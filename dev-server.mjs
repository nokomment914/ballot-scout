#!/usr/bin/env node
// Zero-dependency local server: serves /public like Vercel (clean URLs, the same security
// headers from vercel.json) and routes /api/<name> to /api/<name>.js handlers.
//   node dev-server.mjs            (live APIs; reads keys from .env if present)
//   FIXTURES=1 node dev-server.mjs (sample data, no keys needed)
//   PORT=4000 node dev-server.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;

// Minimal .env loader (KEY=value lines); never overrides variables already set.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const globalHeaders = (vercel.headers ?? []).find((h) => h.source === '/(.*)')?.headers ?? [];
const assetHeaders = (vercel.headers ?? []).find((h) => h.source === '/assets/(.*)')?.headers ?? [];

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

function applyHeaders(res, list) {
  for (const { key, value } of list) {
    if (key === 'Strict-Transport-Security') continue; // not on plain-http localhost
    res.setHeader(key, key === 'Content-Security-Policy' ? value.replace(/;\s*upgrade-insecure-requests/, '') : value);
  }
}

const handlers = new Map();
async function apiHandler(name) {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const file = path.join(ROOT, 'api', `${name}.js`);
  if (!fs.existsSync(file)) return null;
  if (!handlers.has(name)) handlers.set(name, (await import(pathToFileURL(file).href)).default);
  return handlers.get(name);
}

function resolveStatic(urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p.endsWith('/')) p += 'index.html';
  const candidates = [p, `${p}.html`];
  for (const c of candidates) {
    const abs = path.normalize(path.join(PUBLIC, c));
    if (!abs.startsWith(PUBLIC)) return null;
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  applyHeaders(res, globalHeaders);
  try {
    if (url.pathname.startsWith('/api/')) {
      const handler = await apiHandler(url.pathname.slice(5).replace(/\/$/, ''));
      if (!handler) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        return res.end(JSON.stringify({ error: 'Not found' }));
      }
      req.query = Object.fromEntries(url.searchParams.entries());
      return await handler(req, res);
    }
    // Vercel cleanUrls: /methodology.html redirects to /methodology.
    if (url.pathname.endsWith('.html')) {
      res.statusCode = 308;
      res.setHeader('Location', url.pathname.replace(/(index)?\.html$/, '') || '/');
      return res.end();
    }
    const file = resolveStatic(url.pathname);
    if (!file) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('Not found');
    }
    if (url.pathname.startsWith('/assets/')) applyHeaders(res, assetHeaders);
    res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error('[dev-server]', err?.message ?? err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify({ error: 'Server error' }));
  }
});

server.listen(PORT, () => {
  const mode = /^(1|true|yes)$/i.test(process.env.FIXTURES ?? '') ? 'sample data (FIXTURES=1)' : 'live APIs';
  console.log(`Ballot Scout running at http://localhost:${PORT} using ${mode}`);
});

export default server;
