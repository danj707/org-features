/**
 * Remittance — per-org Item Log exports, one billing period at a time.
 *
 * Finance re-ran the product's "Item Log" export by hand once per billing
 * period, for every org. This module turns that into a report: pick an ending
 * remittance date, then click any org's date to download that org's CSV.
 *
 * Routes (both behind auth — this is fleet-wide finance data):
 *   GET /api/remittance             → periods + orgs + config state
 *   GET /api/remittance/csv         → the export itself (?org=<uuid>&end=<date>)
 *
 * Data source: Metabase card "✅ Item Log Report" (question 19900), a shared,
 * org-parameterized public card reading materialized.item_log_report. Unlike
 * the adoption snapshot this is fetched live per request — an item log is
 * transactional and must not be served from a day-old bake.
 *
 * The generated CSV is a drop-in replacement for the product's own Item Log
 * export: same 12 columns, same column order, same value formatting, same rows.
 * Validated against a real manual export (Chico, 2026-08-08 → 2026-08-15):
 * identical 1,180 rows and identical totals, methods and item-type counts.
 * The card's SQL carries two non-obvious rules that make that true —
 * Transaction ID is the last 8 hex of transaction_event_batch_id, and a zero
 * amount renders "$0" not "$0.00" — so don't reformat values here.
 *
 * One deliberate difference: rows sharing the same timestamp can come out in a
 * different sequence than the product's export. The product has no tie-break,
 * so its own order isn't reproducible run to run; the card sorts by
 * order_item_transaction_id within a timestamp so the same period always
 * exports identically. Row content is unaffected.
 */

const fs   = require("fs");
const path = require("path");

const METABASE_URL = process.env.METABASE_URL || "https://rec.metabaseapp.com";

// Public sharing UUID of Metabase card 19900 ("✅ Item Log Report"). Not a
// secret — it's a public link — so it lives in code, with an env override for
// pointing at a replacement card without a deploy. Empty ⇒ the report renders
// an explicit "not connected" state rather than failing.
const ITEM_LOG_UUID = process.env.ITEM_LOG_UUID || "4e02f94d-3658-4c67-b371-41dbbc677831";

// Metabase's own query timeout is the real ceiling; this just stops a hung
// socket from holding the response open forever.
const FETCH_TIMEOUT_MS = Number(process.env.ITEM_LOG_TIMEOUT_MS || 120000);

// The report starts here: 2026-08-15 is the first ending remittance date it
// covers. Earlier 2026 periods are in the schedule file for completeness but
// predate the report, so they aren't offered.
const FIRST_PERIOD_END = "2026-08-15";

// Column order of the product's Item Log export. Used as the header when a
// period has no transactions, so finance still gets a well-formed file.
const ITEM_LOG_COLUMNS = [
  "Date", "Location", "Transaction ID", "Customer Name", "Type", "Method",
  "Item Value", "Item Type", "Fee Category", "Item Name", "GL Code", "Customer Email",
];

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

/** Match the product export: every field quoted, quotes doubled, LF endings. */
function rowsToCsv(rows) {
  // Helper columns the card emits for the UI (leading "_") never reach the file.
  const cols = rows.length
    ? Object.keys(rows[0]).filter(k => !k.startsWith("_"))
    : ITEM_LOG_COLUMNS;
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
let _paramCache = null; // { uuid, bySlug, fetchedAt }
const PARAM_CACHE_MS = 60 * 60 * 1000;

async function cardParams() {
  const fresh = _paramCache
    && _paramCache.uuid === ITEM_LOG_UUID
    && (Date.now() - _paramCache.fetchedAt) < PARAM_CACHE_MS;
  if (fresh) return _paramCache.bySlug;

  const resp = await fetch(`${METABASE_URL}/api/public/card/${ITEM_LOG_UUID}`,
                           { signal: AbortSignal.timeout(30000) });
  if (!resp.ok) {
    throw new Error(`could not read the Item Log card (${resp.status}) — is its public link still enabled?`);
  }
  const card = await resp.json();
  const bySlug = {};
  for (const p of card.parameters || []) bySlug[p.slug] = p;
  for (const need of ["org_id", "start_date", "end_date"]) {
    if (!bySlug[need]) throw new Error(`the Item Log card has no "${need}" parameter`);
  }
  _paramCache = { uuid: ITEM_LOG_UUID, bySlug, fetchedAt: Date.now() };
  return bySlug;
}

/** Fetch one org's item log for one period straight from the public card. */
async function fetchItemLog(orgId, startDate, endDate) {
  const bySlug = await cardParams();
  const values = { org_id: orgId, start_date: startDate, end_date: endDate };
  const params = Object.keys(values).map(slug => ({
    id:     bySlug[slug].id,
    type:   bySlug[slug].type,
    target: bySlug[slug].target,
    value:  values[slug],
  }));

  const url = `${METABASE_URL}/api/public/card/${ITEM_LOG_UUID}/query/json`
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
      configured: !!ITEM_LOG_UUID,
      today,
      currentPeriodEnd: cur ? cur.end : null,
      periods: periods().map(p => ({ ...p, status: periodStatus(p, today) })),
      orgs: loadOrgs(),
    });
  });

  app.get("/api/remittance/csv", requireAuth, async (req, res) => {
    const orgId = String(req.query.org || "");
    const end   = String(req.query.end || "");
    if (!ITEM_LOG_UUID) {
      return res.status(503).type("text/plain")
        .send("Item Log isn't connected yet — set ITEM_LOG_UUID (the Metabase card's public link UUID) on the server.");
    }
    const period = findPeriod(end);
    if (!period) return res.status(400).type("text/plain").send(`Unknown remittance period "${end}".`);

    const org = loadOrgs().find(o => o.id === orgId);
    if (!org) return res.status(404).type("text/plain").send("Unknown organization.");

    try {
      const rows = await fetchItemLog(org.id, period.start, period.end);
      const name = `item-log-${slugify(org.displayName || org.slug)}-${period.start}-to-${period.end}.csv`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
      res.setHeader("Cache-Control", "no-store");
      console.log(`[remittance] ${org.displayName} ${period.start}→${period.end}: ${rows.length} rows`);
      return res.send(rowsToCsv(rows));
    } catch (err) {
      console.error(`[remittance] ${org.displayName} ${period.label} failed: ${err.message}`);
      return res.status(502).type("text/plain").send(`Could not build the item log: ${err.message}`);
    }
  });
}

module.exports = { mount, rowsToCsv, periods, currentPeriod, periodStatus, ITEM_LOG_COLUMNS };
