// New York State campaign finance from the NYS Board of Elections' open data on data.ny.gov
// (Socrata). Datasets:
//   7x2g-h32p  "Campaign Finance Filer Data: Beginning 1974"         (registered candidates and committees)
//   e9ss-239a  "Campaign Finance Disclosure Reports Data: Beginning 1999" (itemized transactions)
// Column names follow the NYS BOE file format references (FileFormatReferenceFiler.pdf and
// FileFormatReference.pdf). The build checks every required column against the dataset's live
// column list before querying, and skips the source entirely if anything is missing.
//
// Transactions are filed by a candidate's committee, not by the candidate's own filer record, and a
// committee's own disclosure rows carry no office or district. So a candidate is linked to a
// committee only when their own registration (a CANDIDATE filer) shows they're running for this
// office and district, and the committee's registered name names them. See linkCandidates().
import { fullNameKey } from './ids.js';
import { lastName } from './order.js';
import { isoDate } from './text.js';

export const NY_SOCRATA = process.env.NY_SOCRATA_BASE || 'https://data.ny.gov';
export const DATASETS = { filers: '7x2g-h32p', disclosures: 'e9ss-239a' };
/** Disclosure columns grouped once per filer (which committees filed in the years covered). */
export const GROUP_FIELDS = ['FILER_ID', 'CAND_COMM_NAME', 'OFFICE_DESC', 'DISTRICT'];
/** Disclosure columns read for each transaction of a linked committee. */
export const TRANSACTION_FIELDS = ['FILER_ID', 'ELECTION_YEAR', 'FILING_DESC', 'FILING_SCHED_ABBREV', 'FILING_SCHED_DESC', 'TRANS_NUMBER', 'R_AMEND', 'SCHED_DATE', 'ORG_AMT'];
export const REQUIRED = {
  filers: ['FILER_ID', 'FILER_NAME', 'COMPLIANCE_TYPE_DESC', 'FILER_TYPE_DESC', 'FILER_STATUS', 'COMMITTEE_TYPE_DESC', 'OFFICE_DESC', 'DISTRICT'],
  disclosures: [...new Set([...TRANSACTION_FIELDS, ...GROUP_FIELDS])],
};
/** Read when the dataset has them: county races are matched within the county. */
export const OPTIONAL = { filers: ['COUNTY_DESC'] };
/** The committee types that are one candidate's own campaign committee. */
export const CANDIDATE_COMMITTEE_TYPES = ['Authorized Single Candidate Committee', 'Public Campaign Finance Committee'];

export function datasetLinks(id) {
  return {
    landing: `${NY_SOCRATA}/d/${id}`,
    columns: `${NY_SOCRATA}/api/views/${id}/columns.json`,
    resource: `${NY_SOCRATA}/resource/${id}.json`,
  };
}

/** Map documented column names to Socrata field names using the dataset's columns.json. */
export function mapColumns(columns, required) {
  const byKey = new Map();
  for (const c of Array.isArray(columns) ? columns : []) {
    const field = c?.fieldName;
    if (!field) continue;
    for (const k of [c.name, c.fieldName]) if (k) byKey.set(String(k).trim().toUpperCase().replace(/\s+/g, '_'), { field, type: String(c.dataTypeName ?? 'text').toLowerCase() });
  }
  const map = {};
  const missing = [];
  for (const r of required) {
    const hit = byKey.get(r);
    if (hit) map[r] = hit;
    else missing.push(r);
  }
  return { map, missing };
}

