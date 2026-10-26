// Per-candidate records for the selected issues. Every candidate gets the same sections, in
// the same order, with a status and a neutral explanation when empty: stated positions, the
// five record sections, and an "At a glance" summary built from them with fixed templates.
import { decodeCandidateToken } from './ids.js';
import { recordProfile, LABELS } from './labels.js';
import { officeKey, lastName } from './order.js';
import { resolveIssueIds, policyAreaMatches, issueLabel, curatedIssueIds, ISSUE_BY_ID } from './issues.js';
import { federalVotesOnIssues, curatedVotesForMember, VOTEVIEW_SOURCE, votesMeta } from './votes.js';
import { loadCuratedIssue } from './curated.js';
import { outsideFor, entryStatus, OUTSIDE_SOURCE, NY_IE_LINKS } from './outside.js';
import { nySenateVotesOnIssues, nySponsoredOnIssues, governorActionsOnIssues, nyMeta, nyMembersIndex, OPENLEG_SOURCE } from './nysenate.js';
import { openStatesVotesOnIssues, OPENSTATES_SOURCE } from './openstates.js';
import { getSponsoredLegislation, sponsoredBillDetail, congressForDate, CONGRESS_SOURCE } from './congress.js';
import { federalMoney, fecSearchUrl, FEC_SOURCE } from './fec.js';
import { stateMoney } from './statemoney.js';
import { stancesSection } from './stances.js';
import { buildSummary } from './summary.js';
import { electionCycle, isFixtureMode, keys } from './config.js';
import { UserError } from './ballot.js';

const now = () => new Date().toISOString();

function gaoSearchUrl(billNumber) {
  return `https://www.gao.gov/search?keyword=${encodeURIComponent(`"${billNumber}"`)}`;
}

