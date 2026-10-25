// POST /api/ballot  { address: string, issues: string[] }
// Returns the voter's contests and candidates (identities only; records load per candidate).
// The address arrives in the request body (never the URL), is not logged, and is not stored.
import { assembleBallot } from '../lib/ballot.js';
import { sendJson, sendError, readJsonBody } from '../lib/respond.js';
import { rewriteForSample } from '../lib/sample.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return sendJson(res, 405, { error: 'Use POST with a JSON body: { "address": "...", "issues": ["housing"] }' });
  }
  try {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err?.status) throw err;
      return sendJson(res, 400, { error: 'Request body must be JSON.' }, { 'Cache-Control': 'no-store' });
    }
    const result = await assembleBallot({ address: body?.address, issues: body?.issues });
    // Address-derived: never cache in shared caches.
    return sendJson(res, 200, result.sample ? sampleBallot(result) : result, { 'Cache-Control': 'private, no-store' });
  } catch (err) {
    return sendError(res, err);
  }
}

/** Sample ballots: rewrite candidate/contest record links, keep the real data-source links. */
function sampleBallot(result) {
  return {
    ...result,
    election: rewriteForSample(result.election),
    voting: rewriteForSample(result.voting),
    contests: rewriteForSample(result.contests),
    possibleContests: rewriteForSample(result.possibleContests),
    ballotProposals: rewriteForSample(result.ballotProposals),
  };
}
