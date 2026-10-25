#!/usr/bin/env node
// End-to-end test in sample-data mode (FIXTURES=1) with Playwright + Chromium.
// Searches an address, picks issues, opens candidate records, and checks for console
// errors and horizontal scrolling at 390px and 1280px in light and dark mode.
// Screenshots go to /screenshots.
//
// Playwright is not a project dependency. The script looks for it in this order:
//   PLAYWRIGHT_MODULE env var, a local node_modules/playwright, then /opt/npm-tools.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = path.join(ROOT, 'screenshots');
const PORT = Number(process.env.E2E_PORT) || 3217;
const BASE = `http://localhost:${PORT}`;

async function loadPlaywright() {
  const tries = [process.env.PLAYWRIGHT_MODULE, path.join(ROOT, 'node_modules', 'playwright'), '/opt/npm-tools/node_modules/playwright'].filter(Boolean);
  for (const t of tries) {
    try {
      const req = createRequire(pathToFileURL(path.join(t, 'package.json')).href);
      return req(t);
    } catch { /* try next */ }
  }
  try { return await import('playwright'); } catch { /* fall through */ }
  throw new Error('Playwright not found. Run "npm i -D playwright && npx playwright install chromium" or set PLAYWRIGHT_MODULE.');
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['dev-server.mjs'], { cwd: ROOT, env: { ...process.env, FIXTURES: '1', PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => reject(new Error('dev server did not start')), 10000);
    child.stdout.on('data', (d) => { if (String(d).includes('running at')) { clearTimeout(timer); resolve(child); } });
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('exit', (code) => { if (code) reject(new Error(`dev server exited with ${code}`)); });
  });
}

const failures = [];
function check(cond, message) {
  if (!cond) failures.push(message);
  console.log(`${cond ? '  ok ' : '  FAIL'} ${message}`);
}

async function noHorizontalScroll(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1);
}

async function waitForRecords(card) {
  await card.locator('.tabpanel[data-key="sources"] .source-list').first().waitFor({ state: 'attached', timeout: 10000 });
}