async function votesSection(c, profile, issueIds, more) {
  const items = [];
  const sources = [];
  const extraNotes = [];
  let found = false;
  // A source returns at most its limit (newest first); remember when a list was cut short.
  let capped = false;
  const take = (r) => { if (r) { found = true; items.push(...r.items); if ((r.matchedTotal ?? 0) > r.items.length) capped = true; } };
  const vm = votesMeta();
  const nm = nyMeta();
  const curatedIds = curatedIssueIds(issueIds);
  const matchedIds = issueIds.filter((id) => !curatedIds.includes(id));
  if (c.ids.bioguide) {
    // Issues defined by a published roll-call list: every listed vote, amendments included.
    for (const id of curatedIds) {
      const list = loadCuratedIssue(ISSUE_BY_ID.get(id).curated);
      if (!list) continue;
      found = true;
      items.push(...curatedVotesForMember(c.ids.bioguide, list, id));
      sources.push({ label: `Clerk of the U.S. House roll calls (published ${issueLabel(id)} list)`, url: 'https://clerk.house.gov/Votes', lastUpdated: list.generatedAt ?? null, note: `${list.rollcalls.length} roll calls; the rule and every vote considered are on the Methodology page` });
    }
    if (matchedIds.length) {
      take(federalVotesOnIssues(c.ids.bioguide, matchedIds, { includeAmendments: more }));
      sources.push({ ...VOTEVIEW_SOURCE, lastUpdated: vm?.voteview?.downloadedAt ?? null, note: 'Joined to Congress.gov policy areas and titles' });
    }
  } else {
    for (const id of curatedIds) {
      if (ISSUE_BY_ID.get(id).federalOnly) extraNotes.push(`The ${issueLabel(id)} list covers U.S. House roll calls on military aid and arms; this candidate has no votes on it.`);
    }
  }
  if (c.ids.nysenate) {
    const r = nySenateVotesOnIssues(c.ids.nysenate, matchedIds, { includeCommittee: more });
    take(r);
    if (r?.chamber === 'ASSEMBLY' && !c.ids.openstates) extraNotes.push('New York Assembly roll calls come from Open States, and this member isn’t linked to an Open States record yet.');
    sources.push({ ...OPENLEG_SOURCE, lastUpdated: nm?.openLegislation?.lastUpdated ?? null, note: 'NY Senate floor and committee votes' });
  }
  if (c.ids.openstates) {
    take(openStatesVotesOnIssues(c.ids.openstates, matchedIds, { includeAmendments: more }));
    sources.push({ ...OPENSTATES_SOURCE, lastUpdated: nm?.openStates?.exportUpdatedAt ?? nm?.openStates?.lastUpdated ?? null, note: 'NY Assembly roll calls (bulk export)' });
  }
  // One row per roll call. Federal votes are keyed by roll call number; the same NY bill, day and
  // vote can appear in both NY sources, so those are keyed by bill. A roll call that matches more
  // than one issue keeps every issue tag (the published-list row comes first and wins).
  const byKey = new Map();
  for (const v of items) {
    const k = v.jurisdiction === 'U.S. Congress' && v.rollcall
      ? `${v.chamber}|${String(v.date).slice(0, 4)}|roll:${v.rollcall}`
      : `${v.jurisdiction}|${v.chamber}|${v.bill?.number}|${v.date}|${v.kind}`;
    const prev = byKey.get(k);
    if (prev) prev.issues = [...new Set([...(prev.issues ?? []), ...(v.issues ?? [])])];
    else byKey.set(k, { ...v });
  }
  const deduped = [...byKey.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));

  let executive = null;
  if (profile.governor && c.state === 'NY') {
    const g = governorActionsOnIssues(lastName(c.name), issueIds);
    executive = {
      title: 'Official actions as Governor: bills signed and vetoed',
      items: g.items,
      total: g.total,
      source: { ...OPENLEG_SOURCE, lastUpdated: nm?.openLegislation?.lastUpdated ?? null, note: 'Governor’s approval and veto actions recorded on each bill' },
    };
    sources.push(executive.source);
  }

  let status = 'ok';
  let note = null;
  if (!deduped.length) {
    if (profile.judicial) { status = 'no-record'; note = `${LABELS.judicial}. Judges don’t vote on legislation.`; }
    else if (!profile.legislative && profile.executive) {
      status = 'no-record';
      note = profile.governor && c.state === 'NY'
        ? `${LABELS.executive}. The Governor’s signatures and vetoes on your issues are listed below.`
        : `${LABELS.executive}. This app has no public database of official actions for this office.`;
    }
    else if (!profile.legislative) { status = 'no-record'; note = `No votes to show. ${profile.labels[0] ?? LABELS.noRecord}.`; }
    else if (!found) { status = 'not-built'; note = 'This candidate’s legislative record is linked, but the vote index hasn’t been built yet. Run the nightly data job.'; }
    else { status = 'none-on-issues'; note = `No recorded votes on ${issueIds.map(issueLabel).join(', ')} in the sessions covered.`; }
  }
  if (profile.executive && profile.legislative && deduped.length) note = 'Votes from prior legislative service.';
  if (capped && deduped.length) extraNotes.unshift('Showing the most recent votes on your issues; the official records linked below have the full list.');
  if (extraNotes.length) note = [note, ...extraNotes].filter(Boolean).join(' ');
  return { status, note, items: deduped, capped, executive, labels: profile.labels, sources, includesMore: more };
}

async function federalSponsored(bioguide, issueIds) {
  const all = await getSponsoredLegislation(bioguide);
  const minCongress = congressForDate() - 1;
  const matches = all
    .filter((b) => b.congress >= minCongress)
    .map((b) => ({ b, issues: policyAreaMatches(b.policyArea, issueIds) }))
    .filter((x) => x.issues.length)
    .sort((x, y) => String(y.b.introducedDate ?? '').localeCompare(String(x.b.introducedDate ?? '')));
  const top = matches.slice(0, 6);
  const details = await Promise.all(top.map(async ({ b, issues }) => ({ ...(await sponsoredBillDetail(b)), issues, jurisdiction: 'U.S. Congress' })));
  return { items: details, matchedTotal: matches.length, congresses: [minCongress, minCongress + 1] };
}

