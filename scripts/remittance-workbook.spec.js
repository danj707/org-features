#!/usr/bin/env node
"use strict";
/**
 * THE GENERATED REMITTANCE HAS TO BE THE SHEET FINANCE ALREADY BUILDS.
 *
 * Five claims, and they need five different kinds of evidence:
 *
 *   1. THE NUMBERS MATCH A SHEET THIS CODE NEVER SAW. Finance hand-built
 *      Pleasant Hill's 2026-09-08 → 2026-09-15 remittance in a Google Sheet.
 *      Every line of it is asserted here against the generator, run over that
 *      period's real card output — committed as a fixture so this runs in CI
 *      with no Metabase access. If the generator and that sheet ever disagree,
 *      one of them is wrong and nobody would otherwise find out.
 *   2. THE LAYOUT MATCHES IT TOO, cell for cell. Same four columns, same row
 *      positions, same label text down to its trailing spaces. A generated
 *      sheet and a hand-built one get put side by side; a tidied-up layout
 *      fails that comparison however right the numbers are. LAYOUT below is
 *      transcribed from the Town of Danvers remittance for the same period.
 *   3. EVERY FORMULA EVALUATES TO ITS OWN CACHED VALUE. The summary computes
 *      itself from the Transactions Log, so a range that points one column left
 *      still opens, still looks right, and quietly disagrees with the figure
 *      beside it the moment Excel recalculates. A small SUMIFS/COUNTIFS
 *      evaluator re-runs every formula against the log the workbook ships.
 *   4. THE ARITHMETIC IS LIFTED AND RUN, not regexed. Every defect in here is
 *      a comparison or a rounding step, and source reads identically either way.
 *   5. THE FILE IS A REAL WORKBOOK. The writer is hand-rolled over zlib, so the
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

// FEE LINES ARE NOT ROUNDED PER LINE. The sheet's own formulas carry full
// precision into =round(...,2) on the total, and rounding each line instead
// disagrees by a cent on a real period — Danvers comes out $20,603.05 that way
// against the $20,603.06 its sheet shows. Asserted to more decimals than the
// sheet displays so that difference cannot creep back in unnoticed.
eq("PH · variable fee 3.50%",  ph.cost.cardVar.toFixed(4),   "21.3745");
eq("PH · fixed fee $0.30 x14", ph.cost.cardFixed.toFixed(2),  "4.20");
eq("PH · Total Rec Fee",       ph.cost.total.toFixed(4),     "25.5745");
eq("PH · Total Rec Fee, as displayed", ph.cost.total.toFixed(2), "25.57");
eq("PH · Card Revenue Collected", money(ph.final.cardRevenueCents), "610.70");
eq("PH · Net Card Refunds",       money(ph.final.cardRefundCents),  "0.00");
eq("PH · FINAL REMITTANCE",       money(ph.final.totalCents),       "585.13");

/* ── 2 · the layout, cell for cell ───────────────────────────────────────── */

// Row positions are 1-based, as the spreadsheet numbers them. Column B holds
// the label; A is the gutter the hand-built sheet leaves empty.
const phSheet = wb.summarySheet(
  { name: PH.name, timezone: PH.timezone, address1: PH.address1, address2: PH.address2 },
  PERIOD, Object.assign(ph, { txnRowCount: PH.txns.length, itemRowCount: PH.items.length }));
const cell = (sheet, row, col) => {
  const c = (sheet.rows[row - 1] || [])[col];
  return c && typeof c === "object" ? c.v : (c === undefined ? null : c);
};
const label = (row) => cell(phSheet, row, 1);

eq("PH layout · column A stays empty", phSheet.rows.every(r => !r.length || r[0] === null || r[0] === undefined), true);
eq("PH layout · four columns", phSheet.widths.length, 4);
eq("PH layout · the finance sheet's column widths", phSheet.widths.join(","), "1.38,34.38,17.13,27.75");
eq("PH layout · gridlines are off", phSheet.gridlines, false);

