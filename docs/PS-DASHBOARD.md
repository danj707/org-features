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

## THE NIGHTLY BAKE IS A CRON JOB NOW, NOT A ROUTINE (2026-09-07)

Dan: *"why is the routine broken?"* and then, correctly: *"pretty
straightforward cron job, no? every AM, scan each org and read all their
features"*.

### What was wrong

`Org Features dashboard daily refresh (6am ET)`
(`trig_01WQfJBjinDM8GRzMRDuwon6`, cron `0 10 * * *`) was **enabled and firing
on schedule the whole time.** It carried
`persistent_session_id: session_0118uDXFFMUoa6tAiJ9iLnHq` — a session created
30 July whose `updated_at` is **2026-08-22T11:40:04Z** and has not moved
since, status IDLE, `connection_status: disconnected`.

The last daily-refresh commit is **2026-08-22**. So the 22 August firing
landed, the session then went cold, and every firing after that was delivered
into a session that never woke. A manual `fire_trigger` on 7 September did not
land either, which is what ruled out the schedule as the cause.

**THE FAILURE IS SILENT BY CONSTRUCTION, and that is the part worth keeping.**
A Routine that wakes a *bound* session records no run outcome — `list_triggers`
returns no `last_run` for it at all (that field is documented as absent when
"the Routine wakes its own bound session"). So there was no failed run to see,
no notification, and nothing in any list that said it had stopped. Sixteen days
of the dashboard confidently serving 22 August data with a "refreshed daily"
claim on it. Compare the sibling `Daily Feature Update` Routine, which creates a
fresh session per fire: its failure on the same day shows as
`last_run: ROUTINE_RUN_STATUS_FAILED`, visible immediately.

**Generalise it: never bind unattended recurring work to a persistent session.**
A bound session is a container that will eventually be reclaimed, and the
binding turns that into an unobservable no-op. Fresh-session-per-fire at least
fails loudly.

### Why it should not have been a Routine at all

The work is: run one saved query, run one script, commit one file. No judgement,
no tool choice, no reading of anything. An agent session buys nothing and adds a
container, a connector grant and a session lifetime to depend on.

`.github/workflows/refresh-features.yml` — daily at 10:00 UTC plus
`workflow_dispatch`:

1. `scripts/refresh/fetch-card.js` fetches **Metabase card 21616** (the saved
   fleet query; the repo's `fleet-query.sql` remains the readable copy and
   documents what each metric means).
2. `merge-snapshot.js` rebuilds the snapshot and **exits non-zero on any of its
   own sanity checks** — under 100 orgs, a row of the wrong shape, an adoption
   key that drifted between the query and the script.
3. `ci-check-data.js` and `npm test` run **before** the push, because a snapshot
   that will not parse takes the whole dashboard down and this job is the thing
   that changes that file most often.
4. Commit and push **only** `data/features-data.json`, rebasing rather than
   forcing so a human commit landing mid-run is not discarded.

The decisions inside it:

- **A failure is a red X anyone can see.** That is the entire point of moving
  it — the old shape could not fail visibly.
- **Nothing changed is not a failure.** `git diff --quiet` skips the commit, so
  a quiet morning does not deploy Railway for nothing.
- **A missing `MB_API_KEY` names the secret and where it goes**, rather than
  failing on a 401 the next person has to decode.
- **NULL is not an empty snapshot.** `json_agg` over no rows is NULL, so a
  query matching no organizations fails in the fetcher rather than writing
  `null` and letting the merge decide what that meant.
- **`concurrency`**, or two overlapping runs race on the same commit.
- Card 21616 carries **no template tags**, so — unlike every card in the
  sibling project — an API save cannot silently retype a date parameter.

### VERIFIED GREEN 2026-09-07, and the 403 on the way is worth recording

Run 3 of the workflow: fetch 4s, whole job 19s, and it pushed
`9ee00d9 Daily data refresh (2026-09-07)`. The first two runs failed, and both
failures are traps someone will hit again:

1. **The key went into Railway, not GitHub.** `MB_API_KEY` on the Railway
   `org-features` service is what an app redeploy picks up; a GitHub Actions
   runner cannot see it. The log showed `MB_API_KEY:` empty and the fetcher's
   own "not set" message. They are two different secret stores with the same
   variable name.
