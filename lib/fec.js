// OpenFEC API client and aggregation (https://api.open.fec.gov/developers/, github.com/fecgov/openFEC).
// Endpoints used (verified in openFEC webservices/api_setup.py and args.py):
//   /candidates/search/            state, district, office (H|S|P), election_year, q/name
//   /candidate/{id}/totals/        cycle, election_full -> receipts, disbursements, cash on hand...
//   /candidate/{id}/committees/    designation=P (principal campaign committee)
//   /schedules/schedule_a/by_size/by_candidate/   candidate_id, cycle, election_full (sizes 0,200,500,1000,2000)
//   /schedules/schedule_a/by_employer/            committee_id, cycle (itemized individual receipts by employer)
//   /schedules/schedule_e/totals/by_candidate/    candidate_id, cycle, election_full (support/oppose totals)
//   /schedules/schedule_e/by_candidate/           candidate_id, cycle, office (per spending committee)
import { fetchJson, buildUrl } from './http.js';
import { cached, HOUR } from './cache.js';
import { isFixtureMode, keys } from './config.js';
import { loadFixture } from './files.js';
import { lastName } from './order.js';
import { isoDate } from './text.js';

export const FEC_API = process.env.FEC_API_BASE || 'https://api.open.fec.gov/v1';
export const FEC_SOURCE = { id: 'openfec', label: 'Federal Election Commission (OpenFEC API)', url: 'https://api.open.fec.gov/developers/' };

async function fecGet(path, params, fixture) {
  if (isFixtureMode()) return loadFixture(fixture);
  const apiKey = keys.dataGov();
  if (!apiKey) throw Object.assign(new Error('FEC API key not configured'), { code: 'not-configured' });
  const url = buildUrl(`${FEC_API}${path}`, { ...params, api_key: apiKey });
  return cached(`fec:${path}:${JSON.stringify(params)}`, 6 * HOUR, () =>
    fetchJson(url, { label: 'OpenFEC API', timeoutMs: 9000, retries: 2, allow404: true })
  );
}

export function fecOfficeCode(officeKey) {
  if (officeKey === 'us-house') return 'H';
  if (officeKey === 'us-senate') return 'S';
  if (officeKey === 'president') return 'P';
  return null;
}

