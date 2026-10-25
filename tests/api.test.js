// API handlers in sample-data mode, with mock request/response objects.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';

let prev;
before(() => { prev = process.env.FIXTURES; process.env.FIXTURES = '1'; });
after(() => { if (prev === undefined) delete process.env.FIXTURES; else process.env.FIXTURES = prev; });

function mockReq({ method = 'GET', url = '/', body, query } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  req.method = method;
  req.url = url;
  if (query) req.query = query;
  return req;
}

function mockRes() {
  const headers = {};
  return {
    statusCode: 200,
    headers,
    body: '',
    setHeader(k, v) { headers[k.toLowerCase()] = v; },
    end(data) { this.body = data ?? ''; this.ended = true; },
    json() { return JSON.parse(this.body); },
  };
}

const ADDRESS = '350 5th Ave, New York, NY 10118';

test('POST /api/ballot returns contests, never cached', async () => {
  const { default: handler } = await import('../api/ballot.js');
  const res = mockRes();
  await handler(mockReq({ method: 'POST', body: { address: ADDRESS, issues: ['housing', 'health'] } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['cache-control'], 'private, no-store');
  const b = res.json();
  assert.equal(b.sample, true);
  assert.equal(b.contests.length, 7);
  assert.deepEqual(b.issues, ['housing', 'health']);
  // Every candidate carries the same fields.
  const keys = new Set();
  for (const c of b.contests) for (const p of c.candidates) keys.add(Object.keys(p).sort().join(','));
  assert.equal(keys.size, 1, 'identical candidate fields');
  // Sample links never point at real record sites.
  const text = JSON.stringify(b.contests);
  assert.ok(!/https:\/\/(www\.)?(congress\.gov|fec\.gov|nysenate\.gov)/.test(text));
  // The raw input address isn't echoed back (only the Census-normalized match).
  assert.ok(!JSON.stringify(b).includes(ADDRESS));
});

test('POST /api/ballot validation and method errors', async () => {
  const { default: handler } = await import('../api/ballot.js');
  let res = mockRes();
  await handler(mockReq({ method: 'GET' }), res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers.allow, 'POST');
  res = mockRes();
  await handler(mockReq({ method: 'POST', body: '{not json' }), res);
  assert.equal(res.statusCode, 400);
  res = mockRes();
  await handler(mockReq({ method: 'POST', body: { address: 'nowhere', issues: [] } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /full street address/);
  res = mockRes();
  await handler(mockReq({ method: 'POST', body: 'x'.repeat(20000) }), res);
  assert.equal(res.statusCode, 413);
});

test('GET /api/candidate returns the same five sections for every candidate', async () => {
  const { default: ballot } = await import('../api/ballot.js');
  const { default: handler } = await import('../api/candidate.js');
  const res = mockRes();
  await ballot(mockReq({ method: 'POST', body: { address: ADDRESS, issues: ['housing'] } }), res);
  const tokens = res.json().contests.flatMap((c) => c.candidates.map((p) => p.id));
  assert.ok(tokens.length >= 15);
  for (const id of tokens) {
    const r = mockRes();
    await handler(mockReq({ method: 'GET', query: { id, issues: 'housing,health' } }), r);
    assert.equal(r.statusCode, 200);
    assert.match(r.headers['cache-control'], /s-maxage=/);
    const rec = r.json();
    assert.deepEqual(Object.keys(rec.sections), ['votes', 'sponsored', 'effects', 'money', 'sources']);
    for (const key of ['votes', 'sponsored', 'effects', 'money']) assert.ok(rec.sections[key].status, `${key} has a status`);
    // No scores, grades or ratings anywhere in the payload.
    assert.ok(!/"(score|grade|rating|alignment)"/i.test(r.body));
  }
});

test('GET /api/candidate rejects bad input', async () => {
  const { default: handler } = await import('../api/candidate.js');
  let r = mockRes();
  await handler(mockReq({ method: 'GET', query: { id: 'garbage!', issues: 'housing' } }), r);
  assert.equal(r.statusCode, 400);
  r = mockRes();
  const token = Buffer.from(JSON.stringify({ v: 1, n: 'Pat', st: 'NY', o: 'Governor' })).toString('base64url');
  await handler(mockReq({ method: 'GET', query: { id: token, issues: 'nonsense' } }), r);
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /issue/);
  r = mockRes();
  await handler(mockReq({ method: 'POST', query: {} }), r);
  assert.equal(r.statusCode, 405);
});

test('GET /api/meta exposes the issue table and freshness', async () => {
  const { default: handler } = await import('../api/meta.js');
  const r = mockRes();
  await handler(mockReq({ method: 'GET' }), r);
  assert.equal(r.statusCode, 200);
  const m = r.json();
  assert.equal(m.mode, 'fixtures');
  assert.ok(m.issueTable.issues.length >= 20);
  assert.equal(m.labels.noRecord, 'No legislative voting record in these databases');
  assert.ok(m.freshness.federalVotes);
  assert.equal(m.nyJudicialDistricts.length, 13);
});