async function sponsoredSection(c, profile, issueIds) {
  const items = [];
  const sources = [];
  const notes = [];
  let attempted = false;
  // Issues defined by a published roll-call list have no subject match, so bills aren't matched to them.
  const curatedIds = curatedIssueIds(issueIds);
  const matchedIds = issueIds.filter((id) => !curatedIds.includes(id));
  const curatedNote = curatedIds.length ? `Sponsored bills aren’t matched to ${curatedIds.map(issueLabel).join(', ')}: that issue is defined by a published list of House votes (see the Votes tab).` : null;
  if (c.ids.bioguide && matchedIds.length) {
    attempted = true;
    try {
      const r = await federalSponsored(c.ids.bioguide, matchedIds);
      items.push(...r.items);
      if (r.matchedTotal > r.items.length) notes.push(`Showing the ${r.items.length} most recent of ${r.matchedTotal} matching federal bills.`);
      sources.push({ ...CONGRESS_SOURCE, lastUpdated: now(), note: `Sponsored bills, ${r.congresses[0]}th–${r.congresses[1]}th Congresses` });
    } catch (err) {
      notes.push(err?.code === 'not-configured' ? 'Congress.gov key not configured, so federal sponsored bills can’t be loaded.' : 'Congress.gov didn’t respond; try again later.');
      sources.push({ ...CONGRESS_SOURCE, lastUpdated: null });
    }
  }
  if (c.ids.nysenate && matchedIds.length) {
    attempted = true;
    const r = nySponsoredOnIssues(c.ids.nysenate, matchedIds);
    const nm = nyMeta();
    if (r) {
      items.push(...r.items.map((x) => ({ ...x, jurisdiction: 'New York State' })));
      if (r.matchedTotal > r.items.length) notes.push(`Showing ${r.items.length} of ${r.matchedTotal} matching New York bills.`);
    }
    sources.push({ ...OPENLEG_SOURCE, lastUpdated: nm?.openLegislation?.lastUpdated ?? null, note: 'Bills where this member is the prime sponsor' });
  }
  const legislativeIds = Boolean(c.ids.bioguide || c.ids.nysenate);
  let status = items.length ? 'ok' : 'none';
  let note = [notes.join(' ') || null, items.length ? curatedNote : null].filter(Boolean).join(' ') || null;
  if (!items.length) {
    if (!attempted && !legislativeIds) { status = 'no-record'; note = profile.judicial ? LABELS.judicial : profile.local ? LABELS.local : profile.executive ? LABELS.executive : LABELS.noRecord; }
    else if (!attempted) note = curatedNote;
    else note = [`No sponsored bills on ${matchedIds.map(issueLabel).join(', ')} found in the sessions covered.`, curatedNote, ...notes].filter(Boolean).join(' ');
  }
  return { status, note, items, sources };
}

