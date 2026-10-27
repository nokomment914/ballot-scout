// "At a glance": three plain-English lines (Money, Positions, Record) built from a candidate's
// other sections with fixed templates only. No adjectives, no comparisons with other candidates,
// and every number is one the Money and Votes tabs show.
import { issueLabel } from './issues.js';

const dateFmt = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** "2026-10-14" -> "Oct 14, 2026" (the same format the tabs use). */
export function formatDate(iso) {
  const s = String(iso ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : dateFmt.format(d);
}

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const thousands = (n) => n.toLocaleString('en-US');

/**
 * Rounded dollars, never more than 5% from the exact amount: "$3.5 million" (one decimal, ".0"
 * dropped), "$812,000" (nearest thousand from $10,000), "$9,500" (nearest hundred from $1,000),
 * "$250" (whole dollars below that), and "$0".
 */
export function formatMoney(n) {
  const v = num(n) ?? 0;
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  const millions = (x) => {
    const m = Math.round(x / 100000) / 10;
    return `${sign}$${Number.isInteger(m) ? String(m) : m.toFixed(1)} million`;
  };
  if (a >= 1000000) return millions(a);
  const r = a >= 10000 ? Math.round(a / 1000) * 1000 : a >= 1000 ? Math.round(a / 100) * 100 : Math.round(a);
  if (r >= 1000000) return millions(r);
  return r === 0 ? '$0' : `${sign}$${thousands(r)}`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// Words that end in a period without ending a sentence ("U.S. House", "Gov. Smith").
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'st', 'no', 'jr', 'sr', 'vs', 'etc', 'gov', 'lt', 'sen', 'rep', 'inc', 'corp', 'co']);

