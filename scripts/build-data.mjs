#!/usr/bin/env node
// Run every data build (federal votes, New York, then outside spending), then validate the seed ballots.
// Each step runs even if an earlier one fails; the exit code is non-zero if any failed.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const steps = ['scripts/build-votes.mjs', 'scripts/build-nysenate.mjs', 'scripts/build-nymoney.mjs', 'scripts/build-outside.mjs', 'scripts/validate-seed.mjs'];
let failed = 0;
for (const step of steps) {
  console.log(`\n=== ${step} ===`);
  const r = spawnSync(process.execPath, [step], { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (r.status !== 0) { failed += 1; console.error(`${step} exited with ${r.status}`); }
}
process.exit(failed ? 1 : 0);
