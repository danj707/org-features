/**
 * The CX dashboard's navigation and the three pages behind it.
 *
 * This page renders through React.createElement rather than JSX, so there is no
 * component to import and run — these are source assertions, and each one is
 * scoped to the thing it is about rather than matched file-wide.
 *
 * THE LOAD-BEARING ONE IS THE ROUTE/TITLE PARITY. The header renders
 * `titles[r.page][0]`, so a page route() can return with no titles entry does
 * not degrade — it throws, React unmounts, and the whole dashboard is a blank
 * screen. Adding a route and forgetting its title is a one-line mistake with a
 * total blast radius, which is exactly the shape worth a guard.
 */
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "public", "ps.html"), "utf8");
const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

let pass = 0;
const failures = [];
const ok = (c, m) => { if (c) pass++; else failures.push(m); };
const eq = (g, w, m) => ok(g === w, `${m} — got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`);

process.on("exit", () => {
  if (failures.length) {
    console.error(`\n✗ nav.spec.js — ${failures.length} failure(s):\n`);
    failures.forEach(f => console.error("  ✗ " + f));
    console.error(`\n${pass} passed, ${failures.length} failed.\n`);
    process.exitCode = 1;
  } else {
    console.log(`✓ nav.spec.js — ${pass} assertions passed.`);
  }
});

