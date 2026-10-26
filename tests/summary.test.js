// "At a glance": fixed templates for the Money, Positions and Record lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummary, formatMoney, formatDate, firstSentence, isContributionSchedule, CONTRIBUTION_SCHEDULES } from '../lib/summary.js';
import { bannedWordsIn } from '../lib/validate-stances.js';

const line = (summary, kind) => summary.lines.find((l) => l.kind === kind);
const money = (m, role = 'candidate') => line(buildSummary({ role, issueIds: ['housing'], money: m, votes: { items: [] }, stances: null }), 'money').text;

test('money amounts are rounded the same way everywhere', () => {
  assert.equal(formatMoney(3493973.6), '$3.5 million');
  assert.equal(formatMoney(812345), '$812,000');
  assert.equal(formatMoney(9549), '$9,500');
  assert.equal(formatMoney(0), '$0');
  assert.equal(formatMoney(1000000), '$1 million', 'drops ".0"');
  assert.equal(formatMoney(12345678), '$12.3 million');
  assert.equal(formatMoney(999600), '$1 million', 'rounding up into millions');
  assert.equal(formatMoney(250), '$250');
  assert.equal(formatMoney(null), '$0');
  assert.equal(formatDate('2026-10-14'), 'Oct 14, 2026');
  assert.equal(formatDate('2026-10-14T23:59:00Z'), 'Oct 14, 2026');
  assert.equal(formatDate('soon'), null);
});

test('money line: federal candidates', () => {
  const fec = { kind: 'fec', status: 'ok', cycle: 2026, totals: { receipts: 3493973.6, coverageEndDate: '2026-10-14' }, sizes: { smallDollarShare: 0.0512 } };
  assert.equal(money(fec), 'Raised $3.5 million for this race through Oct 14, 2026; 5% of the money from individual donors came in donations of $200 or less.');
  assert.equal(money({ ...fec, sizes: null }), 'Raised $3.5 million for this race through Oct 14, 2026.', 'second clause omitted without sizes');
  assert.equal(money({ ...fec, sizes: { smallDollarShare: null } }), 'Raised $3.5 million for this race through Oct 14, 2026.');
  // Outside spending: a zero side is left out.
  assert.match(money({ ...fec, outside: { support: 812345, oppose: 9549 } }), /less\. Outside groups reported spending \$812,000 supporting and \$9,500 opposing\.$/);
  assert.match(money({ ...fec, outside: { support: 812345, oppose: 0 } }), /Outside groups reported spending \$812,000 supporting\.$/);
  assert.match(money({ ...fec, outside: { support: 0, oppose: 9549 } }), /Outside groups reported spending \$9,500 opposing\.$/);
  assert.doesNotMatch(money({ ...fec, outside: { support: 0, oppose: 0 } }), /Outside/);
  // Once the nightly FEC build has run, the Money tab shows its figures for this cycle, and so does the line.
  const built = { status: 'recorded', entry: { status: 'ok', cycles: { 2026: { totals: { support: 1500, oppose: 250 } }, 2024: { totals: { support: 9e6, oppose: 0 } } } } };
  assert.match(money({ ...fec, outside: { support: 1, oppose: 1 }, outsideByCycle: built }), /spending \$1,500 supporting and \$250 opposing\.$/);
  assert.doesNotMatch(money({ ...fec, outside: { support: 5000, oppose: 0 }, outsideByCycle: { status: 'not-found', entry: null } }), /Outside/);
  assert.match(money({ ...fec, outside: { support: 5000, oppose: 0 }, outsideByCycle: { status: 'not-built', entry: null } }), /spending \$5,000 supporting\.$/);
});

test('money line: everyone else', () => {
  assert.equal(money({ kind: 'state', status: 'link-out', links: [] }, 'running-mate'), 'Shares the ticket’s campaign committee; see the candidate for Governor.');
  const noTotals = 'No campaign finance totals are shown for this candidate; the Money tab links to the official filings.';
  for (const status of ['not-found', 'not-configured', 'unavailable']) assert.equal(money({ kind: 'fec', status, links: [{ label: 'Search FEC.gov', url: 'https://www.fec.gov/' }] }), noTotals, status);
  assert.equal(money({ kind: 'state', status: 'link-out', links: [{ label: 'NYS Board of Elections', url: 'https://publicreporting.elections.ny.gov/' }] }), noTotals);
  assert.equal(money({ kind: 'state', status: 'link-out', links: [] }), 'No campaign finance totals are shown for this candidate.', 'no links promised where there are none');
});

