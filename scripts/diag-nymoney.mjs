// Diagnostic (temporary branch): download the raw inputs the committee matching needs, so the
// rules can be calibrated offline. Writes gzipped JSON to diagnostics/raw/.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fetchJson, buildUrl, sleep } from '../lib/http.js';
import { DATASETS, datasetLinks, mapColumns } from '../lib/nymoney.js';

const PAGE = 50000;
const info = { at: new Date().toISOString(), steps: [] };
const get = (url) => fetchJson(url, { label: 'data.ny.gov', timeoutMs: 300000, retries: 4, maxWaitMs: 60000 });
async function queryAll(id, params) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await get(buildUrl(datasetLinks(id).resource, { ...params, $limit: PAGE, $offset: offset }));
    out.push(...rows);
    if (rows.length < PAGE) break;
    await sleep(250);
  }
  return out;
}
async function step(name, fn) {
  const t = Date.now();
  try {
    const v = await fn();
    info.steps.push({ name, ms: Date.now() - t, rows: Array.isArray(v) ? v.length : null });
    return v;
  } catch (err) {
    info.steps.push({ name, ms: Date.now() - t, error: err.message });
    return null;
  }
}
const save = (name, v) => fs.writeFileSync(`diagnostics/raw/${name}.json.gz`, zlib.gzipSync(JSON.stringify(v)));
fs.mkdirSync('diagnostics/raw', { recursive: true });

const fcols = await get(datasetLinks(DATASETS.filers).columns);
const dcols = await get(datasetLinks(DATASETS.disclosures).columns);
info.filerColumnTypes = fcols.map((c) => [c.name, c.fieldName, c.dataTypeName]);
info.disclosureColumnTypes = dcols.map((c) => [c.name, c.fieldName, c.dataTypeName]);
const fc = mapColumns(fcols, ['FILER_ID', 'FILER_NAME', 'COMPLIANCE_TYPE_DESC', 'FILER_TYPE_DESC', 'FILER_STATUS', 'COMMITTEE_TYPE_DESC', 'OFFICE_DESC', 'DISTRICT', 'COUNTY_DESC']).map;
const dc = mapColumns(dcols, ['FILER_ID', 'CAND_COMM_NAME', 'ELECTION_YEAR', 'OFFICE_DESC', 'DISTRICT', 'COUNTY_DESC']).map;
const f = (k) => fc[k].field;
const d = (k) => dc[k].field;
const lit = (col, v) => (col.type === 'number' ? String(Number(v)) : `'${v}'`);

const groups = await step('groups', () => queryAll(DATASETS.disclosures, {
  $select: `${d('FILER_ID')}, ${d('CAND_COMM_NAME')}, ${d('OFFICE_DESC')}, ${d('DISTRICT')}, count(*) as n`,
  $where: `${d('ELECTION_YEAR')} in (${['2025', '2026'].map((y) => lit(dc.ELECTION_YEAR, y)).join(', ')})`,
  $group: `${d('FILER_ID')}, ${d('CAND_COMM_NAME')}, ${d('OFFICE_DESC')}, ${d('DISTRICT')}`,
  $order: `${d('FILER_ID')}, ${d('CAND_COMM_NAME')}, ${d('OFFICE_DESC')}, ${d('DISTRICT')}`,
}));
if (groups) save('groups', groups);
const groupsByCounty = await step('groupsCounty', () => queryAll(DATASETS.disclosures, {
  $select: `${d('FILER_ID')}, ${d('COUNTY_DESC')}, count(*) as n`,
  $where: `${d('ELECTION_YEAR')} in (${['2025', '2026'].map((y) => lit(dc.ELECTION_YEAR, y)).join(', ')})`,
  $group: `${d('FILER_ID')}, ${d('COUNTY_DESC')}`,
  $order: `${d('FILER_ID')}, ${d('COUNTY_DESC')}`,
}));
if (groupsByCounty) save('groups-county', groupsByCounty);
const sel = ['FILER_ID', 'FILER_NAME', 'COMPLIANCE_TYPE_DESC', 'FILER_TYPE_DESC', 'FILER_STATUS', 'COMMITTEE_TYPE_DESC', 'OFFICE_DESC', 'DISTRICT', 'COUNTY_DESC'].map(f).join(',');
const committees = await step('committees', () => queryAll(DATASETS.filers, { $select: sel, $where: `upper(${f('COMPLIANCE_TYPE_DESC')}) like '%COMMITTEE%'` }));
if (committees) save('committees', committees);
const candidates = await step('candidates', () => queryAll(DATASETS.filers, { $select: sel, $where: `upper(${f('COMPLIANCE_TYPE_DESC')}) like '%CANDIDATE%'` }));
if (candidates) save('candidates', candidates);
// Timing probe: one large committee's rows (Friends for Kathy Hochul) as the build would fetch them.
await step('hochulRows', () => queryAll(DATASETS.disclosures, {
  $select: ['FILER_ID', 'ELECTION_YEAR', 'CAND_COMM_NAME'].map(d).join(','),
  $where: `${d('FILER_ID')} = ${lit(dc.FILER_ID, '16851')} AND ${d('ELECTION_YEAR')} in (${['2025', '2026'].map((y) => lit(dc.ELECTION_YEAR, y)).join(', ')})`,
}));
fs.writeFileSync('diagnostics/raw/info.json', JSON.stringify(info, null, 2));
console.log(JSON.stringify(info.steps));
