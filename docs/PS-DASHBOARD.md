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

## Org Features settings — scoping, not deleting (2026-09-07)

Dan: *"of all the measured features, we'll need a 'settings' option for the org
features page, lets me toggle on/off via a checkbox what I care about"*, then
*"settings toggle is every user. Let's skip the sub features for now, but build
out the settings. Keep it high level, main features are checkboxes. and include
the ability to exclude specific orgs, I'm already seeing some test orgs that I'd
need to exclude."*

The gear on the Feature usage panel opens a sheet with two lists. Stored under
the store key **`org-features-settings`** as
`{ hiddenFeatures[], excludedOrgs[], updatedAt, updatedBy }`, read by
`GET /api/org-features-settings` and written by `PUT`.

### IT IS SHARED, AND IT IS EVERY USER

Both routes are behind `auth.requireAuth` and **deliberately not
`requireAdmin`** — Dan's call. The consequence is the whole shape of the sheet:
because a save reaches everyone, it is **draft-then-save**, Save is disabled
until the draft actually differs from what the server holds, the footnote says
which of those two states you are in, and `updatedBy` records who last changed
it. Auto-save would push a half-made change to every reader the moment a box was
ticked.

`updatedBy` is taken from `req.user`, **never from the body** — a caller can
claim to be anyone.

### THE SCOPE APPLIES ONCE, ABOVE EVERY SURFACE

- `shown = measuredFeatures − hiddenFeatures` is the tracked set, and
  **`scoreOf` takes its numerator AND its denominator from it.** That is the
  point of the setting: "how adopted is this org" only means something against
  the features you care about. The per-org checklist and the A/B gap list read
  the same set, or they list features the score above them ignores.
- `all = everyOrg − excludedOrgs` is what the table, the pulldown, both compare
  slots, the fleet average and the org count all read. Filtering in each place
  separately is how the facility Summary came to disagree with itself about how
  many bookings there were, one project over.

### THREE STATES, NOT TWO — the absent-is-not-zero rule again

`scoreOf` returns **null**, not 0, when the bake never measured that org *and*
when nothing is ticked. An empty denominator is not an organization that adopted
nothing, and 0% reads as a verdict.

Same asymmetry on the fetch: **a settings fetch that fails falls back to showing
everything**, with an amber note saying so. Failing the other way renders an
empty dashboard, which reads as "nobody has adopted anything" — and the reader
has no way to tell that from the truth.

### EXCLUDED IS NEVER HIDDEN

`data-feat-scopenote` states what the settings removed and that scores taken
over a narrowed set are not comparable with a differently-scoped view. A count
that quietly drops organizations is how a fleet figure stops being trusted.

### The sheet's own traps

- **PORTALLED ONTO `<body>`.** The sibling project shipped this bug twice: a
  sheet rendered inside a styled container inherits its `text-transform`,
  colour and `flex-direction`, and its Save button loses to the container's own
  button rule and renders as inert grey — which is reported as "the settings
  page doesn't work", not as a CSS problem.
- **The sheet states its own button style.** There is no global `button` rule on
  `ps.html`, so without `.ofs-foot button.ofs-save` the primary action renders
  as a browser default beside Cancel.
- **Already-excluded orgs are pinned to the top**, and an excluded slug whose
  org has left the snapshot **stays listed and says so** — otherwise an org
  excluded last month could never be un-excluded.
- **Section headers are NOT sticky**, and that was tried: two sticky headers in
  one scroll box only hand over when the second reaches the top, and the org
  list scrolls inside its own 232px box so the second never gets there. The
  result was "FEATURES COUNTED" pinned above the organization list.
- **The org list scrolls in its own box** — 144 accounts would otherwise push
  Save off the bottom of the sheet.
- Features are grouped by the catalog's **existing** `category`. Dan deferred
  sub-features, so no second taxonomy is invented here.

### The validator

`normalizeOfSettings` bounds a stored list on every axis it can grow along —
200 features, 500 orgs, 120 chars each — trims, drops blanks and non-strings,
de-duplicates and **sorts** (so two saves of the same set compare equal, which
is what `dirty` depends on), and drops unknown keys rather than carrying them.
The PUT **echoes what was stored, not what was sent**, so a clamped or
de-duplicated entry is visible rather than assumed.

`_ofSettings` is a module cache, invalidated through `store.onKeyChange` — a
change on one replica must not leave the other serving a stale record until it
restarts.

### Guards

`scripts/org-features-settings.spec.js` (**90 assertions, in CI**) has a source
half and a **live half that boots a real server, signs up, saves, reads back,
restarts and reads back again** — a regex over our own patch is not evidence the
server behaves. `SKIP_SOURCE=1` drops the source half so the live half can be
shown to catch a regression alone.

Mutation-tested **29 ways, all failing by name**: the score taken over every
measured feature (so settings do nothing), nothing-ticked scoring 0%, the
exclusion filter removed, the pulldown keeping excluded orgs, the checklist and
the A/B gap list showing untracked features, the settings-fetch failure hiding
everything, the PUT made admin-only, the body stored verbatim, `updatedBy`
trusted from the body, the replica cache never invalidated, de-duplication and
the blank/length/unknown-key clamps each dropped, the GET unauthenticated, the
PUT echoing the request, the sheet rendered in place instead of portalled, Save
always enabled, auto-save on every tick, excluded orgs not pinned, a departed
org silently unlistable, the sheet adopting its own draft, the scope note
removed, the launch flag dropped, four CSS rules removed, and `writeJSON`
dropped so nothing survives a restart.

Verified in a real browser end to end: the gear opens the sheet on `<body>` with
56 feature checkboxes across 12 groups and 144 org checkboxes, rows neither
uppercased nor stacked, Save disabled at rest and enabled on the first tick;
unticking one feature moves the tracked count 56 → 55 and the open checklist to
55 chips, excluding one org moves the count 144 → 143 and the pulldown 145 → 144
options and drops that row from the table; the settings survive a reload; and
clearing them brings all 144 organizations and 56 features back with the scope
note gone. No uncaught page errors.
