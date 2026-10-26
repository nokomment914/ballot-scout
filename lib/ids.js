// Candidate identity: link a ballot name to database ids (Bioguide, FEC, Open Legislation
// member id, Open States person id), and encode the result into an opaque token that
// /api/candidate accepts. Matching is deliberately strict: when a match is ambiguous we
// link nothing rather than risk showing someone else's record.
import { lastName } from './order.js';
import { officeKey } from './order.js';
import { loadMembersIndex } from './votes.js';
import { nyMembersIndex } from './nysenate.js';
import { normalizeDistrict } from './districts.js';

function key(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}

export function nameParts(fullName) {
  const name = String(fullName ?? '').replace(/\([^)]*\)/g, ' ').trim();
  if (name.includes(',')) {
    const [last, rest] = name.split(',', 2);
    return { last: key(last), first: key(String(rest ?? '').trim().split(/\s+/)[0]) };
  }
  return { last: key(lastName(name)), first: key(name.split(/\s+/)[0]) };
}

function sameSurname(a, b) {
  return Boolean(a.last) && a.last === b.last;
}

/**
 * Full-name key for name-only matching: first name + middle names (single-letter initials
 * dropped) + surname. "Dana M. Rivers-Lopez" and "Dana Rivers-Lopez" match;
 * "Sample Candidate A" and "Sample Running Mate A" do not.
 */
export function fullNameKey(fullName) {
  let name = String(fullName ?? '').replace(/\([^)]*\)/g, ' ').trim();
  if (name.includes(',')) {
    const [last, rest] = name.split(',', 2);
    const restTokens = String(rest ?? '').trim();
    name = /^(jr|sr|ii|iii|iv|v)\.?$/i.test(restTokens) ? `${last} ${restTokens}` : `${restTokens} ${last}`;
  }
  const last = key(lastName(name));
  const tokens = name.split(/\s+/).filter(Boolean);
  const first = key(tokens[0]);
  const middle = tokens.slice(1, -1).map(key).filter((t) => t.length > 1 && t !== last && !['jr', 'sr', 'ii', 'iii', 'iv'].includes(t));
  return [first, ...middle, last].filter(Boolean).join(' ');
}

function sameFullName(aName, bName) {
  const a = fullNameKey(aName);
  return Boolean(a) && a === fullNameKey(bName);
}

/** Pull a district number out of text like "U.S. Representative, NY-12" or "State Senator, District 28". */
export function districtFromTitle(title) {
  const t = String(title ?? '');
  const m = /district\s*(\d+)/i.exec(t) ?? /\b(?:AD|SD|CD|LD)\s*-?\s*(\d+)\b/.exec(t) ?? /\b[A-Z]{2}-(\d+)\b/.exec(t) ?? /(\d+)(st|nd|rd|th)\s+district/i.exec(t);
  return m ? normalizeDistrict(m[1]) : null;
}

function chamberFromTitle(title) {
  const t = String(title ?? '').toLowerCase();
  if (/u\.?\s?s\.?\s+senat|united states senat/.test(t)) return { level: 'federal', chamber: 'Senate' };
  if (/representative|congress|u\.?\s?s\.?\s+house/.test(t)) return { level: 'federal', chamber: 'House' };
  if (/state senat|senator/.test(t)) return { level: 'ny', chamber: 'SENATE' };
  if (/assembly/.test(t)) return { level: 'ny', chamber: 'ASSEMBLY' };
  return null;
}

function latestCongress(m) {
  return Math.max(...(m.c ?? [0]));
}

function findFederal({ name, state, chamber, district, requireFirst }) {
  const want = nameParts(name);
  const index = loadMembersIndex();
  const hits = Object.entries(index)
    .map(([bioguide, m]) => ({ bioguide, ...m }))
    .filter((m) => m.st === state && (!chamber || m.ch === chamber) && (district === undefined || district === null || String(m.d) === String(district)))
    .filter((m) => (requireFirst ? sameFullName(name, m.n) : sameSurname(want, nameParts(m.n))));
  if (!hits.length) return null;
  hits.sort((a, b) => latestCongress(b) - latestCongress(a));
  const top = hits.filter((h) => latestCongress(h) === latestCongress(hits[0]));
  return top.length === 1 ? top[0].bioguide : null;
}

