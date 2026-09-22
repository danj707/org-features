/**
 * Remittance — per-org finance exports, one billing period at a time.
 *
 * Finance re-ran the product's "Item Log" and "Transaction Log" exports by hand
 * once per billing period, for every org. This module turns both into reports:
 * pick an ending remittance date, then click any org's date to download its CSV.
 *
 * Two reports, same billing period, one column each on /ps/remittance:
 *   itemlog — one row per order-item transaction (the line-item detail)
 *   txnlog  — one row per transaction event (cart totals + payment-method split)
 * They reconcile: Chico's 1,180 item-log lines for 2026-08-08 → 2026-08-15 roll
 * up to exactly the 630 transactions in that period's transaction log.
 *
 * Routes (both behind auth — this is fleet-wide finance data):
 *   GET /api/remittance      → periods + orgs + per-report config state
 *   GET /api/remittance/csv  → one log as CSV (?org=<uuid>&end=<date>&report=<key>)
 *   GET /api/remittance/xlsx → the whole remittance workbook (?org=<uuid>&end=<date>)
 *
 * Data source: shared, org-parameterized Metabase public cards reading the
 * materialized.item_log_report / materialized.transaction_report views. Unlike
 * the adoption snapshot these are fetched live per request — a transaction log
 * must not be served from a day-old bake.
 *
 * Both CSVs are drop-in replacements for the product's own exports: same
 * columns, same order, same value formatting, same rows. Each was validated
 * against a real manual export (Chico, 2026-08-08 → 2026-08-15) — the item log
 * matched 1,180 rows and every total, the transaction log matched 630 rows and
 * all 24 columns by checksum. The cards' SQL carries the non-obvious rules that
 * make that true (see each file's header), so don't reformat values here.
 *
 * One deliberate difference: rows sharing the same timestamp can come out in a
 * different sequence than the product's export. The product has no tie-break,
 * so its own order isn't reproducible run to run; the cards sort deterministically
 * within a timestamp so the same period always exports identically. Row content
 * is unaffected.
 */

const fs   = require("fs");
const path = require("path");

const METABASE_URL = process.env.METABASE_URL || "https://rec.metabaseapp.com";

// Public sharing UUIDs of the shared Metabase cards. Not secrets — they're
// public links — so they live in code, with env overrides for pointing at a
// replacement card without a deploy. An empty UUID ⇒ that report renders an
// explicit "not connected" state rather than failing.
//   card 19900 — "✅ Item Log Report"
//   card 19933 — "✅ Transaction Log Report"
const ITEM_LOG_UUID        = process.env.ITEM_LOG_UUID        || "4e02f94d-3658-4c67-b371-41dbbc677831";
const TRANSACTION_LOG_UUID = process.env.TRANSACTION_LOG_UUID || "8198df2f-b4c6-4ee5-ac67-4e86cd8abd4c";

// The reports offered per org, in column order on the dashboard.
const REPORTS = {
  itemlog: { key: "itemlog", label: "Item log",        file: "item-log",        uuid: ITEM_LOG_UUID },
  txnlog:  { key: "txnlog",  label: "Transaction log", file: "transaction-log", uuid: TRANSACTION_LOG_UUID },
};
const DEFAULT_REPORT = "itemlog";

// The generated remittance workbook (Summary + both logs), which is the sheet
// finance builds by hand today. Composition lives in lib/; this file only
// decides which orgs get one and on what fee schedule.
const workbook = require("./lib/remittance-workbook");

