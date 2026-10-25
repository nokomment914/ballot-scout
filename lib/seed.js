// Seed ballot files: researched lists of contests and candidates with source links.
// /data/ballots/<state>-<year>-general.json (schemaVersion 1). In fixture mode the
// fictional /fixtures/ballot-seed.json is used instead, so real names never mix with sample records.
import { isFixtureMode, electionDate } from './config.js';
import { readData, loadFixture, listDataDir } from './files.js';
import { validateSeed } from './validate.js';
import { normalizeDistrict, normalizeCounty, normalizePlace, censusNameKey, parseCountyDistrict, NYC_COUNTIES } from './districts.js';

export function isPlaceholderSeed(seed) {
  if (!seed) return false;
  if (seed.placeholder === true) return true;
  const names = (seed.contests ?? []).flatMap((c) => (c.candidates ?? []).map((p) => p.name ?? ''));
  return names.length > 0 && names.every((n) => /^Sample (Candidate|Running Mate)\b/i.test(n));
}

/** Find the seed for a state and the configured election date. */
export function loadSeed(state) {
  const st = String(state ?? '').toLowerCase();
  if (!st) return null;
  if (isFixtureMode()) {
    const seed = loadFixture('ballot-seed');
    if (!seed || String(seed.state ?? 'ny').toLowerCase() !== st) return null;
    return { seed, file: 'fixtures/ballot-seed.json', validation: validateSeed(seed), placeholder: true };
  }
  const year = electionDate().slice(0, 4);
  const files = listDataDir('ballots').filter((f) => f.endsWith('.json') && f.toLowerCase().startsWith(`${st}-`));
  const preferred = files.find((f) => f.toLowerCase() === `${st}-${year}-general.json`) ?? files.find((f) => f.includes(year));
  if (!preferred) return null;
  const seed = readData('ballots', preferred);
  if (!seed || (seed.election?.date && seed.election.date !== electionDate())) return null;
  const validation = validateSeed(seed);
  return { seed, file: `data/ballots/${preferred}`, validation, placeholder: isPlaceholderSeed(seed) };
}

function sameCounty(name, d) {
  const c = normalizeCounty(name);
  return Boolean(c) && (c === normalizeCounty(d.county) || c === normalizeCounty(d.countyBasename));
}

/**
 * Decide whether a seed contest is on this voter's ballot.
 * Returns 'yes', 'no', or 'maybe' (district text we can't evaluate from the address, e.g. a
 * NYC Civil Court municipal district that mentions the voter's county, or a county legislative
 * district, which the Census lookup doesn't return).
 */
export function contestApplies(contest, d) {
  const want = normalizeDistrict(contest.district);
  switch (contest.districtType) {
    case 'county-legislative': {
      const { county, number } = parseCountyDistrict(contest.district);
      if (!sameCounty(county ?? contest.county, d)) return 'no';
      if (d.countyLegislative === null || d.countyLegislative === undefined) return 'maybe';
      return normalizeDistrict(d.countyLegislative) === number ? 'yes' : 'no';
    }
    case 'council': {
      // City council districts (e.g. NYC) aren't in the Census lookup; Google Civic can confirm them.
      if (!sameCounty(contest.county, d)) return 'no';
      if (d.council === null || d.council === undefined) return 'maybe';
      return normalizeDistrict(d.council) === want ? 'yes' : 'no';
    }
    case 'town': {
      if (!sameCounty(contest.county, d)) return 'no';
      if (!d.countySubdivision) return 'maybe';
      return censusNameKey(d.countySubdivision) === censusNameKey(contest.district) ? 'yes' : 'no';
    }
    case 'village': {
      if (!sameCounty(contest.county, d)) return 'no';
      if (d.place) return censusNameKey(d.place) === censusNameKey(contest.district) ? 'yes' : 'no';
      // No incorporated place at this address means it isn't in any village.
      if (d.placeChecked) return 'no';
      const towns = (contest.parentTowns ?? []).map(censusNameKey);
      return !d.countySubdivision || towns.includes(censusNameKey(d.countySubdivision)) ? 'maybe' : 'no';
    }
    case 'district-court': {
      if (!sameCounty(contest.county, d)) return 'no';
      if (!d.countySubdivision) return 'maybe';
      return (contest.coverage ?? []).map(censusNameKey).includes(censusNameKey(d.countySubdivision)) ? 'yes' : 'no';
    }
    case 'statewide':
      return 'yes';
    case 'congressional':
      return want !== null && want === d.congressional ? 'yes' : 'no';
    case 'state-senate':
      return want !== null && want === d.stateSenate ? 'yes' : 'no';
    case 'state-assembly':
      return want !== null && want === d.stateAssembly ? 'yes' : 'no';
    case 'judicial-district': {
      if (want !== null && /^\d+$/.test(want)) return want === d.judicialDistrict ? 'yes' : 'no';
      const text = String(contest.district ?? '').toLowerCase();
      const county = normalizeCounty(d.county);
      return county && text.includes(county) ? 'maybe' : 'no';
    }
    case 'county':
      return sameCounty(contest.district, d) ? 'yes' : 'no';
    case 'citywide': {
      const p = normalizePlace(contest.district);
      if (!p) return 'no';
      if (p === 'new york') return NYC_COUNTIES.has(normalizeCounty(d.county)) ? 'yes' : 'no';
      // Other cities: the incorporated place must be a city ("Yonkers city"), never a village or town of the same name.
      if (contest.county && !sameCounty(contest.county, d)) return 'no';
      return d.place && /\scity$/i.test(String(d.place).trim()) && p === normalizePlace(d.place) ? 'yes' : 'no';
    }
    default:
      return 'no';
  }
}

/** Flatten geocoder output into the comparison shape used by contestApplies(). */
export function districtKeys(geo) {
  return {
    state: geo?.state?.abbr ?? null,
    congressional: geo?.congressional?.district ?? null,
    stateSenate: geo?.stateSenate?.district ?? null,
    stateAssembly: geo?.stateAssembly?.district ?? null,
    county: geo?.county?.name ?? null,
    countyBasename: geo?.county?.basename ?? null,
    place: geo?.place?.name ?? null,
    placeChecked: Boolean(geo?.placeChecked),
    countySubdivision: geo?.countySubdivision?.name ?? null,
    // The Census lookup has no county legislative districts; the voter can pick one.
    countyLegislative: geo?.countyLegislative ?? null,
    council: geo?.council ?? null,
    judicialDistrict: geo?.judicialDistrict ?? null,
  };
}

/** Ballot proposals use the same district rules; a proposal with no districtType is statewide. */
export function proposalApplies(proposal, d) {
  if (!proposal?.districtType || proposal.districtType === 'statewide') return true;
  return contestApplies(proposal, d) === 'yes';
}

export function matchSeedContests(seed, geo) {
  const d = districtKeys(geo);
  const matched = [];
  const possible = [];
  (seed?.contests ?? []).forEach((c, index) => {
    const verdict = contestApplies(c, d);
    const withIndex = { ...c, district: c.districtType === 'statewide' ? null : normalizeDistrict(c.district), seedIndex: index, origin: 'seed' };
    if (verdict === 'yes') matched.push(withIndex);
    else if (verdict === 'maybe') possible.push(withIndex);
  });
  return { matched, possible };
}
