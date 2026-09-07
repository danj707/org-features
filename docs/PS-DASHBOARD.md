# PS Dashboard — architecture

Working doc for the Partner Success dashboard. The `/ps` routes in this repo
are a **clickable mockup built on real data** (baked 2026-07-31); everything
below is what it does today and how it grows into the real thing.

## Page structure

```
┌────────────┬────────────────────────────────────────────────┐
│ Left nav   │  Account Health  (/ps)          ← default      │
│            │    └─ Account drill-in (/ps/org/:hubspotId)    │
│  Account   │  Bug Management  (/ps/bugs)                    │
│   Health   │  CX Reporting    (/ps/reporting)               │
│  Bugs      │                                                │
│  Reporting │  Platform ▸ Org Features (existing dashboard)  │
└────────────┴────────────────────────────────────────────────┘
```

- **Account Health** — one row per account: status, health signals, feature
  adoption, open bugs + 6-month report trend, feature-request rollup,
  engagement. Filters: search / account status / health flags. Sortable.
- **Account drill-in** — the "partner update template": that account's open
  bugs (with who else is affected), feature requests (with how many others
  want it), engagement, links out to HubSpot and the adoption page.
- **Bug Management** — every open Linear bug: search-first workflow for dupe
  avoidance, filters (team / priority / reporter / has-account), age
  highlighting, account chips, click-through to Linear to tag more customers,
  8-week created-WoW trend.
