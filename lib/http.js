// Defensive HTTP helper: timeouts, retries with exponential backoff on 429/5xx,
// Retry-After support, and URL redaction so query strings (which can carry
// addresses or API keys) never appear in errors or logs.

export class HttpError extends Error {
  constructor(message, { status = 0, url = '', label = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url; // already redacted
    this.label = label;
  }
}

/** Strip query string and fragment. Used for every log line and error message. */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '[url]';
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseRetryAfter(value) {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return null;
}

export function backoffMs(attempt, base = 400) {
  const exp = base * 2 ** attempt;
  return exp + Math.floor(Math.random() * base);
}

/**
 * Fetch and parse JSON.
 * @param {string} url
 * @param {{method?: string, headers?: Record<string,string>, body?: any, timeoutMs?: number,
 *          retries?: number, label?: string, maxWaitMs?: number, fetchImpl?: typeof fetch,
 *          allow404?: boolean, raw?: boolean}} [opts]
 */
export async function fetchJson(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 8000,
    retries = 2,
    label = '',
    maxWaitMs = 5000,
    fetchImpl = globalThis.fetch,
    allow404 = false,
    raw = false,
  } = opts;
  const safeUrl = redactUrl(url);
  const name = label || safeUrl;
  let attempt = 0;
  for (;;) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { accept: raw ? '*/*' : 'application/json', 'user-agent': 'BallotScout/1.0 (+nonpartisan voter guide)', ...headers },
        body,
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (attempt < retries) {
        await sleep(Math.min(backoffMs(attempt), maxWaitMs));
        attempt += 1;
        continue;
      }
      const why = err?.name === 'AbortError' ? 'timed out' : 'network error';
      throw new HttpError(`${name}: ${why}`, { status: 0, url: safeUrl, label });
    }
    try {
      if (res.ok) {
        if (raw) return Buffer.from(await res.arrayBuffer());
        const text = await res.text();
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          throw new HttpError(`${name}: response was not JSON`, { status: res.status, url: safeUrl, label });
        }
      }
      if (res.status === 404 && allow404) return null;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < retries) {
        const wait = parseRetryAfter(res.headers?.get?.('retry-after')) ?? backoffMs(attempt);
        await sleep(Math.min(wait, maxWaitMs));
        attempt += 1;
        continue;
      }
      throw new HttpError(`${name}: HTTP ${res.status}`, { status: res.status, url: safeUrl, label });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Build a URL with query params, skipping empty values; arrays repeat the key. */
export function buildUrl(base, params = {}) {
  const u = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    if (Array.isArray(v)) v.forEach((item) => u.searchParams.append(k, String(item)));
    else u.searchParams.set(k, String(v));
  }
  return u.toString();
}
