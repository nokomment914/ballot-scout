// Open States API v3 (https://docs.openstates.org/api-v3/, source: github.com/openstates/api-v3).
// Used for New York Assembly roll calls, which Open Legislation does not carry.
// Auth: X-API-KEY header. Default tier allows 10 requests/minute and 250/day, so the build
// uses the session bulk CSV export (one API call to find it) instead of paging /bills.
import { fetchJson, buildUrl, sleep } from './http.js';
import { keys, isFixtureMode, nySessionYear } from './config.js';
import { readData, loadFixture, safeSegment } from './files.js';
import { nyLawMatches } from './issues.js';
import { nyBills, nyBillUrl, basePrintNo } from './nysenate.js';

export const OPENSTATES_API = process.env.OPENSTATES_API_BASE || 'https://v3.openstates.org';
export const OPENSTATES_SOURCE = { id: 'openstates', label: 'Open States (Plural) API v3', url: 'https://open.pluralpolicy.com/data/' };

let lastCall = 0;
/** Respect the default tier (10/min) with a 6.5 s spacing between calls. */
export async function openStatesGet(path, params = {}, { minSpacingMs = Number(process.env.OPENSTATES_MIN_SPACING_MS ?? 6500) } = {}) {
  const key = keys.openstates();
  if (!key) throw Object.assign(new Error('OPENSTATES_API_KEY not configured'), { code: 'not-configured' });
  const wait = lastCall + minSpacingMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  return fetchJson(buildUrl(`${OPENSTATES_API}${path}`, params), {
    headers: { 'X-API-KEY': key },
    label: 'Open States API',
    timeoutMs: 30000,
    retries: 3,
    maxWaitMs: 65000,
  });
}

/** Find the CSV bulk export for a session via /jurisdictions/{id}?include=legislative_sessions. */
export function pickSessionDownload(jurisdiction, sessionIdentifier, dataType = 'csv') {
  const sessions = jurisdiction?.legislative_sessions ?? [];
  const session = sessions.find((s) => s?.identifier === sessionIdentifier)
    ?? [...sessions].sort((a, b) => String(b?.start_date ?? '').localeCompare(String(a?.start_date ?? '')))[0];
  const dl = (session?.downloads ?? []).find((d) => d?.data_type === dataType);
  return session ? { session: session.identifier, url: dl?.url ?? null, updatedAt: dl?.updated_at ?? null } : null;
}

/** "A 1234" / "A1234" -> "A1234"; returns null for non-bill identifiers. */
export function normalizeNyIdentifier(identifier) {
  const s = String(identifier ?? '').toUpperCase().replace(/\s+/g, '');
  return /^[SAJBKLRCE]\d+[A-Z]?$/.test(s) ? basePrintNo(s) : null;
}

/** Postgres/Python array text such as "['bill-passage']" or "{passage}" -> ['bill-passage']. */
export function parseArrayField(value) {
  if (Array.isArray(value)) return value.map(String);
  return (String(value ?? '').match(/[a-z][a-z-]*/gi) ?? []).map((s) => s.toLowerCase());
}

export function voteKind(motionClassification, motionText = '') {
  const cls = parseArrayField(motionClassification);
  if (cls.includes('veto-override')) return 'veto-override';
  if (cls.some((c) => c.startsWith('amendment'))) return 'amendment';
  if (cls.some((c) => c.includes('passage'))) return 'passage';
  if (/committee/i.test(motionText)) return 'committee';
  if (/amend/i.test(motionText)) return 'amendment';
  return 'passage';
}

const OPTION_LABEL = { yes: 'Yes', no: 'No', abstain: 'Abstained', absent: 'Absent', excused: 'Excused', 'not voting': 'Not voting', other: 'Other' };
export function optionLabel(option) {
  return OPTION_LABEL[String(option ?? '').toLowerCase()] ?? String(option ?? '');
}

// ---------- Runtime readers ----------

export function nyAssemblyVotesFile(personId) {
  if (!personId) return null;
  const id = safeSegment(personId);
  return isFixtureMode() ? loadFixture(`ny-assembly-${id}`) : readData('ny', 'assembly', `${id}.json`);
}

/** NY Assembly (or Senate fallback) votes from Open States for one person, filtered by issue. */
export function openStatesVotesOnIssues(personId, issueIds, { includeAmendments = false, limit = 80 } = {}) {
  const file = nyAssemblyVotesFile(personId);
  if (!file) return null;
  const session = Number(String(file.session ?? nySessionYear()).slice(0, 4)) || nySessionYear();
  const bills = nyBills(session);
  const items = [];
  let substantiveTotal = 0;
  for (const [printNo, date, kind, option, motion, sourceUrl] of file.votes ?? []) {
    if ((kind === 'amendment' || kind === 'committee') && !includeAmendments) continue;
    substantiveTotal += 1;
    const b = bills[printNo];
    const issues = nyLawMatches(b?.ls, issueIds, b?.subj ?? []);
    if (!issues.length) continue;
    const links = [];
    if (sourceUrl) links.push({ label: 'Official vote record (NY Assembly)', url: sourceUrl });
    links.push({ label: 'Bill page (NY Senate site)', url: nyBillUrl(session, printNo) });
    items.push({
      date,
      jurisdiction: 'New York State',
      chamber: file.chamber === 'upper' ? 'NY Senate' : 'NY Assembly',
      bill: { number: printNo, title: b?.t ?? null, url: nyBillUrl(session, printNo), lawSection: b?.ls ?? null },
      question: motion || 'Floor vote',
      kind,
      kindLabel: kind === 'amendment' ? 'Amendment' : kind === 'veto-override' ? 'Veto override' : kind === 'committee' ? 'Committee vote' : 'Passage',
      vote: optionLabel(option),
      result: null,
      billStatus: b?.st ?? null,
      issues,
      links,
    });
  }
  items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { items: items.slice(0, limit), matchedTotal: items.length, substantiveTotal, session };
}
