// A local stand-in for Voteview, Congress.gov, NY Open Legislation and Open States, serving
// fictional data in each API's documented response shape. Used by tests/scripts.test.js to
// run the real build scripts end to end without network access.
import http from 'node:http';
import zlib from 'node:zlib';

export function makeZip(files) {
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

export const VOTEVIEW = {
  members: `congress,chamber,icpsr,state_icpsr,district_code,state_abbrev,party_code,occupancy,last_means,bioname,bioguide_id,born,died
119,House,1,13,12,NY,100,,,"EXAMPLE, Pat",X000001,1980,
119,House,2,13,10,NY,200,,,"SAMPLE, Lee",X000002,1970,
119,Senate,4,13,0,NY,100,,,"SENATOR, Sam",X000004,1950,
`,
  rollcalls: `congress,chamber,rollnumber,date,session,clerk_rollnumber,yea_count,nay_count,nominate_mid_1,nominate_mid_2,nominate_spread_1,nominate_spread_2,nominate_log_likelihood,bill_number,vote_result,vote_desc,vote_question,dtl_desc
119,House,16,2025-01-16,1,17,264,156,,,,,,HR99001,Passed,"Sample Housing Act",On Passage,
119,House,17,2025-01-16,1,18,200,200,,,,,,HR99001,Failed,"Amendment to H.R. 99001",On Agreeing to the Amendment,
119,House,30,2025-03-02,1,31,300,100,,,,,,HR99002,Passed,"Sample Health Act",On Motion to Suspend the Rules and Pass,
119,Senate,6,2025-01-20,1,6,64,35,,,,,,S99003,Passed,"",On Passage of the Bill,
119,Senate,7,2025-01-21,1,7,51,49,,,,,,PN11,Confirmed,"",On the Nomination,
`,
  votes: `congress,chamber,rollnumber,icpsr,cast_code,prob
119,House,16,1,1,99
119,House,16,2,6,99
119,House,17,1,6,99
119,House,30,1,6,99
119,House,30,2,1,99
119,Senate,6,4,1,99
119,Senate,7,4,1,99
`,
};

const congressBills = {
  '119/hr/99001': { title: 'Sample Housing Act', policyArea: { name: 'Housing and Community Development' }, latestAction: { actionDate: '2025-02-01', text: 'Received in the Senate.' }, cboCostEstimates: [{ title: 'H.R. 99001, Sample Housing Act', url: 'https://example.org/cbo', pubDate: '2025-01-10T00:00:00Z', description: 'As ordered reported' }] },
  '119/hr/99002': { title: 'Sample Health Act', policyArea: { name: 'Health' }, latestAction: { actionDate: '2025-04-01', text: 'Became Public Law No: 119-999.' }, laws: [{ number: '119-999', type: 'Public Law' }] },
  // 119/s/99003 deliberately missing -> 404
};

const memo = 'PURPOSE:\nSample.\n\nFISCAL IMPLICATIONS:\nNone to the state.\n\nEFFECTIVE DATE:\nImmediately.';
function nyBill(printNo, { sponsor, status = ['IN_SENATE_COMM', 'In Senate Committee'], law = 'Real Property Law', votes = [], signed = false, actions = [], vetoes = [], resolution = false }) {
  return {
    basePrintNo: printNo, session: 2025, printNo, billType: { chamber: printNo.startsWith('A') ? 'ASSEMBLY' : 'SENATE', resolution },
    title: `Sample bill ${printNo}`, activeVersion: '', publishedDateTime: '2025-01-10T10:00:00', summary: `Official summary of ${printNo}.`,
    signed, status: { statusType: status[0], statusDesc: status[1], actionDate: '2025-06-01' },
    sponsor: { member: { memberId: sponsor, shortName: 'X', fullName: 'X' } },
    amendments: { items: { '': { lawSection: law, memo: printNo.startsWith('S') ? memo : '', fullText: 'x'.repeat(1000) } } },
    votes: { items: votes }, actions: { items: actions }, vetoMessages: { items: vetoes },
  };
}

export const OPENLEG = {
  members: [
    { memberId: 422, chamber: 'SENATE', fullName: 'Pat Senator', incumbent: true, person: { firstName: 'Pat', lastName: 'Senator' }, sessionShortNameMap: { 2025: [{ shortName: 'SENATOR', districtCode: 28, alternate: false }] } },
    { memberId: 700, chamber: 'ASSEMBLY', fullName: 'Lee Assembler', incumbent: true, person: { firstName: 'Lee', lastName: 'Assembler' }, sessionShortNameMap: { 2025: [{ shortName: 'ASSEMBLER', districtCode: 75, alternate: false }] } },
  ],
  bills: [
    nyBill('S100', { sponsor: 422, status: ['SIGNED_BY_GOV', 'Signed by Governor'], signed: true, law: 'Real Property Law', actions: [{ date: '2025-08-01', text: 'SIGNED CHAP.321' }],
      votes: [{ version: '', voteType: 'FLOOR', voteDate: '2025-05-20', memberVotes: { items: { AYE: { items: [{ memberId: 422 }] } } } }] }),
    nyBill('S101', { sponsor: 422, law: 'Public Health Law' }),
    nyBill('A200', { sponsor: 700, status: ['VETOED', 'Vetoed'], law: 'Education Law', actions: [{ date: '2025-11-01', text: 'VETOED MEMO.77' }], vetoes: [{ vetoNumber: 77, year: 2025, signer: 'SAMPLE GOVERNOR', memoText: 'Sample veto memo.', signedDate: '2025-11-01' }] }),
    nyBill('J1', { sponsor: 422, resolution: true }),
  ],
  updated: nyBill('S101', { sponsor: 422, status: ['PASSED_SENATE', 'Passed Senate'], law: 'Public Health Law',
    votes: [{ version: '', voteType: 'FLOOR', voteDate: '2026-02-01', memberVotes: { items: { NAY: { items: [{ memberId: 422 }] } } } }] }),
};

const OS_PREFIX = 'NY/2025-2026/NY_2025-2026';
export const OPENSTATES_ZIP = makeZip({
  README: 'Open States Data Export',
  [`${OS_PREFIX}_organizations.csv`]: 'id,name,classification\norg-lower,Assembly,lower\norg-upper,Senate,upper\n',
  [`${OS_PREFIX}_bills.csv`]: "id,identifier,title,classification,subject,session_identifier,jurisdiction,organization_classification\nb1,A 200,Sample,['bill'],\"['Education']\",2025-2026,New York,lower\n",
  [`${OS_PREFIX}_votes.csv`]: "id,identifier,motion_text,motion_classification,start_date,result,organization_id,bill_id,bill_action_id,jurisdiction,session_identifier\nv1,,Floor Vote,['passage'],2025-06-10,pass,org-lower,b1,,New York,2025-2026\n",
  [`${OS_PREFIX}_vote_people.csv`]: 'id,vote_event_id,option,voter_name,voter_id,note\n1,v1,no,Assembler,ocd-person/77777777-7777-4777-8777-777777777777,\n',
  [`${OS_PREFIX}_vote_sources.csv`]: 'id,vote_event_id,url,note\n1,v1,https://example.org/assembly-vote,\n',
});

const col = (name, type = 'text') => ({ name, fieldName: name.toLowerCase(), dataTypeName: type });
// As on data.ny.gov: transactions are filed by committees, and a committee's own rows carry no office.
// The candidate filers (registrations) carry the office and district.
const txn = (filer, name, year, trans, sched, amount, extra = {}) => ({
  filer_id: filer, cand_comm_name: name, election_year: year, filing_desc: year === '2026' ? 'July Periodic' : 'January Periodic', r_amend: 'N',
  filing_sched_abbrev: sched, filing_sched_desc: sched === 'A' ? 'Monetary Contributions Received From Ind. & Part.' : 'Expenditures/ Payments',
  trans_number: trans, sched_date: `${year}-06-01T00:00:00.000`, org_amt: amount, ...extra,
});
export const SOCRATA = {
  columns: {
    '7x2g-h32p': ['FILER_ID', 'FILER_NAME', 'COMPLIANCE_TYPE_DESC', 'FILER_TYPE_DESC', 'FILER_STATUS', 'COMMITTEE_TYPE_DESC', 'OFFICE_DESC', 'DISTRICT', 'COUNTY_DESC'].map((n) => col(n)),
    'e9ss-239a': ['FILER_ID', 'FILER_PREVIOUS_ID', 'CAND_COMM_NAME', 'ELECTION_YEAR', 'ELECTION_TYPE', 'FILING_ABBREV', 'FILING_DESC', 'R_AMEND', 'FILING_SCHED_ABBREV', 'FILING_SCHED_DESC', 'TRANS_NUMBER', 'SCHED_DATE', 'ORG_AMT', 'OFFICE_DESC', 'DISTRICT'].map((n) => col(n, n === 'FILER_ID' || n === 'ORG_AMT' ? 'number' : 'text')),
  },
  candidates: [
    { filer_id: '5001', filer_name: 'Pat  Senator', compliance_type_desc: 'CANDIDATE', filer_type_desc: 'State', filer_status: 'ACTIVE', office_desc: 'State Senator', district: '28' },
    { filer_id: '5002', filer_name: 'Lee Assembler', compliance_type_desc: 'CANDIDATE', filer_type_desc: 'State', filer_status: 'TERMINATED', office_desc: 'Member of Assembly', district: '75' },
  ],
  committees: [
    { filer_id: '6001', filer_name: 'Friends of Pat Senator', compliance_type_desc: 'COMMITTEE', filer_type_desc: 'State', filer_status: 'ACTIVE', committee_type_desc: 'Authorized Single Candidate Committee' },
    { filer_id: '6002', filer_name: 'Pat Senator 2026', compliance_type_desc: 'COMMITTEE', filer_type_desc: 'State', filer_status: 'ACTIVE', committee_type_desc: 'Public Campaign Finance Committee' },
    { filer_id: '6003', filer_name: 'Friends Of Pat Senator', compliance_type_desc: 'COMMITTEE', filer_type_desc: 'State', filer_status: 'TERMINATED', committee_type_desc: 'Authorized Single Candidate Committee' },
    { filer_id: '6004', filer_name: 'Assembler for Assembly', compliance_type_desc: 'COMMITTEE', filer_type_desc: 'State', filer_status: 'ACTIVE', committee_type_desc: 'Public Campaign Finance Committee' },
    { filer_id: '6005', filer_name: 'Committee To Elect Lee Assembler', compliance_type_desc: 'COMMITTEE', filer_type_desc: 'County', filer_status: 'ACTIVE', committee_type_desc: 'Authorized Single Candidate Committee', county_desc: 'Albany' },
    { filer_id: '7001', filer_name: 'Senate Majority Fund', compliance_type_desc: 'COMMITTEE', filer_type_desc: 'State', filer_status: 'ACTIVE', committee_type_desc: 'Independent Expenditure Committee' },
  ],
  transactions: [
    txn('6001', 'Friends of Pat Senator', '2026', 'T1', 'A', '250'),
    txn('6001', 'Friends of Pat Senator', '2026', 'T1', 'A', '300', { r_amend: 'Y' }),
    txn('6001', 'Friends of Pat Senator', '2025', 'T2', 'F', '120.5'),
    txn('6002', 'Pat Senator 2026', '2026', 'T1', 'A', '50'), // same transaction number, different committee
    txn('6003', 'Friends Of Pat Senator', '2025', 'T9', 'A', '999'), // terminated committee
    txn('6004', 'Assembler for Assembly', '2026', 'T1', 'A', '75'),
    txn('6005', 'Committee To Elect Lee Assembler', '2026', 'T1', 'A', '5000'), // county committee: someone else's race
    txn('7001', 'Senate Majority Fund', '2026', 'T1', 'F', '9000', { office_desc: 'State Senator', district: '28' }),
    txn('6001', 'Friends of Pat Senator', '2024', 'T0', 'A', '40'), // outside the years covered
  ],
};

/** Socrata's grouped count, as `$select=<cols>, count(*) as n&$group=<cols>` returns it. */
function groupRows(rows, cols) {
  const groups = new Map();
  for (const r of rows) {
    const key = JSON.stringify(cols.map((c) => r[c] ?? null));
    const g = groups.get(key) ?? { ...Object.fromEntries(cols.filter((c) => r[c] !== undefined).map((c) => [c, r[c]])), n: 0 };
    g.n += 1;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g, n: String(g.n) }));
}

