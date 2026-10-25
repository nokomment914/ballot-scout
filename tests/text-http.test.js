import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripHtml, excerpt, extractMemoSection, FISCAL_HEADING, decodeEntities, ordinal, isoDate } from '../lib/text.js';
import { fetchJson, redactUrl, buildUrl, parseRetryAfter } from '../lib/http.js';
import { LRU, cached, hashKey } from '../lib/cache.js';
import { parseCsv } from '../lib/csv.js';
import { rewriteForSample } from '../lib/sample.js';

test('stripHtml and excerpt keep official wording verbatim', () => {
  const html = '<![CDATA[ <p><strong>Postal Service Reform Act of 2021</strong></p> <p>This bill addresses the finances &amp; operations of the USPS.</p> ]]>';
  assert.equal(stripHtml(html), 'Postal Service Reform Act of 2021\nThis bill addresses the finances & operations of the USPS.');
  const e = excerpt('one two three four five six seven eight nine ten', 20);
  assert.equal(e.truncated, true);
  assert.equal(e.text, 'one two three four…');
  assert.ok('one two three four five six seven eight nine ten'.startsWith(e.text.slice(0, -1)));
  assert.deepEqual(excerpt('short', 20), { text: 'short', truncated: false });
  assert.equal(decodeEntities('&sect;265.18 &#8212; &#x2019;'), '§265.18 — ’');
});

test('extractMemoSection pulls the fiscal note out of a NY sponsor memo', () => {
  const memo = `BILL NUMBER: S1234\n\nSPONSOR: EXAMPLE\n\nPURPOSE:\nTo do a thing.\n\nJUSTIFICATION:\nBecause reasons.\n\nFISCAL IMPLICATIONS FOR STATE AND LOCAL GOVERNMENTS:\nMinimal cost to the state,\nabsorbed within existing appropriations.\n\nEFFECTIVE DATE:\nImmediately.`;
  assert.equal(extractMemoSection(memo, FISCAL_HEADING), 'Minimal cost to the state,\nabsorbed within existing appropriations.');
  assert.equal(extractMemoSection(memo, 'JUSTIFICATION'), 'Because reasons.');
  assert.equal(extractMemoSection('no headings here', FISCAL_HEADING), '');
  assert.equal(extractMemoSection('', FISCAL_HEADING), '');
});

test('misc text helpers', () => {
  assert.equal(ordinal(119), '119th');
  assert.equal(ordinal(121), '121st');
  assert.equal(ordinal(112), '112th');
  assert.equal(ordinal(123), '123rd');
  assert.equal(isoDate('2025-01-16T11:00:00-05:00'), '2025-01-16');
  assert.equal(isoDate(null), null);
});

test('redactUrl strips query strings (addresses, API keys)', () => {
  assert.equal(redactUrl('https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress?address=350+5th+Ave&format=json'), 'https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress');
  assert.equal(redactUrl('https://api.open.fec.gov/v1/candidates/?api_key=SECRET'), 'https://api.open.fec.gov/v1/candidates/');
  assert.equal(redactUrl('not a url'), '[url]');
  assert.equal(buildUrl('https://x.test/a', { a: 1, b: '', c: null, d: ['x', 'y'] }), 'https://x.test/a?a=1&d=x&d=y');
  assert.equal(parseRetryAfter('2'), 2000);
});

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = responses.shift();
    if (r instanceof Error) throw r;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, headers: { get: (k) => (r.headers ?? {})[k.toLowerCase()] ?? null }, text: async () => r.body ?? '', arrayBuffer: async () => new TextEncoder().encode(r.body ?? '').buffer };
  };
  fn.calls = calls;
  return fn;
}

test('fetchJson retries 429 and 5xx with backoff, then succeeds', async () => {
  const f = fakeFetch([{ status: 429, headers: { 'retry-after': '0' } }, { status: 503 }, { status: 200, body: '{"ok":true}' }]);
  const json = await fetchJson('https://api.test/x?api_key=SECRET', { fetchImpl: f, retries: 3, maxWaitMs: 5 });
  assert.deepEqual(json, { ok: true });
  assert.equal(f.calls.length, 3);
});

test('fetchJson does not retry 400 and redacts the URL in errors', async () => {
  const f = fakeFetch([{ status: 400, body: 'bad address=350 5th Ave' }]);
  await assert.rejects(fetchJson('https://api.test/x?address=350+5th+Ave', { fetchImpl: f, retries: 3, maxWaitMs: 5 }), (err) => {
    assert.equal(err.status, 400);
    assert.ok(!err.message.includes('350'), 'address never appears in the error');
    assert.equal(err.url, 'https://api.test/x');
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test('fetchJson handles 404 when allowed, network errors, and non-JSON', async () => {
  assert.equal(await fetchJson('https://api.test/404', { fetchImpl: fakeFetch([{ status: 404 }]), allow404: true }), null);
  await assert.rejects(fetchJson('https://api.test/n', { fetchImpl: fakeFetch([new Error('boom'), new Error('boom')]), retries: 1, maxWaitMs: 5 }), /network error/);
  await assert.rejects(fetchJson('https://api.test/h', { fetchImpl: fakeFetch([{ status: 200, body: '<html>' }]) }), /not JSON/);
});

test('LRU cache, memoize, and hashing', async () => {
  const lru = new LRU(2);
  lru.set('a', 1); lru.set('b', 2); lru.get('a'); lru.set('c', 3);
  assert.equal(lru.get('b'), undefined, 'least recently used evicted');
  assert.equal(lru.get('a'), 1);
  lru.set('x', 1, 1);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(lru.get('x'), undefined, 'expired');
  let n = 0;
  const fn = async () => { n += 1; return 'v'; };
  const [x, y] = await Promise.all([cached('k1', 1000, fn), cached('k1', 1000, fn)]);
  assert.equal(x, 'v'); assert.equal(y, 'v'); assert.equal(n, 1, 'concurrent calls de-duplicated');
  assert.equal(hashKey('350 5th ave').length, 64);
  assert.notEqual(hashKey('350 5th ave'), '350 5th ave');
});

test('parseCsv handles quotes, commas, newlines and CRLF', () => {
  const rows = parseCsv('a,b,c\r\n1,"two, too","multi\nline"\r\n4,"say ""hi""",\n');
  assert.deepEqual(rows, [{ a: '1', b: 'two, too', c: 'multi\nline' }, { a: '4', b: 'say "hi"', c: '' }]);
  let count = 0;
  parseCsv('x\n1\n2\n', { onRow: () => { count += 1; } });
  assert.equal(count, 2);
});

test('sample mode rewrites record links to example.org', () => {
  const out = rewriteForSample({ id: 'https://keep.me/token', url: 'https://www.congress.gov/bill/119th-congress/house-bill/99001', list: [{ u: 'https://example.org/already' }], n: 3 });
  assert.equal(out.id, 'https://keep.me/token');
  assert.equal(out.url, 'https://example.org/sample-record/www.congress.gov/bill/119th-congress/house-bill/99001');
  assert.equal(out.list[0].u, 'https://example.org/already');
  assert.equal(out.n, 3);
});