2. **A CARD IN A PERSONAL COLLECTION CAN NEVER BE READ BY AN API KEY.**
   Card 21616 was saved into "Dan Jenner's Personal Collection" (where a
   newly-saved card lands by default), and Metabase answered
   `403 You don't have permissions to do that.` A Metabase API key acts as a
   synthetic user in a *group*, never as the person who minted it, and a
   personal collection cannot be granted to a group — so no permission change
   could ever have fixed it. The card was moved to the **CX Dashboard**
   collection (id 4324) and the run went green with no other change.

   Generalise it: when an API key 403s on a saved question, check WHERE the
   question lives before touching permissions.

### It needs one secret

`MB_API_KEY` in the repo's Actions secrets: Metabase → Admin → Authentication →
API keys, scoped to a read-only group with access to Rec-Prod-ReadReplica.
Until it exists the job fails on step 1 with that instruction.

The alternative, taken *not* to be the default: make card 21616 public and read
`/api/public/card/<uuid>/query/json` with no credential at all, which is how the
sibling project serves every report. Rejected here because this payload is
fleet-wide adoption for all 144 organizations rather than one org's own data,
and an unguessable URL is not an access control.

### The ps-data bugs bake is the same shape and is NOT done

`merge-ps-bugs.js` still needs a Linear fetch, which today comes from the MCP
connector inside a session. With a Linear API key in the same Actions secrets it
becomes the identical four-step job and the "Dan must create a Routine by hand"
ask goes away entirely.

## THE ORG FEATURES PAGE, REBUILT AROUND ADOPTION (2026-09-07)

Dan's six asks, verbatim, and what each one turned into.

### The list is twelve group columns, not six count pills

*"The main org list of feature adoption has a ton of space for improved
metrics. Kill the pills and give me a list of the top 10 or so columns of
features by group."*

The six pills were `programs / registrations / memberships / passes /
facilities / reservations` — **measures of SIZE, not adoption.** Apex has
98,197 registrations and Aspen has none, which tells you which org is big on
a page about which features are configured. They are replaced by one column
per feature category (twelve), each reading `used/total` for the **tracked**
features in that group, on a **linear** ramp — `heat()` is a log ramp over
counts, and here every cell is already a share of its own denominator, so
4/4 in a group of four must look identical to 8/8 in a group of eight.

The core counts are **not deleted** — they moved to the drill-in, where size
is context beside the gaps rather than the headline.

**AND THE "TON OF SPACE" HAD A CAUSE.** The org slug was rendered with the
global `.note` class, which is the **centred empty-state style with 26px of
vertical padding**. That padding is what made every row three lines tall with
the slug adrift in the middle. `.subslug` fixed it: a row pair is 94px now.
Generalise it: a utility class named for one job (an empty-state message)
carries that job's spacing wherever it is reused.

### The fingerprint strip is the default view

*"Add this pill style view to the default view, below the metrics for each
org, this is a great quick visual representation."*

It used to render only on click, which is why nobody saw it and why the table
had bands of dead space. Every org row is now followed by a strip of **56
dots grouped into the twelve categories** — 8,064 dots on the page, which
paints in ~1s.

**OFF IS AN OUTLINE, NOT A PALER FILL.** At 7px a light grey square and a
light green one are the same smudge, and telling them apart at a glance is
the entire point of the strip.

### What they are NOT using, named

*"Callout what the org is NOT using specifically."*

A `Not using (N): …` line under each fingerprint, naming up to
`FP_MISS_SHOWN` (12) features and saying `+N more` beyond that — an org at 2%
adoption is missing 55, and printing all of them turns the table into prose.
A fully-adopted org says so rather than rendering an empty callout.

On the drill-in the gaps **lead**, above the per-category detail, grouped by
category so a reader sees *where* the gaps are rather than one alphabetical
list. A **fully-adopted group is not a gap and so is not listed** — which
would silently omit whole groups, so there is a `Fully adopted: …` line.

### An admin link per org

*"Add a link to the admin page for each org after the org name."*

