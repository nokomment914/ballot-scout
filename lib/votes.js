// Federal roll-call votes, precomputed by scripts/build-votes.mjs from Voteview's
// per-Congress CSVs and joined to Congress.gov bill data (policy area, title, laws, CBO).
// Runtime reads the compact indexes in /data/votes (or /fixtures in sample mode).
import { isFixtureMode } from './config.js';
import { readData, loadFixture, safeSegment } from './files.js';
import { policyAreaMatches } from './issues.js';
import { ordinal } from './text.js';

export const VOTEVIEW_SOURCE = { id: 'voteview', label: 'Voteview (UCLA) roll-call data', url: 'https://voteview.com/data' };

/**
 * Classify a roll-call question. Returns one of 'passage' | 'suspension' | 'conference' |
 * 'veto-override' | 'amendment', or null for procedural votes (cloture, motions to table,
 * recommit, previous question, rules, nominations...), which are excluded.
 */
export function classifyQuestion(question, description = '') {
  const q = String(question ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const desc = String(description ?? '').toLowerCase();
  if (!q) return null;
  if (/veto|objections of the president/.test(q)) return 'veto-override';
  if (/table|recommit|reconsider|previous question|cloture|motion to proceed|adjourn|quorum|journal|waive|point of order|instruct|postpone|nomination|ratification|appeal|ruling of the chair|discharge|motion to commit|question of consideration|motion to refer|motion to rise|resolve into/.test(q)) return null;
  if (/conference report/.test(q)) return 'conference';
  if (/suspend the rules/.test(q)) return /\b(pass|agree|concur)/.test(q) ? 'suspension' : null;
  if (/concur|agree to the (senate|house) amendment|agreeing to the (senate|house) amendment/.test(q)) return 'passage';
  if (/amendment/.test(q)) return 'amendment';
  if (/^on (the )?motion$/.test(q)) return /concur/.test(desc) ? 'passage' : null;
  if (/providing for (the )?consideration|special rule/.test(desc) && /resolution/.test(q)) return null; // House rules are procedural
  if (/^on passage|passage of the bill|^on (the )?(bill|joint resolution|concurrent resolution|resolution)\b|^on agreeing to the (resolution|concurrent resolution|joint resolution)/.test(q)) return 'passage';
  return null;
}

export const KIND_LABELS = {
  passage: 'Passage',
  suspension: 'Passage under suspension of the rules',
  conference: 'Conference report',
  'veto-override': 'Veto override',
  amendment: 'Amendment',
  committee: 'Committee vote',
};

/** Voteview cast codes -> displayed vote. */
export const CAST = {
  1: 'Yea', 2: 'Paired yea', 3: 'Announced yea', 4: 'Announced nay', 5: 'Paired nay', 6: 'Nay', 7: 'Present', 8: 'Present', 9: 'Not voting',
};

export function castLabel(code) {
  return CAST[Number(code)] ?? 'Not recorded';
}

const BILL_RE = /^(HCONRES|SCONRES|HJRES|SJRES|HRES|SRES|HR|S)\s*0*(\d+)$/i;

/** "HR30" / "H.R. 30" / "SJRES 7" -> { type: 'hr', number: '30' } (bills and resolutions only). */
export function parseBillNumber(raw) {
  const s = String(raw ?? '').toUpperCase().replace(/[.\s]/g, '');
  const m = BILL_RE.exec(s);
  if (!m) return null;
  return { type: m[1].toLowerCase(), number: String(Number(m[2])) };
}

const TYPE_DISPLAY = { hr: 'H.R.', s: 'S.', hjres: 'H.J.Res.', sjres: 'S.J.Res.', hconres: 'H.Con.Res.', sconres: 'S.Con.Res.', hres: 'H.Res.', sres: 'S.Res.' };
const TYPE_SLUG = { hr: 'house-bill', s: 'senate-bill', hjres: 'house-joint-resolution', sjres: 'senate-joint-resolution', hconres: 'house-concurrent-resolution', sconres: 'senate-concurrent-resolution', hres: 'house-resolution', sres: 'senate-resolution' };

export function billKey(congress, type, number) {
  return `${congress}-${String(type).toLowerCase()}-${Number(number)}`;
}

export function parseBillKey(key) {
  const m = /^(\d+)-([a-z]+)-(\d+)$/.exec(String(key ?? ''));
  return m ? { congress: Number(m[1]), type: m[2], number: m[3] } : null;
}

export function billDisplay(type, number) {
  return `${TYPE_DISPLAY[String(type).toLowerCase()] ?? String(type).toUpperCase()} ${number}`;
}

export function congressBillUrl(congress, type, number) {
  const slug = TYPE_SLUG[String(type).toLowerCase()];
  return slug ? `https://www.congress.gov/bill/${ordinal(congress)}-congress/${slug}/${number}` : 'https://www.congress.gov/';
}

/** Official roll-call record links (formats from the Congress.gov API documentation examples). */
export function rollcallLinks(rc) {
  const links = [];
  const year = String(rc.date ?? '').slice(0, 4);
  if (rc.chamber === 'House' && rc.clerkRoll && year) {
    links.push({ label: 'Official roll call (Clerk of the House)', url: `https://clerk.house.gov/evs/${year}/roll${String(rc.clerkRoll).padStart(3, '0')}.xml` });
  }
  if (rc.chamber === 'Senate' && rc.clerkRoll && rc.session) {
    links.push({ label: 'Official roll call (U.S. Senate)', url: `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${rc.congress}${rc.session}/vote_${rc.congress}_${rc.session}_${String(rc.clerkRoll).padStart(5, '0')}.xml` });
  }
  if (rc.voteviewRoll) {
    links.push({ label: 'Voteview record', url: `https://voteview.com/rollcall/R${rc.chamber === 'Senate' ? 'S' : 'H'}${rc.congress}${String(rc.voteviewRoll).padStart(4, '0')}` });
  }
  return links;
}

function loadIndex(name) {
  return isFixtureMode() ? loadFixture(`votes-${name}`) : readData('votes', `${name}.json`);
}

export function votesMeta() {
  return loadIndex('meta');
}

export function loadMembersIndex() {
  return loadIndex('members-index')?.members ?? {};
}

export function loadBills() {
  return loadIndex('bills')?.bills ?? {};
}

let rcCache = { src: null, map: null };
export function loadRollcalls() {
  const raw = loadIndex('rollcalls');
  if (!raw) return new Map();
  if (rcCache.src === raw) return rcCache.map;
  const fields = raw.fields ?? ['chamber', 'congress', 'session', 'date', 'clerkRoll', 'voteviewRoll', 'bill', 'question', 'kind', 'result', 'desc'];
  const map = new Map();
  for (const [id, row] of Object.entries(raw.rollcalls ?? {})) {
    const o = { id };
    fields.forEach((f, i) => { o[f] = row[i]; });
    o.chamber = o.chamber === 'S' ? 'Senate' : o.chamber === 'H' ? 'House' : o.chamber;
    map.set(id, o);
  }
  rcCache = { src: raw, map };
  return map;
}

export function loadMemberVotes(bioguide) {
  if (!bioguide) return null;
  const id = safeSegment(String(bioguide).toUpperCase());
  return isFixtureMode() ? loadFixture(`votes-member-${id}`) : readData('votes', 'members', `${id}.json`);
}

export const NOT_IN_OFFICE = 'Not in office at the time';

/**
 * Every roll call on a published issue list, with this member's vote. The vote comes from the
 * list itself (read from the Clerk of the House for members on the ballot) or, for anyone the
 * list doesn't cover, from the Voteview index. A roll call with no record for a member who has
 * Voteview data means they weren't a member then (Voteview code 0, dropped by the build).
 * Every roll call on the list is returned, amendments included, so each member's row count matches.
 */
export function curatedVotesForMember(bioguide, list, issueId) {
  if (!bioguide || !list?.rollcalls?.length) return [];
  const id = String(bioguide).toUpperCase();
  const member = loadMemberVotes(id);
  const cast = member ? new Map(member.votes ?? []) : null;
  const byRoll = new Map();
  if (cast) for (const rc of loadRollcalls().values()) if (rc.clerkRoll) byRoll.set(`${rc.chamber}|${rc.congress}|${Number(rc.clerkRoll)}`, rc);
  return list.rollcalls.map((r) => {
    let vote = r.votes?.[id] ?? null;
    let voteSource = vote ? 'list' : null;
    if (!vote && cast) {
      const rc = byRoll.get(`${r.chamber ?? 'House'}|${r.congress}|${Number(r.roll)}`);
      if (rc) { vote = cast.has(rc.id) ? castLabel(cast.get(rc.id)) : 'Not in office'; voteSource = 'voteview'; }
    }
    if (vote === 'Not in office') vote = NOT_IN_OFFICE;
    const year = String(r.date ?? '').slice(0, 4);
    const links = [
      { label: 'Official roll call (Clerk of the House)', url: r.pageUrl ?? r.sourceUrl },
      ...(r.pageUrl && r.sourceUrl && r.sourceUrl !== r.pageUrl ? [{ label: 'Roll call record', url: r.sourceUrl }] : []),
      ...(r.amendment?.descriptionSource?.url ? [{ label: 'Amendment summary', url: r.amendment.descriptionSource.url }] : []),
    ].filter((l) => l.url);
    return {
      date: r.date,
      jurisdiction: 'U.S. Congress',
      chamber: r.chamber ?? 'House',
      rollcall: r.roll,
      rollcallYear: year,
      bill: r.bill ? { number: r.bill.number, title: r.bill.title ?? null, url: r.bill.url ?? null, policyArea: null } : null,
      question: r.question,
      description: r.amendment ? `${r.amendment.number} (${r.amendment.sponsor}): ${r.amendment.description}` : null,
      kind: r.kind,
      kindLabel: KIND_LABELS[r.kind] ?? r.kind,
      vote: vote ?? 'Not recorded in our sources',
      voteSource,
      notInOffice: vote === NOT_IN_OFFICE,
      result: r.tally ? `${r.result} (${r.tally})` : (r.result ?? null),
      issues: [issueId],
      curated: true,
      links,
    };
  });
}

/**
 * Votes on the selected issues for one member.
 * @returns {{ items: object[], substantiveTotal: number, matchedTotal: number }}
 */
export function federalVotesOnIssues(bioguide, issueIds, { includeAmendments = false, limit = 80 } = {}) {
  const member = loadMemberVotes(bioguide);
  if (!member) return null;
  const rollcalls = loadRollcalls();
  const bills = loadBills();
  const items = [];
  let substantiveTotal = 0;
  for (const [rcId, code] of member.votes ?? []) {
    const rc = rollcalls.get(rcId);
    if (!rc || !rc.kind) continue;
    if (rc.kind === 'amendment' && !includeAmendments) continue;
    substantiveTotal += 1;
    const bill = bills[rc.bill] ?? null;
    const issues = policyAreaMatches(bill?.pa, issueIds);
    if (!issues.length) continue;
    const parsed = parseBillKey(rc.bill);
    items.push({
      date: rc.date,
      jurisdiction: 'U.S. Congress',
      chamber: rc.chamber,
      rollcall: rc.clerkRoll ?? rc.voteviewRoll,
      bill: parsed ? {
        number: billDisplay(parsed.type, parsed.number),
        title: bill?.t ?? null,
        url: congressBillUrl(parsed.congress, parsed.type, parsed.number),
        policyArea: bill?.pa ?? null,
      } : null,
      question: rc.question,
      description: rc.desc || null,
      kind: rc.kind,
      kindLabel: KIND_LABELS[rc.kind] ?? rc.kind,
      vote: castLabel(code),
      result: rc.result || null,
      issues,
      links: rollcallLinks(rc),
    });
  }
  items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { items: items.slice(0, limit), matchedTotal: items.length, substantiveTotal };
}