/** The first sentence of a note, or null. */
export function firstSentence(text) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const end = /[.!?](?=\s+["“‘(]?[A-Z0-9])/g;
  let m;
  while ((m = end.exec(s))) {
    const word = s.slice(0, m.index).split(' ').pop();
    if (/^(?:[A-Z]\.)*[A-Z]$/.test(word) || ABBREVIATIONS.has(word.toLowerCase())) continue;
    return s.slice(0, m.index + 1);
  }
  return s;
}

// ---------- Money ----------

/** Outside spending as the Money tab shows it: the nightly FEC build for this cycle once it has run, otherwise the live FEC totals. */
function outsideShown(m) {
  const ob = m.outsideByCycle;
  if (ob && ob.status !== 'not-built') {
    const e = ob.entry;
    if (ob.status === 'preview' || !e || e.status !== 'ok') return null;
    return e.cycles?.[m.cycle]?.totals ?? null;
  }
  return m.outside ?? null;
}

const NO_TOTALS = 'No campaign finance totals are shown for this candidate; the Money tab links to the official filings.';

function federalMoneyText(m) {
  const receipts = num(m.totals?.receipts);
  let text;
  if (receipts === null) text = NO_TOTALS;
  else {
    const through = formatDate(m.totals?.coverageEndDate);
    const share = num(m.sizes?.smallDollarShare);
    // The FEC's size buckets cover individual contributions only, so the share is of that money,
    // as the Money tab shows it, not of everything raised.
    text = `Raised ${formatMoney(receipts)} for this race${through ? ` through ${through}` : ''}${share === null ? '.' : `; ${Math.round(share * 100)}% of the money from individual donors came in donations of $200 or less.`}`;
  }
  const o = outsideShown(m);
  const support = num(o?.support) ?? 0;
  const oppose = num(o?.oppose) ?? 0;
  const sides = [support > 0 ? `${formatMoney(support)} supporting` : null, oppose > 0 ? `${formatMoney(oppose)} opposing` : null].filter(Boolean);
  if (sides.length) text += ` Outside groups reported spending ${sides.join(' and ')}.`;
  return text;
}

/**
 * The NYS Board of Elections schedules for monetary contributions received: A (from individuals
 * and partnerships), B (from corporations) and C (from all other contributors). The other
 * schedules are in-kind contributions (D), other receipts (E), expenditures (F), transfers (G, H),
 * loans (I, J, K), refunds (L, M), liabilities (N), housekeeping accounts (P, Q), allocations (R)
 * and public matching funds (S, T), none of which is a contribution. Source: NYS Board of
 * Elections, "Transaction types: campaign financial disclosure reporting" (April 2023).
 */
export const CONTRIBUTION_SCHEDULES = Object.freeze(['A', 'B', 'C']);

// The disclosure data names each schedule in FILING_SCHED_DESC, abbreviated, e.g. "Monetary
// Contributions Received From All Other" (C) and "Expenditures/ Payments" (F).
const CONTRIBUTION_NAME = /^monetary contributions\b/i;

/** A schedule (as lib/statemoney.js passes it through: { abbrev, desc, total, count }) is counted only when its letter and its name agree. */
export function isContributionSchedule(s) {
  const letter = String(s?.abbrev ?? '').trim().toUpperCase();
  return CONTRIBUTION_SCHEDULES.includes(letter) && CONTRIBUTION_NAME.test(String(s?.desc ?? '').trim());
}

/** "A", "A and B", "A, B and C". */
function listNames(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');
}

function stateMoneyText(m) {
  const years = typeof m.years === 'string' && m.years ? m.years : null;
  const schedules = Array.isArray(m.schedules) ? m.schedules : [];
  const contributions = schedules.filter(isContributionSchedule);
  // A contribution letter without the matching name (or the reverse) means the schedules can't be
  // identified reliably, so no total is given rather than a partial one.
  const unclear = schedules.some((s) => !isContributionSchedule(s)
    && (CONTRIBUTION_SCHEDULES.includes(String(s?.abbrev ?? '').trim().toUpperCase()) || CONTRIBUTION_NAME.test(String(s?.desc ?? '').trim())));
  if (!years || !contributions.length || unclear) return `Campaign finance filings${years ? ` for ${years}` : ''} are summarized in the Money tab.`;
  const total = contributions.reduce((sum, s) => sum + (num(s.total) ?? 0), 0);
  // Named as the filings name them: the committees, and the candidate when they file under their own registration.
  const filers = [...(Array.isArray(m.committees) ? m.committees : []).map((c) => c?.name), m.filerFilings ? m.filer?.name : null].filter(Boolean);
  return `Itemized contributions of ${formatMoney(total)} reported in ${years} filings${filers.length ? ` (${listNames(filers)})` : ''}.`;
}

function moneyText(role, m) {
  if (role === 'running-mate') return 'Shares the ticket’s campaign committee; see the candidate for Governor.';
  if (m?.kind === 'fec' && m.status === 'ok') return federalMoneyText(m);
  if (m?.kind === 'state' && m.status === 'ok') return stateMoneyText(m);
  // not-found, link-out, not-configured, unavailable. Outside New York, state candidates' Money
  // tabs have no official links yet, so the line doesn't promise any.
  return m?.links?.length ? NO_TOTALS : 'No campaign finance totals are shown for this candidate.';
}

// ---------- Positions ----------

const NONE_FOUND = 'No statement found in the sources checked.';
const UNREADABLE_NOTE = 'Ballot Scout couldn’t read this candidate’s campaign website; the Positions tab links to it.';

function positionsLine(stances, issueIds) {
  const extra = stances?.unreadable ? { note: UNREADABLE_NOTE } : {};
  if (stances?.status === 'ok') {
    // One line per issue the voter picked, in their order, so an issue with nothing found is
    // named rather than left out.
    const items = issueIds.map((id) => {
      const first = (stances.items ?? []).find((x) => x.issue === id);
      return first ? { issueLabel: first.issueLabel, text: first.summary } : { issueLabel: issueLabel(id), text: NONE_FOUND, none: true };
    });
    return { kind: 'positions', text: null, items, ...extra };
  }
  const text = stances?.status === 'none-on-issues' ? 'No statement on your issues found in the sources checked. The Positions tab has news searches for more.'
    : stances?.status === 'not-researched' || !stances?.note ? 'Positions not researched yet.'
      : stances.note;
  return { kind: 'positions', text, items: [], ...extra };
}

// ---------- Record ----------

function recordLine(votes, issueIds) {
  const items = votes?.items ?? [];
  // Roll calls the member wasn't in office for are listed in the Votes tab but aren't their votes.
  const cast = items.filter((v) => !v.notInOffice);
  let text;
  if (cast.length) {
    const latest = cast.map((v) => String(v.date ?? '')).sort().at(-1);
    const when = formatDate(latest);
    if (votes?.capped) {
      // The list was cut to the most recent votes, so its length is a floor, not a total, and
      // per-issue counts from it would understate the older issues.
      text = `At least ${plural(cast.length, 'recorded vote', 'recorded votes')} on your issues${when ? `, most recently on ${when}` : ''}. The Votes tab lists the most recent.`;
    } else {
      text = `${plural(cast.length, 'recorded vote', 'recorded votes')} on your issues${when ? `, ${cast.length === 1 ? 'on' : 'most recently on'} ${when}` : ''}.`;
      const counts = issueIds.map((id) => [id, cast.filter((v) => (v.issues ?? []).includes(id)).length]).filter(([, n]) => n > 0);
      if (counts.length) text += ` ${counts.map(([id, n]) => `${issueLabel(id)}: ${n}`).join(' · ')}.`;
    }
  } else {
    text = (items.length ? null : firstSentence(votes?.note)) ?? 'No recorded votes on your issues.';
  }
  const actions = votes?.executive?.items?.length ?? 0;
  if (actions) text += ` As Governor: ${plural(actions, 'bill', 'bills')} signed or vetoed on your issues.`;
  return { kind: 'record', text };
}

/**
 * @param {{ profile: object, role: string, issueIds: string[], votes: object, money: object, stances: object }} p
 * @returns {{ lines: Array<{ kind: 'money'|'positions'|'record', text: string|null, items?: Array<{ issueLabel: string, text: string }> }> }}
 */
export function buildSummary({ role, issueIds = [], votes, money, stances }) {
  return {
    lines: [
      { kind: 'money', text: moneyText(role, money) },
      positionsLine(stances, issueIds),
      recordLine(votes, issueIds),
    ],
  };
}
