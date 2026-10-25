// GET /api/meta: issue list and mapping tables, data freshness, and mode flags.
// Used by the home page (issue picker) and the Methodology page (tables).
import { issueTable, ISSUES } from '../lib/issues.js';
import { curatedIssueSummary } from '../lib/curated.js';
import { dataFreshness, LIVE_SOURCES } from '../lib/sources.js';
import { isFixtureMode, keyStatus, electionDate, reportErrorUrl, nySessionYear } from '../lib/config.js';
import { nyJudicialTable } from '../lib/districts.js';
import { KIND_LABELS } from '../lib/votes.js';
import { LABELS } from '../lib/labels.js';
import { loadSeed } from '../lib/seed.js';
import { sendJson, sendError } from '../lib/respond.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Use GET.' });
  }
  try {
    const seed = loadSeed('NY');
    return sendJson(res, 200, {
      mode: isFixtureMode() ? 'fixtures' : 'live',
      sample: isFixtureMode() || Boolean(seed?.placeholder),
      electionDate: electionDate(),
      nySession: `${nySessionYear()}-${nySessionYear() + 1}`,
      keys: keyStatus(),
      reportErrorUrl: reportErrorUrl() || null,
      issueTable: issueTable(),
      curatedIssues: Object.fromEntries(ISSUES.filter((i) => i.curated).map((i) => [i.id, curatedIssueSummary(i.curated)])),
      voteKinds: KIND_LABELS,
      labels: LABELS,
      nyJudicialDistricts: nyJudicialTable(),
      freshness: dataFreshness(),
      liveSources: LIVE_SOURCES,
      seeds: seed ? [{ state: 'NY', file: seed.file, generatedAt: seed.seed?.generatedAt ?? null, valid: seed.validation.ok, placeholder: seed.placeholder, coverage: seed.seed?.coverage ?? null, stats: seed.validation.stats }] : [],
    }, { 'Cache-Control': 'public, max-age=300, s-maxage=3600' });
  } catch (err) {
    return sendError(res, err);
  }
}
