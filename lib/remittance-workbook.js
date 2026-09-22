/**
 * The remittance workbook: Summary + Transaction Log + Item Log.
 *
 * Finance builds this by hand once per billing period, per org — pulling the
 * two logs, pasting them into a sheet, and typing the summary on top. This
 * module is that sheet, generated.
 *
 * THE SUMMARY TAB IS A ROW-FOR-ROW REPRODUCTION of the existing hand-built
 * sheet: same four columns (A is the gutter it leaves empty), same section
 * order, same label text, same layout inside the processing-costs block — down
 * to the Refunds table listing five methods where the Revenue table lists six.
 * scripts/remittance-workbook.spec.js drives it over Pleasant Hill's real
 * 2026-09-08 → 2026-09-15 period and asserts every line against that sheet.
 * Don't "tidy" the layout: a generated sheet and a hand-built one get put side
 * by side, and the point is that they line up.
 *
 * Pure — no Express, no Metabase, no fs. Rows in, buffer out.
 */

const { build, S } = require("./xlsx");

/* ── the arithmetic ─────────────────────────────────────────────────────── */

// Money arrives from the card as display strings ("$0", "$1,234.50"). Work in
// CENTS throughout: 3.5% of a float dollar amount rounds differently depending
// on which order you add, and a remittance that is a cent out is a support
// ticket.
function cents(v) {
  if (v === null || v === undefined || v === "") return 0;
  const n = Number(String(v).replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

const isPayment = (r) => String(r.Type || "").toLowerCase() === "payment";
const isRefund  = (r) => String(r.Type || "").toLowerCase() === "refund";

// The six tender columns, in the order the example sheet lists them. Built from
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
  // A $0 registration moves no money and so lands in none of the six columns.
  // Without a row of its own the count column visibly fails to add up to the
  // transaction total — 10 of Niagara Falls' 42 payments are free ones.
  let free = 0;
  for (const r of rows) {
    let touched = 0;
    for (const t of out) {
      const c = cents(r[t.key]);
      if (c !== 0) { t.count += 1; t.cents += c; touched++; }
    }
    if (!touched) free++;
  }
  // Appended rather than in TENDERS: it has no column on the feed, and the
  // hand-built sheet has no row for it, so it only appears where it is real.
  if (free) out.push({ key: "Free", label: "Free", real: false, count: free, cents: 0, synthetic: true });
  const total = out.reduce((s, t) => s + t.cents, 0);
  // A split-tender transaction is counted once per tender it used, so the
  // column of counts does NOT sum to the transaction count when one occurs.
  // The total row carries the real transaction count either way.
  return { rows: out, totalCents: total, txnCount: rows.length, freeCount: free,
           realCents:   out.filter(t =>  t.real).reduce((s,t) => s + t.cents, 0),
           creditCents: out.filter(t => !t.real).reduce((s,t) => s + t.cents, 0) };
}

function salesBlock(txns, items) {
  // "Items Sold" counts the line items a customer actually bought: the
  // transaction-fee lines are the pass-through processing charge, reported on
  // their own line, and counting them would inflate every basket by one.
  const lineItems = items.filter(i => String(i["Item Type"] || "") !== "transaction-fee");
  return {
    txnCount:   txns.length,
    itemCount:  lineItems.length,
    itemsCents: txns.reduce((s, r) => s + cents(r["Cart Value"]), 0),
    taxCents:   txns.reduce((s, r) => s + cents(r["Total Tax on Cart Items"]), 0),
    ticketCents:txns.reduce((s, r) => s + cents(r["Ticket Service Fee"]), 0),
    feeCents:   txns.reduce((s, r) => s + cents(r["Credit Card Processing Fee"]), 0),
    totalCents: txns.reduce((s, r) => s + cents(r["Total Transaction Amount"]), 0),
  };
}

/**
 * fees: { cardRateBps, cardFixedCents, cashRateBps, checkRateBps,
 *         chargeFeeOnRefunds }
 */
function summarize({ txns, items, fees }) {
  const pay = txns.filter(isPayment);
  const ref = txns.filter(isRefund);
  const payItems = items.filter(isPayment);
  const refItems = items.filter(isRefund);

  const sales   = salesBlock(pay, payItems);
  const refunds = salesBlock(ref, refItems);
  const revenue = tenderTable(pay);
  const refTend = tenderTable(ref);

  const cardOf = (t) => t.rows.find(r => r.key === "Credit Card");
  const cashOf = (t) => t.rows.find(r => r.key === "Cash");
  const chkOf  = (t) => t.rows.find(r => r.key === "Check");

  const cardPay = cardOf(revenue), cardRef = cardOf(refTend);
  const cash    = cashOf(revenue), chk     = chkOf(revenue);

  // Rounded once per line, the way a fee schedule is actually applied — not
  // summed at full precision and rounded at the end, which drifts a cent on
  // roughly one period in three.
  const pct = (c, bps) => Math.round(c * bps / 10000);

  const cost = {
    cardVarCents:   pct(cardPay.cents, fees.cardRateBps),
    cardFixedCents: cardPay.count * fees.cardFixedCents,
    refVarCents:    pct(cardRef.cents, fees.cardRateBps),
    refFixedCents:  cardRef.count * fees.cardFixedCents,
    cashCents:      pct(cash.cents, fees.cashRateBps),
    checkCents:     pct(chk.cents,  fees.checkRateBps),
  };
  // Whether Rec bills its fee a second time on the refunded amount is the one
  // rule the Pleasant Hill example cannot settle — that period had no refunds.
  // Off by default: charging 3.5% + $0.30 on a refund bills the org twice for
  // one transaction, and the refunded principal is already withheld below.
  const refundFeeCents = fees.chargeFeeOnRefunds
    ? cost.refVarCents + cost.refFixedCents : 0;
  cost.totalCents = cost.cardVarCents + cost.cardFixedCents
                  + cost.cashCents + cost.checkCents + refundFeeCents;
  cost.refundFeeCharged = !!fees.chargeFeeOnRefunds;

  const final = {
    cardRevenueCents: cardPay.cents,
    costCents:        cost.totalCents,
    cardRefundCents:  cardRef.cents,
  };
  final.totalCents = final.cardRevenueCents - final.costCents - final.cardRefundCents;

  return { sales, refunds, revenue, refTend, cost, final, fees };
}


/* ── the sheets ─────────────────────────────────────────────────────────── */

const TXN_COLUMNS = ["Date","Location","Staff","Transaction ID","Customer Name","Customer Email",
  "Customer Phone","Customer Rec ID","Type","Transaction Created By","Item Count","Cart Value",
  "Total Tax on Cart Items","Cart Sub-Total","Ticket Service Fee","Credits","Cash","Check",
  "Credit Card","Credit Card Processing Fee","Scholarship","Gift Card","Total Transaction Amount","Method"];
const ITEM_COLUMNS = ["Date","Location","Transaction ID","Customer Name","Type","Method","Item Value",
  "Item Type","Fee Category","Item Name","GL Code","Customer Email"];

const d = (c) => c / 100;                      // cents -> a number Excel can sum
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
function longDate(iso) {                        // never new Date(iso): that is UTC midnight
  const [y, m, day] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${day}, ${y}`;
}

function summarySheet(org, period, s) {
  // Column A is the gutter the existing sheet leaves empty; B label, C middle,
  // D value. Kept so a generated sheet and a hand-built one line up cell for
  // cell when they are put side by side.
  const rows = [];
  const put = (b, c, dd) => rows.push([null, b, c, dd]);
  const blank = () => rows.push([]);
  const head  = (t) => put({ v: t, s: S.BOLD });
  const money = (label, cents) => put(label, null, { v: d(cents), s: S.MONEY });
  const count = (label, n) => put(label, null, { v: n, s: S.INT });
  const totalRow = (label, n, cents) => put({ v: label, s: S.BOLD },
    n === null ? null : { v: n, s: S.BOLD_INT }, { v: d(cents), s: S.MONEY_BOLD });
  const pct = (bps) => ({ v: bps / 10000, s: S.PCT });

  // The ticket service fee is a real charge inside Total Sales and the existing
  // sheet has no row for it — Pleasant Hill has none, so it never came up.
  // Shown only where an org actually has one; without it the Sales block does
  // not add up to Total Sales.
  const hasTicket = !!(s.sales.ticketCents || s.refunds.ticketCents);

  blank();
  blank();
  put(null, null, { v: "Remittance Report", s: S.BOLD });
  put({ v: org.name, s: S.BOLD }, null, `${longDate(period.start)} - ${longDate(period.end)}`);
  put(org.address1 || null, null, `Timezone: ${org.timezone}`);
  put(org.address2 || null);
  blank();

  head("Sales Summary");
  count("Total Sales Transactions", s.sales.txnCount);
  count("Items Sold", s.sales.itemCount);
  money("Total Value of Items Sold", s.sales.itemsCents);
  money("Taxes", s.sales.taxCents);
  if (hasTicket) money("Ticket Service Fees", s.sales.ticketCents);
  money("Processing Fees", s.sales.feeCents);
  totalRow("Total Sales", null, s.sales.totalCents);
  blank();

  head("Refunds Summary");
  count("Total Refund Transactions", s.refunds.txnCount);
  count("Items Refunded", s.refunds.itemCount);
  money("Total Value of Items Refunded", s.refunds.itemsCents);
  money("Taxes", s.refunds.taxCents);
  if (hasTicket) money("Ticket Service Fees", s.refunds.ticketCents);
  money("Processing Fees", s.refunds.feeCents);
  totalRow("Total Refunds", null, s.refunds.totalCents);
  blank();

  head("Total Revenue by Payment Method");
  put({ v: "Method", s: S.BOLD }, { v: "Total Payments", s: S.BOLD }, { v: "Total Paid", s: S.BOLD });
  for (const t of s.revenue.rows) put(t.label, { v: t.count, s: S.INT }, { v: d(t.cents), s: S.MONEY });
  totalRow("Total Sales", s.revenue.txnCount, s.revenue.totalCents);
  money("         Revenue - Real Money", s.revenue.realCents);
  money("         Revenue - Credits, Scholarships, Gift Cards Applied", s.revenue.creditCents);
  blank();

  head("Refunds by Payment Method");
  put({ v: "Method", s: S.BOLD }, { v: "Total Payments", s: S.BOLD });
  // The existing sheet lists five methods here — no Gift Card row.
  for (const t of s.refTend.rows.filter(t => t.key !== "Gift Card"))
    put(t.label, { v: t.count, s: S.INT }, { v: d(t.cents), s: S.MONEY });
  totalRow("Total Refunds", s.refTend.txnCount, s.refTend.totalCents);
  money("         Refunds - Real Money", s.refTend.realCents);
  money("         Refunds - Credits", s.refTend.creditCents);
  blank();
  blank();

  const f = s.fees, c = s.cost;
  const tender = (t, k) => t.rows.find(r => r.key === k);
  const card = tender(s.revenue, "Credit Card"), cref = tender(s.refTend, "Credit Card");
  const cash = tender(s.revenue, "Cash"),        chk  = tender(s.revenue, "Check");
  head("Rec Payment Processing Costs");
  put({ v: "Method", s: S.BOLD }, { v: "Service Fee", s: S.BOLD });
  // Layout copied from the existing sheet: the rate sits in C, the BASE the
  // rate applies to sits in D on the "variable" row, and D on the "fixed" row
  // carries the combined variable + fixed charge for that block.
  put("Credit Card Transactions");
  put("Variable fee per payment", pct(f.cardRateBps), { v: d(card.cents), s: S.MONEY });
  put("Fixed fee per payment", { v: d(f.cardFixedCents), s: S.MONEY },
      { v: d(c.cardVarCents + c.cardFixedCents), s: S.MONEY });
  put("Credit Card Refunds");
  put("Variable fee per payment", pct(f.cardRateBps), { v: d(cref.cents), s: S.MONEY });
  put("Fixed fee per payment", { v: d(f.cardFixedCents), s: S.MONEY },
      { v: d(c.refundFeeCharged ? c.refVarCents + c.refFixedCents : 0), s: S.MONEY });
  money("Cash Transactions", cash.cents);
  put("Rec Cash Fee", pct(f.cashRateBps), { v: d(c.cashCents), s: S.MONEY });
  money("Check Transactions", chk.cents);
  put("Rec Check Fee", pct(f.checkRateBps), { v: d(c.checkCents), s: S.MONEY });
  totalRow("Total Rec Fee", null, c.totalCents);
  blank();

  head("Final Remittance");
  money("Credit Card Revenue Collected by Rec", s.final.cardRevenueCents);
  money("         Net Rec Payment Processing Costs", s.final.costCents);
  money("         Net Card Refunds", s.final.cardRefundCents);
  totalRow("Total", null, s.final.totalCents);

  // The one thing added below the existing sheet's last row, and only when the
  // rates are placeholders: a remittance total computed from invented fees is
  // indistinguishable from a real one, and this file gets emailed to a partner.
  // Drops off the moment the schedule is marked contracted.
  if (s.fees.rateSource && s.fees.rateSource !== "contracted") {
    blank();
    put({ v: "DRAFT — fee rates are placeholders, not this organization's contracted schedule.", s: S.BOLD });
  }

  return { name: "Summary", rows, merges: [], widths: [3, 46, 16, 18] };
}

function dataSheet(name, columns, src) {
  const rows = [columns.map(h => ({ v: h, s: S.BOLD }))];
  for (const r of src) rows.push(columns.map(cName => {
    const v = r[cName];
    return typeof v === "number" ? { v, s: S.INT } : (v === null || v === undefined ? "" : String(v));
  }));
  const widths = columns.map(h =>
    /Email|Item Name|Customer Name|Transaction Created By/.test(h) ? 30 :
    /Date|Location|Item Type|Method|Staff/.test(h) ? 18 : 15);
  return { name, rows, widths, freeze: 1, landscape: true };
}

function generate({ org, period, txns, items, fees }) {
  const s = summarize({ txns, items, fees });
  // One set of sheet objects feeds BOTH the workbook and the PDF, so the two
  // cannot drift into disagreeing about the same period.
  const sheets = [
    summarySheet(org, period, s),
    dataSheet("Transaction Log", TXN_COLUMNS, txns),
    dataSheet("Item Log", ITEM_COLUMNS, items),
  ];
  return { buffer: build(sheets), sheets, summary: s };
}

module.exports = {
  generate, summarize, summarySheet, dataSheet, cents,
  TENDERS, TXN_COLUMNS, ITEM_COLUMNS,
};
