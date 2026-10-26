// Diagnostic (temporary branch): run scripts/build-nymoney.mjs against live data.ny.gov with DATA_DIR
// in a temp folder, then write a compact report to diagnostics/nymoney-build.json (and the built file
// to diagnostics/money-2026.json for inspection).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nymoney-'));
fs.cpSync('data/ballots', path.join(tmp, 'ballots'), { recursive: true });
const started = Date.now();
const run = spawnSync(process.execPath, ['scripts/build-nymoney.mjs'], { env: { ...process.env, DATA_DIR: tmp }, encoding: 'utf8', maxBuffer: 256 << 20 });
const ms = Date.now() - started;
const report = { at: new Date().toISOString(), build: { exitCode: run.status, seconds: Math.round(ms / 1000), log: `${run.stdout ?? ''}${run.stderr ?? ''}`.split('\n').slice(-12) } };
fs.mkdirSync('diagnostics', { recursive: true });
const file = path.join(tmp, 'ny', 'money-2026.json');
if (fs.existsSync(file)) {
  process.env.DATA_DIR = tmp;
  const { isContributionSchedule, buildSummary } = await import('../lib/summary.js');
  const { stateMoney } = await import('../lib/statemoney.js');
  const money = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.copyFileSync(file, 'diagnostics/money-2026.json');
  const meta = JSON.parse(fs.readFileSync(path.join(tmp, 'ny', 'meta.json'), 'utf8'));
  const seed = JSON.parse(fs.readFileSync('data/ballots/ny-2026-general.json', 'utf8'));
  const { moneyKey } = await import('../lib/nymoney.js');
  const seedOf = new Map();
  for (const c of seed.contests) for (const p of c.candidates ?? []) seedOf.set(moneyKey({ office: c.office, district: c.district, name: p.name }), { contest: c, name: p.name });
  const entries = Object.entries(money.candidates);
  const reasons = {};
  for (const u of money.unmatched) reasons[u.code] = (reasons[u.code] ?? 0) + 1;
  report.linked = entries.length;
  report.unmatchedCount = money.unmatched.length;
  report.unmatchedByReason = reasons;
  report.meta = meta.nyMoney;
  report.linkedWithZeroTransactions = entries.filter(([, e]) => !e.transactions).map(([k]) => k);
  report.byMatchedBy = entries.reduce((a, [, e]) => ({ ...a, [e.matchedBy]: (a[e.matchedBy] ?? 0) + 1 }), {});
  const contributions = (e) => Math.round(e.schedules.filter(isContributionSchedule).reduce((s, x) => s + x.total, 0) * 100) / 100;
  const check = (key) => {
    const e = money.candidates[key];
    const sc = seedOf.get(key);
    let line = null;
    if (sc) {
      const m = stateMoney({ state: 'NY', level: sc.contest.level, name: sc.name, office: sc.contest.office, district: sc.contest.district, role: 'candidate' });
      line = buildSummary({ role: 'candidate', issueIds: ['housing'], money: { ...m, kind: 'state' }, votes: { items: [] }, stances: null }).lines[0].text;
    }
    return {
      key, name: sc?.name ?? null, filer: e.filer, committees: e.committees, filerFilings: e.filerFilings, matchedBy: e.matchedBy,
      transactions: e.transactions, rowsRead: e.rowsRead, latestDate: e.latestDate, contributionTotal: contributions(e),
      schedules: e.schedules.map((s) => `${s.abbrev} ${s.total} (${s.count})`), atAGlance: line,
    };
  };
  const named = ['hochul', 'krueger', 'dinapoli', 'blakeman', 'tony simone'];
  const keyFor = (needle) => entries.map(([k]) => k).find((k) => k.endsWith(needle) || k.includes(`|${needle}`) || k.split('|')[2].endsWith(needle));
  report.spotChecks = named.map((n) => {
    const k = keyFor(n);
    return k ? check(k) : { key: n, linked: false, unmatched: money.unmatched.filter((u) => u.name.toLowerCase().includes(n)) };
  });
  // Ten others, picked at random (seeded by the date so a rerun the same day picks the same ones).
  let seedNum = Number(report.at.slice(0, 10).replace(/-/g, ''));
  const rand = () => { seedNum = (seedNum * 1103515245 + 12345) % 2147483648; return seedNum / 2147483648; };
  const others = entries.map(([k]) => k).filter((k) => !named.some((n) => k.includes(n)));
  const picked = [];
  while (picked.length < 10 && others.length) picked.push(others.splice(Math.floor(rand() * others.length), 1)[0]);
  report.randomChecks = picked.map(check);
  report.unmatched = money.unmatched.map((u) => `${u.name} (${u.office}${u.district ? ` ${u.district}` : ''}): ${u.code} | ${u.reason}`);
}
fs.writeFileSync('diagnostics/nymoney-build.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify({ exitCode: report.build.exitCode, seconds: report.build.seconds, linked: report.linked, unmatched: report.unmatchedCount }));
