import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGeocoderResponse } from '../lib/geocoder.js';
import { loadFixture } from '../lib/files.js';
import { normalizeDistrict, nyJudicialDistrict, parseOcdId } from '../lib/districts.js';

// Real Census Geocoder response for 350 5th Ave, New York, NY 10118 (verified 2026-10-13).
const sample = loadFixture('geocoder-350-5th-ave');

test('parses the verified Census sample into districts', () => {
  const g = parseGeocoderResponse(sample);
  assert.equal(g.matched, true);
  assert.equal(g.matchedAddress, '350 5TH AVE, NEW YORK, NY, 10118');
  assert.deepEqual(g.state, { abbr: 'NY', fips: '36', name: 'New York' });
  assert.equal(g.congressional.district, '12');
  assert.equal(g.congressional.name, 'Congressional District 12');
  assert.equal(g.congressional.geoid, '3612');
  assert.equal(g.stateSenate.district, '28');
  assert.equal(g.stateSenate.name, 'State Senate District 28');
  assert.equal(g.stateAssembly.district, '75');
  assert.equal(g.stateAssembly.name, 'Assembly District 75');
  assert.equal(g.county.name, 'New York County');
  assert.equal(g.county.fips, '061');
  assert.equal(g.place.name, 'New York city');
  assert.equal(g.judicialDistrict, '1');
  assert.ok(Math.abs(g.coordinates.lat - 40.7478486) < 1e-6);
  assert.ok(Math.abs(g.coordinates.lng + 73.9850771) < 1e-6);
});

test('matches layer keys by suffix so future vintages still work', () => {
  const g0 = sample.result.addressMatches[0].geographies;
  const renamed = {
    '120th Congressional Districts': [{ ...g0['119th Congressional Districts'][0], CD119: undefined, CD120: '07', BASENAME: '7' }],
    '2026 State Legislative Districts - Upper': [{ ...g0['2024 State Legislative Districts - Upper'][0], SLDU: '005' }],
    '2026 State Legislative Districts - Lower': [{ ...g0['2024 State Legislative Districts - Lower'][0], SLDL: '101' }],
    Counties: g0.Counties,
    States: g0.States,
  };
  const g = parseGeocoderResponse({ result: { addressMatches: [{ ...sample.result.addressMatches[0], geographies: renamed }] } });
  assert.equal(g.congressional.district, '7');
  assert.equal(g.stateSenate.district, '5');
  assert.equal(g.stateAssembly.district, '101');
});

test('at-large congressional districts normalize to "0"', () => {
  const g = parseGeocoderResponse({ result: { addressMatches: [{ matchedAddress: 'X', coordinates: { x: 0, y: 0 }, geographies: {
    States: [{ STATE: '56', STUSAB: 'WY', NAME: 'Wyoming' }],
    '119th Congressional Districts': [{ STATE: '56', CD119: '00', BASENAME: 'At Large', NAME: 'Congressional District (at Large)' }],
  } }] } });
  assert.equal(g.state.abbr, 'WY');
  assert.equal(g.congressional.district, '0');
  assert.equal(g.stateSenate, null);
  assert.equal(g.judicialDistrict, null);
});

test('no match returns matched:false', () => {
  assert.deepEqual(parseGeocoderResponse({ result: { addressMatches: [] } }), { matched: false });
  assert.deepEqual(parseGeocoderResponse(null), { matched: false });
});

test('falls back to FIPS when the States layer is missing', () => {
  const g = parseGeocoderResponse({ result: { addressMatches: [{ geographies: { Counties: [{ STATE: '36', NAME: 'Kings County', BASENAME: 'Kings', COUNTY: '047' }] } }] } });
  assert.equal(g.state.abbr, 'NY');
  assert.equal(g.judicialDistrict, '2');
});

test('district helpers', () => {
  assert.equal(normalizeDistrict('028'), '28');
  assert.equal(normalizeDistrict('00'), '0');
  assert.equal(normalizeDistrict('CHI-1'), 'CHI-1');
  assert.equal(normalizeDistrict(null), null);
  assert.equal(nyJudicialDistrict('St. Lawrence County'), '4');
  assert.equal(nyJudicialDistrict('Queens'), '11');
  assert.equal(nyJudicialDistrict('Nowhere'), null);
  assert.deepEqual(parseOcdId('ocd-division/country:us/state:ny/cd:12'), { country: 'us', state: 'ny', cd: '12' });
});
