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

## Held back — no button, on purpose

| org | why |
| --- | --- |
| Carmichael RPD | the parsed rate did not reproduce the sheet's own card fee |
| Emeryville | per-transaction **minimum** model — `max(rate x amount, minimum)` per payment, which this report does not compute; period totals disagree — metabase 6547.72 vs sheet 6366.44 |
| Jeffersonville | per-transaction **minimum** model — `max(rate x amount, minimum)` per payment, which this report does not compute |
| Malibu | period totals disagree — metabase 17208.13 vs sheet 17148.41 |
| Midland | the parsed rate did not reproduce the sheet's own card fee; refund rate (3.50%) differs from the card rate (3.20%), which the model cannot express |
| Niagara Falls | period totals disagree — metabase 71.99 vs sheet 23368.50 |
| San Francisco Rec & Park | the attachment on its Airtable record is not a remittance sheet |
| Sebastopol Community Cultural Center | per-transaction **minimum** model — `max(rate x amount, minimum)` per payment, which this report does not compute |
| St. Charles Park District | no rec.us organization in the features snapshot |
| Taylor | per-transaction **minimum** model — `max(rate x amount, minimum)` per payment, which this report does not compute |
| Torrance | period totals disagree — metabase 60438.12 vs sheet 52476.82 |

### The two fee models

Most orgs are **rate + a fixed fee per payment**. Four — Emeryville,
Jeffersonville, Sebastopol and Taylor — are **rate with a per-transaction
minimum**, labelled `Transaction minimum` on their sheets. Supporting them means
charging `max(rate x amount, minimum)` per payment rather than on the period
total, which needs per-transaction card amounts the calculator already has —
so it is a real but small change, not a blocker.

### Known data problems in Airtable

- **Niagara Falls** — the workbook attached to its remittance record is San
  Francisco's (the header reads `501 Stanyan Street`). Niagara therefore has no
  schedule on file and keeps placeholder rates marked `test`, which stamp the
  workbook and its filename `_DRAFT`.
- **San Francisco Rec & Park** — its own latest attachment is a "Lessons Payout"
  sheet with no fee block.
- **St. Charles Park District** — no matching organization in the features
  snapshot, so there is no UUID to key a schedule on.

### Address and timezone

Both are read from the same sheet and are **display only** — they are the two
header lines and the timezone caption. Nine orgs use an older sheet layout that
carries neither, so their header lines are blank; no figure is affected.

### Where this is going

The intended home for these is Airtable, so new orgs can be priced before they
have a remittance history. This map is the interim, and it is the shape those
fields should take: card rate, card fixed fee, cash rate, check rate, technology
rate, whether the card fee is charged again on refunds, and the rec.us org UUID.
