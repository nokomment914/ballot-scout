import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mapColumns, soqlLiteral, officeClass, districtNumber, personName, samePerson, nameMatch, nameOffice, matchFiler, linkCandidates,
  aggregateTransactions, moneyKey, disclosureRow, groupRow, filerRow, REQUIRED, OPTIONAL, GROUP_FIELDS,
} from '../lib/nymoney.js';
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
  assert.ok(REQUIRED.filers.includes('COMMITTEE_TYPE_DESC'));
  for (const k of GROUP_FIELDS) assert.ok(REQUIRED.disclosures.includes(k), k);
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

test('districtNumber reads numbers and the ordinal words the filer data uses for judicial districts', () => {
  assert.equal(districtNumber('28'), 28);
  assert.equal(districtNumber('AD 075'), 75);
  assert.equal(districtNumber('Tenth'), 10);
  assert.equal(districtNumber('Second Judicial District'), 2);
  assert.equal(districtNumber('13th'), 13);
  assert.equal(districtNumber(''), null);
  assert.equal(districtNumber(null), null);
});

test('names: surnames compare without spaces or hyphens, given names allow common short forms', () => {
  const m = (name, committee) => nameMatch(personName(name), committee);
  assert.equal(m('Kathy C. Hochul', 'Friends for Kathy Hochul'), 'full');
  assert.equal(m('Liz Krueger', 'Krueger for New York'), 'surname');
  assert.equal(m('Liz Krueger', 'Friends Of Liz Krueger'), 'full');
  assert.equal(m('Thomas P. DiNapoli', 'DiNapoli for New York'), 'surname');
  assert.equal(m('Thomas P. DiNapoli', 'Friends of Tom DiNapoli'), 'full', 'short form of the first name');
  assert.equal(m('J Gary Pretlow', 'Friends Of James Gary Pretlow'), 'full', 'goes by the name after an initial');
  assert.equal(m('Carl E. Heastie', 'Friends Of Carl E Heastie'), 'full', 'a middle initial between');
  // Hyphenated and two-word surnames.
  assert.equal(m('Joseph P. De Stefano', 'Friends of Joe DeStefano'), 'full');
  assert.equal(m('Joseph P. De Stefano', 'De Stefano for Assembly'), 'surname');
  assert.equal(m('Joseph P. De Stefano', 'Stefano for Assembly'), null, 'the particle belongs to the surname');
  assert.equal(m('Jessica Gonzalez-Rojas', 'Jessica Gonzalez Rojas for Senate'), 'full');
  assert.equal(m('Jessica Gonzalez-Rojas', 'GONZALEZ-ROJAS FOR NY'), 'surname');
  assert.equal(m('Jessica Gonzalez-Rojas', 'Friends of Jessica Gonzalez'), null, 'half a surname is someone else');
  assert.equal(m('Darializa Avila Chevalier', 'Avila Chevalier for Congress'), 'surname');
  assert.equal(m('Darializa Avila Chevalier', 'Darializa Avila Chevalier 2026'), 'full');
  assert.equal(m('Manny De Los Santos', 'Friends Of Manny De Los Santos'), 'full');
  assert.equal(m("Lynn M. Trupiano-O'Keefe", 'Lynn Trupiano-Okeefe Assembly'), 'full');
  assert.equal(m('Kathleen Waterman-Marshall', 'Kate Waterman-Marshall for Supreme Court'), 'full');
  // A surname inside someone else's name doesn't count.
  for (const other of ['Friends of James Coll', 'James Lynch for NY Senate', 'Friends of Mariama James']) assert.equal(m('Letitia A. James', other), null, other);
  assert.equal(m('Letitia A. James', 'James for NY 2026'), 'surname');
  assert.equal(m('Lola Waterman', 'Kate Waterman-Marshall for Supreme Court'), null);
  assert.equal(m('Jaime R. Williams', 'Committee to Elect Racquel A. Williams'), null, 'an initial is part of a name');
  assert.equal(m('Tony Simone', 'Simonetta-Blair For Dewitt'), null, 'whole words only');
  assert.equal(m('Han-Khon To', 'Committee To Elect Philip Ramos'), null, 'a surname that is also a committee word needs the first name');
  assert.equal(m('Han-Khon To', 'Friends of Han-Khon To'), 'full');
  assert.equal(m('Al Taylor', 'Friends of Fred Taylor'), null, 'two short forms of Alfred are not the same person');
  assert.equal(m('Al Taylor', 'Friends of Alfred Taylor'), 'full');
  assert.equal(m('Tony Simone', 'Tony for New York'), null, 'a first name alone is not enough');
  // Same person across spellings; different people with one surname.
  assert.ok(samePerson(personName('Steve Chan'), personName('Stephen T. Chan')));
  assert.ok(samePerson(personName('Sam Sutton'), personName('Solomon Sam Sutton')));
  assert.ok(samePerson(personName('J. Gustavo Rivera'), personName('Jose Gustavo Rivera')));
  assert.ok(samePerson(personName('Dawn Marie D. Kuhn'), personName('DawnMarie Kuhn')));
  assert.ok(samePerson(personName('James Sanders Jr.'), personName('James  Sanders, Jr.')));
  assert.ok(!samePerson(personName('Howard Lasher'), personName('Susan  Lasher')));
  // Offices named in a committee's name.
  assert.equal(nameOffice('Salazar For Supreme Court'), 'supreme-court');
  assert.equal(nameOffice('Re-Elect Justice Steinman 2026'), 'judicial');
  assert.equal(nameOffice('Parker for Assembly'), 'state-assembly');
  assert.equal(nameOffice('James Lynch for Nassau Legislature'), 'local');
  assert.equal(nameOffice('Friends of Kathy Hochul'), null);
});

