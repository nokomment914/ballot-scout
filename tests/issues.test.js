import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ISSUES, POLICY_AREAS_VERIFIED, HIDDEN_POLICY_AREAS, resolveIssueIds, issuesForPolicyArea, issuesForNyLaw,
  issuesForSubjects, policyAreaMatches, nyLawMatches, normalizeLawName, issueTable,
} from '../lib/issues.js';

test('there are exactly 32 verified CRS policy areas', () => {
  assert.equal(POLICY_AREAS_VERIFIED.length, 32);
  assert.equal(new Set(POLICY_AREAS_VERIFIED).size, 32);
});

test('every non-procedural policy area maps to at least one issue', () => {
  for (const pa of POLICY_AREAS_VERIFIED) {
    if (HIDDEN_POLICY_AREAS.includes(pa)) continue;
    assert.ok(issuesForPolicyArea(pa).length >= 1, `${pa} is unmapped`);
  }
});

test('procedural and legacy areas are hidden', () => {
  assert.deepEqual(issuesForPolicyArea('Congress'), []);
  assert.deepEqual(issuesForPolicyArea('Private Legislation'), []);
  assert.deepEqual(issuesForPolicyArea(null), []);
  for (const issue of ISSUES) for (const pa of issue.policyAreas) assert.ok(POLICY_AREAS_VERIFIED.includes(pa), `${issue.id} uses unverified area ${pa}`);
});

test('plain-language groups from the spec', () => {
  assert.deepEqual(issuesForPolicyArea('Housing and Community Development'), ['housing']);
  for (const pa of ['Environmental Protection', 'Energy', 'Water Resources Development', 'Public Lands and Natural Resources']) {
    assert.deepEqual(issuesForPolicyArea(pa), ['climate']);
  }
});

test('New York consolidated laws map to issues, tolerant of punctuation', () => {
  assert.deepEqual(issuesForNyLaw('Real Property Law'), ['housing']);
  assert.deepEqual(issuesForNyLaw('Real Property Tax Law').sort(), ['housing', 'taxes']);
  assert.deepEqual(issuesForNyLaw('Public Health Law'), ['health']);
  assert.deepEqual(issuesForNyLaw('Mental Hygiene Law'), ['health']);
  assert.deepEqual(issuesForNyLaw('Penal Law'), ['criminal-justice']);
  assert.deepEqual(issuesForNyLaw('Criminal Procedure Law'), ['criminal-justice']);
  assert.deepEqual(issuesForNyLaw('Workers’ Compensation Law'), ['labor'], 'curly apostrophe');
  assert.deepEqual(issuesForNyLaw('workers compensation'), ['labor'], 'no apostrophe, no "Law"');
  assert.deepEqual(issuesForNyLaw('Environmental Conservation Law'), ['climate']);
  assert.deepEqual(issuesForNyLaw('Vehicle and Traffic Law'), ['transportation']);
  assert.deepEqual(issuesForNyLaw('Election Law'), ['government']);
  assert.deepEqual(issuesForNyLaw('Education Law'), ['education']);
  assert.deepEqual(issuesForNyLaw('Tax Law'), ['taxes']);
  assert.deepEqual(issuesForNyLaw('Civil Practice Law and Rules'), ['courts']);
  assert.deepEqual(issuesForNyLaw('Executive Law'), [], 'too broad to map');
  assert.deepEqual(issuesForNyLaw('Penal Law; Correction Law'), ['criminal-justice'], 'multiple laws');
  assert.deepEqual(issuesForNyLaw(''), []);
  assert.equal(normalizeLawName('The Workers’ Compensation Law'), 'workers compensation');
});

test('Open States subjects match case-insensitively', () => {
  assert.ok(issuesForSubjects(['HOUSING AND COMMUNITY DEVELOPMENT']).includes('housing'));
  assert.ok(issuesForSubjects(['Immigrants']).includes('immigration'));
  assert.deepEqual(issuesForSubjects([]), []);
});

test('resolveIssueIds validates, de-duplicates and caps at 5', () => {
  assert.deepEqual(resolveIssueIds(['housing', 'HEALTH', 'bogus', 'housing']), ['housing', 'health']);
  assert.deepEqual(resolveIssueIds('taxes,labor'), ['taxes', 'labor']);
  assert.equal(resolveIssueIds(ISSUES.map((i) => i.id)).length, 5);
  assert.deepEqual(resolveIssueIds(undefined), []);
});

test('match helpers only return selected issues', () => {
  assert.deepEqual(policyAreaMatches('Taxation', ['housing']), []);
  assert.deepEqual(policyAreaMatches('Taxation', ['housing', 'taxes']), ['taxes']);
  assert.deepEqual(nyLawMatches('Real Property Tax Law', ['taxes']), ['taxes']);
  assert.deepEqual(nyLawMatches(null, ['immigration'], ['Immigration']), ['immigration']);
});

test('issueTable is what the Methodology page renders', () => {
  const t = issueTable();
  assert.equal(t.maxIssues, 5);
  assert.equal(t.issues.length, ISSUES.length);
  assert.ok(t.issues.every((i) => i.label && Array.isArray(i.policyAreas) && Array.isArray(i.nyLaws)));
  const ids = ISSUES.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length);
});
