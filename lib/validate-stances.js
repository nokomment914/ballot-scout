// Validation for researched position files (/data/stances/*.json), schemaVersion 1.
// Position summaries are paraphrases written by Ballot Scout, so the writing rules are enforced
// here, the same for every candidate: a plain verb first, no characterizing words, short verbatim
// quotes, and a linked source for every summary. Each entry also says whether its research is
// complete; a race's positions are shown only when every candidate in it is complete (lib/stances.js).
import { fullNameKey } from './ids.js';
import { ISSUE_BY_ID } from './issues.js';

/**
 * Every summary starts with one of these words. The past-tense forms are for dated public
 * statements ("Said in 2024 that…", "Signed an October 2023 joint statement…"), so an older
 * statement never reads as a current platform.
 */
export const SUMMARY_VERBS = Object.freeze([
  'Supports', 'Opposes', 'Proposes', 'Calls', 'Pledges', 'Promises', 'Says', 'Wants', 'Plans', 'Would',
  'Favors', 'Seeks', 'Backs', 'Rejects', 'Argues', 'Advocates', 'Aims', 'Intends', 'Prioritizes',
  'Said', 'Called', 'Urged', 'Signed', 'Wrote', 'Condemned', 'Criticized', 'Praised',
]);

/**
 * Why a campaign website couldn't be read (entry.websiteUnreadable.reason). Only these count:
 * a page our reader merely wasn't given isn't "unreadable". The candidate can still be complete,
 * and the site tells voters the website wasn't read and links to it.
 */
export const UNREADABLE_REASONS = Object.freeze(['blocks automated reading', 'did not load', 'shows no readable text']);

/** Characterizing words a summary may not use (whole words, any capitalization). */
export const BANNED_WORDS = Object.freeze([
  'strong', 'strongly', 'bold', 'boldly', 'common-sense', 'commonsense', 'radical', 'extreme', 'extremist',
  'dangerous', 'failed', 'failing', 'reckless', 'disastrous', 'crushing', 'skyrocketing', 'outrageous',
  'corrupt', 'heroic', 'champion', 'champions', 'championing', 'fight', 'fights', 'fighting', 'tireless',
  'tirelessly', 'proud', 'proudly', 'progressive', 'conservative', 'far-left', 'far-right', 'maga',
  'socialist', 'woke', 'unfortunately', 'sadly', 'finally', 'truly', 'great', 'amazing', 'terrible', 'crisis',
]);

export const SOURCE_TYPES = Object.freeze(['campaign-site', 'questionnaire', 'official-site', 'social', 'interview', 'debate', 'news']);
export const MAX_QUOTE_WORDS = 14;
export const SUMMARY_WORD_RANGE = Object.freeze({ min: 8, max: 30 });
export const MAX_STANCES_PER_ISSUE = 2;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isUrl = (u) => typeof u === 'string' && /^https?:\/\/\S+$/.test(u);
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const wordCount = (s) => String(s ?? '').trim().split(/\s+/).filter(Boolean).length;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const VERB_RE = new RegExp(`^(?:${SUMMARY_VERBS.join('|')})\\b`);
const BANNED_RE = new RegExp(`\\b(?:${BANNED_WORDS.map(escapeRe).join('|')})\\b`, 'gi');

/** Banned words found in a text, lower-cased, in order of appearance. */
export function bannedWordsIn(text) {
  return [...new Set([...String(text ?? '').matchAll(BANNED_RE)].map((m) => m[0].toLowerCase()))];
}

/** contestId -> Map of full-name key -> name for the candidates in that contest of a seed ballot file. */
function seedCandidates(seed) {
  const map = new Map();
  for (const c of Array.isArray(seed?.contests) ? seed.contests : []) {
    if (!c?.id) continue;
    map.set(String(c.id), new Map((c.candidates ?? []).map((p) => [fullNameKey(p?.name), p?.name]).filter(([k]) => k)));
  }
  return map;
}

/**
 * Check a positions file against the writing rules and, when a seed ballot file is given, check
 * that every entry names a candidate in that contest of the seed (by full-name key) and warn about
 * races that won't be shown yet because a candidate's entry is missing or incomplete. Running
 * mates aren't entries: a ticket's positions are listed under the candidate for Governor.
 * Returns { ok, errors, warnings, stats }. Unknown extra fields are allowed.
 */
