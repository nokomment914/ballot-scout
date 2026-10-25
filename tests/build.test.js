import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { parseCsv } from '../lib/csv.js';
import { indexMembers, selectRollcalls, collectMemberVotes, billsToFetch, compactCongressBill, policyAreasFromVoteviewJson, voteviewUrls } from '../lib/build/votes-build.js';
import { deriveNyOutputs, parseOpenStatesExport, joinOpenStatesPeople, sessionSigner } from '../lib/build/ny-build.js';
import { compactBill, normalizeMember, basePrintNo } from '../lib/nysenate.js';
import { pickSessionDownload, normalizeNyIdentifier, parseArrayField, voteKind } from '../lib/openstates.js';
import { listZip, unzip } from '../lib/unzip.js';

// ---------- Voteview ----------
const membersCsv = `congress,chamber,icpsr,state_icpsr,district_code,state_abbrev,party_code,occupancy,last_means,bioname,bioguide_id,born,died
119,President,99912,99,0,USA,200,,,"PRESIDENT, Sample",,1946,
119,House,1,13,12,NY,100,,,"EXAMPLE, Pat",X000001,1980,
119,House,2,13,10,NY,200,,,"SAMPLE, Lee",X000002,1970,
119,House,3,68,1,WY,200,,,"ATLARGE, Wy",X000003,1960,
119,Senate,4,13,0,NY,100,,,"SENATOR, Sam",X000004,1950,`;
const rollcallsCsv = `congress,chamber,rollnumber,date,session,clerk_rollnumber,yea_count,nay_count,nominate_mid_1,nominate_mid_2,nominate_spread_1,nominate_spread_2,nominate_log_likelihood,bill_number,vote_result,vote_desc,vote_question,dtl_desc
119,House,1,2025-01-03,1,2,216,215,,,,,,,,"Election of the Speaker",Election of the Speaker,
119,House,16,2025-01-16,1,17,264,156,,,,,,HR30,Passed,"Sample Act",On Passage,
119,House,17,2025-01-16,1,18,200,200,,,,,,HR30,Failed,"Amendment to H.R. 30",On Agreeing to the Amendment,
119,House,18,2025-01-17,1,19,210,200,,,,,,HRES5,Passed,"Providing for consideration of the bill (H.R. 30)",On Agreeing to the Resolution,
119,Senate,5,2025-01-20,1,5,60,40,,,,,,S5,Agreed to,"",On the Cloture Motion,
119,Senate,6,2025-01-20,1,6,64,35,,,,,,S5,Passed,"",On Passage of the Bill,
119,Senate,7,2025-01-21,1,7,51,49,,,,,,PN11,Confirmed,"",On the Nomination,`;
const votesCsv = `congress,chamber,rollnumber,icpsr,cast_code,prob
119,House,16,1,1,99
119,House,16,2,6,99
119,House,16,3,9,99
119,House,17,1,6,99
119,House,18,1,1,99
119,Senate,6,4,1,99
119,Senate,5,4,1,99
119,House,16,999,1,99
119,House,17,2,0,99`;

test('Voteview URLs follow the documented static pattern', () => {
  assert.equal(voteviewUrls(119).votes, 'https://voteview.com/static/data/out/votes/HS119_votes.csv');
  assert.equal(voteviewUrls(119).members, 'https://voteview.com/static/data/out/members/HS119_members.csv');
  assert.equal(voteviewUrls(118).rollcalls, 'https://voteview.com/static/data/out/rollcalls/HS118_rollcalls.csv');
});