`ofRecAdminUrl(orgId)` → `https://www.rec.us/admin/o/<uuid>`, on the list and
the drill-in. **NULL without an id**, so the link is absent rather than
pointing at `/admin/o/undefined` — a link that 404s is worse than no link,
and the snapshot's org id really is the uuid that path wants (all 144
verified). It carries `stopPropagation`, because the row itself navigates.

### Clicking an org opens a drill-in inside the shell

*"When clicking on an org, I want it to open another window but still in the
same navigation screen, with a breadcrumb link at the top to go back."*

`/ps/features/<slug>`, routed through `nav()` so the sidebar stays. Three
things had to line up or it half-works:

- **The slug is parsed BEFORE the bare `/ps/features` prefix test**, which
  would otherwise swallow it and land every drill-in back on the list.
- **`featureorg` needs a `titles` entry.** The header renders
  `titles[r.page][0]`, so a route with no title does not degrade — it throws
  and React unmounts the whole dashboard.
- **The server must serve `/ps/features/:slug`.** A client route the server
  does not serve is a hard 404 on refresh or on a pasted link.

**ONE COMPONENT OWNS BOTH VIEWS.** The drill-in renders from `Features`
rather than being its own top-level component, because a second component
would fetch the snapshot again and resolve the settings again, and the two
copies would disagree about the tracked set the first time either changed.
The spec asserts each fetch appears exactly once.

An unknown slug says so. A deep link to an **excluded** org still renders and
says why it is not in the list — it is reachable from the settings sheet and
from a link somebody was sent.

### Every category, used and unused, with the measured figure

*"The expanded org feature adoption page should give me each feature category
and a full set of metrics of what they are using and what they aren't."*

Twelve panels, each with `n of m in use` and its share, split into **In use**
(with the figure) and **Not in use**. The figure is the snapshot's own
`detail` string — *"4,573 sections with age rules"* — read rather than
re-derived, so the page cannot phrase a number differently from the bake.

### Guards

`org-features-settings.spec.js` 103 → **182 assertions**, lifting and RUNNING
`catShort`, `ofRecAdminUrl`, `ofGroupScore` and `ofRatioHeat`, and checking
the short labels against the **catalog** rather than a transcribed list.

Mutation-tested **22 ways, all failing by name**: a category losing its short
label, the admin link built without its id guard, an empty group scoring 0%
instead of null, the ratio ramp going logarithmic (caught by measuring the
midpoint, not by reading the formula), the count-pill columns coming back,
the fingerprint hidden behind a click again, the not-using list reduced to a
bare count, an all-hidden group still getting a column, groups built from the
full measured set, the row navigating with a full page load, the admin link
swallowing the row click, the route parsed after the prefix, `featureorg`
losing its title, the server not serving the drill-in, the settings fetched
twice, the breadcrumb becoming a plain anchor, an unknown slug rendering
blank, an excluded org silently 404ing, the detail re-deriving its own
figures, fully-adopted groups omitted, the core counts deleted rather than
moved, and an unused dot tinted instead of outlined.

Verified in a browser end to end: 14 columns with no count pills, 12 group
cells per row reading `9/9`, 56 dots in 12 boxes per org (8,064 total, ~1s
paint), the admin href carrying the real uuid, `Not using (6): SMS
Messaging, …` on Apex and `Not using (55): … +43 more` on Aardvark, a click
landing on `/ps/features/apex-…` with the sidebar intact, 12 category panels
with 50 used + 6 unused rows summing to the tracked 56, the breadcrumb
returning to all 144 rows in-shell, a pasted drill-in URL answering 200, and
an unknown slug explaining itself. No uncaught page errors.

**A FOURTH SLICE PINNED TO A NAME.** Giving `Features` a prop broke four spec
slices anchored on the literal `"function Features()"` — a signature change
that altered no behaviour, leaving `indexOf` at -1 and garbage slices. They
anchor on `"function Features("` now. Fourth instance in this repo family.

## ELEVEN QUICK VIEWS ON THE ORG FEATURES LIST (2026-09-07)

Dan: *"add some quick filters next to the 'all organizations' pull down menu.
I need 'top orgs by adoption', 'lowest orgs by adoption', top 'sms users',
top event users, that type of thing. Thinking of 10 or so quick filters so I
can quickly scan which orgs are doing what."*

