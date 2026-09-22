/**
 * The remittance workbook: Remittance Summary + Transactions Log + Items Log.
 *
 * Finance builds this by hand once per billing period, per org — pulling the
 * two logs, pasting them into a sheet, and typing the summary on top. This
 * module is that sheet, generated.
 *
 * THE SUMMARY TAB IS A CELL-FOR-CELL REPRODUCTION of the existing hand-built
 * sheet, checked against the Town of Danvers remittance for 2026-09-08 →
 * 2026-09-15: same four columns (A is the gutter it leaves empty), same rows in
 * the same positions, same label text down to its trailing spaces, same zebra
 * striping, same fonts, and the same formulas — the summary COMPUTES ITSELF
 * from the Transactions Log rather than carrying typed-in numbers, so anyone
 * reading it can click a cell and see where the figure came from.
 * scripts/remittance-workbook.spec.js pins every row of that layout and
 * re-evaluates every formula against the log it references.
 *
 * Don't "tidy" the layout: a generated sheet and a hand-built one get put side
 * by side, and the point is that they line up.
 *
 * Pure — no Express, no Metabase, no fs beyond reading the logo. Rows in,
 * buffer out.
 */

const fs   = require("fs");
const path = require("path");
const { build, colName } = require("./xlsx");

/* ── the palette the finance sheet uses ──────────────────────────────────── */
// Arial throughout, 8pt for data and 10pt bold for a section heading, near-black
// rather than black, and a two-tone zebra. Read off the reference workbook, not
// chosen — the whole value of this tab is that it looks like the one finance
// already sends.
const INK   = "FF202020";
const GREY  = "FFF3F3F3";
const WHITE = "FFFFFFFF";
const A = (d = {}) => ({ sz: 8, color: INK, name: "Arial", ...d });

const HEAD    = (fill) => A({ sz: 10, b: true, fill, v: "top" });
const LABEL   = (fill) => A({ fill });
const LABEL_R = (fill) => A({ fill, h: "right", i: true });
const BOLD    = (fill) => A({ fill, b: true });
const MONEY   = (fill, b) => A({ fill, b: !!b, fmt: '"$"#,##0.00', h: "right" });
const INT     = (fill, b) => A({ fill, b: !!b, fmt: "#,##0", h: "center" });
const ITALIC  = (fill) => A({ fill, i: true });
// A rate is the one thing on the sheet a person types, so it is pure black
// where everything around it is near-black.
const RATE    = (fill, fmt) => A({ fill, color: "FF000000", fmt, h: "center" });

/* ── the arithmetic ─────────────────────────────────────────────────────── */