/** SoQL literal for a column, quoting text columns and leaving numbers bare. */
export function soqlLiteral(col, value) {
  if (col.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`not a number: ${value}`);
    return String(n);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function officeClass(text) {
  const t = String(text ?? '').toLowerCase();
  if (/lieutenant governor|lt\.? governor/.test(t) && !/^governor and/.test(t)) return 'lieutenant-governor';
  if (/governor/.test(t)) return 'governor';
  if (/comptroller/.test(t)) return 'comptroller';
  if (/attorney general/.test(t)) return 'attorney-general';
  if (/supreme court/.test(t)) return 'supreme-court';
  if (/senat/.test(t)) return 'state-senate';
  if (/assembl/.test(t)) return 'state-assembly';
  return null;
}

export function moneyKey({ office, district, name }) {
  const d = /^\d+$/.test(String(district ?? '')) ? String(Number(district)) : '';
  return `${officeClass(office) ?? 'other'}|${d}|${fullNameKey(name)}`;
}

const DISTRICTED = new Set(['state-senate', 'state-assembly', 'supreme-court']);
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth'];

/** "28", "AD 075" and "2nd" -> the number; "Tenth" (how the filer data writes judicial districts) -> 10. */
export function districtNumber(value) {
  const s = String(value ?? '').trim().toLowerCase().replace(/\s+(judicial\s+)?district$/, '');
  const ordinal = ORDINALS.indexOf(s);
  if (ordinal >= 0) return ordinal + 1;
  const m = /\d+/.exec(s);
  return m ? Number(m[0]) : null;
}

function sameDistrict(cls, a, b) {
  if (!DISTRICTED.has(cls)) return true;
  const n = districtNumber(a);
  return n !== null && n === districtNumber(b);
}

// ---------- Names ----------

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'esq', 'md', 'phd']);
const PARTICLES = new Set(['de', 'del', 'della', 'der', 'di', 'da', 'dos', 'das', 'du', 'la', 'las', 'le', 'los', 'van', 'von', 'st', 'mac', 'bin', 'ibn', 'el', 'y']);

// Words that appear around a name in committee names. A surname with only these (or nothing) next
// to it stands alone ("Krueger for New York"); any other neighbor, initials included, is taken to be
// part of someone's name ("Friends of Mariama James", "James Lynch for NY Senate", "Racquel A. Williams").
const COMMITTEE_WORDS = new Set([
  'friends', 'friend', 'of', 'for', 'to', 'the', 'and', 'elect', 'reelect', 're', 'committee', 'citizens', 'people', 'team', 'vote',
  'new', 'york', 'yorkers', 'newyork', 'ny', 'nys', 'nyc', 'state', 'senate', 'senator', 'assembly', 'assemblyman', 'assemblywoman',
  'assemblymember', 'member', 'judge', 'justice', 'supreme', 'court', 'hon', 'honorable', 'campaign', 'inc', 'election', 'governor',
  'comptroller', 'attorney', 'general',
]);

