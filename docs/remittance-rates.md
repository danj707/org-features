# Remittance fee schedules

Where each org's rates come from, and which orgs deliberately have no
"Generate remittance" button.

## How the rates were obtained

Every remittance finance has ever sent states that org's own schedule in its
**Rec Payment Processing Costs** block. The most recent sheet per org was read
straight out of Airtable's `Partner Remittances` attachments and the rates taken
from those cells — they were not inferred from totals.

Two checks had to pass before an org was added to `REMITTANCE_FEES`:

1. **The rate reproduces the sheet.** `rate x card total + fixed x payment count`
   equals that sheet's own card fee line, to the cent.
2. **The UUID is the right organisation.** Querying the transaction-log card with
   that UUID over that sheet's period returns the sheet's own card total, to the
   cent. A correct rate attached to the wrong org is invisible in a diff, so name
   matching alone was never enough — Pleasant Hill has two candidate orgs and only
   one returns the sheet's 14 transactions.

**48 orgs cleared both.** They are marked `rateSource: "remittance"` and are not
stamped as drafts, because these are the rates Rec actually billed.

**32 of those 48 ship**, because clearing both checks is necessary and not
sufficient: the other 16 are on a different fee TEMPLATE — a technology fee or
ticket service fees — and the checks above say nothing about either. The rate
check reproduces "Total Rec Fee", and both of those lines sit outside it. The
33rd schedule in the map is Niagara Falls, on placeholder rates, stamped DRAFT.

## Held back — no button, on purpose

An org that is not in `REMITTANCE_FEES` gets no button, not a button that
guesses. Three groups, and the split now follows the plan of one template per
fee shape, flagged per org in Airtable.

### A different fee template

These orgs' rates were read and verified exactly like the shipped ones. They are
out because the **shape** of their remittance is not the one this report
computes, not because anything about them is unknown.

**Technology fee** — a percentage of total sales across every tender, taken off
the remittance *below* "Total Rec Fee". `lib/` can draw that line, but no check
ever covered it: the rate check reproduces "Total Rec Fee", and this sits
outside that total. Prescott Valley and The Dance Palace are why that matters —
they label it `Technology Fee` where the rest write `Net Technology Fee`, so
they parsed as having none and would have billed $0 against a real fee.

| org | orgId | on its last remittance |
| --- | --- | --- |
| Belton | `86cb6718-c7a4-4639-9f8b-1495f0dc9969` | technology fee $106.64 (parsed as 250 bps) |
| Danvers, MA | `a6aef5df-f742-41a2-9088-1fb6d48c3cb1` | technology fee $251.20 (parsed as 100 bps) |
| Easton | `f4338fa8-009b-49eb-9a2b-16ca4688694a` | technology fee $83.84 (parsed as 500 bps) |
| Euclid | `2a118b52-99af-42f3-9727-d9b46b8d31e4` | technology fee $61.58 (parsed as 100 bps) |
| Prescott Valley | `9acfb33a-4114-4f0f-be3c-2eb0a3930550` | technology fee $86.36 (**parsed as 0 bps** — the label the parser missed); ticket service fees $0.00 |
| The Dance Palace | `35861ae4-e71e-44e9-a574-9c5d6e691612` | technology fee $8.95 (**parsed as 0 bps** — the label the parser missed); ticket service fees $0.00 |
| Watertown, MA | `d781690b-c5a0-43c5-8443-9ae43899528c` | technology fee $246.37 (parsed as 125 bps) |
| Windham, ME | `1c80a358-74c2-477d-aa0b-87bb2d0514b3` | technology fee $112.55 (parsed as 100 bps) |

**Ticket service fees** — `Net Ticket Service Fees`, which this report does not
compute at all. Nine of these read $0.00 today and are held back with the one
that does not: the money is identical this period, and the failure is next
period, when the line moves and a workbook that cannot express it under-bills in
silence.

| org | orgId | on its last remittance |
| --- | --- | --- |
| Boerne | `71bf9bc4-cd62-482a-aee5-5d790cdba811` | ticket service fees $0.00 |
| Madeira Beach | `baa12a2d-b31b-4900-85a1-e6f634f0a3ce` | ticket service fees $0.00 |
| Norman, OK | `574923bd-9e7b-43e0-9e5f-7ce256189cbf` | ticket service fees $0.00 |
| Northern Door Sports and Recreation | `70ea2e35-d1c7-4214-8074-3a598aa991f9` | ticket service fees $0.00 |
| Shrewsbury, MA | `0a9c47af-b4c3-4601-ab0f-d2f401bb787a` | ticket service fees $0.00 |
| Smyrna | `efc0724c-8f32-481a-bab3-fc19c724f3a7` | ticket service fees $0.00 |
| West Sacramento | `7d22bf62-060a-4881-9821-9dea6a0538d6` | ticket service fees $6.50 |
| Yerba Buena Gardens | `b026a7c3-1e7e-48e1-9f0a-b2f7154b117d` | ticket service fees $0.00 |

**Per-transaction minimum** — `max(rate x amount, minimum)` charged per payment,
against this report's `rate x period total + fixed x count`. Different
arithmetic, not a different number: Emeryville, Jeffersonville, Sebastopol
Community Cultural Center, Taylor.

### Unresolved — the rate or the org could not be established

| org | why |
| --- | --- |
| Carmichael RPD | the parsed rate did not reproduce the sheet's own card fee |
| Malibu | period totals disagree — metabase 17208.13 vs sheet 17148.41 |
| Midland | the parsed rate did not reproduce the sheet's own card fee; refund rate (3.50%) differs from the card rate (3.20%), which the model cannot express |
| Niagara Falls | period totals disagree — metabase 71.99 vs sheet 23368.50. It is in the map on **placeholder** rates as the test org, and every workbook it produces is stamped DRAFT |
| San Francisco Rec & Park | the attachment on its Airtable record is not a remittance sheet |
| St. Charles Park District | no rec.us organization in the features snapshot |
| Torrance | period totals disagree — metabase 60438.12 vs sheet 52476.82 |

Emeryville, Jeffersonville, Sebastopol and Taylor also fail the totals check, so
each of them is held on two independent grounds.

