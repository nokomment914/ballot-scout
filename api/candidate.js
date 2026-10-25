// GET /api/candidate?id=<token>&issues=housing,health&more=0|1
// Records for one candidate on the selected issues. Contains no address data, so it is
// safe to cache at the CDN.
import { getCandidateRecord } from '../lib/candidate.js';
import { sendJson, sendError, queryParams } from '../lib/respond.js';
import { isFixtureMode } from '../lib/config.js';
import { rewriteForSample } from '../lib/sample.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET');
    return sendJson(res, 405, { error: 'Use GET.' });
  }
  try {
    const q = queryParams(req);
    const more = q.more === '1' || q.more === 'true';
    const record = await getCandidateRecord(String(q.id ?? ''), String(q.issues ?? ''), { more });
    return sendJson(res, 200, isFixtureMode() || record.sample ? rewriteForSample(record) : record, {
      'Cache-Control': 'public, max-age=300, s-maxage=21600, stale-while-revalidate=86400',
    });
  } catch (err) {
    return sendError(res, err);
  }
}
