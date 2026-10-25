import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseElections, pickElection, parseVoterInfo, mergeCandidates, splitParty } from '../lib/civic.js';
import { loadFixture } from '../lib/files.js';

test('pickElection prefers the state election on the target date', () => {
  const elections = parseElections({ elections: [
    { id: '2000', name: 'VIP Test Election', electionDay: '2031-12-31', ocdDivisionId: 'ocd-division/country:us' },
    { id: '9001', name: 'US General', electionDay: '2026-11-03', ocdDivisionId: 'ocd-division/country:us' },
    { id: '9002', name: 'NY General', electionDay: '2026-11-03', ocdDivisionId: 'ocd-division/country:us/state:ny' },
    { id: '9003', name: 'NJ General', electionDay: '2026-11-03', ocdDivisionId: 'ocd-division/country:us/state:nj' },
  ] });
  assert.equal(pickElection(elections, { date: '2026-11-03', state: 'NY' }).id, '9002');
  assert.equal(pickElection(elections, { date: '2026-11-03', state: 'CA' }).id, '9001');
  assert.equal(pickElection(elections, { date: '2027-11-02', state: 'NY' }), null);
  assert.deepEqual(parseElections(null), []);
});

test('fusion candidates listed once per party line are merged', () => {
  const merged = mergeCandidates([
    { name: 'Pat Example', party: 'Democratic Party', orderOnBallot: 4 },
    { name: 'Pat Example', party: 'Working Families Party', orderOnBallot: 9 },
    { name: 'Lee Sample', party: 'Republican, Conservative', orderOnBallot: 2, candidateUrl: 'https://example.org/lee' },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].partyLines, ['Democratic', 'Working Families']);
  assert.equal(merged[0].orderOnBallot, 4);
  assert.deepEqual(merged[1].partyLines, ['Republican', 'Conservative']);
  assert.equal(merged[1].website, 'https://example.org/lee');
  assert.deepEqual(splitParty('Peace and Freedom Party'), ['Peace and Freedom']);
});

test('parseVoterInfo maps contests, districts, places and links', () => {
  const v = parseVoterInfo(loadFixture('civic-voterinfo'));
  assert.equal(v.contests.length, 1);
  const c = v.contests[0];
  assert.equal(c.districtType, 'congressional');
  assert.equal(c.district, '12');
  assert.equal(c.level, 'federal');
  assert.deepEqual(c.candidates.map((x) => [x.name, x.orderOnBallot]), [['Sample Candidate G', 2], ['Sample Candidate H', 1]]);
  assert.deepEqual(c.candidates[0].partyLines, ['Sample Party One', 'Sample Party Three']);
  assert.equal(v.pollingLocations[0].name, 'Sample Polling Site');
  assert.equal(v.pollingLocations[0].address, '1 Example Plaza, New York NY 10001', 'site name is not repeated in the address');
  assert.equal(v.earlyVoteSites.length, 2);
  assert.ok(v.administrationLinks.some((l) => l.url === 'https://example.org/sample-poll-finder'));
  assert.equal('normalizedInput' in v, false, 'the normalized address is never passed on');
});

test('referenda become ballot proposals and scopes map to district types', () => {
  const v = parseVoterInfo({ contests: [
    { type: 'Referendum', referendumTitle: 'Proposal 1', referendumText: 'Full text', referendumBrief: 'Abstract', referendumUrl: 'https://example.org/p1' },
    { type: 'General', office: 'State Senator', district: { scope: 'stateUpper', id: 'ocd-division/country:us/state:ny/sldu:28' }, level: ['administrativeArea1'], candidates: [] },
    { type: 'General', office: 'Member of Assembly', district: { scope: 'stateLower', id: 'ocd-division/country:us/state:ny/sldl:75' }, candidates: [] },
    { type: 'General', office: 'Justice of the Supreme Court', district: { scope: 'judicial', id: 'ocd-division/country:us/state:ny/judicial_district:1' }, roles: ['judge'], candidates: [] },
  ] });
  assert.equal(v.proposals.length, 1);
  assert.equal(v.proposals[0].summaryOfficial, 'Abstract');
  assert.deepEqual(v.contests.map((c) => [c.districtType, c.district, c.level]), [
    ['state-senate', '28', 'state'],
    ['state-assembly', '75', 'state'],
    ['judicial-district', '1', 'judicial'],
  ]);
});
