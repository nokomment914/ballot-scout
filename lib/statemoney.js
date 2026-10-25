// Money for state and local candidates. Federal races use OpenFEC (lib/fec.js).
// New York: candidates file with the NYS Board of Elections. When the nightly build has linked a
// candidate to their registered committee (scripts/build-nymoney.mjs, data.ny.gov open data), the
// itemized transactions are summed by schedule; otherwise the official search links are shown.
// Every candidate in a race gets the same layout either way.
import { isFixtureMode, electionCycle } from './config.js';
import { readData, loadFixture } from './files.js';
import { moneyKey, datasetLinks, DATASETS } from './nymoney.js';

export const NY_MONEY_SOURCES = [
  { label: 'NYS Board of Elections: campaign finance disclosure search', url: 'https://publicreporting.elections.ny.gov/' },
  { label: 'NYS Board of Elections: campaign finance information', url: 'https://elections.ny.gov/campaign-finance' },
  { label: 'NYS Public Campaign Finance Board: public disclosure', url: 'https://pcfb.ny.gov/public-disclosure' },
];

export function nyMoneyFile() {
  return isFixtureMode() ? loadFixture('ny-money') : readData('ny', `money-${electionCycle()}.json`);
}

export function stateMoney({ state, level, name, office, district, role }) {
  if (String(state).toUpperCase() !== 'NY') {
    return {
      status: 'link-out',
      note: 'State and local candidates file campaign finance reports with their state’s election or ethics agency, which this app does not yet include for this state.',
      links: [],
    };
  }
  const file = role === 'running-mate' ? null : nyMoneyFile();
  const entry = file?.candidates?.[moneyKey({ office, district, name })];
  if (entry) {
    const years = (entry.years ?? file.years ?? []).join('–');
    return {
      status: 'ok',
      filer: { id: entry.filer?.id ?? null, name: entry.filer?.name ?? null, status: entry.filer?.status ?? null, office: entry.filer?.office ?? null },
      years,
      schedules: entry.schedules ?? [],
      transactions: entry.transactions ?? 0,
      latestDate: entry.latestDate ?? null,
      note: `Itemized transactions in reports filed for ${years}, summed by schedule as published in the NYS Board of Elections’ disclosure data. Each transaction number is counted once, so amended reports aren’t double-counted. Unitemized contributions aren’t included, so totals can differ from the summary pages of the official reports.`,
      links: [
        ...NY_MONEY_SOURCES.slice(0, 1),
        { label: 'Disclosure data on data.ny.gov (search this filer ID)', url: datasetLinks(DATASETS.disclosures).landing },
        ...NY_MONEY_SOURCES.slice(2),
      ],
      source: { label: 'NYS Board of Elections disclosure data (data.ny.gov)', url: datasetLinks(DATASETS.disclosures).landing, lastUpdated: file.generatedAt ?? null },
    };
  }
  return {
    status: 'link-out',
    note: level === 'judicial'
      ? 'Judicial candidates in New York file campaign finance reports with the NYS Board of Elections. Search by the candidate’s name.'
      : level === 'local'
        ? 'This guide doesn’t total campaign money for county, town and village candidates yet. Search the NYS Board of Elections’ campaign finance disclosure system by the candidate’s name.'
      : role === 'running-mate'
        ? 'Running mates share the ticket’s campaign committee. See the candidate for Governor’s Money tab, or search the NYS Board of Elections.'
        : 'New York State candidates file campaign finance reports with the NYS Board of Elections. Candidates in the public matching-funds program also report to the NYS Public Campaign Finance Board. Search by the candidate’s name.',
    links: NY_MONEY_SOURCES,
  };
}