export function validateStances(file, seed = null) {
  const errors = [];
  const warnings = [];
  const stats = { candidates: 0, stances: 0, complete: 0 };
  if (!isObject(file)) return { ok: false, errors: ['positions file must be a JSON object'], warnings, stats };
  if (file.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (file.generatedAt !== undefined && file.generatedAt !== null && Number.isNaN(Date.parse(file.generatedAt))) warnings.push('generatedAt should be an ISO date-time');
  if (seed && file.election && seed.election?.id && file.election !== seed.election.id) warnings.push(`election "${file.election}" doesn’t match the ballot file’s election "${seed.election.id}"`);
  if (!Array.isArray(file.candidates)) {
    errors.push('candidates must be an array');
    return { ok: false, errors, warnings, stats };
  }
  const inSeed = seed ? seedCandidates(seed) : null;
  const seen = new Map(); // contestId|name key -> entry
  const contests = new Set();
  file.candidates.forEach((c, i) => {
    const where = `candidates[${i}]${typeof c?.name === 'string' ? ` (${c.name})` : ''}`;
    if (!isObject(c)) { errors.push(`${where} must be an object`); return; }
    stats.candidates += 1;
    const contestId = typeof c.contestId === 'string' ? c.contestId : '';
    const nameKey = typeof c.name === 'string' ? fullNameKey(c.name) : '';
    if (!contestId) errors.push(`${where}.contestId is required`);
    if (!nameKey) errors.push(`${where}.name is required`);
    if (contestId && nameKey) {
      const key = `${contestId}|${nameKey}`;
      if (seen.has(key)) errors.push(`${where} is a duplicate: the same contest and candidate appear earlier in the file`);
      else seen.set(key, c);
      contests.add(contestId);
      if (inSeed) {
        const names = inSeed.get(contestId);
        if (!names) errors.push(`${where}: contest "${contestId}" isn’t in the ballot file`);
        else if (!names.has(nameKey)) errors.push(`${where}: no candidate named "${c.name}" in contest "${contestId}" of the ballot file`);
      }
    }
    if (!DATE_RE.test(String(c.researchedAt ?? ''))) warnings.push(`${where}.researchedAt should be YYYY-MM-DD (it’s shown as the last-updated date)`);
    if (c.website !== undefined && c.website !== null && !isUrl(c.website)) warnings.push(`${where}.website should be an http(s) URL or null`);
    if (c.websiteUnreadable !== undefined && c.websiteUnreadable !== null) {
      const u = c.websiteUnreadable;
      if (!isObject(u)) errors.push(`${where}.websiteUnreadable must be an object { url, checked, reason } or null`);
      else {
        if (!isUrl(u.url)) errors.push(`${where}.websiteUnreadable.url must be an http(s) URL (voters are sent there to read it)`);
        if (!DATE_RE.test(String(u.checked ?? ''))) errors.push(`${where}.websiteUnreadable.checked must be YYYY-MM-DD`);
        if (!UNREADABLE_REASONS.includes(u.reason)) errors.push(`${where}.websiteUnreadable.reason must be one of: ${UNREADABLE_REASONS.join(' | ')}`);
      }
    }

    // Research completeness: true only when every required source check was done.
    if (typeof c.complete !== 'boolean') errors.push(`${where}.complete must be true or false (true only when every required source check was done)`);
    else if (c.complete) stats.complete += 1;
    const reason = c.incompleteReason;
    if (typeof reason !== 'string' && reason !== null) errors.push(`${where}.incompleteReason must be a string or null`);
    else if (c.complete === false && !String(reason ?? '').trim()) warnings.push(`${where}.incompleteReason is empty: say which source checks are still to do`);
    else if (c.complete === true && String(reason ?? '').trim()) warnings.push(`${where}.incompleteReason is set but complete is true`);

    if (c.sourcesChecked !== undefined && c.sourcesChecked !== null && !Array.isArray(c.sourcesChecked)) errors.push(`${where}.sourcesChecked must be an array`);
    else if (!c.sourcesChecked?.length) warnings.push(`${where}.sourcesChecked is empty: list every source checked, including those where nothing was found`);
    else c.sourcesChecked.forEach((s, k) => {
      const w = `${where}.sourcesChecked[${k}]`;
      if (!isObject(s)) { errors.push(`${w} must be an object`); return; }
      if (typeof s.label !== 'string' || !s.label.trim()) warnings.push(`${w}.label is missing`);
      if (s.url !== undefined && s.url !== null && !isUrl(s.url)) warnings.push(`${w}.url should be an http(s) URL or null`);
      if (!SOURCE_TYPES.includes(s.type)) warnings.push(`${w}.type should be one of ${SOURCE_TYPES.join('|')}`);
      if (typeof s.found !== 'boolean') warnings.push(`${w}.found should be true or false`);
    });

    if (!Array.isArray(c.stances)) { errors.push(`${where}.stances must be an array (use [] when nothing was found)`); return; }
    const perIssue = new Map();
    c.stances.forEach((s, j) => {
      const w = `${where}.stances[${j}]`;
      if (!isObject(s)) { errors.push(`${w} must be an object`); return; }
      stats.stances += 1;
      if (!ISSUE_BY_ID.has(s.issue)) errors.push(`${w}.issue "${s.issue}" isn’t a known issue id (see lib/issues.js)`);
      else perIssue.set(s.issue, (perIssue.get(s.issue) ?? 0) + 1);

      const summary = typeof s.summary === 'string' ? s.summary.trim() : '';
      if (!summary) errors.push(`${w}.summary is required`);
      else {
        if (!VERB_RE.test(summary)) errors.push(`${w}.summary must start with one of: ${SUMMARY_VERBS.join(', ')}`);
        const banned = bannedWordsIn(summary);
        if (banned.length) errors.push(`${w}.summary uses words that aren’t allowed: ${banned.join(', ')}`);
        const n = wordCount(summary);
        if (n < SUMMARY_WORD_RANGE.min || n > SUMMARY_WORD_RANGE.max) warnings.push(`${w}.summary has ${n} words (aim for ${SUMMARY_WORD_RANGE.min}–${SUMMARY_WORD_RANGE.max})`);
      }

      if (s.quote !== undefined && s.quote !== null) {
        if (typeof s.quote !== 'string' || !s.quote.trim()) errors.push(`${w}.quote must be a short verbatim quote or null`);
        else if (wordCount(s.quote) > MAX_QUOTE_WORDS) errors.push(`${w}.quote has ${wordCount(s.quote)} words (at most ${MAX_QUOTE_WORDS})`);
      }

      const src = isObject(s.source) ? s.source : {};
      if (!isUrl(src.url)) errors.push(`${w}.source.url must be an http(s) URL (every summary links to where the candidate said it)`);
      if (typeof src.label !== 'string' || !src.label.trim()) warnings.push(`${w}.source.label is missing`);
      if (!SOURCE_TYPES.includes(src.type)) warnings.push(`${w}.source.type should be one of ${SOURCE_TYPES.join('|')}`);
      if (src.date !== undefined && src.date !== null && !DATE_RE.test(String(src.date))) warnings.push(`${w}.source.date should be YYYY-MM-DD or null`);
    });
    for (const [issue, n] of perIssue) {
      if (n > MAX_STANCES_PER_ISSUE) warnings.push(`${where}: ${n} positions on "${issue}" (aim for ${MAX_STANCES_PER_ISSUE} or fewer per issue)`);
    }
  });
  if (inSeed) {
    // The site shows a race's positions only when every candidate in it has a complete entry.
    stats.racesShown = 0;
    for (const contestId of contests) {
      const names = inSeed.get(contestId);
      if (!names) continue;
      const missing = [];
      const incomplete = [];
      for (const [nk, name] of names) {
        const e = seen.get(`${contestId}|${nk}`);
        if (!e) missing.push(name);
        else if (e.complete !== true) incomplete.push(name);
      }
      if (!missing.length && !incomplete.length) stats.racesShown += 1;
      else warnings.push(`contest "${contestId}": no positions are shown for anyone in this race until every candidate has a complete entry (${[missing.length ? `no entry: ${missing.join(', ')}` : null, incomplete.length ? `not complete: ${incomplete.join(', ')}` : null].filter(Boolean).join('; ')})`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, stats };
}
