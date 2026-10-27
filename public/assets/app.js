// Ballot Scout front end. Vanilla JS, no dependencies. All API text is inserted as text
// nodes (never innerHTML), and every external link is checked to be http(s).

const MAX_ISSUES = 5;
const TABS = [
  ['positions', 'Positions on your issues'],
  ['votes', 'Votes on your issues'],
  ['sponsored', 'Bills they sponsored'],
  ['effects', 'What their policies did'],
  ['money', 'Money'],
  ['sources', 'Sources'],
];

const state = {
  meta: null,
  ballot: null,
  issues: [],
  more: false,
  records: new Map(), // key: token|issues|more -> Promise<record>
  observer: null,
};

// ---------- tiny DOM helpers ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'href') { const safe = safeHref(v); if (safe) el.setAttribute('href', safe); }
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function safeHref(url) {
  const s = String(url ?? '').trim();
  if (/^https?:\/\//i.test(s) || /^mailto:/i.test(s)) return s;
  if (/^\/[^/]/.test(s) || /^#/.test(s)) return s;
  return null;
}

function extLink(url, text) {
  const href = safeHref(url);
  if (!href) return document.createTextNode(text ?? '');
  return h('a', { href, rel: 'noopener noreferrer', target: '_blank' }, text ?? href, h('span', { class: 'visually-hidden' }, ' (opens in a new tab)'));
}

const $ = (sel) => document.querySelector(sel);

// ---------- formatting ----------
const dateFmt = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDateFmt = new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const pct = new Intl.NumberFormat('en-US', { style: 'percent', maximumFractionDigits: 1 });

function fmtDate(iso, long = false) {
  if (!iso) return null;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return (long ? longDateFmt : dateFmt).format(d);
}
const fmtMoney = (n) => (Number.isFinite(n) ? usd.format(n) : 'Not reported');
const fmtPct = (n) => (Number.isFinite(n) ? pct.format(n) : '—');

function updatedLine(src) {
  if (!src) return null;
  const when = src.lastUpdated ? `updated ${fmtDate(src.lastUpdated)}` : 'update date not available';
  return h('p', {}, 'Source: ', src.url ? extLink(src.url, src.label) : src.label, ` · ${when}`, src.note ? ` · ${src.note}` : '');
}

// ---------- startup ----------
async function init() {
  const form = $('#lookup-form');
  form.addEventListener('submit', onSubmit);
  $('#more-votes').addEventListener('change', (e) => {
    state.more = e.target.checked;
    refreshLoadedRecords();
  });
  try {
    const res = await fetch('/api/meta', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.meta = await res.json();
    renderIssuePicker(state.meta.issueTable);
    if (state.meta.sample) $('#site-banner').hidden = false;
    if (state.meta.electionDate) $('#election-date-label').textContent = `General Election, ${fmtDate(state.meta.electionDate, true).replace(/^\w+, /, '')}`;
  } catch {
    $('#issue-list').replaceChildren(h('p', { class: 'status error' }, 'Couldn’t load the issue list. Please refresh the page.'));
  }
}

function renderIssuePicker(table) {
  const list = $('#issue-list');
  const chips = table.issues.map((issue) => h('label', { class: 'chip' },
    h('input', { type: 'checkbox', name: 'issue', value: issue.id, onchange: onIssueChange }),
    h('span', {}, issue.label)
  ));
  list.replaceChildren(...chips);
  onIssueChange();
}

function selectedIssues() {
  return [...document.querySelectorAll('input[name="issue"]:checked')].map((i) => i.value);
}

function onIssueChange() {
  const chosen = selectedIssues();
  const atMax = chosen.length >= MAX_ISSUES;
  for (const input of document.querySelectorAll('input[name="issue"]')) input.disabled = atMax && !input.checked;
  $('#issue-count').textContent = chosen.length
    ? `${chosen.length} of ${MAX_ISSUES} picked${atMax ? '. Uncheck one to pick another.' : '.'}`
    : `Pick up to ${MAX_ISSUES}.`;
  if (chosen.length) setFieldError('issues', null);
}

function setFieldError(which, message) {
  const el = which === 'address' ? $('#address-error') : $('#issues-error');
  el.textContent = message ?? '';
  el.hidden = !message;
  if (which === 'address') $('#address').setAttribute('aria-invalid', message ? 'true' : 'false');
}

async function onSubmit(event) {
  event.preventDefault();
  const address = $('#address').value.trim();
  const issues = selectedIssues();
  let ok = true;
  if (address.length < 5 || !/\d/.test(address)) { setFieldError('address', 'Enter your full street address, including the house number and ZIP code.'); ok = false; } else setFieldError('address', null);
  if (!issues.length) { setFieldError('issues', 'Pick at least one issue.'); ok = false; }
  if (!ok) { (address.length < 5 ? $('#address') : document.querySelector('input[name="issue"]'))?.focus(); return; }

  const btn = $('#submit-btn');
  const status = $('#form-status');
  btn.disabled = true;
  status.className = 'status';
  status.textContent = 'Looking up your districts and ballot…';
  try {
    const res = await fetch('/api/ballot', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ address, issues }),
      cache: 'no-store',
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Something went wrong. Please try again.');
    state.ballot = body;
    state.issues = body.issues?.length ? body.issues : issues;
    state.records.clear();
    status.textContent = '';
    renderBallot(body);
  } catch (err) {
    status.className = 'status error';
    status.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
}

// ---------- ballot ----------
function issueLabel(id) {
  return state.meta?.issueTable?.issues?.find((i) => i.id === id)?.label ?? id;
}

function renderBallot(b) {
  const results = $('#results');
  results.hidden = false;
  if (b.sample) $('#site-banner').hidden = false;

  const alerts = [];
  if (b.sample) alerts.push(h('div', { class: 'alert', role: 'note' }, h('strong', {}, 'Sample data. '), 'These candidates, votes and dollar amounts are fictional and exist only to test the app. Record links go to example.org placeholders.'));
  for (const n of b.notices ?? []) alerts.push(h('div', { class: 'alert', role: 'note' }, n));
  $('#results-alerts').replaceChildren(...alerts);

  $('#results-eyebrow').textContent = b.matchedAddress ? 'Ballot for the address you entered' : 'Your ballot';
  $('#results-title').textContent = `${b.election?.name ?? 'General Election'}${b.election?.date ? `: ${fmtDate(b.election.date, true)}` : ''}`;
  const d = b.districts ?? {};
  const parts = [
    d.congressional?.name ?? (d.congressional?.district ? `Congressional District ${d.congressional.district}` : null),
    d.stateSenate?.name,
    d.stateAssembly?.name,
    d.county?.name,
    d.countySubdivision?.name && !/borough$/i.test(d.countySubdivision.name) ? municipalityLabel(d.countySubdivision.name) : null,
    d.place?.name && /village$/i.test(d.place.name) ? municipalityLabel(d.place.name) : null,
    d.countyLegislative ? `County Legislative District ${d.countyLegislative}` : null,
    d.judicialDistrict ? `Judicial District ${d.judicialDistrict}` : null,
  ].filter(Boolean);
  $('#results-districts').textContent = parts.join(' · ');

  renderKeyDates(b.election, b.localBoard);
  renderWhereToVote(b.voting, b.election, b.localBoard);
  $('#selected-issues').replaceChildren(...state.issues.map((id) => h('li', { class: 'tag' }, issueLabel(id))));
  $('#more-votes').checked = state.more;

  const index = $('#contest-index');
  index.replaceChildren(...b.contests.map((c) => h('li', {}, h('a', { href: `#contest-${cssId(c.id)}` }, shortOffice(c)))));
  if (b.outsideSpending) index.append(h('li', {}, h('a', { href: '#outside-spending' }, 'Outside spending in your federal race')));
  if (b.possibleContests?.length) index.append(h('li', {}, h('a', { href: '#possible-contests' }, 'Contests that may be on your ballot')));
  if (b.ballotProposals?.length) index.append(h('li', {}, h('a', { href: '#proposals' }, 'Ballot proposals')));

  if (state.observer) state.observer.disconnect();
  state.observer = 'IntersectionObserver' in window ? new IntersectionObserver(onCandidateVisible, { rootMargin: '300px 0px' }) : null;

  $('#contests').replaceChildren(...b.contests.map((c) => renderContest(c)));
  renderOutsideSpending(b.outsideSpending);
  const possible = $('#possible-contests');
  possible.hidden = !(b.possibleContests?.length);
  $('#possible-list').replaceChildren(...renderPossibleGroups(b.possibleContests ?? []));

  const props = $('#proposals');
  props.hidden = !(b.ballotProposals?.length);
  $('#proposal-list').replaceChildren(...(b.ballotProposals ?? []).map(renderProposal));

  $('#ballot-sources').replaceChildren(...(b.sources ?? []).map((s) => h('li', {},
    s.url ? extLink(s.url, s.label) : h('strong', {}, s.label),
    h('span', { class: 'meta' }, [s.detail, s.lastUpdated ? `Updated ${fmtDate(s.lastUpdated)}` : null].filter(Boolean).join(' · '))
  )));

  if (!state.observer) document.querySelectorAll('.candidate').forEach((el) => loadCandidate(el));
  const title = $('#results-title');
  title.focus({ preventScroll: true });
  title.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

/** "Greenburgh town" -> "Town of Greenburgh" (same rule as lib/districts.js). */
function municipalityLabel(censusName) {
  const m = /^(.*)\s+(town|village|city)$/i.exec(String(censusName ?? '').trim());
  return m ? `${m[2][0].toUpperCase()}${m[2].slice(1).toLowerCase()} of ${m[1]}` : String(censusName ?? '');
}

function cssId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '-');
}

function shortOffice(c) {
  return c.districtType === 'statewide' || !c.district ? c.office : `${c.office} (${c.districtLabel})`;
}

function renderKeyDates(e, board) {
  const dl = $('#key-dates');
  const rows = [];
  const add = (label, value) => { if (value) rows.push(h('dt', {}, label), h('dd', {}, value)); };
  add('Election Day', fmtDate(e?.date, true));
  add('Registration deadline', fmtDate(e?.registrationDeadline, true));
  if (e?.earlyVoting?.start || e?.earlyVoting?.end) add('Early voting', [fmtDate(e.earlyVoting.start), fmtDate(e.earlyVoting.end)].filter(Boolean).join(' to '));
  add('Absentee application deadline', fmtDate(e?.absenteeApplicationDeadline, true));
  add('Polls open', e?.pollHours);
  if (!rows.length) rows.push(h('dd', {}, 'Dates for this election aren’t loaded yet. Check your state or county election office.'));
  dl.replaceChildren(...rows);
  const links = [...(board?.links ?? []), ...(e?.officialLinks ?? [])].map((l) => h('li', {}, extLink(l.url, l.label)));
  dl.parentElement.querySelectorAll('.official-links').forEach((n) => n.remove());
  if (links.length) {
    const block = links.length > 4
      ? h('div', { class: 'official-links' }, h('ul', { class: 'link-list' }, links.slice(0, 4)), h('details', { class: 'more' }, h('summary', {}, `More official links (${links.length - 4})`), h('ul', { class: 'link-list' }, links.slice(4))))
      : h('div', { class: 'official-links' }, h('ul', { class: 'link-list' }, links));
    dl.insertAdjacentElement('afterend', block);
  }
  const src = e?.sources?.[0];
  $('#dates-source').replaceChildren(...(src ? ['Source: ', extLink(src.url, src.label), src.accessed ? ` · accessed ${fmtDate(src.accessed)}` : ''] : ['Source: official election calendar']));
}

function renderPlace(p, kind) {
  return h('div', { class: 'place' },
    h('strong', {}, p.name || kind),
    h('span', {}, p.address),
    p.hours ? h('div', { class: 'muted small' }, p.hours) : null,
    p.startDate || p.endDate ? h('div', { class: 'muted small' }, `Open ${[fmtDate(p.startDate), fmtDate(p.endDate)].filter(Boolean).join(' to ')}`) : null,
    p.notes ? h('div', { class: 'muted small' }, p.notes) : null
  );
}

function renderBoard(board) {
  if (!board) return [];
  const out = [h('h4', {}, board.name)];
  if (board.address || board.phone) out.push(h('p', { class: 'muted small' }, [board.address, board.phone].filter(Boolean).join(' · ')));
  if (board.earlyVoting) out.push(h('p', { class: 'small' }, h('strong', {}, 'Early voting: '), board.earlyVoting));
  if (board.earlyVotingSites?.length) {
    out.push(h('details', { class: 'more' }, h('summary', {}, `Early voting sites (${board.earlyVotingSites.length})`),
      h('ul', { class: 'link-list' }, board.earlyVotingSites.map((s) => h('li', {}, h('strong', {}, s.name), ` · ${s.address}`)))));
  }
  return out;
}

function renderWhereToVote(v, e, board) {
  const box = $('#where-to-vote');
  const out = [];
  if (v?.mailOnly) out.push(h('p', {}, 'This election is conducted by mail at your address.'));
  if (v?.pollingLocations?.length) out.push(h('h4', {}, 'Your Election Day polling place'), ...v.pollingLocations.slice(0, 2).map((p) => renderPlace(p, 'Polling place')));
  if (v?.earlyVoteSites?.length) {
    out.push(h('h4', {}, 'Early voting sites'), ...v.earlyVoteSites.slice(0, 3).map((p) => renderPlace(p, 'Early voting site')));
    if (v.earlyVoteSites.length > 3) out.push(h('details', { class: 'more' }, h('summary', {}, `${v.earlyVoteSites.length - 3} more early voting sites`), ...v.earlyVoteSites.slice(3).map((p) => renderPlace(p, 'Early voting site'))));
  }
  if (v?.dropOffLocations?.length) out.push(h('h4', {}, 'Ballot drop-off'), ...v.dropOffLocations.slice(0, 2).map((p) => renderPlace(p, 'Drop-off location')));
  if (!out.length) out.push(h('p', { class: 'muted' }, 'Polling places weren’t available from Google’s Civic Information API for this address. Use your election office’s poll site finder:'));
  if (!v?.pollingLocations?.length && !v?.earlyVoteSites?.length) out.push(...renderBoard(board));
  // Without Google's polling data, point to the official poll-site and early-voting links only.
  const official = [...(board?.links ?? []), ...(e?.officialLinks ?? [])];
  const pollLinks = official.filter((l) => /poll|early vot|where to vote|find/i.test(l.label ?? ''));
  const links = [...(v?.administrationLinks ?? []), ...((!v?.pollingLocations?.length) ? (pollLinks.length ? pollLinks : official) : [])];
  const seen = new Set();
  const uniq = links.filter((l) => (seen.has(l.url) ? false : seen.add(l.url)));
  if (uniq.length) out.push(h('ul', { class: 'link-list' }, uniq.map((l) => h('li', {}, extLink(l.url, l.label)))));
  box.replaceChildren(...out);
  $('#where-source').replaceChildren(...(v?.source ? ['Source: ', extLink(v.source.url, v.source.label), v.source.lastUpdated ? ` · retrieved ${fmtDate(v.source.lastUpdated)}` : ''] : ['Source: official election office links']));
}

function renderProposal(p) {
  return h('article', { class: 'card proposal', id: `proposal-${cssId(p.id)}` },
    h('h4', {}, p.title),
    p.summaryOfficial ? h('div', {}, h('p', { class: 'evidence-type' }, 'Official abstract'), h('blockquote', { class: 'quote' }, p.summaryOfficial)) : null,
    p.officialText ? h('details', { class: 'more' }, h('summary', {}, 'Official text'), h('blockquote', { class: 'quote' }, p.officialText)) : null,
    !p.officialText && !p.summaryOfficial ? h('p', { class: 'muted' }, 'The official ballot question and abstract are in the official documents linked below.') : null,
    h('div', { class: 'panel-source' }, ...(p.sources ?? []).map((s) => h('p', {}, 'Source: ', extLink(s.url, s.label), s.accessed ? ` · accessed ${fmtDate(s.accessed)}` : '')))
  );
}

function renderContest(c) {
  const seats = c.seats > 1 ? `Vote for up to ${c.seats}` : 'Vote for 1';
  const orderNote = c.orderBasis === 'ballot' ? 'Candidates are listed in ballot order.' : 'Candidates are listed alphabetically by last name.';
  return h('article', { class: 'card contest', id: `contest-${cssId(c.id)}`, 'aria-labelledby': `contest-title-${cssId(c.id)}` },
    h('header', { class: 'contest-head' },
      h('div', {}, h('h3', { id: `contest-title-${cssId(c.id)}` }, c.office), h('p', { class: 'contest-meta' }, [c.districtLabel, seats, c.term?.expires ? `Term ends ${c.term.expires}` : null].filter(Boolean).join(' · '))),
      h('p', { class: 'contest-meta' }, orderNote)
    ),
    c.note ? h('p', { class: 'contest-note' }, c.note) : null,
    c.candidates.length
      ? h('div', { class: 'candidates' }, c.candidates.map((cand) => renderCandidate(cand, c)))
      : h('p', { class: 'empty' }, 'No candidates are listed for this contest in our sources.'),
    c.sources?.length ? h('div', { class: 'panel-source' }, h('p', {}, 'Ballot listing source: ', ...joinLinks(c.sources))) : null
  );
}

function joinLinks(sources) {
  const out = [];
  sources.forEach((s, i) => {
    if (i) out.push(' · ');
    out.push(s.url ? extLink(s.url, s.label) : s.label);
    if (s.accessed) out.push(` (accessed ${fmtDate(s.accessed)})`);
  });
  return out;
}

let uid = 0;
function renderCandidate(cand, contest) {
  const id = `cand-${++uid}`;
  const tablist = h('div', { class: 'tabs', role: 'tablist', 'aria-label': `Records for ${cand.name}` });
  const panels = [];
  TABS.forEach(([key, label], i) => {
    const tab = h('button', { type: 'button', class: 'tab', role: 'tab', id: `${id}-tab-${key}`, 'aria-controls': `${id}-panel-${key}`, 'aria-selected': i === 0 ? 'true' : 'false', tabindex: i === 0 ? '0' : '-1', 'data-key': key }, label);
    tablist.append(tab);
    panels.push(h('div', { class: 'tabpanel', role: 'tabpanel', id: `${id}-panel-${key}`, 'aria-labelledby': `${id}-tab-${key}`, tabindex: '0', hidden: i !== 0, 'data-key': key }));
  });
  tablist.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) selectTab(tablist, tab);
  });
  tablist.addEventListener('keydown', onTabKey);

  const people = [{ id: cand.id, name: cand.name, profile: cand.profile, role: 'candidate' }];
  if (cand.runningMate) people.push({ id: cand.runningMate.id, name: cand.runningMate.name, profile: cand.runningMate.profile, role: 'running-mate' });

  const labelBox = h('div', { class: 'labels' });
  // "At a glance" sits right above the tabs; it exists while the records load.
  const glance = h('div', { class: 'glance' });
  const el = h('section', { class: 'candidate', 'aria-labelledby': `${id}-name`, 'data-token': cand.id, 'data-person': '0' },
    h('div', { class: 'candidate-head' },
      h('h4', { id: `${id}-name` }, cand.name),
      cand.runningMate ? h('p', { class: 'candidate-sub' }, `Running mate: ${cand.runningMate.name} (${cand.runningMate.office})`) : null,
      ...(cand.alsoListedAs ?? []).map((a) => h('p', { class: 'candidate-sub also-listed' }, `Listed by the ${a.by} as `, a.source?.url ? extLink(a.source.url, a.name) : a.name)),
      cand.partyLines.length
        ? h('ul', { class: 'party-lines', 'aria-label': 'Party lines on the ballot' }, cand.partyLines.map((p) => h('li', {}, p)))
        : h('p', { class: 'candidate-sub' }, 'Party line not listed in our sources'),
      h('div', { class: 'badges' },
        cand.incumbent ? h('span', { class: 'badge' }, 'Incumbent') : null,
        cand.currentOffice ? h('span', { class: 'candidate-sub' }, `Current office: ${cand.currentOffice}`) : null
      ),
      cand.website ? h('p', { class: 'candidate-sub' }, extLink(cand.website, 'Official website')) : null
    ),
    people.length > 1 ? h('div', { class: 'person-switch', role: 'group', 'aria-label': 'Show records for' },
      h('span', { class: 'switch-label', 'aria-hidden': 'true' }, 'Show records for:'),
      people.map((p, i) => h('button', { type: 'button', 'aria-pressed': i === 0 ? 'true' : 'false', 'data-index': String(i), onclick: (e) => switchPerson(el, people, i, e.currentTarget) }, p.role === 'running-mate' ? `${p.name} (running mate)` : p.name))
    ) : null,
    labelBox,
    glance,
    tablist,
    ...panels
  );
  el._people = people;
  renderLabels(el, people[0]);
  showLoading(el);
  if (state.observer) state.observer.observe(el);
  return el;
}

