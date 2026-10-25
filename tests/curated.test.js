// Issues defined by a published roll-call list (Israel and Palestine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readData } from '../lib/files.js';
import { ISSUE_BY_ID, issueTable, resolveIssueIds } from '../lib/issues.js';

function withFixtures(fn) {
  return async () => {
    const prev = process.env.FIXTURES;
    process.env.FIXTURES = '1';
    try { await fn(); } finally { if (prev === undefined) delete process.env.FIXTURES; else process.env.FIXTURES = prev; }
  };
}

test('the issue is offered, federal-only, and matched by its list rather than by subject', () => {
  const i = ISSUE_BY_ID.get('israel-palestine');
  assert.equal(i.label, 'Israel and Palestine');
  assert.equal(i.curated, 'israel-palestine');
  assert.equal(i.federalOnly, true);
  assert.deepEqual([i.policyAreas, i.nyLaws, i.subjects], [[], [], []]);
  assert.deepEqual(resolveIssueIds(['israel-palestine', 'housing']), ['israel-palestine', 'housing']);
  assert.equal(issueTable().issues.find((x) => x.id === 'israel-palestine').curated, 'israel-palestine');
});

test('the published list is complete and every vote links to the Clerk of the House', () => {
  const list = readData('issues', 'israel-palestine.json');
  assert.ok(list.rule.length > 200);
  assert.ok(list.rollcalls.length >= 6);
  const allowed = new Set(['Yea', 'Nay', 'Present', 'Not voting', 'Not in office']);
  const members = ['L000598', 'G000597', 'S001201', 'G000602', 'M001137', 'M001188', 'J000294', 'C001067', 'M000317', 'O000172', 'T000486', 'L000606', 'L000599'];
  for (const r of list.rollcalls) {
    assert.match(r.pageUrl, /^https:\/\/clerk\.house\.gov\/Votes\/\d{7}$/, `roll ${r.roll}`);
    assert.match(r.sourceUrl, /^https:\/\/clerk\.house\.gov\//, `roll ${r.roll}`);
    assert.match(r.bill.url, /^https:\/\/www\.congress\.gov\/bill\//);
    assert.ok(['passage', 'suspension', 'concur', 'amendment', 'veto-override'].includes(r.kind));
    if (r.kind === 'amendment') assert.ok(r.amendment?.description && r.amendment?.sponsor, `roll ${r.roll} amendment`);
    for (const m of members) assert.ok(allowed.has(r.votes[m]), `roll ${r.roll} ${m}: ${r.votes[m]}`);
  }
  for (const e of list.excluded) assert.ok(e.what && e.reason, 'every exclusion gives a reason');
});

test('a House member gets every listed vote, amendments included, from the list or Voteview', withFixtures(async () => {
  const { curatedVotesForMember, NOT_IN_OFFICE } = await import('../lib/votes.js');
  const { loadCuratedIssue } = await import('../lib/curated.js');
  const list = loadCuratedIssue('israel-palestine');
  const items = curatedVotesForMember('Z000012', list, 'israel-palestine');
  assert.deepEqual(items.map((x) => `${x.rollcall}:${x.vote}:${x.voteSource}`), ['100:Nay:list', '101:Yea:voteview', `38:${NOT_IN_OFFICE}:list`]);
  assert.equal(items[0].kind, 'amendment');
  assert.match(items[0].description, /Sample amendment description/);
  assert.equal(items[2].notInOffice, true);
  assert.ok(items.every((x) => x.links[0].url && x.issues[0] === 'israel-palestine' && x.curated));
}));

test('candidate records: listed votes show without the amendment switch; others get a plain note', withFixtures(async () => {
  const { getCandidateRecord } = await import('../lib/candidate.js');
  const { encodeCandidateToken } = await import('../lib/ids.js');
  const rep = encodeCandidateToken({ name: 'Sample Candidate G', state: 'NY', office: 'Representative in Congress', districtType: 'congressional', district: '12', level: 'federal', incumbent: true, ids: { bioguide: 'Z000012', fec: ['H0NY12000'] }, matchedBy: { bioguide: 'seed' }, role: 'candidate' });
  const r = await getCandidateRecord(rep, ['israel-palestine', 'housing'], { more: false });
  const v = r.sections.votes;
  assert.ok(v.items.some((x) => x.curated && x.kind === 'amendment'), 'the listed amendment vote is shown with the switch off');
  assert.ok(!v.items.some((x) => !x.curated && x.kind === 'amendment'), 'other amendment votes still need the switch');
  const roll101 = v.items.filter((x) => x.rollcall === 101);
  assert.equal(roll101.length, 1, 'one row per roll call');
  assert.deepEqual(roll101[0].issues.sort(), ['housing', 'israel-palestine'], 'a roll call on both issues keeps both tags');
  assert.match(r.sections.sponsored.note ?? '', /aren’t matched to Israel and Palestine/);
  assert.equal(r.sections.money.outsideByCycle.status, 'recorded');

  const senator = encodeCandidateToken({ name: 'Sample Candidate J', state: 'NY', office: 'State Senator', districtType: 'state-senate', district: '28', level: 'state', incumbent: true, ids: { nysenate: '9028' }, matchedBy: { nysenate: 'seed' }, role: 'candidate' });
  const s = await getCandidateRecord(senator, ['israel-palestine'], { more: false });
  assert.equal(s.sections.votes.items.length, 0);
  assert.match(s.sections.votes.note, /U\.S\. House roll calls/);
  assert.ok(s.sections.money.outsideLinks.length >= 1, 'state candidates link to the NYS Board of Elections IE search');
}));
