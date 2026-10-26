#!/usr/bin/env node
// Build /data/ny/money-<cycle>.json: each New York State candidate on the seed ballot, linked to the
// committees that file their campaign money in the NYS Board of Elections data, with itemized
// transactions summed by schedule from the disclosure data (data.ny.gov, no key required).
//
// Transactions are filed by a candidate's committee, not by the candidate's own filer record. So:
//   1. one grouped query lists every filer with disclosure rows in the years covered;
//   2. the filer data gives each committee's type and status, and each candidate's registrations;
//   3. lib/nymoney.js linkCandidates() ties candidates to committees (the rules are documented there);
//   4. each linked candidate's committees' transactions are read and summed.
//
//   node scripts/build-nymoney.mjs
// Env: NY_MONEY_YEARS (default "<cycle-1>,<cycle>", e.g. 2025,2026), NY_SOCRATA_APP_TOKEN (optional,
//      raises Socrata's rate limit), NY_SOCRATA_BASE (tests only).
import fs from 'node:fs';
import path from 'node:path';
import { fetchJson, buildUrl, sleep } from '../lib/http.js';
import { paths, electionCycle, env } from '../lib/config.js';
import { readJsonFile, writeJsonFile } from '../lib/files.js';
import { isPlaceholderSeed } from '../lib/seed.js';
import { validateSeed } from '../lib/validate.js';
import {
  NY_SOCRATA, DATASETS, REQUIRED, OPTIONAL, GROUP_FIELDS, TRANSACTION_FIELDS, datasetLinks, mapColumns, soqlLiteral,
  linkCandidates, aggregateTransactions, disclosureRow, filerRow, groupRow, moneyKey, officeClass,
} from '../lib/nymoney.js';

const log = (...a) => console.log(`[build-nymoney ${new Date().toISOString().slice(11, 19)}]`, ...a);
const CYCLE = electionCycle();
const YEARS = (env('NY_MONEY_YEARS') || `${CYCLE - 1},${CYCLE}`).split(',').map((s) => s.trim()).filter(Boolean);
const PAGE = 50000;
const headers = env('NY_SOCRATA_APP_TOKEN') ? { 'X-App-Token': env('NY_SOCRATA_APP_TOKEN') } : {};

async function get(url) {
  return fetchJson(url, { headers, label: 'data.ny.gov', timeoutMs: 180000, retries: 4, maxWaitMs: 60000 });
}

async function columns(id) {
  return get(datasetLinks(id).columns);
}

/** Every page of a query. Pass a $order so pages don't overlap or skip rows. */
async function queryAll(id, params) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await get(buildUrl(datasetLinks(id).resource, { ...params, $limit: PAGE, $offset: offset }));
    if (!Array.isArray(rows)) throw new Error('unexpected Socrata response');
    out.push(...rows);
    if (rows.length < PAGE) break;
    await sleep(250);
  }
  return out;
}

function seedCandidates() {
  const dir = paths.data('ballots');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^ny-.*\.json$/i.test(f)) : [];
  const list = [];
  for (const f of files) {
    const seed = readJsonFile(path.join(dir, f));
    if (!seed || isPlaceholderSeed(seed) || !validateSeed(seed).ok) continue;
    for (const c of seed.contests ?? []) {
      if (c.level === 'federal' || !officeClass(c.office)) continue;
      for (const p of c.candidates ?? []) list.push({ name: p.name, office: c.office, district: c.district, level: c.level, county: c.county ?? null, contest: c.id });
    }
  }
  return list;
}