function showLoading(el) {
  const loading = () => document.getElementById('tpl-loading').content.cloneNode(true);
  el.querySelector('.glance')?.replaceChildren(h('h5', { class: 'glance-title' }, 'At a glance'), loading());
  el.querySelectorAll('.tabpanel').forEach((p) => p.replaceChildren(loading()));
}

function renderLabels(el, person) {
  const box = el.querySelector('.labels');
  box.replaceChildren(...(person.profile?.labels ?? []).map((l) => h('p', { class: 'record-label' }, l)));
}

function switchPerson(el, people, index, button) {
  el.querySelectorAll('.person-switch button').forEach((b) => b.setAttribute('aria-pressed', b === button ? 'true' : 'false'));
  el.dataset.token = people[index].id;
  el.dataset.person = String(index);
  renderLabels(el, people[index]);
  loadCandidate(el, true);
}

function selectTab(tablist, tab) {
  for (const t of tablist.querySelectorAll('[role="tab"]')) {
    const on = t === tab;
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
  }
}

function onTabKey(e) {
  const tabs = [...e.currentTarget.querySelectorAll('[role="tab"]')];
  const i = tabs.indexOf(document.activeElement);
  if (i < 0) return;
  let next = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = tabs[(i + 1) % tabs.length];
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = tabs[(i - 1 + tabs.length) % tabs.length];
  else if (e.key === 'Home') next = tabs[0];
  else if (e.key === 'End') next = tabs[tabs.length - 1];
  if (next) { e.preventDefault(); next.focus(); selectTab(e.currentTarget, next); }
}