// TRANSCRIBED FROM THE REFERENCE WORKBOOK, trailing spaces and all — several of
// these labels end in a space and two of the indented ones are padded with nine
// leading spaces rather than indented by a style.
const LAYOUT = [
  [2,  null], [3, PH.name], [4, PH.address1], [5, PH.address2],
  [7,  "Sales Summary"],
  [8,  "Total Sales Transactions "], [9, "Items Sold"], [10, "Total Value of Items Sold"],
  [11, "Taxes "], [12, "Processing Fees"], [13, "Total Sales "],
  [15, "Refunds Summary"],
  [16, "Total Refund Transactions"], [17, "Items Refunded"], [18, "Total Value of Items Refunded"],
  [19, "Taxes"], [20, "Processing Fees"], [21, "Total Refunds"],
  [23, "Total Revenue by Payment Method "], [24, "Method"],
  [25, "Account Credit"], [26, "Scholarship"], [27, "Gift Card"],
  [28, "Credit Card"], [29, "Cash"], [30, "Check"], [31, "Total Sales "],
  [32, "         Revenue - Real Money"],
  [33, "         Revenue - Credits, Scholarships, Gift Cards Applied"],
  [35, "Refunds by Payment Method"], [36, "Method"],
  // Five methods here where Revenue lists six — the hand-built sheet has no
  // Gift Card row in its refunds table, and that is reproduced rather than
  // "fixed", or the two sheets stop lining up row for row.
  [37, "Account Credit"], [38, "Scholarship"], [39, "Credit Card"], [40, "Cash"], [41, "Check"],
  [42, "Total Refunds"],
  [43, "         Refunds - Real Money"], [44, "         Refunds - Credits"],
  [47, "Rec Payment Processing Costs"], [48, "Method"],
  [49, "Credit Card Transactions"], [50, "Variable fee per payment"], [51, "Fixed fee per payment"],
  [52, "Credit Card Refunds"],       [53, "Variable fee per payment"], [54, "Fixed fee per payment"],
  [55, "Cash Transactions"],  [56, "Rec Cash Fee"],
  [57, "Check Transactions"], [58, "Rec Check Fee"],
  [59, "Total Rec Fee"],
  [61, "Final Remittance"], [62, "Credit Card Revenue Collected by Rec"],
  [63, "        Net Rec Payment Processing Costs"], [64, "        Net Card Refunds"],
  [65, "Total"],
];
for (const [row, want] of LAYOUT) eq(`PH layout · row ${row}`, label(row), want);
eq("PH layout · nothing past row 65", phSheet.rows.length, 65);
eq("PH layout · title in column D", cell(phSheet, 2, 3), "Remittance Report");
eq("PH layout · period in column D", cell(phSheet, 3, 3), "September 8, 2026 - September 15, 2026\n");
eq("PH layout · timezone in column D", cell(phSheet, 4, 3), "Timezone: America/Chicago");
eq("PH layout · rate in column C", cell(phSheet, 50, 2), 0.035);
eq("PH layout · base in column D", money(cell(phSheet, 50, 3) * 100), "610.70");
eq("PH layout · block total in D", cell(phSheet, 51, 3).toFixed(4), "25.5745");
eq("PH layout · final total in D", money(cell(phSheet, 65, 3) * 100), "585.13");
eq("PH layout · the tender header is centred", () => val(() => phSheet.rows[23][2].s.h), "center");
eq("PH layout · the logo is anchored in the header band", () => val(() => phSheet.image.row), 0);

