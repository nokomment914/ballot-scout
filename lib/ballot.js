// Assemble a voter's ballot: districts (Census) + researched seed contests + Google Civic
// (contests, polling places, official links), with candidate identities resolved.
import { geocodeAddress, normalizeAddressInput, GEOCODER_SOURCE } from './geocoder.js';
import { getVoterInfo, CIVIC_SOURCE } from './civic.js';
import { loadSeed, matchSeedContests, districtKeys, proposalApplies } from './seed.js';
import { orderCandidates, orderContests, officeKey } from './order.js';
import { recordProfile } from './labels.js';
import { resolveIdentity, encodeCandidateToken, fullNameKey } from './ids.js';
import { districtLabel, normalizeDistrict, normalizeCounty, parseCountyDistrict } from './districts.js';
import { ballotOutside } from './outside.js';
import { resolveIssueIds } from './issues.js';
import { isFixtureMode, electionDate } from './config.js';
import { loadMembersIndex } from './votes.js';
import { getCurrentMembers } from './congress.js';

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

// Names compare without middle initials or punctuation ("Kathy C. Hochul" = "Kathy Hochul").
const nameKey = (s) => fullNameKey(s);

function contestKey(c) {
  return `${officeKey(c.office, c)}|${c.districtType}|${normalizeDistrict(c.district) ?? ''}`;
}

function shapeCandidate(c, contest, state, sample) {
  const { ids, matchedBy } = resolveIdentity({ candidate: c, contest, state });
  const profile = recordProfile({ contest, candidate: c, ids });
  const token = encodeCandidateToken({
    name: c.name, state, office: contest.office, districtType: contest.districtType, district: contest.district,
    level: contest.level, incumbent: c.incumbent, currentOffice: c.currentOffice, ids, matchedBy, role: 'candidate', website: c.website, sample, contestId: contest.id,
  });
  let runningMate = null;
  if (c.runningMate) {
    const mate = { name: c.runningMate, incumbent: false, currentOffice: null };
    const rm = resolveIdentity({ candidate: mate, contest, state, role: 'running-mate' });
    const rmProfile = recordProfile({ contest, candidate: mate, ids: rm.ids, role: 'running-mate' });
    runningMate = {
      name: c.runningMate,
      office: /governor/i.test(contest.office) ? 'Lieutenant Governor' : 'Running mate',
      id: encodeCandidateToken({ name: c.runningMate, state, office: contest.office, districtType: contest.districtType, district: contest.district, level: contest.level, incumbent: false, ids: rm.ids, matchedBy: rm.matchedBy, role: 'running-mate', sample, contestId: contest.id }),
      profile: rmProfile,
    };
  }
  return {
    id: token,
    name: c.name,
    partyLines: Array.isArray(c.partyLines) ? c.partyLines : [],
    incumbent: Boolean(c.incumbent),
    currentOffice: c.currentOffice ?? null,
    website: c.website ?? null,
    channels: c.channels ?? [],
    ballotOrder: c.ballotOrder ?? c.orderOnBallot ?? null,
    alsoListedAs: Array.isArray(c.alsoListedAs) ? c.alsoListedAs : [],
    profile,
    linked: Object.keys(ids),
    runningMate,
    sources: Array.isArray(c.sources) ? c.sources : [],
  };
}

function shapeContest(contest, geo, sample) {
  const state = geo.state.abbr;
  const candidates = orderCandidates((contest.candidates ?? []).map((c) => shapeCandidate(c, contest, state, sample)));
  return {
    id: String(contest.id),
    office: contest.office,
    level: contest.level ?? null,
    districtType: contest.districtType,
    district: contest.district ?? null,
    districtLabel: districtLabel(contest.districtType, contest.district, { stateName: geo.state.name }),
    seats: Number(contest.seats) || 1,
    county: contest.county ?? null,
    term: contest.term ?? null,
    ballotOrder: contest.ballotOrder ?? contest.ballotPlacement ?? null,
    orderBasis: candidates.orderBasis,
    candidates: [...candidates],
    origin: contest.origin,
    note: contest.note ?? null,
    sources: contest.sources ?? [],
  };
}

