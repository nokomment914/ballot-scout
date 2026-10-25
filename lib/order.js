// Ordering rules (impartiality): candidates follow ballot order when the data gives it
// for every candidate in the contest; otherwise they are sorted alphabetically by last
// name. Party is never used as a sort key.

const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'vi', 'md', 'phd', 'esq', 'dds', 'rn', 'cpa']);
const PARTICLES = new Set(['de', 'del', 'della', 'der', 'di', 'da', 'dos', 'du', 'la', 'le', 'van', 'von', 'bin', 'ibn', 'al', 'el', 'st', 'mac']);

function clean(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\([^)]*\)/g, ' ') // drop nicknames in parentheses
    .replace(/[“”"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Extract the surname used for alphabetical ordering. Handles "Last, First", suffixes and particles. */
export function lastName(fullName) {
  const name = clean(fullName);
  if (!name) return '';
  if (name.includes(',')) {
    const [before, after] = name.split(',', 2);
    const afterTokens = after.trim().toLowerCase().replace(/\./g, '').split(' ');
    // "Smith, Jr." style suffix after the comma: surname is the last token before it.
    if (afterTokens.length === 1 && SUFFIXES.has(afterTokens[0])) return lastName(before);
    return before.trim();
  }
  const tokens = name.split(' ');
  while (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1].toLowerCase().replace(/\./g, ''))) tokens.pop();
  let i = tokens.length - 1;
  while (i > 1 && PARTICLES.has(tokens[i - 1].toLowerCase().replace(/\./g, ''))) i -= 1;
  return tokens.slice(i).join(' ');
}

export function sortKey(fullName) {
  return clean(lastName(fullName)).toLowerCase();
}

function ballotPosition(c) {
  const v = c?.ballotOrder ?? c?.orderOnBallot;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
}

/**
 * Returns a new array. Uses ballot order only if every candidate has a position;
 * otherwise alphabetical by last name, then full name. The `orderBasis` property
 * on the result explains which rule applied.
 */
export function orderCandidates(candidates) {
  const list = [...(candidates ?? [])];
  const allHaveBallot = list.length > 0 && list.every((c) => ballotPosition(c) !== null);
  if (allHaveBallot) {
    list.sort((a, b) => ballotPosition(a) - ballotPosition(b) || sortKey(a.name).localeCompare(sortKey(b.name)));
    return Object.assign(list, { orderBasis: 'ballot' });
  }
  list.sort((a, b) =>
    sortKey(a.name).localeCompare(sortKey(b.name), 'en', { sensitivity: 'base' }) ||
    clean(a.name).localeCompare(clean(b.name), 'en', { sensitivity: 'base' })
  );
  return Object.assign(list, { orderBasis: 'alphabetical' });
}

/** Typical order of offices on New York ballots; used when no explicit ballot position exists. */
const OFFICE_RANK = [
  [/^(governor|governor and lieutenant governor)$/, 10],
  [/^lieutenant governor$/, 11],
  [/^comptroller$/, 20],
  [/^attorney general$/, 30],
  [/^(us-senate)$/, 40],
  [/^(us-house)$/, 50],
  [/^(state-senate)$/, 60],
  [/^(state-assembly)$/, 70],
];

/** Canonical office key used for ordering, de-duplication and record lookups. */
export function officeKey(office, { districtType, level } = {}) {
  const o = String(office ?? '').toLowerCase().replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
  const statewide = !districtType || districtType === 'statewide';
  if (statewide) {
    if (/lieutenant governor/.test(o) && !/^governor/.test(o)) return 'lieutenant governor';
    if (/^governor/.test(o) || /governor and lieutenant governor/.test(o)) return 'governor';
    if (/comptroller/.test(o)) return 'comptroller';
    if (/attorney general/.test(o)) return 'attorney general';
  }
  if (/(united states|us|u s) senat/.test(o) || (/senat/.test(o) && level === 'federal')) return 'us-senate';
  if (/representative in congress|us house|u s house|united states house|us representative|member of congress/.test(o) || districtType === 'congressional') return 'us-house';
  if (/state senat/.test(o) || districtType === 'state-senate') return 'state-senate';
  if (/assembly/.test(o) || districtType === 'state-assembly') return 'state-assembly';
  const slug = o.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return statewide ? slug : `${districtType}:${slug}`;
}

export function contestRank(contest) {
  const key = officeKey(contest.office, contest);
  for (const [re, rank] of OFFICE_RANK) if (re.test(key)) return rank;
  if (contest.districtType === 'judicial-district') return 80;
  if (contest.level === 'judicial' && ['county', 'district-court'].includes(contest.districtType)) return 82;
  if (contest.districtType === 'county') return 90;
  if (contest.districtType === 'county-legislative') return 91;
  if (contest.districtType === 'council') return 92;
  if (contest.districtType === 'town') return contest.level === 'judicial' ? 94 : 93;
  if (contest.districtType === 'citywide') return contest.level === 'judicial' ? 96 : 95;
  if (contest.districtType === 'village') return contest.level === 'judicial' ? 98 : 97;
  if (contest.level === 'judicial') return 85;
  if (contest.level === 'local') return 97;
  return 99;
}

/** Contests: explicit ballot position when every contest has one; otherwise office rank, then source order. */
export function orderContests(contests) {
  const list = (contests ?? []).map((c, i) => ({ c, i }));
  const allHave = list.length > 0 && list.every(({ c }) => Number.isFinite(Number(c.ballotOrder ?? c.ballotPlacement)) && (c.ballotOrder ?? c.ballotPlacement) !== null && (c.ballotOrder ?? c.ballotPlacement) !== undefined);
  list.sort((a, b) => {
    if (allHave) return Number(a.c.ballotOrder ?? a.c.ballotPlacement) - Number(b.c.ballotOrder ?? b.c.ballotPlacement) || a.i - b.i;
    return contestRank(a.c) - contestRank(b.c) || a.i - b.i;
  });
  return list.map(({ c }) => c);
}