test('Voteview members, roll calls and votes become compact indexes', () => {
  const members = indexMembers(parseCsv(membersCsv), 119);
  assert.equal(members.size, 4, 'President row skipped');
  assert.equal(members.get('H:1').district, '12');
  assert.equal(members.get('H:3').district, '0', 'single-seat state is at-large');
  assert.equal(members.get('S:4').district, null);

  const { kept, total } = selectRollcalls(parseCsv(rollcallsCsv), 119);
  assert.equal(total, 7);
  assert.deepEqual([...kept.keys()], ['H119-0016', 'H119-0017', 'S119-0006']);
  const passage = kept.get('H119-0016');
  assert.deepEqual(passage, ['H', 119, 1, '2025-01-16', 17, 16, '119-hr-30', 'On Passage', 'passage', 'Passed', 'Sample Act']);
  assert.equal(kept.get('H119-0017')[8], 'amendment');

  const into = new Map();
  for (const row of parseCsv(votesCsv)) collectMemberVotes(row, 119, members, kept, into);
  assert.deepEqual(into.get('X000001'), [['H119-0016', 1], ['H119-0017', 6]], 'procedural rule vote dropped');
  assert.deepEqual(into.get('X000002'), [['H119-0016', 6]], 'cast_code 0 dropped');
  assert.deepEqual(into.get('X000004'), [['S119-0006', 1]], 'cloture dropped');
  assert.equal(into.has('X000999'), false);
});

test('billsToFetch orders missing bills by latest vote, then Voteview-only, then stale', () => {
  const kept = new Map([
    ['a', ['H', 119, 1, '2025-01-01', 1, 1, '119-hr-1', 'q', 'passage', '', '']],
    ['b', ['H', 119, 1, '2025-06-01', 2, 2, '119-hr-2', 'q', 'passage', '', '']],
    ['c', ['H', 119, 1, '2025-03-01', 3, 3, '119-hr-3', 'q', 'passage', '', '']],
    ['d', ['H', 119, 1, '2025-02-01', 4, 4, '119-hr-4', 'q', 'passage', '', '']],
    ['e', ['H', 119, 1, '2025-02-01', 5, 5, '119-hr-5', 'q', 'passage', '', '']],
  ]);
  const now = Date.parse('2026-10-13T00:00:00Z');
  const bills = {
    '119-hr-3': { pa: 'Health', f: '2026-10-01T00:00:00Z' }, // fresh
    '119-hr-4': { pa: 'Taxation', f: '2026-01-01T00:00:00Z' }, // stale
    '119-hr-5': { pa: 'Energy', ps: 'voteview', f: null },
  };
  assert.deepEqual(billsToFetch(kept, bills, { now }), ['119-hr-2', '119-hr-1', '119-hr-5', '119-hr-4']);
});

test('compactCongressBill keeps policy area, title, laws and CBO links', () => {
  const c = compactCongressBill({
    title: 'Postal Service Reform Act of 2022', policyArea: { name: 'Government Operations and Politics' },
    latestAction: { actionDate: '2022-04-06', text: 'Became Public Law No: 117-108.' },
    laws: [{ number: '117-108', type: 'Public Law' }],
    cboCostEstimates: [{ pubDate: '2021-07-14T17:27:00Z', title: 'H.R. 3076, Postal Service Reform Act of 2021', url: 'https://www.cbo.gov/publication/57356', description: 'As ordered reported' }],
  }, '2026-10-13T00:00:00Z');
  assert.equal(c.pa, 'Government Operations and Politics');
  assert.deepEqual(c.laws, ['117-108']);
  assert.deepEqual(c.cbo, [{ t: 'H.R. 3076, Postal Service Reform Act of 2021', u: 'https://www.cbo.gov/publication/57356', d: '2021-07-14', desc: 'As ordered reported' }]);
  assert.deepEqual(compactCongressBill(null, 'x'), { t: null, pa: null, gone: true, f: 'x' });
  const pa = policyAreasFromVoteviewJson([{ congress: 119, bill_number: 'HR30', crs_policy_area: 'Immigration' }, { congress: 118, bill_number: 'HR1', crs_policy_area: 'Taxation' }], 119);
  assert.deepEqual([...pa], [['119-hr-30', 'Immigration']]);
});

