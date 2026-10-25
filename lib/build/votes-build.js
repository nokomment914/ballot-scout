// Pure functions for scripts/build-votes.mjs (unit-tested in tests/build.test.js).
// Input: Voteview per-Congress CSV rows (members, rollcalls, votes).
// Output: the compact indexes read by lib/votes.js.
import { classifyQuestion, parseBillNumber, billKey } from '../votes.js';
import { isoDate } from '../text.js';

export const VOTEVIEW_BASE = process.env.VOTEVIEW_BASE || 'https://voteview.com/static/data/out';

export function voteviewUrls(congress) {
  return {
    members: `${VOTEVIEW_BASE}/members/HS${congress}_members.csv`,
    rollcalls: `${VOTEVIEW_BASE}/rollcalls/HS${congress}_rollcalls.csv`,
    votes: `${VOTEVIEW_BASE}/votes/HS${congress}_votes.csv`,
    rollcallsJson: `${VOTEVIEW_BASE}/rollcalls/HS${congress}_rollcalls.json`,
  };
}

const chamberCode = (c) => (String(c).toLowerCase().startsWith('s') ? 'S' : String(c).toLowerCase().startsWith('h') ? 'H' : null);

/** icpsr -> member info for one Congress. At-large House seats are normalized to district "0". */
export function indexMembers(rows, congress) {
  const byIcpsr = new Map();
  const houseDistricts = new Map();
  for (const r of rows) {
    const ch = chamberCode(r.chamber);
    if (!ch || Number(r.congress) !== Number(congress)) continue;
    if (ch === 'H') {
      if (!houseDistricts.has(r.state_abbrev)) houseDistricts.set(r.state_abbrev, new Set());
      houseDistricts.get(r.state_abbrev).add(String(r.district_code));
    }
  }
  for (const r of rows) {
    const ch = chamberCode(r.chamber);
    if (!ch || Number(r.congress) !== Number(congress)) continue;
    const bioguide = String(r.bioguide_id ?? '').trim().toUpperCase();
    if (!bioguide) continue;
    let district = ch === 'H' ? String(Number(r.district_code)) : null;
    if (ch === 'H' && (houseDistricts.get(r.state_abbrev)?.size ?? 0) === 1) district = '0';
    byIcpsr.set(`${ch}:${r.icpsr}`, { bioguide, name: r.bioname ?? '', state: r.state_abbrev, chamber: ch === 'H' ? 'House' : 'Senate', district });
  }
  return byIcpsr;
}

export function rollcallId(ch, congress, rollnumber) {
  return `${ch}${congress}-${String(rollnumber).padStart(4, '0')}`;
}

/** Keep substantive roll calls on bills/resolutions; returns Map id -> compact row. */
export function selectRollcalls(rows, congress) {
  const kept = new Map();
  let total = 0;
  for (const r of rows) {
    const ch = chamberCode(r.chamber);
    if (!ch || Number(r.congress) !== Number(congress)) continue;
    total += 1;
    const kind = classifyQuestion(r.vote_question, r.vote_desc || r.dtl_desc);
    const bill = parseBillNumber(r.bill_number);
    if (!kind || !bill) continue;
    const id = rollcallId(ch, congress, r.rollnumber);
    kept.set(id, [
      ch,
      Number(congress),
      Number(r.session) || null,
      isoDate(r.date),
      Number(r.clerk_rollnumber) || null,
      Number(r.rollnumber),
      billKey(congress, bill.type, bill.number),
      String(r.vote_question ?? '').trim(),
      kind,
      String(r.vote_result ?? '').trim() || null,
      String(r.vote_desc ?? '').trim().slice(0, 300) || null,
    ]);
  }
  return { kept, total };
}

/** Streamed votes rows -> Map bioguide -> [[rollcallId, castCode], ...] (adds into `into`). */
export function collectMemberVotes(row, congress, members, kept, into) {
  const ch = chamberCode(row.chamber);
  if (!ch) return;
  const code = Number(row.cast_code);
  if (!code) return; // 0 = not a member at the time
  const id = rollcallId(ch, congress, row.rollnumber);
  if (!kept.has(id)) return;
  const m = members.get(`${ch}:${row.icpsr}`);
  if (!m) return;
  if (!into.has(m.bioguide)) into.set(m.bioguide, []);
  into.get(m.bioguide).push([id, code]);
}

/** Which bills still need Congress.gov details, most recently voted first. */
export function billsToFetch(kept, bills, { now = Date.now(), staleDays = 30 } = {}) {
  const lastVote = new Map();
  for (const row of kept.values()) {
    const key = row[6];
    const date = row[3] ?? '';
    if (!lastVote.has(key) || lastVote.get(key) < date) lastVote.set(key, date);
  }
  const missing = [];
  const fallbackOnly = [];
  const stale = [];
  for (const [key, date] of lastVote) {
    const b = bills[key];
    if (!b || (!b.pa && !b.gone)) missing.push([key, date]);
    else if (b.ps === 'voteview' || !b.f) fallbackOnly.push([key, date]);
    else if (now - Date.parse(b.f) > staleDays * 86400000) stale.push([key, date]);
  }
  const byDate = (a, b) => String(b[1]).localeCompare(String(a[1]));
  return [...missing.sort(byDate), ...fallbackOnly.sort(byDate), ...stale.sort(byDate)].map(([k]) => k);
}

/** Compact a Congress.gov bill detail into the bills.json shape. */
export function compactCongressBill(bill, fetchedAt) {
  if (!bill) return { t: null, pa: null, gone: true, f: fetchedAt };
  const laws = (Array.isArray(bill.laws) ? bill.laws : bill.laws?.item ?? []).map((l) => String(l?.number ?? '')).filter(Boolean);
  const cbo = (Array.isArray(bill.cboCostEstimates) ? bill.cboCostEstimates : bill.cboCostEstimates?.item ?? [])
    .filter((c) => c?.url)
    .map((c) => ({ t: c.title ?? null, u: c.url, d: isoDate(c.pubDate), desc: c.description ?? null }));
  return {
    t: bill.title ?? null,
    pa: bill.policyArea?.name ?? null,
    la: bill.latestAction ? { d: bill.latestAction.actionDate ?? null, t: bill.latestAction.text ?? null } : null,
    laws,
    cbo,
    f: fetchedAt,
  };
}

/** Optional fallback: Voteview's JSON rollcalls carry a CRS policy area per roll call. */
export function policyAreasFromVoteviewJson(json, congress) {
  const out = new Map();
  const list = Array.isArray(json) ? json : Array.isArray(json?.rollcalls) ? json.rollcalls : [];
  for (const r of list) {
    if (Number(r?.congress) !== Number(congress)) continue;
    const pa = typeof r?.crs_policy_area === 'string' ? r.crs_policy_area : Array.isArray(r?.crs_policy_area) ? r.crs_policy_area[0] : null;
    const bill = parseBillNumber(r?.bill_number);
    if (pa && bill) out.set(billKey(congress, bill.type, bill.number), pa);
  }
  return out;
}

export function rollcallFields() {
  return ['chamber', 'congress', 'session', 'date', 'clerkRoll', 'voteviewRoll', 'bill', 'question', 'kind', 'result', 'desc'];
}
