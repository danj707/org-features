#!/usr/bin/env node
"use strict";
/**
 * THE GENERATED REMITTANCE HAS TO BE THE SHEET FINANCE ALREADY BUILDS.
 *
 * Four claims, and they need four different kinds of evidence:
 *
 *   1. THE NUMBERS MATCH A SHEET THIS CODE NEVER SAW. Finance hand-built
 *      Pleasant Hill's 2026-09-08 → 2026-09-15 remittance in a Google Sheet.
 *      Every line of it is asserted here against the generator, run over that
 *      period's real card output — committed as a fixture so this runs in CI
 *      with no Metabase access. If the generator and that sheet ever disagree,
 *      one of them is wrong and nobody would otherwise find out.
 *   2. THE LAYOUT MATCHES IT TOO. Same four columns, same row positions, same
 *      label text. A generated sheet and a hand-built one get put side by side;
 *      a tidied-up layout fails that comparison however right the numbers are.
 *   3. THE ARITHMETIC IS LIFTED AND RUN, not regexed. Every defect in here is
 *      a comparison or a rounding step, and source reads identically either way.
 *   4. THE FILE IS A REAL WORKBOOK. The writer is hand-rolled over zlib, so the
 *      zip is opened back up and its parts are checked — "it produced bytes" is
 *      not the claim.
 *
 * Niagara Falls is the second fixture on purpose: Pleasant Hill's period has no
 * refunds, no scholarships, no account credit and no ticket service fee, so on
 * that org alone half the summary is a column of zeros that cannot be wrong.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const wb = require(path.join(ROOT, "lib", "remittance-workbook.js"));
const { S } = require(path.join(ROOT, "lib", "xlsx.js"));
const remittance = require(path.join(ROOT, "remittance.js"));

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "remittance-period.json"), "utf8"));
const PERIOD = FIX.period;
const PH = FIX.orgs["pleasant-hill"];
const NF = FIX.orgs["city-of-niagara-falls"];

// Pleasant Hill's sheet was built at these rates, and everything under its
// "Rec Payment Processing Costs" block totals into "Total Rec Fee".
const FEES = { cardRateBps: 350, cardFixedCents: 30, cashRateBps: 100, checkRateBps: 100,
               chargeFeeOnRefunds: true, rateSource: "contracted" };

let pass = 0;
const failures = [];
const pending = [];
/**
 * A failing mutation must fail BY NAME. Two things get in the way and both have
 * bitten this file: an assertion whose arguments throw while being evaluated
 * kills the run before any name is printed, and an async check thrown into a
 * synchronous runner reports success because nothing waited for it.
 *   ok()  takes a thunk, and collects a returned promise so the report waits.
 *   val() is how anything that might be missing gets read.
 */
function ok(name, fn) {
  let out;
  try { out = fn(); }
  catch (err) { failures.push(`${name}: ${err.message}`); return; }
  if (out && typeof out.then === "function") {
    pending.push(out.then(() => { pass++; }, (err) => { failures.push(`${name}: ${err.message}`); }));
    return;
  }
  pass++;
}
const eq = (name, got, want) => ok(name, () => assert.strictEqual(
  typeof got === "function" ? got() : got, want));
// Read through this rather than chaining off a .find() — a mutation that drops
// the row makes the chain throw, and a spec that dies has told nobody what broke.
const val = (fn, dflt = null) => { try { const v = fn(); return v === undefined ? dflt : v; } catch { return dflt; } };
const money = (c) => (c / 100).toFixed(2);

/* ── 1 · the numbers, against the hand-built sheet ───────────────────────── */

const ph = wb.summarize({ txns: PH.txns, items: PH.items, fees: FEES });

eq("PH · Total Sales Transactions",  ph.sales.txnCount,        14);
eq("PH · Items Sold",                ph.sales.itemCount,       20);
eq("PH · Total Value of Items Sold", money(ph.sales.itemsCents),  "590.00");
eq("PH · Taxes",                     money(ph.sales.taxCents),    "0.00");
eq("PH · Processing Fees",           money(ph.sales.feeCents),    "20.70");
eq("PH · Total Sales",               money(ph.sales.totalCents),  "610.70");
eq("PH · Total Refund Transactions", ph.refunds.txnCount,      0);
eq("PH · Items Refunded",            ph.refunds.itemCount,     0);
eq("PH · Total Refunds",             money(ph.refunds.totalCents), "0.00");

const phTender = (k) => ph.revenue.rows.find(r => r.key === k);
eq("PH · Credit Card payments",  () => val(() => phTender("Credit Card").count),           14);
eq("PH · Credit Card paid",      () => money(val(() => phTender("Credit Card").cents, NaN)), "610.70");
eq("PH · Cash paid",             () => money(val(() => phTender("Cash").cents, NaN)),        "0.00");
eq("PH · Revenue - Real Money",  money(ph.revenue.realCents),          "610.70");
eq("PH · Revenue - Credits etc", money(ph.revenue.creditCents),        "0.00");