// ---------- NY Open Legislation ----------
const fullBill = {
  basePrintNo: 'S2180', session: 2025, printNo: 'S2180A', billType: { chamber: 'SENATE', desc: 'Senate', resolution: false },
  title: 'Relates to tenant notices', activeVersion: 'A', publishedDateTime: '2025-01-14T10:36:22', summary: 'Requires notice to tenants.',
  signed: true, status: { statusType: 'SIGNED_BY_GOV', statusDesc: 'Signed by Governor', actionDate: '2025-08-01' },
  sponsor: { member: { memberId: 422, shortName: 'EXAMPLE', fullName: 'Pat Example', districtCode: 28 } },
  amendments: { items: {
    '': { lawSection: 'Real Property Law', memo: 'OLD MEMO' },
    A: { lawSection: 'Real Property Law', lawCode: 'Amd §235-e, RP L', memo: 'PURPOSE:\nX\n\nFISCAL IMPLICATIONS:\nNone to the state.\n\nEFFECTIVE DATE:\nNow', sameAs: { items: [{ basePrintNo: 'A2098', printNo: 'A2098A' }] } },
  } },
  votes: { items: [
    { version: 'A', voteType: 'FLOOR', voteDate: '2025-05-20', memberVotes: { items: { AYE: { items: [{ memberId: 422 }, { memberId: 500 }] }, NAY: { items: [{ memberId: 600 }] } } } },
    { version: '', voteType: 'COMMITTEE', voteDate: '2025-03-01', committee: { chamber: 'SENATE', name: 'Housing' }, memberVotes: { items: { AYEWR: { items: [{ memberId: 422 }] } } } },
  ] },
  actions: { items: [{ date: '2025-08-01', chamber: 'SENATE', text: 'SIGNED CHAP.123' }] },
  vetoMessages: { items: [] },
  approvalMessage: null,
};

test('compactBill extracts law section, fiscal note, votes and chapter from a full bill', () => {
  const c = compactBill(fullBill);
  assert.equal(c.p, 'S2180');
  assert.equal(c.ls, 'Real Property Law');
  assert.equal(c.fis, 'None to the state.');
  assert.deepEqual(c.sa, ['A2098']);
  assert.equal(c.ch, 123);
  assert.equal(c.signedDate, '2025-08-01');
  assert.deepEqual(c.votes[0], { type: 'F', date: '2025-05-20', version: 'A', committee: null, codes: { AYE: [422, 500], NAY: [600] } });
  assert.equal(c.votes[1].type, 'C');
  assert.equal(c.sponsor, 422);
});

test('deriveNyOutputs builds member files, vote rows and Governor actions', () => {
  const vetoed = compactBill({ ...fullBill, basePrintNo: 'A99', printNo: 'A99', billType: { chamber: 'ASSEMBLY', resolution: false }, signed: false, status: { statusType: 'VETOED', statusDesc: 'Vetoed', actionDate: '2025-11-01' }, sponsor: { member: { memberId: 700 } }, votes: { items: [] }, actions: { items: [{ date: '2025-11-01', text: 'VETOED MEMO.55' }] }, vetoMessages: { items: [{ vetoNumber: 55, year: 2025, signer: 'SAMPLE GOVERNOR', memoText: 'I am constrained to veto this bill.', signedDate: '2025-11-01' }] } });
  const resolution = compactBill({ ...fullBill, basePrintNo: 'J1', billType: { chamber: 'SENATE', resolution: true } });
  const members = [{ memberId: 422, chamber: 'SENATE', name: 'Pat Example', district: '28' }, { memberId: 700, chamber: 'ASSEMBLY', name: 'Lee Sample', district: '75' }];
  const { memberFiles, bills, actions, signer } = deriveNyOutputs([compactBill(fullBill), vetoed, resolution], members, 2025);
  assert.equal(signer, 'SAMPLE GOVERNOR');
  const pat = memberFiles.get('422');
  assert.deepEqual(pat.sponsored.map((s) => s.p), ['S2180']);
  assert.deepEqual(pat.votes, [['S2180', '2025-05-20', 'F', 'AYE', ''], ['S2180', '2025-03-01', 'C', 'AYEWR', 'Housing']]);
  assert.deepEqual(memberFiles.get('600').votes, [['S2180', '2025-05-20', 'F', 'NAY', '']], 'members missing from the list still get files');
  assert.deepEqual(Object.keys(bills).sort(), ['A99', 'S2180']);
  assert.deepEqual(actions.map((a) => [a.p, a.a]), [['A99', 'vetoed'], ['S2180', 'signed']]);
  assert.equal(actions[0].sig, 'SAMPLE GOVERNOR');
  assert.equal(actions[1].sig, null);
  assert.equal(actions[1].si, 'SAMPLE GOVERNOR', 'signer named in the session messages');
  assert.equal(actions[1].ch, 123);
  assert.equal(sessionSigner([]), null);
});

