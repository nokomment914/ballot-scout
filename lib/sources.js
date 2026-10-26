// Source registry and "last updated" dates for precomputed data.
import { votesMeta, VOTEVIEW_SOURCE } from './votes.js';
import { nyMeta, OPENLEG_SOURCE } from './nysenate.js';
import { OPENSTATES_SOURCE } from './openstates.js';
import { CONGRESS_SOURCE } from './congress.js';
import { FEC_SOURCE } from './fec.js';
import { CIVIC_SOURCE } from './civic.js';
import { GEOCODER_SOURCE } from './geocoder.js';
import { loadOutside, OUTSIDE_SOURCE } from './outside.js';

export function dataFreshness() {
  const vm = votesMeta();
  const nm = nyMeta();
  const om = loadOutside();
  const omCandidates = Object.values(om?.candidates ?? {});
  return {
    federalVotes: {
      ...VOTEVIEW_SOURCE,
      status: vm?.status ?? (vm ? 'ok' : 'not-built'),
      lastUpdated: vm?.voteview?.downloadedAt ?? null,
      detail: vm?.congresses?.length ? `Congresses ${vm.congresses.join(', ')}; ${vm.rollcallCount ?? 0} substantive roll calls` : 'Not built yet',
    },
    federalBills: {
      ...CONGRESS_SOURCE,
      label: 'Congress.gov bill data (policy area, title, laws, CBO estimates)',
      status: vm?.congressGov?.status ?? (vm ? 'ok' : 'not-built'),
      lastUpdated: vm?.congressGov?.lastRun ?? null,
      detail: vm?.congressGov ? `${vm.congressGov.billsWithPolicyArea ?? 0} of ${vm.congressGov.billsTotal ?? 0} voted-on bills have a policy area so far` : 'Not built yet',
    },
    nySenate: {
      ...OPENLEG_SOURCE,
      status: nm?.openLegislation?.status ?? (nm ? 'ok' : 'not-built'),
      lastUpdated: nm?.openLegislation?.lastUpdated ?? null,
      detail: nm?.openLegislation ? `${nm.session}-${Number(nm.session) + 1} session; ${nm.openLegislation.bills ?? 0} bills` : 'Not built yet',
    },
    nyMoney: {
      id: 'ny-money',
      label: 'NYS Board of Elections campaign finance (data.ny.gov)',
      url: 'https://data.ny.gov/d/e9ss-239a',
      status: nm?.nyMoney?.status ?? 'not-built',
      lastUpdated: nm?.nyMoney?.lastUpdated ?? null,
      detail: nm?.nyMoney?.status === 'ok' ? `${nm.nyMoney.matched ?? 0} candidates linked to their committees; ${nm.nyMoney.unmatched ?? 0} not linked` : (nm?.nyMoney?.error ?? 'Not built yet'),
    },
    outsideSpending: {
      ...OUTSIDE_SOURCE,
      status: om ? 'ok' : 'not-built',
      lastUpdated: om?.builtAt ?? null,
      detail: om ? `${omCandidates.filter((c) => c.status === 'ok').length} of ${omCandidates.length} federal candidates matched to an FEC record; cycles ${(om.cycles ?? []).join(', ')}` : 'Not built yet',
    },
    nyAssembly: {
      ...OPENSTATES_SOURCE,
      status: nm?.openStates?.status ?? (nm ? 'ok' : 'not-built'),
      lastUpdated: nm?.openStates?.exportUpdatedAt ?? nm?.openStates?.lastUpdated ?? null,
      detail: nm?.openStates ? `${nm.openStates.voteEvents ?? 0} roll calls in the bulk export` : 'Not built yet',
    },
  };
}

export const LIVE_SOURCES = [GEOCODER_SOURCE, CIVIC_SOURCE, CONGRESS_SOURCE, FEC_SOURCE];
