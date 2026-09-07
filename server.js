/**
 * Org Features Dashboard — rec.us feature usage & adoption by organization
 *
 * Routes:
 *   GET /                → all-orgs dashboard
 *   GET /org/:slug       → single-org drill-in (same page, client routing)
 *   GET /api/data        → baked data snapshot (orgs, metrics, features, adoption)
 *   GET /api/remittance  → billing periods + orgs for the Remittance report
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
const remittance  = require("./remittance");
const store       = require("./lib/store");

const app  = express();
const PORT = process.env.PORT || 3200;

// Prefer a volume-mounted snapshot (DATA_DIR) over the baked one, so the
// data can be refreshed without a redeploy. Falls back to the repo copy.
const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, "data");
const BAKED_FILE  = path.join(__dirname, "data", "features-data.json");
const VOLUME_FILE = path.join(DATA_DIR, "features-data.json");

function loadSnapshot() {
  /* THE STORE FIRST, then the same two files as before. A snapshot in the
     store is one that was refreshed without a redeploy; the baked copy in the
     repo remains the floor, so this degrades to exactly the old behaviour when
     the store is empty or in disk mode. */
  const stored = store.readsDb() ? store.readJSON("features-data", null) : null;
  if (stored) {
    stored._file = "store";
    return stored;
  }
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

/* THE STORE BOOTS BEFORE listen, NOT BLOCKING IT. The sibling project took
   production down for five minutes by awaiting an import ahead of
   app.listen — the healthcheck never went green and the container was killed.
   So this races a timeout and the server listens regardless; in the worst case
   the store is still hydrating and reads fall through to the volume, which is
   exactly the old behaviour. */
const STORE_BOOT_TIMEOUT_MS = Number(process.env.STORE_BOOT_TIMEOUT_MS || 20000);
const storeReady = Promise.race([
  store.configure({ dataDir: DATA_DIR }),
  new Promise(r => setTimeout(() => r("timeout"), STORE_BOOT_TIMEOUT_MS)),
]).then(m => {
  if (m === "timeout") console.warn(`[store] boot exceeded ${STORE_BOOT_TIMEOUT_MS}ms — serving anyway`);
  return m;
}).catch(e => { console.warn(`[store] boot failed: ${e.message}`); return "disk"; });

/* A POLLED CHANGE HAS TO REACH MODULE-LEVEL STATE. Most of what this app
   reads is read on demand, so refreshing the mirror is enough — but the
   launches cache is folded into a module-level `let`, so a refresh performed
   by another replica has to invalidate it or this one serves the old snapshot
   until it restarts. */
store.onKeyChange(keys => {
  if (keys.includes("launches-data")) _launchCache = null;
  if (keys.includes("features-data")) _snapshot = loadSnapshot() || _snapshot;
  /* Settings are SHARED, so a change made on the other replica has to reach
     this one's cache or two people editing see different pages. */
  if (keys.includes("org-features-settings")) _ofSettings = null;
});

auth.init(DATA_DIR, store);
auth.mountRoutes(app);

app.get("/healthz", (_req, res) => res.json({ ok: true, snapshot: !!_snapshot }));

/* FAILS CLOSED, and deliberately not behind auth.requireAuth alone — this
   reports internal state and kicks an import, so it checks the signup code as
   a shared secret when no admin session is present. The sibling project found
   its own admin helper guarded only "/" and left an equivalent route wide
   open; that is the mistake this avoids rather than repeats. */
app.get("/api/store", auth.requireAuth, auth.requireAdmin, async (_req, res) => {
  await storeReady;
  res.json(store.status());
});
app.post("/api/store/import", auth.requireAuth, auth.requireAdmin, async (_req, res) => {
  await storeReady;
  if (!store.writesDb()) return res.status(409).json({ error: "store is in disk mode — set STORE_DATABASE_URL first" });
  res.json(await store.importFromDisk(["users", "features-data", "ps-data", "launches-data"]));
});

/* THE DRAIN. writeJSON only enqueues its upsert, so a SIGTERM that ended the
   process without this would lose whatever was queued — including a password
   just set. close() flushes and then ends the pool. */
