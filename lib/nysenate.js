// New York State Senate Open Legislation API v3 (https://legislation.nysenate.gov/static/docs/html/).
// Covers Senate and Assembly bills, Senate floor and committee votes, sponsor memos
// (Senate bills only), the primary law section a bill amends, and the Governor's
// approval and veto messages. The build script precomputes compact indexes into /data/ny.
import { fetchJson, buildUrl } from './http.js';
import { keys, isFixtureMode, nySessionYear } from './config.js';
import { readData, loadFixture, safeSegment } from './files.js';
import { extractMemoSection, FISCAL_HEADING, excerpt, isoDate } from './text.js';
import { nyLawMatches } from './issues.js';

export const OPENLEG_API = process.env.OPENLEG_API_BASE || 'https://legislation.nysenate.gov/api/3';
export const OPENLEG_SOURCE = { id: 'ny-openleg', label: 'NY State Senate Open Legislation API', url: 'https://legislation.nysenate.gov/' };

export function nyBillUrl(session, printNo) {
  return `https://www.nysenate.gov/legislation/bills/${session}/${encodeURIComponent(basePrintNo(printNo))}`;
}

/** "S1234B" -> "S1234"; "A 01234" -> "A1234". */
export function basePrintNo(printNo) {
  const m = /^([SAJBKLRCE])\s*0*(\d+)/i.exec(String(printNo ?? '').trim());
  return m ? `${m[1].toUpperCase()}${Number(m[2])}` : String(printNo ?? '').toUpperCase().replace(/\s+/g, '');
}

// ---------- API client (used by scripts/build-nysenate.mjs) ----------

export async function openLegGet(path, params = {}, opts = {}) {
  const key = keys.nysenate();
  if (!key) throw Object.assign(new Error('NYSENATE_API_KEY not configured'), { code: 'not-configured' });
  const url = buildUrl(`${OPENLEG_API}${path}`, { ...params, key });
  const json = await fetchJson(url, { label: 'NY Open Legislation', timeoutMs: opts.timeoutMs ?? 30000, retries: opts.retries ?? 4, maxWaitMs: 30000, allow404: true });
  if (json && json.success === false) throw Object.assign(new Error(`Open Legislation: ${json.message ?? 'request failed'}`), { code: 'api-error' });
  return json;
}

/** Iterate a paginated listing (offset is 1-based; next offset = offsetEnd + 1). */
export async function* openLegPages(path, params = {}, { limit = 1000, onCall, timeoutMs = 180000 } = {}) {
  let offset = 1;
  for (;;) {
    const json = await openLegGet(path, { ...params, limit, offset }, { timeoutMs });
    onCall?.();
    const items = json?.result?.items ?? [];
    yield { items, total: json?.total ?? items.length, json };
    const end = Number(json?.offsetEnd ?? 0);
    const total = Number(json?.total ?? 0);
    if (!items.length || !end || end >= total) break;
    offset = end + 1;
  }
}

function sessionMember(member, session) {
  const list = member?.sessionShortNameMap?.[String(session)] ?? [];
  return list.find((m) => !m.alternate) ?? list[0] ?? null;
}

/** Normalize a /members/{session} item (full=true). */
export function normalizeMember(m, session) {
  const sm = sessionMember(m, session);
  return {
    memberId: Number(m?.memberId),
    chamber: String(m?.chamber ?? '').toUpperCase(),
    name: m?.fullName ?? m?.person?.fullName ?? null,
    firstName: m?.person?.firstName ?? null,
    lastName: m?.person?.lastName ?? null,
    shortName: sm?.shortName ?? m?.shortName ?? null,
    district: sm?.districtCode !== undefined && sm?.districtCode !== null ? String(sm.districtCode) : (m?.districtCode !== undefined ? String(m.districtCode) : null),
    incumbent: Boolean(m?.incumbent),
  };
}

function memberIdsFromVoteList(list) {
  return (list?.items ?? []).map((x) => Number(x?.memberId)).filter(Number.isFinite);
}