test('New York contribution schedules: A, B and C, confirmed by the name in the filings', () => {
  assert.deepEqual(CONTRIBUTION_SCHEDULES, ['A', 'B', 'C']);
  // As published in the disclosure data (data/ny/money-2026.json).
  assert.equal(isContributionSchedule({ abbrev: 'C', desc: 'Monetary Contributions Received From All Other' }), true);
  assert.equal(isContributionSchedule({ abbrev: 'F', desc: 'Expenditures/ Payments' }), false);
  assert.equal(isContributionSchedule({ abbrev: 'A', desc: 'Monetary Contributions Received From Ind. & Part.' }), true);
  assert.equal(isContributionSchedule({ abbrev: 'b', desc: 'Monetary Contributions Received From Corporation' }), true);
  for (const [abbrev, desc] of [['D', 'In-Kind (Non-Monetary) Contributions Received'], ['E', 'Other Receipts Received'], ['G', 'Transfers In'], ['I', 'Loans Received'], ['L', 'Expenditure Refunds (Increases Balance)'], ['M', 'Contributions Refunded (Decreases Balance)'], ['S', 'Public Funds Receipts']]) {
    assert.equal(isContributionSchedule({ abbrev, desc }), false, `${abbrev}: ${desc}`);
  }
  assert.equal(isContributionSchedule({ abbrev: 'A', desc: 'A' }), false, 'no name to confirm the letter');
  assert.equal(isContributionSchedule({ abbrev: 'X', desc: 'Monetary Contributions Received' }), false, 'name without the letter');
});

test('money line: New York State candidates', () => {
  const state = (schedules, extra = {}) => money({ kind: 'state', status: 'ok', years: '2025–2026', filer: { name: 'Friends of Pat Example' }, schedules, ...extra });
  assert.equal(state([
    { abbrev: 'A', desc: 'Monetary Contributions Received From Ind. & Part.', total: 182500, count: 640 },
    { abbrev: 'B', desc: 'Monetary Contributions Received From Corporation', total: 12000, count: 8 },
    { abbrev: 'C', desc: 'Monetary Contributions Received From All Other', total: 41000, count: 37 },
    { abbrev: 'D', desc: 'In-Kind (Non-Monetary) Contributions Received', total: 5000, count: 2 },
    { abbrev: 'F', desc: 'Expenditures/ Payments', total: 151230.55, count: 212 },
    { abbrev: 'G', desc: 'Transfers In', total: 90000, count: 1 },
  ]), 'Itemized contributions of $236,000 reported in 2025–2026 filings (Friends of Pat Example).');
  assert.equal(state([{ abbrev: 'C', desc: 'Monetary Contributions Received From All Other', total: 1550.82, count: 1 }, { abbrev: 'F', desc: 'Expenditures/ Payments', total: 1163.96, count: 8 }]),
    'Itemized contributions of $1,600 reported in 2025–2026 filings (Friends of Pat Example).');
  const fallback = 'Campaign finance filings for 2025–2026 are summarized in the Money tab.';
  assert.equal(state([]), fallback, 'no transactions: no total is claimed');
  assert.equal(state([{ abbrev: 'F', desc: 'Expenditures/ Payments', total: 100, count: 1 }]), fallback);
  assert.equal(state([{ abbrev: 'A', desc: 'A', total: 100, count: 1 }, { abbrev: 'C', desc: 'Monetary Contributions Received From All Other', total: 50, count: 1 }]), fallback, 'an unnamed contribution schedule would make a partial total');
  assert.equal(state([{ abbrev: 'A', desc: 'Monetary Contributions Received From Ind. & Part.', total: 100, count: 1 }], { filer: null }), 'Itemized contributions of $100 reported in 2025–2026 filings.');
});

test('positions line follows the Positions tab', () => {
  const positions = (stances, issueIds = ['housing', 'health', 'taxes']) => line(buildSummary({ issueIds, votes: { items: [] }, money: null, stances }), 'positions');
  const ok = positions({
    status: 'ok',
    items: [
      { issue: 'health', issueLabel: 'Health care', summary: 'Wants to cap insulin costs at $35 a month for every patient.' },
      { issue: 'housing', issueLabel: 'Housing', summary: 'Supports more federal tax credits for rental homes.' },
      { issue: 'housing', issueLabel: 'Housing', summary: 'Proposes grants for cities that allow more apartments.' },
    ],
  });
  assert.equal(ok.text, null);
  assert.deepEqual(ok.items, [
    { issueLabel: 'Housing', text: 'Supports more federal tax credits for rental homes.' },
    { issueLabel: 'Health care', text: 'Wants to cap insulin costs at $35 a month for every patient.' },
  ], 'the first stance per selected issue, in issue order');
  assert.deepEqual(positions({ status: 'none-on-issues', note: 'No public statement on Housing was found.', items: [] }), { kind: 'positions', text: 'No public statement found on your issues in the sources checked.', items: [] });
  assert.equal(positions({ status: 'not-researched', note: 'Positions for this race haven’t been fully researched yet, so none are shown for any candidate in it.', items: [] }).text, 'Positions not researched yet.');
  assert.equal(positions({ status: 'judicial', note: 'Under New York’s rules for judicial campaigns, …', items: [] }).text, 'Under New York’s rules for judicial campaigns, …');
  assert.equal(positions({ status: 'running-mate', note: 'Positions for this ticket are listed under the candidate for Governor.', items: [] }).text, 'Positions for this ticket are listed under the candidate for Governor.');
  assert.equal(positions(null).text, 'Positions not researched yet.');
});