function onCandidateVisible(entries) {
  for (const entry of entries) {
    if (entry.isIntersecting) {
      state.observer.unobserve(entry.target);
      loadCandidate(entry.target);
    }
  }
}

function refreshLoadedRecords() {
  document.querySelectorAll('.candidate[data-loaded="1"]').forEach((el) => loadCandidate(el, true));
}

async function loadCandidate(el, force = false) {
  if (el.dataset.loading === '1') return;
  if (el.dataset.loaded === '1' && !force) return;
  const token = el.dataset.token;
  const key = `${token}|${state.issues.join(',')}|${state.more ? 1 : 0}`;
  el.dataset.loading = '1';
  showLoading(el);
  try {
    if (!state.records.has(key)) {
      const url = `/api/candidate?id=${encodeURIComponent(token)}&issues=${encodeURIComponent(state.issues.join(','))}&more=${state.more ? 1 : 0}`;
      state.records.set(key, fetch(url, { headers: { accept: 'application/json' } }).then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body.error || 'Couldn’t load records.');
        return body;
      }));
    }
    const rec = await state.records.get(key);
    if (el.dataset.token !== token) return; // switched person meanwhile
    renderRecord(el, rec);
    el.dataset.loaded = '1';
  } catch (err) {
    state.records.delete(key);
    el.querySelector('.glance')?.replaceChildren();
    el.querySelectorAll('.tabpanel').forEach((p) => p.replaceChildren(
      h('p', { class: 'empty' }, err.message || 'Couldn’t load records.'),
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => loadCandidate(el, true) }, 'Try again')
    ));
  } finally {
    el.dataset.loading = '0';
  }
}

