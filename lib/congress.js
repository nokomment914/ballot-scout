// Congress.gov API v3 client.
// Docs: https://github.com/LibraryOfCongress/api.congress.gov (Documentation/*.md, openapi.json).
// Responses wrap data in a key named for the endpoint ("member", "sponsoredLegislation",
// "bill", "summaries"). The API now defaults to XML, so format=json is always sent.
import { fetchJson, buildUrl } from './http.js';
import { cached, HOUR, DAY } from './cache.js';
import { isFixtureMode, keys } from './config.js';
import { loadFixture } from './files.js';
import { stripHtml, excerpt, isoDate } from './text.js';
import { billDisplay, congressBillUrl } from './votes.js';

export const API = process.env.CONGRESS_API_BASE || 'https://api.congress.gov/v3';
export const CONGRESS_SOURCE = { id: 'congress-gov', label: 'Congress.gov API (Library of Congress)', url: 'https://api.congress.gov/' };

/** Current Congress for a given date: the 119th runs Jan 3, 2025 - Jan 3, 2027. */
export function congressForDate(date = new Date()) {
  const d = new Date(date);
  const y = d.getUTCFullYear();
  const startsYear = y % 2 === 1 ? y : y - 1;
  const beforeJan3 = d.getUTCMonth() === 0 && d.getUTCDate() < 3;
  const firstYear = beforeJan3 && y % 2 === 1 ? startsYear - 2 : startsYear;
  return Math.floor((firstYear - 1789) / 2) + 1;
}

async function get(path, params = {}, { ttl = 6 * HOUR, fixture } = {}) {
  if (isFixtureMode()) return fixture ? loadFixture(fixture) : null;
  const apiKey = keys.dataGov();
  if (!apiKey) {
    const err = new Error('Congress.gov API key not configured');
    err.code = 'not-configured';
    throw err;
  }
  const url = buildUrl(`${API}${path}`, { ...params, format: 'json', api_key: apiKey });
  return cached(`congress:${path}:${JSON.stringify(params)}`, ttl, () =>
    fetchJson(url, { label: 'Congress.gov API', timeoutMs: 8000, retries: 2, allow404: true })
  );
}

export async function getMember(bioguide) {
  const json = await get(`/member/${encodeURIComponent(bioguide)}`, {}, { ttl: DAY, fixture: `congress-member-${bioguide}` });
  return json?.member ?? null;
}

/** Current members for a state (and optional district). */
export async function getCurrentMembers(stateCode, district) {
  const path = district !== undefined && district !== null
    ? `/member/${encodeURIComponent(stateCode)}/${encodeURIComponent(district)}`
    : `/member/${encodeURIComponent(stateCode)}`;
  const json = await get(path, { currentMember: 'true', limit: 250 }, { ttl: DAY, fixture: `congress-members-${stateCode}${district !== undefined && district !== null ? `-${district}` : ''}` });
  return (json?.members ?? []).map((m) => ({
    bioguide: m?.bioguideId ?? null,
    name: m?.name ?? null,
    party: m?.partyName ?? null,
    state: m?.state ?? null,
    district: m?.district ?? null,
    chamber: Array.isArray(m?.terms?.item) ? m.terms.item[m.terms.item.length - 1]?.chamber ?? null : null,
  })).filter((m) => m.bioguide);
}

