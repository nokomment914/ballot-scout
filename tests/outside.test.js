// Outside spending (independent expenditures): pure aggregation, the ballot summary, and the
// nightly build script run end to end against a local stand-in for the OpenFEC API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { committeeGroup, summarizeCycle, summarizeNotices, entryStatus, outsideKey, ballotOutside, COMMITTEE_TYPES } from '../lib/outside.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('FEC committee types are grouped so super PACs stand apart', () => {
  for (const t of ['O', 'U', 'V', 'W']) assert.equal(committeeGroup(t), 'super-pac', t);
  for (const t of ['X', 'Y', 'Z']) assert.equal(committeeGroup(t), 'party', t);
  for (const t of ['N', 'Q']) assert.equal(committeeGroup(t), 'pac', t);
  for (const t of ['I', null, '', 'C']) assert.equal(committeeGroup(t), 'other', String(t));
  assert.match(COMMITTEE_TYPES.O, /Super PAC/);
});

test('summarizeCycle splits spending by spender type and lists the largest spenders', () => {
  const r = summarizeCycle({
    cycle: 2026,
    totals: [{ cycle: 2026, support_oppose_indicator: 'S', total: 1500 }, { cycle: 2026, support_oppose_indicator: 'O', total: 250 }, { cycle: 2024, support_oppose_indicator: 'S', total: 999 }],
    byCommittee: [
      { cycle: 2026, committee_id: 'C1', committee_name: 'Example Super PAC', support_oppose_indicator: 'S', total: 1000 },
      { cycle: 2026, committee_id: 'C2', committee_name: 'Example Party', support_oppose_indicator: 'S', total: 500 },
      { cycle: 2026, committee_id: 'C1', committee_name: 'Example Super PAC', support_oppose_indicator: 'O', total: 250 },
      { cycle: 2026, committee_id: 'C3', committee_name: 'Zero', support_oppose_indicator: 'O', total: 0 },
    ],
    committees: { C1: { committee_type: 'O' }, C2: { committee_type: 'Y' } },
  });
  assert.deepEqual(r.totals, { support: 1500, oppose: 250 }, 'other cycles are ignored');
  assert.deepEqual(r.byGroup['super-pac'], { support: 1000, oppose: 250 });
  assert.deepEqual(r.byGroup.party, { support: 500, oppose: 0 });
  assert.deepEqual(r.spenders.map((s) => `${s.name}:${s.position}:${s.total}:${s.group}`), ['Example Super PAC:support:1000:super-pac', 'Example Party:support:500:party', 'Example Super PAC:oppose:250:super-pac']);
  assert.equal(r.notices, null);
});

test('summarizeNotices counts each 24/48-hour item once and skips memo lines', () => {
  const n = summarizeNotices([
    { sub_id: '1', committee_id: 'C1', committee: { committee_type: 'O' }, support_oppose_indicator: 'S', expenditure_amount: 300, filing_date: '2026-10-10' },
    { sub_id: '1', committee_id: 'C1', committee: { committee_type: 'O' }, support_oppose_indicator: 'S', expenditure_amount: 300, filing_date: '2026-10-10' },
    { sub_id: '2', committee_id: 'C1', memoed_subtotal: true, support_oppose_indicator: 'S', expenditure_amount: 999 },
    { sub_id: '3', committee_id: 'C9', support_oppose_indicator: 'O', expenditure_amount: 40, filing_date: '2026-10-12' },
  ], { C9: { committee_type: 'X' } });
  assert.equal(n.support, 300);
  assert.equal(n.oppose, 40);
  assert.equal(n.count, 2);
  assert.equal(n.latestFiled, '2026-10-12');
  assert.deepEqual(n.byGroup['super-pac'], { support: 300, oppose: 0 });
  assert.deepEqual(n.byGroup.party, { support: 0, oppose: 40 });
});