// ── EVERY PAGE route() CAN RETURN MUST HAVE A TITLE ────────────────────────
{
  const routeFn = src.slice(src.indexOf("function route()"), src.indexOf("function nav("));
  ok(routeFn.length > 50, "route() was found and sliced");
  const pages = [...new Set([...routeFn.matchAll(/page:\s*"([a-z]+)"/g)].map(m => m[1]))];
  ok(pages.length >= 8, `route() returns at least eight pages — found ${pages.length}: ${pages.join(", ")}`);

  const titlesLine = (src.match(/const titles = \{[\s\S]*?\};/) || [""])[0];
  ok(titlesLine.length > 50, "the titles map was found");
  const titled = [...new Set([...titlesLine.matchAll(/([a-z]+):\s*\[/g)].map(m => m[1]))];

  const missing = pages.filter(p => !titled.includes(p));
  eq(missing.length, 0,
     `every page route() can return has a titles entry — the header reads titles[r.page][0] and a miss BLANKS THE DASHBOARD. Missing: ${missing.join(", ")}`);

  for (const p of ["features", "how", "updates"])
    ok(pages.includes(p), `route() handles /ps/${p}`);
}

// ── THE SERVER MUST SERVE THE NEW PATHS ───────────────────────────────────
{
  const psRoutes = (server.match(/app\.get\(\[[^\]]*"\/ps"[\s\S]*?\]/) || [""])[0];
  ok(psRoutes.length > 20, "the /ps/* route array was found in server.js");
  for (const p of ["/ps/features", "/ps/how", "/ps/updates"])
    ok(psRoutes.includes(`"${p}"`), `server.js serves ${p} (a client route the server does not serve is a hard 404 on refresh or a shared link)`);
  /* NO BOOKMARK MAY BREAK. The rename was to the LABEL; these paths are what
     people have in their history and in links they were sent. */
  for (const p of ["/ps", "/ps/bugs", "/ps/reporting", "/ps/remittance", "/ps/admin"])
    ok(psRoutes.includes(`"${p}"`), `the pre-existing path ${p} still serves`);
}

// ── THE LOGO IS THE REAL ASSET, AND IT EXISTS ─────────────────────────────
{
  ok(/src:\s*"\/rec-logo\.jpg"/.test(src), "the sidebar renders the rec mark");
  const asset = path.join(__dirname, "..", "public", "rec-logo.jpg");
  ok(fs.existsSync(asset), "public/rec-logo.jpg is committed — a src pointing at nothing is a broken image, not a logo");
  ok(fs.existsSync(asset) && fs.statSync(asset).size > 500,
     "the logo file has real bytes in it");
  /* ALT TEXT AND EXPLICIT DIMENSIONS. Without width/height the sidebar reflows
     as the image lands, which on a nav is a visible jump on every load. */
  ok(/alt:\s*"rec"/.test(src), "the logo carries alt text");
  ok(/width:\s*24,\s*height:\s*24/.test(src), "the logo has explicit dimensions so the sidebar does not reflow");
}

// ── THE RENAME IS THE LABEL ONLY ──────────────────────────────────────────
{
  ok(/"CX dashboard"/.test(src), "the sidebar reads CX dashboard");
  ok(!/PS dashboard/.test(src), "the old PS dashboard label is gone from the page");
  /* THE ROUTES, THE FILE AND THE SNAPSHOT KEY KEEP THEIR NAMES. Renaming those
     breaks every bookmark and the key the ps snapshot is written under. */
  ok(/"\/api\/ps-data"/.test(server), "the ps-data endpoint keeps its name");
  ok(fs.existsSync(path.join(__dirname, "..", "public", "ps.html")), "ps.html keeps its name");
}

// ── ORG FEATURES IS IN THE SHELL ──────────────────────────────────────────
{
  /* THE BUG THIS FIXES: a plain <a href="/"> is a FULL PAGE navigation out of
     this app into dashboard.html — the sidebar disappears and there is no way
     back. Every other nav entry goes through item() -> link() -> pushState. */
  ok(!/className:\s*"item",\s*href:\s*"\/"\s*\}/.test(src),
     "the sidebar no longer contains a raw anchor to / (that was the full-page escape)");
  ok(/item\("\/ps\/features",\s*"Org Features"/.test(src),
     "Org Features is a routed nav item like every other one");
  ok(!/Org Features →/.test(src),
     "the → is gone with it — the arrow advertised an external link");
  /* IT READS THE SAME SNAPSHOT AS THE PUBLIC DASHBOARD, so the two surfaces
     cannot disagree about an adoption score. */
  const feat = src.slice(src.indexOf("function Features()"), src.indexOf("function HowItWorks()"));
  ok(feat.length > 200, "the Features component was found and sliced");
  ok(/fetch\("\/api\/data"\)/.test(feat), "Features reads /api/data, the same snapshot the public dashboard reads");
  /* THE FLEET AVERAGE EXCLUDES UNSCORED ORGS. Folding an org the bake has not
     measured in as a zero drags the fleet figure down and misreports it. */
  ok(/scored\s*=\s*rows\.filter\(r => r\.score != null\)/.test(feat),
     "the fleet average is taken over orgs that could be scored, not over all of them");
  ok(/avg == null \? "—"/.test(feat), "with nothing scoreable the average is a dash, never 0%");
}

// ── THE TWO NEW ABOUT PAGES ───────────────────────────────────────────────
{
  ok(/item\("\/ps\/how",\s*"How This Works"/.test(src), "How This Works is in the sidebar");
  ok(/item\("\/ps\/updates",\s*"Updates"/.test(src), "Updates is in the sidebar");

  const how = src.slice(src.indexOf("function HowItWorks()"), src.indexOf("function Updates()"));
  ok(how.length > 200, "the HowItWorks component was found and sliced");
  /* THE DIAGRAM IS INLINE SVG, not an image file. An architecture picture that
     cannot be edited in the same commit as the architecture goes stale
     immediately, and a stale diagram is worse than none because it is
     believed. */
  ok(/e\("svg",/.test(how), "the architecture diagram is inline SVG, editable in the same commit as the architecture");
  ok(!/<img[^>]*architecture/i.test(how), "it is not a committed image that would go stale on its own");
  /* IT HAS TO DESCRIBE THE POST-POSTGRES SHAPE, which is the whole reason Dan
     asked for it now rather than before. */
  ok(/Postgres/.test(how), "the diagram names Postgres");
  ok(/orgfeatures/.test(how), "...and the schema it owns");
  ok(/viewBox/.test(how) && /maxWidth/.test(how), "the SVG scales rather than overflowing a narrow window");
  ok(/role: "img"/.test(how) && /aria-label/.test(how), "the diagram carries an accessible label");

  const upd = src.slice(src.indexOf("function Updates()"), src.indexOf("function App()") > 0 ? src.indexOf("function App()") : src.length);
  ok(upd.length > 100, "the Updates component was found and sliced");
  ok(/fetch\("\/api\/updates"\)/.test(upd), "Updates reads the committed log rather than a hardcoded array");
  ok(/localeCompare/.test(upd), "the log renders newest first");
  /* A FRESH CHECKOUT HAS AN EMPTY LOG, and that is a state rather than an
     error — the route answers {updates: []} and the page says so. */
  ok(/Nothing logged yet/.test(upd), "an empty log reads as empty, not as a failure");
  ok(/app\.get\("\/api\/updates", auth\.requireAuth/.test(server),
     "the update log is behind auth with the rest of the CX dashboard");
}

// ── the log itself has to be usable ────────────────────────────────────────
{
  const log = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "updates.json"), "utf8"));
  ok(Array.isArray(log.updates) && log.updates.length > 0, "updates.json holds entries");
  for (const u of log.updates) {
    ok(/^\d{4}-\d{2}-\d{2}$/.test(String(u.date)), `every entry has an ISO date — saw ${JSON.stringify(u.date)}`);
    ok(typeof u.title === "string" && u.title.length > 5, `every entry has a title — saw ${JSON.stringify(u.title)}`);
  }
}