function panel(el, key) {
  return el.querySelector(`.tabpanel[data-key="${key}"]`);
}

function fill(target, nodes) {
  target.replaceChildren(...nodes.flat(Infinity).filter((n) => n !== null && n !== undefined && n !== false));
}

function renderRecord(el, rec) {
  const s = rec.sections;
  renderGlance(el, rec);
  fill(panel(el, 'positions'), renderPositions(s.stances));
  fill(panel(el, 'votes'), renderVotes(s.votes, rec));
  fill(panel(el, 'sponsored'), renderSponsored(s.sponsored));
  fill(panel(el, 'effects'), renderEffects(s.effects));
  fill(panel(el, 'money'), renderMoney(s.money));
  fill(panel(el, 'sources'), renderSources(s.sources, rec));
}

function sourceFooter(sources) {
  const list = (sources ?? []).filter(Boolean);
  if (!list.length) return null;
  return h('div', { class: 'panel-source' }, list.map(updatedLine));
}

function issueTags(ids) {
  return (ids ?? []).map(issueLabel).join(', ');
}

// ---------- at a glance and stated positions ----------
const GLANCE_LEADS = { money: 'Money:', positions: 'Positions:', record: 'Record:' };
const GLANCE_NOTE = 'Summary written by Ballot Scout from official records and the candidate’s own statements, by the same rules for every candidate. Details and sources are in the tabs below.';
const SOURCE_TYPES = { 'campaign-site': 'campaign website', questionnaire: 'questionnaire', 'official-site': 'official website', social: 'social media', interview: 'interview', debate: 'debate', news: 'news report' };
const capFirst = (s) => (s ? `${s[0].toUpperCase()}${s.slice(1)}` : s);

function renderGlance(el, rec) {
  const box = el.querySelector('.glance');
  if (!box) return;
  const lines = rec.sections.summary?.lines ?? [];
  if (!lines.length) { box.replaceChildren(); return; }
  box.replaceChildren(
    h('h5', { class: 'glance-title' }, 'At a glance'),
    h('ul', { class: 'glance-list' }, lines.map((l) => h('li', {},
      h('strong', {}, GLANCE_LEADS[l.kind] ?? ''), ' ',
      l.items?.length
        ? h('ul', { class: 'glance-positions' }, l.items.map((it) => h('li', it.none ? { class: 'none' } : {}, h('span', { class: 'glance-issue' }, it.issueLabel), ` — ${it.text}`)))
        : l.text,
      l.note ? h('span', { class: 'glance-sub' }, l.note) : null
    ))),
    h('p', { class: 'glance-note' }, GLANCE_NOTE)
  );
}

function positionSource(src) {
  if (!src) return null;
  const detail = [SOURCE_TYPES[src.type], fmtDate(src.date)].filter(Boolean).join(', ');
  return h('p', { class: 'position-source' }, 'Source: ', extLink(src.url, src.label), detail ? ` (${detail})` : '');
}

