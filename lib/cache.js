// Small in-memory LRU with TTL, plus a memoize helper that de-duplicates
// concurrent requests. Lives only as long as the serverless instance.
import { createHash } from 'node:crypto';

export class LRU {
  constructor(max = 500) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp && hit.exp < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }
  has(key) {
    return this.get(key) !== undefined;
  }
  set(key, value, ttlMs = 0) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, exp: ttlMs ? Date.now() + ttlMs : 0, at: Date.now() });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    return value;
  }
  delete(key) {
    this.map.delete(key);
  }
  clear() {
    this.map.clear();
  }
  get size() {
    return this.map.size;
  }
}

const shared = new LRU(2000);
const inflight = new Map();

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Return a cached value or compute it once. Failures are not cached.
 * Keys must never contain a raw street address; use hashKey() for those.
 */
export async function cached(key, ttlMs, fn, cache = shared) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const value = await fn();
      if (value !== undefined) cache.set(key, value, ttlMs);
      return value;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, p);
  return p;
}

/** SHA-256 hex of a string (used to key address-derived data without storing the address). */
export function hashKey(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

export function clearSharedCache() {
  shared.clear();
}
