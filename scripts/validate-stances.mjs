#!/usr/bin/env node
// Validate researched position files.  node scripts/validate-stances.mjs [file ...]
// With no arguments, checks every /data/stances/*.json. Each file is checked against the writing
// rules and against the researched ballot file of the same name in /data/ballots, so every entry
// must name a candidate in that contest. Exits 1 on errors; warnings are printed.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from '../lib/config.js';
import { validateStances } from '../lib/validate-stances.js';

const dir = paths.data('stances');
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => f.endsWith('.json')).map((f) => paths.data('stances', f));

if (!files.length) console.log('No positions files in data/stances.');

function readJson(file) {
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { error: err.code === 'ENOENT' ? 'file not found' : `not valid JSON (${err.message})` };
  }
}

let bad = 0;
for (const file of files) {
  const name = path.basename(file);
  const stances = readJson(file);
  if (stances.error) {
    console.error(`✗ ${name}: ${stances.error}`);
    bad += 1;
    continue;
  }
  const seedFile = paths.data('ballots', name);
  const seed = readJson(seedFile);
  if (seed.error) {
    console.error(`✗ ${name}: can’t check candidates against data/ballots/${name} (${seed.error})`);
    bad += 1;
    continue;
  }
  const r = validateStances(stances.value, seed.value);
  const s = r.stats;
  console.log(`${r.ok ? '✓' : '✗'} ${name}: ${s.candidates} candidates (${s.complete ?? 0} complete), ${s.stances} positions, ${s.racesShown ?? 0} races ready to show`);
  for (const e of r.errors) console.log(`   error: ${e}`);
  for (const w of r.warnings.slice(0, 50)) console.log(`   warning: ${w}`);
  if (r.warnings.length > 50) console.log(`   … ${r.warnings.length - 50} more warnings`);
  if (!r.ok) bad += 1;
}
process.exit(bad ? 1 : 0);