test('entryStatus: super PAC spending, other spending, or none on record', () => {
  const zero = { support: 0, oppose: 0 };
  const groups = (sp, other) => ({ 'super-pac': sp, party: other, pac: zero, other: zero });
  assert.deepEqual(entryStatus({ status: 'ok', cycles: { 2026: { byGroup: groups({ support: 5, oppose: 0 }, zero), totals: { support: 5, oppose: 0 } } } }), { status: 'recorded', superPac: true, other: false });
  assert.deepEqual(entryStatus({ status: 'ok', cycles: { 2026: { byGroup: groups(zero, { support: 0, oppose: 7 }), totals: { support: 0, oppose: 7 } } } }), { status: 'recorded', superPac: false, other: true });
  assert.deepEqual(entryStatus({ status: 'ok', cycles: { 2026: { byGroup: groups(zero, zero), totals: zero, notices: { byGroup: groups({ support: 1, oppose: 0 }, zero) } } } }), { status: 'recorded', superPac: true, other: false }, '24/48-hour reports count');
  assert.deepEqual(entryStatus({ status: 'ok', cycles: { 2026: { byGroup: groups(zero, zero), totals: zero } } }), { status: 'none', superPac: false, other: false });
  assert.equal(entryStatus(null).status, 'not-built');
  assert.equal(entryStatus({ status: 'not-found' }).status, 'not-found');
});

test('outsideKey ignores case, accents, punctuation and leading zeros', () => {
  assert.equal(outsideKey({ state: 'ny', officeKey: 'us-house', district: '017', name: 'Mike Lawler' }), 'NY|us-house|17|mikelawler');
  assert.equal(outsideKey({ state: 'NY', officeKey: 'us-house', district: '3', name: 'Michael J. LiPetri Jr.' }), outsideKey({ state: 'NY', officeKey: 'us-house', district: 3, name: 'MICHAEL J LIPETRI JR' }));
});

test('ballotOutside covers every candidate in the federal race, in the same shape (sample data)', () => {
  const prev = process.env.FIXTURES;
  process.env.FIXTURES = '1';
  try {
    const contests = [
      { id: 'fx-cd-12', office: 'Representative in Congress', level: 'federal', districtType: 'congressional', district: '12', districtLabel: 'Congressional District 12', candidates: [{ name: 'Sample Candidate G' }, { name: 'Sample Candidate H' }, { name: 'Sample Candidate Z' }] },
      { id: 'fx-sd-28', office: 'State Senator', level: 'state', districtType: 'state-senate', district: '28', candidates: [{ name: 'Sample Candidate K' }] },
    ];
    const o = ballotOutside(contests, 'NY');
    assert.equal(o.status, 'ok');
    assert.equal(o.contests.length, 1, 'state races are not in the FEC summary');
    const [g, hh, z] = o.contests[0].candidates;
    assert.equal(g.status, 'recorded');
    assert.equal(g.superPac, true);
    assert.equal(hh.status, 'none');
    assert.equal(z.status, 'not-found');
    assert.deepEqual(Object.keys(g).sort(), Object.keys(hh).sort(), 'same fields for everyone');
  } finally {
    if (prev === undefined) delete process.env.FIXTURES; else process.env.FIXTURES = prev;
  }
});