- **CX Reporting** — the Launch Pipeline gantt: services from the Airtable
  Services table (owner, stage, LOE, status, ACV, start / reg-launch / end
  dates), with per-month active counts + ACV, an owner breakdown,
  revenue-by-owner-by-quarter, QTD launched/forecast stats, and an
  ACV-by-pipeline-stage table (which follows the page's filters). The full
  table is baked (all stages) so revenue math can count completed launches;
  the gantt itself defaults to upcoming work — **Launched and Delayed
  stages are hidden unless toggled on** via the Include pills.
  Data lives in `data/launches-data.json`, baked by
  `scripts/refresh/bake-launches.js` (Airtable REST, `AIRTABLE_API_KEY`).
  Freshness has three layers, all needing only the Railway env var:
  the server **self-refreshes on boot** when the snapshot is >6h old
  (each morning's data-refresh deploy triggers this ~6am ET), an **hourly
  staleness backstop** re-bakes if >25h old, and the page's **Refresh now**
  button (`POST /api/launches/refresh`) pulls on demand.

## Data model

Same pattern as org-features: a **baked snapshot** (`data/ps-data.json`)
served by the express app (`/api/ps-data`), refreshed by a scheduled Claude
job, `DATA_DIR` volume override supported. No runtime credentials in the app.

```
ps-data.json
├─ accounts[]         one per HubSpot company with an Account Status (60 today)
│   ├─ status, healthReasons[], timesContacted, lastContacted   ← HubSpot
│   ├─ recSlug, adoptionScore                                   ← features-data.json
│   ├─ linearCustomerIds/Names, openBugCount, bugsMonthly[]     ← Linear
│   └─ featureRequests {total, inDevelopment, onRoadmap, requested} ← Airtable
├─ bugs[]             open Linear issues labeled Bug (241 today)
│   └─ id, title, team, status, priority, age, reporter, url, customers[]
└─ featureRequests[]  Airtable CS Feature Requests (66 today)
    └─ title, status, priority, target, customers[], links
```

## Source mapping (verified against live data tonight)

| Need | Source | How | Confidence |
|---|---|---|---|
| Open bugs | Linear | issues labeled `Bug`, states backlog/todo/started/triage | solid |
| Bug ↔ org tagging | Linear **Customers** + customer needs | need.issue ↔ customer; "tag additional customers" = add a customer request on the issue in Linear (the click-through) | solid, but only 53/241 bugs have a customer attached — a CX habit to build |
| Bugs/month per account | Linear needs `createdAt` | counts of reports/month (includes non-bug requests) | good proxy |
| Account status / health | HubSpot company `account_status`, `account_health_score_reason` | note: there is **no numeric health score** property — reasons are tagged P-/N- | solid |
| Engagement | HubSpot `num_contacted_notes`, `notes_last_contacted` | email+meeting+call counts need engagement-object queries for the split — v2 | partial |
| Feature requests | Airtable "Sales Feature Requests" base → CS Feature Requests table | statuses: Requested to Roadmap / On the Roadmap / In Development. ("Released" isn't a status there yet) | solid |
| Feature adoption | this repo's features-data.json | already refreshed daily at 6am ET | solid |
| Launches | HubSpot deals carry Launch Date (synced into Airtable too) | mockup uses company close-date as stand-in | **v2** |
| Intercom interactions / NPS | Intercom | conversations aren't queryable by company directly via the connector; needs per-contact aggregation or data export | **v2** |

## The join (the messy part)

Accounts are keyed by **HubSpot company**. Linear customers matched by domain
then normalized name (Linear has duplicate customers — e.g. two Rocklins, two
Smyrnas — worth a cleanup pass); rec org slugs matched by normalized name +
a small alias table in the bake script. 15 HubSpot accounts don't map to a
rec org — correctly: they're pre-launch/prospect accounts (Glenview, El
Segundo, Needham, …). One Linear customer (City of Torrance) already stores
the rec org UUID as its external ID — adopting that convention everywhere
would delete the whole name-matching problem.

## Refresh model

**This described an intention, not a fact, and the gap cost five weeks.**
`ps-data.json` was baked once by hand on 2026-07-31 and nothing refreshed it.
The "Org Features dashboard daily refresh" Routine rebuilds
`features-data.json` from Metabase and **does not touch this file** — so on
2026-09-06 the page still listed `PLA-1880` as *In Code Review* when it had
gone Done on 2026-08-04, and **six of the seven rows at the top of the Urgent
list were closed**. Urgent read 7; the truth was 2.

Three things changed as a result.

### 1. The bugs bake is a script now

`scripts/refresh/merge-ps-bugs.js`, same shape as `merge-snapshot.js`: it
takes a payload file and rewrites one section, carrying everything else over.

```
node scripts/refresh/merge-ps-bugs.js payload.json
```

`payload.json` is `{ issues: [...], customers: [...] }`:

- **`issues`** — the `issues` arrays from Linear `list_issues` with
  `label: "Bug"`, **fetched per STATE** (`backlog`, `unstarted`, `started`,
  `triage`) and concatenated. **Do not page the label.** Closed bugs
  outnumber open ones about 5:1, so paging by `updatedAt` reads 1,300+
  records and is still not finished; four state calls return the whole open
  set (~285) and each answers `hasNextPage: false`.
- **`customers`** — the `customers` array from `list_customers` with
  `includeNeeds: true`. **One call, no pagination** (81 customers). Each
  `needs[].issue.id` is the bug→org mapping, and this is the only place it
  exists.

The script **refuses** a payload carrying a closed issue, or one that looks
like a partial fetch, and exits non-zero rather than writing — the failure it
exists to prevent is a snapshot that looks current and is not. `accounts` and
`featureRequests` are never written by it; those come from HubSpot and
Airtable and have their own refresh, which is still by hand.

### 2. Staleness is on screen

The sidebar used to read *"Snapshot &lt;date&gt; · refreshed daily"* — a
standing claim, printed under a 38-day-old date, by a page nothing refreshed.
It states the **measured age** now, and past `SNAP_STALE_DAYS` (2) it says so
in amber. Two days, not one: the bake runs at 6am ET, so a reader before it
lands is legitimately looking at yesterday's snapshot and must not be warned.
An **unreadable or missing** date counts as stale, never as fresh — failing
the other way is exactly how this went unnoticed.

### 3. What is still MANUAL, and why

**There is no scheduled Routine for this bake.** A Routine that fires in a
fresh session needs the **Linear connector attached to it**, and that grant
cannot be made from a Claude Code session — the API refuses the `connectors`
parameter for this organization. So creating one from here would produce a job
that fails every morning with nothing to show for it.

**The action, for Dan:** create a Routine from the claude.ai Routines UI (where
connectors can be picked), attach **Linear**, schedule it after the 6am
features refresh, and give it the steps above. Until then the bugs half is
refreshed by hand — and the amber banner is what makes a missed refresh
visible instead of silent.

## Org names are Linear customer names, verbatim

The Bug Management org filter offers **exactly the names Linear holds**, and
never folds them together. That is deliberate and it is not tidy:

- Linear carries **near-duplicate customer records** for one org — three
  Jurupa Valley variants including a typo (`Jarupa Valley`,
  `Jarupa Valley, CA`, `Jurupa Valley, CA`), `Jeffersonville` and
  `Jeffersonville, IN`, `Chico` and `City of Chico`, `Smyrna` and `Smyrnaga`
  — plus records that are not orgs at all (`EVERYONE`, `Rec`, `Instructor`).
- **52 of its 81 customer records carry no domain**, and no two records share
  one, so domains cannot establish identity.
- Matching the names against Rec's own org list (`features-data.json`, which
  this repo already has) resolves **11 of the 24** that appear on open bugs
  exactly; the other 13 would need the same fuzzy guess.

Merging two orgs on a page used to decide what to work on is silent and wrong,
so the duplicates are **named on screen** rather than quietly reconciled. The
real fix is in Linear: give every customer the rec org UUID as its external
ID, the way City of Torrance already does — that deletes the whole
name-matching problem, and it is open question 1 below.

**And the filter states its own coverage.** Only **44 of 285** open bugs carry
any customer, so filtering by org necessarily hides the untagged 241. Without
saying so, "3 bugs" reads as this org's total when the truth is "3 bugs are
*tagged* to this org".

## Open questions for Dan

1. **Bug↔org coverage**: only ~20% of open bugs have a Linear customer
   attached. Push the team to tag via Linear customers (the data model is
   there), or should the dashboard infer orgs from bug titles ("P1 — Chico…")
   as a fallback?
2. **"Time spent on bugs"**: started as WoW created-count per the brief —
   real time-spent needs Linear cycle/estimate data or status-transition
   timestamps. Which flavor do you want?
3. **Account set**: HubSpot companies with an Account Status (60) is the row
   set. Right universe, or should prospects (Discovery) be hidden by default?
4. ~~**Access**~~ — resolved: `/ps*` now sits behind auth (see below).
5. **Intercom**: worth building the per-org conversation aggregation (slower,
   more API calls), or is HubSpot engagement enough for v1?

## Access control

All `/ps*` pages and `/api/ps-data` require a signed-in user. The public
adoption dashboard (`/`) stays open.

- **Signup**: anyone with the team signup code (`SIGNUP_CODE` env var — the
  "shared password") can create an account at `/login` and choose their own
  password. Passwords are scrypt-hashed; nothing is stored in plaintext.
- **Roles**: `admin` and `user`. The first account created becomes admin;
  admins get an **Admin → Users** page to promote/demote/deactivate anyone.
  The server refuses to remove the last active admin. Today `user` = view
  dashboards, `admin` = also manage users; new tiers slot into the same
  role check as pages start needing them.
- **Password reset**: admin-initiated. On **Admin → Users** each row has a
  **Reset password** button that mints a one-time link (`/reset?token=…`,
  1-hour expiry, sha256-hashed at rest) and — when `RESEND_API_KEY` is set —
  emails it straight to the user via Resend (`FROM_EMAIL`/`FROM_NAME`,
  defaulting to `reports@rec.us`, the Resend-verified domain; the key is a
  Railway reference to the rental-report service's). The link is also shown
  in the UI to copy/send manually, which is the whole flow when no key is
  configured. Redeeming it bumps the account's session version, so every
  previously issued cookie stops working. Generating a new link replaces
  any outstanding one; deactivated accounts can't be reset (reactivate
  first). Redemption attempts are IP-throttled like logins.
  Self-service too: **Forgot your password?** on `/login` emails a reset
  link to the account's address (`POST /api/auth/forgot`). The reply is
  the same whether or not the email is registered, so the form can't
  probe for accounts; requests are throttled per-IP and per-email, and it
  requires `RESEND_API_KEY` (without it, only the admin flow exists).
- **Sessions**: 30-day HMAC-signed cookies (`SESSION_SECRET` env var),
  HttpOnly + Secure, with per-account login throttling. Cookies carry a
  per-user session version that invalidates on password reset.
- **Storage**: `users.json` in `DATA_DIR` — a Railway volume is mounted at
  `/data` so accounts survive redeploys. `data/users.json` is gitignored.

**Toward multi-tenancy**: partner-facing logins are the natural v3 — add an
`orgSlug` to a user (a "partner" role), scope `/api/ps-data` responses to
that org's slice, and the account drill-in becomes their self-serve status
page. The auth plumbing built here (roles, per-user records, gated APIs) is
the foundation that needs; what's missing is per-org response filtering and
a partner-safe subset of the data (they shouldn't see other orgs' bugs or
internal health flags).
