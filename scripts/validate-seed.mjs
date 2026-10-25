#!/usr/bin/env node
// Validate seed ballot files.  node scripts/validate-seed.mjs [file ...]
// With no arguments, checks every /data/ballots/*.json.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../lib/config.js';
import { validateSeed } from '../lib/validate.js';
import { isPlaceholderSeed } from '../lib/seed.js';

const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : fs.readdirSync(paths.data('ballots')).filter((f) => f.endsWith('.json')).map((f) => paths.data('ballots', f));

let bad = 0;
for (const file of files) {
  let seed;
  try {
    seed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    console.error(`✗ ${path.basename(file)}: not valid JSON (${err.message})`);
    bad += 1;
    continue;
  }
  const r = validateSeed(seed);
  const tag = isPlaceholderSeed(seed) ? ' (placeholder)' : '';
  console.log(`${r.ok ? '✓' : '✗'} ${path.basename(file)}${tag}: ${r.stats.contests} contests, ${r.stats.candidates} candidates, ${r.stats.proposals} proposals`);
  for (const e of r.errors) console.log(`   error: ${e}`);
  for (const w of r.warnings.slice(0, 50)) console.log(`   warning: ${w}`);
  if (r.warnings.length > 50) console.log(`   … ${r.warnings.length - 50} more warnings`);
  if (!r.ok) bad += 1;
}
process.exit(bad ? 1 : 0);
