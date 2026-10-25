import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapColumns, soqlLiteral, officeClass, matchFiler, aggregateTransactions, moneyKey, disclosureRow, REQUIRED } from '../lib/nymoney.js';
import { stateMoney } from '../lib/statemoney.js';

test('mapColumns maps documented names to Socrata field names and reports gaps', () => {
  const cols = [
    { name: 'FILER_ID', fieldName: 'filer_id', dataTypeName: 'number' },
    { name: 'Filer Name', fieldName: 'filer_name', dataTypeName: 'text' },
    { name: 'compliance_type_desc', fieldName: 'compliance_type_desc', dataTypeName: 'text' },
  ];
  const { map, missing } = mapColumns(cols, ['FILER_ID', 'FILER_NAME', 'COMPLIANCE_TYPE_DESC', 'OFFICE_DESC']);
  assert.deepEqual(map.FILER_ID, { field: 'filer_id', type: 'number' });
  assert.equal(map.FILER_NAME.field, 'filer_name');
  assert.equal(map.COMPLIANCE_TYPE_DESC.field, 'compliance_type_desc');
  assert.deepEqual(missing, ['OFFICE_DESC']);
  assert.deepEqual(mapColumns(null, ['X']).missing, ['X']);
});

test('soqlLiteral quotes text and validates numbers', () => {
  assert.equal(soqlLiteral({ type: 'number' }, '12345'), '12345');
  assert.equal(soqlLiteral({ type: 'text' }, "O'Brien"), "'O''Brien'");
  assert.throws(() => soqlLiteral({ type: 'number' }, '1 OR 1=1'));
});

test('officeClass normalizes office names', () => {
  assert.equal(officeClass('Governor and Lieutenant Governor'), 'governor');
  assert.equal(officeClass('Lieutenant Governor'), 'lieutenant-governor');
  assert.equal(officeClass('State Senator'), 'state-senate');
  assert.equal(officeClass('Member of Assembly'), 'state-assembly');
  assert.equal(officeClass('Justice of the Supreme Court'), 'supreme-court');
  assert.equal(officeClass('Attorney General'), 'attorney-general');
  assert.equal(officeClass('Town Clerk'), null);
});

const filers = [
  { id: '1', name: 'Friends of Pat Senator', compliance: 'Candidate', filerType: 'State', status: 'Active', office: 'State Senator', district: '28' },
  { id: '2', name: 'Pat Senator 2018', compliance: 'Candidate', filerType: 'State', status: 'Terminated', office: 'State Senator', district: '28' },
  { id: '3', name: 'Lee Assembler For Assembly', compliance: 'Candidate', filerType: 'State', status: 'Active', office: 'Member of Assembly', district: 'AD 075' },
  { id: '4', name: 'Committee To Elect Lee Assembler', compliance: 'Candidate', filerType: 'County', status: 'Active', office: 'Member of Assembly', district: '75' },
  { id: '5', name: 'Smith for Senate', compliance: 'Candidate', filerType: 'State', status: 'Active', office: 'State Senator', district: '10' },
  { id: '6', name: 'Jo Smith Campaign', compliance: 'Candidate', filerType: 'State', status: 'Active', office: 'State Senator', district: '10' },
  { id: '7', name: 'Senator PAC', compliance: 'Committee', filerType: 'State', status: 'Active', office: null, district: null },
];

test('matchFiler requires office, district and surname, preferring the one active committee', () => {
  assert.equal(matchFiler({ name: 'Pat Senator', office: 'State Senator', district: '28' }, filers).id, '1');
  assert.equal(matchFiler({ name: 'Lee Assembler', office: 'Member of Assembly', district: '75' }, filers).id, '3', 'county filers excluded');
  assert.equal(matchFiler({ name: 'Ann Smith', office: 'State Senator', district: '10' }, filers), null, 'ambiguous: two active committees');
  assert.equal(matchFiler({ name: 'Pat Senator', office: 'State Senator', district: '29' }, filers), null);
  assert.equal(matchFiler({ name: 'Nobody Here', office: 'State Senator', district: '28' }, filers), null);
});

test('aggregateTransactions sums by schedule and counts amended transactions once', () => {
  const r = aggregateTransactions([
    { trans: 't1', filing: 'July Periodic', amend: 'N', sched: 'A', schedDesc: 'Monetary Contributions', amount: '100', date: '2026-07-01' },
    { trans: 't1', filing: 'July Periodic', amend: 'Y', sched: 'A', schedDesc: 'Monetary Contributions', amount: '150', date: '2026-07-01' },
    { trans: 't2', filing: 'July Periodic', amend: 'N', sched: 'A', schedDesc: 'Monetary Contributions', amount: '50.5', date: '2026-07-02' },
    { trans: 't3', filing: 'July Periodic', amend: 'N', sched: 'F', schedDesc: 'Expenditures', amount: '75', date: '2026-07-15' },
    { trans: null, filing: 'July Periodic', amend: 'N', sched: 'F', schedDesc: 'Expenditures', amount: '5', date: '2026-07-16' },
    { trans: 't4', filing: 'July Periodic', amend: 'N', sched: 'F', schedDesc: 'Expenditures', amount: 'n/a', date: '2026-07-17' },
  ]);
  assert.deepEqual(r.schedules, [
    { abbrev: 'A', desc: 'Monetary Contributions', total: 200.5, count: 2 },
    { abbrev: 'F', desc: 'Expenditures', total: 80, count: 2 },
  ]);
  assert.equal(r.rowsRead, 6);
  assert.equal(r.latestDate, '2026-07-16');
});

test('disclosureRow reads mapped fields', () => {
  const map = Object.fromEntries(REQUIRED.disclosures.map((k) => [k, { field: k.toLowerCase(), type: 'text' }]));
  const row = disclosureRow({ trans_number: '9', filing_desc: 'Jan Periodic', r_amend: 'y', filing_sched_abbrev: 'A', filing_sched_desc: 'X', org_amt: '10', sched_date: '2026-01-05T00:00:00.000' }, map);
  assert.deepEqual(row, { trans: '9', filing: 'Jan Periodic', amend: 'Y', sched: 'A', schedDesc: 'X', amount: '10', date: '2026-01-05' });
});

test('stateMoney uses linked committee data when present, links otherwise', () => {
  const prev = process.env.FIXTURES;
  process.env.FIXTURES = '1';
  try {
    const j = stateMoney({ state: 'NY', level: 'state', name: 'Sample Candidate J', office: 'State Senator', district: '28', role: 'candidate' });
    assert.equal(j.status, 'ok');
    assert.equal(j.filer.id, '99028');
    assert.ok(j.schedules.length >= 3);
    assert.equal(moneyKey({ office: 'State Senator', district: '028', name: 'Sample Candidate J' }), 'state-senate|28|sample candidate j');
    const m = stateMoney({ state: 'NY', level: 'state', name: 'Sample Candidate M', office: 'Member of Assembly', district: '75', role: 'candidate' });
    assert.equal(m.status, 'link-out');
    assert.ok(m.links.some((l) => l.url === 'https://publicreporting.elections.ny.gov/'));
    const mate = stateMoney({ state: 'NY', level: 'state', name: 'Sample Candidate J', office: 'State Senator', district: '28', role: 'running-mate' });
    assert.equal(mate.status, 'link-out');
    assert.equal(stateMoney({ state: 'CA', level: 'state', name: 'X' }).status, 'link-out');
  } finally {
    if (prev === undefined) delete process.env.FIXTURES; else process.env.FIXTURES = prev;
  }
});
