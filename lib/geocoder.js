// U.S. Census Geocoder client. Turns an address into districts.
// Docs: https://geocoding.geo.census.gov/geocoder/ (no key required).
// Privacy: the address is sent only to the Census Geocoder, is never logged, and is
// cached in memory only under a SHA-256 hash for a short time.
import { fetchJson, buildUrl } from './http.js';
import { cached, hashKey, HOUR } from './cache.js';
import { isFixtureMode } from './config.js';
import { loadFixture } from './files.js';
import { STATE_FIPS, normalizeDistrict, nyJudicialDistrict } from './districts.js';

export const GEOCODER_URL = 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress';
export const GEOCODER_SOURCE = {
  id: 'census-geocoder',
  label: 'U.S. Census Bureau Geocoder',
  url: 'https://geocoding.geo.census.gov/geocoder/',
};

/** Layer keys change with each vintage ("119th Congressional Districts", "2024 State Legislative..."), so match by suffix. */
const LAYERS = {
  congressional: /Congressional Districts$/i,
  upper: /State Legislative Districts - Upper$/i,
  lower: /State Legislative Districts - Lower$/i,
  county: /^Counties$/i,
  state: /^States$/i,
  place: /^Incorporated Places$/i,
  countySub: /^County Subdivisions$/i,
};

function findLayer(geographies, re) {
  const key = Object.keys(geographies ?? {}).find((k) => re.test(k.trim()));
  if (!key) return null;
  const items = geographies[key];
  const item = Array.isArray(items) ? items[0] : items;
  return item ? { key, item } : null;
}

function cdNumber(item) {
  if (!item) return null;
  const cdKey = Object.keys(item).filter((k) => /^CD\d{3}$/.test(k) && item[k] !== undefined && item[k] !== null && item[k] !== '').sort().pop();
  const raw = cdKey ? item[cdKey] : item.BASENAME;
  if (raw === '00' || raw === '98' || /at large/i.test(String(item.BASENAME ?? ''))) return '0';
  return normalizeDistrict(raw);
}

export function normalizeAddressInput(address) {
  return String(address ?? '').replace(/\s+/g, ' ').trim();
}

/** Parse a Census "geographies/onelineaddress" JSON response. */
export function parseGeocoderResponse(json) {
  const match = json?.result?.addressMatches?.[0];
  if (!match) return { matched: false };
  const g = match.geographies ?? {};
  const st = findLayer(g, LAYERS.state)?.item;
  const cd = findLayer(g, LAYERS.congressional);
  const up = findLayer(g, LAYERS.upper);
  const lo = findLayer(g, LAYERS.lower);
  const co = findLayer(g, LAYERS.county)?.item;
  const pl = findLayer(g, LAYERS.place)?.item;
  const cs = findLayer(g, LAYERS.countySub)?.item;

  const fips = st?.STATE ?? cd?.item?.STATE ?? co?.STATE ?? null;
  const abbr = st?.STUSAB ?? STATE_FIPS[fips] ?? match.addressComponents?.state ?? null;
  const county = co ? { name: co.NAME ?? null, basename: co.BASENAME ?? null, fips: co.COUNTY ?? null, geoid: co.GEOID ?? null } : null;

  return {
    matched: true,
    matchedAddress: match.matchedAddress ?? null,
    coordinates: match.coordinates ? { lat: Number(match.coordinates.y), lng: Number(match.coordinates.x) } : null,
    state: { abbr, fips, name: st?.NAME ?? st?.BASENAME ?? abbr },
    congressional: cd ? { district: cdNumber(cd.item), name: cd.item.NAME ?? null, geoid: cd.item.GEOID ?? null, layer: cd.key } : null,
    stateSenate: up ? { district: normalizeDistrict(up.item.SLDU ?? up.item.BASENAME), name: up.item.NAME ?? null, geoid: up.item.GEOID ?? null, layer: up.key } : null,
    stateAssembly: lo ? { district: normalizeDistrict(lo.item.SLDL ?? lo.item.BASENAME), name: lo.item.NAME ?? null, geoid: lo.item.GEOID ?? null, layer: lo.key } : null,
    county,
    place: pl ? { name: pl.NAME ?? null, basename: pl.BASENAME ?? null, geoid: pl.GEOID ?? null } : null,
    // The layer came back (possibly empty): an address with no incorporated place isn't in a city or village.
    placeChecked: Object.keys(g).some((k) => LAYERS.place.test(k.trim())),
    countySubdivision: cs ? { name: cs.NAME ?? null, geoid: cs.GEOID ?? null } : null,
    judicialDistrict: abbr === 'NY' && county ? nyJudicialDistrict(county.basename ?? county.name) : null,
    benchmark: json?.result?.input?.benchmark?.benchmarkName ?? null,
    vintage: json?.result?.input?.vintage?.vintageName ?? null,
  };
}

export async function geocodeAddress(address) {
  const clean = normalizeAddressInput(address);
  if (isFixtureMode()) {
    const fx = loadFixture('geocoder-350-5th-ave');
    return { ...parseGeocoderResponse(fx), fetchedAt: fx?._fixtureFetchedAt ?? null };
  }
  return cached(`geo:${hashKey(clean.toLowerCase())}`, 6 * HOUR, async () => {
    const url = buildUrl(GEOCODER_URL, {
      address: clean,
      benchmark: 'Public_AR_Current',
      vintage: 'Current_Current',
      layers: 'all',
      format: 'json',
    });
    const json = await fetchJson(url, { timeoutMs: 12000, retries: 2, label: 'Census Geocoder' });
    return { ...parseGeocoderResponse(json), fetchedAt: new Date().toISOString() };
  });
}
