// Renders the live parts of the Methodology page from /api/meta, so the issue mapping
// tables shown here always match /lib/issues.js.

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'href') { if (/^(https?:|mailto:|\/|#)/i.test(String(v))) el.setAttribute('href', v); }
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

const fmt = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' });
const when = (iso) => (iso ? fmt.format(new Date(iso)) : 'Not built yet');

function list(items) {
  return items.length ? items.join('; ') : '—';
}

async function main() {
  let meta;
  try {
    const res = await fetch('/api/meta', { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(String(res.status));
    meta = await res.json();
  } catch {
    for (const id of ['freshness', 'judicial', 'issue-table', 'israel-list']) {
      document.getElementById(id).replaceChildren(h('p', { class: 'status error' }, 'Couldn’t load this table. Please refresh the page.'));
    }
    return;
  }

  // Issue mapping table (from /lib/issues.js).
  const t = meta.issueTable;
  document.getElementById('issue-table').replaceChildren(h('div', { class: 'table-wrap' }, h('table', { class: 'mapping' },
    h('caption', {}, `${t.issues.length} issues; pick up to ${t.maxIssues}`),
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Issue'), h('th', { scope: 'col' }, 'Federal: CRS policy areas'), h('th', { scope: 'col' }, 'New York: consolidated laws'), h('th', { scope: 'col' }, 'Open States subjects (contains)'))),
    h('tbody', {}, t.issues.map((i) => h('tr', {},
      h('td', {}, i.label),
      h('td', {}, i.curated ? h('a', { href: '#israel' }, 'Published vote list') : list(i.policyAreas)),
      h('td', {}, i.curated ? '—' : list(i.nyLaws), i.note ? h('div', { class: 'muted small' }, i.note) : null),
      h('td', {}, list(i.subjects))
    )))
  )));
  document.getElementById('hidden-areas').textContent = `Not offered as issues (procedural or legacy categories): ${t.hiddenPolicyAreas.join('; ')}. The ${t.verifiedPolicyAreas.length} current policy areas were checked against Congress.gov’s published list.`;

  // The published Israel and Palestine vote list.
  renderCuratedList(document.getElementById('israel-list'), meta.curatedIssues?.['israel-palestine'], meta.voteKinds ?? {});

  // Vote kinds.
  document.getElementById('vote-kinds').replaceChildren(h('p', { class: 'muted small' }, `Vote types shown: ${Object.values(meta.voteKinds).join(', ')}.`));
  document.getElementById('ny-session').textContent = meta.nySession.replace('-', '–');

  // Judicial districts.
  document.getElementById('judicial').replaceChildren(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Judicial district'), h('th', { scope: 'col' }, 'Counties'))),
    h('tbody', {}, meta.nyJudicialDistricts.map((d) => h('tr', {}, h('td', {}, d.district), h('td', {}, d.counties.join(', ')))))
  )), h('p', { class: 'muted small' }, 'Source: ', h('a', { href: 'https://ww2.nycourts.gov/courts/' }, 'NY Unified Court System'), '. Maintained by hand; please report any change.'));

  // Freshness.
  const f = meta.freshness;
  const rows = Object.values(f).map((s) => h('tr', {},
    h('td', {}, s.url ? h('a', { href: s.url }, s.label) : s.label),
    h('td', {}, s.status === 'ok' ? 'Built' : s.status === 'not-built' ? 'Not built yet' : s.status),
    h('td', {}, when(s.lastUpdated)),
    h('td', {}, s.detail ?? '')
  ));
  for (const seed of meta.seeds ?? []) {
    rows.push(h('tr', {},
      h('td', {}, `Researched ballot file (${seed.state})`),
      h('td', {}, seed.placeholder ? 'Placeholder' : seed.valid ? 'Valid' : 'Failed validation'),
      h('td', {}, when(seed.generatedAt)),
      h('td', {}, `${seed.stats?.contests ?? 0} contests, ${seed.stats?.candidates ?? 0} candidates`)
    ));
  }
  document.getElementById('freshness').replaceChildren(h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Precomputed data'), h('th', { scope: 'col' }, 'Status'), h('th', { scope: 'col' }, 'Last updated'), h('th', { scope: 'col' }, 'Detail'))),
    h('tbody', {}, rows)
  )), h('p', { class: 'muted small' }, 'Live sources (Census, Google Civic, Congress.gov sponsored bills, FEC) are fetched when you look something up, and each section shows its own retrieval date.'));

  // Coverage notes from the researched file.
  const cov = meta.seeds?.[0]?.coverage;
  if (cov) {
    const items = [];
    if (cov.partial?.length) items.push(h('li', {}, `Partially covered: ${cov.partial.join('; ')}`));
    if (cov.missing?.length) items.push(h('li', {}, `Missing: ${cov.missing.join('; ')}`));
    if (cov.notes) items.push(h('li', {}, cov.notes));
    if (items.length) document.getElementById('coverage').replaceChildren(h('h3', {}, 'Coverage notes from the researched ballot file'), h('ul', {}, items));
  }

  // Report link.
  if (meta.reportErrorUrl) {
    document.getElementById('report-link').replaceChildren('If something is wrong or missing, ', h('a', { href: meta.reportErrorUrl }, 'report it here'), '. Include what you saw and the link to the record involved.');
  }
}

const day = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtDay = (iso) => (iso ? day.format(new Date(`${String(iso).slice(0, 10)}T12:00:00Z`)) : '');
const link = (url, text) => (url ? h('a', { href: url, rel: 'noopener noreferrer', target: '_blank' }, text) : text);

function renderCuratedList(box, c, kinds = {}) {
  if (!box) return;
  if (!c) { box.replaceChildren(h('p', { class: 'muted' }, 'The vote list isn’t available.')); return; }
  const out = [
    h('h3', {}, 'The rule'),
    h('p', {}, c.rule),
    c.scopeNote ? h('p', { class: 'muted small' }, c.scopeNote) : null,
    h('h3', {}, `Votes counted (${c.rollcalls.length})`),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col' }, 'Measure'), h('th', { scope: 'col' }, 'Question'), h('th', { scope: 'col' }, 'Result'))),
      h('tbody', {}, c.rollcalls.map((r) => h('tr', {},
        h('td', { class: 'nowrap' }, fmtDay(r.date), h('div', { class: 'muted small' }, link(r.pageUrl ?? r.sourceUrl, `Roll call ${r.roll}`))),
        h('td', {}, link(r.bill?.url, r.bill?.number), r.bill?.title ? `: ${r.bill.title}` : '', r.amendment ? h('div', { class: 'small' }, `${r.amendment.number} (${r.amendment.sponsor}): ${r.amendment.description}`, r.amendment.descriptionSource?.url ? [' ', link(r.amendment.descriptionSource.url, '(summary source)')] : null) : null),
        h('td', {}, r.question, h('div', { class: 'muted small' }, kinds[r.kind] ?? r.kind)),
        h('td', {}, r.tally ? `${r.result} (${r.tally})` : r.result)
      )))
    )),
    c.voteNote ? h('p', { class: 'muted small' }, c.voteNote) : null,
  ];
  if (c.related?.length) {
    out.push(h('h3', {}, 'Related votes not counted'), h('p', { class: 'muted small' }, 'These arms-transfer measures apply to every country and their official descriptions don’t name Israel, so the rule doesn’t count them. They’re listed so you can look them up.'));
    const stop = (t) => (/[.!?]["”]?$/.test(String(t ?? '').trim()) ? '' : '.');
    out.push(h('ul', {}, c.related.map((r) => h('li', {}, `${fmtDay(r.date)}, roll call ${r.roll}${r.rollNote ? ` (${r.rollNote})` : ''}: ${r.what}${stop(r.what)}${r.result ? ` ${r.result}${stop(r.result)}` : ''} `, link(r.source, 'Source')))));
  }
  if (c.excluded?.length) {
    out.push(h('details', { class: 'more' }, h('summary', {}, `Every other vote considered and not counted (${c.excluded.length})`),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Date'), h('th', { scope: 'col' }, 'What'), h('th', { scope: 'col' }, 'Why not counted'))),
        h('tbody', {}, c.excluded.map((e) => h('tr', {},
          h('td', { class: 'nowrap' }, fmtDay(e.date), e.roll ? h('div', { class: 'muted small' }, `Roll call ${e.roll}`) : null),
          h('td', {}, e.source ? link(e.source, e.what) : e.what),
          h('td', {}, e.reason)
        )))
      ))));
  }
  if (c.openChecks?.length) out.push(h('h3', {}, 'Still being checked'), h('ul', {}, c.openChecks.map((o) => h('li', {}, `${o.check}: ${o.status}.`))));
  if (c.sources?.length) out.push(h('p', { class: 'muted small' }, 'Sources: ', c.sources.flatMap((s, i) => [i ? ' · ' : '', link(s.url, s.label)]), c.generatedAt ? `. List compiled ${fmtDay(c.generatedAt)}.` : '.'));
  box.replaceChildren(...out.filter(Boolean));
}

main();