function findNy({ name, chamber, district, requireFirst }) {
  const want = nameParts(name);
  const hits = nyMembersIndex()
    .filter((m) => (!chamber || m.chamber === chamber) && (district === undefined || district === null || String(m.district) === String(district)))
    .filter((m) => {
      if (requireFirst) return sameFullName(name, m.name);
      const parts = { last: key(m.lastName ?? lastName(m.name)), first: key(m.firstName ?? String(m.name ?? '').split(/\s+/)[0]) };
      return sameSurname(want, parts);
    });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Resolve ids for a candidate (or running mate).
 * @returns {{ ids: object, matchedBy: object }}
 */
export function resolveIdentity({ candidate, contest, state, role = 'candidate' }) {
  const seedIds = candidate?.ids && typeof candidate.ids === 'object' ? candidate.ids : {};
  const ids = {};
  const matchedBy = {};
  for (const k of ['bioguide', 'fec', 'nysenate', 'openstates']) {
    if (seedIds[k] !== undefined && seedIds[k] !== null && seedIds[k] !== '') {
      ids[k] = k === 'bioguide' ? String(seedIds[k]).toUpperCase() : seedIds[k];
      matchedBy[k] = 'seed';
    }
  }
  // A non-numeric "nysenate" id is a nysenate.gov profile slug (https://www.nysenate.gov/senators/<slug>),
  // not an Open Legislation member id. Keep it for the profile link and resolve the member id below.
  if (ids.nysenate !== undefined && !/^\d+$/.test(String(ids.nysenate))) {
    if (/^[a-z0-9-]{2,80}$/.test(String(ids.nysenate))) ids.nysenateSlug = String(ids.nysenate);
    delete ids.nysenate;
    delete matchedBy.nysenate;
  }
  const name = candidate?.name ?? '';
  const st = String(state ?? '').toUpperCase();
  const ok = officeKey(contest?.office, contest ?? {});
  const contestDistrict = normalizeDistrict(contest?.district);

  // Incumbents of legislative seats: district + surname.
  const fromCurrent = chamberFromTitle(candidate?.currentOffice);
  const fromCurrentDistrict = districtFromTitle(candidate?.currentOffice);
  if (!ids.bioguide) {
    let found = null;
    if (role === 'candidate' && candidate?.incumbent && ok === 'us-house') found = findFederal({ name, state: st, chamber: 'House', district: contestDistrict });
    if (!found && role === 'candidate' && candidate?.incumbent && ok === 'us-senate') found = findFederal({ name, state: st, chamber: 'Senate' });
    if (!found && fromCurrent?.level === 'federal') found = findFederal({ name, state: st, chamber: fromCurrent.chamber, district: fromCurrent.chamber === 'House' ? fromCurrentDistrict : null });
    if (found) matchedBy.bioguide = 'office+surname';
    if (!found) {
      found = findFederal({ name, state: st, requireFirst: true });
      if (found) matchedBy.bioguide = 'name+state';
    }
    if (found) ids.bioguide = found;
  }
  if (st === 'NY' && (!ids.nysenate || !ids.openstates)) {
    let m = null;
    let how = null;
    if (role === 'candidate' && candidate?.incumbent && (ok === 'state-senate' || ok === 'state-assembly')) {
      m = findNy({ name, chamber: ok === 'state-senate' ? 'SENATE' : 'ASSEMBLY', district: contestDistrict });
      how = 'office+surname';
    }
    if (!m && fromCurrent?.level === 'ny') {
      m = findNy({ name, chamber: fromCurrent.chamber, district: fromCurrentDistrict });
      how = 'office+surname';
    }
    if (!m) {
      m = findNy({ name, requireFirst: true });
      how = 'name+state';
    }
    if (m) {
      if (!ids.nysenate && m.memberId !== undefined && m.memberId !== null) { ids.nysenate = String(m.memberId); matchedBy.nysenate = how; }
      if (!ids.openstates && m.openstatesId) { ids.openstates = m.openstatesId; matchedBy.openstates = how; }
    }
  }
  return { ids, matchedBy };
}

// ---------- Opaque candidate token ----------

const MAX_TOKEN = 4000;

export function encodeCandidateToken(p) {
  const payload = {
    v: 1,
    n: p.name,
    st: p.state,
    o: p.office,
    dt: p.districtType ?? null,
    d: p.district ?? null,
    lv: p.level ?? null,
    inc: Boolean(p.incumbent),
    co: p.currentOffice ?? null,
    ids: p.ids ?? {},
    mb: p.matchedBy ?? {},
    r: p.role ?? 'candidate',
    w: p.website ?? null,
    s: p.sample ? 1 : 0,
    ci: p.contestId ?? null,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : null);

export function decodeCandidateToken(token) {
  if (typeof token !== 'string' || !token || token.length > MAX_TOKEN || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw Object.assign(new Error('Invalid candidate id'), { status: 400 });
  }
  let raw;
  try {
    raw = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    throw Object.assign(new Error('Invalid candidate id'), { status: 400 });
  }
  if (!raw || raw.v !== 1 || !str(raw.n)) throw Object.assign(new Error('Invalid candidate id'), { status: 400 });
  const ids = {};
  const src = raw.ids && typeof raw.ids === 'object' ? raw.ids : {};
  if (/^[A-Z]\d{6}$/.test(String(src.bioguide ?? ''))) ids.bioguide = String(src.bioguide);
  const fec = Array.isArray(src.fec) ? src.fec : src.fec ? [src.fec] : [];
  const fecOk = fec.map(String).filter((f) => /^[HSP]\d[A-Z0-9]{2}\d{5}$/.test(f));
  if (fecOk.length) ids.fec = fecOk;
  if (/^\d{1,7}$/.test(String(src.nysenate ?? ''))) ids.nysenate = String(src.nysenate);
  if (/^ocd-person\/[0-9a-f-]{36}$/.test(String(src.openstates ?? ''))) ids.openstates = String(src.openstates);
  if (/^[a-z0-9-]{2,80}$/.test(String(src.nysenateSlug ?? ''))) ids.nysenateSlug = String(src.nysenateSlug);
  const mb = {};
  for (const k of Object.keys(ids)) if (typeof raw.mb?.[k] === 'string') mb[k] = raw.mb[k].slice(0, 40);
  return {
    name: str(raw.n),
    state: str(raw.st, 2)?.toUpperCase() ?? null,
    office: str(raw.o),
    districtType: str(raw.dt, 40),
    district: str(raw.d, 80),
    level: str(raw.lv, 20),
    incumbent: Boolean(raw.inc),
    currentOffice: str(raw.co),
    ids,
    matchedBy: mb,
    role: raw.r === 'running-mate' ? 'running-mate' : 'candidate',
    website: /^https?:\/\//.test(String(raw.w ?? '')) ? str(raw.w, 500) : null,
    sample: raw.s === 1,
    // The ballot contest the token was made for (tokens made before this field existed have none).
    contestId: typeof raw.ci === 'string' && /^[a-z0-9-]{1,120}$/.test(raw.ci) ? raw.ci : null,
  };
}