function norm(s) {
  return String(s ?? '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** FEC names are "LAST, FIRST MIDDLE". Pick the single result whose surname (and given name, if needed) matches. */
export function pickFecCandidate(results, fullName) {
  const last = norm(lastName(fullName)).replace(/\s+/g, '');
  const first = norm(String(fullName).split(/\s+/)[0]);
  const bySurname = (results ?? []).filter((r) => {
    const fecLast = norm(String(r?.name ?? '').split(',')[0]).replace(/\s+/g, '');
    return fecLast === last;
  });
  if (bySurname.length <= 1) return bySurname[0] ?? null;
  const byFirst = bySurname.filter((r) => norm(String(r?.name ?? '').split(',')[1] ?? '').split(' ').includes(first));
  if (byFirst.length === 1) return byFirst[0];
  return null; // ambiguous: better to show nothing than the wrong person's money
}

export async function searchCandidates({ name, state, officeCode, district, cycle }) {
  const json = await fecGet('/candidates/search/', {
    q: lastName(name),
    state,
    office: officeCode,
    district: officeCode === 'H' ? String(district ?? '').padStart(2, '0') : undefined,
    election_year: cycle,
    per_page: 50,
    sort: 'name',
  }, 'fec-candidates-search');
  return json?.results ?? [];
}

export async function getCandidateTotals(candidateId, cycle) {
  const json = await fecGet(`/candidate/${encodeURIComponent(candidateId)}/totals/`, { cycle, election_full: 'true', per_page: 5 }, `fec-totals-${candidateId}`);
  const list = json?.results ?? [];
  return list.find((r) => Number(r?.cycle) === Number(cycle) || Number(r?.candidate_election_year) === Number(cycle)) ?? list[0] ?? null;
}

export async function getPrincipalCommittees(candidateId, cycle) {
  const json = await fecGet(`/candidate/${encodeURIComponent(candidateId)}/committees/`, { designation: 'P', cycle, per_page: 10 }, `fec-committees-${candidateId}`);
  return (json?.results ?? []).map((c) => ({ id: c?.committee_id ?? null, name: c?.name ?? null })).filter((c) => c.id);
}

export async function getBySize(candidateId, cycle) {
  const json = await fecGet('/schedules/schedule_a/by_size/by_candidate/', { candidate_id: candidateId, cycle, election_full: 'true', per_page: 20 }, `fec-by-size-${candidateId}`);
  return json?.results ?? [];
}

export async function getTopEmployers(committeeId, cycle, limit = 10) {
  const json = await fecGet('/schedules/schedule_a/by_employer/', { committee_id: committeeId, cycle, sort: '-total', per_page: limit }, `fec-by-employer-${committeeId}`);
  return json?.results ?? [];
}

export async function getIeTotals(candidateId, cycle) {
  const json = await fecGet('/schedules/schedule_e/totals/by_candidate/', { candidate_id: candidateId, cycle, election_full: 'true', per_page: 20 }, `fec-ie-totals-${candidateId}`);
  return json?.results ?? [];
}

export async function getIeByCommittee(candidateId, cycle, office) {
  const json = await fecGet('/schedules/schedule_e/by_candidate/', { candidate_id: candidateId, cycle, office, election_full: 'true', sort: '-total', per_page: 10 }, `fec-ie-by-committee-${candidateId}`);
  return json?.results ?? [];
}

// ---------- Outside spending, for the nightly build (scripts/build-outside.mjs) ----------
// /schedules/schedule_e/by_candidate/ takes the "elections" arguments (cycle and office are
// required), and pages by number. /schedules/schedule_e/ pages by seek index
// (pagination.last_indexes); is_notice=true limits it to 24- and 48-hour reports and
// most_recent=true keeps the latest version of amended filings (openFEC webservices/args.py).

/** Every spending committee's total for or against one candidate in one cycle. */
export async function getIeByCommitteeAll(candidateId, cycle, office, { maxPages = 10 } = {}) {
  const out = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const json = await fecGet('/schedules/schedule_e/by_candidate/', { candidate_id: candidateId, cycle, office, election_full: 'true', sort: '-total', per_page: 100, page }, `fec-ie-by-committee-${candidateId}`);
    const rows = json?.results ?? [];
    out.push(...rows);
    const pages = Number(json?.pagination?.pages) || 1;
    if (isFixtureMode() || page >= pages || !rows.length) break;
  }
  return out;
}

/** 24- and 48-hour independent expenditure reports for one candidate in one cycle. */
export async function getIeNotices(candidateId, cycle, { maxPages = 40 } = {}) {
  const out = [];
  let seek = {};
  for (let page = 0; page < maxPages; page += 1) {
    const json = await fecGet('/schedules/schedule_e/', { candidate_id: candidateId, cycle, is_notice: 'true', most_recent: 'true', sort: '-expenditure_date', per_page: 100, ...seek }, `fec-ie-notices-${candidateId}`);
    const rows = json?.results ?? [];
    out.push(...rows);
    const last = json?.pagination?.last_indexes;
    if (isFixtureMode() || rows.length < 100 || !last || !Object.keys(last).length) break;
    seek = last;
  }
  return out;
}

/** Committee type codes for a list of committee ids ({ [id]: { committee_type, name } }). */
export async function getCommitteeTypes(ids) {
  const unique = [...new Set((ids ?? []).filter(Boolean))];
  const out = {};
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const json = await fecGet('/committees/', { committee_id: chunk, per_page: 100 }, 'fec-committees-list');
    for (const c of json?.results ?? []) {
      if (c?.committee_id) out[c.committee_id] = { committee_type: c.committee_type ?? null, name: c.name ?? null, designation: c.designation ?? null };
    }
  }
  return out;
}

/** Resolve a federal candidate's FEC id the same way the Money tab does (seed id first, then a single name match). */
export async function resolveFecCandidate({ name, fecIds, state, officeKey, district, cycle }) {
  const officeCode = fecOfficeCode(officeKey);
  const fromSeed = Array.isArray(fecIds) ? fecIds.find((id) => String(id).startsWith(officeCode ?? '')) ?? fecIds[0] : fecIds;
  if (fromSeed) return { candidateId: fromSeed, matchedBy: 'seed' };
  const results = await searchCandidates({ name, state, officeCode, district, cycle });
  const pick = pickFecCandidate(results, name);
  return pick ? { candidateId: pick.candidate_id, matchedBy: 'name+office' } : { candidateId: null, matchedBy: null };
}

// ---------- Pure aggregation (unit-tested) ----------

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

export function summarizeTotals(t) {
  if (!t) return null;
  return {
    receipts: num(t.receipts),
    disbursements: num(t.disbursements),
    cashOnHand: num(t.last_cash_on_hand_end_period),
    debts: num(t.last_debts_owed_by_committee),
    individualContributions: num(t.individual_contributions),
    individualItemized: num(t.individual_itemized_contributions),
    individualUnitemized: num(t.individual_unitemized_contributions),
    pacContributions: num(t.other_political_committee_contributions),
    partyContributions: num(t.political_party_committee_contributions),
    candidateContributions: num(t.candidate_contribution),
    candidateLoans: num(t.loans_made_by_candidate ?? t.loans_received_from_candidate),
    coverageStartDate: isoDate(t.coverage_start_date),
    coverageEndDate: isoDate(t.coverage_end_date),
    lastReport: t.last_report_type_full ?? null,
  };
}

const SIZE_LABELS = { 0: '$200 and under (includes unitemized)', 200: '$200.01–$499.99', 500: '$500–$999.99', 1000: '$1,000–$1,999.99', 2000: '$2,000 and over' };