// ---------- scripts/build-outside.mjs against a local OpenFEC stand-in ----------
let server;
let base;
let tmp;
const hits = [];

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push(`${u.pathname}?${u.searchParams.toString()}`);
    const send = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const id = u.searchParams.get('candidate_id');
    const cycle = Number(u.searchParams.get('cycle'));
    if (u.pathname === '/candidates/search/') {
      const q = u.searchParams.get('q');
      return send({ results: q === 'Example' ? [{ candidate_id: 'H6NY99001', name: 'EXAMPLE, PAT', principal_committees: [] }] : [] });
    }
    if (u.pathname === '/schedules/schedule_e/totals/by_candidate/') {
      return send({ results: cycle === 2026 ? [{ candidate_id: id, cycle: 2026, support_oppose_indicator: 'S', total: 1500 }, { candidate_id: id, cycle: 2026, support_oppose_indicator: 'O', total: 250 }] : [] });
    }
    if (u.pathname === '/schedules/schedule_e/by_candidate/') {
      if (!u.searchParams.get('office') || !cycle) { res.writeHead(422); return res.end('{"message":"office and cycle are required"}'); }
      const rows = cycle === 2026 ? [
        { candidate_id: id, cycle: 2026, committee_id: 'C001', committee_name: 'Example Super PAC', support_oppose_indicator: 'S', total: 1000 },
        { candidate_id: id, cycle: 2026, committee_id: 'C002', committee_name: 'Example Party Committee', support_oppose_indicator: 'S', total: 500 },
        { candidate_id: id, cycle: 2026, committee_id: 'C001', committee_name: 'Example Super PAC', support_oppose_indicator: 'O', total: 250 },
      ] : [];
      return send({ results: rows, pagination: { page: 1, pages: 1, count: rows.length } });
    }
    if (u.pathname === '/schedules/schedule_e/') {
      return send({ results: [
        { sub_id: '11', committee_id: 'C001', committee: { committee_type: 'O' }, support_oppose_indicator: 'S', expenditure_amount: 300, filing_date: '2026-10-10', is_notice: true },
        { sub_id: '12', committee_id: 'C001', memoed_subtotal: true, support_oppose_indicator: 'S', expenditure_amount: 999, is_notice: true },
      ], pagination: { count: 2, per_page: 100, last_indexes: null } });
    }
    if (u.pathname === '/committees/') {
      return send({ results: [{ committee_id: 'C001', committee_type: 'O', name: 'Example Super PAC' }, { committee_id: 'C002', committee_type: 'Y', name: 'Example Party Committee' }] });
    }
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ballot-scout-outside-'));
  const src = [{ label: 's', url: 'https://example.org/s' }];
  const seed = {
    schemaVersion: 1,
    election: { id: 'e', name: 'General', date: '2026-11-03', sources: src },
    contests: [
      { id: 'us-house-ny-99', office: 'Representative in Congress', level: 'federal', districtType: 'congressional', district: '99', sources: src, candidates: [{ name: 'Pat Example', partyLines: ['A'], incumbent: false, sources: src }, { name: 'Lee Nobody', partyLines: ['B'], incumbent: false, sources: src }] },
      { id: 'ny-senate-99', office: 'State Senator', level: 'state', districtType: 'state-senate', district: '99', sources: src, candidates: [{ name: 'Sam State', partyLines: ['A'], incumbent: false, sources: src }] },
    ],
  };
  fs.mkdirSync(path.join(tmp, 'data', 'ballots'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'data', 'ballots', 'ny-2026-general.json'), JSON.stringify(seed));
});
after(() => {
  server?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function run(extraEnv) {
  return new Promise((resolve) => {
    const env = { ...process.env, DATA_DIR: path.join(tmp, 'data'), FIXTURES: '', FEC_API_BASE: base, OUTSIDE_PAUSE_MS: '0', ...extraEnv };
    const child = spawn(process.execPath, ['scripts/build-outside.mjs'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

test('build-outside.mjs skips cleanly without a key', async () => {
  const { code, out } = await run({ DATA_GOV_API_KEY: '' });
  assert.equal(code, 0, out);
  assert.match(out, /DATA_GOV_API_KEY is not set/);
  assert.equal(fs.existsSync(path.join(tmp, 'data', 'fec', 'outside.json')), false);
});

test('build-outside.mjs writes every federal candidate, split by spender type', async () => {
  const { code, out } = await run({ DATA_GOV_API_KEY: 'test-key' });
  assert.equal(code, 0, out);
  const file = JSON.parse(fs.readFileSync(path.join(tmp, 'data', 'fec', 'outside.json'), 'utf8'));
  assert.deepEqual(file.cycles, [2026, 2024]);
  const pat = file.candidates['NY|us-house|99|patexample'];
  assert.equal(pat.status, 'ok');
  assert.equal(pat.fecCandidateId, 'H6NY99001');
  assert.deepEqual(pat.cycles['2026'].byGroup['super-pac'], { support: 1000, oppose: 250 });
  assert.deepEqual(pat.cycles['2026'].byGroup.party, { support: 500, oppose: 0 });
  assert.deepEqual(pat.cycles['2026'].totals, { support: 1500, oppose: 250 });
  assert.equal(pat.cycles['2026'].notices.support, 300, 'memo lines are left out of 24/48-hour totals');
  assert.equal(pat.cycles['2024'].notices, null, 'past cycles use processed reports only');
  assert.equal(file.candidates['NY|us-house|99|leenobody'].status, 'not-found');
  assert.equal(Object.keys(file.candidates).length, 2, 'state races are not sent to the FEC');
  assert.ok(hits.every((h) => h.includes('api_key=test-key')));
  assert.ok(hits.filter((h) => h.startsWith('/schedules/schedule_e/by_candidate/')).every((h) => h.includes('office=house') && /cycle=20(24|26)/.test(h)));
  assert.ok(hits.some((h) => h.startsWith('/schedules/schedule_e/?') && h.includes('is_notice=true') && h.includes('most_recent=true')));

  // The runtime reader sees it.
  process.env.DATA_DIR = path.join(tmp, 'data');
  try {
    const { outsideFor } = await import('../lib/outside.js');
    assert.equal(outsideFor({ state: 'NY', officeKey: 'us-house', district: '99', name: 'Pat Example' }).entry.fecCandidateId, 'H6NY99001');
  } finally {
    delete process.env.DATA_DIR;
  }
});