async function run() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const { chromium } = await loadPlaywright();
  const server = await startServer();
  const browser = await chromium.launch();
  try {
    for (const viewport of [{ width: 390, height: 844, name: '390' }, { width: 1280, height: 900, name: '1280' }]) {
      for (const scheme of ['light', 'dark']) {
        const tag = `${viewport.name}-${scheme}`;
        console.log(`\n# ${tag}`);
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, colorScheme: scheme, reducedMotion: 'reduce' });
        const page = await context.newPage();
        const errors = [];
        page.on('console', (msg) => { if (msg.type() === 'error' || msg.type() === 'warning') errors.push(`${msg.type()}: ${msg.text()}`); });
        page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
        page.on('requestfailed', (req) => errors.push(`requestfailed: ${req.url()}`));
        page.on('request', (req) => { if (!req.url().startsWith(BASE)) errors.push(`external request: ${req.url()}`); });

        await page.goto(`${BASE}/`);
        await page.locator('#issue-list .chip').first().waitFor();
        check(await page.locator('#site-banner').isVisible(), 'sample-data banner is shown');
        check(await page.getByText('Your address is only used to look up your districts. It isn’t stored.').isVisible(), 'privacy note is shown');
        await page.screenshot({ path: path.join(SHOTS, `home-${tag}.png`), fullPage: true });
        check(await noHorizontalScroll(page), 'home: no horizontal scroll');

        // Validation: submitting empty shows errors.
        await page.locator('#submit-btn').click();
        check(await page.locator('#address-error').isVisible(), 'empty address shows an error');

        await page.locator('#address').fill('350 5th Ave, New York, NY 10118');
        for (const label of ['Housing', 'Health care', 'Transportation and infrastructure', 'Schools and education', 'Taxes']) {
          await page.locator('.chip', { hasText: label }).first().click();
        }
        check(await page.locator('.chip input:disabled').count() > 0, 'issue picker stops at 5');
        check((await page.locator('#issue-count').textContent()).includes('5 of 5'), 'issue counter reads 5 of 5');

        await page.locator('#submit-btn').click();
        await page.locator('#results:not([hidden]) .contest').first().waitFor({ timeout: 15000 });
        const contests = await page.locator('#contests .contest').count();
        check(contests === 7, `7 contests matched the address (got ${contests})`);
        check(!(await page.locator('#contest-fx-cd-10').count()), 'contest for another district is excluded');
        check(await page.locator('#possible-contests:not([hidden])').count() === 1, 'unconfirmable judicial contest listed separately');
        check(await page.locator('.party-lines li', { hasText: 'Sample Party Three' }).count() >= 2, 'fusion party lines shown');

        // Candidate order: CD-12 uses ballot order from Civic (H before G); State Senate is alphabetical (J before K).
        const cdNames = await page.locator('#contest-fx-cd-12 .candidate h4').allTextContents();
        check(cdNames.join('|') === 'Sample Candidate H|Sample Candidate G', `CD-12 in ballot order (${cdNames.join(', ')})`);
        const sdNames = await page.locator('#contest-fx-sd-28 .candidate h4').allTextContents();
        check(sdNames.join('|') === 'Sample Candidate J|Sample Candidate K', `State Senate alphabetical (${sdNames.join(', ')})`);

        // Identical sections for every candidate.
        const tabCounts = await page.locator('.candidate').evaluateAll((els) => els.map((e) => e.querySelectorAll('[role="tab"]').length));
        check(tabCounts.every((n) => n === 5), 'every candidate has the same 5 tabs');

        // Labels.
        check(await page.locator('#contest-fx-supreme-1 .record-label', { hasText: 'Judicial races have no voting records' }).count() === 3, 'judicial label on each judicial candidate');
        check(await page.locator('#contest-fx-attorney-general .record-label', { hasText: 'Executive office: no voting record' }).count() === 1, 'executive label on the incumbent AG');
        check(await page.locator('#contest-fx-sd-28 .record-label', { hasText: 'No legislative voting record in these databases' }).count() === 1, 'no-record label on the challenger');

        // Open the congressional incumbent's records.
        const g = page.locator('#contest-fx-cd-12 .candidate', { hasText: 'Sample Candidate G' });
        await g.scrollIntoViewIfNeeded();
        await waitForRecords(g);
        const voteRows = await g.locator('.tabpanel[data-key="votes"] .row').count();
        check(voteRows >= 4, `Candidate G shows votes on the chosen issues (${voteRows})`);
        check(await g.locator('.tabpanel[data-key="votes"] a', { hasText: 'Official roll call' }).count() > 0, 'votes link to official roll calls');
        await g.locator('[role="tab"]', { hasText: 'Bills they sponsored' }).click();
        check(await g.locator('.tabpanel[data-key="sponsored"]:not([hidden]) .quote').count() >= 1, 'sponsored bills quote the CRS summary');
        await g.locator('[role="tab"]', { hasText: 'What their policies did' }).click();
        check(await g.locator('.tabpanel[data-key="effects"]:not([hidden]) a', { hasText: 'Find GAO reviews' }).count() >= 1, 'effects tab has GAO search links');
        await g.locator('[role="tab"]', { hasText: 'Money' }).click();
        check(await g.locator('.tabpanel[data-key="money"]:not([hidden]) table').count() >= 2, 'money tab shows FEC tables');
        check((await g.locator('.tabpanel[data-key="money"]').textContent()).includes('$200 and under: 50%'), 'small-dollar share computed from FEC buckets');
        await g.screenshot({ path: path.join(SHOTS, `candidate-money-${tag}.png`) });
        // Keyboard: arrow from Money to Sources.
        await g.locator('[role="tab"][aria-selected="true"]').focus();
        await page.keyboard.press('ArrowRight');
        check(await g.locator('[role="tab"][aria-selected="true"]').textContent() === 'Sources', 'arrow keys move between tabs');
        check(await noHorizontalScroll(page), 'results: no horizontal scroll');

        // Amendment toggle adds the amendment vote.
        await g.locator('[role="tab"]', { hasText: 'Votes on your issues' }).click();
        const before = await g.locator('.tabpanel[data-key="votes"] .row').count();
        await page.locator('#more-votes').check();
        await g.locator('.tabpanel[data-key="votes"] .row-meta', { hasText: 'Amendment' }).first().waitFor({ timeout: 10000 });
        const after = await g.locator('.tabpanel[data-key="votes"] .row').count();
        check(after === before + 1, `amendment toggle adds amendment votes (${before} -> ${after})`);

        // Governor: executive actions; running mate switch.
        const gov = page.locator('#contest-fx-governor .candidate', { hasText: 'Sample Candidate B' }).first();
        await gov.scrollIntoViewIfNeeded();
        await waitForRecords(gov);
        check(await gov.locator('.tabpanel[data-key="votes"] h5', { hasText: 'Official actions as Governor' }).count() === 1, 'governor shows official actions section');
        const a = page.locator('#contest-fx-governor .candidate', { hasText: 'Sample Candidate A' }).first();
        await a.scrollIntoViewIfNeeded();
        await waitForRecords(a);
        await a.locator('.person-switch button', { hasText: 'running mate' }).click();
        await a.locator('.tabpanel[data-key="votes"] .row').first().waitFor({ timeout: 10000 });
        check(await a.locator('.tabpanel[data-key="votes"] .row').count() >= 1, 'running mate records load');

        // State candidate money from the NYS Board of Elections data (identical layout for both).
        const j = page.locator('#contest-fx-sd-28 .candidate', { hasText: 'Sample Candidate J' });
        await j.scrollIntoViewIfNeeded();
        await waitForRecords(j);
        await j.locator('[role="tab"]', { hasText: 'Money' }).click();
        check((await j.locator('.tabpanel[data-key="money"]').textContent()).includes('Registered committee'), 'state candidate money shows the registered committee');
        check(await j.locator('.tabpanel[data-key="money"] tbody tr').count() >= 3, 'state money summed by schedule');
        await j.screenshot({ path: path.join(SHOTS, `candidate-state-money-${tag}.png`) });

        // Assembly member (Open States votes).
        const l = page.locator('#contest-fx-ad-75 .candidate', { hasText: 'Sample Candidate L' });
        await l.scrollIntoViewIfNeeded();
        await waitForRecords(l);
        check((await l.locator('.tabpanel[data-key="votes"]').textContent()).includes('NY Assembly'), 'Assembly votes shown for Assembly member');

        // Load every remaining card so the full-page screenshot shows records.
        for (const card of await page.locator('.candidate').all()) { await card.scrollIntoViewIfNeeded(); }
        await page.waitForFunction(() => [...document.querySelectorAll('.candidate')].every((c) => c.dataset.loaded === '1'), null, { timeout: 15000 });
        check(await noHorizontalScroll(page), 'results fully loaded: no horizontal scroll');
        const badText = await page.evaluate(() => {
          const walker = document.createTreeWalker(document.getElementById('results'), NodeFilter.SHOW_TEXT);
          const bad = [];
          while (walker.nextNode()) {
            const t = walker.currentNode.textContent.trim();
            if (/^(null|undefined)$/.test(t) || /NaN|\[object Object\]|Invalid Date/.test(t)) bad.push(t);
          }
          return bad;
        });
        check(badText.length === 0, `no "null", "undefined", NaN or Invalid Date text on the page${badText.length ? `: ${badText.slice(0, 5).join(' | ')}` : ''}`);
        // Each candidate's five panels are all filled (identical structure, nothing left loading).
        const panelsFilled = await page.locator('.candidate').evaluateAll((els) => els.every((e) => [...e.querySelectorAll('.tabpanel')].every((p) => p.childElementCount > 0 && !p.querySelector('.loading'))));
        check(panelsFilled, 'every candidate panel is filled');
        await page.screenshot({ path: path.join(SHOTS, `results-${tag}.png`), fullPage: true });

        // Methodology page renders the mapping table.
        await page.goto(`${BASE}/methodology`);
        await page.locator('#issue-table table').waitFor();
        check(await page.locator('#issue-table tbody tr').count() >= 20, 'methodology renders the issue mapping table');
        check(await noHorizontalScroll(page), 'methodology: no horizontal scroll');
        await page.screenshot({ path: path.join(SHOTS, `methodology-${tag}.png`), fullPage: true });

        check(errors.length === 0, `no console errors, warnings or external requests${errors.length ? `: ${errors.join(' | ')}` : ''}`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(failures.length ? `\n${failures.length} check(s) failed.` : '\nAll e2e checks passed.');
  process.exit(failures.length ? 1 : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
