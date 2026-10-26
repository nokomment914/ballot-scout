// Diagnostic: why do NY candidate filers have no disclosure rows? Writes diagnostics/nymoney.json.
import fs from 'node:fs';
const BASE = 'https://data.ny.gov';
const F = '7x2g-h32p', D = 'e9ss-239a';
const get = async (u) => { const r = await fetch(u); const t = await r.text(); try { return JSON.parse(t); } catch { return { status: r.status, text: t.slice(0, 500) }; } };
const q = (id, params) => `${BASE}/resource/${id}.json?` + new URLSearchParams(params).toString();
const out = { at: new Date().toISOString() };
out.filerColumns = (await get(`${BASE}/api/views/${F}/columns.json`)).map?.((c) => ({ name: c.name, field: c.fieldName })) ?? null;
out.disclosureColumns = (await get(`${BASE}/api/views/${D}/columns.json`)).map?.((c) => ({ name: c.name, field: c.fieldName })) ?? null;
out.filerMeta = await get(`${BASE}/api/views/${F}.json`).then((v) => ({ name: v.name, rowsUpdatedAt: v.rowsUpdatedAt, viewLastModified: v.viewLastModified }));
out.disclosureMeta = await get(`${BASE}/api/views/${D}.json`).then((v) => ({ name: v.name, rowsUpdatedAt: v.rowsUpdatedAt, viewLastModified: v.viewLastModified, description: String(v.description ?? '').slice(0, 800) }));
const ff = (n) => out.filerColumns?.find((c) => c.name.toUpperCase().replace(/\s+/g, '_') === n || c.field.toUpperCase() === n)?.field;
const df = (n) => out.disclosureColumns?.find((c) => c.name.toUpperCase().replace(/\s+/g, '_') === n || c.field.toUpperCase() === n)?.field;
const fComp = ff('COMPLIANCE_TYPE_DESC'), fName = ff('FILER_NAME'), fId = ff('FILER_ID');
out.complianceTypes = await get(q(F, { $select: `${fComp}, count(*) as n`, $group: fComp, $limit: 50 }));
const ct = out.filerColumns?.find((c) => /committee.?type/i.test(c.name))?.field;
if (ct) out.committeeTypes = await get(q(F, { $select: `${ct}, count(*) as n`, $group: ct, $limit: 80 }));
const dYear = df('ELECTION_YEAR'), dId = df('FILER_ID');
out.disclosureYears = await get(q(D, { $select: `${dYear}, count(*) as n`, $group: dYear, $order: `${dYear} DESC`, $limit: 8 }));
out.people = {};
for (const s of ['HOCHUL', 'KRUEGER', 'SIMONE', 'LASHER', 'BLAKEMAN', 'DINAPOLI']) {
  const filers = await get(q(F, { $where: `upper(${fName}) like '%${s}%'`, $limit: 20 }));
  const rows = [];
  for (const f of (Array.isArray(filers) ? filers : []).slice(0, 8)) {
    const id = f[fId];
    const cnt = await get(q(D, { $select: `${dYear}, count(*) as n`, $where: `${dId} = '${id}'`, $group: dYear, $order: `${dYear} DESC`, $limit: 5 }));
    const cntNum = Array.isArray(cnt) && !cnt.length ? await get(q(D, { $select: `${dYear}, count(*) as n`, $where: `${dId} = ${Number(id)}`, $group: dYear, $order: `${dYear} DESC`, $limit: 5 })) : null;
    rows.push({ filer: f, disclosuresByYear: cnt, disclosuresByYearNumeric: cntNum });
  }
  out.people[s] = rows;
}
// Disclosure rows naming the candidate, whatever filer they're under (if a name column exists).
const dName = out.disclosureColumns?.find((c) => /cand.?comm|filer.?name|committee.?name/i.test(c.name))?.field;
out.disclosureNameField = dName ?? null;
if (dName) {
  out.byName = {};
  for (const s of ['HOCHUL', 'KRUEGER']) out.byName[s] = await get(q(D, { $select: `${dId}, ${dName}, ${dYear}, count(*) as n`, $where: `upper(${dName}) like '%${s}%' AND ${dYear} in ('2025','2026')`, $group: `${dId}, ${dName}, ${dYear}`, $limit: 20 }));
}
fs.mkdirSync('diagnostics', { recursive: true });
fs.writeFileSync('diagnostics/nymoney.json', JSON.stringify(out, null, 2));
console.log('done');
