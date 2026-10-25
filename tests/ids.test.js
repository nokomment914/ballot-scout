import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCandidateToken, decodeCandidateToken, resolveIdentity, fullNameKey, districtFromTitle } from '../lib/ids.js';

function withFixtures(fn) {
  const prev = process.env.FIXTURES;
  process.env.FIXTURES = '1';
  try { return fn(); } finally { if (prev === undefined) delete process.env.FIXTURES; else process.env.FIXTURES = prev; }
}

test('candidate tokens round-trip and are sanitized', () => {
  const t = encodeCandidateToken({ name: 'Pat Example', state: 'NY', office: 'State Senator', districtType: 'state-senate', district: '28', incumbent: true, ids: { bioguide: 'A000001', fec: 'H0NY12000', nysenate: '123', openstates: 'ocd-person/00000000-0000-4000-8000-000000000001' }, website: 'https://example.org' });
  assert.match(t, /^[A-Za-z0-9_-]+$/);
  const c = decodeCandidateToken(t);
  assert.equal(c.name, 'Pat Example');
  assert.equal(c.state, 'NY');
  assert.equal(c.incumbent, true);
  assert.deepEqual(c.ids, { bioguide: 'A000001', fec: ['H0NY12000'], nysenate: '123', openstates: 'ocd-person/00000000-0000-4000-8000-000000000001' });
  const evil = Buffer.from(JSON.stringify({ v: 1, n: 'X', ids: { bioguide: '../../etc/passwd', nysenate: '1; rm', fec: ['javascript:1'] }, w: 'javascript:alert(1)' })).toString('base64url');
  const e = decodeCandidateToken(evil);
  assert.deepEqual(e.ids, {});
  assert.equal(e.website, null);
  for (const bad of ['', 'not base64!', 'a'.repeat(5000), Buffer.from('{"v":2}').toString('base64url')]) {
    assert.throws(() => decodeCandidateToken(bad), /Invalid candidate id/);
  }
});

test('fullNameKey ignores middle initials but keeps distinct names apart', () => {
  assert.equal(fullNameKey('Dana M. Rivers-Lopez'), fullNameKey('Dana Rivers-Lopez'));
  assert.equal(fullNameKey('RIVERS-LOPEZ, Dana M.'), fullNameKey('Dana Rivers-Lopez'));
  assert.notEqual(fullNameKey('Sample Candidate A'), fullNameKey('Sample Running Mate A'));
  assert.notEqual(fullNameKey('Sample Candidate A'), fullNameKey('Sample Candidate B'));
});

test('districtFromTitle', () => {
  assert.equal(districtFromTitle('State Senator, District 28'), '28');
  assert.equal(districtFromTitle('Member of Assembly, AD 69'), '69');
  assert.equal(districtFromTitle('State Senator, SD 59'), '59');
  assert.equal(districtFromTitle('U.S. Representative, NY-12'), '12');
  assert.equal(districtFromTitle('Governor'), null);
});

test('resolveIdentity prefers seed ids, then office+surname, then exact full name', () => withFixtures(() => {
  const seed = resolveIdentity({ candidate: { name: 'Anyone', ids: { bioguide: 'z000012' } }, contest: { office: 'Representative in Congress', districtType: 'congressional', district: '12' }, state: 'NY' });
  assert.deepEqual(seed.ids, { bioguide: 'Z000012' });
  assert.equal(seed.matchedBy.bioguide, 'seed');

  const byOffice = resolveIdentity({ candidate: { name: 'Sample Candidate J', incumbent: true }, contest: { office: 'State Senator', districtType: 'state-senate', district: '28' }, state: 'NY' });
  assert.equal(byOffice.ids.nysenate, '9028');
  assert.equal(byOffice.matchedBy.nysenate, 'office+surname');

  const byName = resolveIdentity({ candidate: { name: 'Sample Running Mate A' }, contest: { office: 'Governor and Lieutenant Governor', districtType: 'statewide' }, state: 'NY', role: 'running-mate' });
  assert.equal(byName.ids.nysenate, '9100');
  assert.equal(byName.matchedBy.nysenate, 'name+state');

  const fed = resolveIdentity({ candidate: { name: 'Sample Candidate G', incumbent: true }, contest: { office: 'Representative in Congress', districtType: 'congressional', district: '12' }, state: 'NY' });
  assert.equal(fed.ids.bioguide, 'Z000012');

  const nobody = resolveIdentity({ candidate: { name: 'Sample Candidate A' }, contest: { office: 'Governor', districtType: 'statewide' }, state: 'NY' });
  assert.deepEqual(nobody.ids, {}, 'similar-looking names are not matched');

  // A nysenate.gov profile slug is kept for the profile link; the numeric member id is resolved.
  const slug = resolveIdentity({ candidate: { name: 'Sample Candidate J', incumbent: true, ids: { nysenate: 'sample-candidate-j' } }, contest: { office: 'State Senator', districtType: 'state-senate', district: '28' }, state: 'NY' });
  assert.equal(slug.ids.nysenateSlug, 'sample-candidate-j');
  assert.equal(slug.ids.nysenate, '9028');
  assert.equal(slug.matchedBy.nysenate, 'office+surname');
  const tok = decodeCandidateToken(encodeCandidateToken({ name: 'X', state: 'NY', office: 'State Senator', ids: slug.ids }));
  assert.equal(tok.ids.nysenateSlug, 'sample-candidate-j');
  assert.equal(tok.ids.nysenate, '9028');

  // A legislator running for another office is found through their current office.
  const viaTitle = resolveIdentity({ candidate: { name: 'Sample Candidate L', incumbent: false, currentOffice: 'Member of Assembly, AD 75' }, contest: { office: 'Representative in Congress', districtType: 'congressional', district: '12' }, state: 'NY' });
  assert.equal(viaTitle.ids.nysenate, '9075');
  assert.equal(viaTitle.ids.openstates, 'ocd-person/00000000-0000-4000-8000-000000000075');

  const otherState = resolveIdentity({ candidate: { name: 'Sample Candidate G', incumbent: true }, contest: { office: 'Representative in Congress', districtType: 'congressional', district: '12' }, state: 'NJ' });
  assert.equal(otherState.ids.bioguide, undefined);
}));
