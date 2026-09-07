/**
 * The Org Features settings: which features the adoption score counts, and
 * which organizations the page shows at all.
 *
 * TWO HALVES, and the second one is the one that decides whether this works.
 * The source half asserts the page and the server say the right things; the
 * LIVE half boots a real server, signs in, saves settings and reads them
 * back. A regex over our own patch is not evidence the server behaves —
 * `SKIP_SOURCE=1` drops the source half so the live half can be shown to
 * catch a regression on its own.
 *
 * The rule this exists to protect: SETTINGS SCOPE, THEY DO NOT DELETE.
 * A hidden feature leaves the score's denominator and the checklist; an
 * excluded org leaves the table, the pulldown, both compare slots, the fleet
 * average and the count. Anything half-applied makes the page disagree with
 * itself about how many orgs there are — the facility-Summary failure, one
 * project over. And nothing ticked must read as "not measured", never as 0%:
 * an empty denominator is not an org that adopted nothing.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "public", "ps.html"), "utf8");
const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const SKIP_SOURCE = process.env.SKIP_SOURCE === "1";

let pass = 0;
const failures = [];
const ok = (c, m) => { if (c) pass++; else failures.push(m); };
const eq = (g, w, m) => ok(JSON.stringify(g) === JSON.stringify(w),
  `${m} — got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`);

function report() {
  if (failures.length) {
    console.error(`\n✗ org-features-settings.spec.js — ${failures.length} failure(s):\n`);
    failures.forEach(f => console.error("  ✗ " + f));
    console.error(`\n${pass} passed, ${failures.length} failed.\n`);
    process.exitCode = 1;
  } else {
    console.log(`✓ org-features-settings.spec.js — ${pass} assertions passed.`);
  }
}

/* Comments are stripped before the source assertions, because the comments in
   both files quote the forms that must NOT come back (auto-save, a zero score,
   a value test) on purpose. LINE comments first: a `/*` inside a `//` comment
   or inside a template literal makes block-first unsound, which has already
   made four assertions in the sibling project pass vacuously. */
