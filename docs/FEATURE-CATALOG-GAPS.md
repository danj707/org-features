# Finding features the catalog does not know about

Dan, 2026-09-11, after calendar sync turned out to be missing: *"do a deep dive
into how we might find more 'features' that aren't being surfaced. I only care
about things that are launched, not behind feature flags, etc. Maybe look in the
product-launches slack channel?"*

## Why the catalog goes stale, mechanically

`data/features-data.json` carries the catalog, and `merge-snapshot.js` copies it
forward on every bake (`features: old.features`). Nothing compares it against
the schema or against what shipped. So the catalog only ever gains a feature
when a person adds one, and the failure is silent: the page renders perfectly,
the score looks reasonable, and the missing feature is simply not a question
anyone can ask. Calendar sync sat outside it for months.

## The source that makes this checkable: #product-launches

`#product-launches` (C09PUNHFE4A, created 2025-10-30) carries a Macroscope bot
digest of every release, and **each item states its own availability** —
`Generally available`, or `Gated by the DISCOUNTS_M1 feature flag`, or `Toggled
via Statsig feature gate`. That line is what makes "launched, not behind a flag"
a filter rather than a judgement call.

Read end to end for this pass: **863 release items with an availability line,
527 of them generally available and unflagged**, from channel creation to today.

Three shapes to parse, because the digest format changed twice:

* `• *Title*` / `Author:` / `_Availability: …_`   (Nov 2025 – Apr 2026)
* `• *Title*` / desc / `Author:` / `Availability:` (Apr – Jun 2026)
* `◦ *Title* — desc Author: x. Availability: y`    (Jun 2026 – now)

Before Nov 2025 there is no structured source; those launches were written up by
hand by Elise and Ankur and have to be read.

## THE FILTER IS NOT THE ANSWER — most GA items are not features

Of the 527 generally-available items, the overwhelming majority are fixes,
copy changes and performance work ("Faster GL code reporting", "Birthdate picker
no longer shifts dates by one day"). A catalog entry needs three things:

1. it is a **capability an organization turns on or configures**, not a fix and
   not a platform-wide default,
2. it has an **org-scoped signal** — a table carrying `organization_id`, or a
   column on one that does, and
3. **not every org has it**. A filter that matches the whole fleet measures a
   structural fact rather than adoption, which is the `registration_windows`
   problem already recorded in the fleet query.

## What the sweep found, measured 2026-09-11

Over 146 non-sandbox organizations, 73 of them live.

| candidate | signal | orgs | volume |
|---|---|---|---|
| **Per-session registration** | `section.registration_mode = 'per-session'` | **63** | 3,297 sections |
| **Staff assignment ("Assigned to")** | `admin_assignment` | **54** | 15,384 |
| Admin notification routing | `organization_admin_notification_assignments` | 34 | 104 |
| **Custom report builder** | `custom_report_organization` | **31** | 240 |
| **Payment-plan auto-pay** | `payment_plan.autopay_enabled` | **17** | 8,622 plans |
| Campsites / nightly booking | `court.type = 'campsite'` | 7 | 69 sites |
| Donation funds | `donation_fund` | 6 | 21 |
| Facility rental approvals | `facility_rental_approval` | 3 | 64 |
| Site groups | `location_site_group` | 3 | 8 |
| Musco lighting — schedules | `reservation_lighting_schedule` | 2 | 10 |
| Musco lighting — wired sites | `site_lighting_configuration` | 1 | 73 |
| Staff SSO | `staff_sso_organization` | 1 | 1 |
| Voice agent | `organization_voice_config` / `voice_call` | 1 | 12 calls |

### Two candidates REJECTED, and both were measured rather than reasoned about

* **Instant-booking site configuration** (`site_instant_booking_configuration`,
  113 orgs) is NOT a new feature — the catalog's existing `instant_booking`
  reads `court.is_instant_bookable` and covers 106 orgs, with only **10** orgs
  configured and no bookable court. Two spellings of one thing, and adding it
  would double-count instant booking in every adoption score.
* **Invoicing** (`invoice_v2`, **101 orgs, 505,707 rows**) is near-universal and
  transactional rather than configured — an invoice is generated, not turned on.
  What actually launched is *facility rental* invoicing, which is a subset this
  table does not separate out. It needs a definition before it can be measured;
  taken whole it would report 101 of 146 orgs "adopting" a thing they never
  chose.

### Recommended next entries, in order

1. **Per-session registration** — the biggest genuinely-missing capability, and
   the catalog is already wrong about it. `restricted_registration_mode` is the
   one unmeasured entry, and its note records that `registration_mode` carries
   only `section` and `per-session`. That is true, and it means per-session
   registration IS measurable even though invite-only is not. The note ruled out
   a feature it had the data for.
2. **Staff assignment** — 54 orgs, and the launch write-up is explicit that it
   is the input to personalised admin homepages and routing, so its adoption
   curve is worth watching.
3. **Custom report builder** — 31 orgs, and it is what Partner Support hands to
   an org instead of building them a report.
4. **Payment-plan auto-pay** — 17 orgs and moving fast: the sibling
   rental-report project measured **228** auto-pay plans on 2026-09-01 and it is
   **8,622** today. Distinct from `auto_renew_memberships`, which is a
   membership plan setting.
5. **Donation funds** and **campsites** — small, but both are self-contained
   products an org either sells or does not, which is exactly what this
   dashboard is for.

The four single-org ones (Musco lighting, SSO, voice agent, and rental
approvals at three) are real but are pilots today. They are worth adding the
moment a second org appears, and worth *watching* now — a feature going from one
org to five is the signal this dashboard should be the first to show.

## MAKING THIS A PROCESS RATHER THAN A SWEEP

The sweep above takes an afternoon and will be stale in a month. Two cheap
checks would keep it honest:

* **A catalog-coverage spec.** Every org-scoped table with more than N
  organizations behind it either maps to a catalog key or sits on an explicit
  "not a feature" list. A new table nobody has classified fails CI. That turns
  the gap from invisible into a one-line decision.
* **A monthly read of the availability lines.** The digest's own
  `Availability: Generally available` is machine-readable, so a scheduled job
  could post new GA items that mention no existing catalog key. It cannot decide
  what is a feature — the 527-to-13 ratio above is the whole reason — but it can
  put the shortlist in front of someone.

Neither is built. Both are smaller than re-running this by hand twice.
