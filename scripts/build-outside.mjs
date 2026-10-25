#!/usr/bin/env node
// Build /data/fec/outside.json: outside spending (independent expenditures) for and against every
// federal candidate in the researched ballot files, from the FEC, for the current and previous
// two-year cycles. Each spender is tagged with its FEC committee type, so super PACs are shown apart
// from party committees and other groups. See lib/outside.js for how the figures are combined.
//
//   DATA_GOV_API_KEY=... node scripts/build-outside.mjs
// Env: OUTSIDE_CYCLES (default "<cycle>,<cycle-2>", e.g. 2026,2024), OUTSIDE_PAUSE_MS (default 300).
import fs from 'node:fs';
import path from 'node:path';
import { sleep } from '../lib/http.js';
import { paths, electionCycle, env, keys, isFixtureMode } from '../lib/config.js';
import { readJsonFile, writeJsonFile } from '../lib/files.js';
import { isPlaceholderSeed } from '../lib/seed.js';
import { validateSeed } from '../lib/validate.js';
import { officeKey } from '../lib/order.js';
import { resolveFecCandidate, getIeTotals, getIeByCommitteeAll, getIeNotices, getCommitteeTypes } from '../lib/fec.js';
import { outsideKey, summarizeCycle, fecOutsideLinks, OUTSIDE_SOURCE } from '../lib/outside.js';

const log = (...a) => console.log(`[build-outside ${new Date().toISOString().slice(11, 19)}]`, ...a);
const CYCLE = electionCycle();
const CYCLES = (env('OUTSIDE_CYCLES') || `${CYCLE},${CYCLE - 2}`).split(',').map((s) => Number(s.trim())).filter(Boolean);
const PAUSE = Number(env('OUTSIDE_PAUSE_MS') || 300);

export function federalCandidates() {
  const dir = paths.data('ballots');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  const list = [];
  for (const f of files) {
    const seed = readJsonFile(path.join(dir, f));
    if (!seed || isPlaceholderSeed(seed) || !validateSeed(seed).ok) continue;
    const state = String(f.split('-')[0]).toUpperCase();
    for (const c of seed.contests ?? []) {
      const ok = officeKey(c.office, c);
      if (ok !== 'us-house' && ok !== 'us-senate') continue;
      for (const p of c.candidates ?? []) list.push({ name: p.name, fecIds: p.ids?.fec ?? null, state, officeKey: ok, district: c.district, contestId: c.id });
    }
  }
  return list;
}

async function candidateEntry(c) {
  const base = { name: c.name, contestId: c.contestId };
  const { candidateId, matchedBy } = await resolveFecCandidate({ ...c, cycle: CYCLE });
  if (!candidateId) return { ...base, status: 'not-found', fecCandidateId: null, cycles: {}, links: [] };
  const office = c.officeKey === 'us-senate' ? 'senate' : 'house';
  const cycles = {};
  for (const cycle of CYCLES) {
    const totals = await getIeTotals(candidateId, cycle);
    await sleep(PAUSE);
    const byCommittee = await getIeByCommitteeAll(candidateId, cycle, office);
    await sleep(PAUSE);
    // Notices matter for the cycle still being reported; past cycles are fully processed.
    const notices = cycle === CYCLE ? await getIeNotices(candidateId, cycle) : null;
    if (notices) await sleep(PAUSE);
    const ids = [...byCommittee.map((r) => r.committee_id), ...(notices ?? []).filter((r) => !r?.committee?.committee_type).map((r) => r.committee_id)];
    const committees = ids.length ? await getCommitteeTypes(ids) : {};
    cycles[cycle] = summarizeCycle({ cycle, totals, byCommittee, committees, notices });
  }
  return {
    ...base,
    status: 'ok',
    fecCandidateId: candidateId,
    matchedBy,
    cycles,
    links: [
      { label: 'Candidate page on FEC.gov', url: `https://www.fec.gov/data/candidate/${candidateId}/` },
      ...fecOutsideLinks(candidateId, CYCLES),
    ],
  };
}

async function main() {
  if (!isFixtureMode() && !keys.dataGov()) {
    log('DATA_GOV_API_KEY is not set; skipping (the Money tab shows FEC links until this runs).');
    return;
  }
  const out = paths.data('fec', 'outside.json');
  const prev = readJsonFile(out);
  const list = federalCandidates();
  log(`${list.length} federal candidates, cycles ${CYCLES.join(', ')}`);
  const candidates = {};
  let ok = 0;
  let failed = 0;
  for (const c of list) {
    const k = outsideKey(c);
    try {
      candidates[k] = await candidateEntry(c);
      if (candidates[k].status === 'ok') ok += 1;
    } catch (err) {
      failed += 1;
      log(`  ${c.name} (${c.contestId}): ${err.message}`);
      // Keep yesterday's figures rather than dropping a candidate on a transient error.
      candidates[k] = prev?.candidates?.[k] ? { ...prev.candidates[k], stale: true } : { name: c.name, contestId: c.contestId, status: 'error', fecCandidateId: null, cycles: {}, links: [] };
    }
  }
  writeJsonFile(out, {
    builtAt: new Date().toISOString(),
    source: OUTSIDE_SOURCE,
    cycles: CYCLES,
    note: 'Totals are from the FEC’s processed reports. 24- and 48-hour reports are summed separately (latest version of each, memo entries excluded) because they usually reappear on the next regular report.',
    candidates,
  }, { pretty: true });
  log(`wrote ${out}: ${ok} matched, ${list.length - ok - failed} without a single FEC match, ${failed} errors`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
