#!/usr/bin/env node
// Build /data/votes: federal roll-call indexes from Voteview + Congress.gov bill details.
//
//   DATA_GOV_API_KEY=... node scripts/build-votes.mjs
//
// Env:
//   VOTE_CONGRESSES          comma list, default: previous and current Congress (e.g. 118,119)
//   CONGRESS_CALLS_PER_HOUR  pacing for Congress.gov calls (default 900, stays under 1,000/hour)
//   CONGRESS_MAX_CALLS       max Congress.gov calls this run (default = CONGRESS_CALLS_PER_HOUR)
//   BUILD_MAX_MINUTES        stop fetching bill details after this many minutes (default 65)
//
// Bill details are cached in data/votes/bills.json between runs, so each nightly run only
// fetches bills it hasn't seen (newest votes first) and refreshes stale ones.
import fs from 'node:fs';
import path from 'node:path';
import { fetchJson, buildUrl, sleep } from '../lib/http.js';
import { parseCsv } from '../lib/csv.js';
import { paths, keys } from '../lib/config.js';
import { readJsonFile, writeJsonFile } from '../lib/files.js';
import { congressForDate, API as CONGRESS_API } from '../lib/congress.js';
import { parseBillKey } from '../lib/votes.js';
import {
  voteviewUrls, indexMembers, selectRollcalls, collectMemberVotes, billsToFetch,
  compactCongressBill, policyAreasFromVoteviewJson, rollcallFields,
} from '../lib/build/votes-build.js';

const log = (...a) => console.log(`[build-votes ${new Date().toISOString().slice(11, 19)}]`, ...a);
const OUT = paths.data('votes');
const current = congressForDate();
const CONGRESSES = (process.env.VOTE_CONGRESSES || `${current - 1},${current}`).split(',').map((s) => Number(s.trim())).filter(Boolean);
const PER_HOUR = Math.max(1, Number(process.env.CONGRESS_CALLS_PER_HOUR) || 900);
const MAX_CALLS = Number(process.env.CONGRESS_MAX_CALLS) || PER_HOUR;
const MAX_MINUTES = Number(process.env.BUILD_MAX_MINUTES) || 65;
const started = Date.now();

async function downloadText(url, { optional = false } = {}) {
  try {
    const buf = await fetchJson(url, { raw: true, timeoutMs: 180000, retries: 3, maxWaitMs: 30000, label: 'Voteview', allow404: optional });
    return buf ? buf.toString('utf8') : null;
  } catch (err) {
    if (optional) return null;
    throw err;
  }
}

