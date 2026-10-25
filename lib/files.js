// JSON file readers for precomputed data and fixtures, memoized per instance.
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

const memo = new Map();

/** Read and parse a JSON file; returns null when missing. Cached by absolute path + mtime. */
export function readJsonFile(absPath) {
  let stat;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return null;
  }
  const key = `${absPath}:${stat.mtimeMs}`;
  if (memo.has(key)) return memo.get(key);
  const value = JSON.parse(fs.readFileSync(absPath, 'utf8'));
  memo.set(key, value);
  if (memo.size > 800) memo.delete(memo.keys().next().value);
  return value;
}

export function readData(...segments) {
  return readJsonFile(paths.data(...segments));
}

/** Fixture files live in /fixtures/<name>.json. Names are restricted to safe characters. */
export function loadFixture(name) {
  const safe = String(name).replace(/[^a-zA-Z0-9._-]/g, '_');
  return readJsonFile(paths.fixtures(`${safe}.json`));
}

export function listDataDir(...segments) {
  try {
    return fs.readdirSync(paths.data(...segments));
  } catch {
    return [];
  }
}

/** Safe file-name segment for ids like bioguide ids, OCD person ids, member ids. */
export function safeSegment(id) {
  return String(id).replace(/^ocd-person\//, '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

export function writeJsonFile(absPath, value, { pretty = false } = {}) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, pretty ? `${JSON.stringify(value, null, 2)}\n` : JSON.stringify(value));
}
