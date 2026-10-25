// Outside spending: independent expenditures that super PACs, party committees and other groups
// report to the FEC for or against a federal candidate (Schedule E). Super PACs can't give money
// to candidates; they spend on their own, for or against them, and must report it.
//
// scripts/build-outside.mjs precomputes /data/fec/outside.json nightly for every federal candidate
// in the researched ballot files, so every candidate in a race is shown the same way, with the same
// data date. Totals come from the FEC's processed reports; 24- and 48-hour reports, which reach the
// FEC within a day or two of the spending, are summed separately because they usually reappear on
// the spender's next regular report and adding the two would double count.
import { isFixtureMode } from './config.js';
import { readData, loadFixture } from './files.js';
import { officeKey } from './order.js';

export const OUTSIDE_SOURCE = {
  id: 'fec-outside',
  label: 'Federal Election Commission: independent expenditures (Schedule E, via the OpenFEC API)',
  url: 'https://www.fec.gov/data/independent-expenditures/',
};

/** FEC committee type codes (https://www.fec.gov/campaign-finance-data/committee-type-code-descriptions/). */
export const COMMITTEE_TYPES = Object.freeze({
  O: 'Super PAC (independent expenditure-only)',
  U: 'Single-candidate super PAC',
  V: 'Hybrid PAC (super PAC account)',
  W: 'Hybrid PAC (super PAC account)',
  N: 'PAC',
  Q: 'PAC',
  X: 'Party committee',
  Y: 'Party committee',
  Z: 'National party nonfederal account',
  I: 'Independent expenditure filer (person or group, not a committee)',
  C: 'Communication cost filer',
  E: 'Electioneering communication filer',
  H: 'House campaign committee',
  S: 'Senate campaign committee',
  P: 'Presidential campaign committee',
});

export const GROUP_LABELS = Object.freeze({
  'super-pac': 'Super PACs',
  party: 'Party committees',
  pac: 'Other PACs',
  other: 'Other groups and individuals',
});

/** Super PACs, single-candidate super PACs and hybrid PACs' super PAC accounts all spend unlimited funds independently. */
export function committeeGroup(type) {
  const t = String(type ?? '').toUpperCase();
  if (['O', 'U', 'V', 'W'].includes(t)) return 'super-pac';
  if (['X', 'Y', 'Z'].includes(t)) return 'party';
  if (['N', 'Q'].includes(t)) return 'pac';
  return 'other';
}

/** Links for state and local candidates: New York independent expenditures are reported to the NYS Board of Elections. */
export const NY_IE_LINKS = Object.freeze([
  { label: 'NYS Board of Elections: independent expenditures by candidate supported or opposed', url: 'https://publicreporting.elections.ny.gov/IESchedRSupportOppose/IESchedRSupportOppose' },
  { label: 'NYS Board of Elections: 24-hour and weekly independent expenditure reports', url: 'https://publicreporting.elections.ny.gov/IEPIDA/IEPIDA' },
]);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const pos = (ind) => (String(ind ?? '').toUpperCase() === 'S' ? 'support' : String(ind ?? '').toUpperCase() === 'O' ? 'oppose' : null);
const emptyPair = () => ({ support: 0, oppose: 0 });
const emptyGroups = () => ({ 'super-pac': emptyPair(), party: emptyPair(), pac: emptyPair(), other: emptyPair() });

