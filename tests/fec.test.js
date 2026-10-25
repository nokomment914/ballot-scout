import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sizeBreakdown, outsideSpending, summarizeTotals, topEmployers, pickFecCandidate, fecOfficeCode, federalMoney } from '../lib/fec.js';

test('sizeBreakdown computes the small-dollar share from FEC size buckets', () => {
  const r = sizeBreakdown([
    { size: 0, total: 400000, count: 6000 },
    { size: 200, total: 150000 },
    { size: 500, total: 120000 },
    { size: 1000, total: 90000 },
    { size: 2000, total: 40000 },
    { size: 0, total: 100000 }, // a second committee's rows are summed
    { size: 999, total: 5 }, // unknown bucket ignored
  ]);
  assert.equal(r.total, 900000);
  assert.equal(r.smallDollarTotal, 500000);
  assert.equal(r.smallDollarShare, 0.5556);
  assert.deepEqual(r.buckets.map((b) => b.size), [0, 200, 500, 1000, 2000]);
  assert.equal(r.buckets[0].share, 0.5556);
});

test('sizeBreakdown with no data does not divide by zero', () => {
  const r = sizeBreakdown([]);
  assert.equal(r.total, 0);
  assert.equal(r.smallDollarShare, null);
  assert.ok(r.buckets.every((b) => b.total === 0 && b.share === null));
});

test('outsideSpending sums support and oppose and ranks spenders', () => {
  const o = outsideSpending(
    [{ support_oppose_indicator: 'S', total: 50000 }, { support_oppose_indicator: 'O', total: 100000 }, { support_oppose_indicator: 'o', total: 25000 }],
    [
      { committee_id: 'C1', committee_name: 'A PAC', support_oppose_indicator: 'S', total: 50000 },
      { committee_id: 'C2', committee_name: 'B FUND', support_oppose_indicator: 'O', total: 125000 },
      { committee_id: 'C3', support_oppose_indicator: 'O', total: 0 },
    ]
  );
  assert.equal(o.support, 50000);
  assert.equal(o.oppose, 125000);
  assert.deepEqual(o.spenders.map((s) => [s.name, s.supportOppose]), [['B FUND', 'Opposing'], ['A PAC', 'Supporting']]);
  assert.equal(o.spenders[0].url, 'https://www.fec.gov/data/committee/C2/');
});

test('summarizeTotals maps documented OpenFEC fields', () => {
  const t = summarizeTotals({ receipts: '100.5', disbursements: 50, last_cash_on_hand_end_period: 10, individual_contributions: 80, other_political_committee_contributions: 20, coverage_end_date: '2026-09-30T00:00:00' });
  assert.equal(t.receipts, 100.5);
  assert.equal(t.cashOnHand, 10);
  assert.equal(t.pacContributions, 20);
  assert.equal(t.coverageEndDate, '2026-09-30');
  assert.equal(t.partyContributions, null);
  assert.equal(summarizeTotals(null), null);
});

test('topEmployers keeps FEC wording and sorts by amount', () => {
  const r = topEmployers([{ employer: 'RETIRED', total: 10, count: 1 }, { employer: 'ACME', total: 30, count: 2 }, { employer: 'ZERO', total: 0 }]);
  assert.deepEqual(r.map((e) => e.employer), ['ACME', 'RETIRED']);
});

test('pickFecCandidate requires an unambiguous surname match', () => {
  const results = [{ candidate_id: 'H1', name: 'SMITH, JOHN' }, { candidate_id: 'H2', name: 'SMITH, JANE' }, { candidate_id: 'H3', name: 'DOE, ALEX' }];
  assert.equal(pickFecCandidate(results, 'Alex Doe').candidate_id, 'H3');
  assert.equal(pickFecCandidate(results, 'Jane Smith').candidate_id, 'H2');
  assert.equal(pickFecCandidate(results, 'Sam Smith'), null, 'ambiguous surname, no first-name match');
  assert.equal(pickFecCandidate(results, 'Pat Nobody'), null);
});

test('office codes', () => {
  assert.equal(fecOfficeCode('us-house'), 'H');
  assert.equal(fecOfficeCode('us-senate'), 'S');
  assert.equal(fecOfficeCode('governor'), null);
});

test('federalMoney assembles the fixture candidate end to end', async () => {
  const prev = process.env.FIXTURES;
  process.env.FIXTURES = '1';
  try {
    const m = await federalMoney({ name: 'Sample Candidate G', fecIds: ['H0NY12000'], state: 'NY', officeKey: 'us-house', district: '12', cycle: 2026 });
    assert.equal(m.status, 'ok');
    assert.equal(m.candidateId, 'H0NY12000');
    assert.equal(m.committee.id, 'C99999012');
    assert.equal(m.sizes.smallDollarShare, 0.5);
    assert.equal(m.outside.oppose, 125000);
    assert.equal(m.topEmployers[0].employer, 'RETIRED');
    assert.ok(m.links.every((l) => l.url.startsWith('https://www.fec.gov/')));
    const nf = await federalMoney({ name: 'Nobody Here', fecIds: undefined, state: 'NY', officeKey: 'us-house', district: '12', cycle: 2026 });
    assert.equal(nf.status, 'not-found');
  } finally {
    if (prev === undefined) delete process.env.FIXTURES; else process.env.FIXTURES = prev;
  }
});
