// Candidates' stated positions on the issues, from a researched file:
// /data/stances/<state>-<year>-general.json (schemaVersion 1, filled in by hand and checked with
// scripts/validate-stances.mjs). Each summary is a short paraphrase written by Ballot Scout from the
// candidate's own words, to the same rules for every candidate, and links to where the candidate
// said it. Sample mode uses the fictional /fixtures/stances.json.
//
// Fairness rule: a race's positions are shown only when every candidate in that contest of the
// researched ballot file has an entry marked complete. Until then nobody in the race gets any, so
// a voter never sees one candidate's positions next to an opponent who hasn't been researched.
import { isFixtureMode, electionDate } from './config.js';
import { readData, loadFixture } from './files.js';
import { fullNameKey } from './ids.js';
import { ISSUES, issueLabel } from './issues.js';
import { loadSeed } from './seed.js';
import { formatDate } from './summary.js';
import { validateStances, SOURCE_TYPES, UNREADABLE_REASONS } from './validate-stances.js';

export const STANCES_EXPLAINER = 'Written by Ballot Scout from the candidate’s own website, questionnaires and public statements (quotes in news reports, interviews, debates, official statements and letters they signed), using the same rules for every candidate. Follow each link to read their words in full.';

// Plain search words per issue for the "search the news" links shown when no statement was found.
// The same words are used for every candidate.
export const ISSUE_NEWS_TERMS = Object.freeze({
  housing: 'housing', health: 'health care', climate: 'climate OR energy', 'criminal-justice': 'police OR crime OR bail',
  courts: 'courts', labor: 'workers OR wages', education: 'schools OR education', transportation: 'transit OR transportation',
  taxes: 'taxes', government: 'elections OR ethics', budget: 'budget OR affordability', business: 'small business OR consumers',
  immigration: 'immigration OR ICE', 'social-services': '"child care" OR SNAP', 'civil-rights': 'abortion OR "civil rights"',
  'defense-veterans': 'veterans OR military', 'foreign-trade': 'tariffs OR trade', 'israel-palestine': 'Israel OR Gaza',
  agriculture: 'farms OR agriculture', technology: 'technology OR AI', emergency: 'disaster OR emergency', culture: 'arts OR culture',
  'native-american': '"Native American" OR tribal',
});