A chip row beside the pulldown. Each chip **scopes and sorts** — "top SMS
users" means both *only orgs sending SMS* and *busiest first*; scoping alone
gives an alphabetical list of twenty orgs and no answer.

### WHICH FEATURES ARE ON THE ROW WAS MEASURED

A "top users" scan is only worth a click where a handful of orgs dominate.
`facility_rentals` is on 110 of 144 orgs and `group_reservation_windows` on
116 — a chip for either lists most of the platform. Every feature chip is on
**16–57 orgs with the top five holding 59–96% of the volume**:

| feature | orgs | top-5 share |
|---|---|---|
| `auto_renew_memberships` | 16 | 76% |
| `ai_routines` | 17 | 84% |
| `sms_messaging` | 20 | 88% |
| `ticket_sales` | 23 | 96% |
| `rental_permits` | 23 | 87% |
| `competitions_leagues` | 24 | 76% |
| `payment_plans` | 37 | 72% |
| `ai_assistant` (Seb) | 57 | 59% |

**`ticket_sales`, not `events`, for the ticketing chip.** An `event` row is a
CONFIGURED event, so ranking by it puts whoever drafted the most events on
top; a confirmed ticket is a sale. The spec asserts every feature chip stays
inside 70 orgs, so adding a broad one fails rather than shipping a chip that
answers nothing.

### The three ranked views, and why two of them filter

- **Top adoption** — highest first, capped at 25.
- **Lowest adoption — LIVE ONLY, and that is the view rather than a detail.**
  A pre-launch org at 2% is mid-configuration, not a finding; a *live* org at
  25% is. Without the filter this view is just the 71 unlaunched orgs.
- **Pre-launch progress** — the other side: of the orgs not yet live, who is
  furthest through configuration.

**AN UNSCORED ORG IS NOT THE LOWEST-ADOPTION ORG.** `scoreOf` is null when
the bake never measured an org, and letting a null sort to one end would put
"we cannot tell" at the top of a list titled Lowest adoption. Ranked views
drop them.

**Ties break by name**, so two runs of one view cannot disagree.

### The rules the chips follow

- **One active at a time**, and clicking the active chip clears it — so there
  is no separate "off" chip. Picking a chip clears the single-org pulldown and
  picking an org clears the chip: two controls producing one state is a
  control that looks broken.
- **The count on a chip comes from the SAME reducer that does the filtering**,
  or the chip promises a number the click does not deliver.
- **A chip with nothing behind it is not offered**, and neither is one whose
  feature the settings have hidden — the settings scope this page, so ranking
  orgs on something the score ignores is noise.
- **THE ACTIVE VIEW STATES WHAT IT IS SHOWING**, including the cap: 25 rows
  that look like the full list is how a reader takes a slice for the fleet.
  It also carries the way back to all 144 alphabetically.
- **The view is applied to the settings-scoped set**, so no view can widen
  past an excluded org.
- **The default order is untouched** — alphabetical, as Dan asked earlier. A
  quick view re-sorts; it does not redefine how the list opens.

### Guards

`org-features-settings.spec.js` 182 → **268 assertions**, lifting and RUNNING
`ofApplyQuickView` over fixtures, and checking the chip set against the
**snapshot** rather than a transcribed list.

Mutation-tested **14 ways, all failing by name**: the rank direction
inverted (the one mistake that matters, and a regex over a comparator cannot
see it), lowest-adoption losing its live-only filter, unscored orgs ranking as
lowest, a feature view listing orgs with zero, the cap applied silently, ties
made non-deterministic, a chip offered for a settings-hidden feature, an empty
chip offered, chip counts computed separately from the filter, the chip not
clearing the pulldown, the scope note removed, the active chip not visibly
active, a chip ranking on an unmeasured key, and a broad feature offered as a
scan.

Verified in a browser: 11 chips each carrying a number; at rest all 144 rows
alphabetical with no scope note; Top adoption 25 rows scoring 96/93/89/84…;
Lowest 7/11/13/13… all live; Pre-launch all unlaunched; the SMS chip's "20"
matching exactly the 20 rows the click shows, ranked by volume; picking an org
clearing the chip and vice versa; and clicking the active chip returning to
all 144. No uncaught page errors.
