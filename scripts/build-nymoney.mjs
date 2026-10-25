#!/usr/bin/env node
// Build /data/ny/money-<cycle>.json: each New York State candidate on the seed ballot, linked to
// their registered committee in the NYS Board of Elections filer data, with itemized
// transactions summed by schedule from the disclosure data (data.ny.gov, no key required).
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
import { NY_SOCRATA, DATASETS, REQUIRED, datasetLinks, mapColumns, soqlLiteral, matchFiler, aggregateTransactions, disclosureRow, filerRow, moneyKey, officeClass } from '../lib/nymoney.js';

const log = (...a) => console.log(`[build-nymoney ${new Date().toISOString().slice(11, 19)}]`, ...a);
const CYCLE = electionCycle();
const YEARS = (env('NY_MONEY_YEARS') || `${CYCLE - 1},${CYCLE}`).split(',').map((s) => s.trim()).filter(Boolean);
const PAGE = 50000;
const headers = env('NY_SOCRATA_APP_TOKEN') ? { 'X-App-Token': env('NY_SOCRATA_APP_TOKEN') } : {};

async function get(url) {
  return fetchJson(url, { headers, label: 'data.ny.gov', timeoutMs: 120000, retries: 4, maxWaitMs: 60000 });
}

async function columns(id) {
  return get(datasetLinks(id).columns);
}

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
      for (const p of c.candidates ?? []) list.push({ name: p.name, office: c.office, district: c.district, contest: c.id });
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

  const fc = mapColumns(await columns(DATASETS.filers), REQUIRED.filers);
  const dc = mapColumns(await columns(DATASETS.disclosures), REQUIRED.disclosures);
  if (fc.missing.length || dc.missing.length) {
    const why = `columns not found: ${[...fc.missing, ...dc.missing].join(', ')}`;
    log(`Skipping: ${why}`);
    meta.nyMoney = { status: 'unavailable', lastUpdated: new Date().toISOString(), error: why };
    writeJsonFile(metaFile, meta, { pretty: true });
    return;
  }

  const compliance = fc.map.COMPLIANCE_TYPE_DESC.field;
  const filers = (await queryAll(DATASETS.filers, {
    $select: REQUIRED.filers.map((k) => fc.map[k].field).join(','),
    $where: `upper(${compliance}) like '%CANDIDATE%'`,
  })).map((r) => filerRow(r, fc.map));
  log(`${filers.length} candidate filers`);

  const result = {};
  const unmatched = [];
  for (const c of candidates) {
    const filer = matchFiler(c, filers);
    if (!filer?.id) { unmatched.push(`${c.name} (${c.office}${c.district ? ` ${c.district}` : ''})`); continue; }
    const fid = dc.map.FILER_ID;
    const yr = dc.map.ELECTION_YEAR;
    const where = `${fid.field} = ${soqlLiteral(fid, filer.id)} AND ${yr.field} in (${YEARS.map((y) => soqlLiteral(yr, y)).join(', ')})`;
    try {
      const rows = await queryAll(DATASETS.disclosures, { $select: REQUIRED.disclosures.map((k) => dc.map[k].field).join(','), $where: where });
      result[moneyKey(c)] = { filer, years: YEARS, ...aggregateTransactions(rows.map((r) => disclosureRow(r, dc.map))) };
    } catch (err) {
      log(`  ${c.name}: ${err.message}`);
    }
    await sleep(200);
  }
  const now = new Date().toISOString();
  writeJsonFile(path.join(out, `money-${CYCLE}.json`), {
    schemaVersion: 1,
    generatedAt: now,
    cycle: CYCLE,
    years: YEARS,
    source: { filers: datasetLinks(DATASETS.filers).landing, disclosures: datasetLinks(DATASETS.disclosures).landing, base: NY_SOCRATA },
    candidates: result,
    unmatched,
  });
  meta.nyMoney = { status: 'ok', lastUpdated: now, matched: Object.keys(result).length, unmatched: unmatched.length };
  writeJsonFile(metaFile, meta, { pretty: true });
  log(`Linked ${Object.keys(result).length} candidates to committees; ${unmatched.length} not linked.`);
}

main().catch((err) => {
  console.error(`[build-nymoney] failed: ${err.message}`);
  process.exit(1);
});