// THE ZEBRA STRIPING IS PART OF THE FORMAT. It alternates within a block rather
// than by row parity, so a block that gains a row — the ticket-fee line — keeps
// alternating instead of doubling a stripe.
const fillOf = (sheet, row, col) => val(() => sheet.rows[row - 1][col].s.fill);
ok("PH layout · the summary is striped", () => {
  const want = ["FFF3F3F3", "FFFFFFFF"];
  for (const [first, last] of [[8, 13], [16, 21], [24, 33], [36, 44], [48, 59]]) {
    for (let r = first; r <= last; r++) {
      const got = fillOf(phSheet, r, 1);
      assert.strictEqual(got, want[(r - first) % 2], `B${r} is ${got}`);
    }
  }
});
// Two blank rows before the processing block, as the sheet has them.
eq("PH layout · blank row 45", label(45), "");
eq("PH layout · blank row 46", label(46), "");

// A technology fee is per contract. Absent means the org has none and the whole
// section is left out — a row of zeros would assert a fee that is not in their
// agreement, and it comes straight off the remittance total.
eq("PH · no technology fee configured, no section", ph.tech, null);
ok("a technology fee inserts its section and its own Final Remittance line", () => {
  const withTech = wb.summarize({ txns: PH.txns, items: PH.items, fees: { ...FEES, techRateBps: 100 } });
  withTech.txnRowCount = PH.txns.length; withTech.itemRowCount = PH.items.length;
  const sheet = wb.summarySheet({ name: PH.name, timezone: PH.timezone }, PERIOD, withTech);
  const lab = (r) => { const c = (sheet.rows[r - 1] || [])[1]; return c && typeof c === "object" ? c.v : c; };
  // Danvers' own row numbers, which is the whole point of matching the layout.
  assert.strictEqual(lab(61), "Technology Fees", `row 61 is ${JSON.stringify(lab(61))}`);
  assert.strictEqual(lab(62), "Total Sales");
  assert.strictEqual(lab(65), "Final Remittance");
  assert.strictEqual(lab(68), "        Net Technology Fee");
  assert.strictEqual(lab(70), "Total");
  // 1% of total sales, and it comes off the total.
  assert.strictEqual(withTech.tech.amount.toFixed(4), "6.1070");
  assert.strictEqual((ph.final.total - withTech.final.total).toFixed(4), "6.1070");
});

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

nf.txnRowCount = NF.txns.length; nf.itemRowCount = NF.items.length;
const nfSheet = wb.summarySheet({ name: NF.name, timezone: NF.timezone }, PERIOD, nf);
// The one row added beyond the hand-built layout, and only where the org has a
// ticket service fee — without it the Sales block visibly fails to add up to
// Total Sales. It sits after Taxes, the way the block is ordered.
eq("NF layout · ticket row present", cell(nfSheet, 12, 1), "Ticket Service Fees");
eq("NF layout · and it pushes Processing Fees down a row", cell(nfSheet, 13, 1), "Processing Fees");
ok("NF layout · the extra row does not double a stripe", () => {
  // Same block, one row longer, and still alternating from the top.
  const want = ["FFF3F3F3", "FFFFFFFF"];
  for (let r = 8; r <= 14; r++) {
    const got = fillOf(nfSheet, r, 1);
    assert.strictEqual(got, want[(r - 8) % 2], `B${r} is ${got}`);
  }
});

eq("NF layout · Pleasant Hill has no ticket row",
  phSheet.rows.some(r => (r[1] && r[1].v || r[1]) === "Ticket Service Fees"), false);

// SIX METHODS AND NO MORE. Ten of Niagara Falls' payments are free
// registrations that touch none of the six tender columns, so the count column
// reads 32 under 41 transactions — and the hand-built sheets have exactly the
// same property (Danvers reads 117 under 165). A seventh "Free" row would make
// the column add up and stop the two sheets lining up row for row, so the
// money is what has to tie, not the counts.
eq("PH · exactly the six methods the hand-built sheet lists", ph.revenue.rows.length, 6);
eq("NF · exactly the six methods, free registrations and all", nf.revenue.rows.length, 6);
eq("NF · free registrations are visible as the gap", nf.revenue.freeCount, 10);
for (const [who, t] of [["PH", ph], ["NF", nf]]) {
  eq(`${who} · method money adds up to the transaction total`,
    money(t.revenue.totalCents), money(t.sales.totalCents));
}
// One transaction can come down the log as two rows; the summary counts it once.
eq("NF · transactions are counted distinctly", nf.sales.txnCount, 41);
eq("NF · and the log still carries every row", nf.sales.rowCount, 42);

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

