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
 *   GET /api/remittance/csv  → the export (?org=<uuid>&end=<date>&report=<key>)
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
const TRANSACTION_LOG_UUID = process.env.TRANSACTION_LOG_UUID || "";

// The reports offered per org, in column order on the dashboard.
const REPORTS = {
  itemlog: { key: "itemlog", label: "Item log",        file: "item-log",        uuid: ITEM_LOG_UUID },
  txnlog:  { key: "txnlog",  label: "Transaction log", file: "transaction-log", uuid: TRANSACTION_LOG_UUID },
};
const DEFAULT_REPORT = "itemlog";

// Metabase's own query timeout is the real ceiling; this just stops a hung
// socket from holding the response open forever.
const FETCH_TIMEOUT_MS = Number(process.env.ITEM_LOG_TIMEOUT_MS || 120000);

// The report starts here: 2026-08-15 is the first ending remittance date it
// covers. Earlier 2026 periods are in the schedule file for completeness but
// predate the report, so they aren't offered.
const FIRST_PERIOD_END = "2026-08-15";

// Column order of each product export. Only used as the header when a period
// has no rows at all, so finance still gets a well-formed file with the right
// shape instead of an empty one.
const ITEM_LOG_COLUMNS = [
  "Date", "Location", "Transaction ID", "Customer Name", "Type", "Method",
  "Item Value", "Item Type", "Fee Category", "Item Name", "GL Code", "Customer Email",
];
const TRANSACTION_LOG_COLUMNS = [
  "Date", "Location", "Staff", "Transaction ID", "Customer Name", "Customer Email",
  "Customer Phone", "Customer Rec ID", "Type", "Transaction Created By", "Item Count",
  "Cart Value", "Total Tax on Cart Items", "Cart Sub-Total", "Ticket Service Fee",
  "Credits", "Cash", "Check", "Credit Card", "Credit Card Processing Fee",
  "Scholarship", "Gift Card", "Total Transaction Amount", "Method",
];
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

/** Every period the report covers, oldest first. */
function periods() {
  const years = (_schedule && _schedule.years) || {};
  return Object.keys(years).sort()
    .flatMap(y => years[y])
    .filter(p => p.end >= FIRST_PERIOD_END);
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
  const all = periods();
  const closed = all.filter(p => p.end < today);
  return closed.length ? closed[closed.length - 1] : (all[0] || null);
}

/**
 *   due      — closed, payment not yet issued (the export is needed now)
 *   paid     — payment date has passed; ACH may still be landing
 *   upcoming — period hasn't closed yet
 */
function periodStatus(p, today = new Date().toISOString().slice(0, 10)) {
  if (p.end >= today) return "upcoming";
  return p.payBy >= today ? "due" : "paid";
}

/**
 * Match the product export: every field quoted, quotes doubled, LF endings.
 * `fallbackColumns` is the header to use when there are no rows to infer it
 * from — pass the report's own columns so an empty period still exports with
 * the right shape.
 */
function rowsToCsv(rows, fallbackColumns) {
  // Helper columns the card emits for the UI (leading "_") never reach the file.
  const cols = rows.length
    ? Object.keys(rows[0]).filter(k => !k.startsWith("_"))
    : (fallbackColumns || ITEM_LOG_COLUMNS);
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
      periods: periods().map(p => ({ ...p, status: periodStatus(p, today) })),
      orgs: loadOrgs(),
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
}

module.exports = {
  mount, rowsToCsv, periods, currentPeriod, periodStatus,
  ITEM_LOG_COLUMNS, TRANSACTION_LOG_COLUMNS, REPORTS,
};