// Hand-made rows in the shape of the live data (lib/nymoney.js filerRow and groupRow).
const cand = (id, name, office, district, status = 'ACTIVE', extra = {}) => ({ id, name, compliance: 'CANDIDATE', filerType: 'State', status, office, district, ...extra });
const comm = (id, name, type, status = 'ACTIVE', extra = {}) => ({ id, name, compliance: 'COMMITTEE', filerType: 'State', status, committeeType: type, office: null, district: null, ...extra });
const ASCC = 'Authorized Single Candidate Committee';
const PCF = 'Public Campaign Finance Committee';
const grp = (id, name, n = 10, office = null, district = null) => ({ id, name, office, district, n });

const filers = [
  cand('27197', 'Kathy C. Hochul', 'Governor', null),
  cand('38771', 'Kathleen C. Hochul', 'County Clerk', null, 'TERMINATED', { filerType: 'County', county: 'Erie' }),
  cand('25724', 'Liz  Krueger', 'State Senator', '28', 'TERMINATED'),
  cand('27168', 'Liz  Krueger', 'State Senator', '28', 'TERMINATED'),
  cand('28979', 'Thomas P. DiNapoli', 'State Comptroller', null),
  cand('22938', 'Thomas P Dinapoli', 'Member of Assembly', '16', 'TERMINATED'),
  cand('216875', 'Tony  Simone', 'Member of Assembly', '75', 'TERMINATED'),
  cand('569329', 'Tony  Simone', 'Member of Assembly', '75'),
  cand('27937', 'Letitia  James', 'Attorney General', null),
  cand('591000', 'Mariama N. James', 'Member of Assembly', '65'),
  cand('445001', 'Kristen S Gonzalez', 'State Senator', '59'),
  cand('445002', 'Veronica I. Gonzalez', 'Member of Assembly', '74'),
  cand('500001', 'Ann  Smith', 'State Senator', '10', 'TERMINATED'),
  cand('500002', 'Jo  Smith', 'State Senator', '10', 'TERMINATED'),
  cand('500003', 'Pat  Example', 'Member of Assembly', '30'),
  cand('28210', 'Jessica Gonzalez-Rojas', 'State Senator', '13'),
  cand('27983', 'Joseph P. De Stefano', 'Member of Assembly', '3'),
  cand('27893', 'Julia  Salazar', 'State Senator', '18'),
  cand('34083', 'Hemalee J Patel', 'Supreme Court Justice', 'Second'),
  cand('38611', 'Daniel P Losquadro', 'County Comptroller', null, 'ACTIVE', { filerType: 'County', county: 'Suffolk' }),
];
const committees = [
  comm('16851', 'Friends for Kathy Hochul', ASCC),
  comm('4678', 'Friends Of Kathy Hochul', ASCC, 'TERMINATED', { filerType: 'County', county: 'Erie' }),
  comm('14602', 'Friends Of Liz Krueger', ASCC, 'TERMINATED'),
  comm('371436', 'Krueger for New York', ASCC),
  comm('308716', 'DiNapoli for New York', PCF),
  comm('22271', 'Dinapoli 2022 Inc.', ASCC, 'TERMINATED'),
  comm('11517', 'Committee To Elect Anthony Simone', ASCC, 'ACTIVE', { filerType: 'County', county: 'Schenectady' }),
  comm('569330', 'Tony for New York', PCF),
  comm('308810', 'James for NY 2026', PCF),
  comm('591076', 'Friends of Mariama James', PCF),
  comm('445624', 'Gonzalez for New York 2026', ASCC),
  comm('600001', 'Smith for Senate', PCF),
  comm('600002', 'Friends of Pat Example', ASCC),
  comm('600003', 'Pat Example 2026', PCF),
  comm('600004', 'Example PAC', 'Political Action Committee'),
  comm('600005', 'Friends of Jessica Gonzalez-Rojas', PCF),
  comm('414194', 'Friends of Joe DeStefano', PCF),
  comm('382860', 'Salazar for Senate', ASCC),
  comm('538685', 'Salazar For Supreme Court', ASCC),
  comm('17802', 'Friends Of Dan Losquadro', ASCC, 'ACTIVE', { filerType: 'County', county: 'Suffolk' }),
  comm('17803', 'Friends of Dan Losquadro', ASCC, 'ACTIVE', { filerType: 'County', county: 'Albany' }),
  comm('600006', 'Friends of Pat Senator', ASCC),
  comm('600007', 'Lee Assembler 2026', PCF),
];
// Filers with disclosure rows in the years covered. Committee rows carry no office; a few filers'
// rows do (as party and independent-expenditure committees' rows do on data.ny.gov).
const groups = [
  ...['16851', '4678', '14602', '371436', '308716', '22271', '11517', '569330', '308810', '591076', '445624', '600001', '600002', '600003', '600004', '600005', '414194', '382860', '538685', '17802', '17803']
    .map((id) => grp(id, committees.find((k) => k.id === id).name)),
  grp('34083', 'Hemalee J Patel', 16),
  grp('600006', 'Friends of Pat Senator', 5, 'State Senator', '28'),
  grp('600007', 'Lee Assembler 2026', 5, 'Member of Assembly', '76'),
];
const seed = [
  { name: 'Kathy C. Hochul', office: 'Governor and Lieutenant Governor', district: null, level: 'state' },
  { name: 'Liz Krueger', office: 'State Senator', district: '28', level: 'state' },
  { name: 'Thomas P. DiNapoli', office: 'Comptroller', district: null, level: 'state' },
  { name: 'Tony Simone', office: 'Member of Assembly', district: '75', level: 'state' },
  { name: 'Letitia A. James', office: 'Attorney General', district: null, level: 'state' },
  { name: 'Kristen Gonzalez', office: 'State Senator', district: '59', level: 'state' },
  { name: 'Veronica I. Gonzalez', office: 'Member of Assembly', district: '74', level: 'state' },
  { name: 'Ann Smith', office: 'State Senator', district: '10', level: 'state' },
  { name: 'Jo Smith', office: 'State Senator', district: '10', level: 'state' },
  { name: 'Pat Example', office: 'Member of Assembly', district: '30', level: 'state' },
  { name: 'Jessica Gonzalez-Rojas', office: 'State Senator', district: '13', level: 'state' },
  { name: 'Joseph P. De Stefano', office: 'Member of Assembly', district: '3', level: 'state' },
  { name: 'Julia Salazar', office: 'State Senator', district: '18', level: 'state' },
  { name: 'Hemalee J. Patel', office: 'Justice of the Supreme Court', district: '2', level: 'judicial' },
  { name: 'Daniel P. Losquadro', office: 'County Comptroller', district: 'Suffolk', level: 'local', county: 'Suffolk' },
  { name: 'Pat Senator', office: 'State Senator', district: '28', level: 'state' },
  { name: 'Lee Assembler', office: 'Member of Assembly', district: '75', level: 'state' },
  { name: 'Edward Lee', office: 'Member of Assembly', district: '36', level: 'state' },
];
const result = linkCandidates(seed, { filers, committees, groups });
const linkOf = (name) => result.links[seed.findIndex((c) => c.name === name)];
const problemOf = (name) => result.unmatched.find((u) => u.index === seed.findIndex((c) => c.name === name));
const ids = (name) => linkOf(name)?.committees.map((k) => k.id) ?? null;