// Money arrives from the card as display strings ("$0", "$1,234.50"). Sums are
// taken in CENTS so a period of 600 rows cannot drift a cent on binary
// fractions.
// A count, not money: cents() multiplies by 100 and is the wrong reader for
// "Item Count". A value that cannot be read is 0 rather than NaN, which would
// poison the whole sum.
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function cents(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

const isPayment = (r) => String(r.Type || "").toLowerCase() === "payment";
const isRefund  = (r) => String(r.Type || "").toLowerCase() === "refund";

// The six tender columns, in the order the finance sheet lists them. Built from
// the AMOUNT COLUMNS rather than the "Method" label: a split-tender transaction
// carries one label ("Card, Account Credit") and two non-zero columns, so a
// label-driven table would file the whole transaction under one method and stop
// tying to the transaction total.
const TENDERS = [
  { key: "Credits",     label: "Account Credit", real: false },
  { key: "Scholarship", label: "Scholarship",    real: false },
  { key: "Gift Card",   label: "Gift Card",      real: false },
  { key: "Credit Card", label: "Credit Card",    real: true  },
  { key: "Cash",        label: "Cash",           real: true  },
  { key: "Check",       label: "Check",          real: true  },
];

function tenderTable(rows) {
  const out = TENDERS.map((t) => ({ ...t, count: 0, cents: 0 }));
  let free = 0;
  for (const r of rows) {
    let touched = 0;
    for (const t of out) {
      const c = cents(r[t.key]);
      if (c !== 0) { t.count += 1; t.cents += c; touched++; }
    }
    if (!touched) free++;
  }
  const total = out.reduce((s, t) => s + t.cents, 0);
  // A $0 registration moves no money and lands in none of the six columns, and
  // a split-tender transaction lands in two — so this column of counts is
  // "transactions that used this method", NOT a partition of the transaction
  // count, and the finance sheet has the same property (117 against 165 at
  // Danvers). freeCount is carried so a reader of this module can tell the two
  // apart; the sheet deliberately has no row for it.
  return { rows: out, totalCents: total, txnCount: rows.length, freeCount: free,
           realCents:   out.filter(t =>  t.real).reduce((s, t) => s + t.cents, 0),
           creditCents: out.filter(t => !t.real).reduce((s, t) => s + t.cents, 0) };
}


function salesBlock(txns) {
  // "ITEMS SOLD" IS THE TRANSACTION LOG'S OWN Item Count, summed — which is what
  // the Danvers sheet does (=SUMIFS('Transactions Log'!K, …!I, "payment")).
  //
  // Dan, 2026-09-22: "stick with whatever i uploaded for danvers."
  //
  // It is worth knowing what that includes, because the two readings really do
  // differ: Item Count carries the pass-through processing-fee lines, so a
  // basket with a card fee counts one higher than the goods in it. Pleasant
  // Hill's own sheet reads 20 over a period whose Item Count is 34 — the 14 fee
  // lines are the difference. Danvers is the reference, so 34 is the answer;
  // that one row will not match a hand-built Pleasant Hill sheet, and the money
  // rows are untouched either way.
  return {
    // DISTINCT TRANSACTION IDS, not rows: one transaction can come down the
    // log as two rows (Niagara Falls has one, 42 rows over 41 ids), and the
    // finance sheet counts it once — its formula is COUNTUNIQUEIFS.
    txnCount:   new Set(txns.map(r => r["Transaction ID"])).size,
    rowCount:   txns.length,
    itemCount:  txns.reduce((t, r) => t + num(r["Item Count"]), 0),
    itemsCents: txns.reduce((s, r) => s + cents(r["Cart Value"]), 0),
    taxCents:   txns.reduce((s, r) => s + cents(r["Total Tax on Cart Items"]), 0),
    ticketCents:txns.reduce((s, r) => s + cents(r["Ticket Service Fee"]), 0),
    feeCents:   txns.reduce((s, r) => s + cents(r["Credit Card Processing Fee"]), 0),
    totalCents: txns.reduce((s, r) => s + cents(r["Total Transaction Amount"]), 0),
  };
}

/**
 * fees: { cardRateBps, cardFixedCents, cashRateBps, checkRateBps,
 *         techRateBps, chargeFeeOnRefunds }
 */
function summarize({ txns, items, fees }) {
  const pay = txns.filter(isPayment);
  const ref = txns.filter(isRefund);

  const sales   = salesBlock(pay);
  const refunds = salesBlock(ref);
  const revenue = tenderTable(pay);
  const refTend = tenderTable(ref);

  const of = (t, k) => t.rows.find(r => r.key === k);
  const cardPay = of(revenue, "Credit Card"), cardRef = of(refTend, "Credit Card");
  const cash    = of(revenue, "Cash"),        chk     = of(revenue, "Check");

  // FEE LINES CARRY FULL PRECISION AND ARE ROUNDED EXACTLY ONCE, at the final
  // total — because that is what the sheet's own formulas do
  // (=round(D66-D67-D68-D69,2) over unrounded fee cells). Rounding each line to
  // the cent instead reads more "correct" and disagrees: on the Danvers period
  // it gives $20,603.05 where the sheet gives $20,603.06. A remittance that is
  // a cent out from the one finance sent last month is a support ticket, so
  // this mirrors the arithmetic rather than improving on it.
  const $ = (c) => c / 100;
  const rate = (bps) => bps / 10000;
  const cost = {
    cardVar:   $(cardPay.cents) * rate(fees.cardRateBps),
    cardFixed: cardPay.count * $(fees.cardFixedCents),
    refVar:    $(cardRef.cents) * rate(fees.cardRateBps),
    refFixed:  cardRef.count * $(fees.cardFixedCents),
    cash:      $(cash.cents) * rate(fees.cashRateBps || 0),
    check:     $(chk.cents)  * rate(fees.checkRateBps || 0),
  };
  cost.cardBlock = cost.cardVar + cost.cardFixed;
  // Whether Rec bills its fee a second time on the refunded amount is per
  // schedule. The reference sheet charges it (its D59 sums the refund block in),
  // and the refunded principal is withheld separately below.
  cost.refundBlock = fees.chargeFeeOnRefunds ? cost.refVar + cost.refFixed : 0;
  cost.refundFeeCharged = !!fees.chargeFeeOnRefunds;
  cost.total = cost.cardBlock + cost.refundBlock + cost.cash + cost.check;

  // The technology fee is a percentage of TOTAL SALES — every tender, not just
  // the card money Rec is holding. Absent from the schedule means the org has
  // none and the whole section is left out, rather than a row of zeros
  // asserting a fee that is not in their contract.
  const tech = fees.techRateBps
    ? { rateBps: fees.techRateBps, baseCents: revenue.totalCents,
        amount: $(revenue.totalCents) * rate(fees.techRateBps) }
    : null;

  const final = {
    cardRevenueCents: cardPay.cents,
    cost:             cost.total,
    tech:             tech ? tech.amount : 0,
    cardRefundCents:  cardRef.cents,
  };
  final.total = $(final.cardRevenueCents) - final.cost - final.tech - $(final.cardRefundCents);
  final.totalCents = Math.round(final.total * 100);

  return { sales, refunds, revenue, refTend, cost, tech, final, fees };
}


/* ── the sheets ─────────────────────────────────────────────────────────── */

// The product's own export columns, in its order. Validated against a real
// manual export (Chico, 2026-08-08 → 2026-08-15) column for column — so these
// are the product's list, not the reference workbook's, which predates the
// Ticket Service Fee column.
const TXN_COLUMNS = ["Date","Location","Staff","Transaction ID","Customer Name","Customer Email",
  "Customer Phone","Customer Rec ID","Type","Transaction Created By","Item Count","Cart Value",
  "Total Tax on Cart Items","Cart Sub-Total","Ticket Service Fee","Credits","Cash","Check",
  "Credit Card","Credit Card Processing Fee","Scholarship","Gift Card","Total Transaction Amount","Method"];
const ITEM_COLUMNS = ["Date","Location","Transaction ID","Customer Name","Type","Method","Item Value",
  "Item Type","Fee Category","Item Name","GL Code","Customer Email"];

const TXN_SHEET  = "Transactions Log";
const ITEM_SHEET = "Items Log";

/**
 * WHAT THE CARD SENDS IS WHAT THE SHEET CARRIES. The lists above are the ORDER
 * and the header for a period with no rows; they are not an allowlist, because
 * an allowlist silently drops a column the export gains and nothing on screen
 * says so. Dan, 2026-09-22: "whatever data is coming from the items and
 * transactions log, go with that and include it."
 *
 * The one thing held back is a LEADING UNDERSCORE, which is the card's own mark
 * for a machine column rather than a judgement about which data matters: today
 * that is _sort_at, _amount_cents, _method_raw, _type_raw and
 * _total_cents — every one of them the sortable or in-cents twin of a column
 * already on the sheet. A real new column (an Item ID, say) has no underscore
 * and lands on its own.
 *
 * The CSV export has always worked this way; the workbook did not, and the two
 * disagreeing about the same period is the thing this removes.
 */
function logColumns(rows, fallback) {
  const seen = [];
  for (const r of rows || []) {
    for (const k of Object.keys(r || {})) {
      if (!k.startsWith("_") && !seen.includes(k)) seen.push(k);
    }
  }
  return seen.length ? seen : (fallback || []);
}

// The summary's formulas address the Transactions Log by COLUMN LETTER, so the
// letters are derived from the columns the sheet ACTUALLY carries rather than
// typed. A column added to the export then moves the formulas with it instead
// of silently pointing them one column left.
const colLetters = (columns) =>
  Object.fromEntries((columns || []).map((n, i) => [n, colName(i)]));
const TXN_COL  = colLetters(TXN_COLUMNS);
const ITEM_COL = colLetters(ITEM_COLUMNS);

const $ = (c) => c / 100;
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function longDate(iso) {                        // never new Date(iso): that is UTC midnight
  const [y, m, day] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${day}, ${y}`;
}

const LOGO = path.join(__dirname, "..", "public", "rec-wordmark.png");

function summarySheet(org, period, s) {
  const rows = [];
  const heights = {};
  // Zebra striping is by POSITION in a block, not by row parity, so a block
  // that gains a row (the ticket-fee line) keeps alternating instead of
  // doubling a stripe.
  let stripe = 0;
  const zebra = () => (stripe++ % 2 ? WHITE : GREY);
  const resetStripe = () => { stripe = 0; };

  // Column A is the gutter the finance sheet leaves empty; B label, C middle,
  // D value. Kept so a generated sheet and a hand-built one line up cell for
  // cell when they are put side by side.
  const put = (b, c, d, ht) => {
    rows.push([null, b, c, d]);
    if (ht) heights[rows.length - 1] = ht;
    return rows.length;                 // the 1-based row number, for formulas
  };
  // The row a put() is ABOUT to write. Arguments are evaluated before the push,
  // so a formula that refers to its own row — "this row's rate times the row
  // above" — has to name next(), and one that refers to a row already written
  // uses the number that put() returned.
  const next = () => rows.length + 1;
  const blank = (fill, ht) => {
    const c = fill ? { v: "", s: A({ fill }) } : null;
    return put(c, c && { ...c }, c && { ...c }, ht);
  };

  // ── header ────────────────────────────────────────────────────────────────
  // The three newlines are what reserve the header band the logo sits in.
  put({ v: "\n\n\n", s: A({ sz: 9, b: true, color: "FF434343", h: "left", v: "center" }) }, null, null, 18.75);
  put(null, null, { v: "Remittance Report", s: A({ sz: 10, b: true, h: "right", v: "top" }) }, 30.75);
  put({ v: org.name, s: A({ b: true, h: "left", v: "center", fmt: "@" }) }, null,
      { v: `${longDate(period.start)} - ${longDate(period.end)}\n`, s: A({ b: true, h: "right", v: "top", fmt: "@" }) }, 11.25);
  // TWO LITERAL LINES, not one address split by rule: the reference sheets break
  // "1 Sylvan Street, Danvers" / " Danvers, MA 01923, USA" and "203 Paul St." /
  // " Pleasant Hill, MO 64080" at different commas, because a person typed them.
  // They come off the fee schedule, which is hand-maintained per org anyway.
  // "America/New_York" is shown with a space, the way the reference sheet does.
  put({ v: org.address1 || "", s: A({ h: "left", v: "bottom" }) }, null,
      { v: `Timezone: ${String(org.timezone || "").replace(/_/g, " ")}`, s: A({ h: "right", v: "bottom" }) }, 11.25);
  put({ v: org.address2 || "", s: A({ h: "left", v: "bottom" }) }, null, null, 9);
  blank(null, 7.5);

  // ── Sales Summary ─────────────────────────────────────────────────────────
  // Every org's sheet has these lines; the ticket-fee line is the one addition,
  // and only where an org has one — without it the block visibly fails to add
  // up to Total Sales.
  const hasTicket = !!(s.sales.ticketCents || s.refunds.ticketCents);
  // The SUMIFS ranges cover exactly the rows the log has. The reference sheet
  // pads to a fixed 1032 because it was built by hand; sizing to the data means
  // a period with more transactions than that still adds up.
  const txnRows = s.txnRowCount || 0;
  // The letters come from the columns the LOG SHEET carries, which is whatever
  // the card sent — not from the declared order, or a card that gained a column
  // would leave every formula addressing the column to its left. A caller that
  // builds a summary on its own (the spec does) gets the declared order.
  const txnCol  = s.txnColumns  ? colLetters(s.txnColumns)  : TXN_COL;
  const T = (name) => `'${TXN_SHEET}'!$${txnCol[name]}$2:$${txnCol[name]}$${txnRows + 1}`;
  const sumIf = (col, type) => `IFERROR(SUMIFS(${T(col)}, ${T("Type")}, "${type}"), 0)`;
  const countIf = (col, type) => `IFERROR(COUNTIFS(${T("Type")}, "${type}", ${T(col)}, ">0"), 0)`;

  put({ v: "Sales Summary", s: HEAD() }, null, null, 19.5);
  resetStripe();
  // The value column of these two blocks is right-aligned, counts included —
  // only the tender tables below centre a count.
  const SUMINT = (fill) => A({ fill, fmt: "#,##0", h: "right" });
  const line = (label, value, fmt, fill) => put(
    { v: label, s: LABEL(fill) }, { v: "", s: A({ fill }) },
    { ...value, s: (fmt === "int" ? SUMINT : MONEY)(fill) });
  let f = zebra();
  // COUNTUNIQUEIFS has no Excel equivalent, so the transaction count is the one
  // figure carried as a plain value — the reference sheet resorts to a cached
  // value here too.
  line("Total Sales Transactions ", { v: s.sales.txnCount }, "int", f);
  f = zebra(); line("Items Sold", { v: s.sales.itemCount, f: sumIf("Item Count", "payment") }, "int", f);
  f = zebra(); line("Total Value of Items Sold", { v: $(s.sales.itemsCents), f: sumIf("Cart Value", "payment") }, "money", f);
  f = zebra(); line("Taxes ", { v: $(s.sales.taxCents), f: sumIf("Total Tax on Cart Items", "payment") }, "money", f);
  if (hasTicket) { f = zebra(); line("Ticket Service Fees", { v: $(s.sales.ticketCents), f: sumIf("Ticket Service Fee", "payment") }, "money", f); }
  f = zebra(); line("Processing Fees", { v: $(s.sales.feeCents), f: sumIf("Credit Card Processing Fee", "payment") }, "money", f);
  f = zebra();
  const rTotalSales = put({ v: "Total Sales ", s: BOLD(f) }, { v: "", s: A({ fill: f }) },
                          { v: $(s.revenue.totalCents), s: MONEY(f, true) });
  blank(WHITE);

  // ── Refunds Summary ───────────────────────────────────────────────────────
  put({ v: "Refunds Summary", s: HEAD(WHITE) }, { v: "", s: A({ fill: WHITE }) }, { v: "", s: A({ fill: WHITE }) }, 18.75);
  resetStripe();
  f = zebra(); line("Total Refund Transactions", { v: s.refunds.txnCount }, "int", f);
  f = zebra(); line("Items Refunded", { v: s.refunds.itemCount, f: sumIf("Item Count", "refund") }, "int", f);
  f = zebra(); line("Total Value of Items Refunded", { v: $(s.refunds.itemsCents), f: sumIf("Cart Value", "refund") }, "money", f);
  f = zebra(); line("Taxes", { v: $(s.refunds.taxCents), f: sumIf("Total Tax on Cart Items", "refund") }, "money", f);
  if (hasTicket) { f = zebra(); line("Ticket Service Fees", { v: $(s.refunds.ticketCents), f: sumIf("Ticket Service Fee", "refund") }, "money", f); }
  f = zebra(); line("Processing Fees", { v: $(s.refunds.feeCents), f: sumIf("Credit Card Processing Fee", "refund") }, "money", f);
  f = zebra();
  const rTotalRef = put({ v: "Total Refunds", s: BOLD(f) }, { v: "", s: A({ fill: f }) },
                        { v: $(s.refTend.totalCents), s: MONEY(f, true) });
  blank();

  // ── Total Revenue by Payment Method ───────────────────────────────────────
  put({ v: "Total Revenue by Payment Method ", s: HEAD(WHITE) }, { v: "", s: A({ fill: WHITE }) }, { v: "", s: A({ fill: WHITE }) }, 20.25);
  resetStripe();
  f = zebra();
  put({ v: "Method", s: BOLD(f) },
      { v: "Total Payments ", s: A({ fill: f, b: true, h: "center" }) },
      { v: "Total Paid", s: A({ fill: f, b: true, h: "center" }) });
  const revRow = {};
  for (const t of s.revenue.rows) {
    f = zebra();
    revRow[t.key] = put({ v: t.label, s: LABEL(f) },
      { v: t.count, f: countIf(t.key, "payment"), s: INT(f) },
      { v: $(t.cents), f: sumIf(t.key, "payment"), s: MONEY(f) });
  }
  f = zebra();
  const rRevTotal = put({ v: "Total Sales ", s: BOLD(f) },
    { v: s.revenue.rows.reduce((n, t) => n + t.count, 0), f: `SUM(C${revRow.Credits}:C${revRow.Check})`, s: INT(f, true) },
    { v: $(s.revenue.totalCents), f: `SUM(D${revRow.Credits}:D${revRow.Check})`, s: MONEY(f, true) });
  f = zebra();
  put({ v: "         Revenue - Real Money", s: ITALIC(f) }, { v: "", s: INT(f) },
      { v: $(s.revenue.realCents), f: `SUM(D${revRow["Credit Card"]}:D${revRow.Check})`, s: MONEY(f) });
  f = zebra();
  put({ v: "         Revenue - Credits, Scholarships, Gift Cards Applied", s: ITALIC(f) }, { v: "", s: INT(f) },
      { v: $(s.revenue.creditCents), f: `SUM(D${revRow.Credits}:D${revRow["Gift Card"]})`, s: MONEY(f) });
  blank();

  // ── Refunds by Payment Method ─────────────────────────────────────────────
  // Five methods where the revenue table lists six: the finance sheet has no
  // Gift Card row here, and a gift card is not refunded to a gift card.
  put({ v: "Refunds by Payment Method", s: HEAD(WHITE) }, { v: "", s: A({ fill: WHITE }) }, { v: "", s: A({ fill: WHITE }) }, 20.25);
  resetStripe();
  f = zebra();
  put({ v: "Method", s: BOLD(f) },
      { v: "Total Payments", s: A({ fill: f, b: true, h: "center" }) }, { v: "", s: A({ fill: f }) });
  const refOrder = ["Credits", "Scholarship", "Credit Card", "Cash", "Check"];
  const refRow = {};
  for (const key of refOrder) {
    const t = s.refTend.rows.find(r => r.key === key);
    f = zebra();
    refRow[key] = put({ v: t.label, s: LABEL(f) },
      { v: t.count, f: countIf(key, "refund"), s: INT(f) },
      { v: $(t.cents), f: sumIf(key, "refund"), s: MONEY(f) });
  }
  const refReal = refOrder.filter(k => k === "Credit Card" || k === "Cash" || k === "Check")
    .reduce((n, k) => n + s.refTend.rows.find(r => r.key === k).cents, 0);
  f = zebra();
  const rRefTotal = put({ v: "Total Refunds", s: BOLD(f) },
    { v: refOrder.reduce((n, k) => n + s.refTend.rows.find(r => r.key === k).count, 0),
      f: `SUM(C${refRow.Credits}:C${refRow.Check})`, s: INT(f, true) },
    { v: $(s.refTend.totalCents), f: `SUM(D${refRow.Credits}:D${refRow.Check})`, s: MONEY(f, true) });
  f = zebra();
  put({ v: "         Refunds - Real Money", s: ITALIC(f) }, { v: "", s: BOLD(f) },
      { v: $(refReal), f: `SUM(D${refRow["Credit Card"]}:D${refRow.Check})`, s: MONEY(f) });
  f = zebra();
  put({ v: "         Refunds - Credits", s: ITALIC(f) }, { v: "", s: BOLD(f) },
      { v: $(s.refTend.rows.find(r => r.key === "Credits").cents), f: `D${refRow.Credits}`, s: MONEY(f) });
  blank(WHITE); blank(WHITE);

  // ── Rec Payment Processing Costs ──────────────────────────────────────────
  const c = s.cost, fe = s.fees;
  put({ v: "Rec Payment Processing Costs", s: HEAD(WHITE) }, { v: "", s: A({ fill: WHITE }) }, { v: "", s: A({ fill: WHITE }) }, 19.5);
  resetStripe();
  f = zebra();
  put({ v: "Method", s: BOLD(f) },
      { v: "Service Fee", s: A({ fill: f, b: true, h: "center" }) }, { v: "", s: A({ fill: f }) });
  // Layout copied from the finance sheet: the rate sits in C, the BASE the rate
  // applies to sits in D on the "variable" row, and D on the "fixed" row
  // carries the combined variable + fixed charge for that block.
  f = zebra(); put({ v: "Credit Card Transactions", s: LABEL(f) }, { v: "", s: A({ fill: f }) }, { v: "", s: A({ fill: f }) });
  f = zebra();
  const rCardVarRate = put({ v: "Variable fee per payment", s: LABEL_R(f) },
    { v: fe.cardRateBps / 10000, s: RATE(f, "0.00%") },
    { v: $(s.revenue.rows.find(r => r.key === "Credit Card").cents), f: `D${revRow["Credit Card"]}`, s: MONEY(f) });
  f = zebra();
  const rCardBlock = put({ v: "Fixed fee per payment", s: LABEL_R(f) },
    { v: $(fe.cardFixedCents), s: RATE(f, '"$"#,##0.00') },
    { v: c.cardBlock, f: `D${revRow["Credit Card"]}*C${rCardVarRate}+C${revRow["Credit Card"]}*C${next()}`, s: MONEY(f) });
  f = zebra(); put({ v: "Credit Card Refunds", s: LABEL(f) }, { v: "", s: A({ fill: f }) }, { v: "", s: A({ fill: f }) });
  f = zebra();
  const rRefVarRate = put({ v: "Variable fee per payment", s: LABEL_R(f) },
    { v: fe.cardRateBps / 10000, s: RATE(f, "0.00%") },
    { v: $(s.refTend.rows.find(r => r.key === "Credit Card").cents), f: `D${refRow["Credit Card"]}`, s: MONEY(f) });
  f = zebra();
  const rRefBlock = put({ v: "Fixed fee per payment", s: LABEL_R(f) },
    { v: $(fe.cardFixedCents), s: RATE(f, '"$"#,##0.00') },
    c.refundFeeCharged
      ? { v: c.refundBlock, f: `D${refRow["Credit Card"]}*C${rRefVarRate}+C${refRow["Credit Card"]}*C${next()}`, s: MONEY(f) }
      : { v: 0, s: MONEY(f) });
  f = zebra();
  const rCashBase = put({ v: "Cash Transactions", s: LABEL(f) }, { v: "", s: A({ fill: f }) },
    { v: $(s.revenue.rows.find(r => r.key === "Cash").cents), f: `D${revRow.Cash}`, s: MONEY(f) });
  f = zebra();
  const rCash = put({ v: "Rec Cash Fee", s: A({ fill: f, h: "right" }) },
    { v: (fe.cashRateBps || 0) / 10000, s: RATE(f, "0.00%") },
    { v: c.cash, f: `D${revRow.Cash}*C${next()}`, s: MONEY(f) });
  f = zebra();
  put({ v: "Check Transactions", s: LABEL(f) }, { v: "", s: A({ fill: f }) },
    { v: $(s.revenue.rows.find(r => r.key === "Check").cents), f: `D${revRow.Check}`, s: MONEY(f) });
  f = zebra();
  const rCheck = put({ v: "Rec Check Fee", s: A({ fill: f, h: "right" }) },
    { v: (fe.checkRateBps || 0) / 10000, s: RATE(f, "0.00%") },
    { v: c.check, f: `D${revRow.Check}*C${next()}`, s: MONEY(f) });
  f = zebra();
  const rCostTotal = put({ v: "Total Rec Fee", s: BOLD(f) }, { v: "", s: A({ fill: f }) },
    { v: c.total, f: `D${rCardBlock}+D${rRefBlock}+D${rCash}+D${rCheck}`, s: MONEY(f, true) });
  blank(WHITE);

  // ── Technology Fees ───────────────────────────────────────────────────────
  let rTech = null;
  if (s.tech) {
    put({ v: "Technology Fees", s: HEAD(WHITE) }, { v: "", s: A({ fill: WHITE, v: "top" }) }, { v: "", s: A({ fill: WHITE, v: "top" }) }, 19.5);
    resetStripe();
    f = zebra();
    const rTechBase = put({ v: "Total Sales", s: A({ fill: f, v: "top" }) }, { v: "", s: A({ fill: f, v: "top" }) },
      { v: $(s.tech.baseCents), f: `D${rRevTotal}`, s: A({ fill: f, fmt: '"$"#,##0.00', v: "top" }) }, 15);
    f = zebra();
    rTech = put({ v: "Technology Fees", s: A({ fill: f, i: true, h: "right", v: "top" }) },
      { v: s.tech.rateBps / 10000, s: A({ fill: f, fmt: "0.00%", h: "center", v: "top" }) },
      { v: s.tech.amount, f: `D${rTechBase}*C${next()}`, s: A({ fill: f, fmt: '"$"#,##0.00', v: "top" }) }, 15);
    blank(WHITE, 15);
  }

  // ── Final Remittance ──────────────────────────────────────────────────────
  put({ v: "Final Remittance", s: HEAD(WHITE) }, { v: "", s: A({ fill: WHITE, v: "top" }) }, { v: "", s: A({ fill: WHITE, v: "top" }) }, 19.5);
  const rCardRev = put({ v: "Credit Card Revenue Collected by Rec", s: LABEL(GREY) }, { v: "", s: A({ fill: GREY }) },
    { v: $(s.final.cardRevenueCents), f: `D${revRow["Credit Card"]}`, s: MONEY(GREY) });
  const rNetCost = put({ v: "        Net Rec Payment Processing Costs", s: LABEL(WHITE) }, { v: "", s: A({ fill: WHITE }) },
    { v: s.final.cost, f: `D${rCostTotal}`, s: MONEY(WHITE) });
  const rNetTech = rTech ? put({ v: "        Net Technology Fee", s: LABEL(WHITE) }, { v: "", s: A({ fill: WHITE }) },
    { v: s.final.tech, f: `D${rTech}`, s: MONEY(WHITE) }) : null;
  const rNetRef = put({ v: "        Net Card Refunds", s: LABEL(GREY) }, { v: "", s: A({ fill: GREY }) },
    { v: $(s.final.cardRefundCents), f: `D${refRow["Credit Card"]}`, s: MONEY(GREY) });
  // The one rounding on the sheet, on the line that is actually paid.
  const subtract = [rNetCost, rNetTech, rNetRef].filter(Boolean).map(r => `D${r}`).join("-");
  put({ v: "Total", s: BOLD(WHITE) }, { v: "", s: A({ fill: WHITE }) },
      { v: $(s.final.totalCents), f: `ROUND(D${rCardRev}-${subtract},2)`, s: MONEY(WHITE, true) });

  // A remittance total computed from invented fees is indistinguishable from a
  // real one, and this file gets emailed to a partner. Drops off the moment the
  // schedule is marked contracted.
  if (fe.rateSource && fe.rateSource !== "contracted") {
    blank();
    put({ v: "DRAFT — fee rates are placeholders, not this organization's contracted schedule.", s: BOLD() });
  }

  const rowHeights = [];
  for (const [i, h] of Object.entries(heights)) rowHeights[+i] = h;

  return {
    name: "Remittance Summary", rows, rowHeights, merges: [],
    widths: [1.38, 34.38, 17.13, 27.75],
    gridlines: false,
    // Anchored just inside B1 and sized to the header band, where the finance
    // sheet puts it.
    image: fs.existsSync(LOGO)
      ? { data: fs.readFileSync(LOGO), col: 1, colOff: 3.75, row: 0, rowOff: 17.25,
          w: 40.5, h: 16.5, name: "rec" }
      : null,
  };
}

function dataSheet(name, columns, src) {
  const th = { sz: 10, name: "Arial", b: true, color: INK };
  const rows = [columns.map(h => ({ v: h, s: th }))];
  for (const r of src) rows.push(columns.map(cName => {
    const v = r[cName];
    if (typeof v === "number") return { v, s: A({ sz: 10, fmt: "#,##0" }) };
    return v === null || v === undefined ? "" : { v: String(v), s: A({ sz: 10 }) };
  }));
  const widths = columns.map(h =>
    /Email|Item Name|Customer Name|Transaction Created By/.test(h) ? 30 :
    /Date|Location|Item Type|Method|Staff/.test(h) ? 18 : 15);
  return { name, rows, widths, freeze: 1, landscape: true };
}

function generate({ org, period, txns, items, fees }) {
  const s = summarize({ txns, items, fees });
  // The summary's SUMIFS ranges have to cover the logs they are computed over,
  // so the row counts travel with the figures.
  s.txnRowCount  = txns.length;
  s.itemRowCount = items.length;
  // ...and so do the columns, for the same reason: the summary addresses the
  // log by letter, so it has to be reading the same sheet it is describing.
  s.txnColumns  = logColumns(txns,  TXN_COLUMNS);
  s.itemColumns = logColumns(items, ITEM_COLUMNS);
  // One set of sheet objects feeds BOTH the workbook and anything that renders
  // it, so the two cannot drift into disagreeing about the same period.
  const sheets = [
    summarySheet(org, period, s),
    dataSheet(TXN_SHEET,  s.txnColumns,  txns),
    dataSheet(ITEM_SHEET, s.itemColumns, items),
  ];
  return { buffer: build(sheets), sheets, summary: s };
}

module.exports = {
  generate, summarize, summarySheet, dataSheet, cents,
  TENDERS, TXN_COLUMNS, ITEM_COLUMNS, TXN_SHEET, ITEM_SHEET, TXN_COL, ITEM_COL,
  logColumns,
};
