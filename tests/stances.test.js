// Stated positions: contest ids in candidate tokens, the "Positions on your issues" section in
// every status, the race gate (a race's positions are shown only when every candidate in it is
// fully researched), and the writing rules in validateStances.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { encodeCandidateToken, decodeCandidateToken } from '../lib/ids.js';
import { recordProfile } from '../lib/labels.js';
import { stancesSection, indexStances, raceResearched, STANCE_NOTES, STANCES_EXPLAINER, ISSUE_NEWS_TERMS, searchName, newsSearchUrl } from '../lib/stances.js';
import { ISSUES } from '../lib/issues.js';
import { validateStances } from '../lib/validate-stances.js';

const FIXTURE_SEED = JSON.parse(fs.readFileSync(new URL('../fixtures/ballot-seed.json', import.meta.url), 'utf8'));
const FIXTURE_STANCES = JSON.parse(fs.readFileSync(new URL('../fixtures/stances.json', import.meta.url), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

async function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const withFixtures = (fn) => () => withEnv({ FIXTURES: '1' }, fn);

/** A decoded-token-shaped candidate from the fixture seed, plus its record profile. */
function person(contestId, name, { role = 'candidate', withContest = true } = {}) {
  const contest = FIXTURE_SEED.contests.find((c) => c.id === contestId);
  const cand = contest.candidates.find((p) => p.name === name || p.runningMate === name);
  const c = decodeCandidateToken(encodeCandidateToken({
    name, state: 'NY', office: contest.office, districtType: contest.districtType, district: contest.district, level: contest.level,
    incumbent: role === 'candidate' && cand.incumbent, currentOffice: role === 'candidate' ? cand.currentOffice : null, role, contestId: withContest ? contest.id : undefined,
  }));
  const profile = recordProfile({ contest, candidate: { incumbent: c.incumbent, currentOffice: c.currentOffice }, ids: {}, role });
  return { c, profile };
}

function section(contestId, name, issueIds, opts) {
  const { c, profile } = person(contestId, name, opts);
  return stancesSection(c, profile, issueIds);
}

// ---------- contest ids in tokens ----------

test('candidate tokens carry the contest id; tokens without one still work', () => {
  const base = { name: 'Pat Example', state: 'NY', office: 'State Senator', districtType: 'state-senate', district: '28' };
  assert.equal(decodeCandidateToken(encodeCandidateToken({ ...base, contestId: 'ny-sd-28' })).contestId, 'ny-sd-28');
  assert.equal(decodeCandidateToken(encodeCandidateToken(base)).contestId, null);
  // A token made before the field existed has no "ci" key at all.
  const old = Buffer.from(JSON.stringify({ v: 1, n: 'Pat Example', st: 'NY', o: 'State Senator', ids: {} })).toString('base64url');
  const decoded = decodeCandidateToken(old);
  assert.equal(decoded.name, 'Pat Example');
  assert.equal(decoded.contestId, null);
  for (const bad of ['NY-SD-28', '../etc/passwd', 'a b', 'x'.repeat(121), '', 12, ['ny-sd-28']]) {
    const t = Buffer.from(JSON.stringify({ v: 1, n: 'Pat', ci: bad })).toString('base64url');
    assert.equal(decodeCandidateToken(t).contestId, null, `rejects ${JSON.stringify(bad)}`);
  }
});

test('ballot tokens name their contest, for candidates and running mates', withFixtures(async () => {
  const { assembleBallot } = await import('../lib/ballot.js');
  const b = await assembleBallot({ address: '350 5th Ave, New York, NY 10118', issues: ['housing'] });
  for (const contest of [...b.contests, ...b.possibleContests]) {
    for (const cand of contest.candidates) {
      assert.equal(decodeCandidateToken(cand.id).contestId, contest.id, cand.name);
      if (cand.runningMate) assert.equal(decodeCandidateToken(cand.runningMate.id).contestId, contest.id, cand.runningMate.name);
    }
  }
}));

// ---------- statuses ----------

test('ok: every stance on the selected issues, in issue order, with sources and other issues', withFixtures(() => {
  const s = section('fx-cd-12', 'Sample Candidate G', ['health', 'housing', 'taxes']);
  assert.equal(s.status, 'ok');
  assert.equal(s.note, null);
  assert.equal(s.explainer, STANCES_EXPLAINER);
  assert.deepEqual(s.items.map((i) => i.issue), ['health', 'housing', 'housing'], 'issue order, every stance per issue');
  assert.deepEqual(s.items.map((i) => i.issueLabel), ['Health care', 'Housing', 'Housing']);
  assert.match(s.items[1].summary, /^Supports expanding/);
  assert.equal(s.items[1].quote, 'More homes that working families can afford, in every neighborhood.');
  assert.equal(s.items[2].quote, null);
  assert.deepEqual(s.items[1].source, { label: 'Campaign website: Housing (fictional)', url: 'https://example.org/sample-candidate-g/housing', type: 'campaign-site', date: '2026-09-14' });
  assert.deepEqual(s.otherIssues, ['Climate, energy and environment']);
  assert.equal(s.sourcesChecked.length, 5);
  assert.deepEqual(s.sourcesChecked.at(-1), { label: 'Campaign social media accounts (fictional)', url: null, type: 'social', found: false });
  assert.equal(s.researchedAt, '2026-10-20');
  assert.equal(s.website, 'https://example.org/sample-candidate-g');
  assert.deepEqual(s.sources.map((x) => x.label), ['Ballot Scout positions research', 'Candidate’s website']);
  assert.equal(s.sources[0].url, null);
  assert.equal(s.sources[0].lastUpdated, '2026-10-20');
}));

test('none-on-issues: the entry exists but says nothing on the selected issues', withFixtures(() => {
  const b = section('fx-governor', 'Sample Candidate B', ['housing', 'health']);
  assert.equal(b.status, 'none-on-issues');
  assert.equal(b.note, 'Ballot Scout found no statement from this candidate on Housing, Health care in the sources it checked (listed below). That doesn’t mean they haven’t spoken about it: the news searches below may find more.');
  assert.deepEqual(b.items, []);
  assert.equal(b.sourcesChecked.length, 3);
  assert.deepEqual(b.missing.map((m) => [m.issue, m.issueLabel]), [['housing', 'Housing'], ['health', 'Health care']]);
  assert.equal(b.missing[0].searchUrl, `https://news.google.com/search?q=${encodeURIComponent('"Sample Candidate B" housing')}&hl=en-US&gl=US&ceid=US:en`);
  assert.equal(b.unreadable, null);
  const g = section('fx-cd-12', 'Sample Candidate G', ['labor']);
  assert.equal(g.status, 'none-on-issues');
  assert.deepEqual(g.otherIssues, ['Housing', 'Health care', 'Climate, energy and environment']);
}));

test('ok: issues with nothing found are listed with the same news search for every candidate', withFixtures(() => {
  const s = section('fx-cd-12', 'Sample Candidate G', ['housing', 'israel-palestine', 'taxes']);
  assert.equal(s.status, 'ok');
  assert.deepEqual(s.missing.map((m) => m.issue), ['israel-palestine', 'taxes']);
  assert.equal(s.missing[0].searchUrl, `https://news.google.com/search?q=${encodeURIComponent('"Sample Candidate G" Israel OR Gaza')}&hl=en-US&gl=US&ceid=US:en`);
  assert.equal(section('fx-cd-12', 'Sample Candidate G', ['housing']).missing.length, 0);
}));

test('news search helpers: names as news reports print them, a fixed term list per issue', () => {
  assert.equal(searchName('Kathy C. Hochul'), 'Kathy Hochul');
  assert.equal(searchName('Joseph P. Addabbo Jr.'), 'Joseph Addabbo');
  assert.equal(searchName('Jordan J.G. Wright'), 'Jordan Wright');
  assert.equal(searchName('Nathaniel Hezekiah III'), 'Nathaniel Hezekiah');
  for (const i of ISSUES) assert.ok(ISSUE_NEWS_TERMS[i.id], `search words for ${i.id}`);
  assert.equal(newsSearchUrl('Pat Example', 'not-an-issue'), null);
  assert.equal(newsSearchUrl('', 'housing'), null);
});

test('a campaign website that couldn’t be read is named, dated and linked, and the race still shows', withFixtures(() => {
  const h = section('fx-cd-12', 'Sample Candidate H', ['housing']);
  assert.equal(h.status, 'ok');
  assert.deepEqual(h.unreadable, {
    url: 'https://example.org/sample-candidate-h/issues', checked: '2026-10-20', reason: 'shows no readable text',
    note: 'Ballot Scout couldn’t read this candidate’s campaign website when it checked on Oct 20, 2026: the site shows no readable text. Positions stated only there aren’t summarized here, so read it directly.',
  });
  assert.equal(section('fx-cd-12', 'Sample Candidate G', ['housing']).unreadable, null, 'only the candidate whose site couldn’t be read');
  const bad = clone(FIXTURE_STANCES);
  bad.candidates.find((e) => e.name === 'Sample Candidate H').websiteUnreadable = { url: 'not a url', checked: 'Oct 26', reason: 'not on the allowlist' };
  const r = validateStances(bad, FIXTURE_SEED);
  assert.ok(r.errors.some((e) => /websiteUnreadable\.url must be an http/.test(e)));
  assert.ok(r.errors.some((e) => /websiteUnreadable\.checked must be YYYY-MM-DD/.test(e)));
  assert.ok(r.errors.some((e) => /websiteUnreadable\.reason must be one of: blocks automated reading \| did not load \| shows no readable text/.test(e)), 'a page we merely weren’t given isn’t unreadable');
  bad.candidates.find((e) => e.name === 'Sample Candidate H').websiteUnreadable = 'yes';
  assert.ok(validateStances(bad, FIXTURE_SEED).errors.some((e) => /websiteUnreadable must be an object/.test(e)));
}));

test('judicial and running-mate statuses come before any lookup', withFixtures(() => {
  const n = section('fx-supreme-1', 'Sample Candidate N', ['housing']);
  assert.equal(n.status, 'judicial');
  assert.equal(n.note, STANCE_NOTES.judicial);
  assert.match(n.note, /^Under New York’s rules for judicial campaigns, judicial candidates can’t pledge or commit/);
  const rm = section('fx-governor', 'Sample Running Mate A', ['housing'], { role: 'running-mate' });
  assert.equal(rm.status, 'running-mate');
  assert.equal(rm.note, 'Positions for this ticket are listed under the candidate for Governor.');
  for (const s of [n, rm]) assert.deepEqual([s.items, s.sourcesChecked, s.sources], [[], [], []]);
}));

test('not-researched: no entry, no contest to check, or no positions file for the state', withFixtures(() => {
  // A token without a contest id whose name isn't in the file can't be placed in a race.
  const e = section('fx-attorney-general', 'Sample Candidate E', ['housing'], { withContest: false });
  assert.equal(e.status, 'not-researched');
  assert.equal(e.note, 'This candidate’s positions haven’t been researched yet.');
  const { c, profile } = person('fx-cd-12', 'Sample Candidate G');
  const other = stancesSection({ ...c, state: 'NJ' }, profile, ['housing']);
  assert.equal(other.status, 'not-researched');
  assert.equal(other.note, STANCE_NOTES.notResearched);
}));

// ---------- the race gate ----------

test('race gate: a fully researched race shows every candidate’s positions', withFixtures(() => {
  const issues = ['housing', 'taxes'];
  assert.equal(section('fx-cd-12', 'Sample Candidate G', issues).status, 'ok');
  assert.equal(section('fx-cd-12', 'Sample Candidate H', issues).status, 'ok');
  assert.equal(section('fx-governor', 'Sample Candidate A', issues).status, 'ok');
  assert.equal(section('fx-governor', 'Sample Candidate B', issues).status, 'none-on-issues', 'a complete entry with nothing on these issues still counts');
}));

test('race gate: one incomplete candidate means positions for nobody in the race', withFixtures(() => {
  // J is complete with positions on housing and labor; K is marked incomplete.
  const blocked = ['Sample Candidate J', 'Sample Candidate K'].map((n) => section('fx-sd-28', n, ['housing', 'labor', 'taxes']));
  for (const s of blocked) {
    assert.equal(s.status, 'not-researched');
    assert.equal(s.note, 'Positions for this race haven’t been fully researched yet, so none are shown for any candidate in it.');
    assert.deepEqual([s.items, s.otherIssues, s.sourcesChecked, s.sources, s.website, s.researchedAt], [[], [], [], [], null, null], 'nothing from the entry leaks out');
  }
  assert.deepEqual(blocked[0], blocked[1], 'identical for everyone in the race');
}));

test('race gate: a missing entry blocks the race', withFixtures(() => {
  // D has a complete entry; C has none.
  const d = section('fx-comptroller', 'Sample Candidate D', ['budget', 'taxes']);
  const c = section('fx-comptroller', 'Sample Candidate C', ['budget', 'taxes']);
  assert.equal(d.status, 'not-researched');
  assert.equal(d.note, STANCE_NOTES.raceIncomplete);
  assert.deepEqual(d, c);
  // Nobody in the race has an entry: same race note for everyone.
  assert.equal(section('fx-attorney-general', 'Sample Candidate F', ['housing']).note, STANCE_NOTES.raceIncomplete);
}));

test('race gate: a token without a contest id uses the contest of the entry its name matched', withFixtures(() => {
  assert.equal(section('fx-cd-12', 'Sample Candidate G', ['housing'], { withContest: false }).status, 'ok');
  const j = section('fx-sd-28', 'Sample Candidate J', ['housing'], { withContest: false });
  assert.equal(j.status, 'not-researched');
  assert.equal(j.note, STANCE_NOTES.raceIncomplete);
}));

test('raceResearched: needs a complete entry for every ballot candidate, and caches per file version', () => {
  const seed = { contests: [{ id: 'c1', candidates: [{ name: 'Pat A. Example' }, { name: 'Sam Example' }] }, { id: 'c2', candidates: [] }] };
  const entry = (name, complete = true) => ({ contestId: 'c1', name, researchedAt: '2026-10-20', complete, incompleteReason: complete ? null : 'Questionnaire pending', sourcesChecked: [], stances: [] });
  const file = { schemaVersion: 1, candidates: [entry('Pat Example'), entry('Sam Example')] };
  const index = indexStances(file);
  assert.equal(index.ok, true);
  assert.equal(raceResearched(index, seed, 'c1'), true, 'middle initials don’t matter');
  assert.equal(raceResearched(index, seed, 'c2'), false, 'a contest with no candidates is never complete');
  assert.equal(raceResearched(index, seed, 'nope'), false, 'a contest missing from the ballot file is never complete');
  assert.equal(raceResearched(index, null, 'c1'), false, 'no valid ballot file, no positions');
  // Cached for this version of the file...
  file.candidates[1].complete = false;
  assert.equal(raceResearched(index, seed, 'c1'), true);
  // ...and recomputed for a new version.
  assert.equal(raceResearched(indexStances(clone(file)), seed, 'c1'), false);
  assert.equal(raceResearched(indexStances({ schemaVersion: 1, candidates: [entry('Pat Example')] }), seed, 'c1'), false, 'missing entry');
});

test('a positions file that breaks the writing rules is not shown for anyone (outside sample mode)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballot-scout-stances-'));
  try {
    fs.mkdirSync(path.join(dir, 'ballots'));
    fs.mkdirSync(path.join(dir, 'stances'));
    fs.writeFileSync(path.join(dir, 'ballots', 'ny-2026-general.json'), JSON.stringify(FIXTURE_SEED));
    const bad = clone(FIXTURE_STANCES);
    bad.candidates[0].stances[0].summary = 'Supports a bold plan to build more homes for families with modest incomes.';
    fs.writeFileSync(path.join(dir, 'stances', 'ny-2026-general.json'), JSON.stringify(bad));
    await withEnv({ FIXTURES: undefined, DATA_DIR: dir, ELECTION_DATE: undefined }, () => {
      const s = section('fx-cd-12', 'Sample Candidate H', ['housing']);
      assert.equal(s.status, 'unavailable');
      assert.equal(s.note, STANCE_NOTES.unavailable);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('outside sample mode the real files are read: data/stances and data/ballots', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ballot-scout-stances-'));
  try {
    fs.mkdirSync(path.join(dir, 'ballots'));
    fs.mkdirSync(path.join(dir, 'stances'));
    fs.writeFileSync(path.join(dir, 'ballots', 'ny-2026-general.json'), JSON.stringify(FIXTURE_SEED));
    fs.writeFileSync(path.join(dir, 'stances', 'ny-2026-general.json'), JSON.stringify(FIXTURE_STANCES));
    await withEnv({ FIXTURES: undefined, DATA_DIR: dir, ELECTION_DATE: undefined }, () => {
      assert.equal(section('fx-cd-12', 'Sample Candidate H', ['housing']).status, 'ok');
      assert.equal(section('fx-sd-28', 'Sample Candidate J', ['housing']).status, 'not-researched');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real positions file is valid against the real ballot file', () => {
  const file = JSON.parse(fs.readFileSync(new URL('../data/stances/ny-2026-general.json', import.meta.url), 'utf8'));
  const seed = JSON.parse(fs.readFileSync(new URL('../data/ballots/ny-2026-general.json', import.meta.url), 'utf8'));
  const r = validateStances(file, seed);
  assert.deepEqual(r.errors, []);
  assert.equal(file.election, seed.election.id);
});

// ---------- validateStances ----------

test('the sample positions file passes, and races that can’t be shown yet are flagged', () => {
  const r = validateStances(FIXTURE_STANCES, FIXTURE_SEED);
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.deepEqual(r.stats, { candidates: 7, stances: 15, complete: 6, racesShown: 2 });
  assert.ok(r.warnings.some((w) => w.includes('"fx-sd-28"') && w.includes('not complete: Sample Candidate K')));
  assert.ok(r.warnings.some((w) => w.includes('"fx-comptroller"') && w.includes('no entry: Sample Candidate C')));
});

function oneEntry(edit) {
  const file = clone(FIXTURE_STANCES);
  file.candidates = [clone(FIXTURE_STANCES.candidates[0])];
  edit(file, file.candidates[0], file.candidates[0].stances[0]);
  return validateStances(file, FIXTURE_SEED);
}
const hasError = (r, re) => r.errors.some((e) => re.test(e));
const hasWarning = (r, re) => r.warnings.some((w) => re.test(w));

test('validateStances catches each error type', () => {
  assert.ok(hasError(oneEntry((f) => { f.schemaVersion = 2; }), /schemaVersion must be 1/));
  assert.ok(hasError(oneEntry((f, c) => { c.contestId = 'fx-nowhere'; }), /contest "fx-nowhere" isn’t in the ballot file/));
  assert.ok(hasError(oneEntry((f, c) => { c.name = 'Sample Candidate Z'; }), /no candidate named "Sample Candidate Z" in contest "fx-cd-12"/));
  assert.ok(hasError(oneEntry((f, c) => { c.contestId = 'fx-governor'; }), /no candidate named "Sample Candidate G" in contest "fx-governor"/), 'right name, wrong contest');
  assert.ok(hasError(oneEntry((f, c) => { f.candidates.push({ ...clone(c), name: 'Sample Candidate G.' }); }), /duplicate/));
  assert.ok(hasError(oneEntry((f, c, s) => { s.issue = 'potholes'; }), /issue "potholes" isn’t a known issue id/));
  assert.ok(hasError(oneEntry((f, c, s) => { s.summary = '  '; }), /summary is required/));
  assert.ok(hasError(oneEntry((f, c, s) => { delete s.summary; }), /summary is required/));
  assert.ok(hasError(oneEntry((f, c, s) => { s.summary = 'Has a plan to expand federal tax credits for new rental homes.'; }), /summary must start with one of: Supports, Opposes/));
  assert.ok(hasError(oneEntry((f, c, s) => { s.summary = 'supports expanding federal tax credits for new rental homes in the district.'; }), /must start with/), 'the verb is capitalized');
  for (const verb of ['Said', 'Called', 'Urged', 'Signed', 'Wrote', 'Condemned', 'Criticized', 'Praised']) {
    assert.equal(hasError(oneEntry((f, c, s) => { s.summary = `${verb} in 2024 that federal tax credits for new rental homes should grow.`; }), /must start with/), false, `${verb} opens a dated statement`);
  }
  for (const word of ['Strongly', 'common-sense', 'CRISIS', 'far-left', 'Fighting']) {
    const r = oneEntry((f, c, s) => { s.summary = `Supports a ${word} approach to federal tax credits for new rental homes.`; });
    assert.ok(hasError(r, new RegExp(`uses words that aren’t allowed: ${word.toLowerCase()}`)), word);
  }
  assert.equal(hasError(oneEntry((f, c, s) => { s.summary = 'Supports the strongest possible federal tax credits for new rental homes.'; }), /aren’t allowed/), false, 'whole words only');
  assert.ok(hasError(oneEntry((f, c, s) => { s.quote = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen'; }), /quote has 15 words \(at most 14\)/));
  assert.equal(hasError(oneEntry((f, c, s) => { s.quote = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen'; }), /quote/), false);
  assert.ok(hasError(oneEntry((f, c, s) => { s.source.url = 'javascript:alert(1)'; }), /source\.url must be an http\(s\) URL/));
  assert.ok(hasError(oneEntry((f, c, s) => { delete s.source; }), /source\.url must be an http\(s\) URL/));
  // Research completeness.
  assert.ok(hasError(oneEntry((f, c) => { delete c.complete; }), /complete must be true or false/));
  assert.ok(hasError(oneEntry((f, c) => { c.complete = 'yes'; }), /complete must be true or false/));
  assert.ok(hasError(oneEntry((f, c) => { c.incompleteReason = 0; }), /incompleteReason must be a string or null/));
  assert.ok(hasError(oneEntry((f, c) => { delete c.incompleteReason; }), /incompleteReason must be a string or null/));
  assert.equal(oneEntry(() => {}).ok, true);
});

test('validateStances warnings', () => {
  assert.ok(hasWarning(oneEntry((f, c, s) => { s.summary = 'Supports more rental homes.'; }), /summary has 4 words \(aim for 8–30\)/));
  assert.ok(hasWarning(oneEntry((f, c, s) => { s.summary = `Supports ${'more rental homes for families '.repeat(7).trim()}.`; }), /summary has 36 words/));
  assert.ok(hasWarning(oneEntry((f, c) => { c.stances.push(clone(c.stances[0])); }), /3 positions on "housing"/));
  assert.ok(hasWarning(oneEntry((f, c) => { c.sourcesChecked = []; }), /sourcesChecked is empty/));
  assert.ok(hasWarning(oneEntry((f, c) => { c.complete = false; c.incompleteReason = ' '; }), /incompleteReason is empty/));
  const incomplete = oneEntry((f, c) => { c.complete = false; c.incompleteReason = 'Debate transcript not checked yet'; });
  assert.equal(incomplete.ok, true, 'an incomplete entry is allowed; its race just isn’t shown');
  assert.ok(hasWarning(incomplete, /"fx-cd-12": no positions are shown .*no entry: Sample Candidate H; not complete: Sample Candidate G/));
  assert.ok(hasWarning(oneEntry((f, c) => { c.incompleteReason = 'left over'; }), /incompleteReason is set but complete is true/));
});