test('Open Legislation member normalization and print numbers', () => {
  const m = normalizeMember({ memberId: 371, chamber: 'SENATE', fullName: 'Sample Q. Member', incumbent: true, person: { firstName: 'Sample', lastName: 'Member' }, sessionShortNameMap: { 2025: [{ shortName: 'MEMBER', districtCode: 51, alternate: false }] } }, 2025);
  assert.deepEqual(m, { memberId: 371, chamber: 'SENATE', name: 'Sample Q. Member', firstName: 'Sample', lastName: 'Member', shortName: 'MEMBER', district: '51', incumbent: true });
  assert.equal(basePrintNo('S1234B'), 'S1234');
  assert.equal(basePrintNo('A 01234'), 'A1234');
});

// ---------- Open States bulk export ----------
function makeZip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const comp = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

test('unzip reads deflated entries', () => {
  const zip = makeZip({ 'README': 'hello', 'NY/2025-2026/NY_2025-2026_votes.csv': 'id\n1\n' });
  assert.deepEqual(listZip(zip).map((e) => e.name), ['README', 'NY/2025-2026/NY_2025-2026_votes.csv']);
  const out = unzip(zip, (n) => n.endsWith('.csv'));
  assert.deepEqual(Object.keys(out), ['NY/2025-2026/NY_2025-2026_votes.csv']);
  assert.equal(out['NY/2025-2026/NY_2025-2026_votes.csv'].toString(), 'id\n1\n');
  assert.throws(() => listZip(Buffer.from('not a zip at all, definitely not')), /Not a zip/);
});

