#!/usr/bin/env node
// Build /data/ny: New York legislature indexes for the current session.
//   NYSENATE_API_KEY=... OPENSTATES_API_KEY=... node scripts/build-nysenate.mjs
//
// 1. Open Legislation: members, every bill (sponsor, law section, status, sponsor-memo
//    fiscal note, Senate floor/committee votes, Governor's approval/veto messages).
//    First run lists all bills (full view, paged); later runs fetch only bills updated
//    since the last run. The working cache lives in .cache/ (kept by the GitHub Action's
//    cache step, not committed).
// 2. Open States: one API call finds the session's bulk CSV export; Assembly roll calls are
//    read from it. /people (a few calls) links Open States ids to Open Legislation members.
//
// Env: NY_SESSION (default from ELECTION_DATE, e.g. 2025), NY_FULL_REFRESH=1, NY_MAX_CALLS
//      (per-bill fetch budget, default 4000), NY_PAGE_SIZE (full listing page size, default 100).
import fs from 'node:fs';
import path from 'node:path';
import { fetchJson } from '../lib/http.js';
import { ROOT, paths, keys, nySessionYear } from '../lib/config.js';
import { readJsonFile, writeJsonFile, safeSegment } from '../lib/files.js';
import { openLegGet, openLegPages, normalizeMember, compactBill, basePrintNo } from '../lib/nysenate.js';
import { openStatesGet, pickSessionDownload } from '../lib/openstates.js';
import { unzip } from '../lib/unzip.js';
import { deriveNyOutputs, parseOpenStatesExport, joinOpenStatesPeople } from '../lib/build/ny-build.js';

const log = (...a) => console.log(`[build-ny ${new Date().toISOString().slice(11, 19)}]`, ...a);
const SESSION = nySessionYear();
const OUT = paths.data('ny');
const CACHE_DIR = path.join(process.env.BUILD_CACHE_DIR ? path.resolve(process.env.BUILD_CACHE_DIR) : path.join(ROOT, '.cache'), 'nysenate');
const CACHE_FILE = path.join(CACHE_DIR, `bills-${SESSION}.json`);
const MAX_CALLS = Number(process.env.NY_MAX_CALLS) || 4000;
const PAGE = Number(process.env.NY_PAGE_SIZE) || 100;
const FULL = /^(1|true)$/i.test(process.env.NY_FULL_REFRESH ?? '');
const JURISDICTION = 'ocd-jurisdiction/country:us/state:ny/government';

let calls = 0;

async function openLegislation(meta) {
  if (!keys.nysenate()) {
    log('NYSENATE_API_KEY not set: skipping Open Legislation.');
    return null;
  }
  const startedAt = new Date().toISOString();
  // Members (both chambers) for the session.
  const members = [];
  for await (const page of openLegPages(`/members/${SESSION}`, { full: true }, { limit: 1000, onCall: () => { calls += 1; } })) {
    for (const m of page.items) members.push(normalizeMember(m, SESSION));
  }
  log(`${members.length} members`);

  const cache = (!FULL && readJsonFile(CACHE_FILE)) || { session: SESSION, lastProcessed: null, pending: [], bills: {} };
  if (!cache.lastProcessed) {
    log(`Full bill listing for ${SESSION} (page size ${PAGE})…`);
    let n = 0;
    for await (const page of openLegPages(`/bills/${SESSION}`, { full: true }, { limit: PAGE, onCall: () => { calls += 1; } })) {
      for (const item of page.items) {
        const c = compactBill(item);
        if (c.p) cache.bills[c.p] = c;
      }
      n += page.items.length;
      if (n % 2000 < PAGE) log(`  ${n} / ${page.total} bills`);
    }
  } else {
    log(`Bills updated since ${cache.lastProcessed}…`);
    const from = cache.lastProcessed.slice(0, 19);
    const to = startedAt.slice(0, 19);
    const changed = new Set(cache.pending ?? []);
    for await (const page of openLegPages(`/bills/updates/${from}/${to}`, { type: 'processed' }, { limit: 1000, onCall: () => { calls += 1; } })) {
      for (const u of page.items) if (Number(u?.id?.session) === SESSION && u?.id?.basePrintNo) changed.add(basePrintNo(u.id.basePrintNo));
    }
    log(`  ${changed.size} bills to refresh`);
    const queue = [...changed];
    const done = new Set();
    for (const printNo of queue) {
      if (calls >= MAX_CALLS) break;
      try {
        const json = await openLegGet(`/bills/${SESSION}/${encodeURIComponent(printNo)}`, { view: 'no_fulltext' });
        calls += 1;
        if (json?.result) cache.bills[printNo] = compactBill(json.result);
        done.add(printNo);
      } catch (err) {
        calls += 1;
        log(`  ${printNo}: ${err.message}`);
      }
    }
    cache.pending = queue.filter((p) => !done.has(p));
    if (cache.pending.length) log(`  ${cache.pending.length} left for the next run (call budget reached)`);
  }
  cache.lastProcessed = startedAt;
  writeJsonFile(CACHE_FILE, cache);
  meta.openLegislation = { status: 'ok', lastUpdated: startedAt, bills: Object.keys(cache.bills).length, apiCalls: calls, pending: cache.pending?.length ?? 0 };
  return { members, bills: Object.values(cache.bills) };
}