/** Compact a full bill response into what the app needs (drops full text). */
export function compactBill(bill) {
  const active = bill?.activeVersion ?? '';
  const amendments = bill?.amendments?.items ?? {};
  const am = amendments[active] ?? Object.values(amendments)[0] ?? {};
  const memo = am?.memo ?? '';
  const fiscal = extractMemoSection(memo, FISCAL_HEADING);
  const votes = (bill?.votes?.items ?? []).map((v) => {
    const codes = {};
    for (const [code, list] of Object.entries(v?.memberVotes?.items ?? {})) codes[code] = memberIdsFromVoteList(list);
    return {
      type: String(v?.voteType ?? '').toUpperCase() === 'COMMITTEE' ? 'C' : 'F',
      date: isoDate(v?.voteDate),
      version: v?.version ?? '',
      committee: v?.committee?.name ?? null,
      codes,
    };
  });
  const approval = bill?.approvalMessage ?? null;
  const vetoes = (bill?.vetoMessages?.items ?? []).map((v) => ({
    number: v?.vetoNumber ?? null,
    year: v?.year ?? null,
    type: v?.vetoType ?? null,
    signer: v?.signer ?? null,
    date: isoDate(v?.signedDate),
    text: excerpt(v?.memoText ?? '', 900).text || null,
  }));
  const actions = bill?.actions?.items ?? [];
  let chapter = approval?.chapter ? Number(approval.chapter) : null;
  let signedDate = null;
  let vetoNumber = vetoes[0]?.number ?? null;
  let vetoDate = vetoes[0]?.date ?? null;
  for (const a of actions) {
    const text = String(a?.text ?? '');
    const sc = /SIGNED\s+CHAP\.?\s*(\d+)/i.exec(text);
    if (sc) { chapter = chapter ?? Number(sc[1]); signedDate = isoDate(a?.date); }
    const vm = /VETOED\s+MEMO\.?\s*(\d+)/i.exec(text);
    if (vm) { vetoNumber = vetoNumber ?? Number(vm[1]); vetoDate = vetoDate ?? isoDate(a?.date); }
  }
  return {
    p: basePrintNo(bill?.basePrintNo ?? bill?.printNo),
    session: Number(bill?.session),
    chamber: bill?.billType?.chamber ?? null,
    resolution: Boolean(bill?.billType?.resolution),
    t: bill?.title ?? null,
    sum: bill?.summary ? excerpt(bill.summary, 700).text : null,
    st: bill?.status?.statusDesc ?? null,
    stc: bill?.status?.statusType ?? null,
    sd: isoDate(bill?.status?.actionDate),
    sg: Boolean(bill?.signed),
    sponsor: bill?.sponsor?.member?.memberId ? Number(bill.sponsor.member.memberId) : null,
    sponsorName: bill?.sponsor?.member?.fullName ?? null,
    pub: isoDate(bill?.publishedDateTime),
    ls: am?.lawSection ?? null,
    lc: am?.lawCode ?? null,
    sa: (am?.sameAs?.items ?? []).map((x) => basePrintNo(x?.basePrintNo ?? x?.printNo)).filter(Boolean),
    fis: fiscal ? excerpt(fiscal, 900).text : null,
    hasMemo: Boolean(memo),
    votes,
    ch: chapter,
    signedDate,
    vn: vetoNumber,
    vetoDate,
    approval: approval ? { chapter: approval.chapter ?? null, signer: approval.signer ?? null, year: approval.year ?? null, number: approval.approvalNumber ?? null, text: excerpt(approval.text ?? '', 900).text || null } : null,
    vetoes,
  };
}

// ---------- Runtime readers for precomputed /data/ny ----------

function nyData(name) {
  return isFixtureMode() ? loadFixture(`ny-${name}`) : readData('ny', `${name}.json`);
}

export function nyMeta() {
  return nyData('meta');
}

export function nyMembersIndex() {
  return nyData('members-index')?.members ?? [];
}

export function nyBills(session = nySessionYear()) {
  return nyData(`bills-${session}`)?.bills ?? {};
}

export function nyMember(memberId) {
  if (memberId === undefined || memberId === null || memberId === '') return null;
  const id = safeSegment(memberId);
  return isFixtureMode() ? loadFixture(`ny-member-${id}`) : readData('ny', 'members', `${id}.json`);
}

export function nyGovernorActions(session = nySessionYear()) {
  return nyData(`governor-actions-${session}`)?.actions ?? [];
}

const NY_CODE_LABEL = { AYE: 'Aye', NAY: 'Nay', AYEWR: 'Aye with reservations', EXC: 'Excused', ABS: 'Absent', ABD: 'Abstained' };

export function nyVoteLabel(code) {
  return NY_CODE_LABEL[String(code).toUpperCase()] ?? String(code);
}