/**
 * Per-org fee schedule, keyed by the rec.us organization UUID — NEVER by slug
 * or name. Two orgs here are called Pleasant Hill and three are called some
 * form of San Francisco; the UUID is the only stable key, and billing the
 * wrong org's rates is the worst outcome this file has.
 *
 *   cardRateBps / cardFixedCents  what Rec charges per card payment
 *   cashRateBps / checkRateBps    what Rec charges on money it never touched
 *   techRateBps                   the technology fee, a percentage of TOTAL
 *                                 sales across every tender. ABSENT MEANS THE
 *                                 ORG HAS NONE and the section is left out —
 *                                 a zero row would assert a fee that is not in
 *                                 their contract, and it comes straight off the
 *                                 remittance total.
 *   chargeFeeOnRefunds            whether the card fee is billed again on
 *                                 refunded volume. The existing sheet totals
 *                                 its refund lines into "Total Rec Fee", so
 *                                 that is what this reproduces.
 *   address1 / address2           the two header lines, VERBATIM. Finance
 *                                 breaks the address at a different comma for
 *                                 different orgs, so this is two literal lines
 *                                 rather than one string split by rule.
 *   timezone                      config.general.primaryTimezone. The org list
 *                                 this report is built on carries only names
 *                                 and ids, so these live here with the rates.
 *   rateSource                    where the numbers came from. "remittance"
 *                                 means READ OUT OF THAT ORG'S OWN MOST RECENT
 *                                 REMITTANCE SHEET and checked (see below);
 *                                 "test" is a placeholder and stamps the
 *                                 workbook and its filename as a draft.
 *
 * WHERE THE RATES COME FROM, AND WHY THEY ARE NOT A GUESS. Every remittance
 * finance has ever sent states that org's own schedule in its Rec Payment
 * Processing Costs block — "Variable fee per payment", "Fixed fee per payment",
 * "Rec Cash Fee", "Rec Check Fee", "Technology Fees" — so the schedule is read
 * off the sheet rather than inferred. An earlier note here said the rates were
 * "not derivable"; that was wrong, and it is corrected rather than deleted,
 * because it is the sentence that stopped anyone looking.
 *
 * EVERY ENTRY CLEARED TWO CHECKS, AND BOTH ARE NEEDED. The rate has to
 * reproduce that sheet's own card fee from that sheet's own card total and
 * payment count; and the org UUID has to reproduce that sheet's card total
 * from LIVE Metabase over the same period. The first proves the rate was read
 * correctly, the second proves it is bolted to the right organisation — a
 * right rate on the wrong org is the failure this file exists to prevent, and
 * it is invisible in a diff. Pleasant Hill was settled exactly that way: two
 * orgs carry that name, and only one returns the sheet's own 14 transactions.
 *
 * THIS MAP IS THE **STANDARD** TEMPLATE ONLY — rate + fixed fee per card
 * payment, plus a flat rate on cash and cheque. Three other shapes exist on
 * real sheets, and each is a separate template to be flagged per org in
 * Airtable rather than a variation to be squeezed in here:
 *
 *   a per-transaction MINIMUM — max(rate x amount, minimum) per payment
 *     ("Transaction minimum"): Emeryville, Jeffersonville, Sebastopol, Taylor.
 *     Different arithmetic, not a different number.
 *   a TECHNOLOGY FEE — a percentage of total sales across every tender, taken
 *     off the remittance BELOW "Total Rec Fee": eight orgs. lib/ can draw that
 *     line, but see the next paragraph for why none of them is here.
 *   TICKET SERVICE FEES — "Net Ticket Service Fees", which this report does
 *     not compute at all: ten orgs, only one of them non-zero today.
 *
 * A ZERO TODAY IS NOT A ZERO FOREVER, which is why the nine orgs whose ticket
 * line currently reads $0.00 are held back with the one that does not. The
 * money is identical this period; the failure is next period, when the line
 * moves and a workbook that cannot express it under-bills silently.
 *
 * AND THE TECHNOLOGY FEE WAS NEVER VERIFIED, unlike every rate that is here.
 * The rate check reproduced each sheet's "Total Rec Fee" — and the technology
 * fee sits OUTSIDE that total, so it was read off the sheet and checked
 * against nothing. Two orgs proved the point: Prescott Valley and The Dance
 * Palace label it "Technology Fee" where the rest write "Net Technology Fee",
 * so they parsed as having none and would have shipped billing $0 against a
 * real $86.36 and $8.95. A component no check covers does not ship.
 *
 * AN ORG THAT IS NOT IN THIS MAP GETS NO BUTTON — not a button that guesses.
 * The held-back orgs and the reason for each are in docs/remittance-rates.md.
 */