function effectsSection(sponsored, votes, issueIds) {
  const items = [];
  for (const b of sponsored.items) {
    const evidence = [];
    if (b.cbo?.length) for (const e of b.cbo) evidence.push({ type: 'CBO cost estimate', title: e.title, description: e.description, date: e.date, url: e.url });
    if (b.crsSummary) evidence.push({ type: `CRS summary${b.crsSummary.version ? ` (${b.crsSummary.version})` : ''}`, quote: b.crsSummary.text, truncated: b.crsSummary.truncated, date: b.crsSummary.date, url: b.crsSummary.url });
    if (b.laws?.length) for (const l of b.laws) evidence.push({ type: 'Enacted', title: `${l.type} ${l.number}`, url: b.url });
    if (b.fiscal) evidence.push({ type: b.fiscal.source, quote: b.fiscal.text, url: b.url });
    if (b.chapter) evidence.push({ type: 'Enacted', title: `Chapter ${b.chapter} of the Laws of New York`, url: b.url });
    if (b.approval?.text) evidence.push({ type: 'Governor’s approval message', quote: b.approval.text, url: b.url });
    if (b.veto?.text) evidence.push({ type: 'Governor’s veto message', quote: b.veto.text, url: b.url });
    items.push({
      bill: { number: b.number, title: b.title, url: b.url, jurisdiction: b.jurisdiction },
      evidence,
      noEvidence: evidence.length === 0,
      gaoSearchUrl: b.jurisdiction === 'U.S. Congress' ? gaoSearchUrl(b.number) : null,
      issues: b.issues,
    });
  }
  for (const a of votes.executive?.items ?? []) {
    const evidence = [];
    if (a.chapter) evidence.push({ type: 'Enacted', title: `Chapter ${a.chapter} of the Laws of New York`, url: a.bill.url });
    if (a.message) evidence.push({ type: a.message.source, quote: a.message.text, url: a.bill.url });
    items.push({ bill: { ...a.bill, jurisdiction: 'New York State' }, action: a.action, date: a.date, evidence, noEvidence: evidence.length === 0, gaoSearchUrl: null, issues: a.issues });
  }
  const anyEvidence = items.some((i) => !i.noEvidence);
  return {
    status: items.length ? (anyEvidence ? 'ok' : 'none') : 'none',
    note: items.length
      ? (anyEvidence ? null : 'No official cost estimate, CRS summary or fiscal note was found for these bills.')
      : (issueIds.every((id) => ISSUE_BY_ID.get(id)?.curated)
        ? `Official analyses are linked to sponsored bills, and bills aren’t matched to ${issueIds.map(issueLabel).join(', ')}.`
        : `No official estimates or analyses are available, because no sponsored bills or official actions on ${issueIds.filter((id) => !ISSUE_BY_ID.get(id)?.curated).map(issueLabel).join(', ')} were found.`),
    explainer: 'Only official evidence is shown: Congressional Budget Office cost estimates, Congressional Research Service summaries, New York sponsor-memo fiscal notes and the Governor’s messages, quoted verbatim. Use “Find GAO reviews” to search the Government Accountability Office.',
    items,
    sources: [
      { label: 'Congressional Budget Office cost estimates (via Congress.gov)', url: 'https://www.cbo.gov/cost-estimates' },
      { label: 'Congressional Research Service bill summaries (via Congress.gov)', url: 'https://www.congress.gov/help/legislative-glossary#glossary_billsummary' },
      { label: 'U.S. Government Accountability Office search', url: 'https://www.gao.gov/' },
      { ...OPENLEG_SOURCE, label: 'NY sponsor memos and Governor’s messages (Open Legislation)' },
    ],
  };
}

/** Outside spending for a federal candidate from the nightly FEC build, in every Money tab state. */
function nightlyOutside(c, ok) {
  const { file, entry } = outsideFor({ state: c.state, officeKey: ok, district: c.district, name: c.name });
  if (!file) return { status: 'not-built', builtAt: null, cycles: [], entry: null, source: { ...OUTSIDE_SOURCE, lastUpdated: null } };
  return {
    status: entry ? entryStatus(entry).status : 'not-found',
    builtAt: file.builtAt ?? null,
    cycles: file.cycles ?? [],
    entry: entry ?? null,
    note: file.note ?? null,
    source: { ...OUTSIDE_SOURCE, lastUpdated: file.builtAt ?? null },
  };
}

async function moneySection(c, ok) {
  const cycle = electionCycle();
  if (ok === 'us-house' || ok === 'us-senate') {
    const outsideByCycle = nightlyOutside(c, ok);
    const withOutside = (m) => ({ ...m, outsideByCycle, sources: [...(m.sources ?? []), outsideByCycle.source] });
    if (!isFixtureMode() && !keys.dataGov()) {
      return withOutside({ status: 'not-configured', kind: 'fec', note: 'FEC data needs a free api.data.gov key (see README).', links: [{ label: 'Search FEC.gov', url: fecSearchUrl(c.name) }], sources: [{ ...FEC_SOURCE, lastUpdated: null }] });
    }
    try {
      const m = await federalMoney({ name: c.name, fecIds: c.ids.fec, state: c.state, officeKey: ok, district: c.district, cycle });
      if (m.status !== 'ok') {
        return withOutside({ status: 'not-found', kind: 'fec', note: 'No single FEC candidate record matched this name for this race and cycle.', links: [{ label: 'Search FEC.gov', url: m.searchUrl }], sources: [{ ...FEC_SOURCE, lastUpdated: now() }] });
      }
      return withOutside({ ...m, kind: 'fec', sources: [{ ...FEC_SOURCE, lastUpdated: now(), note: 'Totals as of the latest report filed' }] });
    } catch {
      return withOutside({ status: 'unavailable', kind: 'fec', note: 'The FEC API didn’t respond. Try again later.', links: [{ label: 'Search FEC.gov', url: fecSearchUrl(c.name) }], sources: [{ ...FEC_SOURCE, lastUpdated: null }] });
    }
  }
  const s = stateMoney({ state: c.state, level: c.level, name: c.name, office: c.office, district: c.district, role: c.role });
  const outsideLinks = String(c.state).toUpperCase() === 'NY' && c.role !== 'running-mate' ? NY_IE_LINKS : [];
  return {
    ...s,
    kind: 'state',
    outsideLinks,
    outsideNote: outsideLinks.length ? 'Independent expenditures for or against New York State and local candidates are reported to the NYS Board of Elections, not the FEC. Search them by the candidate’s name:' : null,
    sources: [...(s.source ? [s.source] : []), ...s.links.map((l) => ({ label: l.label, url: l.url }))],
  };
}