/** Two listings of one contest: same district type and district, and at least half the candidates in common. */
export function sameContestByCandidates(a, b) {
  if (a.districtType !== b.districtType || (normalizeDistrict(a.district) ?? '') !== (normalizeDistrict(b.district) ?? '')) return false;
  const an = new Set((a.candidates ?? []).map((c) => nameKey(c.name)));
  const bn = (b.candidates ?? []).map((c) => nameKey(c.name));
  if (!an.size || !bn.length) return false;
  const common = bn.filter((n) => an.has(n)).length;
  return common >= Math.ceil(Math.min(an.size, bn.length) / 2);
}

/** Mostly the same candidates, whatever the district labels say (Civic names local districts its own way). */
export function candidatesOverlap(a, b) {
  const an = new Set((a.candidates ?? []).map((c) => nameKey(c.name)));
  const bn = (b.candidates ?? []).map((c) => nameKey(c.name));
  if (!an.size || !bn.length) return false;
  const common = bn.filter((n) => an.has(n)).length;
  return common >= 1 && common >= Math.ceil(Math.min(an.size, bn.length) / 2);
}

/** Use Civic's ballot positions for seed candidates when the names line up exactly. */
function applyCivicOrder(seedContest, civicContest) {
  const order = new Map(civicContest.candidates.filter((c) => c.orderOnBallot !== null).map((c) => [nameKey(c.name), c.orderOnBallot]));
  const candidates = seedContest.candidates.map((c) => (order.has(nameKey(c.name)) ? { ...c, orderOnBallot: order.get(nameKey(c.name)) } : c));
  return {
    ...seedContest,
    candidates,
    ballotPlacement: seedContest.ballotOrder ?? civicContest.ballotPlacement ?? null,
    sources: [...(seedContest.sources ?? []), { label: 'Google Civic Information API (ballot order)', url: CIVIC_SOURCE.url }],
  };
}

function bestElection(seed, civic) {
  const e = seed?.election;
  if (e) {
    return {
      id: e.id, name: e.name, date: e.date,
      registrationDeadline: e.registrationDeadline ?? null,
      earlyVoting: e.earlyVoting ?? null,
      absenteeApplicationDeadline: e.absenteeApplicationDeadline ?? null,
      pollHours: e.pollHours ?? null,
      officialLinks: e.officialLinks ?? [],
      sources: e.sources ?? [],
      origin: 'seed',
    };
  }
  if (civic?.status === 'ok') {
    return { id: civic.election.id, name: civic.data.election?.name ?? civic.election.name, date: civic.data.election?.date ?? civic.election.electionDay, registrationDeadline: null, earlyVoting: null, absenteeApplicationDeadline: null, pollHours: null, officialLinks: [], sources: [{ label: CIVIC_SOURCE.label, url: CIVIC_SOURCE.url }], origin: 'civic' };
  }
  return { id: null, name: 'General Election', date: electionDate(), registrationDeadline: null, earlyVoting: null, absenteeApplicationDeadline: null, pollHours: null, officialLinks: [], sources: [], origin: 'default' };
}

/** When no ballot list exists for an address, show current members of Congress (clearly labeled). */
async function officeholderContests(geo) {
  const state = geo.state.abbr;
  const cd = geo.congressional?.district ?? null;
  let senators = [];
  let reps = [];
  let origin = 'congress-gov';
  try {
    if (isFixtureMode()) throw new Error('fixtures');
    senators = (await getCurrentMembers(state)).filter((m) => /senate/i.test(m.chamber ?? ''));
    if (cd !== null) reps = await getCurrentMembers(state, cd);
  } catch {
    origin = 'voteview';
    const idx = loadMembersIndex();
    const all = Object.entries(idx).map(([bioguide, m]) => ({ bioguide, ...m }));
    const maxC = Math.max(0, ...all.map((m) => Math.max(...(m.c ?? [0]))));
    const current = all.filter((m) => m.st === state && (m.c ?? []).includes(maxC));
    senators = current.filter((m) => m.ch === 'Senate').map((m) => ({ bioguide: m.bioguide, name: m.n }));
    reps = current.filter((m) => m.ch === 'House' && String(m.d) === String(cd)).map((m) => ({ bioguide: m.bioguide, name: m.n }));
  }
  const flip = (n) => (String(n).includes(',') ? `${String(n).split(',')[1].trim()} ${String(n).split(',')[0].trim()}` : n);
  const note = 'Current officeholders, not a ballot list. We don’t have a verified list of candidates for this address yet.';
  const src = origin === 'congress-gov' ? [{ label: 'Congress.gov API (current members)', url: 'https://api.congress.gov/' }] : [{ label: 'Voteview member lists', url: 'https://voteview.com/data' }];
  const out = [];
  if (senators.length) out.push({ id: 'officeholders-us-senate', office: 'U.S. Senate (current senators)', level: 'federal', districtType: 'statewide', district: null, seats: senators.length, origin: 'officeholders', note, sources: src, candidates: senators.map((m) => ({ name: flip(m.name), partyLines: [], incumbent: true, currentOffice: 'U.S. Senator', ids: { bioguide: m.bioguide }, sources: src })) });
  if (reps.length) out.push({ id: 'officeholders-us-house', office: `U.S. House (current representative)`, level: 'federal', districtType: 'congressional', district: cd, seats: 1, origin: 'officeholders', note, sources: src, candidates: reps.map((m) => ({ name: flip(m.name), partyLines: [], incumbent: true, currentOffice: `U.S. Representative, District ${cd}`, ids: { bioguide: m.bioguide }, sources: src })) });
  return out;
}