// Common short forms of given names: [spellings of the full name, short forms]. A full name matches
// its short forms and other spellings, and a short form matches the full names, but two short forms
// never match each other ("Al" can be Alfred and "Fred" can be Alfred, yet Al Taylor isn't Fred Taylor).
const NICKNAME_GROUPS = [
  ['abraham', 'abe'], ['albert', 'al bert'], ['alexander', 'alex sandy'], ['alexandra alexandria', 'alex lexi'], ['alfred', 'al alf fred'],
  ['alan allan allen', 'al'], ['andrew', 'andy drew'], ['anthony antony antonio', 'tony'], ['barbara', 'barb'], ['benjamin', 'ben benny benji'],
  ['bernard', 'bernie'], ['catherine katherine kathryn katharine kathleen', 'cathy kathy kate katie kat kathie'], ['charles', 'charlie chuck'],
  ['christopher', 'chris kit'], ['christine christina cristina kristina kristine', 'chris tina chrissy'], ['kristen kristin', 'kris kristy'],
  ['cynthia', 'cindy'], ['daniel', 'dan danny'], ['david', 'dave davey'], ['deborah debra', 'deb debbie'], ['donald', 'don donnie'],
  ['douglas', 'doug'], ['edward', 'ed eddie ted ned'], ['edwin', 'ed eddie'], ['eduardo', 'ed eddie lalo'],
  ['elizabeth', 'liz lizzie beth betsy betsey betty eliza liza libby'], ['emmanuel immanuel manuel', 'manny'], ['eugene', 'gene'],
  ['frances', 'fran frannie'], ['francis', 'frank fran'], ['francisco', 'frank paco pancho'], ['franklin', 'frank'], ['frederick', 'fred freddie'],
  ['gerald', 'jerry gerry'], ['gregory', 'greg'], ['gustavo', 'gus'], ['harold', 'hal harry'], ['henry', 'hank harry'], ['herbert', 'herb'],
  ['isaac', 'ike'], ['jacob', 'jake'], ['jacqueline', 'jackie'], ['james', 'jim jimmy jamie'], ['jeffrey geoffrey', 'jeff'],
  ['jennifer', 'jen jenn jenny'], ['jerome', 'jerry'], ['jessica', 'jess jessie'], ['john', 'jack johnny jon'], ['jonathan', 'jon jonny'],
  ['joseph', 'joe joey'], ['josephine', 'jo josie'], ['joshua', 'josh'], ['judith', 'judy'], ['kenneth', 'ken kenny'], ['kimberly', 'kim'],
  ['lawrence laurence', 'larry'], ['leonard', 'len lenny leo'], ['louis', 'lou'], ['margaret', 'maggie meg peggy marge margie'],
  ['matthew', 'matt'], ['michael', 'mike mikey mick'], ['mitchell', 'mitch'], ['nathaniel nathan', 'nate nat'], ['nicholas', 'nick nicky'],
  ['nicole', 'nikki'], ['pamela', 'pam'], ['patricia', 'pat patty trish tricia'], ['patrick', 'pat'], ['peter', 'pete'], ['philip phillip', 'phil'],
  ['rebecca', 'becky becca'], ['richard', 'rich rick ricky dick richie'], ['ricardo', 'ricky rick'], ['robert', 'rob robbie bob bobby'],
  ['roberto', 'rob beto'], ['ronald', 'ron ronnie'], ['salvatore', 'sal'], ['samuel', 'sam sammy'], ['samantha', 'sam'], ['sandra', 'sandy'],
  ['solomon', 'sol'], ['stephen steven', 'steve stevie'], ['stephanie', 'steph'], ['susan suzanne', 'sue susie suzy'],
  ['theodore', 'ted teddy theo'], ['thomas', 'tom tommy'], ['timothy', 'tim timmy'], ['victoria', 'vicky tori'], ['vincent', 'vince vinny'],
  ['walter', 'walt'], ['william', 'will bill billy willie liam'], ['zachary', 'zach zack'], ['mohammed mohammad muhammad mohamed mohamad', ''],
];
const NICKNAMES = new Map();
const addNames = (n, names) => NICKNAMES.set(n, new Set([...(NICKNAMES.get(n) ?? []), ...names]));
for (const [fullNames, shortNames] of NICKNAME_GROUPS) {
  const full = fullNames.split(' ').filter(Boolean);
  const short = shortNames.split(' ').filter(Boolean);
  for (const n of full) addNames(n, [...full, ...short]);
  for (const n of short) addNames(n, full);
}
const withNicknames = (names) => new Set([...names].flatMap((n) => [n, ...(NICKNAMES.get(n) ?? [])]));

