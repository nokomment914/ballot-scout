// District normalization and small lookup tables.

export const STATE_FIPS = {
  '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', '10': 'DE', '11': 'DC', '12': 'FL',
  '13': 'GA', '15': 'HI', '16': 'ID', '17': 'IL', '18': 'IN', '19': 'IA', '20': 'KS', '21': 'KY', '22': 'LA', '23': 'ME',
  '24': 'MD', '25': 'MA', '26': 'MI', '27': 'MN', '28': 'MS', '29': 'MO', '30': 'MT', '31': 'NE', '32': 'NV', '33': 'NH',
  '34': 'NJ', '35': 'NM', '36': 'NY', '37': 'NC', '38': 'ND', '39': 'OH', '40': 'OK', '41': 'OR', '42': 'PA', '44': 'RI',
  '45': 'SC', '46': 'SD', '47': 'TN', '48': 'TX', '49': 'UT', '50': 'VT', '51': 'VA', '53': 'WA', '54': 'WV', '55': 'WI',
  '56': 'WY', '60': 'AS', '66': 'GU', '69': 'MP', '72': 'PR', '78': 'VI',
};

/** "028" -> "28", "00" -> "0"; non-numeric district names are kept as-is. */
export function normalizeDistrict(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return String(parseInt(s, 10));
  return s;
}

/** "New York County" -> "new york"; "Kings" -> "kings". */
export function normalizeCounty(name) {
  return String(name ?? '').toLowerCase().replace(/\s+(county|parish|borough|census area|municipality)$/, '').replace(/[^a-z0-9 ]+/g, '').trim();
}

/** "New York city" / "New York City" / "City of New York" -> "new york". */
export function normalizePlace(name) {
  return String(name ?? '').toLowerCase().replace(/^city of /, '').replace(/\s+(city|town|village|borough|cdp)$/, '').replace(/[^a-z0-9 ]+/g, '').trim();
}

export const NYC_COUNTIES = new Set(['new york', 'kings', 'queens', 'bronx', 'richmond']);

/**
 * Census county-subdivision and place names compare in full ("Rye town" and "Rye city" are
 * different places), ignoring case, accents and punctuation spacing.
 */
export function censusNameKey(name) {
  return String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 -]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "Nassau|2" -> { county: 'Nassau', number: '2' }. */
export function parseCountyDistrict(value) {
  const [county, number] = String(value ?? '').split('|');
  return { county: county?.trim() || null, number: number ? normalizeDistrict(number) : null };
}

/** "Greenburgh town" -> "Town of Greenburgh"; "Croton-on-Hudson village" -> "Village of Croton-on-Hudson"; "Yonkers city" -> "City of Yonkers". */
export function municipalityLabel(censusName) {
  const s = String(censusName ?? '').trim();
  const m = /^(.*)\s+(town|village|city)$/i.exec(s);
  if (!m) return s;
  const kind = m[2].toLowerCase();
  return `${kind[0].toUpperCase()}${kind.slice(1)} of ${m[1]}`;
}

function ordinalWord(n) {
  const v = Number(n);
  const s = ['th', 'st', 'nd', 'rd'];
  const r = v % 100;
  return `${v}${s[(r - 20) % 10] || s[r] || s[0]}`;
}

/**
 * New York State judicial districts by county (Supreme Court elections are held by
 * judicial district). Source: NY Unified Court System district listings
 * (https://ww2.nycourts.gov/courts/). Maintained by hand; verify after any redistricting.
 */
const NY_JUDICIAL = {
  1: ['New York'],
  2: ['Kings'],
  3: ['Albany', 'Columbia', 'Greene', 'Rensselaer', 'Schoharie', 'Sullivan', 'Ulster'],
  4: ['Clinton', 'Essex', 'Franklin', 'Fulton', 'Hamilton', 'Montgomery', 'St. Lawrence', 'Saratoga', 'Schenectady', 'Warren', 'Washington'],
  5: ['Herkimer', 'Jefferson', 'Lewis', 'Oneida', 'Onondaga', 'Oswego'],
  6: ['Broome', 'Chemung', 'Chenango', 'Cortland', 'Delaware', 'Madison', 'Otsego', 'Schuyler', 'Tioga', 'Tompkins'],
  7: ['Cayuga', 'Livingston', 'Monroe', 'Ontario', 'Seneca', 'Steuben', 'Wayne', 'Yates'],
  8: ['Allegany', 'Cattaraugus', 'Chautauqua', 'Erie', 'Genesee', 'Niagara', 'Orleans', 'Wyoming'],
  9: ['Dutchess', 'Orange', 'Putnam', 'Rockland', 'Westchester'],
  10: ['Nassau', 'Suffolk'],
  11: ['Queens'],
  12: ['Bronx'],
  13: ['Richmond'],
};

const NY_JUDICIAL_BY_COUNTY = new Map(
  Object.entries(NY_JUDICIAL).flatMap(([d, counties]) => counties.map((c) => [normalizeCounty(c), String(d)]))
);

export function nyJudicialDistrict(countyName) {
  return NY_JUDICIAL_BY_COUNTY.get(normalizeCounty(countyName)) ?? null;
}

export function nyJudicialTable() {
  return Object.entries(NY_JUDICIAL).map(([district, counties]) => ({ district, counties }));
}

/** Parse an OCD division id like ocd-division/country:us/state:ny/cd:12 into parts. */
export function parseOcdId(ocdId) {
  const out = {};
  for (const part of String(ocdId ?? '').split('/')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

export function districtLabel(type, district, extras = {}) {
  switch (type) {
    case 'statewide': return extras.stateName ? `Statewide (${extras.stateName})` : 'Statewide';
    case 'congressional': return district === '0' ? 'At-large congressional district' : `Congressional District ${district}`;
    case 'state-senate': return `State Senate District ${district}`;
    case 'state-assembly': return extras.lowerName ? `${extras.lowerName} District ${district}` : `Assembly District ${district}`;
    case 'judicial-district': return /^\d+$/.test(String(district)) ? `Judicial District ${district}` : String(district ?? 'Judicial district');
    case 'county': return /county/i.test(String(district)) ? String(district) : `${district} County`;
    case 'citywide': return district ? `Citywide (${district})` : 'Citywide';
    case 'county-legislative': {
      const { county, number } = parseCountyDistrict(district);
      return county && number ? `${county} County Legislative District ${number}` : String(district ?? '');
    }
    case 'council': return `City Council District ${district}`;
    case 'district-court': {
      const { county, number } = parseCountyDistrict(district);
      return county && number ? `${county} County District Court, ${ordinalWord(number)} District` : String(district ?? '');
    }
    case 'town':
    case 'village':
      return municipalityLabel(district);
    default: return district ? String(district) : '';
  }
}