export async function assembleBallot({ address, issues }) {
  const addr = normalizeAddressInput(address);
  if (addr.length < 5 || addr.length > 200 || !/\d/.test(addr)) {
    throw new UserError('Enter the full street address where you’re registered to vote, including the house number, city and state or ZIP code.');
  }
  const issueIds = resolveIssueIds(issues);

  let geo;
  try {
    geo = await geocodeAddress(addr);
  } catch {
    throw new UserError('The Census address lookup isn’t responding right now. Please try again in a minute.', 502);
  }
  if (!geo?.matched || !geo.state?.abbr) {
    throw new UserError('We couldn’t match that address. Check the house number, street, city and ZIP code, and use the address where you’re registered to vote.', 422);
  }
  const state = geo.state.abbr;
  const [civic, seedRes] = await Promise.all([getVoterInfo(addr, { state }), Promise.resolve(loadSeed(state))]);
  const notices = [];
  const seedValid = seedRes && seedRes.validation.ok;
  if (seedRes && !seedValid) notices.push('The researched ballot file for this state failed validation, so it isn’t shown. Showing other sources only.');
  const sample = isFixtureMode() || Boolean(seedRes?.placeholder);

  const seed = seedValid ? seedRes.seed : null;
  const { matched, possible: possibleAll } = seed ? matchSeedContests(seed, geo) : { matched: [], possible: [] };
  const civicContests = civic.status === 'ok' ? civic.data.contests : [];

  // A possible contest (district not found from the address) that Google Civic lists for this
  // address, with the same candidates, is on this ballot; the rest of its group isn't.
  const promoted = new Map();
  for (const p of possibleAll) {
    const cc = civicContests.find((x) => ![...promoted.values()].includes(x) && candidatesOverlap(p, x));
    if (cc) promoted.set(p, cc);
  }
  const promotedGroups = new Set([...promoted.keys()].map((p) => possibleGroup(p).key));
  const possible = possibleAll.filter((p) => !promoted.has(p) && !promotedGroups.has(possibleGroup(p).key));
  for (const p of promoted.keys()) matched.push(p);

  const merged = [];
  const used = new Set();
  const civicByKey = new Map(civicContests.map((c) => [contestKey(c), c]));
  for (const c of matched) {
    // Same office and district, or (when office names differ) same district with mostly the same candidates.
    const cc = promoted.get(c) ?? civicByKey.get(contestKey(c)) ?? civicContests.find((x) => !used.has(x) && sameContestByCandidates(c, x));
    if (cc) used.add(cc);
    merged.push(cc ? applyCivicOrder(c, cc) : c);
  }
  for (const cc of civicContests) if (!used.has(cc)) merged.push(cc);

  let contests = merged;
  let mode = seed ? 'seed' : civicContests.length ? 'civic' : 'none';
  if (!contests.length) {
    contests = await officeholderContests(geo);
    mode = 'officeholders';
    notices.push('We don’t have a verified ballot list for this address yet. Below are your current members of Congress so you can review their records. This is not your ballot. Check your official sample ballot for the full list of contests.');
  }

  const shaped = orderContests(contests).map((c) => shapeContest(c, geo, sample));
  const possibleShaped = orderContests(possible).map((c) => ({ ...shapeContest(c, geo, sample), note: 'This contest’s district can’t be confirmed from your address. Check your official sample ballot.', group: possibleGroup(c) }));

  const keysForGeo = districtKeys(geo);
  const seedProposals = (seed?.ballotProposals ?? []).filter((p) => proposalApplies(p, keysForGeo));
  const proposals = [
    ...seedProposals.map((p) => ({ ...p, origin: 'seed' })),
    ...((civic.status === 'ok' && !seedProposals.length) ? civic.data.proposals : []),
  ];

  const election = bestElection(seed, civic);
  const voting = civic.status === 'ok'
    ? { pollingLocations: civic.data.pollingLocations, earlyVoteSites: civic.data.earlyVoteSites, dropOffLocations: civic.data.dropOffLocations, administrationLinks: civic.data.administrationLinks, mailOnly: civic.data.mailOnly, source: { ...CIVIC_SOURCE, lastUpdated: civic.fetchedAt ?? null } }
    : { pollingLocations: [], earlyVoteSites: [], dropOffLocations: [], administrationLinks: [], mailOnly: false, source: null };

  const sources = [
    { ...GEOCODER_SOURCE, status: 'ok', lastUpdated: geo.fetchedAt ?? null, detail: geo.vintage ? `Vintage ${geo.vintage}` : null },
    { ...CIVIC_SOURCE, status: civic.status, lastUpdated: civic.fetchedAt ?? null, detail: civicStatusText(civic.status) },
    seedRes
      ? { id: 'seed', label: 'Researched ballot file', url: null, file: seedRes.file, status: seedValid ? 'ok' : 'invalid', lastUpdated: seedRes.seed?.generatedAt ?? null, detail: seedValid ? `${seedRes.validation.stats.contests} contests, ${seedRes.validation.stats.candidates} candidates; every entry lists its own sources` : 'failed validation' }
      : { id: 'seed', label: 'Researched ballot file', url: null, status: 'none', lastUpdated: null, detail: `No researched ballot file for ${state} yet` },
  ];

  return {
    mode: isFixtureMode() ? 'fixtures' : 'live',
    sample,
    ballotSource: mode,
    generatedAt: new Date().toISOString(),
    issues: issueIds,
    matchedAddress: geo.matchedAddress,
    districts: {
      state: geo.state,
      congressional: geo.congressional,
      stateSenate: geo.stateSenate,
      stateAssembly: geo.stateAssembly,
      county: geo.county,
      place: geo.place,
      countySubdivision: geo.countySubdivision ?? null,
      judicialDistrict: geo.judicialDistrict,
    },
    election,
    voting,
    localBoard: localBoardFor(seed, geo),
    contests: shaped,
    possibleContests: possibleShaped,
    ballotProposals: proposals,
    outsideSpending: ballotOutside(shaped, state),
    coverage: seed?.coverage ?? null,
    notices,
    sources,
  };
}