/** Lower-case letter tokens: accents dropped, apostrophes removed ("O'Keefe" -> "okeefe"), split on everything else. */
export function nameTokens(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/['’`]/g, '').split(/[^a-z]+/).filter(Boolean);
}

/**
 * A person's name for matching. Surname keys are written without spaces or hyphens, so
 * "De Stefano", "DeStefano", "Gonzalez-Rojas" and "Gonzalez Rojas" compare equal, and particles
 * stay with the surname ("De Los Santos"). When there's a word between the first name and the
 * surname, it may be the first half of a two-word surname ("Darializa Avila Chevalier"), so
 * "avilachevalier" is kept as a second key. `first` holds the given name the person goes by (the
 * first word that isn't an initial) and its short forms; `given` holds every given name.
 */
export function personName(fullName) {
  let name = String(fullName ?? '').replace(/\([^)]*\)/g, ' ').replace(/[“”"]/g, ' ').replace(/\s+/g, ' ').trim();
  if (name.includes(',')) {
    const [before, after] = name.split(',', 2);
    name = nameTokens(after).every((t) => SUFFIXES.has(t)) ? before : `${after} ${before}`; // "Last, First" -> "First Last"
  }
  const words = name.split(' ').map(nameTokens).filter((t) => t.length && !(t.length === 1 && SUFFIXES.has(t[0])));
  const tokens = words.flat();
  const base = nameTokens(lastName(name));
  const surnameKey = base.join('');
  if (!base.length || tokens.length <= base.length) return { surnameKey, surnameKeys: new Set(surnameKey ? [surnameKey] : []), first: new Set(), given: new Set() };
  let start = tokens.length - base.length;
  while (start > 1 && PARTICLES.has(tokens[start - 1])) start -= 1;
  const surname = tokens.slice(start);
  // Given names: the words before the surname, without initials.
  const givenWords = [];
  let used = 0;
  for (const w of words) {
    if (used >= start) break;
    const part = w.slice(0, start - used).filter((t) => t.length > 1);
    used += w.length;
    if (part.length) givenWords.push(part);
  }
  const surnameKeys = new Set([surnameKey, surname.join('')]);
  if (givenWords.length > 1) surnameKeys.add([...givenWords[givenWords.length - 1], ...surname].join(''));
  const first = new Set();
  if (givenWords.length) {
    first.add(givenWords[0].join(''));
    first.add(givenWords[0][0]);
    if (givenWords[1]) first.add([...givenWords[0], ...givenWords[1]].join(''));
  }
  const given = new Set(givenWords.flat());
  for (const w of givenWords) given.add(w.join(''));
  for (let i = 0; i + 1 < givenWords.length; i++) given.add([...givenWords[i], ...givenWords[i + 1]].join(''));
  return { surnameKey, surnameKeys, first: withNicknames(first), given };
}

const intersects = (a, b) => [...a].some((x) => b.has(x));
const givenCompatible = (a, b) => intersects(withNicknames(a.given), b.given) || intersects(withNicknames(b.given), a.given);

/** Same surname and a given name in common (allowing short forms: "Steve Chan" and "Stephen T. Chan"). */
export function samePerson(a, b) {
  return intersects(a.surnameKeys, b.surnameKeys) && givenCompatible(a, b);
}

/** Same surname, but given names that rule out the same person ("Kristen Gonzalez" and "Veronica I. Gonzalez"). */
function otherPerson(a, b) {
  return intersects(a.surnameKeys, b.surnameKeys) && a.given.size > 0 && b.given.size > 0 && !givenCompatible(a, b);
}

/** [start, end) token ranges whose letters spell `key` ("de","stefano" for "destefano"). */
function runs(tokens, key) {
  const out = [];
  for (let s = 0; s < tokens.length; s++) {
    let acc = '';
    for (let e = s; e < tokens.length && acc.length < key.length; e++) {
      acc += tokens[e];
      if (acc === key) out.push([s, e + 1]);
      if (!key.startsWith(acc)) break;
    }
  }
  return out;
}

/**
 * How a committee name names the person: 'full' when the first name (or a short form) comes just
 * before the surname, with at most two words between ("Friends Of Carl E Heastie", "Friends of Joe
 * DeStefano"); 'surname' when the full surname stands alone among committee words ("DiNapoli for New
 * York", "Re-Elect Addabbo for Senate"); otherwise null. Surnames of two letters or that are
 * themselves committee words ("To") only count with the first name.
 */
export function nameMatch(person, committeeName) {
  const tokens = nameTokens(committeeName);
  const keys = [...person.surnameKeys].filter(Boolean);
  const surnameRuns = keys.flatMap((k) => runs(tokens, k));
  for (const f of person.first) {
    for (const [, fe] of runs(tokens, f)) if (surnameRuns.some(([s]) => s >= fe && s - fe <= 2)) return 'full';
  }
  for (const k of keys) {
    if (k.length < 3 || COMMITTEE_WORDS.has(k)) continue;
    for (const [s, e] of runs(tokens, k)) {
      if ((s === 0 || COMMITTEE_WORDS.has(tokens[s - 1])) && (e === tokens.length || COMMITTEE_WORDS.has(tokens[e]))) return 'surname';
    }
  }
  return null;
}

/** The office a committee's name mentions, if any ("Salazar For Supreme Court", "Parker for Assembly"). */
export function nameOffice(name) {
  const cls = officeClass(name);
  if (cls) return cls;
  const t = ` ${nameTokens(name).join(' ')} `;
  if (/ (judge|justice|court) /.test(t)) return 'judicial';
  if (/ (council\w*|legislat\w*|supervisor|mayor|town|village|clerk|trustee|sheriff|highway|borough|district attorney|county executive) /.test(t)) return 'local';
  return null;
}

function officeAgrees(named, cls) {
  return !named || named === cls || (named === 'judicial' && cls === 'supreme-court');
}

// ---------- Rows ----------

/** Normalize a raw Socrata disclosure row using the column map. */
export function disclosureRow(raw, map) {
  const g = (k) => raw?.[map[k]?.field];
  return {
    filer: g('FILER_ID') !== undefined && g('FILER_ID') !== null ? String(g('FILER_ID')) : null,
    trans: g('TRANS_NUMBER') ?? null,
    filing: g('FILING_DESC') ?? null,
    amend: String(g('R_AMEND') ?? '').toUpperCase() === 'Y' ? 'Y' : 'N',
    sched: g('FILING_SCHED_ABBREV') ?? null,
    schedDesc: g('FILING_SCHED_DESC') ?? null,
    amount: g('ORG_AMT'),
    date: isoDate(g('SCHED_DATE')),
  };
}

export function filerRow(raw, map) {
  const g = (k) => raw?.[map[k]?.field];
  return {
    id: g('FILER_ID') !== undefined ? String(g('FILER_ID')) : null,
    name: g('FILER_NAME') ?? null,
    compliance: g('COMPLIANCE_TYPE_DESC') ?? null,
    filerType: g('FILER_TYPE_DESC') ?? null,
    status: g('FILER_STATUS') ?? null,
    committeeType: g('COMMITTEE_TYPE_DESC') ?? null,
    office: g('OFFICE_DESC') ?? null,
    district: g('DISTRICT') ?? null,
    county: g('COUNTY_DESC') ?? null,
  };
}

/** One row of the grouped disclosure query: a filer, the name and office on its filings, and the row count. */
export function groupRow(raw, map) {
  const g = (k) => raw?.[map[k]?.field];
  return {
    id: g('FILER_ID') !== undefined && g('FILER_ID') !== null ? String(g('FILER_ID')) : null,
    name: g('CAND_COMM_NAME') ?? null,
    office: g('OFFICE_DESC') ?? null,
    district: g('DISTRICT') ?? null,
    n: Number(raw?.n ?? 0),
  };
}

// ---------- Matching ----------

const isActive = (f) => /^active$/i.test(String(f?.status ?? '').trim());
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const countyKey = (s) => String(s ?? '').toLowerCase().replace(/\bcounty\b/g, '').replace(/[^a-z]/g, '');

/** State races use state-level filers; county races (level "local") use county filers in that county. */
function inScope(candidate, f) {
  if (candidate.level === 'local') {
    return /county/i.test(f.filerType ?? '') && Boolean(countyKey(candidate.county)) && countyKey(f.county) === countyKey(candidate.county);
  }
  return !f.filerType || /state/i.test(f.filerType);
}

// Office class and parsed name of each filer row, worked out once.
const derived = new WeakMap();
function filerInfo(f) {
  let d = derived.get(f);
  if (!d) {
    d = { cls: officeClass(f.office), person: personName(f.name) };
    derived.set(f, d);
  }
  return d;
}

/** The candidate's own registrations (CANDIDATE filers) for this office and district. */
export function registrations(candidate, filers) {
  const cls = officeClass(candidate.office);
  if (!cls) return [];
  const person = personName(candidate.name);
  return filers.filter((f) => /candidate/i.test(f.compliance ?? '')
    && filerInfo(f).cls === cls
    && inScope(candidate, f)
    && sameDistrict(cls, f.district, candidate.district)
    && samePerson(person, filerInfo(f).person));
}

/** The candidate's registration to show: the only one, else the newest active one. */
export function matchFiler(candidate, filers) {
  const regs = registrations(candidate, filers);
  if (regs.length <= 1) return regs[0] ?? null;
  const pool = regs.filter(isActive).length ? regs.filter(isActive) : regs;
  return [...pool].sort((a, b) => Number(b.id) - Number(a.id) || String(b.id).localeCompare(String(a.id)))[0];
}

const label = (c) => `${c.name} (${c.office}${c.district ? ` ${c.district}` : ''})`;
const filerLabel = (f) => `${clean(f.name)}${f.office ? `, ${clean(f.office)}${f.district ? ` ${clean(f.district)}` : ''}` : ''}`;

/**
 * Link each candidate to the committees that file their money, by these rules:
 *  1. The committee is an Authorized Single Candidate Committee or a Public Campaign Finance
 *     Committee, ACTIVE, at the level of the race (state-level for state races; county-level in the
 *     same county for county races), and it filed in the years covered (`groups`).
 *  2. Office: when the committee's filings name an office (OFFICE_DESC), it must be this office class
 *     (and district, for districted offices). Otherwise, which is every candidate committee in the
 *     data today, the candidate must have their own registration for this office and district.
 *     An office named in the committee's name ("for Assembly") must also agree.
 *  3. Name: the committee's registered name names the candidate (nameMatch). Names with the first name
 *     (or a short form) are preferred; surname-only names are used only when there are none.
 *  4. A surname-only name is ambiguous when another active candidate at that level has the same
 *     surname and a different first name (and, if the name mentions an office, that office). A
 *     committee that two candidates would claim is ambiguous for both. Ambiguity links nothing.
 *  5. A candidate filer that files its own reports (some judicial candidates do) is included.
 *
 * @param {Array<{name: string, office: string, district?: string|null, level?: string, county?: string}>} candidates
 * @param {{ filers: object[], committees: object[], groups: object[] }} data  filerRow() and groupRow() rows
 * @returns {{ links: Array<object|null>, unmatched: Array<{ index: number, code: string, reason: string }> }}
 *   links[i] is { filer, committees: [{ id, name, type, status, match }], filerFilings, filerIds, matchedBy } or null.
 */
export function linkCandidates(candidates, { filers = [], committees = [], groups = [] }) {
  const activity = new Map();
  for (const g of groups) {
    if (!g.id) continue;
    const a = activity.get(g.id) ?? { n: 0, offices: [] };
    a.n += g.n || 0;
    if (clean(g.office)) a.offices.push({ office: g.office, district: g.district });
    activity.set(g.id, a);
  }
  const candidateTypes = new Set(CANDIDATE_COMMITTEE_TYPES.map((t) => t.toLowerCase()));
  const pool = committees.filter((k) => k.id && activity.has(k.id) && /committee/i.test(k.compliance ?? 'committee')
    && candidateTypes.has(String(k.committeeType ?? '').trim().toLowerCase()) && isActive(k));
  // Candidate filers by surname key, so each candidate only looks at namesakes.
  const bySurname = new Map();
  for (const f of filers) {
    if (!/candidate/i.test(f.compliance ?? '')) continue;
    for (const k of filerInfo(f).person.surnameKeys) {
      if (!bySurname.has(k)) bySurname.set(k, []);
      bySurname.get(k).push(f);
    }
  }

  const picks = candidates.map((c) => {
    const cls = officeClass(c.office);
    const person = personName(c.name);
    if (!cls || !person.surnameKey) return { problem: { code: 'no-registration', reason: 'The office or name could not be read.' } };
    const namesakes = [...new Set([...person.surnameKeys].flatMap((k) => bySurname.get(k) ?? []))];
    const regs = registrations(c, namesakes);
    const own = regs.filter((f) => activity.has(f.id));
    const matches = [];
    for (const k of pool) {
      if (!inScope(c, k)) continue;
      const match = nameMatch(person, k.name);
      if (!match) continue;
      const named = nameOffice(k.name);
      if (!officeAgrees(named, cls)) continue;
      const offices = activity.get(k.id).offices;
      let via;
      if (offices.length) {
        if (!offices.some((o) => officeClass(o.office) === cls && sameDistrict(cls, o.district, c.district))) continue;
        via = 'filings';
      } else if (regs.length) via = 'registration';
      else continue;
      matches.push({ k, match, via, named });
    }
    const full = matches.filter((m) => m.match === 'full');
    const chosen = full.length ? full : matches;
    for (const m of chosen) {
      if (m.match !== 'surname') continue;
      const rivals = namesakes.filter((f) => isActive(f) && inScope(c, f) && (!m.named || officeAgrees(m.named, filerInfo(f).cls))
        && otherPerson(person, filerInfo(f).person));
      if (rivals.length) {
        const shown = rivals.slice(0, 3).map(filerLabel).join('; ');
        return { problem: { code: 'ambiguous', reason: `Committee "${clean(m.k.name)}" (filer ID ${m.k.id}) names only the surname, and another active candidate has it: ${shown}${rivals.length > 3 ? ` and ${rivals.length - 3} more` : ''}.` } };
      }
    }
    if (!chosen.length && !own.length) {
      return { problem: regs.length
        ? { code: 'no-committee', reason: 'Registered for this office, but no active candidate committee that filed in these years has a name that names the candidate, and the registration itself has no filings.' }
        : { code: 'no-registration', reason: 'No registration as a candidate for this office and district was found in the filer data, so no committee can be tied to this race.' } };
    }
    return { regs, own, chosen };
  });

  // A committee two candidates would both claim is theirs is left unlinked for both.
  const claims = new Map();
  picks.forEach((p, i) => { for (const m of p.chosen ?? []) claims.set(m.k.id, [...(claims.get(m.k.id) ?? []), i]); });
  const links = [];
  const unmatched = [];
  picks.forEach((p, i) => {
    const shared = (p.chosen ?? []).find((m) => claims.get(m.k.id).length > 1);
    if (shared) {
      const others = claims.get(shared.k.id).filter((j) => j !== i).map((j) => label(candidates[j])).join('; ');
      p = { problem: { code: 'shared', reason: `Committee "${clean(shared.k.name)}" (filer ID ${shared.k.id}) also matches ${others}.` } };
    }
    if (p.problem) {
      links.push(null);
      unmatched.push({ index: i, ...p.problem });
      return;
    }
    const filer = matchFiler(candidates[i], p.regs);
    const committeesOut = p.chosen.map(({ k, match }) => ({ id: k.id, name: clean(k.name), type: clean(k.committeeType) || null, status: clean(k.status) || null, match }));
    const ownIds = p.own.map((f) => f.id);
    links.push({
      filer: filer ? { id: filer.id, name: clean(filer.name), status: filer.status ?? null, office: filer.office ?? null, district: filer.district ?? null } : null,
      committees: committeesOut,
      filerFilings: ownIds.length > 0,
      filerIds: [...new Set([...committeesOut.map((k) => k.id), ...ownIds])],
      matchedBy: !committeesOut.length ? 'registration' : p.chosen.every((m) => m.via === 'filings') ? 'filings-office+name' : 'registration+name',
    });
  });
  return { links, unmatched };
}

/**
 * Sum itemized transactions by schedule. Amended reports can repeat a transaction number,
 * so each transaction number is counted once per filer (the amended row wins, then the latest date).
 */
export function aggregateTransactions(rows) {
  const byTrans = new Map();
  let anonymous = 0;
  for (const r of rows) {
    const key = r.trans ? `${r.filer ?? ''}|${r.filing ?? ''}|${r.sched ?? ''}|${r.trans}` : `anon-${anonymous++}`;
    const prev = byTrans.get(key);
    if (!prev) { byTrans.set(key, r); continue; }
    const better = (r.amend === 'Y' && prev.amend !== 'Y') || (r.amend === prev.amend && String(r.date ?? '') > String(prev.date ?? ''));
    if (better) byTrans.set(key, r);
  }
  const sched = new Map();
  let latest = null;
  for (const r of byTrans.values()) {
    const amt = Number(r.amount);
    if (!Number.isFinite(amt)) continue;
    const k = r.sched ?? '?';
    const s = sched.get(k) ?? { abbrev: k, desc: r.schedDesc ?? k, total: 0, count: 0 };
    s.total += amt;
    s.count += 1;
    sched.set(k, s);
    if (r.date && (!latest || r.date > latest)) latest = r.date;
  }
  const schedules = [...sched.values()].map((s) => ({ ...s, total: Math.round(s.total * 100) / 100 })).sort((a, b) => a.abbrev.localeCompare(b.abbrev));
  return { schedules, transactions: [...byTrans.values()].length, rowsRead: rows.length, latestDate: latest };
}