test('parseOpenStatesExport produces Assembly roll calls per person', () => {
  const p = 'NY/2025-2026/NY_2025-2026';
  const zip = makeZip({
    [`${p}_organizations.csv`]: 'id,name,classification\norg-lower,Assembly,lower\norg-upper,Senate,upper\n',
    [`${p}_bills.csv`]: `id,identifier,title,classification,subject,session_identifier,jurisdiction,organization_classification\nb1,A 1234,Transit fares,['bill'],"['Transportation', 'Transit']",2025-2026,New York,lower\nb2,K 55,Honoring someone,['resolution'],[],2025-2026,New York,lower\nb3,S 99,Senate bill,['bill'],[],2025-2026,New York,upper\n`,
    [`${p}_votes.csv`]: 'id,identifier,motion_text,motion_classification,start_date,result,organization_id,bill_id,bill_action_id,jurisdiction,session_identifier\nv1,,Floor Vote,[\'passage\'],2025-06-10,pass,org-lower,b1,,New York,2025-2026\nv2,,Floor Vote,[\'passage\'],2025-06-11,pass,org-lower,b2,,New York,2025-2026\nv3,,Floor Vote,[\'passage\'],2025-06-12,pass,org-upper,b3,,New York,2025-2026\nv4,,Amendment,[\'amendment-passage\'],2025-06-09,fail,org-lower,b1,,New York,2025-2026\n',
    [`${p}_vote_people.csv`]: 'id,vote_event_id,option,voter_name,voter_id,note\n1,v1,yes,Alder,ocd-person/11111111-1111-4111-8111-111111111111,\n2,v1,no,Doe,ocd-person/22222222-2222-4222-8222-222222222222,\n3,v2,yes,Alder,ocd-person/11111111-1111-4111-8111-111111111111,\n4,v3,yes,Senator,ocd-person/33333333-3333-4333-8333-333333333333,\n5,v4,no,Alder,ocd-person/11111111-1111-4111-8111-111111111111,\n6,v1,yes,Unknown,,\n',
    [`${p}_vote_sources.csv`]: 'id,vote_event_id,url,note\n1,v1,https://nyassembly.gov/leg/?bn=A01234,\n',
  });
  const files = unzip(zip, (n) => n.endsWith('.csv'));
  const r = parseOpenStatesExport(files);
  assert.equal(r.voteEvents, 2, 'resolution and Senate votes skipped');
  assert.deepEqual(r.byPerson.get('ocd-person/11111111-1111-4111-8111-111111111111'), [
    ['A1234', '2025-06-10', 'passage', 'yes', 'Floor Vote', 'https://nyassembly.gov/leg/?bn=A01234'],
    ['A1234', '2025-06-09', 'amendment', 'no', 'Amendment', null],
  ]);
  assert.equal(r.byPerson.has('ocd-person/33333333-3333-4333-8333-333333333333'), false);
  assert.deepEqual(r.subjects.get('A1234'), ['Transportation', 'Transit']);
});

test('Open States helpers', () => {
  const jur = { legislative_sessions: [
    { identifier: '2023-2024', start_date: '2023-01-04', downloads: [{ data_type: 'csv', url: 'https://data.openstates.org/csv/latest/NY_2023-2024_csv_x.zip', updated_at: '2025-01-01' }] },
    { identifier: '2025-2026', start_date: '2025-01-08', downloads: [{ data_type: 'json', url: 'j' }, { data_type: 'csv', url: 'https://data.openstates.org/csv/latest/NY_2025-2026_csv_y.zip', updated_at: '2026-10-11' }] },
  ] };
  assert.deepEqual(pickSessionDownload(jur, '2025-2026'), { session: '2025-2026', url: 'https://data.openstates.org/csv/latest/NY_2025-2026_csv_y.zip', updatedAt: '2026-10-11' });
  assert.equal(pickSessionDownload(jur, '2027-2028').session, '2025-2026', 'falls back to the latest session');
  assert.equal(normalizeNyIdentifier('A 1234'), 'A1234');
  assert.equal(normalizeNyIdentifier('S1234B'), 'S1234');
  assert.equal(normalizeNyIdentifier('SR 12'), null);
  assert.deepEqual(parseArrayField("['bill-passage', 'veto-override']"), ['bill-passage', 'veto-override']);
  assert.deepEqual(parseArrayField('{passage}'), ['passage']);
  assert.equal(voteKind("['veto-override']"), 'veto-override');
  assert.equal(voteKind("['amendment-passage']"), 'amendment');
  assert.equal(voteKind('[]', 'Committee on Codes'), 'committee');
  const joined = joinOpenStatesPeople(
    [{ memberId: 1, chamber: 'ASSEMBLY', name: 'Sample J. Alder', lastName: 'Alder', district: '66' }, { memberId: 2, chamber: 'SENATE', name: 'Pat Example', lastName: 'Example', district: '28' }],
    [{ id: 'ocd-person/a', name: 'Sample J. Alder', family_name: 'Alder', openstates_url: 'https://openstates.org/person/x/', current_role: { org_classification: 'lower', district: '66' } },
     { id: 'ocd-person/b', name: 'Someone Else', family_name: 'Else', current_role: { org_classification: 'upper', district: '28' } }]
  );
  assert.equal(joined[0].openstatesId, 'ocd-person/a');
  assert.equal(joined[1].openstatesId, null, 'district matches but surname does not');
});
