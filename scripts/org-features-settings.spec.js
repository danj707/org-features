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
  const feat = srcNC.slice(srcNC.indexOf("function Features()"), srcNC.indexOf("function FeatureSettings"));
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
    ["the table", /const rows = all\.filter/],
    ["the fleet average", /scoredAll = all\.map\(decorate\)/],
    ["the pulldown and both compare slots", /const orgOptions = all\.map/],
    ["compare slot A", /cmpA \? all\.find/],
    ["compare slot B", /cmpB \? all\.find/],
    ["the org count", /"data-feat-orgs": all\.length/],
  ]) ok(re.test(feat), `${what} reads the excluded-filtered set`);

  // The checklist inside an open row shows the TRACKED set, or it lists
  // features the score above it ignores.
  const openRow = (feat.match(/"data-feat-open"[\s\S]{0,400}/) || [""])[0];
  ok(/shown\.map/.test(openRow), "the per-org checklist shows the tracked set, matching the score above it");
  ok(!/allMeasured\.map/.test(openRow), "...and not the full measured set");

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
  const feat = srcNC.slice(srcNC.indexOf("function Features()"), srcNC.indexOf("function FeatureSettings"));

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