function identityLinks(c) {
  const out = [];
  if (c.ids.bioguide) out.push({ label: `Biographical Directory of the U.S. Congress (${c.ids.bioguide})`, url: `https://bioguide.congress.gov/search/bio/${c.ids.bioguide}`, matchedBy: c.matchedBy.bioguide ?? null });
  for (const f of c.ids.fec ?? []) out.push({ label: `FEC candidate ${f}`, url: `https://www.fec.gov/data/candidate/${f}/`, matchedBy: c.matchedBy.fec ?? null });
  if (c.ids.nysenateSlug) out.push({ label: 'NY Senate profile (nysenate.gov)', url: `https://www.nysenate.gov/senators/${c.ids.nysenateSlug}`, matchedBy: 'seed' });
  if (c.ids.nysenate) out.push({ label: `NY Open Legislation member id ${c.ids.nysenate} (sponsorships and Senate votes)`, url: 'https://legislation.nysenate.gov/', matchedBy: c.matchedBy.nysenate ?? null });
  if (c.ids.openstates) {
    const m = nyMembersIndex().find((x) => x.openstatesId === c.ids.openstates);
    out.push({ label: `Open States person ${c.ids.openstates}`, url: m?.openstatesUrl ?? 'https://open.pluralpolicy.com/', matchedBy: c.matchedBy.openstates ?? null });
  }
  if (c.website) out.push({ label: 'Official campaign or office website', url: c.website, matchedBy: null });
  return out;
}

export async function getCandidateRecord(token, issuesParam, { more = false } = {}) {
  const c = decodeCandidateToken(token);
  const issueIds = resolveIssueIds(issuesParam);
  if (!issueIds.length) throw new UserError('Pick at least one issue.');
  const contest = { office: c.office, districtType: c.districtType, district: c.district, level: c.level };
  const profile = recordProfile({ contest, candidate: { incumbent: c.incumbent, currentOffice: c.currentOffice }, ids: c.ids, role: c.role });
  const ok = officeKey(c.office, contest);

  const stances = stancesSection(c, profile, issueIds);
  const votes = await votesSection(c, profile, issueIds, more);
  const [sponsored, money] = await Promise.all([sponsoredSection(c, profile, issueIds), moneySection(c, c.role === 'running-mate' ? 'state' : ok)]);
  const effects = effectsSection(sponsored, votes, issueIds);
  // Built last, from the sections above: every number in it is one the Money and Votes tabs show.
  const summary = buildSummary({ profile, role: c.role, issueIds, votes, money, stances });

  const allSources = [];
  const seen = new Set();
  for (const s of [...stances.sources, ...votes.sources, ...sponsored.sources, ...(money.sources ?? []), ...effects.sources]) {
    const k = `${s.label}|${s.url}`;
    if (!seen.has(k)) { seen.add(k); allSources.push(s); }
  }
  return {
    name: c.name,
    role: c.role,
    sample: Boolean(c.sample || isFixtureMode()),
    issues: issueIds,
    profile,
    generatedAt: now(),
    sections: {
      summary,
      stances,
      votes,
      sponsored,
      effects,
      money,
      sources: { identity: identityLinks(c), data: allSources },
    },
  };
}