/** "Kathy C. Hochul" -> "Kathy Hochul": the name as news reports usually print it. */
export function searchName(name) {
  return String(name ?? '')
    .replace(/\b[A-Z]\.\s*/g, ' ')
    .replace(/,?\s+(Jr|Sr|II|III|IV)\.?$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A Google News search for the candidate's name with an issue's search words. */
export function newsSearchUrl(name, issueId) {
  const terms = ISSUE_NEWS_TERMS[issueId];
  const who = searchName(name);
  if (!terms || !who) return null;
  return `https://news.google.com/search?q=${encodeURIComponent(`"${who}" ${terms}`)}&hl=en-US&gl=US&ceid=US:en`;
}

export const STANCE_NOTES = Object.freeze({
  judicial: 'Under New York’s rules for judicial campaigns, judicial candidates can’t pledge or commit to positions on issues that may come before the court, so this guide doesn’t list positions for judicial races.',
  runningMate: 'Positions for this ticket are listed under the candidate for Governor.',
  notResearched: 'This candidate’s positions haven’t been researched yet.',
  raceIncomplete: 'Positions for this race haven’t been fully researched yet, so none are shown for any candidate in it.',
  unavailable: 'The researched positions file failed validation, so positions aren’t shown.',
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isUrl = (u) => typeof u === 'string' && /^https?:\/\/\S+$/.test(u);
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The positions file for a state's election in the configured year, or null. */
export function loadStancesFile(state) {
  const st = String(state ?? '').toLowerCase();
  if (!/^[a-z]{2}$/.test(st)) return null;
  if (isFixtureMode()) return st === 'ny' ? loadFixture('stances') : null;
  return readData('stances', `${st}-${electionDate().slice(0, 4)}-general.json`);
}

// One index per file version: readJsonFile returns the same object until the file changes.
const indexes = new WeakMap();

/**
 * Index a positions file by contest + full-name key, and by name alone. A file that fails
 * validation is indexed as not ok: the site never shows a summary that breaks the writing rules,
 * and never shows some candidates' positions while hiding others'.
 */
export function indexStances(file) {
  if (!file || typeof file !== 'object') return null;
  const hit = indexes.get(file);
  if (hit) return hit;
  const check = validateStances(file);
  const byKey = new Map();
  const byName = new Map();
  if (check.ok) {
    for (const e of file.candidates) {
      const nk = fullNameKey(e.name);
      byKey.set(`${e.contestId}|${nk}`, e);
      byName.set(nk, [...(byName.get(nk) ?? []), e]);
    }
  }
  // races: seed file version -> contestId -> whether every candidate in the race is complete.
  const index = { ok: check.ok, errors: check.errors, byKey, byName, races: new WeakMap() };
  indexes.set(file, index);
  return index;
}

/**
 * The entry for one candidate: same contest and full name. Tokens made before contest ids were
 * added fall back to a name that appears exactly once in the file; an ambiguous name matches nothing.
 */
export function findStanceEntry(index, { contestId, name } = {}) {
  if (!index?.ok) return null;
  const nk = fullNameKey(name);
  if (!nk) return null;
  if (contestId) return index.byKey.get(`${contestId}|${nk}`) ?? null;
  const hits = index.byName.get(nk) ?? [];
  return hits.length === 1 ? hits[0] : null;
}

/**
 * True when every candidate in this contest of the researched ballot file (running mates aren't
 * separate candidates) has an entry with complete === true. A contest that isn't in the ballot
 * file, or a ballot file that fails validation, can't be checked, so it's never complete.
 * Cached per positions-file version and ballot-file version.
 */
export function raceResearched(index, seed, contestId) {
  if (!index?.ok || !seed || !contestId) return false;
  let races = index.races.get(seed);
  if (!races) { races = new Map(); index.races.set(seed, races); }
  if (races.has(contestId)) return races.get(contestId);
  const contest = (Array.isArray(seed.contests) ? seed.contests : []).find((x) => String(x?.id) === contestId);
  const names = (contest?.candidates ?? []).map((p) => fullNameKey(p?.name));
  const done = names.length > 0 && names.every((nk) => Boolean(nk) && index.byKey.get(`${contestId}|${nk}`)?.complete === true);
  races.set(contestId, done);
  return done;
}

function cleanSource(s) {
  if (!s || !isUrl(s.url)) return null;
  return {
    label: text(s.label) ?? 'Source',
    url: s.url,
    type: SOURCE_TYPES.includes(s.type) ? s.type : null,
    date: DATE_RE.test(String(s.date ?? '')) ? s.date : null,
  };
}

/** "Positions on your issues" for one candidate, in every state the section can be in. */
export function stancesSection(c, profile, issueIds) {
  const section = (status, note, extra = {}) => ({
    status, note, explainer: STANCES_EXPLAINER, items: [], otherIssues: [], website: null, researchedAt: null, sourcesChecked: [], sources: [], missing: [], unreadable: null, ...extra,
  });
  if (profile?.judicial) return section('judicial', STANCE_NOTES.judicial);
  if (c?.role === 'running-mate') return section('running-mate', STANCE_NOTES.runningMate);
  const index = indexStances(loadStancesFile(c?.state));
  if (index && !index.ok) return section('unavailable', STANCE_NOTES.unavailable);
  const entry = findStanceEntry(index, { contestId: c?.contestId, name: c?.name });
  // The race gate. A token without a contest id uses the contest of the entry its name matched.
  const contestId = c?.contestId ?? entry?.contestId ?? null;
  if (index && contestId) {
    const seedRes = loadSeed(c?.state);
    if (!raceResearched(index, seedRes?.validation?.ok ? seedRes.seed : null, contestId)) return section('not-researched', STANCE_NOTES.raceIncomplete);
  }
  if (!entry) return section('not-researched', STANCE_NOTES.notResearched);

  const stances = entry.stances;
  const items = issueIds.flatMap((id) => stances.filter((s) => s.issue === id).map((s) => ({
    issue: id,
    issueLabel: issueLabel(id),
    summary: s.summary.trim(),
    quote: text(s.quote),
    source: cleanSource(s.source),
  })));
  const stated = new Set(stances.map((s) => s.issue));
  const otherIssues = ISSUES.filter((i) => stated.has(i.id) && !issueIds.includes(i.id)).map((i) => i.label);
  const sourcesChecked = (Array.isArray(entry.sourcesChecked) ? entry.sourcesChecked : []).filter((s) => s && typeof s === 'object').map((s) => ({
    label: text(s.label) ?? 'Source',
    url: isUrl(s.url) ? s.url : null,
    type: SOURCE_TYPES.includes(s.type) ? s.type : null,
    found: typeof s.found === 'boolean' ? s.found : null,
  }));
  const website = isUrl(entry.website) ? entry.website : null;
  const researchedAt = DATE_RE.test(String(entry.researchedAt ?? '')) ? entry.researchedAt : null;
  const sources = [
    { label: 'Ballot Scout positions research', url: null, lastUpdated: researchedAt, note: 'Candidate’s website, nonpartisan questionnaires and quoted statements' },
    ...(website ? [{ label: 'Candidate’s website', url: website, lastUpdated: researchedAt, note: 'Checked for stated positions' }] : []),
  ];
  // Issues the voter picked with nothing found, each with a news search for the candidate's name.
  const missing = issueIds.filter((id) => !items.some((it) => it.issue === id))
    .map((id) => ({ issue: id, issueLabel: issueLabel(id), searchUrl: newsSearchUrl(c?.name ?? entry.name, id) }));
  // A campaign website that couldn't be read: the race is still shown, and the voter is told and sent there.
  const u = entry.websiteUnreadable;
  const unreadable = u && isUrl(u.url) && UNREADABLE_REASONS.includes(u.reason)
    ? { url: u.url, checked: DATE_RE.test(String(u.checked ?? '')) ? u.checked : null, reason: u.reason,
      note: `Ballot Scout couldn’t read this candidate’s campaign website${formatDate(u.checked) ? ` when it checked on ${formatDate(u.checked)}` : ''}: the site ${u.reason}. Positions stated only there aren’t summarized here, so read it directly.` }
    : null;
  const extra = { items, otherIssues, website, researchedAt, sourcesChecked, sources, missing, unreadable };
  if (items.length) return section('ok', null, extra);
  const listed = sourcesChecked.length ? ' (listed below)' : '';
  return section('none-on-issues', `Ballot Scout found no statement from this candidate on ${issueIds.map(issueLabel).join(', ')} in the sources it checked${listed}. That doesn’t mean they haven’t spoken about it: the news searches below may find more.`, extra);
}