let _shuttingDown = false;
async function shutdown(sig) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[store] ${sig} — draining`);
  try { await store.close(); } catch (e) { console.warn(`[store] drain failed: ${e.message}`); }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

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
  const stored = store.readsDb() ? store.readJSON("ps-data", null) : null;
  if (stored) { res.setHeader("Cache-Control", "no-cache"); return res.json(stored); }
  for (const file of [PS_VOLUME, PS_BAKED]) {
    try {
      res.setHeader("Cache-Control", "no-cache");
      return res.json(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch { /* try next */ }
  }
  res.status(503).json({ error: "no PS snapshot baked yet" });
});

/* The running update log behind /ps/updates. A committed file rather than a
   table or a page-embedded array: an entry then arrives in the same commit as
   the change it describes and is reviewable in the diff. Behind auth with the
   rest of the CX dashboard — it names internal work. */
const UPDATES_BAKED  = path.join(__dirname, "data", "updates.json");
const UPDATES_VOLUME = path.join(DATA_DIR, "updates.json");
app.get("/api/updates", auth.requireAuth, (_req, res) => {
  const stored = store.readsDb() ? store.readJSON("updates", null) : null;
  if (stored) { res.setHeader("Cache-Control", "no-cache"); return res.json(stored); }
  for (const file of [UPDATES_VOLUME, UPDATES_BAKED]) {
    try {
      res.setHeader("Cache-Control", "no-cache");
      return res.json(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch { /* try next */ }
  }
  /* AN EMPTY LOG IS A REAL STATE, not an error — a fresh checkout has one. */
  res.json({ updates: [] });
});

/* ── ORG FEATURES SETTINGS ────────────────────────────────────────────────
   SHARED BY EVERY USER, not per person: Dan's call, and it is the right one
   for a five-person CX dashboard where "which features do we care about" is
   a team decision rather than a personal preference. So it goes through the
   store (durable across a deploy, visible to both replicas) rather than into
   localStorage, and the panel says on screen that a change applies to
   everyone.

   IT IS A VIEW PREFERENCE, NOT A GATE. Hiding a feature or excluding an org
   changes what this page shows and what its adoption score is taken over. It
   changes nothing about the bake, and every hidden thing is still in
   /api/data — so a stale or malformed setting can only ever narrow the view,
   never lose data. That is why the defaults below are "show everything" and
   why an unreadable stored value falls back to them rather than to empty.

   Writes require a signed-in user and NOT admin, because every user shares
   the result and any of them may need to adjust it. `updatedBy` records who
   last changed it, which is the audit trail that matters when a setting is
   shared. Body parsing is the app-wide express.json() — a second parser on
   the route would never see the body, since the first one already consumed
   it. */
let _ofSettings = null;
const OF_SETTINGS_KEY = "org-features-settings";
const OF_SETTINGS_DEFAULT = { hiddenFeatures: [], excludedOrgs: [], updatedAt: null, updatedBy: null };

function ofSettings() {
  if (_ofSettings) return _ofSettings;
  const raw = store.readJSON(OF_SETTINGS_KEY, null);
  _ofSettings = normalizeOfSettings(raw);
  return _ofSettings;
}

/* Bounded on every axis a stored list can grow along, and every entry
   clamped — this is read back into a page and a 10MB array or a 5,000-char
   slug would break it far from here. Unknown keys are dropped rather than
   carried, so a hand-edited row cannot smuggle anything through. */
function normalizeOfSettings(raw) {
  const cleanList = (v, cap) => {
    if (!Array.isArray(v)) return [];
    const out = [];
    for (const x of v) {
      if (typeof x !== "string") continue;
      const t = x.trim().slice(0, 120);
      // A blank entry can never match anything and would sit in the panel
      // looking like a bug.
      if (t && !out.includes(t)) out.push(t);
      if (out.length >= cap) break;
    }
    return out.sort();
  };
  const r = raw && typeof raw === "object" ? raw : {};
  return {
    hiddenFeatures: cleanList(r.hiddenFeatures, 200),
    excludedOrgs: cleanList(r.excludedOrgs, 500),
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt.slice(0, 40) : null,
    updatedBy: typeof r.updatedBy === "string" ? r.updatedBy.slice(0, 120) : null,
  };
}

app.get("/api/org-features-settings", auth.requireAuth, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(ofSettings());
});

app.put("/api/org-features-settings", auth.requireAuth, (req, res) => {
  const next = normalizeOfSettings(req.body);
  next.updatedAt = new Date().toISOString();
  next.updatedBy = (req.user && (req.user.name || req.user.email)) || null;
  store.writeJSON(OF_SETTINGS_KEY, next);
  _ofSettings = next;
  /* Echo what was STORED rather than what was sent, so a caller can see its
     own entries having been clamped or de-duplicated instead of assuming
     they landed verbatim. */
  res.json(next);
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
  /* NEWEST WINS, and the store is just another candidate rather than an
     override — this snapshot self-refreshes on boot, so a container that has
     re-baked since the last store write legitimately holds the fresher copy. */
  const stored = store.readsDb() ? store.readJSON("launches-data", null) : null;
  if (stored && (!best || String(stored.generatedAt) > String(best.generatedAt))) best = stored;
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
  store.writeJSON("launches-data", snap);
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

// Remittance — per-org Item Log exports by billing period. Unlike the baked
// dashboards this queries Metabase live per request: an item log is
// transactional and a day-old snapshot would be wrong for finance. Org names
// and ids come from the features snapshot, so every published org is covered.
remittance.mount(app, {
  requireAuth: auth.requireAuth,
  dataDir: DATA_DIR,
  loadOrgs: () => {
    _snapshot = loadSnapshot() || _snapshot;
    return ((_snapshot && _snapshot.orgs) || [])
      .map(o => ({ id: o.id, slug: o.slug, name: o.name, displayName: o.displayName || o.name }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  },
});

const PAGE       = path.join(__dirname, "public", "dashboard.html");
const PS_PAGE    = path.join(__dirname, "public", "ps.html");
const LOGIN_PAGE = path.join(__dirname, "public", "login.html");
const RESET_PAGE = path.join(__dirname, "public", "reset.html");
app.get("/", (_req, res) => res.sendFile(PAGE));
app.get("/org/:slug", (_req, res) => res.sendFile(PAGE));
app.get("/login", (req, res) => auth.currentUser(req) ? res.redirect("/ps") : res.sendFile(LOGIN_PAGE));
app.get("/reset", (_req, res) => res.sendFile(RESET_PAGE));
// A CLIENT ROUTE THE SERVER DOES NOT SERVE IS A HARD 404 on refresh or on a
// shared link — the page only routes once it has been loaded. /ps/features/:slug
// is the per-org drill-in, and it has to be here or the breadcrumb works while
// pasting the URL does not.
app.get(["/ps", "/ps/bugs", "/ps/reporting", "/ps/remittance", "/ps/admin", "/ps/org/:id",
         "/ps/features", "/ps/features/:slug", "/ps/how", "/ps/updates"],
        auth.requireAuth, (_req, res) => res.sendFile(PS_PAGE));

app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => console.log(`Org Features Dashboard listening on :${PORT}`));
