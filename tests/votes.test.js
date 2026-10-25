import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuestion, parseBillNumber, billDisplay, congressBillUrl, rollcallLinks, castLabel, federalVotesOnIssues } from '../lib/votes.js';
import { nySenateVotesOnIssues } from '../lib/nysenate.js';
import { openStatesVotesOnIssues } from '../lib/openstates.js';

function withFixtures(fn) {
  const prev = process.env.FIXTURES;
  process.env.FIXTURES = '1';
  try { return fn(); } finally { if (prev === undefined) delete process.env.FIXTURES; else process.env.FIXTURES = prev; }
}

test('classifyQuestion keeps substantive questions and drops procedural ones', () => {
  const cases = [
    ['On Passage', 'passage'],
    ['On Passage of the Bill', 'passage'],
    ['On Passage of the Bill, as Amended', 'passage'],
    ['On the Joint Resolution', 'passage'],
    ['On the Resolution', 'passage'],
    ['On Agreeing to the Resolution', 'passage'],
    ['On Motion to Suspend the Rules and Pass', 'suspension'],
    ['On Motion to Suspend the Rules and Pass, as Amended', 'suspension'],
    ['On Motion to Suspend the Rules and Agree', 'suspension'],
    ['On Motion to Suspend the Rules and Concur in the Senate Amendment', 'suspension'],
    ['On Agreeing to the Conference Report', 'conference'],
    ['On the Conference Report', 'conference'],
    ['On Overriding the Veto', 'veto-override'],
    ['On Passage, Objections of the President Not Withstanding', 'veto-override'],
    ['On Motion to Concur in the Senate Amendment', 'passage'],
    ['On the Motion to Concur in the House Amendment to the Senate Amendment', 'passage'],
    ['On Agreeing to the Amendment', 'amendment'],
    ['On the Amendment', 'amendment'],
    ['On the Cloture Motion', null],
    ['On Cloture on the Motion to Proceed', null],
    ['On the Motion to Proceed', null],
    ['On the Motion to Table', null],
    ['On Motion to Table the Amendment', null],
    ['On Motion to Recommit', null],
    ['On Motion to Recommit with Instructions', null],
    ['On Ordering the Previous Question', null],
    ['On Motion to Reconsider', null],
    ['On Motion to Adjourn', null],
    ['On Approving the Journal', null],
    ['On the Nomination', null],
    ['On the Resolution of Ratification', null],
    ['Call of the House', null],
    ['Election of the Speaker', null],
    ['', null],
  ];
  for (const [q, want] of cases) assert.equal(classifyQuestion(q), want, q);
  assert.equal(classifyQuestion('On Agreeing to the Resolution', 'Providing for consideration of the bill (H.R. 2)'), null, 'House rules are procedural');
  assert.equal(classifyQuestion('On the Motion', 'Motion to Concur in the House Amendment'), 'passage');
  assert.equal(classifyQuestion('On the Motion', 'Motion to Waive'), null);
});

test('parseBillNumber handles Voteview and display formats', () => {
  assert.deepEqual(parseBillNumber('HR30'), { type: 'hr', number: '30' });
  assert.deepEqual(parseBillNumber('H.R. 30'), { type: 'hr', number: '30' });
  assert.deepEqual(parseBillNumber('S5'), { type: 's', number: '5' });
  assert.deepEqual(parseBillNumber('SJRES7'), { type: 'sjres', number: '7' });
  assert.deepEqual(parseBillNumber('HCONRES14'), { type: 'hconres', number: '14' });
  assert.deepEqual(parseBillNumber('HRES 0005'), { type: 'hres', number: '5' });
  assert.equal(parseBillNumber('PN12'), null, 'nominations are not bills');
  assert.equal(parseBillNumber('TREATY 1'), null);
  assert.equal(parseBillNumber(''), null);
});

test('display and link helpers', () => {
  assert.equal(billDisplay('hjres', '7'), 'H.J.Res. 7');
  assert.equal(congressBillUrl(119, 'hr', '30'), 'https://www.congress.gov/bill/119th-congress/house-bill/30');
  assert.equal(congressBillUrl(121, 's', '1'), 'https://www.congress.gov/bill/121st-congress/senate-bill/1');
  const house = rollcallLinks({ chamber: 'House', congress: 119, session: 1, date: '2025-01-16', clerkRoll: 17, voteviewRoll: 16 });
  assert.equal(house[0].url, 'https://clerk.house.gov/evs/2025/roll017.xml');
  assert.equal(house[1].url, 'https://voteview.com/rollcall/RH1190016');
  const senate = rollcallLinks({ chamber: 'Senate', congress: 117, session: 2, date: '2022-03-08', clerkRoll: 70, voteviewRoll: 70 });
  assert.equal(senate[0].url, 'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1172/vote_117_2_00070.xml');
  assert.equal(castLabel(1), 'Yea');
  assert.equal(castLabel(6), 'Nay');
  assert.equal(castLabel(9), 'Not voting');
  assert.equal(castLabel(0), 'Not recorded');
});

test('federal votes are filtered by issue and question type', () => withFixtures(() => {
  const housing = federalVotesOnIssues('Z000012', ['housing']);
  assert.deepEqual(housing.items.map((v) => v.bill.number), ['H.R. 99001'], 'amendments excluded by default');
  assert.equal(housing.items[0].vote, 'Yea');
  assert.equal(housing.items[0].kind, 'passage');
  const withAmend = federalVotesOnIssues('Z000012', ['housing'], { includeAmendments: true });
  assert.deepEqual(withAmend.items.map((v) => v.kind).sort(), ['amendment', 'passage']);
  const transit = federalVotesOnIssues('Z000012', ['transportation']);
  assert.deepEqual(transit.items.map((v) => v.bill.number), ['H.R. 99007', 'H.R. 99004'], 'newest first');
  const climate = federalVotesOnIssues('Z000012', ['climate']);
  assert.equal(climate.items[0].kind, 'veto-override');
  assert.equal(climate.items[0].vote, 'Not voting');
  const none = federalVotesOnIssues('Z000012', ['immigration']);
  assert.equal(none.items.length, 0);
  assert.ok(none.substantiveTotal > 0);
  assert.equal(federalVotesOnIssues('Z999999', ['housing']), null, 'unknown member has no file');
}));

test('NY Senate and Assembly votes are filtered by law section', () => withFixtures(() => {
  const s = nySenateVotesOnIssues('9028', ['housing']);
  assert.deepEqual(s.items.map((v) => `${v.bill.number}:${v.vote}`), ['S99001:Aye']);
  const sc = nySenateVotesOnIssues('9028', ['housing'], { includeCommittee: true });
  assert.equal(sc.items.length, 2);
  assert.equal(sc.items[1].kind, 'committee');
  const health = nySenateVotesOnIssues('9028', ['health']);
  assert.equal(health.items[0].vote, 'Nay');
  assert.equal(health.items[0].billStatus, 'Signed by Governor');
  const a = openStatesVotesOnIssues('ocd-person/00000000-0000-4000-8000-000000000075', ['transportation', 'education']);
  assert.deepEqual(a.items.map((v) => `${v.bill.number}:${v.vote}`), ['A99004:No', 'A99003:Yes']);
  assert.equal(a.items[0].chamber, 'NY Assembly');
}));
