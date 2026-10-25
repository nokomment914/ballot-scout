// Issues defined by a published list of roll calls rather than a subject match.
// /data/issues/<id>.json holds the rule, every roll call that meets it (with the official record
// link and the votes read from the Clerk of the House for members on the ballot), and every
// vote considered and not counted, so the list can be audited. Sample mode uses
// /fixtures/issue-<id>.json, which is fictional like the rest of the sample data.
import { isFixtureMode } from './config.js';
import { readData, loadFixture, safeSegment } from './files.js';

export function loadCuratedIssue(id) {
  const name = safeSegment(id);
  return isFixtureMode() ? loadFixture(`issue-${name}`) : readData('issues', `${name}.json`);
}

/** Public summary for /api/meta and the Methodology page. */
export function curatedIssueSummary(id) {
  const list = loadCuratedIssue(id);
  if (!list) return null;
  return {
    id: list.id,
    label: list.label,
    generatedAt: list.generatedAt ?? null,
    window: list.window ?? null,
    rule: list.rule,
    scopeNote: list.scopeNote ?? null,
    voteNote: list.voteNote ?? null,
    rollcalls: (list.rollcalls ?? []).map(({ votes, ...rc }) => rc),
    related: list.related ?? [],
    excluded: list.excluded ?? [],
    openChecks: list.openChecks ?? [],
    sources: list.sources ?? [],
  };
}
