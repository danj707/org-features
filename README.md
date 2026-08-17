# Org Features Dashboard

Tracks **rec.us feature usage & adoption by organization** — which of the
platform's capabilities each of the 61 published organizations is actually
using, from core module volume (programs, registrations, memberships,
passes, facilities, reservations) down to optional feature adoption
(age eligibility on sections, SMS messaging, waitlists, and so on).

## Live URL

Deployed dashboard (Railway): <https://org-features-production.up.railway.app/>

The root path is the all-orgs view; append `/org/<slug>` for a single-org
drill-in (e.g. <https://org-features-production.up.railway.app/org/carmichael-district>).

## Views

- **`/`** — all-orgs dashboard: sortable usage heat-table across every
  organization with a per-org **feature-adoption score** (% of measured
  features that organization has adopted), summary cards including the
  fleet-wide average adoption, and (as signals land) an org × feature
  adoption matrix.
- **`/org/:slug`** — per-org drill-in: that organization's core usage plus
  a categorized feature-adoption checklist.
- **`/api/data`** — the raw JSON snapshot behind the dashboard.
- **`/ps/remittance`** — Finance › Remittance: per-org **Item Log** exports,
  one billing period at a time (see below).

## Remittance (Finance › Remittance)

Finance used to re-run the product's **Item Log** export by hand once per
billing period, for every org. `/ps/remittance` replaces that: pick the ending
remittance date, then click any organization's date to download that org's CSV.

- **Billing periods** run 1–7, 8–15, 16–22, and 23–end of month. The report
  starts at the period ending **2026-08-15**.
- **Payment / ACH dates** come from the finance remittance schedule in
  `data/remittance-schedule.json`. They're business-day driven rather than
  formulaic, so **each new year has to be transcribed into that file** or the
  date menu runs out of periods.
- The page opens on whichever period is currently *due* — the most recently
  closed one — and labels each period due / payment issued / still open.
- Org names and ids come from the features snapshot, so every published org is
  covered automatically.

Unlike the baked dashboards this queries **Metabase live per request** — an item
log is transactional, and a day-old snapshot would be wrong for finance. The
generated CSV is a drop-in replacement for the product's own Item Log export:
same 12 columns, same order, same value formatting, same rows. Validated against
a real manual export (Chico, 2026-08-08 → 2026-08-15) — identical 1,180 rows and
identical totals, payment-method and item-type counts.

Rows sharing the same timestamp can appear in a different sequence than the
product's export. The product has no tie-break, so its own order isn't
reproducible run to run; this card sorts by `order_item_transaction_id` within a
timestamp, so the same period always exports identically. Row content is
unaffected — a set-comparison of the two files matches exactly.

Live sign-off on the heaviest org (Apex, the busiest period): 9,866 rows in
~7s, well inside the request timeout.

**Config:** `ITEM_LOG_UUID` defaults in code to the public link of the shared
Metabase card "✅ Item Log Report" (question 19900); set the env var only to
point at a replacement card without a deploy. Optional: `METABASE_URL`
(default `https://rec.metabaseapp.com`) and `ITEM_LOG_TIMEOUT_MS` (default
120000). With no UUID the page renders an explicit "not connected" state
instead of failing.

> **Metabase parameter ids are required.** This Metabase (v1.63) rejects a
> public-card query whose `parameters` omit the card's parameter `id` — it 400s
> with a bare `"An error occurred."` in ~3ms, before running any SQL. So
> `remittance.js` reads the parameter descriptors from the card itself
> (`/api/public/card/<uuid>`, cached for an hour) and echoes their ids back.
> Don't "simplify" that into a hardcoded parameter array.

## How the data works

The deployed server has **no direct database access**. The snapshot in
`data/features-data.json` is baked from the live rec.us production database
and committed. Refreshing the numbers = re-baking the snapshot and pushing
to `main` (Railway auto-deploys).

Bakes run against the **Rec-Prod-ReadReplica** database via the Metabase
MCP connection (fleet-wide grouped SQL — one query covers every org). The
Rec Staff MCP was the original source, but its query sandbox now points at
a non-production database, so Metabase is the reliable path. The metric
definitions (live/non-deleted filters, active statuses, per-feature adoption
signals) are documented in the snapshot's `notes` field and in each feature's
`adoption_definition`.

A scheduled Claude Code Routine re-bakes the snapshot daily at ~6am ET and
pushes it to `main`, so the dashboard refreshes automatically each morning.

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
