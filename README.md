# Org Features Dashboard

Tracks **rec.us feature usage & adoption by organization** — which of the
platform's capabilities each of the 61 published organizations is actually
using, from core module volume (programs, registrations, memberships,
passes, facilities, reservations) down to optional feature adoption
(age eligibility on sections, SMS messaging, waitlists, and so on).

## Views

- **`/`** — all-orgs dashboard: sortable usage heat-table across every
  organization with a per-org **feature-adoption score** (% of measured
  features that organization has adopted), summary cards including the
  fleet-wide average adoption, and (as signals land) an org × feature
  adoption matrix.
- **`/org/:slug`** — per-org drill-in: that organization's core usage plus
  a categorized feature-adoption checklist.
- **`/api/data`** — the raw JSON snapshot behind the dashboard.

## How the data works

The deployed server has **no direct database access**. The snapshot in
`data/features-data.json` is baked from the live rec.us production database
via the Rec Staff MCP and committed. Refreshing the numbers = re-baking the
snapshot and pushing.

The **adoption score** shown per organization is the share of *measured*
features (`measuredFeatures`, currently 14 of the 53-feature catalog) that
the org has adopted — i.e. adopted ÷ measured. As later waves measure more
features, the denominator grows and scores re-baseline automatically.

If a `DATA_DIR` env var is set (e.g. a Railway volume mounted at `/data`),
a `features-data.json` dropped there takes precedence over the baked copy,
so data can be refreshed without a redeploy.

## Run

```bash
npm install
npm start        # listens on PORT (default 3200)
```

## Stack

Node/Express + React 18 via CDN (no build step), same conventions as
[`rental-report`](https://github.com/danj707/rental-report). Deployed on
Railway from the `main` branch.
