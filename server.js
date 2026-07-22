/**
 * Org Features Dashboard — rec.us feature usage & adoption by organization
 *
 * Routes:
 *   GET /                → all-orgs dashboard
 *   GET /org/:slug       → single-org drill-in (same page, client routing)
 *   GET /api/data        → baked data snapshot (orgs, metrics, features, adoption)
 *   GET /healthz         → liveness probe
 *
 * Data model: data/features-data.json is a snapshot baked from the live
 * rec.us database (via the Rec Staff MCP) at build time. The deployed
 * server has no direct DB access — refreshing the numbers means re-baking
 * the snapshot and pushing. A DATA_DIR override (Railway volume) is
 * honored so future automated refreshes can drop a newer snapshot without
 * a redeploy.
 */

const express     = require("express");
const compression = require("compression");
const fs          = require("fs");
const path        = require("path");

const app  = express();
const PORT = process.env.PORT || 3200;

// Prefer a volume-mounted snapshot (DATA_DIR) over the baked one, so the
// data can be refreshed without a redeploy. Falls back to the repo copy.
const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, "data");
const BAKED_FILE  = path.join(__dirname, "data", "features-data.json");
const VOLUME_FILE = path.join(DATA_DIR, "features-data.json");

function loadSnapshot() {
  for (const file of [VOLUME_FILE, BAKED_FILE]) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      raw._file = file === VOLUME_FILE && file !== BAKED_FILE ? "volume" : "baked";
      return raw;
    } catch { /* try next */ }
  }
  return null;
}

let _snapshot = loadSnapshot();
console.log(`[data] DATA_DIR=${DATA_DIR} snapshot=${_snapshot ? `${_snapshot._file} (generated ${_snapshot.generatedAt || "?"})` : "MISSING"}`);

app.use(compression());

app.get("/healthz", (_req, res) => res.json({ ok: true, snapshot: !!_snapshot }));

app.get("/api/data", (_req, res) => {
  // Re-read lazily so a volume-dropped refresh is picked up without restart
  _snapshot = loadSnapshot() || _snapshot;
  if (!_snapshot) return res.status(503).json({ error: "no snapshot baked yet" });
  res.setHeader("Cache-Control", "no-cache");
  res.json(_snapshot);
});

const PAGE = path.join(__dirname, "public", "dashboard.html");
app.get("/", (_req, res) => res.sendFile(PAGE));
app.get("/org/:slug", (_req, res) => res.sendFile(PAGE));

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => console.log(`Org Features Dashboard listening on :${PORT}`));
