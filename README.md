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

Finance used to re-run the product's **Item Log** and **Transaction Log**
exports by hand once per billing period, for every org. `/ps/remittance`
replaces that: pick the ending remittance date, then click any organization's
date to download that CSV. One column per report:

| Column | Grain | Card |
|---|---|---|
| Item log | one row per order-item transaction (line-item detail, 12 columns) | 19900 |
| Transaction log | one row per transaction event (cart totals + payment-method split, 24 columns) | 19933 |

The two reconcile: Chico's 1,180 item-log lines for 2026-08-08 → 2026-08-15 roll
up to exactly the 630 transactions in that period's transaction log.

- **Billing periods** run 1–7, 8–15, 16–22, and 23–end of month. The report
  starts at the period ending **2026-08-15**.
- **Periods are generated, not listed.** The 1-7 / 8-15 / 16-22 / 23-EOM shape is
  formulaic, so `remittance.js` generates every period from the start date up to
  and including the one in progress. Nothing has to be added each week: the next
  period appears on its own, and the page's default rolls over automatically.
  Future periods aren't offered — there's nothing to export from a period that
  hasn't started.
- **The default is the period finance is working on**: the most recently *closed*
  one. On Aug 23 that's Aug 16–22; the menu (newest first) flips back to any
  prior period, with the in-progress one at the top marked *(in progress)*.
- **Payment / ACH dates** come from the finance remittance schedule in
  `data/remittance-schedule.json`. Those are business-day driven rather than
  formulaic, so each year has to be transcribed there. If a year is missing the
  periods still list and still export — the pay/ACH cards just read "—" with a
  "not in the schedule file yet" note, so **add next year's column when finance
  publishes it** and nothing else changes.
- Each period is labelled *export due* / *payment issued* / *still in progress*.
- Org names and ids come from the features snapshot, so every published org is
  covered automatically.

Unlike the baked dashboards these query **Metabase live per request** — a
transaction log is transactional, and a day-old snapshot would be wrong for
finance. Each CSV is an exact duplicate of the product's own export: same
columns, same order, same value formatting, same rows. Both were validated
against real manual exports (Chico, 2026-08-08 → 2026-08-15):

- **Item log** — 1,180 rows, every total and payment-method/item-type count identical.
- **Transaction log** — 630 rows, all 24 columns identical by checksum, and the
  full quoted CSV rows hash-identical to the manual file.

**On "line for line".** Every line in the product's export appears in ours
exactly once, and vice versa — verified as a multiset against the live cards, so
no row is missing, duplicated, or altered. What can differ is the *sequence* of
lines that share the same timestamp: 9 of 630 in the transaction log, 317 of
1,180 in the item log, and in both cases every difference is a reordering inside
one timestamp, never across one.

That gap is not closable. The product emits no tie-break, so its own order is
not reproducible run to run — re-running the same manual export can reorder those
same lines. It was checked against `transaction_event_created_at`,
`settled_at`, `epsio_id`, `order_id`, `transaction_event_id` and customer name,
ascending and descending; none reproduces the file's order. These cards sort
deterministically instead, so the same period always exports identically. If you
need to diff an export against a historical file, compare them sorted.

Live sign-off on the heaviest org (Apex, the busiest period): 9,866 item-log rows
in ~7s, well inside the request timeout.

**Config:** `ITEM_LOG_UUID` and `TRANSACTION_LOG_UUID` hold the public-link UUIDs
of cards 19900 and 19933. They default in code (a public link is not a secret);
set the env vars only to point at replacement cards without a deploy. Optional:
`METABASE_URL` (default `https://rec.metabaseapp.com`) and `ITEM_LOG_TIMEOUT_MS`
(default 120000). A report with no UUID renders an explicit "not connected"
state for its column and leaves the other one working.

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