async function openStates(meta) {
  if (!keys.openstates()) {
    log('OPENSTATES_API_KEY not set: skipping Open States (Assembly roll calls).');
    return null;
  }
  const sessionId = `${SESSION}-${SESSION + 1}`;
  const jur = await openStatesGet(`/jurisdictions/${JURISDICTION}`, { include: 'legislative_sessions' });
  const dl = pickSessionDownload(jur, sessionId, 'csv');
  if (!dl?.url) {
    log(`No CSV export listed for ${sessionId}.`);
    meta.openStates = { status: 'unavailable', lastUpdated: new Date().toISOString(), exportUpdatedAt: null, voteEvents: 0 };
    return null;
  }
  log(`Downloading Open States export for ${dl.session}…`);
  const zip = await fetchJson(dl.url, { raw: true, timeoutMs: 300000, retries: 3, maxWaitMs: 30000, label: 'Open States bulk export' });
  const files = unzip(zip, (name) => /_(votes|vote_people|vote_sources|bills|organizations)\.csv$/.test(name));
  const parsed = parseOpenStatesExport(files, { chamber: 'lower' });
  log(`  ${parsed.voteEvents} Assembly roll calls, ${parsed.byPerson.size} members`);

  const people = [];
  for (let page = 1; page <= 10; page += 1) {
    const res = await openStatesGet('/people', { jurisdiction: JURISDICTION, per_page: 50, page });
    people.push(...(res?.results ?? []));
    if (page >= Number(res?.pagination?.max_page ?? 1)) break;
  }
  log(`  ${people.length} current legislators from /people`);
  meta.openStates = { status: 'ok', lastUpdated: new Date().toISOString(), exportUpdatedAt: dl.updatedAt ?? null, exportUrl: dl.url, voteEvents: parsed.voteEvents };
  return { ...parsed, people, sessionId };
}

async function main() {
  const meta = readJsonFile(path.join(OUT, 'meta.json')) ?? {};
  meta.schemaVersion = 1;
  meta.session = SESSION;
  const leg = await openLegislation(meta).catch((err) => { log(`Open Legislation failed: ${err.message}`); meta.openLegislation = { ...(meta.openLegislation ?? {}), status: 'error', error: err.message }; return null; });
  const os = await openStates(meta).catch((err) => { log(`Open States failed: ${err.message}`); meta.openStates = { ...(meta.openStates ?? {}), status: 'error', error: err.message }; return null; });

  let members = leg?.members ?? readJsonFile(path.join(OUT, 'members-index.json'))?.members ?? [];
  if (os?.people?.length) members = joinOpenStatesPeople(members, os.people);

  if (leg) {
    const { memberFiles, bills, actions, signer } = deriveNyOutputs(leg.bills, members, SESSION, { extraBillIds: os?.billIds ?? new Set(), subjects: os?.subjects ?? new Map() });
    const dir = path.join(OUT, 'members');
    fs.mkdirSync(dir, { recursive: true });
    const keep = new Set();
    for (const [id, f] of memberFiles) {
      if (!f.sponsored.length && !f.votes.length && !members.some((m) => String(m.memberId) === id)) continue;
      writeJsonFile(path.join(dir, `${safeSegment(id)}.json`), f);
      keep.add(`${safeSegment(id)}.json`);
    }
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.json') && !keep.has(f)) fs.unlinkSync(path.join(dir, f));
    writeJsonFile(path.join(OUT, `bills-${SESSION}.json`), { schemaVersion: 1, session: SESSION, generatedAt: new Date().toISOString(), bills });
    writeJsonFile(path.join(OUT, `governor-actions-${SESSION}.json`), { schemaVersion: 1, session: SESSION, generatedAt: new Date().toISOString(), sessionSigner: signer, actions });
    log(`Wrote ${keep.size} member files, ${Object.keys(bills).length} bills, ${actions.length} Governor actions.`);
  }
  writeJsonFile(path.join(OUT, 'members-index.json'), { schemaVersion: 1, session: SESSION, generatedAt: new Date().toISOString(), members });

  if (os) {
    const dir = path.join(OUT, 'assembly');
    fs.mkdirSync(dir, { recursive: true });
    const keep = new Set();
    for (const [personId, votes] of os.byPerson) {
      const person = os.people.find((p) => p.id === personId);
      const file = `${safeSegment(personId)}.json`;
      writeJsonFile(path.join(dir, file), { personId, name: person?.name ?? os.names.get(personId) ?? null, district: person?.current_role?.district ?? null, chamber: 'lower', session: os.sessionId, votes });
      keep.add(file);
    }
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.json') && !keep.has(f)) fs.unlinkSync(path.join(dir, f));
    log(`Wrote ${keep.size} Assembly vote files.`);
  }

  meta.status = meta.openLegislation?.status === 'ok' || meta.openStates?.status === 'ok' ? 'ok' : (meta.status ?? 'not-built');
  meta.generatedAt = new Date().toISOString();
  writeJsonFile(path.join(OUT, 'meta.json'), meta, { pretty: true });
  log(`Done (${calls} Open Legislation calls).`);
  if (meta.openLegislation?.status === 'error' && meta.openStates?.status === 'error') process.exit(1);
}

main().catch((err) => {
  console.error(`[build-ny] failed: ${err.message}`);
  process.exit(1);
});