test('linkCandidates: the committee that files, not the candidate filer record', () => {
  const hochul = linkOf('Kathy C. Hochul');
  assert.deepEqual(ids('Kathy C. Hochul'), ['16851'], 'Friends for Kathy Hochul, not candidate filer 27197');
  assert.equal(hochul.filer.id, '27197', 'the candidate filer is kept as the registration');
  assert.deepEqual(hochul.committees[0], { id: '16851', name: 'Friends for Kathy Hochul', type: ASCC, status: 'ACTIVE', match: 'full' });
  assert.equal(hochul.matchedBy, 'registration+name');
  assert.equal(hochul.filerFilings, false);
  assert.deepEqual(hochul.filerIds, ['16851']);
});

test('linkCandidates: terminated committees are never picked', () => {
  assert.deepEqual(ids('Liz Krueger'), ['371436'], 'not Friends Of Liz Krueger (terminated), even with filings this cycle');
  assert.equal(linkOf('Liz Krueger').committees[0].match, 'surname');
  assert.equal(linkOf('Liz Krueger').filer.id, '27168', 'two terminated registrations: the newest is shown');
  assert.deepEqual(ids('Thomas P. DiNapoli'), ['308716'], 'not Dinapoli 2022 Inc. (terminated)');
});

test('linkCandidates: an authorized and a public-financing committee are both linked', () => {
  assert.deepEqual(ids('Pat Example'), ['600002', '600003']);
  assert.ok(!ids('Pat Example').includes('600004'), 'a PAC is not a candidate committee');
  // Their transactions are summed together; the same transaction number in each is two transactions.
  const r = aggregateTransactions([
    { filer: '600002', trans: '1', filing: 'July Periodic', amend: 'N', sched: 'A', schedDesc: 'Monetary Contributions Received From Ind. & Part.', amount: '100', date: '2026-07-01' },
    { filer: '600002', trans: '1', filing: 'July Periodic', amend: 'Y', sched: 'A', schedDesc: 'Monetary Contributions Received From Ind. & Part.', amount: '150', date: '2026-07-01' },
    { filer: '600003', trans: '1', filing: 'July Periodic', amend: 'N', sched: 'A', schedDesc: 'Monetary Contributions Received From Ind. & Part.', amount: '40', date: '2026-07-02' },
  ]);
  assert.deepEqual(r.schedules, [{ abbrev: 'A', desc: 'Monetary Contributions Received From Ind. & Part.', total: 190, count: 2 }]);
});

