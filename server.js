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
const auth        = require("./auth");

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
      // When the snapshot file itself last changed — distinct from generatedAt
      // (the time the data was baked), so the UI can tell "same file as before"
      // from "a fresh snapshot was dropped in".
      try { raw._fileModifiedAt = fs.statSync(file).mtime.toISOString(); } catch { /* non-fatal */ }
      return raw;
    } catch { /* try next */ }
  }
  return null;
}

let _snapshot = loadSnapshot();
console.log(`[data] DATA_DIR=${DATA_DIR} snapshot=${_snapshot ? `${_snapshot._file} (generated ${_snapshot.generatedAt || "?"})` : "MISSING"}`);

app.use(compression());
app.use(express.json());
auth.init(DATA_DIR);
auth.mountRoutes(app);

app.get("/healthz", (_req, res) => res.json({ ok: true, snapshot: !!_snapshot }));

app.get("/api/data", (_req, res) => {
  // Re-read lazily so a volume-dropped refresh is picked up without restart
  _snapshot = loadSnapshot() || _snapshot;
  if (!_snapshot) return res.status(503).json({ error: "no snapshot baked yet" });
  // no-store so the dashboard's Refresh button always reaches the server rather
  // than being served a cached copy by the browser or an intermediary.
  res.setHeader("Cache-Control", "no-store, must-revalidate");
  res.json(_snapshot);
});

// PS dashboard (Account Health / Bug Management / CX Reporting) — separate
// baked snapshot, same volume-override rules as the features snapshot.
// Everything PS-related sits behind auth: bug titles and account health
// flags are internal. The adoption dashboard (/) stays public.
const PS_BAKED  = path.join(__dirname, "data", "ps-data.json");
const PS_VOLUME = path.join(DATA_DIR, "ps-data.json");
app.get("/api/ps-data", auth.requireAuth, (_req, res) => {
  for (const file of [PS_VOLUME, PS_BAKED]) {
    try {
      res.setHeader("Cache-Control", "no-cache");
      return res.json(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch { /* try next */ }
  }
  res.status(503).json({ error: "no PS snapshot baked yet" });
});

// Launch pipeline (CX Reporting gantt) — baked from the Airtable Services
// view by scripts/refresh/bake-launches.js. Same volume-override rules.
// POST /api/launches/refresh re-bakes live from Airtable when the server
// has an AIRTABLE_API_KEY (Railway env var); the result is cached in
// memory and written to the volume when one is mounted.
const launchesBake  = require("./scripts/refresh/bake-launches");
const LAUNCH_BAKED  = path.join(__dirname, "data", "launches-data.json");
const LAUNCH_VOLUME = path.join(DATA_DIR, "launches-data.json");
let _launchCache = null;

function loadLaunches() {
  let best = _launchCache;
  for (const file of [LAUNCH_VOLUME, LAUNCH_BAKED]) {
    try {
      const snap = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!best || String(snap.generatedAt) > String(best.generatedAt)) best = snap;
    } catch { /* try next */ }
  }
  return best;
}

app.get("/api/launches", auth.requireAuth, (_req, res) => {
  const snap = loadLaunches();
  if (!snap) return res.status(503).json({ error: "no launches snapshot baked yet" });
  res.setHeader("Cache-Control", "no-cache");
  res.json({ ...snap, refreshAvailable: !!process.env.AIRTABLE_API_KEY });
});

async function refreshLaunches() {
  const snap = await launchesBake.bake(process.env.AIRTABLE_API_KEY);
  _launchCache = snap;
  if (LAUNCH_VOLUME !== LAUNCH_BAKED) {
    try { fs.writeFileSync(LAUNCH_VOLUME, JSON.stringify(snap, null, 2)); } catch { /* volume may be absent/read-only */ }
  }
  return snap;
}

app.post("/api/launches/refresh", auth.requireAuth, async (_req, res) => {
  if (!process.env.AIRTABLE_API_KEY) {
    return res.status(503).json({ error: "Live refresh isn't configured: set AIRTABLE_API_KEY on the server. Data still refreshes with the daily bake." });
  }
  try {
    res.json({ ...(await refreshLaunches()), refreshAvailable: true });
  } catch (err) {
    res.status(502).json({ error: `Airtable refresh failed: ${err.message}` });
  }
});

// Daily self-refresh: the launches snapshot re-bakes on boot when stale
// (each morning's data-refresh commit redeploys the app, so this fires
// daily ~6am ET), plus an hourly staleness backstop in case a deploy
// doesn't happen. No cron or external job needed.
if (process.env.AIRTABLE_API_KEY) {
  const ageHours = () => {
    const snap = loadLaunches();
    return snap && snap.generatedAt ? (Date.now() - new Date(snap.generatedAt)) / 36e5 : Infinity;
  };
  const maybeRefresh = (threshold) => {
    if (ageHours() < threshold) return;
    refreshLaunches()
      .then(s => console.log(`[launches] self-refreshed: ${s.services.length} services`))
      .catch(err => console.error(`[launches] self-refresh failed: ${err.message}`));
  };
  setTimeout(() => maybeRefresh(6), 15 * 1000);            // on boot, if >6h stale
  setInterval(() => maybeRefresh(25), 60 * 60 * 1000);     // hourly backstop, if >25h stale
}

const PAGE       = path.join(__dirname, "public", "dashboard.html");
const PS_PAGE    = path.join(__dirname, "public", "ps.html");
const LOGIN_PAGE = path.join(__dirname, "public", "login.html");
const RESET_PAGE = path.join(__dirname, "public", "reset.html");
app.get("/", (_req, res) => res.sendFile(PAGE));
app.get("/org/:slug", (_req, res) => res.sendFile(PAGE));
app.get("/login", (req, res) => auth.currentUser(req) ? res.redirect("/ps") : res.sendFile(LOGIN_PAGE));
app.get("/reset", (_req, res) => res.sendFile(RESET_PAGE));
app.get(["/ps", "/ps/bugs", "/ps/reporting", "/ps/admin", "/ps/org/:id"], auth.requireAuth, (_req, res) => res.sendFile(PS_PAGE));

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => console.log(`Org Features Dashboard listening on :${PORT}`));