async function main() {
  const out = paths.data('ny');
  const metaFile = path.join(out, 'meta.json');
  const meta = readJsonFile(metaFile) ?? { schemaVersion: 1 };
  const candidates = seedCandidates();
  if (!candidates.length) {
    log('No researched New York seed with state candidates; nothing to do.');
    return;
  }
  log(`${candidates.length} state-level candidates; filing years ${YEARS.join(', ')}`);

  const fc = mapColumns(await columns(DATASETS.filers), [...REQUIRED.filers, ...OPTIONAL.filers]);
  const dc = mapColumns(await columns(DATASETS.disclosures), REQUIRED.disclosures);
  const missing = [...fc.missing.filter((k) => !OPTIONAL.filers.includes(k)), ...dc.missing];
  if (missing.length) {
    const why = `columns not found: ${missing.join(', ')}`;
    log(`Skipping: ${why}`);
    meta.nyMoney = { status: 'unavailable', lastUpdated: new Date().toISOString(), error: why };
    writeJsonFile(metaFile, meta, { pretty: true });
    return;
  }
  const ff = (k) => fc.map[k].field;
  const df = (k) => dc.map[k].field;
  const yr = dc.map.ELECTION_YEAR;
  const inYears = `${yr.field} in (${YEARS.map((y) => soqlLiteral(yr, y)).join(', ')})`;

  // Registered candidates (their office and district) and committees (their type and status).
  const filerSelect = [...REQUIRED.filers, ...OPTIONAL.filers].filter((k) => fc.map[k]).map(ff).join(',');
  const compliance = ff('COMPLIANCE_TYPE_DESC');
  const filers = (await queryAll(DATASETS.filers, { $select: filerSelect, $where: `upper(${compliance}) like '%CANDIDATE%'`, $order: ':id' })).map((r) => filerRow(r, fc.map));
  const committees = (await queryAll(DATASETS.filers, { $select: filerSelect, $where: `upper(${compliance}) like '%COMMITTEE%'`, $order: ':id' })).map((r) => filerRow(r, fc.map));
  // Every filer with disclosure rows in these years, with the name and office on its filings.
  const groupCols = GROUP_FIELDS.map(df).join(', ');
  const groups = (await queryAll(DATASETS.disclosures, { $select: `${groupCols}, count(*) as n`, $where: inYears, $group: groupCols, $order: groupCols })).map((r) => groupRow(r, dc.map));
  log(`${filers.length} candidate filers, ${committees.length} committees; ${new Set(groups.map((g) => g.id)).size} filers filed for ${YEARS.join(', ')}`);

  const { links, unmatched: problems } = linkCandidates(candidates, { filers, committees, groups });
  const who = (c) => ({ name: c.name, office: c.office, district: c.district ?? null });
  const unmatched = problems.map((u) => ({ ...who(candidates[u.index]), code: u.code, reason: u.reason }));
  const result = {};
  const fid = dc.map.FILER_ID;
  for (const [i, link] of links.entries()) {
    if (!link) continue;
    const c = candidates[i];
    const where = `${fid.field} in (${link.filerIds.map((id) => soqlLiteral(fid, id)).join(', ')}) AND ${inYears}`;
    try {
      const rows = await queryAll(DATASETS.disclosures, { $select: TRANSACTION_FIELDS.map(df).join(','), $where: where, $order: ':id' });
      const { filerIds, ...linked } = link;
      result[moneyKey(c)] = { ...linked, years: YEARS, ...aggregateTransactions(rows.map((r) => disclosureRow(r, dc.map))) };
    } catch (err) {
      log(`  ${c.name}: ${err.message}`);
      unmatched.push({ ...who(c), code: 'unavailable', reason: `The disclosure data didn't load: ${err.message}` });
    }
    await sleep(200);
  }
  const now = new Date().toISOString();
  writeJsonFile(path.join(out, `money-${CYCLE}.json`), {
    schemaVersion: 2,
    generatedAt: now,
    cycle: CYCLE,
    years: YEARS,
    source: { filers: datasetLinks(DATASETS.filers).landing, disclosures: datasetLinks(DATASETS.disclosures).landing, base: NY_SOCRATA },
    candidates: result,
    unmatched,
  });
  meta.nyMoney = { status: 'ok', lastUpdated: now, matched: Object.keys(result).length, unmatched: unmatched.length };
  writeJsonFile(metaFile, meta, { pretty: true });
  const reasons = Object.entries(unmatched.reduce((a, u) => ({ ...a, [u.code]: (a[u.code] ?? 0) + 1 }), {})).map(([k, n]) => `${k} ${n}`).join(', ');
  log(`Linked ${Object.keys(result).length} candidates to their committees; ${unmatched.length} not linked${reasons ? ` (${reasons})` : ''}.`);
}

main().catch((err) => {
  console.error(`[build-nymoney] failed: ${err.message}`);
  process.exit(1);
});
