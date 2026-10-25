// Central configuration: environment keys, fixture mode, project paths, election constants.
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Absolute project root (works locally and inside a Vercel function bundle). */
export const ROOT = (() => {
  const fromModule = path.resolve(here, '..');
  if (fs.existsSync(path.join(fromModule, 'data'))) return fromModule;
  return process.cwd();
})();

export const paths = {
  // DATA_DIR lets tests and the build scripts write somewhere other than /data.
  data: (...p) => path.join(process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data'), ...p),
  fixtures: (...p) => path.join(ROOT, 'fixtures', ...p),
};

export function env(name) {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : '';
}

/** FIXTURES=1 makes every client read /fixtures/*.json instead of the network. */
export function isFixtureMode() {
  const v = env('FIXTURES').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export const keys = {
  civic: () => env('GOOGLE_CIVIC_API_KEY'),
  dataGov: () => env('DATA_GOV_API_KEY'),
  nysenate: () => env('NYSENATE_API_KEY'),
  openstates: () => env('OPENSTATES_API_KEY'),
};

/** The election this deployment targets. Override with ELECTION_DATE (YYYY-MM-DD). */
export function electionDate() {
  return env('ELECTION_DATE') || '2026-11-03';
}

/** Federal election cycle (FEC two-year period ending in the election year). */
export function electionCycle() {
  const y = Number(electionDate().slice(0, 4));
  return y % 2 === 0 ? y : y + 1;
}

/** NY legislative session year (Open Legislation uses the odd first year). */
export function nySessionYear() {
  const fromEnv = Number(env('NY_SESSION'));
  if (fromEnv) return fromEnv % 2 === 1 ? fromEnv : fromEnv - 1;
  const y = Number(electionDate().slice(0, 4));
  return y % 2 === 1 ? y : y - 1;
}

/** Optional link (e.g. GitHub issues page) where visitors can report an error. */
export function reportErrorUrl() {
  const v = env('REPORT_ERROR_URL');
  return /^https:\/\//.test(v) || /^mailto:/.test(v) ? v : '';
}

export function keyStatus() {
  return {
    googleCivic: Boolean(keys.civic()),
    dataGov: Boolean(keys.dataGov()),
    nysenate: Boolean(keys.nysenate()),
    openstates: Boolean(keys.openstates()),
  };
}