export function startMockUpstream() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    hits.push(url.pathname + url.search);
    const json = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
    const p = url.pathname;
    // Voteview static files
    const vv = /^\/voteview\/(members|rollcalls|votes)\/HS119_\1\.(csv|json)$/.exec(p);
    if (vv) {
      if (vv[2] === 'json') return json(404, {});
      res.setHeader('content-type', 'text/csv');
      return res.end(VOTEVIEW[vv[1]]);
    }
    // Congress.gov
    const cg = /^\/congress\/bill\/(\d+\/[a-z]+\/\d+)$/.exec(p);
    if (cg) {
      if (url.searchParams.get('format') !== 'json' || !url.searchParams.get('api_key')) return json(400, { error: 'format/api_key required' });
      const bill = congressBills[cg[1]];
      return bill ? json(200, { bill, request: {} }) : json(404, { error: 'Unknown resource' });
    }
    // Open Legislation
    if (p.startsWith('/openleg/')) {
      if (!url.searchParams.get('key')) return json(401, { success: false, message: 'key required' });
      const offset = Number(url.searchParams.get('offset') ?? 1);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const page = (items) => {
        const slice = items.slice(offset - 1, offset - 1 + limit);
        return json(200, { success: true, message: '', responseType: 'list', total: items.length, offsetStart: offset, offsetEnd: offset - 1 + slice.length, limit, result: { items: slice, size: slice.length } });
      };
      if (p === '/openleg/members/2025') return page(OPENLEG.members);
      if (p === '/openleg/bills/2025') return page(OPENLEG.bills);
      if (p.startsWith('/openleg/bills/updates/')) return page([{ id: { basePrintNo: 'S101', session: 2025, basePrintNoStr: 'S101-2025' }, contentType: 'BILL' }, { id: { basePrintNo: 'S9', session: 2023 }, contentType: 'BILL' }]);
      if (p === '/openleg/bills/2025/S101') return json(200, { success: true, responseType: 'bill', result: OPENLEG.updated });
      return json(404, { success: false, message: 'not found' });
    }
    // Open States
    if (p.startsWith('/openstates/')) {
      if (req.headers['x-api-key'] !== 'test-key') return json(403, { detail: 'Must provide API Key' });
      if (p === '/openstates/jurisdictions/ocd-jurisdiction/country:us/state:ny/government') {
        const base = `http://localhost:${server.address().port}`;
        return json(200, { id: 'ocd-jurisdiction/country:us/state:ny/government', name: 'New York', legislative_sessions: [{ identifier: '2025-2026', name: '2025-2026', start_date: '2025-01-08', downloads: [{ data_type: 'csv', url: `${base}/files/NY_2025-2026_csv.zip`, updated_at: '2026-10-11T10:00:00Z', created_at: '2025-01-09T00:00:00Z' }] }] });
      }
      if (p === '/openstates/people') {
        return json(200, { results: [
          { id: 'ocd-person/77777777-7777-4777-8777-777777777777', name: 'Lee Assembler', family_name: 'Assembler', party: 'Sample', openstates_url: 'https://example.org/os/lee', current_role: { title: 'Assemblymember', org_classification: 'lower', district: '75' } },
          { id: 'ocd-person/88888888-8888-4888-8888-888888888888', name: 'Pat Senator', family_name: 'Senator', party: 'Sample', current_role: { title: 'Senator', org_classification: 'upper', district: '28' } },
        ], pagination: { per_page: 50, page: 1, max_page: 1, total_items: 2 } });
      }
      return json(404, { detail: 'Not Found' });
    }
    if (p === '/files/NY_2025-2026_csv.zip') { res.setHeader('content-type', 'application/zip'); return res.end(OPENSTATES_ZIP); }
    // data.ny.gov (Socrata)
    const cols = /^\/socrata\/api\/views\/([a-z0-9]{4}-[a-z0-9]{4})\/columns\.json$/.exec(p);
    if (cols) return json(200, SOCRATA.columns[cols[1]] ?? []);
    const resource = /^\/socrata\/resource\/([a-z0-9]{4}-[a-z0-9]{4})\.json$/.exec(p);
    if (resource) {
      const where = url.searchParams.get('$where') ?? '';
      const offset = Number(url.searchParams.get('$offset') ?? 0);
      if (offset) return json(200, []);
      if (resource[1] === '7x2g-h32p') {
        if (/upper\(compliance_type_desc\) like '%CANDIDATE%'/.test(where)) return json(200, SOCRATA.candidates);
        if (/upper\(compliance_type_desc\) like '%COMMITTEE%'/.test(where)) return json(200, SOCRATA.committees);
        return json(400, { message: 'bad where' });
      }
      if (!/election_year in \('2025', '2026'\)/.test(where)) return json(400, { message: 'bad where' });
      const inYears = SOCRATA.transactions.filter((t) => ['2025', '2026'].includes(t.election_year));
      const group = url.searchParams.get('$group');
      if (group) return json(200, groupRows(inYears, group.split(',').map((s) => s.trim())));
      const ids = (/filer_id in \(([^)]*)\)/.exec(where)?.[1] ?? '').split(',').map((s) => s.trim());
      return json(200, inYears.filter((t) => ids.includes(t.filer_id)));
    }
    json(404, { error: 'unknown mock route' });
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, hits, base: `http://localhost:${server.address().port}` })));
}
