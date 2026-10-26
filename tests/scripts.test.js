// Runs scripts/build-votes.mjs and scripts/build-nysenate.mjs end to end against a local
// mock of the upstream APIs, then reads the outputs through the runtime readers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockUpstream } from './helpers/mock-upstream.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let mock;
let tmp;

before(async () => {
  mock = await startMockUpstream();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ballot-scout-build-'));
});
after(() => {
  mock?.server.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

function run(script, extraEnv) {
  return new Promise((resolve) => {
    const env = { ...process.env, DATA_DIR: path.join(tmp, 'data'), BUILD_CACHE_DIR: path.join(tmp, 'cache'), FIXTURES: '', ...extraEnv };
    const child = spawn(process.execPath, [script], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
  });
}

const readOut = (...p) => JSON.parse(fs.readFileSync(path.join(tmp, 'data', ...p), 'utf8'));

test('build-votes.mjs builds federal indexes from Voteview + Congress.gov', async () => {
  const { code, out } = await run('scripts/build-votes.mjs', {
    VOTEVIEW_BASE: `${mock.base}/voteview`,
    CONGRESS_API_BASE: `${mock.base}/congress`,
    DATA_GOV_API_KEY: 'test-key',
    VOTE_CONGRESSES: '119',
    CONGRESS_CALLS_PER_HOUR: '360000',
  });
  assert.equal(code, 0, out);
  const rc = readOut('votes', 'rollcalls.json');
  assert.deepEqual(Object.keys(rc.rollcalls).sort(), ['H119-0016', 'H119-0017', 'H119-0030', 'S119-0006']);
  const bills = readOut('votes', 'bills.json').bills;
  assert.equal(bills['119-hr-99001'].pa, 'Housing and Community Development');
  assert.equal(bills['119-hr-99001'].cbo[0].u, 'https://example.org/cbo');
  assert.deepEqual(bills['119-hr-99002'].laws, ['119-999']);
  assert.equal(bills['119-s-99003'].gone, true, '404 recorded so it is not refetched every run');
  assert.deepEqual(readOut('votes', 'members', 'X000001.json').votes, [['H119-0016', 1], ['H119-0017', 6], ['H119-0030', 6]]);
  const meta = readOut('votes', 'meta.json');
  assert.equal(meta.status, 'ok');
  assert.equal(meta.congressGov.calls, 3);
  assert.equal(readOut('votes', 'members-index.json').members.X000004.ch, 'Senate');
  // Every Congress.gov call asked for JSON and carried the key.
  assert.ok(mock.hits.filter((h) => h.startsWith('/congress/')).every((h) => h.includes('format=json') && h.includes('api_key=')));

  // Runtime readers see the built data (live mode, DATA_DIR override).
  process.env.DATA_DIR = path.join(tmp, 'data');
  try {
    const { federalVotesOnIssues } = await import('../lib/votes.js');
    const r = federalVotesOnIssues('X000001', ['housing', 'health']);
    assert.deepEqual(r.items.map((v) => `${v.bill.number}:${v.vote}`), ['H.R. 99002:Nay', 'H.R. 99001:Yea']);
  } finally {
    delete process.env.DATA_DIR;
  }

  // A second run makes no new Congress.gov calls for bills already cached.
  const before = mock.hits.filter((h) => h.startsWith('/congress/')).length;
  const again = await run('scripts/build-votes.mjs', { VOTEVIEW_BASE: `${mock.base}/voteview`, CONGRESS_API_BASE: `${mock.base}/congress`, DATA_GOV_API_KEY: 'test-key', VOTE_CONGRESSES: '119', CONGRESS_CALLS_PER_HOUR: '360000' });
  assert.equal(again.code, 0, again.out);
  assert.equal(mock.hits.filter((h) => h.startsWith('/congress/')).length, before, 'cached bills are not refetched');
});

test('build-nysenate.mjs builds NY indexes, then refreshes incrementally', async () => {
  const env = {
    OPENLEG_API_BASE: `${mock.base}/openleg`,
    NYSENATE_API_KEY: 'test-key',
    OPENSTATES_API_BASE: `${mock.base}/openstates`,
    OPENSTATES_API_KEY: 'test-key',
    OPENSTATES_MIN_SPACING_MS: '0',
    NY_SESSION: '2025',
  };
  const first = await run('scripts/build-nysenate.mjs', env);
  assert.equal(first.code, 0, first.out);
  const pat = readOut('ny', 'members', '422.json');
  assert.deepEqual(pat.sponsored.map((b) => b.p).sort(), ['S100', 'S101'], 'resolutions excluded');
  assert.equal(pat.sponsored.find((b) => b.p === 'S100').fis, 'None to the state.');
  assert.deepEqual(pat.votes, [['S100', '2025-05-20', 'F', 'AYE', '']]);
  const gov = readOut('ny', 'governor-actions-2025.json');
  assert.deepEqual(gov.actions.map((a) => [a.p, a.a, a.ch ?? a.vn]), [['A200', 'vetoed', 77], ['S100', 'signed', 321]]);
  assert.equal(gov.actions[1].si, 'SAMPLE GOVERNOR');
  const idx = readOut('ny', 'members-index.json').members;
  assert.equal(idx.find((m) => m.memberId === 700).openstatesId, 'ocd-person/77777777-7777-4777-8777-777777777777');
  const asm = readOut('ny', 'assembly', '77777777-7777-4777-8777-777777777777.json');
  assert.deepEqual(asm.votes, [['A200', '2025-06-10', 'passage', 'no', 'Floor Vote', 'https://example.org/assembly-vote']]);
  const bills = readOut('ny', 'bills-2025.json').bills;
  assert.ok(bills.A200 && bills.S100, 'bills referenced by votes or Governor actions are included');
  assert.deepEqual(bills.A200.subj, ['Education']);
  const meta = readOut('ny', 'meta.json');
  assert.equal(meta.openLegislation.status, 'ok');
  assert.equal(meta.openStates.status, 'ok');
  assert.equal(meta.openStates.exportUpdatedAt, '2026-10-11T10:00:00Z');

  const second = await run('scripts/build-nysenate.mjs', env);
  assert.equal(second.code, 0, second.out);
  assert.ok(mock.hits.some((h) => h.startsWith('/openleg/bills/updates/')), 'incremental run asks for updates');
  assert.ok(mock.hits.some((h) => h.startsWith('/openleg/bills/2025/S101?')), 'changed bill is refetched');
  const pat2 = readOut('ny', 'members', '422.json');
  assert.deepEqual(pat2.votes[0], ['S101', '2026-02-01', 'F', 'NAY', '']);

  // Runtime readers (live mode) over the built NY data.
  process.env.DATA_DIR = path.join(tmp, 'data');
  try {
    const { nySenateVotesOnIssues, nySponsoredOnIssues, governorActionsOnIssues } = await import('../lib/nysenate.js');
    const { openStatesVotesOnIssues } = await import('../lib/openstates.js');
    assert.equal(nySenateVotesOnIssues('422', ['health']).items[0].vote, 'Nay');
    assert.equal(nySponsoredOnIssues('422', ['housing']).items[0].chapter, 321);
    assert.equal(governorActionsOnIssues('Governor', ['education']).items[0].action, 'Vetoed');
    assert.equal(openStatesVotesOnIssues('ocd-person/77777777-7777-4777-8777-777777777777', ['education']).items[0].vote, 'No');
  } finally {
    delete process.env.DATA_DIR;
  }
});

test('build-nymoney.mjs links state candidates to their committees and sums transactions', async () => {
  const dataDir = path.join(tmp, 'money-data');
  fs.mkdirSync(path.join(dataDir, 'ballots'), { recursive: true });
  const src = [{ label: 'Test source', url: 'https://example.org/src' }];
  const cand = (name, extra = {}) => ({ name, runningMate: null, partyLines: ['Line A'], incumbent: false, ids: {}, currentOffice: null, website: null, sources: src, ...extra });
  fs.writeFileSync(path.join(dataDir, 'ballots', 'ny-2026-general.json'), JSON.stringify({
    schemaVersion: 1, generatedAt: '2026-10-13T00:00:00Z',
    election: { id: 'e', name: 'Test Election', date: '2026-11-03', sources: src },
    contests: [
      { id: 'sd-28', office: 'State Senator', level: 'state', districtType: 'state-senate', district: '28', seats: 1, sources: src, candidates: [cand('Pat Senator', { incumbent: true }), cand('Robin Rival')] },
      { id: 'ad-75', office: 'Member of Assembly', level: 'state', districtType: 'state-assembly', district: '75', seats: 1, sources: src, candidates: [cand('Lee Assembler')] },
      { id: 'cd-12', office: 'Representative in Congress', level: 'federal', districtType: 'congressional', district: '12', seats: 1, sources: src, candidates: [cand('Fed Person')] },
    ],
  }));
  const r = await run('scripts/build-nymoney.mjs', { DATA_DIR: dataDir, NY_SOCRATA_BASE: `${mock.base}/socrata` });
  assert.equal(r.code, 0, r.out);
  const money = JSON.parse(fs.readFileSync(path.join(dataDir, 'ny', 'money-2026.json'), 'utf8'));
  assert.equal(money.schemaVersion, 2);
  const pat = money.candidates['state-senate|28|pat senator'];
  assert.equal(pat.filer.id, '5001', 'the candidate filer (registration) is kept');
  assert.deepEqual(pat.committees.map((k) => [k.id, k.name, k.type, k.status, k.match]), [
    ['6001', 'Friends of Pat Senator', 'Authorized Single Candidate Committee', 'ACTIVE', 'full'],
    ['6002', 'Pat Senator 2026', 'Public Campaign Finance Committee', 'ACTIVE', 'full'],
  ], 'authorized and public-financing committees; terminated committee left out');
  assert.equal(pat.matchedBy, 'registration+name');
  assert.equal(pat.filerFilings, false);
  assert.deepEqual(pat.schedules.map((s) => [s.abbrev, s.total, s.count]), [['A', 350, 2], ['F', 120.5, 1]],
    'amended transaction counted once; the same transaction number in two committees counted twice; other years left out');
  const lee = money.candidates['state-assembly|75|lee assembler'];
  assert.deepEqual(lee.committees.map((k) => [k.id, k.match]), [['6004', 'surname']], 'county committee of the same name left out');
  assert.deepEqual(lee.schedules.map((s) => [s.abbrev, s.total]), [['A', 75]]);
  assert.deepEqual(money.unmatched.map((u) => [u.name, u.office, u.district, u.code]), [['Robin Rival', 'State Senator', '28', 'no-registration']]);
  assert.ok(money.unmatched[0].reason.length > 20, 'unmatched candidates carry the reason');
  assert.ok(!Object.keys(money.candidates).some((k) => k.includes('fed person')), 'federal candidates use the FEC instead');
  const meta = JSON.parse(fs.readFileSync(path.join(dataDir, 'ny', 'meta.json'), 'utf8'));
  assert.deepEqual([meta.nyMoney.status, meta.nyMoney.matched, meta.nyMoney.unmatched], ['ok', 2, 1]);
  const wheres = mock.hits.map((h) => new URL(h, 'http://x').searchParams);
  // One grouped query lists the filers with filings in these years.
  assert.ok(wheres.some((q) => q.get('$group') === 'filer_id, cand_comm_name, office_desc, district' && /count\(\*\) as n/.test(q.get('$select') ?? '')));
  // Filer id is a number column in the disclosure data, so it is not quoted in the SoQL filter.
  assert.ok(wheres.some((q) => (q.get('$where') ?? '').startsWith('filer_id in (6001, 6002) AND ')));
});

test('build scripts skip cleanly without keys', async () => {
  const r = await run('scripts/build-nysenate.mjs', { NYSENATE_API_KEY: '', OPENSTATES_API_KEY: '', DATA_DIR: path.join(tmp, 'nokeys') });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not set: skipping/);
});