/** Combine by-size rows into ordered buckets with shares of the total individual contributions. */
export function sizeBreakdown(rows) {
  const totals = new Map();
  for (const r of rows ?? []) {
    const size = Number(r?.size);
    if (!(size in SIZE_LABELS)) continue;
    const prev = totals.get(size) ?? { total: 0, count: 0 };
    prev.total += Number(r?.total) || 0;
    prev.count += Number(r?.count) || 0;
    totals.set(size, prev);
  }
  const sum = [...totals.values()].reduce((a, b) => a + b.total, 0);
  const buckets = Object.keys(SIZE_LABELS).map(Number).map((size) => {
    const t = totals.get(size) ?? { total: 0, count: 0 };
    return { size, label: SIZE_LABELS[size], total: round2(t.total), share: sum > 0 ? round4(t.total / sum) : null };
  });
  const small = totals.get(0)?.total ?? 0;
  return { buckets, total: round2(sum), smallDollarTotal: round2(small), smallDollarShare: sum > 0 ? round4(small / sum) : null };
}

export function outsideSpending(totalRows, committeeRows) {
  let support = 0;
  let oppose = 0;
  for (const r of totalRows ?? []) {
    const amt = Number(r?.total) || 0;
    if (String(r?.support_oppose_indicator).toUpperCase() === 'S') support += amt;
    else if (String(r?.support_oppose_indicator).toUpperCase() === 'O') oppose += amt;
  }
  const spenders = (committeeRows ?? [])
    .filter((r) => Number(r?.total) > 0)
    .map((r) => ({
      committeeId: r?.committee_id ?? null,
      name: r?.committee_name ?? r?.committee?.name ?? r?.committee_id ?? 'Unnamed committee',
      supportOppose: String(r?.support_oppose_indicator).toUpperCase() === 'S' ? 'Supporting' : String(r?.support_oppose_indicator).toUpperCase() === 'O' ? 'Opposing' : 'Not stated',
      total: round2(Number(r.total)),
      url: r?.committee_id ? `https://www.fec.gov/data/committee/${r.committee_id}/` : null,
    }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
  return { support: round2(support), oppose: round2(oppose), spenders };
}

export function topEmployers(rows, limit = 10) {
  return (rows ?? [])
    .filter((r) => r?.employer !== undefined && Number(r?.total) > 0)
    .map((r) => ({ employer: String(r.employer ?? '').trim() || '(blank)', total: round2(Number(r.total)), count: Number(r.count) || null }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }

/**
 * Full money section for a federal candidate.
 * @returns {Promise<{status: string, ...}>}
 */
export async function federalMoney({ name, fecIds, state, officeKey, district, cycle }) {
  const officeCode = fecOfficeCode(officeKey);
  let candidateId = Array.isArray(fecIds) ? fecIds.find((id) => String(id).startsWith(officeCode ?? '')) ?? fecIds[0] : fecIds;
  let principal = [];
  let matchedBy = candidateId ? 'seed' : null;
  if (!candidateId) {
    const results = await searchCandidates({ name, state, officeCode, district, cycle });
    const pick = pickFecCandidate(results, name);
    if (!pick) return { status: 'not-found', searchUrl: fecSearchUrl(name) };
    candidateId = pick.candidate_id;
    principal = (pick.principal_committees ?? []).map((c) => ({ id: c?.committee_id, name: c?.name })).filter((c) => c.id);
    matchedBy = 'name+office';
  }
  const [totals, bySize, committees, ieTotals, ieRows] = await Promise.all([
    getCandidateTotals(candidateId, cycle).catch(() => null),
    getBySize(candidateId, cycle).catch(() => []),
    principal.length ? Promise.resolve(principal) : getPrincipalCommittees(candidateId, cycle).catch(() => []),
    getIeTotals(candidateId, cycle).catch(() => []),
    getIeByCommittee(candidateId, cycle, officeCode === 'S' ? 'senate' : 'house').catch(() => []),
  ]);
  const committee = committees[0] ?? null;
  const employers = committee ? await getTopEmployers(committee.id, cycle).catch(() => []) : [];
  return {
    status: 'ok',
    candidateId,
    matchedBy,
    cycle,
    committee: committee ? { ...committee, url: `https://www.fec.gov/data/committee/${committee.id}/` } : null,
    totals: summarizeTotals(totals),
    sizes: sizeBreakdown(bySize),
    topEmployers: topEmployers(employers),
    outside: outsideSpending(ieTotals, ieRows),
    links: [
      { label: 'Candidate page on FEC.gov', url: `https://www.fec.gov/data/candidate/${candidateId}/?cycle=${cycle}` },
      ...(committee ? [{ label: 'Campaign committee filings on FEC.gov', url: `https://www.fec.gov/data/committee/${committee.id}/?cycle=${cycle}` }] : []),
      { label: 'Independent expenditures for this candidate (FEC.gov)', url: `https://www.fec.gov/data/independent-expenditures/?candidate_id=${candidateId}&two_year_transaction_period=${cycle}` },
    ],
  };
}

export function fecSearchUrl(name) {
  return `https://www.fec.gov/data/candidates/?q=${encodeURIComponent(lastName(name))}`;
}