export async function getSponsoredLegislation(bioguide, { limit = 250, maxPages = 4 } = {}) {
  const path = `/member/${encodeURIComponent(bioguide)}/sponsored-legislation`;
  const first = await get(path, { limit }, { ttl: 12 * HOUR, fixture: `congress-sponsored-${bioguide}` });
  const items = [...(first?.sponsoredLegislation ?? [])];
  // The API's default order isn't documented, so read every page (up to 1,000 bills) and sort locally.
  const total = Number(first?.pagination?.count ?? items.length);
  for (let page = 1; page < maxPages && items.length < total && !isFixtureMode(); page += 1) {
    const next = await get(path, { limit, offset: page * limit }, { ttl: 12 * HOUR });
    const more = next?.sponsoredLegislation ?? [];
    if (!more.length) break;
    items.push(...more);
  }
  return items
    .filter((b) => b && b.type && b.number) // amendments in this list have no bill type/number
    .map((b) => ({
      congress: Number(b.congress),
      type: String(b.type).toLowerCase(),
      number: String(b.number),
      title: b.title ?? b.latestTitle ?? null,
      introducedDate: b.introducedDate ?? null,
      policyArea: b.policyArea?.name ?? null,
      latestAction: b.latestAction ? { date: b.latestAction.actionDate ?? null, text: b.latestAction.text ?? null } : null,
    }));
}

export async function getBill(congress, type, number) {
  const json = await get(`/bill/${congress}/${String(type).toLowerCase()}/${number}`, {}, { ttl: 12 * HOUR, fixture: `congress-bill-${congress}-${String(type).toLowerCase()}-${number}` });
  return json?.bill ?? null;
}

export async function getBillSummaries(congress, type, number) {
  const json = await get(`/bill/${congress}/${String(type).toLowerCase()}/${number}/summaries`, {}, { ttl: DAY, fixture: `congress-summaries-${congress}-${String(type).toLowerCase()}-${number}` });
  return json?.summaries ?? [];
}

/** Pick the most recent CRS summary (prefers the enacted "Public Law" version when present). */
export function latestSummary(summaries) {
  const list = [...(summaries ?? [])].filter((s) => s?.text);
  if (!list.length) return null;
  list.sort((a, b) => String(b.updateDate ?? b.actionDate ?? '').localeCompare(String(a.updateDate ?? a.actionDate ?? '')));
  const enacted = list.find((s) => String(s.versionCode) === '49' || /public law/i.test(s.actionDesc ?? ''));
  return enacted ?? list[0];
}

export function normalizeCbo(bill) {
  const list = Array.isArray(bill?.cboCostEstimates) ? bill.cboCostEstimates : (bill?.cboCostEstimates?.item ?? []);
  return list.filter((c) => c?.url).map((c) => ({
    title: c.title ?? 'CBO cost estimate',
    url: c.url,
    date: isoDate(c.pubDate),
    description: c.description ?? null,
  }));
}

export function normalizeLaws(bill) {
  const list = Array.isArray(bill?.laws) ? bill.laws : (bill?.laws?.item ?? []);
  return list.filter((l) => l?.number).map((l) => ({ type: l.type ?? 'Public Law', number: String(l.number) }));
}

/** Detail for a sponsored bill: status, law, CRS summary excerpt (verbatim), CBO estimates. */
export async function sponsoredBillDetail(item) {
  const [bill, summaries] = await Promise.all([
    getBill(item.congress, item.type, item.number).catch(() => null),
    getBillSummaries(item.congress, item.type, item.number).catch(() => []),
  ]);
  const summary = latestSummary(summaries);
  const text = summary ? excerpt(stripHtml(summary.text), 700) : null;
  return {
    number: billDisplay(item.type, item.number),
    congress: item.congress,
    title: bill?.title ?? item.title,
    url: congressBillUrl(item.congress, item.type, item.number),
    introducedDate: bill?.introducedDate ?? item.introducedDate,
    policyArea: bill?.policyArea?.name ?? item.policyArea,
    latestAction: bill?.latestAction ? { date: bill.latestAction.actionDate ?? null, text: bill.latestAction.text ?? null } : item.latestAction,
    laws: normalizeLaws(bill),
    cbo: normalizeCbo(bill),
    crsSummary: summary && text ? {
      text: text.text,
      truncated: text.truncated,
      version: summary.actionDesc ?? null,
      date: isoDate(summary.actionDate ?? summary.updateDate),
      url: `${congressBillUrl(item.congress, item.type, item.number)}`,
    } : null,
  };
}