const REMITTANCE_FEES = {
  // Belton — city-of-belton
  "86cb6718-c7a4-4639-9f8b-1495f0dc9969": {
    timezone: "America/Chicago",
    address1: "333 Water Street",
    address2: "Belton, Texas 76513",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 250,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Danvers, MA — town-of-danvers
  "a6aef5df-f742-41a2-9088-1fb6d48c3cb1": {
    timezone: "America/New_York",
    address1: "1 Sylvan Street, Danvers",
    address2: "Danvers, MA 01923, USA",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 100, checkRateBps: 100,
    techRateBps: 100,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Easton — city-of-easton
  "f4338fa8-009b-49eb-9a2b-16ca4688694a": {
    timezone: "",
    address1: "Remittance Period Start",
    address2: "Remittance Period End",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 500,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Euclid — city-of-euclid
  "2a118b52-99af-42f3-9727-d9b46b8d31e4": {
    timezone: "America/New_York",
    address1: "585 East 222nd St",
    address2: "Euclid, OH 44123",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 100,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Watertown, MA — watertown
  "d781690b-c5a0-43c5-8443-9ae43899528c": {
    timezone: "",
    address1: "Remittance Period Start",
    address2: "Remittance Period End",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 125,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Windham, ME — town-of-windham
  "1c80a358-74c2-477d-aa0b-87bb2d0514b3": {
    timezone: "",
    address1: "Remittance Period Start",
    address2: "Remittance Period End",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 100, checkRateBps: 100,
    techRateBps: 100,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Apex Park and Recreation District — apex-park-and-recreation-district
  "aeba47d0-c97f-49cb-a0e9-93c5af3a68fa": {
    timezone: "America/Denver",
    address1: "13150 W. 72nd Avenue",
    address2: "Arvada, CO 80005, USA",
    cardRateBps: 290, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Battle Ground — city-of-battle-ground
  "b715f06b-920a-4562-ae7f-7df1477626c2": {
    timezone: "America/Los_Angeles",
    address1: "109 SW 1st Street",
    address2: "Battle Ground, WA 98604",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 100, checkRateBps: 100,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Buffalo — city-of-buffalo
  "5aef2fa7-2999-45ed-afc7-0b884196e426": {
    timezone: "America/Chicago",
    address1: "212 Central Avenue",
    address2: "Buffalo, Minnesota 55313",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Central Point — central-point-recreation
  "449ce3cc-b071-4c6e-b474-d6591d32f617": {
    timezone: "America/Los_Angeles",
    address1: "235 S Haskell St",
    address2: "Central Point, OR  97502",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Chico Recreation District — chicorec
  "de370d91-868b-4f7b-bf23-3694749661a5": {
    timezone: "America/Los_Angeles",
    address1: "545 Vallombrosa Avenue",
    address2: "Chico, CA 95926",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: false,
    rateSource: "remittance",
  },
  // City of Madison, IN — city-of-madison
  "14e26ada-ac6c-48ec-ad75-0590daaa4d71": {
    timezone: "America/New_York",
    address1: "101 West Main Street",
    address2: "Madison, IN 47250",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 100, checkRateBps: 100,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // City of West Haven, CT — city-of-west-haven
  "83006fa1-fdaf-4f47-a4e1-a184e15f3527": {
    timezone: "",
    address1: "Remittance Period Start",
    address2: "Remittance Period End",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 100, checkRateBps: 100,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Clarkstown — town-of-clarkstown
  "5dee565a-6012-4b4f-a325-0aea81674364": {
    timezone: "America/New_York",
    address1: "10 Maple Ave",
    address2: "New City, NY 10956",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Clarksville, IN — town-of-clarksville
  "460566d3-3a51-4387-a7a0-0b010923e40d": {
    timezone: "America/New_York",
    address1: "2000 Broadway Street",
    address2: "Clarksville, IN 47129",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Douglas County, NV — douglas-county-nv
  "0312ebc8-40de-4fc8-a737-8afa26334e13": {
    timezone: "America/Los_Angeles",
    address1: "1329 Waterloo Lane",
    address2: "Gardnerville, Nevada 89410",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // El Segundo — el-segundo-recreation
  "8ae77057-6bce-4c20-b0f2-366ed5fa14dd": {
    timezone: "America/Los_Angeles",
    address1: "401 Sheldon Street",
    address2: "El Segundo, CA 90245",
    cardRateBps: 325, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Essex Junction — essex-junction
  "2e622a3e-80e1-4911-b722-81929ca27056": {
    timezone: "America/New_York",
    address1: "75 Maple Street",
    address2: "Junction, VT 05452",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Hermosa Beach — city-of-hermosa-beach
  "8890d2c8-329a-48a9-972b-872435bd5fa6": {
    timezone: "America/Los_Angeles",
    address1: "710 Pier Avenue",
    address2: "Hermosa Beach, CA 90254",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 100, checkRateBps: 100,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Joplin — city-of-joplin
  "ac04aa52-d629-435f-84af-0fc95e152e7b": {
    timezone: "America/Chicago",
    address1: "3301 W. 1st Street",
    address2: "Joplin, MO 64801",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Jurupa Area Recreation & Park District — jurupa-area-recreation-and-park-district
  "1f1b6f1d-d0c4-4912-b4a2-077d1786ab20": {
    timezone: "America/Los_Angeles",
    address1: "8621 Jurupa Rd",
    address2: "Jurupa, California 92509",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Lake County, CA — lake-county
  "ef946698-1e71-4159-b814-f89df3d2e7d4": {
    timezone: "",
    address1: "Remittance Period Start",
    address2: "Remittance Period End",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 100, checkRateBps: 100,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Lakeland — city-of-lakeland
  "f2f03a2b-82b8-4cd6-be40-ae94aea6480b": {
    timezone: "America/Chicago",
    address1: "101 West Main Street",
    address2: "Lakeland, TN 38002",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Lewisburg — city-of-lewisburg
  "ff965a2b-7746-4de9-8b41-402927cb5879": {
    timezone: "",
    address1: "Remittance Period Start",
    address2: "Remittance Period End",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Littleton — littleton
  "992ee322-4927-4558-827d-7f8768580b85": {
    timezone: "America/New_York",
    address1: "41 Shattuck Street",
    address2: "Littleton, MA 01460",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Mashantucket Pequot Tribal Nation — mashantucket-pequot-tribal-nation
  "c193567f-9503-4635-a134-f72b5db556b6": {
    timezone: "",
    address1: "Remittance Period Start",
    address2: "Remittance Period End",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 100, checkRateBps: 100,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Menifee — city-of-menifee
  "bc94a100-8adb-4303-90cb-7c4714c22751": {
    timezone: "America/Los_Angeles",
    address1: "29844 Haun Road",
    address2: "Menifee, CA 92586, USA",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 100, checkRateBps: 100,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Natchez, MS — city-of-natchez
  "f64a9263-0fe8-4f90-8015-67b23c546e14": {
    timezone: "",
    address1: "Remittance Period Start",
    address2: "Remittance Period End",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 100, checkRateBps: 100,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Needham — needham
  "9e6de746-5935-4c47-855d-0f50b02bfe7e": {
    timezone: "America/New_York",
    address1: "178 Rosemary Street",
    address2: "Needham, MA 02492",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Paradise RPD — paradise-recreation-and-park-district
  "f395300e-2edf-42f3-ba24-bebbceb1fa33": {
    timezone: "America/Los_Angeles",
    address1: "6626 Skyway",
    address2: "Paradise, CA 95969",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Piedmont — city-of-piedmont
  "5aa9686e-f5f7-49af-bf2d-3be6f6257013": {
    timezone: "America/Los_Angeles",
    address1: "120 Vista Avenue",
    address2: "Piedmont, CA 94611",
    cardRateBps: 300, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Pleasant Hill, MO — pleasant-hill
  "52efcded-a5e8-4dbf-8a45-100f70170de0": {
    timezone: "America/Chicago",
    address1: "203 Paul St.",
    address2: "Pleasant Hill, MO 64080",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 100, checkRateBps: 100,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Pueblo County — pueblo-county
  "5b5a3779-da76-4b83-9229-17de9c525dc0": {
    timezone: "America/Denver",
    address1: "215 W. 10th Street",
    address2: "Pueblo, Colorado 81003",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 100, checkRateBps: 100,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Putnam County, FL — putnam-county
  "fe152712-f0bf-41df-892f-5edad45d9168": {
    timezone: "America/New_York",
    address1: "2509 Crill Avenue",
    address2: "Palatka, Florida 32177",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 100, checkRateBps: 100,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Reading — town-of-reading
  "8f24ee66-e9a6-40a4-afbb-27efe8ef64d5": {
    timezone: "America/New_York",
    address1: "16 Lowell Street",
    address2: "Reading, MA 01867",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Sacramento County — sacramento-county
  "90cab301-360d-4c01-9a88-0a67ecd6a9d2": {
    timezone: "America/Los_Angeles",
    address1: "1110 West Capitol Ave",
    address2: "West Sacramento, CA 95691",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // The Ranch — the-ranch
  "2d147f38-068c-409e-890d-a8acc88d8079": {
    timezone: "America/Los_Angeles",
    address1: "600 Ned’s Way",
    address2: "Tiburon, CA 94920",
    cardRateBps: 310, cardFixedCents: 30,
    cashRateBps: 100, checkRateBps: 100,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // Tullahoma — city-of-tullahoma
  "bc7afe82-0054-4bed-b77d-787a79a9018e": {
    timezone: "America/Chicago",
    address1: "201 West Grundy Street",
    address2: "Tullahoma, TN 37388",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 0, checkRateBps: 0,
    techRateBps: 0,
    chargeFeeOnRefunds: true,
    rateSource: "remittance",
  },
  // City of Niagara Falls — PLACEHOLDER, and the one draft entry. The sheet
  // filed against Niagara in Airtable is San Francisco's (its header reads
  // 501 Stanyan Street), so no Niagara schedule is on file.
  "a976a11a-5303-4785-838a-1b281ca77678": {
    timezone: "America/New_York",   // organization.config general.primaryTimezone
    address1: "123 Niagara Falls lane",   // organization.address
    address2: " Niagara Falls, 45336",
    cardRateBps: 350, cardFixedCents: 30,
    cashRateBps: 100, checkRateBps: 100,
    techRateBps: 100,
    chargeFeeOnRefunds: true,
    rateSource: "test",
  },
};

function feesFor(orgId) { return REMITTANCE_FEES[orgId] || null; }

/* ── emailing a remittance ────────────────────────────────────────────────── */

// WHO GETS IT IS A PLACEHOLDER, and deliberately a visible one. Finance
// contacts live per organization in Airtable; until this reads them, every
// remittance goes to the same three people whatever org it is for, which is
// fine for testing and would be wrong the moment a real one is sent to a city.
// REMITTANCE_EMAIL_TO overrides it, so a preview or a local boot can be pointed
// somewhere harmless without editing code.
const REMITTANCE_DEFAULT_TO = ["dan@rec.us", "jennel@rec.us", "lindsay@rec.us"];
function remittanceRecipients() {
  const raw = String(process.env.REMITTANCE_EMAIL_TO || "").trim();
  if (!raw) return REMITTANCE_DEFAULT_TO.slice();
  // A malformed override must not fall back to the real three — that would mail
  // a typo's worth of people the thing it was set to keep away from them.
  return raw.split(/[,;\s]+/).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
}

const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = `${process.env.FROM_NAME || "Rec Finance"} <${process.env.FROM_EMAIL || "reports@rec.us"}>`;

const esc = (s) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// The body carries the period and the total, so a recipient can tell at a
// glance whether the attachment is the one they were expecting without opening
// it — and so a remittance built on PLACEHOLDER rates says so in the message
// as well as in the filename. A file gets forwarded on its own.
function remittanceEmailHtml({ org, period, total, name, draft }) {
  return `<div style="font-family:system-ui,-apple-system,sans-serif;max-width:560px;margin:0 auto;padding:28px 24px;color:#111">
  <h2 style="margin:0 0 4px;font-size:19px">${esc(org.displayName || org.name)} — remittance</h2>
  <p style="margin:0 0 20px;color:#666;font-size:14px">${esc(period.label || (period.start + " – " + period.end))}</p>
  ${draft ? `<p style="margin:0 0 20px;padding:10px 12px;border-left:3px solid #b45309;background:#fffbeb;font-size:13.5px;line-height:1.5;color:#7c2d12">
    <strong>Draft.</strong> This organization is on placeholder rates, so the totals below are
    for shaping the report and are not what Rec billed.</p>` : ""}
  <table style="border-collapse:collapse;font-size:14px;margin:0 0 20px">
    <tr><td style="padding:3px 16px 3px 0;color:#666">Period</td><td style="padding:3px 0"><strong>${esc(period.start)} → ${esc(period.end)}</strong></td></tr>
    <tr><td style="padding:3px 16px 3px 0;color:#666">Total remittance</td><td style="padding:3px 0"><strong>$${esc(total)}</strong></td></tr>
    <tr><td style="padding:3px 16px 3px 0;color:#666">Attached</td><td style="padding:3px 0">${esc(name)}</td></tr>
  </table>
  <p style="margin:0;color:#888;font-size:12.5px;line-height:1.5">
    Summary, transaction log and item log are the three tabs of the attached workbook.
    Generated from the CX dashboard.</p>
</div>`;
}

async function sendRemittanceEmail({ to, org, period, name, buffer, total, draft }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: RESEND_FROM,
      to,
      subject: `${draft ? "[DRAFT] " : ""}${org.displayName || org.name} remittance — `
             + `${period.start} to ${period.end} — $${total}`,
      html: remittanceEmailHtml({ org, period, total, name, draft }),
      attachments: [{ filename: name, content: Buffer.from(buffer).toString("base64") }],
    }),
    signal: AbortSignal.timeout(60000),
  });
  // Resend answers 200 with an error object on some failures, so the status
  // alone is not the verdict.
  const out = await r.json().catch(() => ({}));
  if (!r.ok || out.error) {
    throw new Error(`resend ${r.status} ${JSON.stringify(out.error || out).slice(0, 160)}`);
  }
  return out;
}

// A schedule read out of that org's own last remittance and checked against it
// is not a draft — it is the rate Rec actually billed. Only a placeholder is.
// Testing "not contracted" instead would stamp DRAFT on 48 verified schedules,
// and a report that calls itself a draft is one finance will not send.
function ratesAreDraft(fees) { return !fees || fees.rateSource === "test"; }

// Metabase's own query timeout is the real ceiling; this just stops a hung
// socket from holding the response open forever.
const FETCH_TIMEOUT_MS = Number(process.env.ITEM_LOG_TIMEOUT_MS || 120000);

// The report starts here: 2026-08-15 is the first ending remittance date it
// covers. Earlier 2026 periods are in the schedule file for completeness but
// predate the report, so they aren't offered.
const FIRST_PERIOD_END = "2026-08-15";

// Column order of each product export. Only used as the header when a period
// has no rows at all, so finance still gets a well-formed file with the right
// shape instead of an empty one — what a period WITH rows carries is whatever
// the card sent, through workbook.logColumns.
//
// READ FROM THE WORKBOOK RATHER THAN RETYPED. The summary's formulas address
// these logs by column letter, so a second copy here that drifted by one column
// would not look wrong — it would just sum the wrong column.
const ITEM_LOG_COLUMNS = workbook.ITEM_COLUMNS;
const TRANSACTION_LOG_COLUMNS = workbook.TXN_COLUMNS;
REPORTS.itemlog.columns = ITEM_LOG_COLUMNS;
REPORTS.txnlog.columns  = TRANSACTION_LOG_COLUMNS;

let _schedule = null;

function loadSchedule(dataDir) {
  const candidates = [
    dataDir ? path.join(dataDir, "remittance-schedule.json") : null,
    path.join(__dirname, "data", "remittance-schedule.json"),
  ].filter(Boolean);
  for (const file of candidates) {
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* try next */ }
  }
  return { years: {} };
}

const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];
const iso = (y, m, d) => `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;

/**
 * Billing periods themselves are formulaic — 1-7, 8-15, 16-22, 23-EOM — so they
 * are GENERATED rather than read from the schedule file. Only the pay/ACH dates
 * need transcribing, and those get merged in below when we have them.
 *
 * That split is what makes each new period show up on its own: nothing has to
 * be added weekly, and when 2026's transcribed schedule runs out the report
 * keeps listing periods (with pay/ACH blank) instead of dead-ending.
 */
function generatePeriods(year) {
  const out = [];
  for (let m = 1; m <= 12; m++) {
    const eom = new Date(Date.UTC(year, m, 0)).getUTCDate();
    for (const [s, e] of [[1,7],[8,15],[16,22],[23,eom]]) {
      out.push({
        label: `${MONTHS[m-1]} ${s}-${e}`,
        start: iso(year, m, s),
        end:   iso(year, m, e),
        payBy: null, achStart: null, achEnd: null,
      });
    }
  }
  return out;
}

/**
 * Every period the report covers, oldest first: from FIRST_PERIOD_END up to and
 * including the one in progress today. Future periods are left out — there is
 * nothing to export from a period that hasn't started.
 */
function periods(today = new Date().toISOString().slice(0, 10)) {
  const firstYear = Number(FIRST_PERIOD_END.slice(0, 4));
  const thisYear  = Number(today.slice(0, 4));
  const byEnd = new Map();
  for (let y = firstYear; y <= thisYear; y++) {
    for (const p of generatePeriods(y)) byEnd.set(p.end, p);
  }
  // Merge the transcribed pay/ACH dates onto the generated periods.
  for (const list of Object.values((_schedule && _schedule.years) || {})) {
    for (const s of list) {
      const p = byEnd.get(s.end);
      if (p) Object.assign(p, { payBy: s.payBy, achStart: s.achStart, achEnd: s.achEnd, label: s.label || p.label });
    }
  }
  return [...byEnd.values()]
    .filter(p => p.end >= FIRST_PERIOD_END && p.start <= today)
    .sort((a, b) => a.end < b.end ? -1 : a.end > b.end ? 1 : 0);
}

function findPeriod(end) {
  return periods().find(p => p.end === end) || null;
}

/**
 * The period finance is working on right now: the most recent one that has
 * closed. A period is "closed" the day after its end date — Chico's 8-15
 * export was pulled on the 16th. Before the first covered period closes,
 * fall back to that first period so the page always has a selection.
 */
function currentPeriod(today = new Date().toISOString().slice(0, 10)) {
  const all = periods(today);
  const closed = all.filter(p => p.end < today);
  return closed.length ? closed[closed.length - 1] : (all[0] || null);
}

/**
 *   due      — closed, payment not yet issued (the export is needed now)
 *   paid     — payment date has passed; ACH may still be landing
 *   open     — period hasn't closed yet, so the data is still accumulating
 *
 * A period with no transcribed pay date can't be called due or paid, so it
 * stays "due" once closed — finance still needs the export either way.
 */
function periodStatus(p, today = new Date().toISOString().slice(0, 10)) {
  if (p.end >= today) return "open";
  if (!p.payBy) return "due";
  return p.payBy >= today ? "due" : "paid";
}

/**
 * Match the product export: every field quoted, quotes doubled, LF endings.
 * `fallbackColumns` is the header to use when there are no rows to infer it
 * from — pass the report's own columns so an empty period still exports with
 * the right shape.
 */
function rowsToCsv(rows, fallbackColumns) {
  // One rule, both exports: the CSV and the workbook have to agree about which
  // columns a period has, or the same period reads two ways depending on which
  // button finance pressed.
  const cols = workbook.logColumns(rows, fallbackColumns || ITEM_LOG_COLUMNS);
  const esc = (v) => `"${String(v === null || v === undefined ? "" : v).replace(/"/g, '""')}"`;
  const out = [cols.map(esc).join(",")];
  for (const row of rows) out.push(cols.map(c => esc(row[c])).join(","));
  return out.join("\n") + "\n";
}

// Parameter descriptors come from the card itself rather than being hardcoded.
// This matters: Metabase (v1.63) REJECTS a public card query whose parameters
// omit the card's parameter `id` — it 400s with a bare "An error occurred." in
// ~3ms, before running any SQL, and the same request with ids returns rows.
// Reading them from the card also means a retyped or renamed template tag is
// picked up automatically instead of silently breaking the export.
const _paramCache = new Map(); // uuid → { bySlug, fetchedAt }
const PARAM_CACHE_MS = 60 * 60 * 1000;

async function cardParams(report) {
  const hit = _paramCache.get(report.uuid);
  if (hit && (Date.now() - hit.fetchedAt) < PARAM_CACHE_MS) return hit.bySlug;

  const resp = await fetch(`${METABASE_URL}/api/public/card/${report.uuid}`,
                           { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) {
    throw new Error(`could not read the ${report.label} card (${resp.status}) — is its public link still enabled?`);
  }
  const card = await resp.json();
  const bySlug = {};
  for (const p of card.parameters || []) bySlug[p.slug] = p;
  for (const need of ["org_id", "start_date", "end_date"]) {
    if (!bySlug[need]) throw new Error(`the ${report.label} card has no "${need}" parameter`);
  }
  _paramCache.set(report.uuid, { bySlug, fetchedAt: Date.now() });
  return bySlug;
}

/** Fetch one org's report rows for one period straight from the public card. */
async function fetchReport(report, orgId, startDate, endDate) {
  const bySlug = await cardParams(report);
  const values = { org_id: orgId, start_date: startDate, end_date: endDate };
  const params = Object.keys(values).map(slug => ({
    id:     bySlug[slug].id,
    type:   bySlug[slug].type,
    target: bySlug[slug].target,
    value:  values[slug],
  }));

  const url = `${METABASE_URL}/api/public/card/${report.uuid}/query/json`
            + `?parameters=${encodeURIComponent(JSON.stringify(params))}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) {
    // Public endpoints deliberately sanitize errors to "An error occurred.",
    // so add the context that actually helps someone debug it.
    const body = (await resp.text()).slice(0, 200);
    throw new Error(`Metabase returned ${resp.status}: ${body}`
      + (resp.status === 400 ? " (card parameters rejected — check the card's template tags)" : ""));
  }
  const data = await resp.json();
  // A failed query can also come back as 200 with an {error} object.
  if (!Array.isArray(data)) throw new Error(String((data && data.error) || "unexpected Metabase response"));
  return data;
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "org";
}

// The workbook is named the way finance already names it —
// Danvers_Remittance_Report_-_20260908-20260915.xlsx — so a generated one files
// alongside the hand-built ones instead of sorting into its own group.
const compactDate = (iso) => String(iso).replace(/-/g, "");
function workbookFilename(org, period, { draft } = {}) {
  const name = String(org.displayName || org.name || org.slug || "org")
    .replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "") || "org";
  return `${name}_Remittance_Report_-_${compactDate(period.start)}-${compactDate(period.end)}`
       + `${draft ? "_DRAFT" : ""}.xlsx`;
}

function mount(app, { requireAuth, dataDir, loadOrgs }) {
  _schedule = loadSchedule(dataDir);

  app.get("/api/remittance", requireAuth, (_req, res) => {
    const today = new Date().toISOString().slice(0, 10);
    const cur = currentPeriod(today);
    res.setHeader("Cache-Control", "no-store");
    res.json({
      // Per-report so one unconfigured card doesn't disable the other column.
      reports: Object.values(REPORTS).map(r => ({ key: r.key, label: r.label, configured: !!r.uuid })),
      today,
      currentPeriodEnd: cur ? cur.end : null,
      // WHO an email would go to, so the confirm dialog can name them. This is
      // the only place the page can learn it, and a "send to three people"
      // button whose dialog cannot say which three is not a confirmation.
      // `emailReady` is false on a deploy with no Resend key, which is every
      // local boot — the button says so rather than failing on click.
      emailTo: remittanceRecipients(),
      emailReady: !!RESEND_API_KEY && remittanceRecipients().length > 0,
      // Newest first: the period that's due sits at the top of the menu and
      // flipping back to prior periods means going down the list.
      periods: periods(today)
        .map(p => ({ ...p, status: periodStatus(p, today) }))
        .reverse(),
      // The workbook needs a fee schedule, so the button is offered per org
      // rather than fleet-wide. Only whether one EXISTS travels to the browser
      // — the rates themselves are nobody's business outside this server.
      orgs: loadOrgs().map(o => {
        const f = feesFor(o.id);
        return f ? { ...o, remittance: true, remittanceDraft: ratesAreDraft(f) } : o;
      }),
    });
  });

  app.get("/api/remittance/csv", requireAuth, async (req, res) => {
    const orgId = String(req.query.org || "");
    const end   = String(req.query.end || "");
    const report = REPORTS[String(req.query.report || DEFAULT_REPORT)];

    if (!report) return res.status(400).type("text/plain").send(`Unknown report "${req.query.report}".`);
    if (!report.uuid) {
      return res.status(503).type("text/plain")
        .send(`${report.label} isn't connected yet — set the card's public-link UUID on the server.`);
    }
    const period = findPeriod(end);
    if (!period) return res.status(400).type("text/plain").send(`Unknown remittance period "${end}".`);

    const org = loadOrgs().find(o => o.id === orgId);
    if (!org) return res.status(404).type("text/plain").send("Unknown organization.");

    try {
      const rows = await fetchReport(report, org.id, period.start, period.end);
      const name = `${report.file}-${slugify(org.displayName || org.slug)}-${period.start}-to-${period.end}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
      res.setHeader("Cache-Control", "no-store");
      console.log(`[remittance] ${report.key} ${org.displayName} ${period.start}→${period.end}: ${rows.length} rows`);
      return res.send(rowsToCsv(rows, report.columns));
    } catch (err) {
      console.error(`[remittance] ${report.key} ${org.displayName} ${period.label} failed: ${err.message}`);
      return res.status(502).type("text/plain").send(`Could not build the ${report.label.toLowerCase()}: ${err.message}`);
    }
  });

  // The whole remittance as one workbook: the Summary finance types by hand,
  // over the two logs it is computed from. Both feeds are fetched IN PARALLEL —
  // they are independent queries against different cards, and serially this is
  // two cold Metabase reads with a person watching a spinner.
  // ONE BUILDER, TWO ROUTES. The download and the email must be the same file:
  // a second copy of this would drift the first time either changed, and the
  // failure is finance receiving a workbook that does not match the one whoever
  // sent it had checked. Refusals come back as a thrown `status` so both routes
  // answer the same way — the point of refusing here rather than in the route is
  // that neither can forget to.
  async function buildRemittance(orgId, end) {
    const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };

    const period = findPeriod(end);
    if (!period) fail(400, `Unknown remittance period "${end}".`);

    const org = loadOrgs().find(o => o.id === orgId);
    if (!org) fail(404, "Unknown organization.");

    const fees = feesFor(org.id);
    if (!fees) {
      fail(503, `No fee schedule on file for ${org.displayName}. The remittance total is computed from `
              + `that organization's own card, cash and check rates, so there is nothing to generate `
              + `until they are set — a guessed rate would produce a plausible wrong number.`);
    }
    for (const r of [REPORTS.itemlog, REPORTS.txnlog]) {
      if (!r.uuid) fail(503, `${r.label} isn't connected yet — the workbook needs both logs.`);
    }

    // Both feeds are fetched IN PARALLEL — they are independent queries against
    // different cards, and serially this is two cold Metabase reads with a
    // person watching a spinner.
    const [txns, items] = await Promise.all([
      fetchReport(REPORTS.txnlog,  org.id, period.start, period.end),
      fetchReport(REPORTS.itemlog, org.id, period.start, period.end),
    ]);
    const { buffer, summary } = workbook.generate({
      org: { name: org.name || org.displayName, slug: org.slug, timezone: fees.timezone || "",
             address1: fees.address1 || "", address2: fees.address2 || "" },
      period, txns, items, fees,
    });
    // The filename finance already uses:
    //   Danvers_Remittance_Report_-_20260908-20260915.xlsx
    // Placeholder rates are named in the filename as well as in the sheet —
    // a file gets forwarded on its own, without whoever downloaded it.
    const draft = ratesAreDraft(fees);
    return { org, period, fees, draft, buffer, summary, txns, items,
             name: workbookFilename(org, period, { draft }) };
  }

  // The whole remittance as one workbook: the Summary finance types by hand,
  // over the two logs it is computed from.
  app.get("/api/remittance/xlsx", requireAuth, async (req, res) => {
    let built;
    try {
      built = await buildRemittance(String(req.query.org || ""), String(req.query.end || ""));
    } catch (err) {
      if (err.status) return res.status(err.status).type("text/plain").send(err.message);
      console.error(`[remittance] workbook failed: ${err.message}`);
      return res.status(502).type("text/plain").send(`Could not build the remittance: ${err.message}`);
    }
    const { org, period, buffer, summary, name, txns, items } = built;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
    res.setHeader("Cache-Control", "no-store");
    console.log(`[remittance] workbook ${org.displayName} ${period.start}→${period.end}: `
      + `${txns.length} txns, ${items.length} items, total $${(summary.final.totalCents / 100).toFixed(2)}`);
    return res.send(buffer);
  });

  // Email the same workbook. POST, not GET: it sends mail, so it must not be
  // reachable by a prefetch, a crawler or a pasted link.
  app.post("/api/remittance/email", requireAuth, async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const to = remittanceRecipients();
    if (!to.length) {
      return res.status(503).json({ ok: false, error: "No remittance recipients configured." });
    }
    if (!RESEND_API_KEY) {
      return res.status(503).json({ ok: false,
        error: "RESEND_API_KEY is not set on this deploy, so nothing was sent." });
    }

    let built;
    try {
      built = await buildRemittance(String(body.org || ""), String(body.end || ""));
    } catch (err) {
      if (err.status) return res.status(err.status).json({ ok: false, error: err.message });
      console.error(`[remittance] email build failed: ${err.message}`);
      return res.status(502).json({ ok: false, error: `Could not build the remittance: ${err.message}` });
    }

    const { org, period, buffer, summary, name, draft } = built;
    const total = (summary.final.totalCents / 100).toFixed(2);
    try {
      await sendRemittanceEmail({ to, org, period, name, buffer, total, draft });
    } catch (err) {
      // Never echo the provider's body: a Resend error can quote the key back,
      // and this string is rendered straight into the page.
      console.error(`[remittance] email ${org.displayName} ${period.label} failed: ${err.message}`);
      return res.status(502).json({ ok: false, error: "The remittance built, but sending it failed." });
    }
    console.log(`[remittance] emailed ${org.displayName} ${period.start}→${period.end} `
      + `($${total}${draft ? ", DRAFT" : ""}) to ${to.join(", ")}`);
    return res.json({ ok: true, to, file: name, total, draft });
  });
}

module.exports = {
  mount, rowsToCsv, periods, currentPeriod, periodStatus,
  ITEM_LOG_COLUMNS, TRANSACTION_LOG_COLUMNS, REPORTS,
  REMITTANCE_FEES, feesFor, ratesAreDraft, workbookFilename, remittanceRecipients,
};
