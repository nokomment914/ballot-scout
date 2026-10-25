// Response helpers shared by the /api functions (Vercel Node runtime and dev-server.mjs).

export function sendJson(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export function sendError(res, err) {
  const status = Number(err?.status) || 500;
  const expose = err?.expose || (status >= 400 && status < 500);
  // Never log request bodies, addresses or upstream URLs with query strings.
  if (!expose) console.error(`[api] ${err?.name ?? 'Error'}: ${err?.code ?? ''} ${status}`);
  sendJson(res, expose ? status : 500, { error: expose ? err.message : 'Something went wrong on our side. Please try again.' }, { 'Cache-Control': 'no-store' });
}

/** Read a JSON body whether or not the platform already parsed it. Limits size to 10 KB. */
export async function readJsonBody(req, limit = 10_240) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8') || '{}');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413, expose: true });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

export function queryParams(req) {
  if (req.query && typeof req.query === 'object') return req.query;
  const u = new URL(req.url ?? '/', 'http://localhost');
  return Object.fromEntries(u.searchParams.entries());
}
