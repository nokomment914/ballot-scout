import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contestApplies, matchSeedContests, districtKeys, isPlaceholderSeed, loadSeed, proposalApplies } from '../lib/seed.js';
import { validateSeed } from '../lib/validate.js';
import { parseGeocoderResponse } from '../lib/geocoder.js';
import { loadFixture, readData } from '../lib/files.js';

const geo = parseGeocoderResponse(loadFixture('geocoder-350-5th-ave'));
const d = districtKeys(geo);

test('districtKeys flattens the geocoder output', () => {
  assert.deepEqual(d, { state: 'NY', congressional: '12', stateSenate: '28', stateAssembly: '75', county: 'New York County', countyBasename: 'New York', place: 'New York city', placeChecked: true, countySubdivision: 'Manhattan borough', countyLegislative: null, council: null, judicialDistrict: '1' });
});

test('contestApplies by district type and number', () => {
  assert.equal(contestApplies({ districtType: 'statewide', district: null }, d), 'yes');
  assert.equal(contestApplies({ districtType: 'congressional', district: '12' }, d), 'yes');
  assert.equal(contestApplies({ districtType: 'congressional', district: '10' }, d), 'no');
  assert.equal(contestApplies({ districtType: 'state-senate', district: '028' }, d), 'yes', 'leading zeros are normalized');
  assert.equal(contestApplies({ districtType: 'state-senate', district: '27' }, d), 'no');
  assert.equal(contestApplies({ districtType: 'state-assembly', district: '75' }, d), 'yes');
  assert.equal(contestApplies({ districtType: 'state-assembly', district: '74' }, d), 'no');
  assert.equal(contestApplies({ districtType: 'judicial-district', district: '1' }, d), 'yes');
  assert.equal(contestApplies({ districtType: 'judicial-district', district: '2' }, d), 'no');
  assert.equal(contestApplies({ districtType: 'judicial-district', district: 'New York County, 3rd Municipal Court District' }, d), 'maybe');
  assert.equal(contestApplies({ districtType: 'judicial-district', district: 'Kings County, 1st Municipal Court District' }, d), 'no');
  assert.equal(contestApplies({ districtType: 'county', district: 'New York' }, d), 'yes');
  assert.equal(contestApplies({ districtType: 'county', district: 'New York County' }, d), 'yes');
  assert.equal(contestApplies({ districtType: 'county', district: 'Kings' }, d), 'no');
  assert.equal(contestApplies({ districtType: 'citywide', district: 'New York City' }, d), 'yes');
  assert.equal(contestApplies({ districtType: 'citywide', district: 'Buffalo' }, d), 'no');
  assert.equal(contestApplies({ districtType: 'congressional', district: null }, d), 'no');
});

test('matchSeedContests on the fixture seed', () => {
  const seed = loadFixture('ballot-seed');
  const { matched, possible } = matchSeedContests(seed, geo);
  assert.deepEqual(matched.map((c) => c.id), ['fx-governor', 'fx-comptroller', 'fx-attorney-general', 'fx-cd-12', 'fx-sd-28', 'fx-ad-75', 'fx-supreme-1']);
  assert.deepEqual(possible.map((c) => c.id), ['fx-civil-court']);
  assert.equal(matched.find((c) => c.id === 'fx-ad-75').district, '75');
  assert.equal(matched.find((c) => c.id === 'fx-governor').district, null);
});

test('a voter in another district gets a different set', () => {
  const seed = loadFixture('ballot-seed');
  const other = { ...geo, congressional: { district: '10' }, stateSenate: { district: '27' }, stateAssembly: { district: '65' } };
  const ids = matchSeedContests(seed, other).matched.map((c) => c.id);
  assert.ok(ids.includes('fx-cd-10'));
  assert.ok(!ids.includes('fx-cd-12'));
  assert.ok(!ids.includes('fx-sd-28'));
  assert.ok(ids.includes('fx-governor'));
});

test('fixture seed and the installed seed both validate', () => {
  const fx = validateSeed(loadFixture('ballot-seed'));
  assert.equal(fx.ok, true, fx.errors.join('\n'));
  const placeholder = readData('ballots', 'ny-2026-general.json');
  const r = validateSeed(placeholder);
  assert.equal(r.ok, true, r.errors.join('\n'));
});

