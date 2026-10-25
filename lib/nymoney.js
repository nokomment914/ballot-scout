// New York State campaign finance from the NYS Board of Elections' open data on data.ny.gov
// (Socrata). Datasets:
//   7x2g-h32p  "Campaign Finance Filer Data: Beginning 1974"         (registered candidates and committees)
//   e9ss-239a  "Campaign Finance Disclosure Reports Data: Beginning 1999" (itemized transactions)
// Column names follow the NYS BOE file format references (FileFormatReferenceFiler.pdf and
// FileFormatReference.pdf). The build checks every required column against the dataset's live
// column list before querying, and skips the source entirely if anything is missing.
import { fullNameKey } from './ids.js';
import { lastName } from './order.js';
import { isoDate } from './text.js';

export const NY_SOCRATA = process.env.NY_SOCRATA_BASE || 'https://data.ny.gov';
export const DATASETS = { filers: '7x2g-h32p', disclosures: 'e9ss-239a' };
export const REQUIRED = {
  filers: ['FILER_ID', 'FILER_NAME', 'COMPLIANCE_TYPE_DESC', 'FILER_TYPE_DESC', 'FILER_STATUS', 'OFFICE_DESC', 'DISTRICT'],
  disclosures: ['FILER_ID', 'ELECTION_YEAR', 'FILING_DESC', 'FILING_SCHED_ABBREV', 'FILING_SCHED_DESC', 'TRANS_NUMBER', 'R_AMEND', 'SCHED_DATE', 'ORG_AMT'],
};

export function datasetLinks(id) {
  return {
    landing: `${NY_SOCRATA}/d/${id}`,
    columns: `${NY_SOCRATA}/api/views/${id}/columns.json`,
    resource: `${NY_SOCRATA}/resource/${id}.json`,
  };
}

/** Map documented column names to Socrata field names using the dataset's columns.json. */
export function mapColumns(columns, required) {
  const byKey = new Map();
  for (const c of Array.isArray(columns) ? columns : []) {
    const field = c?.fieldName;
    if (!field) continue;
    for (const k of [c.name, c.fieldName]) if (k) byKey.set(String(k).trim().toUpperCase().replace(/\s+/g, '_'), { field, type: String(c.dataTypeName ?? 'text').toLowerCase() });
  }
  const map = {};
  const missing = [];
  for (const r of required) {
    const hit = byKey.get(r);
    if (hit) map[r] = hit;
    else missing.push(r);
  }
  return { map, missing };
}

/** SoQL literal for a column, quoting text columns and leaving numbers bare. */
export function soqlLiteral(col, value) {
  if (col.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`not a number: ${value}`);
    return String(n);
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

export function officeClass(text) {
  const t = String(text ?? '').toLowerCase();
  if (/lieutenant governor|lt\.? governor/.test(t) && !/^governor and/.test(t)) return 'lieutenant-governor';
  if (/governor/.test(t)) return 'governor';
  if (/comptroller/.test(t)) return 'comptroller';
  if (/attorney general/.test(t)) return 'attorney-general';
  if (/supreme court/.test(t)) return 'supreme-court';
  if (/senat/.test(t)) return 'state-senate';
  if (/assembl/.test(t)) return 'state-assembly';
  return null;
}

export function moneyKey({ office, district, name }) {
  const d = /^\d+$/.test(String(district ?? '')) ? String(Number(district)) : '';
  return `${officeClass(office) ?? 'other'}|${d}|${fullNameKey(name)}`;
}

const squash = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * Pick the candidate's own registered committee: same office class, same district (for
 * districted offices), surname in the filer name, state-level candidate filer. Exactly one
 * active match (or exactly one match overall) is required.
 */
export function matchFiler(candidate, filers) {
  const cls = officeClass(candidate.office);
  if (!cls) return null;
  const surname = squash(lastName(candidate.name));
  if (!surname) return null;
  const districted = cls === 'state-senate' || cls === 'state-assembly' || cls === 'supreme-court';
  const want = districted ? String(Number(candidate.district)) : null;
  const hits = filers.filter((f) => {
    if (officeClass(f.office) !== cls) return false;
    if (!/candidate/i.test(f.compliance ?? '')) return false;
    if (f.filerType && !/state/i.test(f.filerType)) return false;
    if (districted && String(Number(String(f.district ?? '').replace(/\D/g, ''))) !== want) return false;
    return squash(f.name).includes(surname);
  });
  if (hits.length === 1) return hits[0];
  const active = hits.filter((f) => /active/i.test(f.status ?? ''));
  return active.length === 1 ? active[0] : null;
}

/**
 * Sum itemized transactions by schedule. Amended reports can repeat a transaction number,
 * so each transaction number is counted once (the amended row wins, then the latest date).
 */
export function aggregateTransactions(rows) {
  const byTrans = new Map();
  let anonymous = 0;
  for (const r of rows) {
    const key = r.trans ? `${r.filing ?? ''}|${r.sched ?? ''}|${r.trans}` : `anon-${anonymous++}`;
    const prev = byTrans.get(key);
    if (!prev) { byTrans.set(key, r); continue; }
    const better = (r.amend === 'Y' && prev.amend !== 'Y') || (r.amend === prev.amend && String(r.date ?? '') > String(prev.date ?? ''));
    if (better) byTrans.set(key, r);
  }
  const sched = new Map();
  let latest = null;
  for (const r of byTrans.values()) {
    const amt = Number(r.amount);
    if (!Number.isFinite(amt)) continue;
    const k = r.sched ?? '?';
    const s = sched.get(k) ?? { abbrev: k, desc: r.schedDesc ?? k, total: 0, count: 0 };
    s.total += amt;
    s.count += 1;
    sched.set(k, s);
    if (r.date && (!latest || r.date > latest)) latest = r.date;
  }
  const schedules = [...sched.values()].map((s) => ({ ...s, total: Math.round(s.total * 100) / 100 })).sort((a, b) => a.abbrev.localeCompare(b.abbrev));
  return { schedules, transactions: [...byTrans.values()].length, rowsRead: rows.length, latestDate: latest };
}

/** Normalize a raw Socrata disclosure row using the column map. */
export function disclosureRow(raw, map) {
  const g = (k) => raw?.[map[k]?.field];
  return {
    trans: g('TRANS_NUMBER') ?? null,
    filing: g('FILING_DESC') ?? null,
    amend: String(g('R_AMEND') ?? '').toUpperCase() === 'Y' ? 'Y' : 'N',
    sched: g('FILING_SCHED_ABBREV') ?? null,
    schedDesc: g('FILING_SCHED_DESC') ?? null,
    amount: g('ORG_AMT'),
    date: isoDate(g('SCHED_DATE')),
  };
}

export function filerRow(raw, map) {
  const g = (k) => raw?.[map[k]?.field];
  return {
    id: g('FILER_ID') !== undefined ? String(g('FILER_ID')) : null,
    name: g('FILER_NAME') ?? null,
    compliance: g('COMPLIANCE_TYPE_DESC') ?? null,
    filerType: g('FILER_TYPE_DESC') ?? null,
    status: g('FILER_STATUS') ?? null,
    office: g('OFFICE_DESC') ?? null,
    district: g('DISTRICT') ?? null,
  };
}