test('record line counts the votes the Votes tab lists', () => {
  const record = (votes, issueIds = ['housing', 'health', 'taxes']) => line(buildSummary({ issueIds, votes, money: null, stances: null }), 'record').text;
  const v = (date, issues, extra = {}) => ({ date, issues, ...extra });
  assert.equal(record({ items: [v('2026-03-02', ['housing']), v('2025-06-01', ['housing', 'health']), v('2026-10-01', ['health']), v('2024-01-05', ['taxes'])] }),
    '4 recorded votes on your issues, most recently on Oct 1, 2026. Housing: 2 · Health care: 2 · Taxes: 1.');
  assert.equal(record({ items: [v('2025-06-01', ['health'])] }), '1 recorded vote on your issues, on Jun 1, 2025. Health care: 1.');
  assert.equal(record({ items: [v('2025-06-01', ['housing']), v('2024-01-03', ['israel-palestine'], { notInOffice: true })] }),
    '1 recorded vote on your issues, on Jun 1, 2025. Housing: 1.', 'roll calls before the member took office aren’t their votes');
  assert.equal(record({ items: [], note: 'Executive office: no voting record. The Governor’s signatures and vetoes on your issues are listed below.', executive: { items: [{}, {}, {}] } }),
    'Executive office: no voting record. As Governor: 3 bills signed or vetoed on your issues.');
  assert.equal(record({ items: [v('2025-06-01', ['housing'])], executive: { items: [{}] } }), '1 recorded vote on your issues, on Jun 1, 2025. Housing: 1. As Governor: 1 bill signed or vetoed on your issues.');
  assert.equal(record({ items: [], note: 'Judicial races have no voting records. Judges don’t vote on legislation.' }), 'Judicial races have no voting records.');
  assert.equal(record({ items: [], note: 'No recorded votes on Housing, Taxes in the sessions covered. The Israel and Palestine list covers U.S. House roll calls on military aid and arms; this candidate has no votes on it.' }), 'No recorded votes on Housing, Taxes in the sessions covered.');
  assert.equal(record({ items: [] }), 'No recorded votes on your issues.');
  assert.equal(record(undefined), 'No recorded votes on your issues.');
});

test('firstSentence keeps abbreviations together', () => {
  assert.equal(firstSentence('The list covers U.S. House roll calls. Nothing else.'), 'The list covers U.S. House roll calls.');
  assert.equal(firstSentence('Signed by Gov. Example in 2025. Then vetoed.'), 'Signed by Gov. Example in 2025.');
  assert.equal(firstSentence('One sentence only'), 'One sentence only');
  assert.equal(firstSentence(''), null);
});

test('the lines are plain: fixed templates, no characterizing words', () => {
  const s = buildSummary({
    role: 'candidate',
    issueIds: ['housing'],
    money: { kind: 'fec', status: 'ok', cycle: 2026, totals: { receipts: 812345, coverageEndDate: '2026-09-30' }, sizes: { smallDollarShare: 0.5 }, outside: { support: 100, oppose: 200 } },
    votes: { items: [{ date: '2026-01-01', issues: ['housing'] }] },
    stances: { status: 'ok', items: [{ issue: 'housing', issueLabel: 'Housing', summary: 'Supports more federal tax credits for rental homes.' }] },
  });
  assert.deepEqual(s.lines.map((l) => l.kind), ['money', 'positions', 'record']);
  const text = JSON.stringify(s);
  assert.deepEqual(bannedWordsIn(text), []);
  assert.ok(!/\b(more|less|most|least) than\b|\bhigher\b|\blower\b|\bopponent\b/i.test(s.lines[0].text + s.lines[2].text), 'no comparisons');
});