test('validateSeed reports schema problems', () => {
  const bad = {
    schemaVersion: 2,
    election: { id: 'x', name: 'X', date: '11/03/2026', officialLinks: [{ label: 'a', url: 'ftp://nope' }] },
    contests: [
      { id: 'a', office: 'Gov', level: 'state', districtType: 'statewide', district: null, candidates: [{ name: 'A', partyLines: 'Dem', incumbent: 'yes' }], sources: [] },
      { id: 'a', office: 'Rep', level: 'federal', districtType: 'congressional', district: null, candidates: [{ partyLines: [] }] },
      { id: 'c', office: 'X', level: 'galactic', districtType: 'planet', candidates: [] },
    ],
  };
  const r = validateSeed(bad);
  assert.equal(r.ok, false);
  const text = r.errors.join('\n');
  assert.ok(text.includes('incumbent must be true, false or null'));
  for (const needle of ['schemaVersion', 'election.date', 'officialLinks[0].url', 'partyLines must be an array', 'id is duplicated', 'district is required', 'candidates[0].name is required', 'level must be', 'districtType must be']) {
    assert.ok(text.includes(needle), `expected error mentioning ${needle}\n${text}`);
  }
});

test('incumbent null is allowed (unknown), with a warning outside judicial races', () => {
  const src = [{ label: 's', url: 'https://example.org' }];
  const seed = {
    schemaVersion: 1,
    election: { id: 'e', name: 'E', date: '2026-11-03', sources: src },
    contests: [
      { id: 'j', office: 'Justice of the Supreme Court', level: 'judicial', districtType: 'judicial-district', district: '1', sources: src, candidates: [{ name: 'Judge One', partyLines: [], incumbent: null }] },
      { id: 's', office: 'State Senator', level: 'state', districtType: 'state-senate', district: '28', sources: src, candidates: [{ name: 'Sen One', partyLines: [], incumbent: null, ids: { nysenate: 'sen-one' } }] },
    ],
  };
  const r = validateSeed(seed);
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.equal(r.warnings.filter((w) => w.includes('incumbent is null')).length, 1);
});

test('placeholder detection', () => {
  assert.equal(isPlaceholderSeed({ placeholder: true, contests: [] }), true);
  assert.equal(isPlaceholderSeed({ contests: [{ candidates: [{ name: 'Sample Candidate A' }, { name: 'Sample Running Mate B' }] }] }), true);
  assert.equal(isPlaceholderSeed({ contests: [{ candidates: [{ name: 'Sample Candidate A' }, { name: 'Real Person' }] }] }), false);
});

test('loadSeed uses the fictional fixture in sample mode', () => {
  const prev = process.env.FIXTURES;
  process.env.FIXTURES = '1';
  try {
    const s = loadSeed('NY');
    assert.equal(s.file, 'fixtures/ballot-seed.json');
    assert.equal(s.placeholder, true);
    assert.equal(loadSeed('CA'), null);
  } finally {
    if (prev === undefined) delete process.env.FIXTURES; else process.env.FIXTURES = prev;
  }
});

test('Civic and seed listings of the same contest are recognized despite different office names', async () => {
  const { sameContestByCandidates } = await import('../lib/ballot.js');
  const seed = { districtType: 'judicial-district', district: '1', candidates: [{ name: 'Pat A. Jones' }, { name: 'Lee Smith' }, { name: 'Ann Lee' }] };
  const civic = { districtType: 'judicial-district', district: '1', candidates: [{ name: 'Pat Jones' }, { name: 'Lee Smith' }] };
  assert.equal(sameContestByCandidates(seed, civic), true);
  assert.equal(sameContestByCandidates({ ...seed, candidates: [{ name: 'Pat A. Jones' }, { name: 'Ann Lee' }] }, { ...civic, candidates: [{ name: 'Pat Jones' }, { name: 'Ann B. Lee' }] }), true, 'middle initials ignored');
  assert.equal(sameContestByCandidates(seed, { ...civic, district: '2' }), false);
  assert.equal(sameContestByCandidates(seed, { districtType: 'judicial-district', district: '1', candidates: [{ name: 'Someone Else' }, { name: 'Lee Smith' }, { name: 'X Y' }, { name: 'Z W' }] }), false);
});

// ---------- county, town, village and court districts outside New York City ----------
const westchester = { state: 'NY', county: 'Westchester County', countyBasename: 'Westchester', countySubdivision: 'Greenburgh town', place: 'Ardsley village', placeChecked: true, countyLegislative: null, judicialDistrict: '9' };

test('county legislative districts are possible until the voter picks one', () => {
  const c = { districtType: 'county-legislative', district: 'Westchester|8', county: 'Westchester' };
  assert.equal(contestApplies(c, westchester), 'maybe');
  assert.equal(contestApplies(c, { ...westchester, countyLegislative: '8' }), 'yes');
  assert.equal(contestApplies(c, { ...westchester, countyLegislative: '08' }), 'yes', 'leading zeros are normalized');
  assert.equal(contestApplies(c, { ...westchester, countyLegislative: '9' }), 'no');
  assert.equal(contestApplies(c, { ...westchester, county: 'Nassau County', countyBasename: 'Nassau' }), 'no', 'another county never matches');
});

