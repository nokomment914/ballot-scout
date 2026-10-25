// Validation for seed ballot files (/data/ballots/*.json), schemaVersion 1.

export const LEVELS = ['state', 'federal', 'local', 'judicial'];
export const DISTRICT_TYPES = ['statewide', 'congressional', 'state-senate', 'state-assembly', 'judicial-district', 'county', 'citywide', 'county-legislative', 'council', 'town', 'village', 'district-court'];
/** District types below the county: the contest must name its county so it is never matched in another county. */
export const LOCAL_DISTRICT_TYPES = ['county-legislative', 'council', 'town', 'village', 'district-court'];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isUrl = (u) => typeof u === 'string' && /^https?:\/\/\S+$/.test(u);

function checkSources(list, where, errors, warnings, { required = false } = {}) {
  if (list === undefined || list === null) {
    if (required) warnings.push(`${where}: no sources listed`);
    return;
  }
  if (!Array.isArray(list)) {
    errors.push(`${where}.sources must be an array`);
    return;
  }
  list.forEach((s, i) => {
    if (!s || typeof s !== 'object') errors.push(`${where}.sources[${i}] must be an object`);
    else if (!isUrl(s.url)) errors.push(`${where}.sources[${i}].url must be an http(s) URL`);
  });
}

/** Returns { ok, errors, warnings, stats }. Unknown extra fields are allowed. */
export function validateSeed(seed) {
  const errors = [];
  const warnings = [];
  if (!seed || typeof seed !== 'object') return { ok: false, errors: ['seed must be a JSON object'], warnings, stats: {} };
  if (seed.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (seed.generatedAt && Number.isNaN(Date.parse(seed.generatedAt))) errors.push('generatedAt must be an ISO date-time');

  const e = seed.election;
  if (!e || typeof e !== 'object') errors.push('election is required');
  else {
    if (!e.id) errors.push('election.id is required');
    if (!e.name) errors.push('election.name is required');
    if (!DATE_RE.test(e.date ?? '')) errors.push('election.date must be YYYY-MM-DD');
    for (const k of ['registrationDeadline', 'absenteeApplicationDeadline']) {
      if (e[k] !== null && e[k] !== undefined && !DATE_RE.test(e[k])) errors.push(`election.${k} must be YYYY-MM-DD or null`);
    }
    if (e.earlyVoting && typeof e.earlyVoting === 'object') {
      for (const k of ['start', 'end']) {
        const v = e.earlyVoting[k];
        if (v !== null && v !== undefined && !DATE_RE.test(v)) errors.push(`election.earlyVoting.${k} must be YYYY-MM-DD or null`);
      }
    }
    if (e.officialLinks !== undefined) {
      if (!Array.isArray(e.officialLinks)) errors.push('election.officialLinks must be an array');
      else e.officialLinks.forEach((l, i) => { if (!isUrl(l?.url)) errors.push(`election.officialLinks[${i}].url must be an http(s) URL`); });
    }
    checkSources(e.sources, 'election', errors, warnings, { required: true });
  }

  let candidateCount = 0;
  const ids = new Set();
  if (!Array.isArray(seed.contests)) errors.push('contests must be an array');
  else seed.contests.forEach((c, i) => {
    const where = `contests[${i}]${c?.id ? ` (${c.id})` : ''}`;
    if (!c || typeof c !== 'object') { errors.push(`${where} must be an object`); return; }
    if (!c.id) errors.push(`${where}.id is required`);
    else if (ids.has(c.id)) errors.push(`${where}.id is duplicated`);
    else ids.add(c.id);
    if (!c.office) errors.push(`${where}.office is required`);
    if (!LEVELS.includes(c.level)) errors.push(`${where}.level must be one of ${LEVELS.join('|')}`);
    if (!DISTRICT_TYPES.includes(c.districtType)) errors.push(`${where}.districtType must be one of ${DISTRICT_TYPES.join('|')}`);
    if (c.districtType === 'statewide') {
      if (c.district !== null && c.district !== undefined) warnings.push(`${where}: statewide contests should have district null`);
    } else if (c.district === null || c.district === undefined || c.district === '') {
      errors.push(`${where}.district is required for districtType ${c.districtType}`);
    } else if (/^0\d+$/.test(String(c.district))) {
      warnings.push(`${where}.district "${c.district}" has a leading zero (it will be normalized)`);
    }
    if (LOCAL_DISTRICT_TYPES.includes(c.districtType) && (typeof c.county !== 'string' || !c.county.trim())) errors.push(`${where}.county is required for districtType ${c.districtType}`);
    if (c.districtType === 'county-legislative' && !/^[^|]+\|\d+$/.test(String(c.district ?? ''))) errors.push(`${where}.district must look like "<County>|<number>" for county-legislative contests`);
    if (c.districtType === 'council' && !/^\d+$/.test(String(c.district ?? ''))) errors.push(`${where}.district must be the council district number for council contests`);
    if (c.districtType === 'district-court' && !(Array.isArray(c.coverage) && c.coverage.length && c.coverage.every((t) => typeof t === 'string' && t.trim()))) errors.push(`${where}.coverage must list the towns and cities the court district covers`);
    if (c.districtType === 'village' && c.parentTowns !== undefined && !Array.isArray(c.parentTowns)) errors.push(`${where}.parentTowns must be an array`);
    if (c.term !== undefined && (typeof c.term !== 'object' || c.term === null || (c.term.expires !== undefined && !Number.isInteger(c.term.expires)))) errors.push(`${where}.term must be an object with an integer "expires" year`);
    if (c.seats !== undefined && !(Number.isInteger(c.seats) && c.seats >= 1)) errors.push(`${where}.seats must be a positive integer`);
    if (!Array.isArray(c.candidates)) errors.push(`${where}.candidates must be an array`);
    else c.candidates.forEach((p, j) => {
      const w = `${where}.candidates[${j}]`;
      candidateCount += 1;
      if (!p || typeof p !== 'object') { errors.push(`${w} must be an object`); return; }
      if (!p.name || typeof p.name !== 'string') errors.push(`${w}.name is required`);
      if (!Array.isArray(p.partyLines)) errors.push(`${w}.partyLines must be an array (use [] for none)`);
      if (p.incumbent !== undefined && p.incumbent !== null && typeof p.incumbent !== 'boolean') errors.push(`${w}.incumbent must be true, false or null`);
      if (p.incumbent === null && c.level !== 'judicial') warnings.push(`${w}.incumbent is null (unknown)`);
      if (p.ids !== undefined && (typeof p.ids !== 'object' || Array.isArray(p.ids) || p.ids === null)) errors.push(`${w}.ids must be an object`);
      if (p.ids?.bioguide && !/^[A-Z]\d{6}$/.test(p.ids.bioguide)) warnings.push(`${w}.ids.bioguide "${p.ids.bioguide}" doesn't look like a Bioguide id`);
      if (p.ids?.nysenate && !/^\d+$/.test(String(p.ids.nysenate)) && !/^[a-z0-9-]+$/.test(String(p.ids.nysenate))) warnings.push(`${w}.ids.nysenate "${p.ids.nysenate}" is neither an Open Legislation member id nor a nysenate.gov slug`);
      if (p.ids?.fec) {
        const list = Array.isArray(p.ids.fec) ? p.ids.fec : [p.ids.fec];
        list.forEach((f) => { if (!/^[HSP]\d[A-Z0-9]{2}\d{5}$/.test(String(f))) warnings.push(`${w}.ids.fec "${f}" doesn't look like an FEC candidate id`); });
      }
      if (p.website !== null && p.website !== undefined && !isUrl(p.website)) errors.push(`${w}.website must be an http(s) URL or null`);
      if (p.alsoListedAs !== undefined) {
        if (!Array.isArray(p.alsoListedAs)) errors.push(`${w}.alsoListedAs must be an array`);
        else p.alsoListedAs.forEach((a, k) => {
          if (!a?.name || !a?.by) errors.push(`${w}.alsoListedAs[${k}] needs a name and who lists it ("by")`);
          if (a?.source && !isUrl(a.source.url)) errors.push(`${w}.alsoListedAs[${k}].source.url must be an http(s) URL`);
        });
      }
      checkSources(p.sources, w, errors, warnings);
    });
    checkSources(c.sources, where, errors, warnings, { required: true });
  });

  if (seed.ballotProposals !== undefined) {
    if (!Array.isArray(seed.ballotProposals)) errors.push('ballotProposals must be an array');
    else seed.ballotProposals.forEach((b, i) => {
      if (!b?.id) errors.push(`ballotProposals[${i}].id is required`);
      if (!b?.title) errors.push(`ballotProposals[${i}].title is required`);
      if (b?.districtType !== undefined && !DISTRICT_TYPES.includes(b.districtType)) errors.push(`ballotProposals[${i}].districtType must be one of ${DISTRICT_TYPES.join('|')}`);
      checkSources(b?.sources, `ballotProposals[${i}]`, errors, warnings, { required: true });
    });
  }
  if (seed.localBoards !== undefined) {
    if (!Array.isArray(seed.localBoards)) errors.push('localBoards must be an array');
    else seed.localBoards.forEach((b, i) => {
      const where = `localBoards[${i}]`;
      if (!b?.id || !b?.name) errors.push(`${where} needs an id and a name`);
      if (!Array.isArray(b?.counties) || !b.counties.length) errors.push(`${where}.counties must list at least one county`);
      if (!isUrl(b?.url)) errors.push(`${where}.url must be an http(s) URL`);
      (b?.links ?? []).forEach((l, k) => { if (!isUrl(l?.url)) errors.push(`${where}.links[${k}].url must be an http(s) URL`); });
      checkSources(b?.sources, where, errors, warnings, { required: true });
    });
  }
  if (seed.coverage !== undefined && (typeof seed.coverage !== 'object' || seed.coverage === null)) errors.push('coverage must be an object');

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: { contests: Array.isArray(seed.contests) ? seed.contests.length : 0, candidates: candidateCount, proposals: Array.isArray(seed.ballotProposals) ? seed.ballotProposals.length : 0 },
  };
}