/** NY Senate votes on the selected issues for one member (Open Legislation memberId). */
export function nySenateVotesOnIssues(memberId, issueIds, { includeCommittee = false, limit = 80 } = {}) {
  const member = nyMember(memberId);
  if (!member) return null;
  const session = member.session ?? nySessionYear();
  const bills = nyBills(session);
  const items = [];
  let substantiveTotal = 0;
  for (const [printNo, date, type, code, committee] of member.votes ?? []) {
    if (type === 'C' && !includeCommittee) continue;
    substantiveTotal += 1;
    const b = bills[printNo];
    const issues = nyLawMatches(b?.ls, issueIds);
    if (!issues.length) continue;
    items.push({
      date,
      jurisdiction: 'New York State',
      chamber: type === 'C' ? `Senate ${committee ?? ''} Committee`.replace(/\s+/g, ' ') : 'NY Senate',
      bill: { number: printNo, title: b?.t ?? null, url: nyBillUrl(session, printNo), lawSection: b?.ls ?? null },
      question: type === 'C' ? 'Committee vote' : 'Floor vote on the bill',
      kind: type === 'C' ? 'committee' : 'passage',
      kindLabel: type === 'C' ? 'Committee vote' : 'Passage',
      vote: nyVoteLabel(code),
      result: null,
      billStatus: b?.st ?? null,
      issues,
      links: [{ label: 'Bill page with votes (NY Senate)', url: nyBillUrl(session, printNo) }],
    });
  }
  items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { items: items.slice(0, limit), matchedTotal: items.length, substantiveTotal, session, chamber: member.chamber ?? null };
}

/** Bills a NY legislator sponsored (from Open Legislation), filtered by issue. */
export function nySponsoredOnIssues(memberId, issueIds, { limit = 25 } = {}) {
  const member = nyMember(memberId);
  if (!member) return null;
  const session = member.session ?? nySessionYear();
  const items = (member.sponsored ?? [])
    .map((b) => ({ b, issues: nyLawMatches(b.ls, issueIds) }))
    .filter((x) => x.issues.length)
    .sort((x, y) => String(y.b.sd ?? y.b.pub ?? '').localeCompare(String(x.b.sd ?? x.b.pub ?? '')))
    .map(({ b, issues }) => ({
      number: b.p,
      title: b.t,
      url: nyBillUrl(session, b.p),
      lawSection: b.ls ?? null,
      introducedDate: b.pub ?? null,
      status: b.st ?? null,
      statusDate: b.sd ?? null,
      becameLaw: Boolean(b.sg && b.ch),
      chapter: b.ch ?? null,
      summary: b.sum ? { text: b.sum, source: 'NY Legislative Bill Drafting Commission summary (via Open Legislation)' } : null,
      fiscal: b.fis ? { text: b.fis, source: "Sponsor's memo: Fiscal implications (as written by the sponsor)" } : null,
      approval: b.appr ?? null,
      veto: b.veto ?? null,
      issues,
    }));
  return { items: items.slice(0, limit), matchedTotal: items.length, total: (member.sponsored ?? []).length, session };
}

/** Governor's signatures and vetoes on the selected issues (signer must match the candidate). */
export function governorActionsOnIssues(candidateLastName, issueIds, { limit = 60, session = nySessionYear() } = {}) {
  const last = String(candidateLastName ?? '').toUpperCase().replace(/[^A-Z]/g, '');
  const all = nyGovernorActions(session);
  // `sig` comes from the Governor's own approval/veto message; `si` is the signer named in
  // this session's messages, used for bills signed without a message (marked as such).
  const items = all
    .filter((a) => !last || String(a.sig ?? a.si ?? '').toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).includes(last))
    .map((a) => ({ a, issues: nyLawMatches(a.ls, issueIds) }))
    .filter((x) => x.issues.length)
    .sort((x, y) => String(y.a.d ?? '').localeCompare(String(x.a.d ?? '')))
    .map(({ a, issues }) => ({
      date: a.d ?? null,
      action: a.a === 'vetoed' ? 'Vetoed' : 'Signed into law',
      chapter: a.ch ?? null,
      vetoNumber: a.vn ?? null,
      bill: { number: a.p, title: a.t ?? null, url: nyBillUrl(session, a.p), lawSection: a.ls ?? null },
      message: a.x ? { text: a.x, source: a.a === 'vetoed' ? "Governor's veto message" : "Governor's approval message" } : null,
      signer: a.sig ?? a.si ?? null,
      signerSource: a.sig ? 'message' : 'session',
      issues,
    }));
  return { items: items.slice(0, limit), matchedTotal: items.length, total: all.length, session };
}