function renderPositions(st) {
  if (!st) return [h('p', { class: 'empty' }, 'Positions aren’t available right now.')];
  const out = [h('p', { class: 'panel-note small' }, st.explainer)];
  if (st.unreadable) out.push(h('p', { class: 'panel-note unreadable' }, st.unreadable.note, ' ', extLink(st.unreadable.url, 'Open the campaign website')));
  if (st.note) out.push(h('p', { class: st.items.length ? 'panel-note' : 'empty' }, st.note));
  if (st.items.length) {
    out.push(h('ul', { class: 'rows' }, st.items.map((it) => h('li', { class: 'row' },
      h('p', { class: 'evidence-type' }, it.issueLabel),
      h('p', { class: 'position-summary' }, it.summary),
      it.quote ? h('blockquote', { class: 'quote' }, it.quote, h('cite', {}, 'Quoted verbatim from the source below')) : null,
      positionSource(it.source)
    ))));
  }
  const missing = (st.missing ?? []).filter((m) => m.searchUrl);
  if (missing.length && (st.status === 'ok' || st.status === 'none-on-issues')) {
    if (st.items.length) out.push(h('p', { class: 'panel-note' }, `No statement found in the sources checked on: ${missing.map((m) => m.issueLabel).join(', ')}. That doesn’t mean the candidate hasn’t spoken about it.`));
    const links = missing.flatMap((m, i) => [i ? ' · ' : '', extLink(m.searchUrl, m.issueLabel)]);
    out.push(h('p', { class: 'panel-note small news-search' }, 'Search news coverage of this candidate (Google News): ', ...links));
  }
  if (st.otherIssues?.length) out.push(h('p', { class: 'panel-note' }, `Also has stated positions on: ${st.otherIssues.join(', ')}.`));
  if (st.sourcesChecked?.length) {
    out.push(h('details', { class: 'more' },
      h('summary', {}, `Sources checked (${st.sourcesChecked.length})`),
      h('ul', { class: 'source-list' }, st.sourcesChecked.map((s) => h('li', {},
        s.url ? extLink(s.url, s.label) : s.label,
        h('span', { class: 'meta' }, [capFirst(SOURCE_TYPES[s.type]), s.found === true ? 'Statements found' : s.found === false ? 'No statements found' : null].filter(Boolean).join(' · '))
      )))
    ));
  }
  out.push(sourceFooter(st.sources));
  return out;
}

function renderVotes(v, rec) {
  const out = [];
  if (v.note) out.push(h('p', { class: v.items.length ? 'panel-note' : 'empty' }, v.note));
  if (v.items.length) {
    const cast = v.items.filter((x) => !x.notInOffice).length;
    const listed = v.items.some((x) => x.curated);
    const kinds = v.includesMore ? 'Includes amendment and committee votes.' : listed ? 'Final-passage-type votes only, except published issue lists, which show every listed vote.' : 'Final-passage-type votes only.';
    out.push(h('p', { class: 'panel-note' }, `${cast} recorded vote${cast === 1 ? '' : 's'} on bills matching your issues, newest first. ${kinds}`));
    out.push(h('ul', { class: 'rows' }, v.items.map((x) => h('li', { class: x.notInOffice ? 'row row-muted' : 'row' },
      h('p', { class: 'row-meta' }, [fmtDate(x.date), x.chamber, x.kindLabel, x.issues?.length ? issueTags(x.issues) : null].filter(Boolean).join(' · ')),
      x.bill ? h('p', { class: 'row-title' }, x.bill.url ? extLink(x.bill.url, x.bill.number) : x.bill.number, x.bill.title ? ` — ${x.bill.title}` : '') : null,
      h('p', { class: 'row-line' }, h('span', { class: 'k' }, 'Question: '), x.question || '—'),
      x.kind === 'amendment' && x.description ? h('p', { class: 'row-line' }, h('span', { class: 'k' }, 'Amendment: '), x.description) : null,
      h('p', { class: 'row-line' }, h('span', { class: 'k' }, 'Their vote: '), h('span', { class: 'cast' }, x.vote), x.result ? h('span', {}, h('span', { class: 'k' }, ' · Result: '), x.result) : null),
      x.billStatus ? h('p', { class: 'row-line' }, h('span', { class: 'k' }, 'Bill status now: '), x.billStatus) : null,
      x.links?.length ? h('div', { class: 'row-links' }, x.links.map((l) => extLink(l.url, l.label))) : null
    ))));
  }
  if (v.executive) {
    out.push(h('h5', {}, v.executive.title));
    if (v.executive.items.length) {
      out.push(h('ul', { class: 'rows' }, v.executive.items.map((a) => h('li', { class: 'row' },
        h('p', { class: 'row-meta' }, [fmtDate(a.date), a.action, a.chapter ? `Chapter ${a.chapter}` : null, a.vetoNumber ? `Veto ${a.vetoNumber}` : null, issueTags(a.issues)].filter(Boolean).join(' · ')),
        h('p', { class: 'row-title' }, extLink(a.bill.url, a.bill.number), a.bill.title ? ` — ${a.bill.title}` : ''),
        a.bill.lawSection ? h('p', { class: 'row-line' }, h('span', { class: 'k' }, 'Law amended: '), a.bill.lawSection) : null,
        a.signerSource === 'session' ? h('p', { class: 'row-line muted small' }, 'Signed without a separate message; signer is the Governor named in this session’s messages.') : null
      ))));
    } else out.push(h('p', { class: 'empty' }, 'No signatures or vetoes on these issues in the session covered.'));
  }
  out.push(sourceFooter(v.sources));
  return out;
}

function renderSponsored(sp) {
  const out = [];
  if (sp.note) out.push(h('p', { class: sp.items.length ? 'panel-note' : 'empty' }, sp.note));
  if (sp.items.length) {
    out.push(h('ul', { class: 'rows' }, sp.items.map((b) => h('li', { class: 'row' },
      h('p', { class: 'row-meta' }, [b.jurisdiction, b.introducedDate ? `Introduced ${fmtDate(b.introducedDate)}` : null, issueTags(b.issues)].filter(Boolean).join(' · ')),
      h('p', { class: 'row-title' }, extLink(b.url, b.number), b.title ? ` — ${b.title}` : ''),
      h('p', { class: 'row-line' }, h('span', { class: 'k' }, 'Status: '), b.latestAction?.text ? `${b.latestAction.text}${b.latestAction.date ? ` (${fmtDate(b.latestAction.date)})` : ''}` : (b.status ? `${b.status}${b.statusDate ? ` (${fmtDate(b.statusDate)})` : ''}` : '—')),
      h('p', { class: 'row-line' }, h('span', { class: 'k' }, 'Became law: '), becameLaw(b)),
      b.lawSection ? h('p', { class: 'row-line' }, h('span', { class: 'k' }, 'Law amended: '), b.lawSection) : null,
      b.crsSummary ? h('blockquote', { class: 'quote' }, b.crsSummary.text, h('cite', {}, `CRS summary${b.crsSummary.version ? `, ${b.crsSummary.version}` : ''}${b.crsSummary.date ? `, ${fmtDate(b.crsSummary.date)}` : ''} (quoted verbatim)`)) : null,
      b.summary ? h('blockquote', { class: 'quote' }, b.summary.text, h('cite', {}, `${b.summary.source} (quoted verbatim)`)) : null,
      b.cbo?.length ? h('div', { class: 'row-links' }, b.cbo.map((c) => extLink(c.url, `CBO estimate: ${c.title}`))) : null
    ))));
  }
  out.push(sourceFooter(sp.sources));
  return out;
}