eq("PH · variable fee 3.50%",  money(ph.cost.cardVarCents),   "21.37");
eq("PH · fixed fee $0.30 x14", money(ph.cost.cardFixedCents),  "4.20");
eq("PH · Total Rec Fee",       money(ph.cost.totalCents),     "25.57");
eq("PH · Card Revenue Collected", money(ph.final.cardRevenueCents), "610.70");
eq("PH · Net Card Refunds",       money(ph.final.cardRefundCents),  "0.00");
eq("PH · FINAL REMITTANCE",       money(ph.final.totalCents),       "585.13");

/* ── 2 · the layout, against the same sheet ──────────────────────────────── */

// Row positions are 1-based, as the spreadsheet numbers them. Column B holds
// the label; A is the gutter the hand-built sheet leaves empty.
const phSheet = wb.summarySheet(
  { name: PH.name, timezone: PH.timezone, address1: PH.address1, address2: PH.address2 },
  PERIOD, ph);
const cell = (sheet, row, col) => {
  const c = (sheet.rows[row - 1] || [])[col];
  return c && typeof c === "object" ? c.v : (c === undefined ? null : c);
};
const label = (row) => cell(phSheet, row, 1);

eq("PH layout · column A stays empty", phSheet.rows.every(r => !r.length || r[0] === null || r[0] === undefined), true);
eq("PH layout · four columns", phSheet.widths.length, 4);

const LAYOUT = [
  [3,  null], [4, PH.name], [5, PH.address1], [6, PH.address2],
  [8,  "Sales Summary"],
  [9,  "Total Sales Transactions"], [10, "Items Sold"], [11, "Total Value of Items Sold"],
  [12, "Taxes"], [13, "Processing Fees"], [14, "Total Sales"],
  [16, "Refunds Summary"],
  [17, "Total Refund Transactions"], [18, "Items Refunded"], [19, "Total Value of Items Refunded"],
  [20, "Taxes"], [21, "Processing Fees"], [22, "Total Refunds"],
  [24, "Total Revenue by Payment Method"], [25, "Method"],
  [26, "Account Credit"], [27, "Scholarship"], [28, "Gift Card"],
  [29, "Credit Card"], [30, "Cash"], [31, "Check"], [32, "Total Sales"],
  [33, "         Revenue - Real Money"],
  [34, "         Revenue - Credits, Scholarships, Gift Cards Applied"],
  [36, "Refunds by Payment Method"], [37, "Method"],
  // Five methods here where Revenue lists six — the hand-built sheet has no
  // Gift Card row in its refunds table, and that is reproduced rather than
  // "fixed", or the two sheets stop lining up row for row.
  [38, "Account Credit"], [39, "Scholarship"], [40, "Credit Card"], [41, "Cash"], [42, "Check"],
  [43, "Total Refunds"],
  [44, "         Refunds - Real Money"], [45, "         Refunds - Credits"],
  [48, "Rec Payment Processing Costs"], [49, "Method"],
  [50, "Credit Card Transactions"], [51, "Variable fee per payment"], [52, "Fixed fee per payment"],
  [53, "Credit Card Refunds"],       [54, "Variable fee per payment"], [55, "Fixed fee per payment"],
  [56, "Cash Transactions"],  [57, "Rec Cash Fee"],
  [58, "Check Transactions"], [59, "Rec Check Fee"],
  [60, "Total Rec Fee"],
  [62, "Final Remittance"], [63, "Credit Card Revenue Collected by Rec"],
  [64, "         Net Rec Payment Processing Costs"], [65, "         Net Card Refunds"],
  [66, "Total"],
];
for (const [row, want] of LAYOUT) eq(`PH layout · row ${row}`, label(row), want);
eq("PH layout · nothing past row 66", phSheet.rows.length, 66);
eq("PH layout · title in column D", cell(phSheet, 3, 3), "Remittance Report");
eq("PH layout · period in column D", cell(phSheet, 4, 3), "September 8, 2026 - September 15, 2026");
eq("PH layout · timezone in column D", cell(phSheet, 5, 3), "Timezone: America/Chicago");
eq("PH layout · rate in column C", cell(phSheet, 51, 2), 0.035);
eq("PH layout · base in column D", money(cell(phSheet, 51, 3) * 100), "610.70");
eq("PH layout · block total in D", money(cell(phSheet, 52, 3) * 100), "25.57");
eq("PH layout · final total in D", money(cell(phSheet, 66, 3) * 100), "585.13");

