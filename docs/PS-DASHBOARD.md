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
  revenue-by-owner-by-quarter, and QTD launched/forecast stats. The full
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

Nightly Claude Routine (same as org-features): pull Linear/HubSpot/Airtable
via connectors, rebuild `ps-data.json`, push. The bake currently lives as a
session script; formalizing it into `scripts/ps/` happens once the shape is
approved.

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
- **Sessions**: 30-day HMAC-signed cookies (`SESSION_SECRET` env var),
  HttpOnly + Secure, with per-account login throttling.
- **Storage**: `users.json` in `DATA_DIR` — a Railway volume is mounted at
  `/data` so accounts survive redeploys. `data/users.json` is gitignored.

**Toward multi-tenancy**: partner-facing logins are the natural v3 — add an
`orgSlug` to a user (a "partner" role), scope `/api/ps-data` responses to
that org's slice, and the account drill-in becomes their self-serve status
page. The auth plumbing built here (roles, per-user records, gated APIs) is
the foundation that needs; what's missing is per-org response filtering and
a partner-safe subset of the data (they shouldn't see other orgs' bugs or
internal health flags).