function becameLaw(b) {
  if (b.laws?.length) return b.laws.map((l) => `Yes, ${l.type} ${l.number}`).join('; ');
  if (b.becameLaw) return `Yes${b.chapter ? `, Chapter ${b.chapter}` : ''}`;
  return 'No';
}

function renderEffects(ef) {
  const out = [h('p', { class: 'panel-note' }, ef.explainer)];
  if (!ef.items.length || ef.note) out.push(h('p', { class: 'empty' }, ef.note));
  if (ef.items.length) {
    out.push(h('ul', { class: 'rows' }, ef.items.map((it) => h('li', { class: 'row' },
      h('p', { class: 'row-meta' }, [it.bill.jurisdiction, it.action ? `${it.action}${it.date ? ` ${fmtDate(it.date)}` : ''}` : null, issueTags(it.issues)].filter(Boolean).join(' · ')),
      h('p', { class: 'row-title' }, extLink(it.bill.url, it.bill.number), it.bill.title ? ` — ${it.bill.title}` : ''),
      it.noEvidence
        ? h('p', { class: 'row-line muted' }, 'No official cost estimate, CRS summary or fiscal note exists for this bill in our sources.')
        : h('ul', { class: 'evidence' }, it.evidence.map((e) => h('li', {},
          h('span', { class: 'evidence-type' }, e.type),
          e.title ? h('p', { class: 'row-line' }, e.url ? extLink(e.url, e.title) : e.title, e.date ? ` (${fmtDate(e.date)})` : '') : null,
          e.description ? h('p', { class: 'row-line muted' }, e.description) : null,
          e.quote ? h('blockquote', { class: 'quote' }, e.quote, h('cite', {}, 'Quoted verbatim', e.url && !e.title ? [' · ', extLink(e.url, 'source')] : '')) : null
        ))),
      it.gaoSearchUrl ? h('div', { class: 'row-links' }, extLink(it.gaoSearchUrl, 'Find GAO reviews')) : null
    ))));
  }
  out.push(h('div', { class: 'panel-source' }, ef.sources.map((s) => h('p', {}, 'Source: ', extLink(s.url, s.label)))));
  return out;
}

function renderStateMoney(m) {
  const out = [];
  // Each filer whose reports are summed, with the official search to look it up by filer ID.
  const filers = (m.committees ?? []).map((c) => ({ name: c.name, detail: [`NYS Board of Elections filer ID ${c.id}`, c.type, c.status].filter(Boolean).join(', '), search: c.search }));
  if (m.filerFilings && m.filer) filers.push({ name: m.filer.name, detail: `the candidate’s own registration, filer ID ${m.filer.id}${m.filer.status ? `, ${m.filer.status}` : ''}`, search: m.filer.search });
  out.push(h('p', { class: 'panel-note' }, (m.committees ?? []).length > 1 ? 'Registered committees:' : (m.committees ?? []).length ? 'Registered committee:' : 'Filed by the candidate:'));
  out.push(h('ul', { class: 'link-list' }, filers.map((f) => h('li', {}, `${f.name} (${f.detail}). `, f.search ? extLink(f.search.url, f.search.label) : null))));
  if (m.matchNote) out.push(h('p', { class: 'panel-note small' }, `How these records were matched: ${m.matchNote}`));
  out.push(h('div', { class: 'table-wrap' }, h('table', {},
    h('caption', {}, `Itemized transactions by schedule, ${m.years} filings${m.latestDate ? `, through ${fmtDate(m.latestDate)}` : ''}`),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Schedule (as named in the filings)'), h('th', { scope: 'col', class: 'num' }, 'Amount'), h('th', { scope: 'col', class: 'num' }, 'Items'))),
    h('tbody', {}, m.schedules.length
      ? m.schedules.map((s) => h('tr', {}, h('td', {}, `${s.abbrev}: ${s.desc}`), h('td', { class: 'num' }, fmtMoney(s.total)), h('td', { class: 'num' }, String(s.count))))
      : h('tr', {}, h('td', { colspan: '3' }, 'No itemized transactions reported for these years.')))
  )));
  out.push(h('p', { class: 'panel-note small' }, m.note));
  if (m.links?.length) out.push(h('ul', { class: 'link-list' }, m.links.map((l) => h('li', {}, extLink(l.url, l.label)))));
  out.push(sourceFooter([m.source]));
  return out;
}

function stateOutside(m) {
  if (!m.outsideLinks?.length) return [];
  return [h('h5', {}, 'Outside spending (independent expenditures)'), h('p', { class: 'panel-note' }, m.outsideNote), h('ul', { class: 'link-list' }, m.outsideLinks.map((l) => h('li', {}, extLink(l.url, l.label))))];
}

