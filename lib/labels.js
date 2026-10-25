// Record labels. Every candidate gets the same sections; these labels explain, in neutral
// terms, why a section may be empty. A missing record is never treated as a negative.
import { officeKey } from './order.js';

export const LABELS = Object.freeze({
  noRecord: 'No legislative voting record in these databases',
  executive: 'Executive office: no voting record',
  judicial: 'Judicial races have no voting records',
  unlinked: 'Legislative record not linked yet: see Sources for the official record',
  local: 'City, county, town and village records aren’t covered by this guide yet',
});

const EXECUTIVE_TITLE = /\b(governor|attorney general|comptroller|mayor|public advocate|borough president|county executive|secretary of state|treasurer|president of the united states|vice president)\b/i;
const LEGISLATIVE_TITLE = /\b(senat|assembly|assemblymember|representative|congress|council|legislat|delegate)\w*/i;

export function isExecutiveTitle(title) {
  const t = String(title ?? '');
  return EXECUTIVE_TITLE.test(t) && !LEGISLATIVE_TITLE.test(t.replace(/lieutenant governor/i, ''));
}

/** "State Senator, SD 28", "Member of Assembly, AD 69", "U.S. Representative, NY-12"... */
export function isLegislativeTitle(title) {
  const t = String(title ?? '');
  return Boolean(t) && LEGISLATIVE_TITLE.test(t) && !EXECUTIVE_TITLE.test(t) && !/council/i.test(t);
}

export function isGovernorTitle(title) {
  const t = String(title ?? '').toLowerCase();
  return /\bgovernor\b/.test(t) && !/lieutenant/.test(t);
}

export function isJudicialContest(contest) {
  if (!contest) return false;
  if (contest.level === 'judicial' || contest.districtType === 'judicial-district') return true;
  return /\b(judge|justice|surrogate|court)\b/i.test(contest.office ?? '');
}

const LEGISLATIVE_OFFICE_KEYS = new Set(['us-house', 'us-senate', 'state-senate', 'state-assembly']);

export function isLegislativeContest(contest) {
  return LEGISLATIVE_OFFICE_KEYS.has(officeKey(contest?.office, contest ?? {}));
}

export function isExecutiveContest(contest) {
  if (!contest || isJudicialContest(contest) || isLegislativeContest(contest)) return false;
  return isExecutiveTitle(contest.office);
}

export function hasLegislativeIds(ids) {
  return Boolean(ids && (ids.bioguide || ids.nysenate || ids.openstates));
}

/**
 * Decide which record types apply and which labels to show.
 * @param {{contest: object, candidate: object, ids?: object, role?: 'candidate'|'running-mate'}} p
 */
export function recordProfile({ contest, candidate, ids, role = 'candidate' }) {
  const judicial = isJudicialContest(contest);
  const legislative = hasLegislativeIds(ids ?? candidate?.ids);
  const currentOffice = candidate?.currentOffice ?? '';
  const executive = !judicial && (
    isExecutiveTitle(currentOffice) ||
    (role === 'candidate' && Boolean(candidate?.incumbent) && isExecutiveContest(contest))
  );
  const governor = executive && (isGovernorTitle(currentOffice) || (role === 'candidate' && candidate?.incumbent && officeKey(contest?.office, contest) === 'governor'));
  // County, town, city and village offices: this guide has no database of their records.
  const local = !judicial && contest?.level === 'local';
  const labels = [];
  if (judicial) labels.push(LABELS.judicial);
  if (local && !legislative) labels.push(LABELS.local);
  else if (executive) labels.push(LABELS.executive);
  if (!legislative && !judicial && !executive && !local) {
    // A sitting legislator (by incumbency or by current office) whose record isn't linked yet
    // gets an honest "not linked" label rather than "no record".
    const sittingLegislator = (role === 'candidate' && candidate?.incumbent && isLegislativeContest(contest)) || isLegislativeTitle(currentOffice);
    labels.push(sittingLegislator ? LABELS.unlinked : LABELS.noRecord);
  }
  return { judicial, legislative, executive: executive && !(local && !legislative), governor: Boolean(governor), local, labels };
}