/** The county board of elections for this address (NYC's board covers all five counties). */
export function localBoardFor(seed, geo) {
  const county = normalizeCounty(geo?.county?.name ?? geo?.county?.basename);
  if (!county) return null;
  return (seed?.localBoards ?? []).find((b) => (b.counties ?? []).some((c) => normalizeCounty(c) === county)) ?? null;
}

/** Possible contests for the same office in the same county are shown together, with a district picker. */
export function possibleGroup(c) {
  if (c.districtType === 'county-legislative') {
    const { county, number } = parseCountyDistrict(c.district);
    return { key: `county-legislative|${county}`, label: `${c.office}: ${county} County`, pickLabel: `District ${number}`, sortKey: Number(number) || 0 };
  }
  const mcd = c.districtType === 'judicial-district' ? /^(.*?) County,\s*(\d+)\w*\s+Municipal Court District$/i.exec(String(c.district ?? '').trim()) : null;
  if (mcd) {
    const [, county, number] = mcd;
    return { key: `civil-court-mcd|${county}`, label: `Judge of the Civil Court: ${county} County municipal court districts`, pickLabel: String(c.district).replace(/^.*?,\s*/, ''), sortKey: Number(number) || 0 };
  }
  return { key: `${c.districtType}|${c.id}`, label: c.office, pickLabel: districtLabel(c.districtType, c.district), sortKey: 0 };
}

function civicStatusText(status) {
  return {
    ok: 'Polling places and contests loaded',
    'not-configured': 'Not configured (no API key)',
    'no-election': 'Google has not loaded this election for this address yet',
    unavailable: 'Unavailable for this address right now',
  }[status] ?? status;
}
