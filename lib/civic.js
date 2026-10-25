// Google Civic Information API v2: elections + voterinfo only.
// Docs: https://developers.google.com/civic-information/docs/v2
// (The Representatives endpoint was shut down in 2025 and is not used.)
import { fetchJson, buildUrl } from './http.js';
import { cached, hashKey, HOUR } from './cache.js';
import { isFixtureMode, keys, electionDate } from './config.js';
import { loadFixture } from './files.js';
import { normalizeDistrict, parseOcdId } from './districts.js';

const BASE = 'https://www.googleapis.com/civicinfo/v2';
export const CIVIC_SOURCE = {
  id: 'google-civic',
  label: 'Google Civic Information API',
  url: 'https://developers.google.com/civic-information',
};

export function parseElections(json) {
  return (json?.elections ?? []).map((e) => ({
    id: String(e?.id ?? ''),
    name: e?.name ?? '',
    electionDay: e?.electionDay ?? '',
    ocdDivisionId: e?.ocdDivisionId ?? '',
  })).filter((e) => e.id);
}

/** Prefer the state's own election on the target date, then a national one on that date. */
export function pickElection(elections, { date, state }) {
  const onDate = elections.filter((e) => e.electionDay === date);
  const st = String(state ?? '').toLowerCase();
  return (
    onDate.find((e) => e.ocdDivisionId === `ocd-division/country:us/state:${st}`) ??
    onDate.find((e) => e.ocdDivisionId === 'ocd-division/country:us') ??
    onDate.find((e) => parseOcdId(e.ocdDivisionId).state === st) ??
    null
  );
}

const SCOPE_TO_TYPE = {
  statewide: 'statewide',
  national: 'statewide',
  congressional: 'congressional',
  stateUpper: 'state-senate',
  stateLower: 'state-assembly',
  judicial: 'judicial-district',
  countywide: 'county',
  cityWide: 'citywide',
  citywide: 'citywide',
  countyCouncil: 'county',
  cityCouncil: 'citywide',
  schoolBoard: 'local',
  township: 'local',
  ward: 'local',
  special: 'local',
};

function districtFromOcd(ocdId, type) {
  const p = parseOcdId(ocdId);
  if (type === 'congressional') return normalizeDistrict(p.cd);
  if (type === 'state-senate') return normalizeDistrict(p.sldu);
  if (type === 'state-assembly') return normalizeDistrict(p.sldl);
  if (type === 'county') return p.county ? p.county.replace(/_/g, ' ') : null;
  if (type === 'citywide') return p.place ? p.place.replace(/_/g, ' ') : null;
  if (type === 'judicial-district') return normalizeDistrict(p.judicial_district ?? p.district ?? null);
  return null;
}

function contestLevel(c, type) {
  const roles = c?.roles ?? [];
  if (type === 'judicial-district' || roles.some((r) => /judge/i.test(r))) return 'judicial';
  const levels = c?.level ?? [];
  if (levels.includes('country')) return 'federal';
  if (levels.includes('administrativeArea1')) return 'state';
  if (levels.length) return 'local';
  return type === 'congressional' ? 'federal' : 'state';
}

export function splitParty(party) {
  return String(party ?? '')
    .split(/\s*[,;/]\s*/)
    .map((p) => p.replace(/\s+Party$/i, '').trim())
    .filter(Boolean);
}