/** { state: 'NY', officeKey: 'us-house', district: '17', name: 'Mike Lawler' } -> "NY|us-house|17|mikelawler". */
export function outsideKey({ state, officeKey, district, name }) {
  const d = district === null || district === undefined || district === '' ? '' : (/^\d+$/.test(String(district)) ? String(parseInt(district, 10)) : String(district));
  const n = String(name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  return `${String(state ?? '').toUpperCase()}|${officeKey}|${d}|${n}`;
}

/**
 * One cycle for one candidate, from FEC rows:
 *   totals:      /schedules/schedule_e/totals/by_candidate/ rows (support_oppose_indicator, total)
 *   byCommittee: /schedules/schedule_e/by_candidate/ rows (committee_id, committee_name, support_oppose_indicator, total)
 *   committees:  { [committee_id]: { committee_type, name } } from /committees/
 *   notices:     /schedules/schedule_e/ rows with is_notice=true and most_recent=true (24- and 48-hour reports)
 */
export function summarizeCycle({ cycle, totals = [], byCommittee = [], committees = {}, notices = null }) {
  const t = emptyPair();
  for (const r of totals) {
    if (r?.cycle !== undefined && Number(r.cycle) !== Number(cycle)) continue;
    const p = pos(r?.support_oppose_indicator);
    if (p) t[p] += Number(r?.total) || 0;
  }
  const byGroup = emptyGroups();
  const spenderMap = new Map();
  for (const r of byCommittee) {
    if (r?.cycle !== undefined && Number(r.cycle) !== Number(cycle)) continue;
    const p = pos(r?.support_oppose_indicator);
    const amount = Number(r?.total) || 0;
    if (!p || amount <= 0) continue;
    const type = committees[r.committee_id]?.committee_type ?? null;
    const group = committeeGroup(type);
    byGroup[group][p] += amount;
    const k = `${r.committee_id}|${p}`;
    const prev = spenderMap.get(k);
    if (prev) prev.total += amount;
    else spenderMap.set(k, { committeeId: r.committee_id ?? null, name: r.committee_name || committees[r.committee_id]?.name || r.committee_id || 'Unnamed committee', type, typeLabel: COMMITTEE_TYPES[type] ?? (type ? `FEC committee type ${type}` : 'Committee type not listed'), group, position: p, total: amount });
  }
  const spenders = [...spenderMap.values()].map((s) => ({ ...s, total: round2(s.total) })).sort((a, b) => b.total - a.total).slice(0, 10);
  for (const g of Object.values(byGroup)) { g.support = round2(g.support); g.oppose = round2(g.oppose); }
  return {
    cycle: Number(cycle),
    totals: { support: round2(t.support), oppose: round2(t.oppose) },
    byGroup,
    spenders,
    notices: notices ? summarizeNotices(notices, committees) : null,
  };
}

/** 24- and 48-hour reports: latest version of each, memo entries left out (they repeat other lines). */
export function summarizeNotices(rows, committees = {}) {
  const out = { support: 0, oppose: 0, count: 0, latestFiled: null, byGroup: emptyGroups() };
  const seen = new Set();
  for (const r of rows ?? []) {
    if (r?.is_notice === false) continue;
    if (r?.memoed_subtotal === true || String(r?.memo_code ?? '').toUpperCase() === 'X') continue;
    const id = r?.sub_id ?? `${r?.committee_id}|${r?.transaction_id}|${r?.file_number}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const p = pos(r?.support_oppose_indicator);
    const amount = Number(r?.expenditure_amount) || 0;
    if (!p || amount <= 0) continue;
    const type = r?.committee?.committee_type ?? committees[r?.committee_id]?.committee_type ?? null;
    out[p] += amount;
    out.byGroup[committeeGroup(type)][p] += amount;
    out.count += 1;
    const filed = String(r?.filing_date ?? r?.expenditure_date ?? '').slice(0, 10);
    if (filed && (!out.latestFiled || filed > out.latestFiled)) out.latestFiled = filed;
  }
  out.support = round2(out.support);
  out.oppose = round2(out.oppose);
  for (const g of Object.values(out.byGroup)) { g.support = round2(g.support); g.oppose = round2(g.oppose); }
  return out;
}

/** Anything at all for or against this candidate from super PACs, and from everyone else. */
export function entryStatus(entry) {
  if (!entry) return { status: 'not-built', superPac: false, other: false };
  if (entry.status !== 'ok') return { status: entry.status ?? 'not-found', superPac: false, other: false };
  let superPac = false;
  let other = false;
  for (const c of Object.values(entry.cycles ?? {})) {
    for (const [g, v] of Object.entries(c.byGroup ?? {})) if (v.support > 0 || v.oppose > 0) { if (g === 'super-pac') superPac = true; else other = true; }
    for (const [g, v] of Object.entries(c.notices?.byGroup ?? {})) if (v.support > 0 || v.oppose > 0) { if (g === 'super-pac') superPac = true; else other = true; }
    // Totals with no committee rows (rare: processing lag) still count as outside spending.
    if (!superPac && !other && (c.totals?.support > 0 || c.totals?.oppose > 0)) other = true;
  }
  return { status: superPac || other ? 'recorded' : 'none', superPac, other };
}

export function loadOutside() {
  return isFixtureMode() ? loadFixture('fec-outside') : readData('fec', 'outside.json');
}

export function outsideFor({ state, officeKey, district, name }) {
  const file = loadOutside();
  if (!file) return { file: null, entry: null };
  return { file, entry: file.candidates?.[outsideKey({ state, officeKey, district, name })] ?? null };
}

/** fec.gov pages for one candidate (independent expenditures supporting or opposing them). */
export function fecOutsideLinks(fecCandidateId, cycles = []) {
  if (!fecCandidateId) return [];
  return cycles.map((cy) => ({ label: `Independent expenditures for or against this candidate, ${cy - 1}–${cy} (FEC.gov)`, url: `https://www.fec.gov/data/independent-expenditures/?candidate_id=${fecCandidateId}&two_year_transaction_period=${cy}` }));
}

/**
 * The outside-spending summary for the federal contests on one ballot, in ballot order, every
 * candidate in the same shape. contests are shaped contests from lib/ballot.js.
 */
export function ballotOutside(contests, state) {
  const federal = (contests ?? []).filter((c) => ['us-house', 'us-senate'].includes(officeKey(c.office, c)));
  if (!federal.length) return null;
  const file = loadOutside();
  return {
    builtAt: file?.builtAt ?? null,
    status: file ? 'ok' : 'not-built',
    cycles: file?.cycles ?? [],
    source: { ...OUTSIDE_SOURCE, lastUpdated: file?.builtAt ?? null },
    contests: federal.map((c) => ({
      contestId: c.id,
      office: c.office,
      districtLabel: c.districtLabel,
      candidates: c.candidates.map((cand) => {
        const entry = file?.candidates?.[outsideKey({ state, officeKey: officeKey(c.office, c), district: c.district, name: cand.name })] ?? null;
        const st = entryStatus(file ? entry : null);
        return {
          name: cand.name,
          status: file ? (entry ? st.status : 'not-found') : 'not-built',
          superPac: st.superPac,
          other: st.other,
          fecCandidateId: entry?.fecCandidateId ?? null,
          cycles: entry?.status === 'ok' ? Object.values(entry.cycles ?? {}).sort((a, b) => b.cycle - a.cycle).map((cy) => ({ cycle: cy.cycle, byGroup: cy.byGroup, totals: cy.totals, notices: cy.notices })) : [],
          links: entry?.links ?? [],
        };
      }),
    })),
  };
}