test('linkCandidates: ambiguous matches link nothing and say why', () => {
  // Two candidates on the ballot would both claim "Smith for Senate".
  for (const name of ['Ann Smith', 'Jo Smith']) {
    assert.equal(linkOf(name), null, name);
    assert.equal(problemOf(name).code, 'shared');
    assert.match(problemOf(name).reason, /"Smith for Senate" \(filer ID 600001\) also matches/);
  }
  // A surname-only name another active candidate shares, on the ballot or not.
  assert.equal(linkOf('Letitia A. James'), null);
  assert.equal(problemOf('Letitia A. James').code, 'ambiguous');
  assert.match(problemOf('Letitia A. James').reason, /James for NY 2026.*Mariama N\. James/);
  for (const name of ['Kristen Gonzalez', 'Veronica I. Gonzalez']) assert.equal(problemOf(name).code, 'ambiguous', name);
});

test('linkCandidates: right level, office and name, or nothing', () => {
  // Tony Simone's only surname match is a Schenectady County committee for "Anthony Simone".
  assert.equal(linkOf('Tony Simone'), null);
  assert.equal(problemOf('Tony Simone').code, 'no-committee');
  assert.deepEqual(ids('Jessica Gonzalez-Rojas'), ['600005']);
  assert.deepEqual(ids('Joseph P. De Stefano'), ['414194']);
  assert.deepEqual(ids('Julia Salazar'), ['382860'], 'a committee named for another office is left out');
  assert.equal(problemOf('Edward Lee').code, 'no-registration');
  // County races: county committees in the same county.
  assert.deepEqual(ids('Daniel P. Losquadro'), ['17802']);
  assert.ok(!ids('Kathy C. Hochul').includes('4678'), 'county committee left out of a state race');
});