// Two blank rows before the processing block, as the sheet has them.
eq("PH layout · blank row 46", (phSheet.rows[45] || []).length, 0);
eq("PH layout · blank row 47", (phSheet.rows[46] || []).length, 0);

/* ── 3 · the states Pleasant Hill's period cannot exercise ───────────────── */

const nf = wb.summarize({ txns: NF.txns, items: NF.items, fees: FEES });

// These three identities are what say the summary reads the feed correctly.
// Each is computed two different ways from the same rows; a column read from
// the wrong field breaks one of them.
eq("NF tie · items + tax + ticket = cart sub-total",
  money(nf.sales.itemsCents + nf.sales.taxCents + nf.sales.ticketCents),
  money(NF.txns.filter(r => r.Type === "payment").reduce((a, r) => a + wb.cents(r["Cart Sub-Total"]), 0)));
eq("NF tie · sub-total + processing = transaction total",
  money(nf.sales.itemsCents + nf.sales.taxCents + nf.sales.ticketCents + nf.sales.feeCents),
  money(nf.sales.totalCents));
eq("NF tie · the six tenders sum to the transaction total",
  money(nf.revenue.totalCents), money(nf.sales.totalCents));

eq("NF · refunds are counted",        nf.refunds.txnCount,                6);
eq("NF · card refunds",               () => money(val(() => nf.refTend.rows.find(r => r.key === "Credit Card").cents, NaN)), "10.66");
eq("NF · ticket service fee",         money(nf.sales.ticketCents),        "2.50");
eq("NF · scholarship is not real money", money(nf.revenue.realCents),     "49.00");
eq("NF · credits applied",            money(nf.revenue.creditCents),      "187.80");
eq("NF · final remittance",           money(nf.final.totalCents),         "3.15");

const nfSheet = wb.summarySheet({ name: NF.name, timezone: NF.timezone }, PERIOD, nf);
// The one row added beyond the hand-built layout, and only where the org has
// a ticket service fee — without it the Sales block does not add up.
eq("NF layout · ticket row present", cell(nfSheet, 13, 1), "Ticket Service Fees");
eq("NF layout · Pleasant Hill has no ticket row",
  phSheet.rows.some(r => (r[1] && r[1].v || r[1]) === "Ticket Service Fees"), false);

// The methods table is a column of counts under a total; a reader adds it up.
// Ten of Niagara Falls' payments are free registrations that touch none of the
// six tender columns, so without a Free row the column reads 32 under a total
// of 42 and the whole summary looks wrong.
eq("NF · a Free row exists", nf.revenue.rows.some(t => t.key === "Free"), true);
eq("NF · free registrations counted", () => val(() => nf.revenue.rows.find(t => t.key === "Free").count), 10);
eq("NF · free registrations are worth nothing",
  () => money(val(() => nf.revenue.rows.find(t => t.key === "Free").cents, NaN)), "0.00");
eq("PH · no Free row where there are none", ph.revenue.rows.some(t => t.key === "Free"), false);
eq("PH · still exactly the six methods the hand-built sheet lists", ph.revenue.rows.length, 6);
for (const [who, t] of [["PH", ph], ["NF", nf]]) {
  // Neither fixture has a split-tender transaction, so the counts must add up
  // exactly. (With one, a transaction is counted once per tender it used and
  // the column legitimately exceeds the total — the total row carries the real
  // transaction count either way.)
  eq(`${who} · method counts add up to the transaction total`,
    t.revenue.rows.reduce((a, x) => a + x.count, 0), t.revenue.txnCount);
  eq(`${who} · method money adds up to the transaction total`,
    money(t.revenue.totalCents), money(t.sales.totalCents));
}

ok("placeholder rates stamp the sheet", () => {
  const draft = wb.summarySheet({ name: NF.name, timezone: NF.timezone }, PERIOD,
    wb.summarize({ txns: NF.txns, items: NF.items, fees: { ...FEES, rateSource: "test" } }));
  const last = draft.rows.filter(r => r.length).slice(-1)[0];
  assert.ok(/^DRAFT/.test(String(last[1].v)), `last row is ${JSON.stringify(last[1])}`);
});
ok("a contracted schedule does not stamp it", () => {
  const last = phSheet.rows.filter(r => r.length).slice(-1)[0];
  assert.strictEqual(String(last[1].v), "Total");
});

/* ── 4 · the file is a real workbook ─────────────────────────────────────── */

// Minimal reader: walk the ZIP central directory and inflate each part. The
// writer is hand-rolled, so "it produced bytes" proves nothing on its own.
function unzip(buf) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd > 0, "no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.strictEqual(buf.readUInt32LE(p), 0x02014b50, `central header ${i}`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const start = lho + 30 + lNameLen + lExtraLen;
    const body = buf.subarray(start, start + compSize);
    out[name] = (method === 8 ? zlib.inflateRawSync(body) : body).toString("utf8");
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

