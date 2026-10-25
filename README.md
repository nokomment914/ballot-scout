# Ballot Scout

A nonpartisan politician report card. A voter enters the address where they're registered and picks up to five issues. Ballot Scout shows every contest and candidate on their ballot, and for each candidate:

- **Votes on your issues:** date, bill, question, their vote, result, and a link to the official roll call
- **Bills they sponsored:** status, whether it became law, and the official summary, quoted
- **What their policies did:** only official evidence (Congressional Budget Office estimates, Congressional Research Service summaries, New York sponsor-memo fiscal notes, the Governor's messages) plus a "Find GAO reviews" link
- **Money:** FEC totals, small-dollar share, donors' employers as the FEC aggregates them, and outside spending for and against, with super PACs shown apart from party committees and other groups (2023–24 and 2025–26 cycles, rebuilt nightly from the FEC). New York State candidates get their registered committee's itemized transactions from the NYS Board of Elections' open data, plus the official disclosure links
- **Sources:** every record linked to the candidate, and when each source was last updated

The researched ballot covers New York City, Westchester County and Long Island (Nassau and Suffolk) for the November 3, 2026 general election, including county, town, city and village races outside the city. It works for any U.S. address wherever the national sources allow: federal records everywhere, and Google's ballot data where Google has loaded the election.

The ballot page also shows, for the federal race on each ballot, outside spending for and against every candidate, and an **Israel and Palestine** issue built from a published list of U.S. House roll calls on military aid and arms for Israel since January 2023 (`data/issues/israel-palestine.json`: the rule, every counted vote with each listed member's vote read from the Clerk of the House, and every vote considered and not counted).

## Impartiality rules (enforced in code)

1. Every candidate gets the same five sections in the same layout.
2. Candidates appear in ballot order when the data gives a position for everyone in the contest; otherwise alphabetically by last name. Never by party.
3. No grades, scores, ratings, endorsements, "alignment" percentages, or adjectives about candidates. Parties, votes and money all use the same neutral styling.
4. No AI-written descriptions. Summaries are official text quoted verbatim with a link.
5. Every fact links to its primary record, and every section shows its source and last-updated date.
6. A missing record is labeled, not penalized: "No legislative voting record in these databases", "Executive office: no voting record" (with the Governor's signatures and vetoes shown), "Judicial races have no voting records," or, for city, county, town and village offices, "City, county, town and village records aren't covered by this guide yet."
7. If a name can't be matched to exactly one database record, nothing is linked.

The full rules, sources, issue-mapping tables and known gaps are on the site's **How it works** page (`/methodology`).

---

## Go live: step by step

You need four free API keys, a GitHub account, and a Vercel account. Nothing to install on your computer, and no build step.

### 1. Get the four free keys

| Key | Where | Notes |
| --- | --- | --- |
| **GOOGLE_CIVIC_API_KEY** | [Google Cloud Console: Civic Information API](https://console.cloud.google.com/apis/library/civicinfo.googleapis.com) | Sign in, create a project (any name), click **Enable**, then go to **APIs & Services → Credentials → Create credentials → API key**. Click the new key, choose **Restrict key**, and allow only the Civic Information API. |
| **DATA_GOV_API_KEY** | [api.data.gov signup](https://api.data.gov/signup/) | One key works for both the **Congress.gov API** and the **FEC API**. It arrives by email. |
| **NYSENATE_API_KEY** | [legislation.nysenate.gov](https://legislation.nysenate.gov/) | Use the API key sign-up form on the home page. The key arrives by email. |
| **OPENSTATES_API_KEY** | [Open States / Plural: create an account](https://open.pluralpolicy.com/accounts/signup/) | After signing in, your key is on your [profile page](https://open.pluralpolicy.com/accounts/profile/). |

Optional: **REPORT_ERROR_URL**, a link where visitors can report a mistake (for example your GitHub repo's Issues page, `https://github.com/YOU/ballot-scout/issues`, or `mailto:you@example.com`).

### 2. Put the project on GitHub

Easiest, with [GitHub Desktop](https://desktop.github.com/):
1. Unzip `ballot-scout.zip`.
2. In GitHub Desktop: **File → Add local repository**, choose the `ballot-scout` folder, click **create a repository** when asked, then **Publish repository**. You can keep it private.

Or in the browser: create a new repository on github.com, click **uploading an existing file**, and drag in everything inside the `ballot-scout` folder. On a Mac, press **Cmd+Shift+.** in Finder first so the hidden `.github` folder and `.gitignore`/`.vercelignore`/`.env.example` files are included. The `.github` folder holds the nightly data job.

### 3. Import it into Vercel

1. Go to [vercel.com/new](https://vercel.com/new) and import the GitHub repository.
2. **Framework Preset:** Other. Leave Build Command, Output Directory and Install Command as they are (they come from `vercel.json`).
3. Open **Environment Variables** and add `GOOGLE_CIVIC_API_KEY`, `DATA_GOV_API_KEY`, `NYSENATE_API_KEY`, `OPENSTATES_API_KEY` (and `REPORT_ERROR_URL` if you want it).
4. Click **Deploy**.

### 4. Add the same keys as GitHub secrets (for the nightly data job)

In your GitHub repository: **Settings → Secrets and variables → Actions → New repository secret**. Add:
- `DATA_GOV_API_KEY`
- `NYSENATE_API_KEY`
- `OPENSTATES_API_KEY`

(The Google key isn't needed by the data job. Optional: `NY_SOCRATA_APP_TOKEN`, a free app token from your data.ny.gov account's developer settings, raises the rate limit for the New York campaign-finance download.)

### 5. Run the data job once

In GitHub: **Actions → Refresh data → Run workflow**. (It also starts on its own whenever the ballot file, the workflow, or `.github/refresh-trigger` changes on `main`, so editing that one file is another way to request a run.) It downloads every House and Senate roll call (Voteview), looks up each voted-on bill's issue area on Congress.gov, builds the New York indexes, and pulls outside spending for every federal candidate on the ballot from the FEC. When it finishes it commits the new `/data` files, and Vercel redeploys on its own.

- Congress.gov lookups are paced to stay under 1,000 calls an hour, so the first complete federal build takes a few runs. It runs every night automatically, and you can also click **Run workflow** a few more times to finish sooner. Votes on bills that don't have an issue area yet are hidden until they do.
- If the commit step fails with a permissions error: **Settings → Actions → General → Workflow permissions → Read and write permissions**.

### 6. Point your domain at it (Squarespace domains)

1. In Vercel: **Project → Settings → Domains → Add**, and type the domain, for example `ballotscout.com` or a subdomain like `vote.yourdomain.com`.
2. Vercel shows the DNS record to add. Usually that's an **A record** with host `@` and value `76.76.21.21` for a bare domain, or a **CNAME** with host `vote` and value `cname.vercel-dns.com` for a subdomain. Use exactly what Vercel shows.
3. In Squarespace: **Settings → Domains →** your domain **→ DNS → DNS Settings → Add record**, and enter that record. If you're pointing the bare domain at Vercel, delete Squarespace's default A records for `@` first.
4. Back in Vercel, wait for the domain to show **Valid Configuration** (minutes to a few hours). HTTPS is set up automatically.

---

## Updating the ballot

The researched ballot lives in `data/ballots/ny-2026-general.json`. Each contest and candidate lists its own sources. After editing it, check it:

```
node scripts/validate-seed.mjs
```

The researched file (updated Oct 25, 2026) has 300 contests, 579 candidates and 6 ballot proposals.

- **New York City** (researched Oct 13): Governor/Lt. Governor, Comptroller, Attorney General, U.S. House (NY-3, NY-5 to NY-16), State Senate, Assembly and Supreme Court, plus the 5 NYC Charter proposals (titles only), checked against the NYS Board of Elections certification (Oct 7) and the NYC Board of Elections contest list.
- **Westchester, Nassau and Suffolk** (researched Oct 17): U.S. House NY-1, NY-2, NY-4 and NY-17, every State Senate and Assembly district in those counties, the 9th and 10th Judicial District Supreme Court races, and the local races on each county Board of Elections' 2026 candidate list (county legislatures in Westchester and Nassau, town offices, Westchester city and village races, County, Family and District Court seats, Suffolk County Clerk and Comptroller). Names and lines were checked against the state certification and each county's list by an independent fact-check; Westchester's local candidates rest on the county's list, which stopped loading before the fact-check could re-read it.
- **NYC courts and Council** (added Oct 25): Civil Court countywide seats (New York, Kings, Queens, Richmond) and municipal court district seats, Surrogate's Court (New York and Bronx counties) and City Council District 3, from the NYC Board of Elections General Contest List (printed 9/11/2026, still the only version posted on Oct 25). Municipal court districts and council districts aren't in the Census lookup, so they're listed under "may be on your ballot" with a district picker unless Google's data lists the voter's own race.
- **Re-check (Oct 25):** every state and federal candidate and party line still matches the NYS Board of Elections certification (amended Oct 7, the latest). Incumbency was added where an official town or village page confirms it, and one local proposal (Croton-on-Hudson Proposition One) was added from an official sample ballot.
- Local contests use five more district types: `council` (a city council district number, with its `county`), `county-legislative` (`"Westchester|8"`), `town` and `village` (Census county-subdivision and place names, for example `"Greenburgh town"`), and `district-court` (with the towns and cities it covers). Each names its `county`. County legislative districts aren't in the Census lookup, so the site lists the county's legislative races under "may be on your ballot" with a district picker, unless Google's data lists the voter's own race.
- `localBoards` holds each county Board of Elections' contact details, early voting hours and sites, and links, shown in the "Where to vote" card.

Not yet included: local proposals outside the city beyond the one found on a sample ballot (not every sample ballot was checked), and the NYC proposals' full text and abstracts (the site links to the official documents). If a file only has fictional "Sample Candidate" names, the site shows a "Sample data" banner.

## Data refresh

| Data | How it's updated |
| --- | --- |
| Census districts, Google ballot data and polling places, Congress.gov sponsored bills, FEC money | Live on each lookup (cached briefly) |
| Federal roll calls (Voteview) and bill issue areas (Congress.gov) | Nightly GitHub Action → `data/votes/` |
| NY Senate votes, bills, sponsor memos, Governor's actions (Open Legislation) and Assembly roll calls (Open States) | Nightly GitHub Action → `data/ny/` |
| NY State candidates' committees and itemized transactions (NYS Board of Elections data on data.ny.gov, no key) | Nightly GitHub Action → `data/ny/money-2026.json` |
| Outside spending for and against each federal candidate (FEC Schedule E, with each spender's committee type) | Nightly GitHub Action → `data/fec/outside.json` |
| The Israel and Palestine vote list | By hand, from the Clerk of the House: `data/issues/israel-palestine.json` |
| Ballot contests and candidates | When you replace the seed file |

## Limitations

- Votes cover the 118th–119th Congresses and New York's 2025–2026 session by default.
- Issue matching uses one official category per bill (the CRS policy area, or the primary New York law amended), so some multi-topic bills won't appear under every issue.
- New York's Executive Law (including the Human Rights Law) is too broad to map; no New York law maps to immigration.
- New York sponsor memos exist only for Senate bills. Assembly roll calls come from Open States and may lag.
- New York State money comes from the NYS Board of Elections' open data on data.ny.gov (registered committees and itemized transactions, summed by schedule). It appears only when a candidate matches exactly one registered committee; everyone else gets the official disclosure links. The figures are sums of itemized transactions, not the official report totals.
- Outside New York, the ballot depends on Google's Civic Information API (usually loaded a few weeks before Election Day). Without it, the app shows your current members of Congress, clearly labeled as not your ballot.
- Outside spending covers federal candidates only; New York State and local candidates' Money tabs link to the NYS Board of Elections' independent-expenditure search. The FEC's processed totals can trail recent spending, so 24- and 48-hour reports are shown separately rather than added in.
- Records for county, town and village offices aren't covered yet; those candidates show their ballot listing and sources only.
- Free API limits: FEC allows about 1,000 calls an hour per key. Candidate records are cached at the edge for 6 hours, which covers normal traffic; ask the FEC for a higher limit if the site gets busy.

## Privacy

The address is sent in the body of one request, used only to look up districts (Census Geocoder and Google Civic), and never logged or stored. Short-lived in-memory caches use a one-way hash of it. Candidate record requests contain no address data. No cookies, analytics or third-party scripts.

---

## For developers

Zero runtime dependencies: Vercel serverless functions in `/api` (Node 20+ ES modules, global `fetch`), a vanilla HTML/CSS/JS front end in `/public`, shared code in `/lib`.

```
api/          ballot.js (POST), candidate.js (GET), meta.js (GET)
lib/          one module per source: geocoder, civic, seed, congress, votes, nysenate, openstates, fec,
              plus issues.js (the single issue-mapping table), order.js, labels.js, ids.js, ballot.js, candidate.js
lib/build/    pure transforms used by the data build scripts
scripts/      build-votes.mjs, build-nysenate.mjs, build-nymoney.mjs, build-outside.mjs, build-data.mjs, validate-seed.mjs
data/         ballots/ (seed), issues/ (published vote lists), votes/, ny/ and fec/ (built nightly)
fixtures/     fictional sample data for FIXTURES=1
public/       index.html, methodology.html, assets/
tests/        node:test unit tests, plus the build scripts run end to end against a local mock of each API
e2e/          Playwright end-to-end test (sample-data mode)
```

Run locally (Node 20+):

```
cp .env.example .env              # add your keys
node dev-server.mjs               # http://localhost:3000
FIXTURES=1 node dev-server.mjs    # fictional sample data, no keys needed
npm test                          # unit tests
npm i --no-save playwright && npx playwright install chromium && npm run e2e   # end-to-end, screenshots in /screenshots
```

API:
- `POST /api/ballot` with `{"address": "...", "issues": ["housing", "health"]}` returns districts, election info, polling places, contests and candidates (each with an opaque `id`). Never cached.
- `GET /api/candidate?id=<id>&issues=housing,health&more=0|1` returns the five sections. CDN-cached for 6 hours. `more=1` adds amendment and committee votes.
- `GET /api/meta` returns the issue list and mapping tables, data freshness and mode.