function channelUrl(ch) {
  const id = String(ch?.id ?? '').trim();
  if (!id) return null;
  if (/^https?:\/\//.test(id)) return id;
  const t = String(ch?.type ?? '').toLowerCase();
  if (t === 'facebook') return `https://www.facebook.com/${encodeURIComponent(id)}`;
  if (t === 'twitter') return `https://x.com/${encodeURIComponent(id)}`;
  if (t === 'youtube') return `https://www.youtube.com/${encodeURIComponent(id)}`;
  return null;
}

/** Merge duplicate rows for the same person (New York lists fusion candidates once per party line). */
export function mergeCandidates(rows) {
  const byName = new Map();
  for (const r of rows ?? []) {
    const key = String(r?.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (!key) continue;
    const prev = byName.get(key);
    const parties = splitParty(r.party);
    const order = Number.isFinite(Number(r.orderOnBallot)) ? Number(r.orderOnBallot) : null;
    if (!prev) {
      byName.set(key, {
        name: String(r.name).trim(),
        partyLines: parties,
        website: r.candidateUrl ?? null,
        orderOnBallot: order,
        channels: (r.channels ?? []).map((ch) => ({ type: ch?.type ?? '', url: channelUrl(ch) })).filter((c) => c.url),
      });
    } else {
      for (const p of parties) if (!prev.partyLines.includes(p)) prev.partyLines.push(p);
      if (order !== null && (prev.orderOnBallot === null || order < prev.orderOnBallot)) prev.orderOnBallot = order;
      prev.website = prev.website ?? r.candidateUrl ?? null;
    }
  }
  return [...byName.values()];
}

function mapLocation(loc) {
  const a = loc?.address ?? {};
  const name = loc?.name ?? a.locationName ?? null;
  return {
    name,
    address: [a.locationName && a.locationName !== name ? a.locationName : null, a.line1, a.line2, a.line3, [a.city, a.state, a.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    hours: loc?.pollingHours ?? null,
    notes: loc?.notes ?? null,
    startDate: loc?.startDate ?? null,
    endDate: loc?.endDate ?? null,
    sources: (loc?.sources ?? []).map((s) => ({ name: s?.name ?? '', official: Boolean(s?.official) })),
  };
}

const ADMIN_LINKS = [
  ['electionInfoUrl', 'Election information'],
  ['electionRegistrationUrl', 'Register to vote'],
  ['electionRegistrationConfirmationUrl', 'Check your registration'],
  ['absenteeVotingInfoUrl', 'Absentee / mail voting'],
  ['votingLocationFinderUrl', 'Find your polling place'],
  ['ballotInfoUrl', 'Sample ballot information'],
  ['electionRulesUrl', 'Election rules'],
];

function adminLinks(body, scope) {
  if (!body) return [];
  return ADMIN_LINKS.filter(([k]) => /^https?:\/\//.test(body[k] ?? '')).map(([k, label]) => ({ label: `${label} (${body.name || scope})`, url: body[k] }));
}

/** Normalize a voterinfo response into the app's shapes. Never returns the normalized input address. */
export function parseVoterInfo(json) {
  const contests = [];
  const proposals = [];
  for (const c of json?.contests ?? []) {
    if (String(c?.type ?? '').toLowerCase() === 'referendum' || c?.referendumTitle) {
      proposals.push({
        id: `civic-ref-${proposals.length + 1}`,
        title: c.referendumTitle ?? c.ballotTitle ?? 'Ballot proposal',
        subtitle: c.referendumSubtitle ?? null,
        officialText: c.referendumText ?? null,
        summaryOfficial: c.referendumBrief ?? null,
        url: c.referendumUrl ?? null,
        sources: [{ label: 'Google Civic Information API', url: c.referendumUrl ?? CIVIC_SOURCE.url }],
        origin: 'civic',
      });
      continue;
    }
    const scope = c?.district?.scope ?? '';
    const districtType = SCOPE_TO_TYPE[scope] ?? 'local';
    const office = c?.office ?? c?.ballotTitle ?? 'Office';
    contests.push({
      id: `civic-${contests.length + 1}`,
      office,
      level: contestLevel(c, districtType),
      districtType,
      district: districtType === 'statewide' ? null : (districtFromOcd(c?.district?.id, districtType) ?? c?.district?.name ?? null),
      districtName: c?.district?.name ?? null,
      seats: Number(c?.numberElected ?? c?.numberVotingFor) || 1,
      ballotPlacement: Number.isFinite(Number(c?.ballotPlacement)) ? Number(c.ballotPlacement) : null,
      candidates: mergeCandidates(c?.candidates),
      sources: [{ label: 'Google Civic Information API', url: CIVIC_SOURCE.url }],
      origin: 'civic',
    });
  }
  const states = Array.isArray(json?.state) ? json.state : [];
  const links = [];
  for (const s of states) {
    links.push(...adminLinks(s?.electionAdministrationBody, s?.name ?? 'State'));
    links.push(...adminLinks(s?.local_jurisdiction?.electionAdministrationBody, s?.local_jurisdiction?.name ?? 'Local'));
  }
  return {
    election: json?.election ? { id: String(json.election.id ?? ''), name: json.election.name ?? '', date: json.election.electionDay ?? '' } : null,
    pollingLocations: (json?.pollingLocations ?? []).map(mapLocation),
    earlyVoteSites: (json?.earlyVoteSites ?? []).map(mapLocation),
    dropOffLocations: (json?.dropOffLocations ?? []).map(mapLocation),
    contests,
    proposals,
    administrationLinks: dedupeLinks(links),
    mailOnly: Boolean(json?.mailOnly),
    otherElections: (json?.otherElections ?? []).map((e) => ({ id: String(e?.id ?? ''), name: e?.name ?? '', date: e?.electionDay ?? '' })),
  };
}

function dedupeLinks(links) {
  const seen = new Set();
  return links.filter((l) => (seen.has(l.url) ? false : seen.add(l.url)));
}

export async function listElections() {
  if (isFixtureMode()) return parseElections(loadFixture('civic-elections'));
  const key = keys.civic();
  if (!key) return null;
  return cached('civic:elections', 6 * HOUR, async () => {
    const json = await fetchJson(buildUrl(`${BASE}/elections`, { key }), { label: 'Google Civic elections', timeoutMs: 7000 });
    return parseElections(json);
  });
}

/**
 * Voter information for an address. Returns { status, data?, election? }.
 * status: 'ok' | 'not-configured' | 'no-election' | 'unavailable'
 */
export async function getVoterInfo(address, { state } = {}) {
  if (!isFixtureMode() && !keys.civic()) return { status: 'not-configured' };
  try {
    const elections = (await listElections()) ?? [];
    const election = pickElection(elections, { date: electionDate(), state });
    if (!election) return { status: 'no-election' };
    if (isFixtureMode()) {
      return { status: 'ok', election, data: parseVoterInfo(loadFixture('civic-voterinfo')), fetchedAt: loadFixture('civic-voterinfo')?._fixtureFetchedAt ?? null };
    }
    const k = `civic:voterinfo:${election.id}:${hashKey(String(address).toLowerCase().trim())}`;
    return await cached(k, HOUR, async () => {
      const url = buildUrl(`${BASE}/voterinfo`, { key: keys.civic(), address, electionId: election.id, officialOnly: 'false' });
      const json = await fetchJson(url, { label: 'Google Civic voterinfo', timeoutMs: 9000, allow404: true });
      if (!json) return { status: 'no-election', election };
      return { status: 'ok', election, data: parseVoterInfo(json), fetchedAt: new Date().toISOString() };
    });
  } catch (err) {
    // Google returns 400 when it has no data for the address/election; treat as unavailable.
    return { status: 'unavailable', error: err?.status ? `HTTP ${err.status}` : 'error' };
  }
}