const built = wb.generate({
  org: { name: NF.name, slug: "city-of-niagara-falls", timezone: NF.timezone },
  period: PERIOD, txns: NF.txns, items: NF.items, fees: { ...FEES, rateSource: "test" },
});
ok("the workbook opens", () => {
  const parts = unzip(built.buffer);
  for (const need of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml",
                      "xl/_rels/workbook.xml.rels", "xl/styles.xml",
                      "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml"]) {
    assert.ok(parts[need], `missing ${need}`);
  }
  const book = parts["xl/workbook.xml"];
  for (const name of ["Summary", "Transaction Log", "Item Log"]) {
    assert.ok(book.includes(`name="${name}"`), `no ${name} sheet`);
  }
  const s1 = parts["xl/worksheets/sheet1.xml"];
  assert.ok(s1.includes("Rec Payment Processing Costs"), "summary has no processing-costs block");
  assert.ok(s1.includes("<v>3.15</v>"), "summary does not carry the remittance total");
  // Every part must be well-formed enough that each opening tag closes.
  for (const [name, xml] of Object.entries(parts)) {
    assert.ok(xml.trim().endsWith(">"), `${name} is truncated`);
  }
});
ok("the three sheets carry every row", () => {
  const parts = unzip(built.buffer);
  const rowsIn = (xml) => (xml.match(/<row /g) || []).length;
  assert.strictEqual(rowsIn(parts["xl/worksheets/sheet2.xml"]), NF.txns.length + 1, "transaction log");
  assert.strictEqual(rowsIn(parts["xl/worksheets/sheet3.xml"]), NF.items.length + 1, "item log");
});
ok("helper columns never reach the file", () => {
  const parts = unzip(built.buffer);
  const sawHelper = Object.keys(NF.txns[0]).filter(k => k.startsWith("_"))
    .filter(k => parts["xl/worksheets/sheet2.xml"].includes(`>${k}<`));
  assert.deepStrictEqual(sawHelper, [], `leaked ${sawHelper.join(", ")}`);
});

/* ── 5 · the fee schedule and the route that gates on it ─────────────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
ok("the fee schedule is keyed by organization UUID", () => {
  const keys = Object.keys(remittance.REMITTANCE_FEES);
  assert.ok(keys.length, "no orgs configured");
  for (const k of keys) assert.ok(UUID.test(k), `"${k}" is not a UUID — a slug or name key bills the wrong org`);
});
ok("Niagara Falls has a schedule", () => {
  const f = remittance.feesFor(NF.id);
  assert.ok(f, "no schedule");
  for (const need of ["cardRateBps", "cardFixedCents", "cashRateBps", "checkRateBps"]) {
    assert.strictEqual(typeof f[need], "number", `${need} missing`);
  }
});
eq("an org with no schedule gets none", remittance.feesFor(PH.id), null);

// Drive the real route: an org with no fee schedule must be refused BEFORE any
// Metabase call, or a fleet-wide click storm queries every card to then say no.
ok("the workbook route refuses an org with no fee schedule", () => {
  const routes = {};
  const app = { get: (p, _auth, handler) => { routes[p] = handler || _auth; } };
  remittance.mount(app, {
    requireAuth: (_q, _s, next) => next(),
    dataDir: path.join(ROOT, "data"),
    loadOrgs: () => [{ id: PH.id, slug: "pleasant-hill", name: PH.name, displayName: "Pleasant Hill" }],
  });
  const handler = routes["/api/remittance/xlsx"];
  assert.ok(handler, "no /api/remittance/xlsx route registered");

  let status = 200, body = "";
  const res = { status(c) { status = c; return this; }, type() { return this; },
                send(b) { body = b; return this; }, setHeader() {} };
  const done = handler({ query: { org: PH.id, end: PERIOD.end } }, res);
  return Promise.resolve(done).then(() => {
    assert.strictEqual(status, 503, `status ${status}`);
    assert.ok(/fee schedule/i.test(String(body)), `body: ${String(body).slice(0, 120)}`);
  });
});

/* ── report ─────────────────────────────────────────────────────────────── */
// As an exit handler so a block appended below this line still gets reported.
function report() {
  if (failures.length) {
    for (const f of failures) console.error("  ✗ " + f);
    console.error(`✗ remittance-workbook.spec.js — ${failures.length} failure(s), ${pass} passed.`);
    process.exitCode = 1;
  } else {
    console.log(`✓ remittance-workbook.spec.js — ${pass} assertions passed.`);
  }
}
// Nothing may report before every assertion has been made, async ones included.
Promise.all(pending).then(report, (err) => {
  console.error("✗ remittance-workbook.spec.js — the run itself failed: " + err.message);
  process.exitCode = 1;
});