const strip = (s) => s.replace(/^[ \t]*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const srcNC = strip(src);
const serverNC = strip(server);

// ── LIFT AND RUN THE VALIDATOR ─────────────────────────────────────────────
// A stored list is read back into a page, so it is bounded on every axis it
// can grow along. Running it beats regexing it: a regex passes on an
// inverted comparison.
{
  const fnSrc = server.slice(server.indexOf("function normalizeOfSettings"),
                             server.indexOf("app.get(\"/api/org-features-settings\""));
  ok(fnSrc.length > 200, "normalizeOfSettings was found and sliced");
  let norm = null;
  try { norm = new Function(fnSrc + "; return normalizeOfSettings;")(); }
  catch (e) { ok(false, "normalizeOfSettings evaluates standalone — threw " + e.message); }

  if (norm) {
    eq(norm(null), { hiddenFeatures: [], excludedOrgs: [], updatedAt: null, updatedBy: null },
       "no stored record normalizes to the everything-shown default");
    eq(norm({}).hiddenFeatures, [], "a record with no lists reads as empty lists");
    eq(norm({ hiddenFeatures: "nope" }).hiddenFeatures, [],
       "a non-array is dropped rather than iterated (a string would spread into characters)");
    eq(norm({ hiddenFeatures: ["b", "a", "b"] }).hiddenFeatures, ["a", "b"],
       "entries are de-duplicated and sorted, so two saves of the same set compare equal");
    eq(norm({ excludedOrgs: ["  slug  "] }).excludedOrgs, ["slug"], "entries are trimmed");
    eq(norm({ excludedOrgs: ["", "  ", "real"] }).excludedOrgs, ["real"],
       "a blank entry is dropped — it can never match an org and would sit in the panel looking like a bug");
    eq(norm({ excludedOrgs: [1, null, {}, "real"] }).excludedOrgs, ["real"],
       "non-strings are dropped rather than coerced");
    eq(norm({ hiddenFeatures: ["x".repeat(400)] }).hiddenFeatures[0].length, 120,
       "an over-long entry is clamped");
    ok(norm({ hiddenFeatures: Array.from({ length: 500 }, (_, i) => "f" + i) }).hiddenFeatures.length <= 200,
       "the feature list is capped");
    ok(norm({ excludedOrgs: Array.from({ length: 900 }, (_, i) => "o" + i) }).excludedOrgs.length <= 500,
       "the org list is capped");
    eq(norm({ hiddenFeatures: ["a"], evil: "x" }).evil, undefined,
       "an unknown key is dropped rather than carried through into the stored record");
    eq(norm({ updatedAt: 12345 }).updatedAt, null, "a non-string updatedAt reads as null");
  }
}

// ── THE SERVER SIDE ────────────────────────────────────────────────────────
if (!SKIP_SOURCE) {
  ok(/app\.get\("\/api\/org-features-settings", auth\.requireAuth/.test(serverNC),
     "reading the settings requires a signed-in user");
  ok(/app\.put\("\/api\/org-features-settings", auth\.requireAuth/.test(serverNC),
     "writing them requires a signed-in user");
  /* DELIBERATELY NOT requireAdmin (Dan: "settings toggle is every user").
     The result is shared, so any signed-in user may need to adjust it. */
  ok(!/org-features-settings", auth\.requireAuth, auth\.requireAdmin/.test(serverNC),
     "...but NOT admin-only — the toggle is every user, by Dan's call");

  const put = serverNC.slice(serverNC.indexOf('app.put("/api/org-features-settings"'),
                             serverNC.indexOf('app.put("/api/org-features-settings"') + 800);
  ok(/normalizeOfSettings\(req\.body\)/.test(put),
     "the PUT normalizes the body rather than storing it verbatim");
  ok(/res\.json\(next\)/.test(put),
     "the PUT echoes what was STORED, so a clamped or de-duplicated entry is visible rather than assumed");
  ok(/updatedBy/.test(put), "who last changed a shared setting is recorded");

  /* THE MODULE CACHE MUST BE INVALIDATED BY A CHANGE ON ANOTHER REPLICA, or
     one container serves a stale settings record until it restarts — the
     same failure the sibling project records for ORGS and the map blobs. */
  const hook = serverNC.slice(serverNC.indexOf("onKeyChange"), serverNC.indexOf("onKeyChange") + 500);
  ok(/org-features-settings/.test(hook) && /_ofSettings = null/.test(hook),
     "a settings change on another replica invalidates this one's cache");

  ok(/store\.writeJSON\(OF_SETTINGS_KEY/.test(serverNC),
     "settings go through the store seam, not straight to disk");
}

// ── THE PAGE: SETTINGS SCOPE EVERY SURFACE ─────────────────────────────────
if (!SKIP_SOURCE) {
  // ANCHORED ON `function Features(` — the open paren only. It was pinned to
  // `function Features()` and broke the moment the component took a prop, a
  // signature change that altered no behaviour, leaving indexOf at -1 and a
  // garbage slice. FOURTH instance in this repo family of a slice pinned to a
  // name rather than to what the code does.
  const feat = srcNC.slice(srcNC.indexOf("function Features("), srcNC.indexOf("function FeatureSettings"));
  ok(feat.length > 500, "the Features component was found and sliced");

  ok(/fetch\("\/api\/org-features-settings"\)/.test(feat), "Features reads the shared settings");
  /* A SETTINGS FETCH THAT FAILS FALLS BACK TO SHOWING EVERYTHING. Failing the
     other way renders an empty dashboard, which reads as "no orgs have
     adopted anything" — and the page says out loud that it is unscoped. */
  ok(/setCfg\(OF_DEFAULT_SETTINGS\)/.test(feat),
     "a settings fetch that fails falls back to showing everything, not to hiding everything");
  ok(/cfgErr \?/.test(feat), "...and says so on screen rather than silently pretending it is scoped");

  // THE SCORE IS TAKEN OVER THE TRACKED SET, which is the whole point.
  const scoreFn = (feat.match(/const scoreOf = [\s\S]*?\n    \};/) || [""])[0];
  ok(scoreFn.length > 60, "scoreOf was found");
  ok(/shown\.filter/.test(scoreFn) && /shown\.length/.test(scoreFn),
     "the adoption score's numerator AND denominator are the tracked set, not every measured feature");
  ok(/!a\) return null/.test(scoreFn),
     "an org the bake never measured scores null, not 0 — unmeasured is not zero");
  ok(/!shown\.length\) return null/.test(scoreFn),
     "with nothing ticked the score is null, never 0% — an empty denominator is not an org that adopted nothing");

  ok(/const shown = allMeasured\.filter\(k => !hidden\.has\(k\)\)/.test(feat),
     "the tracked set is the measured set minus what settings hide");

  // EXCLUSION APPLIES ONCE, ABOVE EVERYTHING. `all` is what every surface
  // reads; a second filter further down is how one surface gets missed.
  ok(/const all = everyOrg\.filter\(o => !excluded\.has\(o\.slug\)\)/.test(feat),
     "excluded orgs are filtered out once, in the set every surface reads");
  for (const [what, re] of [
    // The quick view is applied TO the settings-scoped set, so no view can
    // widen the page past an excluded org — one assertion pinning both facts.
    ["the table (through the quick view)", /ofApplyQuickView\(view, all\.filter/],
    ["the fleet average", /scoredAll = all\.map\(decorate\)/],
    ["the pulldown and both compare slots", /const orgOptions = all\.map/],
    ["compare slot A", /cmpA \? all\.find/],
    ["compare slot B", /cmpB \? all\.find/],
    ["the org count", /"data-feat-orgs": all\.length/],
  ]) ok(re.test(feat), `${what} reads the excluded-filtered set`);

  /* EVERY PER-FEATURE SURFACE COMES OFF `groups`, WHICH COMES OFF `shown`.
     The old expand-on-click checklist iterated `shown` directly and this
     asserted that; the checklist is now the always-on fingerprint plus the
     drill-in's per-category panels, so the invariant moved to the one place
     the categories are built. If `groups` were built from `allMeasured`,
     every one of those surfaces would list features the score ignores. */
  ok(/const groups = \(d\.featureCategories \|\| \[\]\)/.test(feat),
     "the feature groups come from the catalog's own categories");
  ok(/keys: shown\.filter\(k => byKey\[k\] && byKey\[k\]\.category === cat\)/.test(feat),
     "...and hold only TRACKED features, so a hidden feature leaves every group surface");
  ok(/\.filter\(g => g\.keys\.length > 0\)/.test(feat),
     "a group whose features are all hidden gets no column at all, rather than a permanent 0/0");
  ok(/const notUsing = \(s2\) => shown\.filter/.test(feat),
     "the not-using callout is over the tracked set");
  const gapLine = (feat.match(/"data-feat-miss": miss\.length[\s\S]{0,1400}/) || [""])[0];
  ok(gapLine.length > 300, "the gap line was found");
  ok(/g\.keys\.filter\(k => !adoptedIn\(r\.o\.slug, k\)\)/.test(gapLine),
     "the gap line is built from each group's TRACKED features");
  ok(!/allMeasured/.test(gapLine), "...and never the full measured set");

  // THE GAP LIST IN THE COMPARISON is over the tracked set too, or A/B
  // reports a difference on a feature the reader untracked.
  ok(/const gap = \(x, y\) => shown\.filter/.test(feat),
     "the A/B gap list is over the tracked set");

  /* EXCLUDED IS NEVER HIDDEN. A count that quietly drops orgs is how a fleet
     figure stops being trusted, so the page states what settings removed. */
  ok(/"data-feat-scopenote"/.test(feat), "the page states on screen what settings have scoped out");
  ok(/Nothing is deleted/.test(src), "...and says nothing is deleted");

  // The launch flag is rendered per org, since the org set now includes
  // pre-launch accounts (Dan asked for both, marked).
  ok(/"data-feat-launched"/.test(feat), "each row says whether the org is live on rec.us");
  ok(/o\.launched/.test(feat), "the tag reads the snapshot's launched flag");

  ok(/"data-feat-gear"/.test(feat), "there is a gear that opens the settings");
  ok(/e\(FeatureSettings, \{/.test(feat), "the gear mounts the settings sheet");
}

// ── THE SHEET ──────────────────────────────────────────────────────────────
if (!SKIP_SOURCE) {
  const sh = srcNC.slice(srcNC.indexOf("function FeatureSettings"), srcNC.indexOf("function HowItWorks()"));
  ok(sh.length > 500, "the FeatureSettings component was found and sliced");

  /* PORTALLED ONTO <body>. The sibling project shipped this bug twice: a sheet
     rendered inside a styled container inherits its text-transform, colour and
     flex-direction, and its Save button loses to the container's own button
     rule and renders inert — which reads as "the settings page doesn't work"
     rather than as a CSS problem. */
  ok(/ReactDOM\.createPortal/.test(sh), "the sheet is portalled onto <body>, out of any container's cascade");

  /* DRAFT-THEN-SAVE, never auto-save (Dan, on the sibling panel: "don't love
     the 'auto save', cause it actually didn't"). This is SHARED state, so a
     half-made change must not reach everyone the moment a box is ticked. */
  ok(/disabled: !dirty \|\| saving/.test(sh), "Save is off until the draft differs from what the server holds");
  ok(/const dirty = !sameSet/.test(sh), "dirty is a real comparison against the stored record, not a click flag");
  ok(/Nothing to save/.test(sh),
     "a disabled Save says why — a greyed button with no explanation is what invites \"it didn't save\"");
  ok(/applies this to everyone/.test(sh), "...and an enabled one says the change is shared");
  ok(!/onChange:[^\n]*save\(\)/.test(sh), "ticking a box does not save on its own");

  // The features are grouped by the catalog's OWN category. Dan deferred
  // sub-features, so no second taxonomy is invented here.
  ok(/category/.test(sh), "features are grouped by the catalog's existing category");
  ok(/"data-feat-fchk"/.test(sh), "each feature has a checkbox");
  ok(/"data-feat-ochk"/.test(sh), "each org has a checkbox");
  ok(/"data-feat-save"/.test(sh), "the Save button is addressable");
  ok(/"data-feat-footnote"/.test(sh), "the footnote states which state Save is in");

  /* ALREADY-EXCLUDED ORGS ARE PINNED TO THE TOP, and one whose org has left
     the snapshot is still listed — otherwise an org excluded last month can
     never be un-excluded. */
  ok(/\[\.\.\.excluded\]\.sort\(\)\.map/.test(sh), "already-excluded orgs are listed first");
  ok(/not in this snapshot/.test(sh),
     "an excluded slug whose org has left the snapshot stays listed, so it can still be unticked");

  // The response is what was stored, so the sheet adopts THAT rather than
  // its own draft — a clamped entry must not linger on screen as saved.
  ok(/onSaved\(saved\)/.test(sh), "the sheet adopts the STORED record, not its own draft");

  ok(/OF_DEFAULT_SETTINGS/.test(src), "there is a default settings shape for the fallback path");
}

// ── THE CSS THE SHEET NEEDS ────────────────────────────────────────────────
if (!SKIP_SOURCE) {
  const css = (src.match(/<style>[\s\S]*?<\/style>/) || [""])[0];
  for (const c of ["ofs-back", "ofs-head", "ofs-body", "ofs-grid", "ofs-chk", "ofs-foot", "ofs-save", "ofs-scroll"])
    ok(new RegExp("\\." + c + "\\b").test(css), `.${c} is styled — an unstyled sheet is the bug this rewrites`);
  /* THE SHEET STATES ITS OWN BUTTON STYLE. There is no global button rule on
     this page, so without one Save renders as a browser default next to
     Cancel and nothing marks the primary action. */
  ok(/\.ofs-foot button\.ofs-save\s*\{/.test(css), "Save is styled as the primary action");
  ok(/\.ofs-foot button\.ofs-save:disabled\s*\{/.test(css), "...and has a distinct disabled state");
  /* The org list is the long one — 144 accounts — so it scrolls in its own
     box rather than pushing Save off the bottom of the sheet. */
  ok(/\.ofs-scroll\s*\{[^}]*overflow-y:\s*auto/.test(css), "the org list scrolls inside its own box");
  ok(/\.ofs\s*\{[^}]*max-height/.test(css), "the sheet itself is bounded to the viewport");
}

// ── THE LIVE HALF: boot, sign in, save, read back ──────────────────────────
const PORT = 3407;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of-settings-"));
const env = { ...process.env, PORT: String(PORT), DATA_DIR: dir,
              SESSION_SECRET: "settings-spec", SIGNUP_CODE: "letmein" };
delete env.STORE_DATABASE_URL; delete env.DATABASE_URL; delete env.STORE_MODE;

const child = spawn("node", [path.join(ROOT, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", d => { log += d; });
child.stderr.on("data", d => { log += d; });

let cookie = "";
function req(method, p, body) {
  return new Promise((res, rej) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, timeout: 9000,
      headers: Object.assign({}, cookie ? { cookie } : null,
        payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : null) },
      resp => {
        let b = "";
        resp.on("data", c => b += c);
        resp.on("end", () => {
          const sc = resp.headers["set-cookie"];
          if (sc) cookie = sc.map(s => s.split(";")[0]).join("; ");
          let json = null;
          try { json = JSON.parse(b); } catch { /* not json */ }
          res({ status: resp.statusCode, body: b, json });
        });
      });
    r.on("error", rej);
    r.on("timeout", () => { r.destroy(); rej(new Error("timeout on " + method + " " + p)); });
    if (payload) r.write(payload);
    r.end();
  });
}
const wait = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await wait(250);
    try { up = (await req("GET", "/healthz")).status === 200; } catch { /* not yet */ }
  }
  if (!up) { ok(false, "the server never answered /healthz:\n" + log); return; }

  // REFUSED WITHOUT A SESSION, both ways. A shared setting any signed-in user
  // can change is still not one an anonymous caller may read or write.
  eq((await req("GET", "/api/org-features-settings")).status, 401, "unauthenticated GET is refused");
  eq((await req("PUT", "/api/org-features-settings", { hiddenFeatures: ["x"] })).status, 401,
     "unauthenticated PUT is refused");

  const up1 = await req("POST", "/api/auth/signup",
    { name: "Spec", email: "spec@example.com", password: "hunter2hunter2", code: "letmein" });
  eq(up1.status, 200, "signed up a user for the live half");

  // A FRESH INSTALL HIDES NOTHING. Defaulting the other way would render an
  // empty dashboard on first run.
  const g0 = await req("GET", "/api/org-features-settings");
  eq(g0.status, 200, "the signed-in GET answers");
  eq(g0.json && g0.json.hiddenFeatures, [], "a fresh install hides no features");
  eq(g0.json && g0.json.excludedOrgs, [], "...and excludes no orgs");

  const p1 = await req("PUT", "/api/org-features-settings",
    { hiddenFeatures: ["  b_feature  ", "a_feature", "a_feature", "", 7],
      excludedOrgs: ["zz-test-org"], updatedBy: "someone-else" });
  eq(p1.status, 200, "the PUT is accepted");
  eq(p1.json && p1.json.hiddenFeatures, ["a_feature", "b_feature"],
     "the echoed record is TRIMMED, DE-DUPLICATED and SORTED — the caller sees what was stored");
  eq(p1.json && p1.json.excludedOrgs, ["zz-test-org"], "the excluded org landed");
  ok(p1.json && p1.json.updatedBy === "Spec",
     `updatedBy is the SIGNED-IN user, never what the body claimed — got ${p1.json && p1.json.updatedBy}`);
  ok(p1.json && typeof p1.json.updatedAt === "string", "updatedAt is stamped server-side");

  const g1 = await req("GET", "/api/org-features-settings");
  eq(g1.json && g1.json.hiddenFeatures, ["a_feature", "b_feature"], "the settings read back");
  eq(g1.json && g1.json.excludedOrgs, ["zz-test-org"], "...both lists");

  // IT PERSISTS ACROSS A RESTART. It is shared state read on every page load,
  // and a setting that dies with the container is not a setting.
  child.kill();
  await wait(400);
  const child2 = spawn("node", [path.join(ROOT, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let log2 = "";
  child2.stdout.on("data", d => { log2 += d; });
  child2.stderr.on("data", d => { log2 += d; });
  let up2 = false;
  for (let i = 0; i < 40 && !up2; i++) {
    await wait(250);
    try { up2 = (await req("GET", "/healthz")).status === 200; } catch { /* not yet */ }
  }
  if (!up2) { ok(false, "the server never came back up:\n" + log2); child2.kill(); return; }
  const g2 = await req("GET", "/api/org-features-settings");
  eq(g2.json && g2.json.hiddenFeatures, ["a_feature", "b_feature"], "the settings survive a restart");

  // AN EMPTY SAVE CLEARS, rather than being read as "no change sent" — that
  // is how a reader un-hides everything from the sheet's "all" link.
  const p2 = await req("PUT", "/api/org-features-settings", { hiddenFeatures: [], excludedOrgs: [] });
  eq(p2.json && p2.json.hiddenFeatures, [], "an empty save really clears the list");
  eq((await req("GET", "/api/org-features-settings")).json.excludedOrgs, [], "...and reads back cleared");

  child2.kill();
})()
  .catch(e => { ok(false, "the live half threw: " + e.message + "\n" + log); })
  .then(() => { try { child.kill(); } catch { /* already gone */ } report(); });

// ── WHEN THIS DATA IS FROM ─────────────────────────────────────────────────
// Appended after the live half's .then(report) intentionally: these are
// synchronous source assertions and `pass`/`failures` are module-level, so
// they are counted before report() runs on the microtask queue. (The
// report-goes-last trap recorded in the sibling project is about a spec that
// PRINTS its summary mid-file; here the print is deferred by a promise.)
if (!SKIP_SOURCE) {
  const feat = srcNC.slice(srcNC.indexOf("function Features("), srcNC.indexOf("function FeatureSettings"));

  ok(/"data-feat-asof"/.test(feat), "the Features page states when its data is from");
  /* IT READS THE FEATURES SNAPSHOT'S OWN generatedAt. The shell's sidebar
     line reads the PS/bugs snapshot — a different file on a different
     schedule — and renders at the foot of this page too. Reading that one
     here would put a fresh-looking date over 16-day-old numbers, which is
     the exact failure that went unnoticed. */
  ok(/data-feat-asof": snapAgeDays\(d\.generatedAt\)/.test(feat),
     "...from the FEATURES snapshot's generatedAt, not the shell's ps-data snapshot");
  ok(/snapStale\(d\.generatedAt\)/.test(feat),
     "it reuses the shared staleness helper rather than growing its own comparison");
  ok(/snapAgeLabel\(d\.generatedAt\)/.test(feat), "...and the shared age label");

  /* THE AGE IS MEASURED; "refreshed daily" IS A PROMISE. That exact phrase
     stood on this project for 38 days while nothing refreshed at all. The
     line may describe the SCHEDULE, but the freshness claim has to come
     from the timestamp. */
  const asof = (feat.match(/data-feat-asof[\s\S]*?e\("div", \{ className: "cards" \}/) || [""])[0];
  ok(asof.length > 200, "the as-of block was found and sliced");
  ok(!/refreshed daily|updated daily/i.test(asof),
     "it does not assert freshness as a standing fact — the age is read from the timestamp");
  /* A WARNING WHOSE FIX ONLY A HUMAN CAN PERFORM CARRIES THE LINK. The bake
     is a GitHub Action now, so a stale snapshot is one click from its red X. */
  ok(/actions\/workflows\/refresh-features\.yml/.test(asof),
     "a stale snapshot links to the workflow that should have refreshed it");
  ok(/an unreadable date/.test(asof),
     "a missing or unparseable generatedAt says so rather than rendering Invalid Date");

  // AND THE SHELL'S LINE NAMES ITS OWN SNAPSHOT, or the two are indistinguishable.
  const shell = srcNC.slice(srcNC.indexOf("function App()"));
  ok(/"PS snapshot " \+ new Date\(data\.generatedAt\)/.test(shell),
     "the sidebar names the PS snapshot, so it cannot be read as covering the features page");

  const css = (src.match(/<style>[\s\S]*?<\/style>/) || [""])[0];
  // Matched as a BARE class rule (`.x {`), not `\.x\b` — which also matches a
  // descendant selector like `.asof-stale a { }` and so survived deleting the
  // rule that actually colours the warning. An assertion that a class is
  // mentioned somewhere in the stylesheet is not an assertion that it is
  // styled.
  for (const c of ["asof", "asof-stale", "asof-src"])
    ok(new RegExp("\\." + c + "\\s*\\{").test(css), `.${c} has its own rule`);
  ok(/\.asof-stale\s*\{[^}]*color:/.test(css),
     "the stale warning has its own colour — it is the only thing that makes it read as a warning");
}

// ── THE LIST/DRILL-IN LAYOUT ───────────────────────────────────────────────
// Six asks from Dan, and each one has a way of looking right while being
// wrong, so each is pinned to the thing that would actually regress.
{
  /* BEHIND A TRY/CATCH, and reporting by name. This lift threw a bare
     ReferenceError on a renamed constant and killed the whole spec before a
     single failure printed — fifth instance in this repo family of a guard
     dying instead of failing. */
  let H = null;
  try {
    H = new Function(
      src.slice(src.indexOf("const CAT_SHORT"), src.indexOf("function route()")) +
      "; return { CAT_SHORT, catShort, ofRecAdminUrl, ofGroupScore, ofRatioHeat," +
      " GAP_GROUPS_SHOWN, GAP_NAMES_SHOWN };")();
  } catch (err) {
    ok(false, "the org-features helpers lift and evaluate — THREW: " + err.message);
    H = { CAT_SHORT: {}, catShort: x => x, ofRecAdminUrl: () => null,
          ofGroupScore: () => null, ofRatioHeat: () => ({}), GAP_GROUPS_SHOWN: 0, GAP_NAMES_SHOWN: 0 };
  }

  // 1. SHORT COLUMN LABELS FOR EVERY CATEGORY IN THE DATA. A miss falls back
  //    to the 25-character name and the symptom is a table nobody can read,
  //    so the catalog is the source of the list rather than this file.
  const snap = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "features-data.json"), "utf8"));
  for (const cat of snap.featureCategories) {
    ok(H.CAT_SHORT[cat], `"${cat}" has a short column label`);
    ok(H.catShort(cat).length <= 13, `"${cat}" abbreviates to something a column can hold (got "${H.catShort(cat)}")`);
  }
  eq(H.catShort("Something Unseen"), "Something Unseen",
     "an unknown category falls back to its own name rather than to undefined");

  // 2. THE ADMIN LINK IS ABSENT WITHOUT AN ID, never /admin/o/undefined.
  /* `/home` IS PART OF THE PATH — Dan corrected this after clicking one.
     /admin/o/<uuid> alone is not the org's admin page. Pinned to his own
     example verbatim, so the suffix cannot be dropped as "tidying". */
  eq(H.ofRecAdminUrl("aeba47d0-c97f-49cb-a0e9-93c5af3a68fa"),
     "https://www.rec.us/admin/o/aeba47d0-c97f-49cb-a0e9-93c5af3a68fa/home",
     "the admin link is the real admin landing path, /admin/o/<uuid>/home");
  eq(H.ofRecAdminUrl(null), null, "no id means NO link — a 404 is worse than no link");
  eq(H.ofRecAdminUrl(""), null, "...and an empty id is the same case");
  // The snapshot really carries the uuid this path wants, or the link 404s
  // for every org and no source assertion would notice.
  ok(snap.orgs.every(o => /^[0-9a-f-]{36}$/.test(String(o.id))),
     "every org in the snapshot carries a uuid for the admin link");

  // 3. A GROUP SCORE IS NULL, NOT 0%, WHEN NOTHING IN IT IS TRACKED.
  eq(H.ofGroupScore([], () => true), null, "an empty group scores null — 0/0 is not 'uses none of it'");
  eq(H.ofGroupScore(null, () => true), null, "...and so does a missing one");
  eq(H.ofGroupScore(["a", "b", "c", "d"], k => k !== "d"), { used: 3, total: 4, pct: 75 },
     "a group reports used, total and the rounded share");
  eq(H.ofGroupScore(["a"], () => false), { used: 0, total: 1, pct: 0 },
     "a real zero still reports as zero");

  // 4. THE RATIO RAMP IS LINEAR, and distinct from the count pills' log ramp.
  //    4/4 in a group of four must look like 8/8 in a group of eight.
  eq(H.ofRatioHeat(100).background, H.ofRatioHeat(100).background, "full adoption is one colour");
  ok(H.ofRatioHeat(null).background !== H.ofRatioHeat(0).background,
     "an untracked group and a real zero are coloured differently");
  ok(H.ofRatioHeat(50).background !== H.ofRatioHeat(100).background, "the ramp ramps");
  {
    // LINEAR, checked by the midpoint rather than by reading the formula: a
    // log ramp (what heat() does for counts) puts 50% far above halfway.
    const alpha = s2 => Number((String(s2).match(/,([\d.]+)\)$/) || [0, 0])[1]);
    const a0 = alpha(H.ofRatioHeat(1).background), a50 = alpha(H.ofRatioHeat(50).background),
          a100 = alpha(H.ofRatioHeat(100).background);
    const half = (a50 - a0) / (a100 - a0);
    ok(Math.abs(half - 0.5) < 0.03, `50% sits halfway up the ramp (got ${half.toFixed(3)})`);
  }

  const feat = srcNC.slice(srcNC.indexOf("function Features("), srcNC.indexOf("function FeatureSettings"));

  // 5. THE COUNT PILLS ARE OFF THE LIST (Dan: "Kill the pills"), and the
  //    group columns replaced them. The core counts moved to the drill-in,
  //    where size is context rather than the headline.
  const listPanel = feat.slice(feat.indexOf('"Feature adoption by organization"'));
  ok(listPanel.length > 500, "the list panel was found");
  ok(!/metrics\.map\(m => e\("td"/.test(listPanel),
     "the list no longer renders a column per core COUNT — those measured size, not adoption");
  // Matched through the shared header renderer rather than on a literal
  // e("th") — the columns went sortable and every header now goes through
  // sortTh(), which is the point.
  ok(/groups\.map\(g => sortTh\(catShort\(g\.cat\), g\.cat/.test(listPanel),
     "the header has one column per feature group");
  ok(/ofGroupScore\(g\.keys/.test(listPanel), "...and each cell is that group's own share");
  ok(/"data-feat-grp"/.test(listPanel), "the group cells are addressable");

  /* 6. THE GAP LINE IS THE DEFAULT VIEW, and it is not the old dot strip.
        Dan on that strip: "this set of boxes is pretty unreadable." Two
        things were wrong with it — it DUPLICATED the `9/9` group columns
        directly above it, less legibly (a dot can be counted, not read), and
        it was unlabelled, so telling which box was which meant hovering. The
        row now carries what the columns CANNOT: which features are missing. */
  ok(/className: "gap-row"/.test(listPanel), "every org row is followed by its gap line");
  ok(!/fp-dot|fp-grp|data-feat-fp/.test(src),
     "the unreadable dot strip is gone, not merely hidden");
  ok(!/isOpen \?/.test(listPanel) && !/setOpen\(/.test(listPanel),
     "it is not gated behind a click — the gaps are the default view");

  /* 7. THE GAPS ARE CLUSTERED BY GROUP AND NAMED. A flat comma list of 40
        features is a paragraph; "Payments 5" is a number to wonder about.
        Grouped, ordered worst-first, with the names. */
  ok(/"data-feat-miss"/.test(listPanel), "the gap line is addressable");
  ok(/Not using " \+ miss\.length/.test(listPanel), "it names the count");
  ok(/className: "gapclus"/.test(listPanel), "the gaps are clustered by group");
  ok(/\.sort\(\(x, y\) => y\.gone\.length - x\.gone\.length/.test(listPanel),
     "...ordered by how many are missing, so the worst gap reads first");
  ok(/x\.cat\.localeCompare\(y\.cat\)/.test(listPanel),
     "...with a name tie-break, so two renders cannot disagree");
  ok(/x\.gone\.slice\(0, GAP_NAMES_SHOWN\)\.map\(label\)/.test(listPanel),
     "each cluster names its features rather than just counting them");
  /* WHAT WAS TRIMMED IS STATED. A capped list that does not say it is capped
     reads as the whole answer, which is how 55 gaps look like 12. */
  ok(/more in " \+ restGroups/.test(listPanel), "the trimmed groups are counted on screen");
  ok(/x\.gone\.length > GAP_NAMES_SHOWN[\s\S]{0,120}x\.gone\.length - GAP_NAMES_SHOWN/.test(listPanel),
     "...and so are the trimmed names inside a cluster");
  ok(/Using every tracked feature/.test(listPanel),
     "a fully-adopted org says so rather than rendering an empty line");
  ok(H.GAP_GROUPS_SHOWN > 0 && H.GAP_GROUPS_SHOWN <= 6,
     `the group cap is a readable number (got ${H.GAP_GROUPS_SHOWN})`);
  ok(H.GAP_NAMES_SHOWN > 0 && H.GAP_NAMES_SHOWN <= 6,
     `the per-cluster name cap is a readable number (got ${H.GAP_NAMES_SHOWN})`);
  const css = (src.match(/<style>[\s\S]*?<\/style>/) || [""])[0];
  ok(/\.gapline\s*\{[^}]*flex-wrap:\s*wrap/.test(css),
     "the gap line wraps rather than clipping — a trimmed name is worse than a second line");
  ok(/\.gaplabel\.ok\s*\{[^}]*color:/.test(css),
     "a fully-adopted org's label is coloured differently from a gap count");

  // 8. CLICKING AN ORG STAYS IN THE SHELL. A plain href would be a full page
  //    load out of the app; every other drill-in here routes through nav().
  ok(/nav\("\/ps\/features\/" \+ encodeURIComponent\(r\.o\.slug\)\)/.test(listPanel),
     "a row opens the drill-in through nav(), keeping the sidebar");
  ok(/onClick: ev => ev\.stopPropagation\(\)/.test(feat),
     "the admin link does not also trigger the row's own navigation");

  // 9. THE ROUTE, ITS TITLE AND ITS SERVER ENTRY. The header reads
  //    titles[r.page][0], so a route with no title BLANKS the dashboard; and
  //    a client route the server does not serve is a hard 404 on refresh.
  const routeFn = src.slice(src.indexOf("function route()"), src.indexOf("function nav("));
  ok(/\^\\\/ps\\\/features\\\/\(\.\+\)\$/.test(routeFn), "/ps/features/<slug> is parsed");
  ok(routeFn.indexOf("featureorg") < routeFn.indexOf('p.startsWith("/ps/features")'),
     "...BEFORE the bare prefix test, which would otherwise swallow the slug");
  ok(/featureorg: \["Org Features"/.test(src), "featureorg has a titles entry");
  ok(/"\/ps\/features\/:slug"/.test(server), "the server serves the drill-in path");

  // 10. THE DRILL-IN. One component owns the fetch and the settings, so the
  //     list and the detail cannot disagree about the tracked set.
  ok(/function Features\(\{ slug \}\)/.test(feat), "the component takes the slug");
  ok(/if \(slug\) \{/.test(feat), "...and renders the drill-in from the same data");
  ok((src.match(/fetch\("\/api\/org-features-settings"\)/g) || []).length === 1,
     "the settings are fetched in exactly ONE place");
  ok((src.match(/fetch\("\/api\/data"\)/g) || []).length === 1,
     "...and so is the snapshot");
  ok(/"data-feat-crumb"/.test(feat), "the drill-in carries a breadcrumb");
  ok(/link\("\/ps\/features", "Org Features"\)/.test(feat),
     "...whose back link routes in-shell rather than reloading the page");
  ok(/is in this snapshot/.test(feat),
     "an unknown slug says so rather than rendering an empty page");
  ok(/"data-feat-exclnote"/.test(feat),
     "a deep link to an EXCLUDED org still works and says why it is not in the list");

  // 11. EVERY CATEGORY, USED AND UNUSED, with the measured figure beside what
  //     is in use — read from the snapshot's own `detail` string rather than
  //     re-derived, so the page cannot phrase a number differently.
  ok(/"data-feat-cat"/.test(feat), "the drill-in renders a panel per category");
  ok(/const detailOf = \(s2, k\) =>/.test(feat), "there is one accessor for a feature's measured detail");
  ok(/\.detail \|\| ""/.test(feat), "...reading the snapshot's own phrasing");
  ok(/catlab on/.test(feat) && /catlab off/.test(feat), "each category shows in-use AND not-in-use");
  /* A GAP YOU CANNOT NAME IS NOT AN ACTIONABLE GAP. Dan: "unclear on some of
     these features like 'guest participation' and 'instructor
     certifications'" — both were in the not-in-use list with their
     explanation hidden in a title attribute. */
  // SCOPED TO EACH SURFACE. Asserted file-wide, a mutation that reverted the
  // per-category column to a hover still matched the gaps panel's copy and
  // failed by the wrong name. A guard that fires on the wrong assertion has
  // told the next person the wrong thing.
  const catCols = (feat.match(/catlab off[\s\S]{0,700}/) || [""])[0];
  ok(catCols.length > 200, "the not-in-use column was found");
  ok(/className: "catdesc"/.test(catCols),
     "an unused feature carries its description ON SCREEN in its category panel, not in a hover");
  const gapsPanel = (feat.match(/className: "gapitem"[\s\S]{0,400}/) || [""])[0];
  ok(gapsPanel.length > 100, "the leading gaps panel was found");
  ok(/className: "catdesc"/.test(gapsPanel),
     "...and in the leading gaps panel too, which is where a reader looks first");
  {
    const snap2 = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "features-data.json"), "utf8"));
    const missing = snap2.features.filter(f => !f.description || f.description.length < 20);
    eq(missing.length, 0,
       `every catalog feature has a real one-line description, or the fix renders nothing for it — missing: ${missing.map(f => f.key).join(", ")}`);
  }
  ok(/"data-feat-gaps"/.test(feat), "the gaps panel is addressable");
  ok(/Fully adopted: /.test(feat),
     "a group with no gaps is still reported — otherwise the panel silently omits whole groups");
  ok(/"data-feat-orgscore"/.test(feat), "the drill-in states the org's adoption score");
  ok(/metrics\.map\(m => e\("div", \{ className: "card", key: m\.key \}/.test(feat),
     "the core counts moved to the drill-in rather than being deleted");
}

// ── QUICK VIEWS ────────────────────────────────────────────────────────────
// LIFTED AND RUN. The one mistake that matters here is a direction — "lowest
// adoption" showing the top — and a regex over a comparator passes just as
// happily inverted.
{
  const Q = new Function(
    src.slice(src.indexOf("const OF_QUICK_VIEWS"), src.indexOf("function route()")) +
    "; return { OF_QUICK_VIEWS, ofQuickView, ofApplyQuickView };")();
  const snap = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "features-data.json"), "utf8"));
  const measured = new Set(snap.measuredFeatures);

  ok(Q.OF_QUICK_VIEWS.length >= 10, `there are ten or so quick views (got ${Q.OF_QUICK_VIEWS.length})`);
  const ids = Q.OF_QUICK_VIEWS.map(v => v.id);
  eq(new Set(ids).size, ids.length, "the view ids are unique — two chips sharing one id is one dead chip");
  for (const v of Q.OF_QUICK_VIEWS) {
    ok(v.label && v.label.length <= 22, `"${v.id}" has a chip-sized label (got "${v.label}")`);
    /* EVERY CHIP CARRIES A TITLE saying what it ranks by. "Top SMS" alone
       does not say whether that is by volume or by configuration date. */
    ok(v.title && v.title.length > 15, `"${v.id}" explains itself on hover`);
    ok(v.kind === "rank" || v.kind === "feature", `"${v.id}" has a known kind`);
    /* A FEATURE VIEW MUST NAME A KEY THE BAKE ACTUALLY MEASURES. A renamed
       metric would otherwise leave a chip that scopes to nothing, and the
       zero-count filter would hide it — a chip that silently disappears is
       how a filter stops being trusted. */
    if (v.kind === "feature")
      ok(measured.has(v.key), `"${v.id}" ranks on a measured feature (${v.key})`);
    if (v.kind === "rank") ok(v.dir === 1 || v.dir === -1, `"${v.id}" has a direction`);
  }
  // The two Dan named by hand.
  ok(Q.OF_QUICK_VIEWS.some(v => v.key === "sms_messaging"), "there is an SMS view");
  ok(Q.OF_QUICK_VIEWS.some(v => v.key === "ticket_sales"), "there is a ticketing view");
  ok(ids.includes("top") && ids.includes("lowest"), "top and lowest adoption are both offered");
  eq(Q.ofQuickView("nope"), null, "an unknown id resolves to null rather than throwing");

  /* THE FEATURES ARE NARROW ENOUGH TO SCAN — measured, not assumed. A chip
     for a feature 110 of 144 orgs use lists most of the platform and answers
     nothing, which is the whole reason this set was chosen from the data. */
  for (const v of Q.OF_QUICK_VIEWS.filter(x => x.kind === "feature")) {
    const users = Object.keys(snap.adoption).filter(s2 => (snap.adoption[s2][v.key] || {}).adopted);
    ok(users.length > 0 && users.length <= 70,
       `"${v.id}" scopes to a scannable slice — ${users.length} of ${snap.orgs.length} orgs use ${v.key}`);
  }

  // ── the reducer ──
  const mk = (slug, score, launched, n) => ({ o: { slug, displayName: slug, launched }, score, _n: n });
  const rows = [mk("a", 90, true, 5), mk("b", 10, true, 100), mk("c", 50, false, 0),
                mk("d", null, true, 7), mk("e", 30, false, 50)];
  const countOf = (slug, k) => (rows.find(r => r.o.slug === slug) || { _n: 0 })._n;

  eq(Q.ofApplyQuickView(null, rows, countOf).rows.length, 5, "no view leaves the rows alone");

  const top = Q.ofApplyQuickView(Q.ofQuickView("top"), rows, countOf);
  eq(top.rows.map(r => r.o.slug), ["a", "c", "e", "b"], "Top adoption ranks highest first");
  ok(!top.rows.some(r => r.score == null),
     "an UNSCORED org is dropped from a ranked view — 'we cannot tell' is not a score");

  const low = Q.ofApplyQuickView(Q.ofQuickView("lowest"), rows, countOf);
  eq(low.rows.map(r => r.o.slug), ["b", "a"], "Lowest adoption ranks lowest first AND live-only");
  ok(low.rows[0].score < top.rows[0].score,
     "the two adoption views really are opposite ends — the direction is not inverted");

  const pre = Q.ofApplyQuickView(Q.ofQuickView("prelaunch"), rows, countOf);
  eq(pre.rows.map(r => r.o.slug), ["c", "e"], "Pre-launch progress keeps only unlaunched orgs, best first");

  const sms = Q.ofApplyQuickView(Q.ofQuickView("sms"), rows, countOf);
  eq(sms.rows.map(r => r.o.slug), ["b", "e", "d", "a"], "a feature view ranks by volume, busiest first");
  ok(!sms.rows.some(r => r.o.slug === "c"),
     "...and drops orgs with none of it — 'top SMS users' must not list organizations sending zero");
  eq(sms.total, 4, "the total is the scoped count, which is what the chip promises");

  // THE CAP IS REPORTED, not silent: 25 rows that look like the whole list is
  // how a reader takes a slice for the fleet.
  const many = Array.from({ length: 40 }, (_, i) => mk("o" + i, i, true, i));
  const capped = Q.ofApplyQuickView(Q.ofQuickView("top"), many, () => 1);
  eq(capped.rows.length, 25, "a ranked view is capped at its limit");
  eq(capped.total, 40, "...and still reports the true total");
  eq(capped.capped, true, "...and says it is capped");

  // Deterministic: two runs of one view cannot disagree about a tie.
  const ties = [mk("zeta", 50, true, 3), mk("alpha", 50, true, 3), mk("mid", 50, true, 3)];
  eq(Q.ofApplyQuickView(Q.ofQuickView("top"), ties, countOf).rows.map(r => r.o.slug),
     ["alpha", "mid", "zeta"], "ties break by name, so the order is stable between runs");

  // ── the wiring ──
  const feat = srcNC.slice(srcNC.indexOf("function Features("), srcNC.indexOf("function FeatureSettings"));
  ok(/ofApplyQuickView\(view, all\.filter/.test(feat),
     "the view is applied to the settings-scoped set, so it cannot widen past an exclusion");
  ok(/"data-feat-qvchip"/.test(feat), "the chips are addressable");
  ok(/setQv\(qv === v\.id \? "" : v\.id\); setOnly\(""\)/.test(feat),
     "clicking the active chip clears it, and picking one clears the single-org pulldown");
  ok(/setOnly\(ev\.target\.value\); if \(ev\.target\.value\) \{ setQv\(""\); setSort\(null\); \}/.test(feat),
     "...and picking an org clears the chip AND any manual column sort — two controls producing one state looks broken");
  ok(/v\.kind !== "feature" \|\| shown\.indexOf\(v\.key\) >= 0/.test(feat),
     "a chip whose feature the settings hide is not offered");
  ok(/\.filter\(x => x\.n > 0\)/.test(feat), "a chip with nothing behind it is not offered");
  ok(/ofApplyQuickView\(v, all\.map\(decorate\), countOf\)\.total/.test(feat),
     "each chip's count comes from the SAME reducer that filters, or it promises a number the click does not deliver");
  ok(/"data-feat-qvnote"/.test(feat), "an active view states what it is showing");
  ok(/showing " \+ rows\.length \+ " of " \+ qvOut\.total/.test(feat),
     "...including the cap, so 25 rows are not read as the fleet");
  ok(/No organization matches/.test(feat),
     "an empty view names itself rather than reading as a broken page");
  ok(/clear and go back to all/.test(feat), "there is a way back to the full alphabetical list");

  const css = (src.match(/<style>[\s\S]*?<\/style>/) || [""])[0];
  for (const c of ["qv", "qvchip", "qvnote"]) ok(new RegExp("\\." + c + "\\s*\\{").test(css), `.${c} has its own rule`);
  ok(/\.qvchip\.on\s*\{[^}]*background:\s*var\(--brand\)/.test(css),
     "the active chip is visibly active — otherwise nothing on screen says which view is on");
}

// ── SORTABLE COLUMNS ───────────────────────────────────────────────────────
// Dan: "make these top column headers sortable, so I can click to sort and
// then click again to sort, descending and ascending". LIFTED AND RUN — the
// only mistake that matters is a direction, and no regex over a comparator
// can see one.
{
  const S = new Function(
    src.slice(src.indexOf("function ofSortRows"), src.indexOf("const OF_QUICK_VIEWS") >= 0
      ? src.indexOf("function route()") : src.indexOf("function route()")) +
    "; return { ofSortRows, ofFirstDir };")();

  const row = (slug, v) => ({ o: { slug, displayName: slug }, v });
  const get = (r) => r.v;
  const order = (rows, dir) => S.ofSortRows(rows, "k", dir, get, true).map(r => r.o.slug);

  eq(order([row("a", 1), row("b", 3), row("c", 2)], -1), ["b", "c", "a"], "descending puts the biggest first");
  eq(order([row("a", 1), row("b", 3), row("c", 2)], 1), ["a", "c", "b"], "ascending puts the smallest first");
  ok(order([row("a", 1), row("b", 3)], -1).join() !== order([row("a", 1), row("b", 3)], 1).join(),
     "the two directions really are opposite — a click and a second click differ");

  /* FIRST CLICK ON A NUMBER GOES DESCENDING, on a name ascending. Clicking
     "Payments" means "who uses the most of it"; making the reader click
     twice for the obvious question is the small wrongness that makes a
     control feel broken. */
  eq(S.ofFirstDir(true), -1, "a numeric column opens high-to-low");
  eq(S.ofFirstDir(false), 1, "a name column opens A-Z");

  /* A NULL NEVER SORTS AS A VALUE. An unmeasured org has no score, and
     letting null compare as 0 puts "we cannot tell" at one end of a list
     that claims to rank. Nulls go LAST in BOTH directions, the only
     arrangement honest either way round. */
  eq(order([row("a", 5), row("nul", null), row("b", 1)], -1), ["a", "b", "nul"],
     "nulls sort last descending");
  eq(order([row("a", 5), row("nul", null), row("b", 1)], 1), ["b", "a", "nul"],
     "...and last ascending too, rather than flipping to the top");

  // Deterministic on a tie, or two runs of one sort disagree.
  eq(order([row("zeta", 2), row("alpha", 2), row("mid", 2)], -1), ["alpha", "mid", "zeta"],
     "ties break by name");

  // A name column compares as text, numerically aware, case-insensitively —
  // "Aspen" must not sort after "apex" because of capitalisation.
  const names = [{ o: { slug: "b", displayName: "Barton" }, v: "Barton" },
                 { o: { slug: "a", displayName: "apex" }, v: "apex" },
                 { o: { slug: "c", displayName: "Aspen" }, v: "Aspen" }];
  eq(S.ofSortRows(names, "k", 1, get, false).map(r => r.o.slug), ["a", "c", "b"],
     "a name column sorts case-insensitively");

  const feat = srcNC.slice(srcNC.indexOf("function Features("), srcNC.indexOf("function FeatureSettings"));
  ok(/const sortTh = \(label, key, extra\)/.test(feat),
     "ONE header renderer for all fourteen columns, so the arrow and the click cannot drift apart");
  ok(/s2 && s2\[0\] === key \? -s2\[1\] : ofFirstDir\(numericCol\(key\)\)/.test(feat),
     "clicking the same column flips the direction; a new column takes its own first direction");
  ok(/"data-feat-thdir"/.test(feat), "the sorted column and its direction are addressable");
  ok(/\\u2193" : " \\u2191"/.test(feat) || /↓" : " ↑/.test(feat),
     "the sorted header shows an arrow — otherwise nothing on screen says which column is sorting");
  ok(/sortTh\("Organization", "name"/.test(feat) && /sortTh\("Adoption", "score"/.test(feat),
     "the name and adoption columns are sortable too, not just the groups");

  /* A HEADER CLICK OVERRIDES THE ORDER, NOT THE SCOPE. Sorting inside "Top
     SMS users" re-orders those 20 orgs; it must not bring the other 124
     back. */
  ok(/const rows = sort\s*\?\s*ofSortRows\(qvOut\.rows/.test(feat),
     "the sort is applied to the quick view's OUTPUT, so it re-orders without re-scoping");

  /* AND THE VIEW'S NOTE MUST STOP CLAIMING AN ORDER IT NO LONGER SETS. A
     view says "by volume"; once a column is clicked the table is in that
     column's order, and a note still promising the view's ranking is two
     surfaces disagreeing on one screen. */
  ok(/sort \? e\("span", null, "re-sorted by the "/.test(feat),
     "an active view says when a column has taken over the ordering");
  ok(/"data-feat-sortnote"/.test(feat),
     "a manual sort with no view active still says so — an arrow in a header is not enough");
  ok(/back to alphabetical/.test(feat), "...and offers the way back");
  ok(/setQv\(qv === v\.id \? "" : v\.id\); setOnly\(""\); setSort\(null\)/.test(feat),
     "picking a view clears a stale column sort, or last click's order silently governs a new view");

  const css = (src.match(/<style>[\s\S]*?<\/style>/) || [""])[0];
  ok(/\.feattable th:hover\s*\{/.test(css), "the headers look clickable on hover");
}

// ── RING METERS AND THE SIDE-BY-SIDE COMPARISON ────────────────────────────
{
  const feat = srcNC.slice(srcNC.indexOf("function Features("), srcNC.indexOf("function FeatureSettings"));
  const ring = srcNC.slice(srcNC.indexOf("function Ring("), srcNC.indexOf("function RingCard("));
  ok(ring.length > 300, "the Ring component was found");

  /* A SINGLE RATIO IS A METER, NOT A TWO-SLICE PIE. Dan asked for donut
     charts; all three tiles are one ratio against a limit, and the dataviz
     guidance is blunt that the honest form is one data arc on a recessive
     track — the anti-pattern is the second competing slice, not the shape. */
  eq((ring.match(/e\("circle"/g) || []).length, 2,
     "the ring is ONE data arc on ONE track — not a two-slice pie");
  ok(/strokeDasharray/.test(ring) && /strokeDashoffset/.test(ring),
     "the arc is drawn by dash offset, so it is a real proportion rather than a picture");
  /* A NULL RATIO DRAWS THE TRACK ALONE. "We could not measure this" must not
     render as a confident zero. */
  ok(/p == null \? null : e\("circle"/.test(ring),
     "an unmeasured ratio draws the empty track rather than a zero arc");
  ok(/Math\.max\(0, Math\.min\(100, pct\)\)/.test(ring),
     "the arc is clamped, so a bad input cannot wrap the ring past full");
  ok(/rotate\(-90 /.test(ring), "it starts at twelve o'clock, which is how a progress ring is read");
  ok(/role: "img"/.test(ring) && /aria-label/.test(ring), "the ring carries an accessible label");
  /* NO LIBRARY. A CDN chart library on this page is one more thing that can
     fail to load, and an inline SVG scales with the card. */
  ok(!/chart\.js|d3|recharts|cdnjs/i.test(ring), "it is inline SVG with no library behind it");
  /* THE ARC CARRIES THE COLOUR AND THE FIGURE STAYS IN INK — text wears text
     tokens, never the series colour. */
  const ringCard = srcNC.slice(srcNC.indexOf("function RingCard("), srcNC.indexOf("function ofSortRows"));
  ok(!/color: color/.test(ringCard), "the tile's figure is not painted in the arc's colour");

  ok(/"Feature Adoption"/.test(feat), "the tile is called Feature Adoption");
  ok(!/"Fleet adoption"/.test(feat), "...and the old Fleet adoption label is gone");
  ok((feat.match(/e\(Ring, \{/g) || []).length === 3, "all three KPI tiles are rings");
  ok(/pct: avg, color: avg == null \? null : scoreColor\(avg\)/.test(feat),
     "the adoption ring takes the same threshold colour as the rest of the page");
  ok(/pct: all\.length \? \(launched \/ all\.length\) \* 100 : null/.test(feat),
     "the organizations ring shows the LIVE share, which is the only ratio that tile has");
  ok(/data-feat-avg|data-feat-orgs|data-feat-shown/.test(feat),
     "the tiles keep their addressable values, so the render checks still read them");

  /* SIDE BY SIDE MEANS LEFT AND RIGHT. Dan: "This isn't side by side, it's
     top and bottom." It was two table rows; a three-column grid puts one
     label against both values so the eye travels along a row. */
  const cmp = feat.slice(feat.indexOf('"data-feat-cmp"'));
  ok(cmp.length > 500, "the comparison block was found");
  ok(/className: "cmprow"/.test(cmp), "the comparison is a row-per-metric grid");
  ok(/"data-feat-cmpcol"/.test(cmp), "each organization has its own COLUMN");
  ok(!/"data-feat-cmprow"/.test(feat), "...and the old row-per-organization table is gone");
  ok(!/e\("tbody", null, \[A, B\]/.test(feat), "there is no two-row table left");
  ok(/metrics\.map\(m => e\("div", \{ className: "cmprow", key: m\.key \}/.test(cmp),
     "every core metric gets its own aligned row");
  ok(/groups\.map\(g => \{/.test(cmp), "...and so does every feature group");
  /* THE GAP LISTS SIT UNDER THEIR OWN ORG. They ran full-width and stacked,
     which is what made the panel read top-and-bottom even where the numbers
     did not. */
  ok(/className: "cmprow cmpgaps"/.test(cmp), "the gap lists are in the same two columns");
  ok(/Nothing " \+ orgName\(y\) \+ " does not also have/.test(cmp),
     "an empty gap list says so rather than rendering nothing");
  ok(/same organization in both slots/.test(cmp), "picking one org twice says so");

  const css = (src.match(/<style>[\s\S]*?<\/style>/) || [""])[0];
  ok(/\.cmprow\s*\{[^}]*grid-template-columns:\s*minmax\(120px, 190px\) 1fr 1fr/.test(css),
     "the grid really is label + two equal columns");
  ok(/@media \(max-width: 700px\) \{ \.cmprow \{ grid-template-columns: 1fr/.test(css),
     "...and it stacks on a narrow screen rather than crushing both columns");
  ok(/\.ringcard\s*\{[^}]*display:\s*flex/.test(css), "the ring sits beside its figure");
  ok(/\.ring\s*\{[^}]*flex:\s*none/.test(css), "the ring does not squash when the text is long");
}

// ── THE SETTINGS CATEGORY ──────────────────────────────────────────────────
// Dan: "missing a whole section on settings, like permits, waivers, forms,
// desk locations, etc." All thirteen were already measured but scattered
// across five functional categories, so the setup picture could not be read
// anywhere. Asserted against the CATALOG, not a transcribed list.
{
  const snap = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "features-data.json"), "utf8"));
  const byCat = {};
  for (const f of snap.features) (byCat[f.category] = byCat[f.category] || []).push(f.key);

  ok(snap.featureCategories.includes("Settings & Configuration"),
     "there is a Settings & Configuration category");
  /* THE FOUR DAN NAMED ARE THE ANCHORS. If any of them drifts back out, the
     regroup has silently stopped answering the thing he asked for. */
  for (const k of ["rental_permits", "waivers_contracts", "custom_forms", "pos_desk_locations"])
    ok((byCat["Settings & Configuration"] || []).includes(k),
       `${k} is in the Settings category — one of the four Dan named`);
  ok((byCat["Settings & Configuration"] || []).length >= 10,
     `the Settings category is substantial (${(byCat["Settings & Configuration"] || []).length} features)`);

  /* EVERY FEATURE'S CATEGORY MUST BE A LISTED ONE, or it silently gets no
     column: `groups` is built by mapping over featureCategories, so a
     feature in an unlisted category is measured, scored, and invisible. */
  const unlisted = snap.features.filter(f => !snap.featureCategories.includes(f.category));
  eq(unlisted.length, 0,
     `every feature sits in a listed category — orphans get NO column and vanish from the page: ${unlisted.map(f => f.key + " (" + f.category + ")").join(", ")}`);

  /* AND EVERY LISTED CATEGORY MUST HAVE A FEATURE. An empty one is a column
     that can never render and a heading in the settings sheet that never
     appears — which is why "Forms & Waivers" came out when its three
     features moved. */
  const empty = snap.featureCategories.filter(c => !(byCat[c] || []).length);
  eq(empty.length, 0, `no category is empty: ${empty.join(", ")}`);

  ok(!snap.featureCategories.includes("Forms & Waivers"),
     "Forms & Waivers is gone — forms and waivers ARE the settings, and it has no features left");

  // The catalog and the page's short labels stay in step, both ways.
  const H2 = new Function(
    src.slice(src.indexOf("const CAT_SHORT"), src.indexOf("function route()")) +
    "; return { CAT_SHORT };")();
  const stale = Object.keys(H2.CAT_SHORT).filter(c => !snap.featureCategories.includes(c));
  eq(stale.length, 0, `no short label points at a category that no longer exists: ${stale.join(", ")}`);

  /* THE NIGHTLY BAKE MUST NOT UNDO THIS. merge-snapshot carries the catalog
     over from the committed snapshot rather than rebuilding it, which is the
     only reason a category edit survives a refresh. */
  const merge = fs.readFileSync(path.join(ROOT, "scripts", "refresh", "merge-snapshot.js"), "utf8");
  ok(/featureCategories: old\.featureCategories/.test(merge),
     "the bake carries featureCategories over, so tomorrow's refresh does not revert the regroup");
  ok(/features: old\.features/.test(merge),
     "...and the feature catalog with it, including each feature's category");
}