test('towns match the full Census name, so Rye town is not Rye city', () => {
  const town = { districtType: 'town', district: 'Rye town', county: 'Westchester' };
  assert.equal(contestApplies(town, { ...westchester, countySubdivision: 'Rye town' }), 'yes');
  assert.equal(contestApplies(town, { ...westchester, countySubdivision: 'Rye city' }), 'no');
  assert.equal(contestApplies(town, { ...westchester, countySubdivision: null }), 'maybe');
  assert.equal(contestApplies({ ...town, county: 'Nassau' }, { ...westchester, countySubdivision: 'Rye town' }), 'no');
});

test('villages match the incorporated place, and an address outside any place is not in a village', () => {
  const v = { districtType: 'village', district: 'Ardsley village', county: 'Westchester', parentTowns: ['Greenburgh town'] };
  assert.equal(contestApplies(v, westchester), 'yes');
  assert.equal(contestApplies(v, { ...westchester, place: 'Dobbs Ferry village' }), 'no');
  assert.equal(contestApplies(v, { ...westchester, place: null, placeChecked: true }), 'no');
  assert.equal(contestApplies(v, { ...westchester, place: null, placeChecked: false }), 'maybe', 'place layer missing: only a possible match');
  assert.equal(contestApplies(v, { ...westchester, place: null, placeChecked: false, countySubdivision: 'Bedford town' }), 'no', 'outside the village’s towns');
});

test('District Court districts follow their towns and cities', () => {
  const dc = { districtType: 'district-court', district: 'Nassau|2', county: 'Nassau', coverage: ['Hempstead town', 'Long Beach city'] };
  const nassau = { county: 'Nassau County', countyBasename: 'Nassau', countySubdivision: 'Hempstead town' };
  assert.equal(contestApplies(dc, nassau), 'yes');
  assert.equal(contestApplies(dc, { ...nassau, countySubdivision: 'Long Beach city' }), 'yes');
  assert.equal(contestApplies(dc, { ...nassau, countySubdivision: 'Oyster Bay town' }), 'no');
  assert.equal(contestApplies(dc, { ...nassau, countySubdivision: null }), 'maybe');
  assert.equal(contestApplies(dc, { ...westchester }), 'no');
});

test('city contests outside NYC need the city itself, not a same-named village', () => {
  const rye = { districtType: 'citywide', district: 'Rye', county: 'Westchester' };
  assert.equal(contestApplies(rye, { ...westchester, place: 'Rye city' }), 'yes');
  assert.equal(contestApplies(rye, { ...westchester, place: 'Rye Brook village' }), 'no');
  assert.equal(contestApplies(rye, { ...westchester, place: null }), 'no');
  assert.equal(contestApplies({ districtType: 'citywide', district: 'New York' }, westchester), 'no', 'NYC contests stay in the five boroughs');
  assert.equal(contestApplies({ districtType: 'citywide', district: 'New York' }, d), 'yes');
});

test('ballot proposals follow their district; NYC Charter proposals stay in NYC', () => {
  const nyc = { id: 'p', title: 'T', districtType: 'citywide', district: 'New York' };
  assert.equal(proposalApplies(nyc, d), true);
  assert.equal(proposalApplies(nyc, westchester), false);
  assert.equal(proposalApplies({ id: 's', title: 'Statewide' }, westchester), true, 'no districtType means statewide');
});

test('the installed seed covers NYC, Westchester, Nassau and Suffolk', () => {
  const seed = readData('ballots', 'ny-2026-general.json');
  const ids = new Set(seed.contests.map((c) => c.id));
  for (const id of ['us-house-ny-1', 'us-house-ny-4', 'us-house-ny-17', 'ny-senate-1', 'ny-senate-40', 'ny-assembly-1', 'ny-assembly-95', 'ny-supreme-court-jd-9', 'ny-supreme-court-jd-10', 'westchester-county-legislator-17', 'nassau-county-legislator-19', 'suffolk-county-comptroller']) assert.ok(ids.has(id), id);
  assert.ok(!seed.contests.some((c) => /^suffolk-county-legislator/.test(c.id)), 'the Suffolk County Legislature is not on the 2026 ballot');
  for (const c of seed.contests.filter((x) => ['county-legislative', 'town', 'village', 'district-court'].includes(x.districtType))) assert.ok(c.county, `${c.id} names its county`);
  // Every NYC Charter proposal is scoped to the city; local proposals elsewhere name their village and county.
  assert.ok(seed.ballotProposals.filter((p) => p.id.startsWith('nyc-')).every((p) => p.districtType === 'citywide' && p.district === 'New York'));
  assert.ok(seed.ballotProposals.filter((p) => !p.id.startsWith('nyc-')).every((p) => p.districtType === 'village' && p.county));
  for (const c of seed.contests.filter((x) => x.districtType === 'council')) assert.ok(c.county && /^\d+$/.test(c.district), `${c.id} names its county and district number`);
  // A Supreme Court nominee is never marked as sitting when the others in the race aren't checked.
  for (const c of seed.contests.filter((x) => x.districtType === 'judicial-district')) for (const p of c.candidates) { assert.equal(p.currentOffice ?? null, null, p.name); assert.equal(p.incumbent ?? null, null, p.name); }
  const boards = Object.fromEntries(seed.localBoards.map((b) => [b.id, b]));
  assert.deepEqual(Object.keys(boards).sort(), ['nassau', 'nyc', 'suffolk', 'westchester']);
});