function renderMoney(m) {
  const out = [];
  if (m.kind === 'state' && m.status === 'ok') return [...renderStateMoney(m), ...stateOutside(m)];
  if (m.kind === 'state' || m.status === 'link-out') {
    out.push(h('p', { class: 'empty' }, m.note));
    if (m.links?.length) out.push(h('ul', { class: 'link-list' }, m.links.map((l) => h('li', {}, extLink(l.url, l.label)))));
    out.push(...stateOutside(m));
    if (m.kind === 'fec') out.push(...renderOutsideByCycle(m.outsideByCycle));
    return out;
  }
  if (m.status !== 'ok') {
    out.push(h('p', { class: 'empty' }, m.note || 'Campaign finance data isn’t available.'));
    if (m.links?.length) out.push(h('ul', { class: 'link-list' }, m.links.map((l) => h('li', {}, extLink(l.url, l.label)))));
    out.push(...renderOutsideByCycle(m.outsideByCycle));
    out.push(sourceFooter(m.sources));
    return out;
  }
  const t = m.totals ?? {};
  out.push(h('p', { class: 'panel-note' }, `${m.cycle - 1}–${m.cycle} election cycle, principal campaign committee${m.committee ? `: ${m.committee.name}` : ''}. ${t.coverageEndDate ? `Reports through ${fmtDate(t.coverageEndDate)}.` : ''}`));
  const kv = h('dl', { class: 'money-kv' });
  const add = (label, value) => kv.append(h('dt', {}, label), h('dd', {}, fmtMoney(value)));
  add('Total raised', t.receipts);
  add('Total spent', t.disbursements);
  add('Cash on hand', t.cashOnHand);
  add('From individuals', t.individualContributions);
  add('From PACs and other committees', t.pacContributions);
  add('From party committees', t.partyContributions);
  add('From the candidate', t.candidateContributions);
  out.push(kv);
  if (m.sizes?.buckets?.length) {
    out.push(h('div', { class: 'table-wrap' }, h('table', {},
      h('caption', {}, `Individual contributions by size${Number.isFinite(m.sizes.smallDollarShare) ? ` · $200 and under: ${fmtPct(m.sizes.smallDollarShare)}` : ''}`),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Size'), h('th', { scope: 'col', class: 'num' }, 'Amount'), h('th', { scope: 'col', class: 'num' }, 'Share'))),
      h('tbody', {}, m.sizes.buckets.map((b) => h('tr', {}, h('td', {}, b.label), h('td', { class: 'num' }, fmtMoney(b.total)), h('td', { class: 'num' }, fmtPct(b.share)))))
    )));
  }
  out.push(h('div', { class: 'table-wrap' }, h('table', {},
    h('caption', {}, 'Top employers of individual donors (as reported to and aggregated by the FEC; itemized gifts over $200)'),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Employer'), h('th', { scope: 'col', class: 'num' }, 'Amount'))),
    h('tbody', {}, m.topEmployers?.length ? m.topEmployers.map((e) => h('tr', {}, h('td', {}, e.employer), h('td', { class: 'num' }, fmtMoney(e.total)))) : h('tr', {}, h('td', { colspan: '2' }, 'No itemized employer data reported yet.')))
  )));
  const o = m.outside ?? {};
  if (m.outsideByCycle && m.outsideByCycle.status !== 'not-built') out.push(...renderOutsideByCycle(m.outsideByCycle));
  else {
  out.push(h('h5', {}, 'Outside spending (independent expenditures)'));
  const okv = h('dl', { class: 'money-kv' });
  okv.append(h('dt', {}, 'Spent supporting this candidate'), h('dd', {}, fmtMoney(o.support)), h('dt', {}, 'Spent opposing this candidate'), h('dd', {}, fmtMoney(o.oppose)));
  out.push(okv);
  }
  if (!(m.outsideByCycle && m.outsideByCycle.status !== 'not-built') && o.spenders?.length) {
    out.push(h('div', { class: 'table-wrap' }, h('table', {},
      h('caption', {}, 'Largest outside spenders'),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Committee'), h('th', { scope: 'col' }, 'Position'), h('th', { scope: 'col', class: 'num' }, 'Amount'))),
      h('tbody', {}, o.spenders.map((s) => h('tr', {}, h('td', {}, s.url ? extLink(s.url, s.name) : s.name), h('td', {}, s.supportOppose), h('td', { class: 'num' }, fmtMoney(s.total)))))
    )));
  }
  if (m.links?.length) out.push(h('ul', { class: 'link-list' }, m.links.map((l) => h('li', {}, extLink(l.url, l.label)))));
  out.push(sourceFooter(m.sources));
  return out;
}

// ---------- outside spending (super PACs and other groups) ----------
const GROUP_LABELS = { 'super-pac': 'Super PACs', party: 'Party committees', pac: 'Other PACs', other: 'Other groups and individuals' };
const cycleLabel = (cy) => `${cy - 1}–${String(cy).slice(2)}`;
const hasAny = (p) => (p?.support ?? 0) > 0 || (p?.oppose ?? 0) > 0;
const pairText = (p) => `${fmtMoney(p?.support ?? 0)} supporting, ${fmtMoney(p?.oppose ?? 0)} opposing`;
const OUTSIDE_INTRO = 'Independent expenditures reported to the FEC: money that super PACs, party committees and other groups spent on their own to support or oppose a candidate. Super PACs can’t give money to candidates; they spend independently and must report it. 24- and 48-hour reports are filed within a day or two of the spending and usually reappear on the group’s next regular report, so they’re shown separately, not added in.';

function otherGroups(byGroup) {
  const out = { support: 0, oppose: 0 };
  for (const [g, v] of Object.entries(byGroup ?? {})) if (g !== 'super-pac') { out.support += v?.support ?? 0; out.oppose += v?.oppose ?? 0; }
  return out;
}

function outsideLines(cycles, which) {
  const lines = [];
  for (const cy of cycles ?? []) {
    const pick = (bg) => (which === 'super-pac' ? bg?.['super-pac'] : otherGroups(bg));
    const p = pick(cy.byGroup);
    const n = cy.notices ? pick(cy.notices.byGroup) : null;
    if (hasAny(p)) lines.push(`${cycleLabel(cy.cycle)}: ${pairText(p)}`);
    if (hasAny(n)) lines.push(`${cycleLabel(cy.cycle)} 24- and 48-hour reports: ${pairText(n)}`);
  }
  return lines;
}

function outsideCandidateLines(cand) {
  if (cand.status === 'not-built' || cand.status === 'preview') return [h('p', { class: 'row-line muted' }, cand.note ?? 'Not loaded yet.')];
  if (cand.status !== 'recorded' && cand.status !== 'none') return [h('p', { class: 'row-line muted' }, 'No single FEC candidate record matched this name, so outside spending isn’t shown. Search FEC.gov to check.')];
  const years = (cand.cycles ?? []).map((c) => c.cycle).sort();
  const span = years.length ? `${years[0] - 1}–${years.at(-1)}` : '';
  const sp = outsideLines(cand.cycles, 'super-pac');
  const ot = outsideLines(cand.cycles, 'other');
  return [
    h('p', { class: 'row-line' }, h('span', { class: 'k' }, 'Super PACs: '), sp.length ? sp.join('; ') : `None on record for or against them, ${span}.`),
    h('p', { class: 'row-line' }, h('span', { class: 'k' }, 'Other outside groups: '), ot.length ? ot.join('; ') : `None on record, ${span}.`),
  ];
}

function renderOutsideSpending(o) {
  const box = $('#outside-spending');
  if (!box) return;
  box.hidden = !o;
  if (!o) return;
  const out = [h('p', { class: 'panel-note' }, OUTSIDE_INTRO)];
  if (o.status === 'not-built') out.push(h('p', { class: 'empty' }, 'The FEC figures haven’t been built yet. They come from the nightly FEC data job.'));
  if (o.note) out.push(h('p', { class: 'empty' }, o.note));
  for (const c of o.contests ?? []) {
    out.push(h('h4', {}, `${c.office} (${c.districtLabel})`));
    out.push(h('ul', { class: 'rows' }, c.candidates.map((cand) => h('li', { class: 'row' },
      h('p', { class: 'row-title' }, cand.name),
      ...outsideCandidateLines(cand),
      cand.links?.length ? h('div', { class: 'row-links' }, cand.links.map((l) => extLink(l.url, l.label))) : null
    ))));
  }
  out.push(h('p', { class: 'source-line' }, 'Source: ', o.source?.url ? extLink(o.source.url, o.source.label) : (o.source?.label ?? 'Federal Election Commission'), o.builtAt ? ` · data as of ${fmtDate(o.builtAt)}` : ''));
  $('#outside-list').replaceChildren(...out);
}