/* ── 3b · every formula evaluates to its own cached value ────────────────── */

/**
 * The summary is formula-driven: it computes itself from the Transactions Log
 * the way the hand-built sheet does, so a reader can click a figure and see
 * where it came from. That makes a whole class of defect invisible — a range
 * that points one column left still opens, still shows the right number
 * (because the value is cached beside the formula), and changes the moment
 * Excel recalculates in front of the org.
 *
 * So: a small evaluator for exactly the subset emitted — SUMIFS, COUNTIFS, SUM,
 * ROUND, IFERROR, cell and range references, and + - * / — re-run against the
 * log sheets the workbook actually ships.
 */
function makeEvaluator(sheets) {
  const byName = Object.fromEntries(sheets.map((sh) => [sh.name, sh]));
  const colIdx = (c) => { let n = 0; for (const ch of c) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  const cellAt = (sheetName, col, row) => {
    const sh = byName[sheetName];
    assert.ok(sh, `formula refers to a sheet that is not in the workbook: ${sheetName}`);
    const c = (sh.rows[row - 1] || [])[colIdx(col)];
    if (c === null || c === undefined || c === "") return "";
    return typeof c === "object" ? (c.v === undefined ? "" : c.v) : c;
  };
  const num = (v) => { const n = Number(String(v).replace(/[$,]/g, "")); return Number.isFinite(n) ? n : 0; };

  return function evaluate(src, homeSheet) {
    let i = 0;
    const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
    const rangeVals = (r) => {
      const out = [];
      for (let n = r.from; n <= r.to; n++) out.push(cellAt(r.sheet, r.col, n));
      return out;
    };
    function matches(v, crit) {
      if (typeof crit === "string" && crit.startsWith("<>"))
        return String(v).toLowerCase() !== crit.slice(2).toLowerCase();
      if (typeof crit === "string" && /^[<>]=?/.test(crit)) {
        const op = crit.match(/^[<>]=?/)[0], k = Number(crit.slice(op.length)), n = num(v);
        return op === ">" ? n > k : op === "<" ? n < k : op === ">=" ? n >= k : n <= k;
      }
      return String(v).toLowerCase() === String(crit).toLowerCase();
    }
    function parseRef() {
      let sheet = homeSheet;
      if (src[i] === "'") { const e = src.indexOf("'", i + 1); sheet = src.slice(i + 1, e); i = e + 1; if (src[i] === "!") i++; }
      const m = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?/.exec(src.slice(i));
      assert.ok(m, `cannot parse a reference at "${src.slice(i, i + 24)}"`);
      i += m[0].length;
      return m[3] ? { kind: "range", sheet, col: m[1], from: +m[2], to: +m[4] }
                  : { kind: "cell",  sheet, col: m[1], row: +m[2] };
    }
    function apply(name, args) {
      const range = (a) => { assert.ok(a && a.kind === "range", `${name} wants a range`); return rangeVals(a); };
      switch (name) {
        case "IFERROR": return args[0];
        case "ROUND": { const p = num(args[1]); return Math.round(num(args[0]) * 10 ** p) / 10 ** p; }
        case "SUM": return args.reduce((t, a) =>
          t + (a && a.kind === "range" ? range(a).reduce((u, v) => u + num(v), 0) : num(a)), 0);
        case "SUMIFS": {
          const vals = range(args[0]); let total = 0;
          for (let n = 0; n < vals.length; n++) {
            let hit = true;
            for (let a = 1; a < args.length; a += 2)
              if (!matches(range(args[a])[n], args[a + 1])) { hit = false; break; }
            if (hit) total += num(vals[n]);
          }
          return total;
        }
        case "COUNTIFS": {
          const len = range(args[0]).length; let c = 0;
          for (let n = 0; n < len; n++) {
            let hit = true;
            for (let a = 0; a < args.length; a += 2)
              if (!matches(range(args[a])[n], args[a + 1])) { hit = false; break; }
            if (hit) c++;
          }
          return c;
        }
        default: throw new Error(`the summary emits ${name}(), which this evaluator does not know`);
      }
    }
    function atom() {
      ws();
      if (src[i] === "(") { i++; const v = expr(); ws(); i++; return v; }
      if (src[i] === '"') { const e = src.indexOf('"', i + 1); const t = src.slice(i + 1, e); i = e + 1; return t; }
      if (/[0-9.]/.test(src[i])) { const m = /^[0-9.]+/.exec(src.slice(i)); i += m[0].length; return Number(m[0]); }
      const fn = /^([A-Z]+)\s*\(/.exec(src.slice(i));
      if (fn && !/^[A-Z]+\$?\d/.test(src.slice(i))) {
        i += fn[0].length;
        const args = [];
        for (;;) {
          ws();
          if (src[i] === ")") { i++; break; }
          args.push(src[i] === "'" || /^\$?[A-Z]+\$?\d+:/.test(src.slice(i)) ? parseRef() : expr());
          ws();
          if (src[i] === ",") { i++; continue; }
          assert.strictEqual(src[i], ")", `unexpected "${src[i]}" in ${fn[1]}()`);
          i++; break;
        }
        return apply(fn[1], args);
      }
      const r = parseRef();
      return r.kind === "cell" ? cellAt(r.sheet, r.col, r.row)
                               : rangeVals(r).reduce((t, v) => t + num(v), 0);
    }
    function term() {
      let v = atom();
      for (ws(); i < src.length && "*/".includes(src[i]); ws()) {
        const op = src[i++], r = atom();
        v = op === "*" ? num(v) * num(r) : num(v) / num(r);
      }
      return v;
    }
    function expr() {
      let v = term();
      for (ws(); i < src.length && "+-".includes(src[i]); ws()) {
        const op = src[i++], r = term();
        v = op === "+" ? num(v) + num(r) : num(v) - num(r);
      }
      return v;
    }
    return expr();
  };
}

for (const [who, org, data, fees] of [
  ["PH", { name: PH.name, timezone: PH.timezone, address1: PH.address1, address2: PH.address2 }, PH, FEES],
  // Niagara Falls with a technology fee, so the section's own formulas are
  // covered as well — Pleasant Hill has none.
  ["NF", { name: NF.name, timezone: NF.timezone }, NF, { ...FEES, techRateBps: 100 }],
]) {
  const gen = wb.generate({ org, period: PERIOD, txns: data.txns, items: data.items, fees });
  const evaluate = makeEvaluator(gen.sheets);
  const summary = gen.sheets[0];
  const formulas = [];
  summary.rows.forEach((row, r) => (row || []).forEach((c, ci) => {
    if (c && typeof c === "object" && c.f) formulas.push([`${String.fromCharCode(65 + ci)}${r + 1}`, c]);
  }));
  eq(`${who} formulas · the summary computes itself`, formulas.length > 30, true);
  ok(`${who} formulas · every one evaluates to its cached value`, () => {
    const wrong = [];
    for (const [ref, c] of formulas) {
      let got;
      try { got = evaluate(c.f, summary.name); }
      catch (err) { wrong.push(`${ref}: ${err.message}`); continue; }
      if (Math.abs(Number(got) - Number(c.v)) > 1e-9) wrong.push(`${ref}: shows ${c.v} but ${c.f} gives ${got}`);
    }
    assert.deepStrictEqual(wrong, [], `\n      ${wrong.join("\n      ")}`);
  });
  // The line that is actually paid, recomputed from the sheet rather than from
  // the calculator that wrote it.
  ok(`${who} formulas · the remittance total ties`, () => {
    const total = summary.rows.filter(r => r.length)
      .map(r => r[1]).filter(Boolean)
      .map(c => (typeof c === "object" ? c.v : c));
    assert.ok(total.includes("Total"), "no Total row");
    const row = summary.rows.findIndex(r => r[1] && (r[1].v === "Total"));
    assert.strictEqual(
      Number(evaluate(summary.rows[row][3].f, summary.name)).toFixed(2),
      (gen.summary.final.totalCents / 100).toFixed(2));
  });
}

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
    out[name] = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
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
  const book = String(parts["xl/workbook.xml"]);
  // Literal, not wb.TXN_SHEET — reading the constant compares the code to
  // itself and renaming the tabs would pass.
  for (const name of ["Remittance Summary", "Transactions Log", "Items Log"]) {
    assert.ok(book.includes(`name="${name}"`), `no "${name}" sheet — the tabs are named on the sheet finance already sends`);
  }
  const s1 = String(parts["xl/worksheets/sheet1.xml"]);
  assert.ok(s1.includes("Rec Payment Processing Costs"), "summary has no processing-costs block");
  assert.ok(s1.includes("<v>3.15</v>"), "summary does not carry the remittance total");
  // Every XML part must be well-formed enough that each opening tag closes.
  for (const [name, part] of Object.entries(parts)) {
    if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
    assert.ok(String(part).trim().endsWith(">"), `${name} is truncated`);
  }
  // The logo survives the writer: deflating an already-compressed PNG makes it
  // bigger, so it takes the stored-not-deflated path and a byte off there is a
  // corrupt image rather than a smaller one.
  const png = parts["xl/media/image1.png"];
  assert.ok(png, "no logo in the workbook");
  assert.strictEqual(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "logo is not a PNG");
  assert.ok(parts["xl/drawings/drawing1.xml"], "the logo is embedded but never anchored");
  assert.ok(String(parts["xl/worksheets/sheet1.xml"]).includes("<drawing "), "the summary does not reference its drawing");
});
ok("the three sheets carry every row", () => {
  const parts = unzip(built.buffer);
  const rowsIn = (xml) => (String(xml).match(/<row /g) || []).length;
  assert.strictEqual(rowsIn(parts["xl/worksheets/sheet2.xml"]), NF.txns.length + 1, "transaction log");
  assert.strictEqual(rowsIn(parts["xl/worksheets/sheet3.xml"]), NF.items.length + 1, "item log");
});
ok("helper columns never reach the file", () => {
  const parts = unzip(built.buffer);
  const sawHelper = Object.keys(NF.txns[0]).filter(k => k.startsWith("_"))
    .filter(k => String(parts["xl/worksheets/sheet2.xml"]).includes(`>${k}<`));
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

// The filename finance already uses. A generated workbook has to file next to
// the hand-built ones, not sort into its own group at the top of the folder.
eq("the workbook is named the way finance names it",
  remittance.workbookFilename({ displayName: "Danvers" }, PERIOD),
  "Danvers_Remittance_Report_-_20260908-20260915.xlsx");
eq("placeholder rates are named in the filename too",
  remittance.workbookFilename({ displayName: "City of Niagara Falls" }, PERIOD, { draft: true }),
  "City_of_Niagara_Falls_Remittance_Report_-_20260908-20260915_DRAFT.xlsx");
// An org name is free text and this ends up in a Content-Disposition header.
eq("punctuation in an org name cannot escape the filename",
  remittance.workbookFilename({ displayName: 'St. Charles "Parks" & Rec/Admin' }, PERIOD),
  "St_Charles_Parks_Rec_Admin_Remittance_Report_-_20260908-20260915.xlsx");

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
