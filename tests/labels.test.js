import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recordProfile, LABELS, isExecutiveTitle, isJudicialContest, isLegislativeContest } from '../lib/labels.js';

const gov = { office: 'Governor and Lieutenant Governor', level: 'state', districtType: 'statewide' };
const ag = { office: 'Attorney General', level: 'state', districtType: 'statewide' };
const sd = { office: 'State Senator', level: 'state', districtType: 'state-senate', district: '28' };
const cd = { office: 'Representative in Congress', level: 'federal', districtType: 'congressional', district: '12' };
const judge = { office: 'Justice of the Supreme Court', level: 'judicial', districtType: 'judicial-district', district: '1' };

test('no legislative record is labeled, not penalized', () => {
  const p = recordProfile({ contest: sd, candidate: { name: 'New Comer', incumbent: false }, ids: {} });
  assert.deepEqual(p.labels, [LABELS.noRecord]);
  assert.equal(LABELS.noRecord, 'No legislative voting record in these databases');
  assert.equal(p.legislative, false);
});

test('legislators with linked ids get no label', () => {
  const p = recordProfile({ contest: cd, candidate: { incumbent: true }, ids: { bioguide: 'A000001' } });
  assert.deepEqual(p.labels, []);
  assert.equal(p.legislative, true);
});

test('incumbent legislator without a linked record says so honestly', () => {
  const p = recordProfile({ contest: sd, candidate: { incumbent: true }, ids: {} });
  assert.deepEqual(p.labels, [LABELS.unlinked]);
});

test('sitting legislators running for another office are "not linked yet", not "no record"', () => {
  const p = recordProfile({ contest: cd, candidate: { incumbent: false, currentOffice: 'Member of Assembly, AD 69' }, ids: {} });
  assert.deepEqual(p.labels, [LABELS.unlinked]);
  const council = recordProfile({ contest: cd, candidate: { incumbent: false, currentOffice: 'NYC Council Member, District 3' }, ids: {} });
  assert.deepEqual(council.labels, [LABELS.noRecord], 'city council votes are not in these databases');
});

test('executive incumbents', () => {
  const a = recordProfile({ contest: ag, candidate: { incumbent: true, currentOffice: 'Attorney General of New York' }, ids: {} });
  assert.deepEqual(a.labels, ['Executive office: no voting record']);
  assert.equal(a.executive, true);
  assert.equal(a.governor, false);
  const g = recordProfile({ contest: gov, candidate: { incumbent: true, currentOffice: 'Governor of New York' }, ids: {} });
  assert.equal(g.governor, true);
  assert.deepEqual(g.labels, [LABELS.executive]);
  const challenger = recordProfile({ contest: gov, candidate: { incumbent: false }, ids: {} });
  assert.equal(challenger.executive, false);
  assert.deepEqual(challenger.labels, [LABELS.noRecord]);
});

test('a legislator running for an executive office keeps their votes and gets no executive label', () => {
  const p = recordProfile({ contest: ag, candidate: { incumbent: false, currentOffice: 'State Senator, District 59' }, ids: { nysenate: '123' } });
  assert.equal(p.legislative, true);
  assert.equal(p.executive, false);
  assert.deepEqual(p.labels, []);
});

test('lieutenant governor is executive but not the Governor', () => {
  const p = recordProfile({ contest: gov, candidate: { incumbent: false, currentOffice: 'Lieutenant Governor' }, ids: {} });
  assert.equal(p.executive, true);
  assert.equal(p.governor, false);
});

test('judicial candidates', () => {
  const p = recordProfile({ contest: judge, candidate: { incumbent: true, currentOffice: 'Justice of the Supreme Court' }, ids: {} });
  assert.deepEqual(p.labels, ['Judicial races have no voting records']);
  assert.equal(p.judicial, true);
  assert.equal(p.executive, false);
  assert.equal(isJudicialContest({ office: 'Surrogate', districtType: 'county' }), true);
});

test('running mates are never treated as the incumbent of the ticket', () => {
  const p = recordProfile({ contest: gov, candidate: { name: 'Mate', incumbent: true }, ids: {}, role: 'running-mate' });
  assert.equal(p.executive, false);
  assert.deepEqual(p.labels, [LABELS.noRecord]);
});

test('title helpers', () => {
  assert.equal(isExecutiveTitle('Governor of New York'), true);
  assert.equal(isExecutiveTitle('New York State Comptroller'), true);
  assert.equal(isExecutiveTitle('State Senator'), false);
  assert.equal(isExecutiveTitle('U.S. Representative'), false);
  assert.equal(isLegislativeContest(cd), true);
  assert.equal(isLegislativeContest(gov), false);
});