/** Money tab: outside spending from the nightly FEC build, cycle by cycle, every candidate in the same layout. */
function renderOutsideByCycle(ob) {
  if (!ob) return [];
  const out = [h('h5', {}, 'Outside spending (independent expenditures)')];
  if (ob.status === 'not-built' || ob.status === 'preview') {
    out.push(h('p', { class: 'empty' }, ob.note ?? 'Outside spending comes from the nightly FEC data job, which hasn’t run yet.'));
    if (ob.links?.length) out.push(h('ul', { class: 'link-list' }, ob.links.map((l) => h('li', {}, extLink(l.url, l.label)))));
    return out;
  }
  const e = ob.entry;
  if (!e || e.status !== 'ok') {
    out.push(h('p', { class: 'empty' }, 'No single FEC candidate record matched this name, so outside spending isn’t shown.'));
    return out;
  }
  out.push(h('p', { class: 'panel-note' }, OUTSIDE_INTRO));
  for (const cy of Object.values(e.cycles ?? {}).sort((a, b) => b.cycle - a.cycle)) {
    const groups = Object.entries(GROUP_LABELS);
    out.push(h('div', { class: 'table-wrap' }, h('table', {},
      h('caption', {}, `${cycleLabel(cy.cycle)} election cycle, from processed FEC reports`),
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Spender type'), h('th', { scope: 'col', class: 'num' }, 'Supporting'), h('th', { scope: 'col', class: 'num' }, 'Opposing'))),
      h('tbody', {}, groups.map(([g, label]) => h('tr', {}, h('td', {}, label), h('td', { class: 'num' }, fmtMoney(cy.byGroup?.[g]?.support ?? 0)), h('td', { class: 'num' }, fmtMoney(cy.byGroup?.[g]?.oppose ?? 0)))),
        h('tr', {}, h('th', { scope: 'row' }, 'FEC total'), h('td', { class: 'num' }, fmtMoney(cy.totals?.support ?? 0)), h('td', { class: 'num' }, fmtMoney(cy.totals?.oppose ?? 0))))
    )));
    if (cy.notices && (cy.notices.count ?? 0) > 0) out.push(h('p', { class: 'panel-note small' }, `24- and 48-hour reports this cycle: ${pairText(cy.notices)} (${cy.notices.count} item${cy.notices.count === 1 ? '' : 's'}${cy.notices.latestFiled ? `, latest filed ${fmtDate(cy.notices.latestFiled)}` : ''}). Super PACs: ${pairText(cy.notices.byGroup?.['super-pac'])}.`));
    if (cy.spenders?.length) {
      out.push(h('div', { class: 'table-wrap' }, h('table', {},
        h('caption', {}, `Largest outside spenders, ${cycleLabel(cy.cycle)}`),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Committee'), h('th', { scope: 'col' }, 'FEC committee type'), h('th', { scope: 'col' }, 'Position'), h('th', { scope: 'col', class: 'num' }, 'Amount'))),
        h('tbody', {}, cy.spenders.map((s) => h('tr', {}, h('td', {}, s.committeeId ? extLink(`https://www.fec.gov/data/committee/${s.committeeId}/`, s.name) : s.name), h('td', {}, s.typeLabel), h('td', {}, s.position === 'support' ? 'Supporting' : 'Opposing'), h('td', { class: 'num' }, fmtMoney(s.total)))))
      )));
    } else out.push(h('p', { class: 'muted small' }, `No outside spending for or against this candidate in processed FEC reports, ${cycleLabel(cy.cycle)}.`));
  }
  // The Money tab already links the candidate's FEC page; add only the independent-expenditure pages.
  const ieLinks = (e.links ?? []).filter((l) => !/^Candidate page/i.test(l.label ?? ''));
  if (ieLinks.length) out.push(h('ul', { class: 'link-list' }, ieLinks.map((l) => h('li', {}, extLink(l.url, l.label)))));
  return out;
}

// ---------- contests whose district the address can't confirm ----------
function renderPossibleGroups(list) {
  const groups = new Map();
  for (const c of list) {
    const g = c.group ?? { key: c.id, label: c.office, pickLabel: c.districtLabel, sortKey: 0 };
    if (!groups.has(g.key)) groups.set(g.key, { ...g, contests: [] });
    groups.get(g.key).contests.push(c);
  }
  const out = [];
  for (const g of groups.values()) {
    if (g.contests.length === 1) { out.push(renderContest(g.contests[0])); continue; }
    const holder = h('div', { class: 'possible-pick' });
    const contests = [...g.contests].sort((a, b) => (a.group?.sortKey ?? 0) - (b.group?.sortKey ?? 0));
    const sel = h('select', {
      'aria-label': `Your district for ${g.label}`,
      onchange: (e) => {
        const c = contests.find((x) => x.id === e.target.value);
        holder.replaceChildren(...(c ? [renderContest(c)] : []));
        if (c && !state.observer) holder.querySelectorAll('.candidate').forEach((el) => loadCandidate(el));
      },
    }, h('option', { value: '' }, 'Pick your district'), contests.map((c) => h('option', { value: c.id }, c.group?.pickLabel ?? c.districtLabel)));
    out.push(h('div', { class: 'card possible-group' },
      h('h4', {}, g.label),
      h('p', { class: 'muted small' }, `${contests.length} districts are on the ballot in your county. The address lookup doesn’t return this district; it’s printed on your sample ballot.`),
      h('label', { class: 'possible-label' }, h('span', {}, 'Your district'), sel),
      holder
    ));
  }
  return out;
}

function renderSources(src, rec) {
  const out = [];
  out.push(h('h5', {}, 'Records linked to this candidate'));
  if (src.identity?.length) {
    out.push(h('ul', { class: 'source-list' }, src.identity.map((i) => h('li', {}, extLink(i.url, i.label), i.matchedBy ? h('span', { class: 'meta' }, matchText(i.matchedBy)) : null))));
  } else out.push(h('p', { class: 'empty' }, 'No database records are linked to this candidate.'));
  out.push(h('h5', {}, 'Data sources used'));
  out.push(h('ul', { class: 'source-list' }, src.data.map((s) => h('li', {}, s.url ? extLink(s.url, s.label) : s.label, h('span', { class: 'meta' }, [s.note, s.lastUpdated ? `Updated ${fmtDate(s.lastUpdated)}` : null].filter(Boolean).join(' · '))))));
  out.push(h('p', { class: 'muted small' }, `Records retrieved ${fmtDate(rec.generatedAt)}. `, h('a', { href: '/methodology#report' }, 'Report an error')));
  return out;
}

function matchText(how) {
  return {
    seed: 'Linked in the researched ballot file',
    'office+surname': 'Matched by current office, district and surname',
    'name+state': 'Matched by full name and state',
    'name+office': 'Matched by name, office and district in FEC records',
  }[how] ?? `Matched: ${how}`;
}

init();
