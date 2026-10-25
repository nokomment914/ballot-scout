// Pure functions for scripts/build-nysenate.mjs (unit-tested in tests/build.test.js).
import { parseCsv } from '../csv.js';
import { normalizeNyIdentifier, parseArrayField, voteKind } from '../openstates.js';
import { isoDate } from '../text.js';

/** Most common signer named in this session's approval/veto messages (null if none or a tie). */
export function sessionSigner(bills) {
  const counts = new Map();
  for (const b of bills) {
    const names = [b.approval?.signer, ...(b.vetoes ?? []).map((v) => v.signer)].filter(Boolean).map((s) => String(s).trim().toUpperCase());
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (!sorted.length || (sorted[1] && sorted[1][1] === sorted[0][1])) return null;
  return sorted[0][0];
}

function sponsoredEntry(b) {
  return {
    p: b.p, t: b.t, ls: b.ls, st: b.st, sd: b.sd, sg: b.sg, ch: b.ch ?? null, sum: b.sum ?? null, fis: b.fis ?? null, pub: b.pub ?? null,
    appr: b.approval?.text ? { text: b.approval.text } : null,
    veto: b.vetoes?.[0]?.text ? { text: b.vetoes[0].text, number: b.vetoes[0].number ?? b.vn ?? null } : null,
  };
}

/**
 * From compact Open Legislation bills (see compactBill in lib/nysenate.js) derive:
 *  - per-member files (sponsored bills + Senate floor/committee votes)
 *  - the bill lookup used to label votes
 *  - the Governor's signatures and vetoes
 */
export function deriveNyOutputs(billList, members, session, { extraBillIds = new Set(), subjects = new Map() } = {}) {
  const real = billList.filter((b) => b && b.p && !b.resolution);
  const memberFiles = new Map();
  const ensure = (id) => {
    const key = String(id);
    if (!memberFiles.has(key)) {
      const m = members.find((x) => String(x.memberId) === key);
      memberFiles.set(key, { memberId: Number(id), chamber: m?.chamber ?? null, name: m?.name ?? null, district: m?.district ?? null, session, sponsored: [], votes: [] });
    }
    return memberFiles.get(key);
  };
  for (const m of members) ensure(m.memberId);

  const voted = new Set();
  for (const b of real) {
    if (b.sponsor) ensure(b.sponsor).sponsored.push(sponsoredEntry(b));
    for (const v of b.votes ?? []) {
      for (const [code, ids] of Object.entries(v.codes ?? {})) {
        for (const id of ids) ensure(id).votes.push([b.p, v.date, v.type, code, v.type === 'C' ? (v.committee ?? '') : '']);
      }
      voted.add(b.p);
    }
  }
  for (const f of memberFiles.values()) {
    f.sponsored.sort((a, b) => String(b.sd ?? b.pub ?? '').localeCompare(String(a.sd ?? a.pub ?? '')));
    f.votes.sort((a, b) => String(b[1]).localeCompare(String(a[1])));
  }

  const signer = sessionSigner(real);
  const actions = [];
  for (const b of real) {
    const signed = b.stc === 'SIGNED_BY_GOV' || (b.sg && b.ch);
    const vetoed = b.stc === 'VETOED' || Boolean(b.vetoes?.length);
    if (signed) {
      actions.push({ p: b.p, t: b.t, ls: b.ls, a: 'signed', d: b.signedDate ?? b.sd ?? null, ch: b.ch ?? null, sig: b.approval?.signer ?? null, si: b.approval?.signer ? null : signer, x: b.approval?.text ?? null, fis: b.fis ?? null });
    } else if (vetoed) {
      const v = b.vetoes?.[0];
      actions.push({ p: b.p, t: b.t, ls: b.ls, a: 'vetoed', d: v?.date ?? b.vetoDate ?? b.sd ?? null, vn: v?.number ?? b.vn ?? null, sig: v?.signer ?? null, si: v?.signer ? null : signer, x: v?.text ?? null, fis: b.fis ?? null });
    }
  }
  actions.sort((a, b) => String(b.d ?? '').localeCompare(String(a.d ?? '')));

  const bills = {};
  const want = new Set([...voted, ...extraBillIds, ...actions.map((a) => a.p)]);
  for (const b of real) {
    if (!want.has(b.p)) continue;
    bills[b.p] = { t: b.t, ls: b.ls, st: b.st, sd: b.sd, sg: b.sg, ch: b.ch ?? null, sa: b.sa?.length ? b.sa : undefined, subj: subjects.get(b.p) ?? undefined };
  }
  return { memberFiles, bills, actions, signer };
}

/**
 * Parse an Open States session CSV export (files from the zip, keyed by path) into
 * per-person roll-call rows for the lower chamber (Assembly).
 */
export function parseOpenStatesExport(files, { chamber = 'lower' } = {}) {
  const find = (suffix) => Object.entries(files).find(([name]) => name.endsWith(suffix))?.[1];
  const text = (buf) => (buf ? buf.toString('utf8') : '');
  const orgs = new Map(parseCsv(text(find('_organizations.csv'))).map((o) => [o.id, o.classification]));
  const bills = new Map();
  const subjects = new Map();
  for (const b of parseCsv(text(find('_bills.csv')))) {
    const p = normalizeNyIdentifier(b.identifier);
    if (!p) continue;
    const cls = parseArrayField(b.classification);
    bills.set(b.id, { p, resolution: cls.some((c) => c.includes('resolution')) });
    const subj = (String(b.subject ?? '').match(/'([^']+)'|"([^"]+)"/g) ?? []).map((s) => s.slice(1, -1)).filter(Boolean);
    if (subj.length) subjects.set(p, subj);
  }
  const sources = new Map();
  for (const s of parseCsv(text(find('_vote_sources.csv')))) if (!sources.has(s.vote_event_id) && /^https?:\/\//.test(s.url ?? '')) sources.set(s.vote_event_id, s.url);
  const events = new Map();
  for (const v of parseCsv(text(find('_votes.csv')))) {
    const bill = bills.get(v.bill_id);
    if (!bill || bill.resolution) continue;
    if (orgs.get(v.organization_id) !== chamber) continue;
    events.set(v.id, { p: bill.p, date: isoDate(v.start_date), kind: voteKind(v.motion_classification, v.motion_text), motion: String(v.motion_text ?? '').trim().slice(0, 200), source: sources.get(v.id) ?? null });
  }
  const byPerson = new Map();
  const names = new Map();
  parseCsv(text(find('_vote_people.csv')), {
    onRow: (r) => {
      const e = events.get(r.vote_event_id);
      if (!e || !/^ocd-person\//.test(r.voter_id ?? '')) return;
      if (!byPerson.has(r.voter_id)) byPerson.set(r.voter_id, []);
      byPerson.get(r.voter_id).push([e.p, e.date, e.kind, String(r.option ?? '').toLowerCase(), e.motion, e.source]);
      if (!names.has(r.voter_id)) names.set(r.voter_id, r.voter_name);
    },
  });
  for (const rows of byPerson.values()) rows.sort((a, b) => String(b[1]).localeCompare(String(a[1])));
  return { byPerson, names, subjects, billIds: new Set([...events.values()].map((e) => e.p)), voteEvents: events.size };
}

/** Attach Open States person ids to Open Legislation members by chamber + district (+ surname check). */
export function joinOpenStatesPeople(members, people) {
  const surname = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]/g, '');
  return members.map((m) => {
    const chamber = m.chamber === 'SENATE' ? 'upper' : m.chamber === 'ASSEMBLY' ? 'lower' : null;
    const hits = people.filter((p) => p?.current_role?.org_classification === chamber && String(p?.current_role?.district ?? '') === String(m.district ?? ''));
    const last = surname(m.lastName || String(m.shortName ?? '').split(/\s+/)[0] || String(m.name ?? '').split(' ').pop());
    const same = hits.filter((p) => {
      const fam = surname(p.family_name || String(p.name ?? '').split(' ').pop());
      return Boolean(fam && last) && (fam === last || fam.includes(last) || last.includes(fam));
    });
    const match = same.length === 1 ? same[0] : null;
    return { ...m, openstatesId: match?.id ?? m.openstatesId ?? null, openstatesUrl: match?.openstates_url ?? m.openstatesUrl ?? null };
  });
}