test('linkCandidates: a candidate filing under their own registration, and offices named in the filings', () => {
  const patel = linkOf('Hemalee J. Patel');
  assert.equal(patel.filer.id, '34083', '"Second" judicial district read as district 2');
  assert.deepEqual(patel.committees, []);
  assert.equal(patel.filerFilings, true);
  assert.equal(patel.matchedBy, 'registration');
  assert.deepEqual(patel.filerIds, ['34083']);
  // No registration, but the committee's own filings name this office and district.
  assert.deepEqual(ids('Pat Senator'), ['600006']);
  assert.equal(linkOf('Pat Senator').matchedBy, 'filings-office+name');
  // Filings naming another district rule the committee out.
  assert.equal(linkOf('Lee Assembler'), null);
});

test('matchFiler keeps the candidate-filer match: office, district, name and level', () => {
  assert.equal(matchFiler({ name: 'Tony Simone', office: 'Member of Assembly', district: '75', level: 'state' }, filers).id, '569329', 'the active registration');
  assert.equal(matchFiler({ name: 'Tony Simone', office: 'Member of Assembly', district: '76', level: 'state' }, filers), null);
  assert.equal(matchFiler({ name: 'Kathy Hochul', office: 'County Clerk', district: null, level: 'state' }, filers), null, 'county filers excluded from state races');
  assert.equal(matchFiler({ name: 'Nobody Here', office: 'State Senator', district: '28', level: 'state' }, filers), null);
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

test('row readers map fields', () => {
  const map = Object.fromEntries(REQUIRED.disclosures.map((k) => [k, { field: k.toLowerCase(), type: 'text' }]));
  const row = disclosureRow({ filer_id: 16851, trans_number: '9', filing_desc: 'Jan Periodic', r_amend: 'y', filing_sched_abbrev: 'A', filing_sched_desc: 'X', org_amt: '10', sched_date: '2026-01-05T00:00:00.000' }, map);
  assert.deepEqual(row, { filer: '16851', trans: '9', filing: 'Jan Periodic', amend: 'Y', sched: 'A', schedDesc: 'X', amount: '10', date: '2026-01-05' });
  assert.deepEqual(groupRow({ filer_id: '371436', cand_comm_name: 'Krueger for New York', n: '283' }, map), { id: '371436', name: 'Krueger for New York', office: null, district: null, n: 283 });
  const fmap = Object.fromEntries([...REQUIRED.filers, ...OPTIONAL.filers].map((k) => [k, { field: k.toLowerCase(), type: 'text' }]));
  assert.deepEqual(filerRow({ filer_id: '16851', filer_name: 'Friends for Kathy Hochul', compliance_type_desc: 'COMMITTEE', filer_type_desc: 'State', filer_status: 'ACTIVE', committee_type_desc: ASCC }, fmap),
    { id: '16851', name: 'Friends for Kathy Hochul', compliance: 'COMMITTEE', filerType: 'State', status: 'ACTIVE', committeeType: ASCC, office: null, district: null, county: null });
});

test('stateMoney names the linked committees and links each to the official search', () => {
  const prev = process.env.FIXTURES;
  process.env.FIXTURES = '1';
  try {
    const j = stateMoney({ state: 'NY', level: 'state', name: 'Sample Candidate J', office: 'State Senator', district: '28', role: 'candidate' });
    assert.equal(j.status, 'ok');
    assert.deepEqual(j.committees.map((c) => [c.id, c.name, c.type, c.status]), [['99028', 'Friends of Sample Candidate J (fictional)', ASCC, 'ACTIVE']]);
    assert.deepEqual(j.committees[0].search, { label: 'Look up filer ID 99028 in the NYS Board of Elections disclosure search', url: 'https://publicreporting.elections.ny.gov/' });
    assert.equal(j.filer.id, '99027');
    assert.equal(j.filerFilings, false);
    assert.equal(j.matchedBy, 'registration+name');
    assert.match(j.matchNote, /registered .* for this office and district/);
    assert.ok(j.schedules.length >= 3);
    assert.match(j.note, /by the filer above/);
    assert.equal(moneyKey({ office: 'State Senator', district: '028', name: 'Sample Candidate J' }), 'state-senate|28|sample candidate j');
    const m = stateMoney({ state: 'NY', level: 'state', name: 'Sample Candidate M', office: 'Member of Assembly', district: '75', role: 'candidate' });
    assert.equal(m.status, 'link-out');
    assert.ok(m.links.some((l) => l.url === 'https://publicreporting.elections.ny.gov/'));
    const mate = stateMoney({ state: 'NY', level: 'state', name: 'Sample Candidate J', office: 'State Senator', district: '28', role: 'running-mate' });
    assert.equal(mate.status, 'link-out');
    assert.equal(stateMoney({ state: 'CA', level: 'state', name: 'X' }).status, 'link-out');
    // County comptroller races are built, so an unlinked candidate there isn't told county money isn't covered.
    assert.match(stateMoney({ state: 'NY', level: 'local', name: 'Sample Candidate Q', office: 'County Comptroller', district: 'Suffolk', role: 'candidate' }).note, /^County candidates in New York file/);
    assert.match(stateMoney({ state: 'NY', level: 'local', name: 'Sample Candidate Q', office: 'Town Supervisor', district: null, role: 'candidate' }).note, /doesn’t total campaign money for county, town and village candidates yet/);
  } finally {
    if (prev === undefined) delete process.env.FIXTURES; else process.env.FIXTURES = prev;
  }
});

test('stateMoney ignores money files built before committees were linked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ny-money-'));
  const prev = { FIXTURES: process.env.FIXTURES, DATA_DIR: process.env.DATA_DIR };
  try {
    fs.mkdirSync(path.join(dir, 'ny'));
    const entry = { filer: { id: '27197', name: 'Kathy C. Hochul' }, years: ['2025', '2026'], schedules: [], transactions: 0 };
    fs.writeFileSync(path.join(dir, 'ny', 'money-2026.json'), JSON.stringify({ schemaVersion: 1, years: ['2025', '2026'], candidates: { 'governor||kathy hochul': entry } }));
    process.env.FIXTURES = '';
    process.env.DATA_DIR = dir;
    assert.equal(stateMoney({ state: 'NY', level: 'state', name: 'Kathy C. Hochul', office: 'Governor and Lieutenant Governor', district: null, role: 'candidate' }).status, 'link-out');
  } finally {
    for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
