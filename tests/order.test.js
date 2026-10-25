import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastName, orderCandidates, orderContests, officeKey, contestRank } from '../lib/order.js';

test('lastName handles suffixes, particles, nicknames and "Last, First"', () => {
  assert.equal(lastName('Avery C. Holloway'), 'Holloway');
  assert.equal(lastName('Maria Ortega-Cruz'), 'Ortega-Cruz');
  assert.equal(lastName('John Smith Jr.'), 'Smith');
  assert.equal(lastName('Robin F. Kestrel III'), 'Kestrel');
  assert.equal(lastName('Lou de Santis'), 'de Santis');
  assert.equal(lastName('Jan van Dijk'), 'van Dijk');
  assert.equal(lastName('James "Jim" Doe'), 'Doe');
  assert.equal(lastName('DOE, JANE'), 'DOE');
  assert.equal(lastName('Smith, Jr.'), 'Smith');
  assert.equal(lastName('Cher'), 'Cher');
  assert.equal(lastName(''), '');
});

test('alphabetical by last name, never by party', () => {
  const list = [
    { name: 'Zed Adams', partyLines: ['Republican'] },
    { name: 'Amy Zimmer', partyLines: ['Democratic'] },
    { name: 'Bo Baker', partyLines: ['Working Families'] },
    { name: 'Cy de Costa', partyLines: ['Conservative'] },
  ];
  const ordered = orderCandidates(list);
  assert.equal(ordered.orderBasis, 'alphabetical');
  assert.deepEqual(ordered.map((c) => c.name), ['Zed Adams', 'Bo Baker', 'Cy de Costa', 'Amy Zimmer']);
  // Reversing the party labels must not change the order.
  const swapped = list.map((c, i) => ({ ...c, partyLines: list[list.length - 1 - i].partyLines }));
  assert.deepEqual(orderCandidates(swapped).map((c) => c.name), ordered.map((c) => c.name));
});

test('ballot order wins only when every candidate has a position', () => {
  const full = orderCandidates([{ name: 'A Adams', orderOnBallot: 3 }, { name: 'B Baker', orderOnBallot: 1 }, { name: 'C Cole', ballotOrder: 2 }]);
  assert.equal(full.orderBasis, 'ballot');
  assert.deepEqual(full.map((c) => c.name), ['B Baker', 'C Cole', 'A Adams']);
  const partial = orderCandidates([{ name: 'A Adams', orderOnBallot: 3 }, { name: 'B Baker' }]);
  assert.equal(partial.orderBasis, 'alphabetical');
  assert.deepEqual(partial.map((c) => c.name), ['A Adams', 'B Baker']);
  assert.equal(orderCandidates([]).orderBasis, 'alphabetical');
});

test('orderCandidates does not mutate its input', () => {
  const input = [{ name: 'B' }, { name: 'A' }];
  orderCandidates(input);
  assert.deepEqual(input.map((c) => c.name), ['B', 'A']);
});

test('officeKey canonicalizes offices', () => {
  assert.equal(officeKey('Governor and Lieutenant Governor', { districtType: 'statewide' }), 'governor');
  assert.equal(officeKey('Lieutenant Governor', { districtType: 'statewide' }), 'lieutenant governor');
  assert.equal(officeKey('Attorney General'), 'attorney general');
  assert.equal(officeKey('Comptroller', { districtType: 'statewide' }), 'comptroller');
  assert.equal(officeKey('Comptroller', { districtType: 'citywide' }), 'citywide:comptroller');
  assert.equal(officeKey('Representative in Congress', { districtType: 'congressional' }), 'us-house');
  assert.equal(officeKey('U.S. Senator', { districtType: 'statewide' }), 'us-senate');
  assert.equal(officeKey('State Senator', { districtType: 'state-senate' }), 'state-senate');
  assert.equal(officeKey('Member of Assembly', { districtType: 'state-assembly' }), 'state-assembly');
  assert.equal(officeKey('Justice of the Supreme Court', { districtType: 'judicial-district' }), 'judicial-district:justice-of-the-supreme-court');
});

test('contests follow the New York office order unless ballot positions are given', () => {
  const contests = [
    { id: 'jud', office: 'Justice of the Supreme Court', level: 'judicial', districtType: 'judicial-district' },
    { id: 'ad', office: 'Member of Assembly', districtType: 'state-assembly' },
    { id: 'ag', office: 'Attorney General', districtType: 'statewide' },
    { id: 'cd', office: 'Representative in Congress', districtType: 'congressional' },
    { id: 'gov', office: 'Governor and Lieutenant Governor', districtType: 'statewide' },
    { id: 'comp', office: 'Comptroller', districtType: 'statewide' },
    { id: 'sd', office: 'State Senator', districtType: 'state-senate' },
  ];
  assert.deepEqual(orderContests(contests).map((c) => c.id), ['gov', 'comp', 'ag', 'cd', 'sd', 'ad', 'jud']);
  const placed = contests.map((c, i) => ({ ...c, ballotPlacement: contests.length - i }));
  assert.deepEqual(orderContests(placed).map((c) => c.id), ['sd', 'comp', 'gov', 'cd', 'ag', 'ad', 'jud']);
  assert.ok(contestRank({ office: 'Mayor', districtType: 'citywide' }) > contestRank({ office: 'Member of Assembly', districtType: 'state-assembly' }));
});