test('a Westchester address gets Westchester races and none from the city', () => {
  const seed = readData('ballots', 'ny-2026-general.json');
  const geoW = {
    state: { abbr: 'NY' }, congressional: { district: '16' }, stateSenate: { district: '35' }, stateAssembly: { district: '92' },
    county: { name: 'Westchester County', basename: 'Westchester' }, place: { name: 'Ardsley village' }, placeChecked: true, countySubdivision: { name: 'Greenburgh town' }, judicialDistrict: '9',
  };
  const { matched, possible } = matchSeedContests(seed, geoW);
  const ids = matched.map((c) => c.id);
  for (const id of ['us-house-ny-16', 'ny-senate-35', 'ny-assembly-92', 'ny-supreme-court-jd-9', 'westchester-greenburgh-town-supervisor', 'westchester-ardsley-village-trustee']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.some((id) => id.startsWith('nyc-') || id.startsWith('nassau-') || id.startsWith('suffolk-')));
  assert.equal(possible.filter((c) => c.districtType === 'county-legislative').length, 17, 'all 17 legislative districts are possible until one is picked');
  const picked = matchSeedContests(seed, { ...geoW, countyLegislative: '8' });
  assert.deepEqual(picked.matched.filter((c) => c.districtType === 'county-legislative').map((c) => c.id), ['westchester-county-legislator-8']);
  assert.equal(picked.possible.length, 0);
});

test('city council districts are possible within the county until confirmed', () => {
  const council = { districtType: 'council', district: '3', county: 'New York' };
  assert.equal(contestApplies(council, d), 'maybe', 'Manhattan address, council district unknown');
  assert.equal(contestApplies(council, { ...d, council: '3' }), 'yes');
  assert.equal(contestApplies(council, { ...d, council: '4' }), 'no');
  assert.equal(contestApplies(council, { ...d, county: 'Kings County', countyBasename: 'Kings' }), 'no');
});

test('a Manhattan address gets the county courts and lists the municipal court districts and Council District 3 as possible', async () => {
  const { possibleGroup } = await import('../lib/ballot.js');
  const seed = readData('ballots', 'ny-2026-general.json');
  const { matched, possible } = matchSeedContests(seed, geo);
  const ids = matched.map((c) => c.id);
  for (const id of ['nyc-civil-court-new-york-countywide', 'nyc-surrogate-new-york']) assert.ok(ids.includes(id), id);
  assert.ok(!ids.some((id) => /^nyc-(civil-court|surrogate)-(kings|queens|bronx|richmond)/.test(id)), 'no other county courts');
  const mcd = possible.filter((c) => /^nyc-civil-court-new-york-mcd-/.test(c.id));
  assert.equal(mcd.length, 5);
  const groups = new Set(mcd.map((c) => possibleGroup(c).key));
  assert.deepEqual([...groups], ['civil-court-mcd|New York'], 'one district picker for the county');
  assert.equal(possibleGroup(mcd.find((c) => c.id === 'nyc-civil-court-new-york-mcd-7')).pickLabel, '7th Municipal Court District');
  assert.ok(possible.some((c) => c.id === 'nyc-council-district-3'));
  assert.ok(!possible.some((c) => /^nyc-civil-court-(kings|queens|bronx|richmond)/.test(c.id)));
});

test('the Croton-on-Hudson proposition applies only inside the village', () => {
  const seed = readData('ballots', 'ny-2026-general.json');
  const prop = seed.ballotProposals.find((p) => p.id === 'croton-on-hudson-2026-prop-1');
  assert.ok(prop);
  const croton = { state: 'NY', county: 'Westchester County', countyBasename: 'Westchester', place: 'Croton-on-Hudson village', placeChecked: true, countySubdivision: 'Cortlandt town' };
  assert.equal(proposalApplies(prop, croton), true);
  assert.equal(proposalApplies(prop, { ...croton, place: null }), false, 'rest of the Town of Cortlandt');
  assert.equal(proposalApplies(prop, d), false, 'Manhattan');
});