async function main() {
  log(`Congresses ${CONGRESSES.join(', ')}`);
  const previousMeta = readJsonFile(path.join(OUT, 'meta.json'));
  const billsFile = readJsonFile(path.join(OUT, 'bills.json'));
  const bills = billsFile?.bills ?? {};
  const allKept = new Map();
  const memberVotes = new Map();
  const index = {};
  let rollcallTotal = 0;
  const voteviewPa = new Map();

  for (const congress of CONGRESSES) {
    const urls = voteviewUrls(congress);
    log(`Downloading Voteview members/rollcalls/votes for the ${congress}th Congress`);
    const membersCsv = await downloadText(urls.members);
    const rollcallsCsv = await downloadText(urls.rollcalls);
    const members = indexMembers(parseCsv(membersCsv), congress);
    const { kept, total } = selectRollcalls(parseCsv(rollcallsCsv), congress);
    rollcallTotal += total;
    log(`  ${members.size} members, ${total} roll calls, ${kept.size} substantive roll calls on bills`);
    for (const m of members.values()) {
      const prev = index[m.bioguide];
      index[m.bioguide] = { n: m.name, st: m.state, ch: m.chamber, d: m.district, c: [...new Set([...(prev?.c ?? []), congress])].sort() };
    }
    const votesCsv = await downloadText(urls.votes);
    parseCsv(votesCsv, { onRow: (row) => collectMemberVotes(row, congress, members, kept, memberVotes) });
    for (const [id, row] of kept) allKept.set(id, row);
    // Optional fallback for policy areas (field documented as JSON-only on Voteview).
    const json = await downloadText(urls.rollcallsJson, { optional: true });
    if (json) {
      try {
        for (const [k, pa] of policyAreasFromVoteviewJson(JSON.parse(json), congress)) voteviewPa.set(k, pa);
        log(`  Voteview JSON policy areas available for ${voteviewPa.size} bills`);
      } catch { log('  Voteview JSON rollcalls not parseable; skipping fallback'); }
    }
  }

  // Congress.gov bill details, paced to stay under the hourly budget.
  const queue = billsToFetch(allKept, bills);
  const apiKey = keys.dataGov();
  let calls = 0;
  let errors = 0;
  if (!apiKey) log('DATA_GOV_API_KEY not set: skipping Congress.gov bill details (votes will lack issue tags).');
  else {
    log(`${queue.length} bills need Congress.gov details; budget ${MAX_CALLS} calls at ${PER_HOUR}/hour`);
    const gap = Math.ceil(3_600_000 / PER_HOUR);
    for (const key of queue) {
      if (calls >= MAX_CALLS || Date.now() - started > MAX_MINUTES * 60_000) break;
      const b = parseBillKey(key);
      const t0 = Date.now();
      try {
        const json = await fetchJson(buildUrl(`${CONGRESS_API}/bill/${b.congress}/${b.type}/${b.number}`, { format: 'json', api_key: apiKey }), { label: 'Congress.gov', timeoutMs: 20000, retries: 3, maxWaitMs: 60000, allow404: true });
        bills[key] = compactCongressBill(json?.bill ?? null, new Date().toISOString());
      } catch (err) {
        errors += 1;
        log(`  ${key}: ${err.message}`);
        if (err.status === 403 || err.status === 401) { log('  Key rejected; stopping bill fetches.'); calls += 1; break; }
      }
      calls += 1;
      if (calls % 50 === 0) log(`  ${calls} calls so far`);
      const wait = gap - (Date.now() - t0);
      if (wait > 0) await sleep(wait);
    }
  }
  // Fallback policy areas for bills Congress.gov hasn't filled yet.
  let fallbackUsed = 0;
  for (const [key, pa] of voteviewPa) {
    if (!bills[key]) bills[key] = { t: null, pa, ps: 'voteview', f: null };
    else if (!bills[key].pa && !bills[key].gone) { bills[key].pa = pa; bills[key].ps = 'voteview'; }
    else continue;
    fallbackUsed += 1;
  }

  // Keep only bills referenced by the current roll-call window.
  const referenced = new Set([...allKept.values()].map((r) => r[6]));
  const keptBills = Object.fromEntries(Object.entries(bills).filter(([k]) => referenced.has(k)));
  const withPa = Object.values(keptBills).filter((b) => b.pa).length;

  // Write outputs.
  const now = new Date().toISOString();
  writeJsonFile(path.join(OUT, 'rollcalls.json'), { schemaVersion: 1, generatedAt: now, fields: rollcallFields(), rollcalls: Object.fromEntries(allKept) });
  writeJsonFile(path.join(OUT, 'bills.json'), { schemaVersion: 1, generatedAt: now, bills: keptBills });
  writeJsonFile(path.join(OUT, 'members-index.json'), { schemaVersion: 1, generatedAt: now, members: index });
  const memberDir = path.join(OUT, 'members');
  fs.mkdirSync(memberDir, { recursive: true });
  const written = new Set();
  for (const [bioguide, votes] of memberVotes) {
    const m = index[bioguide];
    writeJsonFile(path.join(memberDir, `${bioguide}.json`), { bioguide, name: m?.n ?? null, state: m?.st ?? null, votes });
    written.add(`${bioguide}.json`);
  }
  for (const f of fs.readdirSync(memberDir)) if (f.endsWith('.json') && !written.has(f)) fs.unlinkSync(path.join(memberDir, f));

  const meta = {
    schemaVersion: 1,
    status: 'ok',
    generatedAt: now,
    congresses: CONGRESSES,
    rollcallCount: allKept.size,
    rollcallsScanned: rollcallTotal,
    members: memberVotes.size,
    voteview: { downloadedAt: now, urls: CONGRESSES.map((c) => voteviewUrls(c).votes) },
    congressGov: {
      status: apiKey ? (withPa === referenced.size ? 'ok' : 'partial') : 'not-configured',
      lastRun: apiKey ? now : previousMeta?.congressGov?.lastRun ?? null,
      billsTotal: referenced.size,
      billsWithPolicyArea: withPa,
      voteviewFallbackPolicyAreas: fallbackUsed,
      calls,
      errors,
      remaining: Math.max(0, referenced.size - withPa),
    },
  };
  writeJsonFile(path.join(OUT, 'meta.json'), meta, { pretty: true });
  log(`Done: ${allKept.size} roll calls, ${memberVotes.size} members, ${withPa}/${referenced.size} bills with policy areas, ${calls} Congress.gov calls.`);
}

main().catch((err) => {
  console.error(`[build-votes] failed: ${err.message}`);
  process.exit(1);
});
