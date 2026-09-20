#!/usr/bin/env node
/**
 * EVERY PAGE MUST ACTUALLY RENDER IN A BROWSER.
 *
 * WHY THIS EXISTS. On 2026-09-07 this project shipped TWO blank pages in one
 * afternoon, both the same class and both invisible to everything else:
 *
 *   Cannot access 'groups' before initialization      (a sorted group column)
 *   Cannot access 'launchTag' before initialization   (the per-org drill-in)
 *
 * Both were temporal dead zones — a derived value read above its own
 * declaration. `node --check` passes (the file is valid), ci-check-html
 * passes (the block PARSES; it only throws when RUN), ci-boot-check passes
 * (the server serves the HTML happily), and all five specs pass (none of
 * them mounts a component). React catches the throw, unmounts the tree, and
 * the response is a 200 with a complete document and nothing on screen.
 *
 * Parsing is not running. A page can only be proven to render by rendering
 * it. The sibling rental-report project learned this the same way and its
 * note is blunt about it: in these components, define derived values AFTER
 * everything they read.
 *
 * IT BOOTS THE REAL SERVER against the committed snapshot rather than stubs,
 * because the pages fetch from their own origin and the snapshot in the repo
 * is the thing CI should be proving renders.
 */
const { spawn } = require("child_process");
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");

/* PUPPETEER IS A REAL devDependency NOW. It used not to be, and this block
   carried two hand-written fallback paths to find a copy belonging to another
   project on one machine - which is precisely why nobody noticed that CI
   could not load it at all. Plain resolution, and the gate below. */
let puppeteer;
try { puppeteer = require("puppeteer"); }
catch { /* handled below */ }
/* SKIPS WITH A MESSAGE locally, and FAILS IN CI. A render check that reports
   success without having opened a browser is the warm-cache sign-off this
   repo family already has a rule about - and that is exactly what the `render`
   job did from the day it was written: the workflow installed a BROWSER
   (`puppeteer browsers install chrome`) and never the LIBRARY, so every run
   printed this line and exited 0. A green tick on a check that never ran is
   worse than no check, because it is trusted. On a developer's machine a skip
   is still the right answer; in CI it is the failure. */
if (!puppeteer) {
  const msg = "ci-check-render.js could not load puppeteer.";
  if (process.env.CI) {
    console.error("✗ " + msg + " In CI this is a FAILURE, not a skip - "
      + "add puppeteer to devDependencies so `npm ci` installs it. "
      + "This check proves nothing without it.");
    process.exit(1);
  }
  console.log("⊘ " + msg + " SKIPPED - this check proves nothing without it.");
  process.exit(0);
}
const EXECUTABLE = process.env.PUPPETEER_EXECUTABLE_PATH
  || (fs.existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
        ? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" : undefined);

const PORT = Number(process.env.RENDER_PORT || 3451);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of-render-"));
const env = { ...process.env, PORT: String(PORT), DATA_DIR: dir,
              SESSION_SECRET: "render-check", SIGNUP_CODE: "render-check" };
delete env.STORE_DATABASE_URL; delete env.DATABASE_URL; delete env.STORE_MODE;

const child = spawn("node", [path.join(__dirname, "..", "server.js")],
  { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", d => { log += d; });
child.stderr.on("data", d => { log += d; });

const wait = ms => new Promise(r => setTimeout(r, ms));
function req(method, p, body) {
  return new Promise((res, rej) => {
    const pay = body === undefined ? null : JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port: PORT, path: p, method, timeout: 10000,
      headers: pay ? { "content-type": "application/json", "content-length": Buffer.byteLength(pay) } : {} },
      resp => { let x = ""; resp.on("data", c => x += c);
                resp.on("end", () => res({ status: resp.statusCode, body: x, cookies: resp.headers["set-cookie"] })); });
    r.on("error", rej); r.on("timeout", () => { r.destroy(); rej(new Error("timeout " + p)); });
    if (pay) r.write(pay);
    r.end();
  });
}

/* Each case is a path plus ONE thing that must appear — a `needs` selector,
   or a `text` snippet for a page built from inline styles with no class to
   hook (CX Reporting is one). Either way it is what turns "no exception was
   thrown" into "it actually rendered something": an unmounted tree throws
   nothing on the second render, it is simply empty. */
const CASES = [
  { name: "org features · the list", path: "/ps/features", needs: "[data-feat-miss]" },
  /* THE ALIGNMENT IS THE WHOLE FIX, AND ONLY A BROWSER CAN SEE IT. Dan's
     complaint about the version before this was "The two rows of not using
     are just a mash up of words" — the same names, the same order, the same
     markup depth, rendered as a wrapping flex line instead of a grid. So a
     source assertion cannot tell the two apart, and "a gap line rendered"
     passes on both. This measures the left edge of the NAME column down the
     table: under the grid every line starts at one x, and under a flex line
     each one starts wherever its label happened to end. */
  { name: "org features · every gap line starts in the same place", path: "/ps/features",
    needs: '[data-rc-gapx="1"]',
    act: async (pg) => {
      await pg.waitForSelector(".gapnames");
      await pg.evaluate(() => {
        const xs = [...document.querySelectorAll(".gapnames")]
          .slice(0, 24).map(n => Math.round(n.getBoundingClientRect().left));
        const cats = [...document.querySelectorAll(".gapcat")]
          .slice(0, 24).map(n => Math.round(n.getBoundingClientRect().left));
        const one = new Set(xs).size === 1 && new Set(cats).size === 1;
        document.body.setAttribute("data-rc-gapx", (xs.length >= 6 && one) ? "1" : "0");
        document.body.setAttribute("data-rc-gapx-seen", xs.length + ":" + new Set(xs).size);
      });
    } },
  /* THE ORG CELL MUST NOT OVERFLOW INTO THE ADOPTION FIGURE. A max-width on a
     `white-space: nowrap` cell clips nothing, it overflows — and the only
     symptom is a name running over the number beside it, which no source
     assertion can see. Measured as content width against the cell's own. */
  { name: "org features · the org cell does not run over the adoption figure", path: "/ps/features",
    needs: '[data-rc-fit="1"]',
    act: async (pg) => {
      await pg.waitForSelector("td.l");
      await pg.evaluate(() => {
        const cells = [...document.querySelectorAll(".feattable td.l")].slice(0, 24);
        const over = cells.filter(c => c.scrollWidth > c.clientWidth + 1);
        document.body.setAttribute("data-rc-fit",
          (cells.length >= 6 && !over.length) ? "1" : "0");
        document.body.setAttribute("data-rc-fit-seen",
          cells.length + " cells, " + over.length + " overflowing");
      });
    } },
  /* THE HEADER STAYS PUT. Dan: "once I scroll down a bit, all the column
     headers are gone." `position: sticky; top: 0` was already on every `th`
     and DID NOT WORK, which is exactly why no source assertion could catch
     this — the CSS reads correctly and the sticky ancestor was wrong. Only a
     browser that actually scrolls can tell. */
  { name: "org features · the column headers stay put when you scroll", path: "/ps/features",
    needs: '[data-rc-sticky="1"]',
    act: async (pg) => {
      await pg.waitForSelector(".stickywrap thead th");
      await pg.evaluate(() => {
        const w = document.querySelector(".stickywrap");
        w.scrollTop = 700;
        const th = w.querySelector("thead th");
        const wr = w.getBoundingClientRect(), tr = th.getBoundingClientRect();
        const stuck = w.scrollTop > 300 && tr.top >= wr.top - 2 && tr.bottom <= wr.bottom;
        document.body.setAttribute("data-rc-sticky", stuck ? "1" : "0");
        document.body.setAttribute("data-rc-sticky-seen",
          "scrolled " + w.scrollTop + ", header at " + Math.round(tr.top - wr.top));
      });
    } },
  /* A PILL ON EVERY GROUP CELL, at every value. Dan: "why do some of the
     feature options have pills and others dont?" The old ramp faded to a
     WHITE fill, so a 0/7 rendered as bare grey text next to a pill — one
     column, two shapes, one kind of value. A source assertion sees a `.gpill`
     span either way; what changed is whether it is visible. */
  { name: "org features · every group cell wears a pill", path: "/ps/features",
    needs: '[data-rc-pills="1"]',
    act: async (pg) => {
      await pg.waitForSelector("[data-feat-grp]");
      await pg.evaluate(() => {
        const cells = [...document.querySelectorAll("[data-feat-grp]")].slice(0, 120);
        const invisible = cells.filter(c => {
          const bg = getComputedStyle(c).backgroundColor;
          return !bg || bg === "rgba(0, 0, 0, 0)" || bg === "transparent"
              || bg === "rgb(255, 255, 255)";
        });
        // ...and the bands must actually differ, or "every cell has a pill"
        // passes on a single flat colour that says nothing.
        const fills = new Set(cells.map(c => getComputedStyle(c).backgroundColor));
        document.body.setAttribute("data-rc-pills",
          (cells.length >= 24 && !invisible.length && fills.size >= 3) ? "1" : "0");
        document.body.setAttribute("data-rc-pills-seen",
          cells.length + " cells, " + invisible.length + " invisible, " + fills.size + " fills");
      });
    } },
  /* THE TREND COLUMN, AND THE STATE IT IS IN TODAY. The bake writes one point
     per day and the series starts at the first bake carrying it, so with a
     single point EVERY row must show the explanation and NO row may draw a
     line — a flat line is a claim that nothing changed. The day there are two
     comparable points this case flips to asserting the line instead, which is
     why it keys on the two facts rather than on one of them. */
  { name: "org features · the trend column matches the history it has", path: "/ps/features",
    needs: '[data-rc-trend="1"]',
    act: async (pg) => {
      await pg.waitForSelector("[data-of-trend]");
      await pg.evaluate(async () => {
        /* THE CASE READS THE HISTORY ITSELF and requires the column to agree
           with it. Asserting only "ready cells draw a line" cannot
           discriminate: drop the two-point minimum and every cell becomes
           ready and draws one, so the case passes on the regression it is
           named for. The invariant is the RELATIONSHIP — a line may exist iff
           there are at least two points scored over the CURRENT feature set. */
        const d = await fetch("/api/data").then(r => r.json()).catch(() => null);
        const hist = (d && d.history) || [];
        const newest = hist.length ? hist[hist.length - 1].setKey : null;
        const comparable = hist.filter(h => h.setKey === newest).length;
        const cells = [...document.querySelectorAll("[data-of-trend]")].slice(0, 40);
        const ready = cells.filter(c => c.getAttribute("data-of-trend") !== "");
        const lines = cells.filter(c => c.querySelector("svg.trendline polyline"));
        const blank = cells.filter(c => c.getAttribute("data-of-trend") === "");
        const good = comparable >= 2
          // enough history: the orgs with a delta draw a line, and some do
          ? (ready.length > 0 && lines.length === ready.length)
          // not enough: NOBODY draws a line, and every cell says why
          : (lines.length === 0 && blank.length === cells.length
             && blank.every(c => (c.title || "").length > 20));
        document.body.setAttribute("data-rc-trend",
          (cells.length >= 20 && good) ? "1" : "0");
        document.body.setAttribute("data-rc-trend-seen",
          comparable + " comparable point(s), " + cells.length + " cells, "
          + ready.length + " with a delta, " + lines.length + " lines");
      });
    } },
  /* ONE BAND PER ORG, with a heavier edge between orgs than inside one.
     "Orgs run together vertically" was a CSS fact: every td carried the same
     1px rule, so three identical hairlines per org. Reverting either half —
     the inner rule coming back, or the band edge dropping to 1px — makes the
     two weights equal again, which is what this compares. */
  { name: "org features · an org and its gaps are one band", path: "/ps/features",
    needs: '[data-rc-band="1"]',
    act: async (pg) => {
      await pg.waitForSelector("tbody.orgband");
      await pg.evaluate(() => {
        const bands = [...document.querySelectorAll("tbody.orgband")];
        const pairs = bands.length && bands.slice(0, 20).every(b => b.rows.length === 2);
        const px = el => parseFloat(getComputedStyle(el).borderBottomWidth) || 0;
        const inner = bands.slice(0, 20).map(b => px(b.rows[0].cells[0]));
        const edge = bands.slice(0, 20).map(b => px(b.rows[1].cells[0]));
        const ok = pairs && inner.every(v => v === 0) && edge.every(v => v >= 2);
        document.body.setAttribute("data-rc-band", ok ? "1" : "0");
        document.body.setAttribute("data-rc-band-seen",
          bands.length + " bands, inner " + inner[0] + "px, edge " + edge[0] + "px");
      });
    } },
  { name: "org features · a per-org drill-in", path: "/ps/features/apex-park-and-recreation-district",
    needs: "[data-feat-cat]" },
  { name: "org features · an unknown slug explains itself", path: "/ps/features/not-a-real-org",
    needs: "[data-feat-crumb]" },
  /* THE SORTED-GROUP-COLUMN PATH IS ITS OWN CASE. It is reachable only by a
     click, and it is exactly where the first of the two blank pages lived. */
  { name: "org features · sorting a group column", path: "/ps/features", needs: '[data-feat-thdir="desc"]',
    act: async (pg) => {
      await pg.waitForSelector('[data-feat-th="Payments & Pricing"]');
      await pg.click('[data-feat-th="Payments & Pricing"]');
    } },
  { name: "org features · the A/B comparison", path: "/ps/features", needs: "[data-feat-cmpcol]",
    act: async (pg) => {
      await pg.waitForSelector("[data-feat-cmpa]");
      await pg.select("[data-feat-cmpa]", "city-of-aspen");
      await pg.select("[data-feat-cmpb]", "apex-park-and-recreation-district");
    } },
  { name: "org features · a quick view", path: "/ps/features", needs: "[data-feat-qvnote]",
    act: async (pg) => {
      await pg.waitForSelector('[data-feat-qvchip="sms"]');
      await pg.click('[data-feat-qvchip="sms"]');
    } },
  /* THE PICKER'S PROMISE MUST EQUAL WHAT THE CLICK DELIVERS. Every option
     carries an org count in its own label, and a picker wired to the wrong
     key renders a perfectly plausible table of some other feature's users —
     "a table rendered" and even "the table got shorter" both pass on that.
     So the case reads the count out of the option's TEXT and requires the
     row count to equal it. Keyed on calendar_sync because it is the feature
     this control was built for and it is nowhere near the fleet-wide
     features, so a wrong key cannot coincide with it. */
  { name: "org features · the picker filters to exactly what its label promised",
    path: "/ps/features", needs: '[data-rc-fpick="1"]',
    act: async (pg) => {
      await pg.waitForSelector("[data-feat-fsel]");
      await pg.select("[data-feat-fsel]", "calendar_sync");
      /* waitForFunction, NOT waitForSelector: the element was already there
         and only its attribute VALUE changes, which a selector wait does not
         reliably see. A fixed sleep here was flaky, and a flaky assertion is
         not a guard.

         IT WAITS FOR *ANY* ACTIVE FEATURE, not for calendar_sync. Waiting for
         the right one makes a picker wired to the WRONG key fail as a 30s
         timeout, which reads as the page being broken rather than as this
         assertion catching the thing it is named for — so the wait settles
         and the assertion below is what reports. */
      await pg.waitForFunction(() => {
        const el = document.querySelector("[data-feat-fsel]");
        return el && el.getAttribute("data-feat-fsel") !== "none";
      });
      await pg.evaluate(() => {
        const sel = document.querySelector("[data-feat-fsel]");
        const active = sel.getAttribute("data-feat-fsel");
        const opt = [...sel.options].find(o => o.value === active);
        const promised = Number((((opt && opt.textContent) || "").match(/(\d+)\s+orgs?\s*$/) || [])[1]);
        const rows = document.querySelectorAll("[data-feat-row]").length;
        document.body.setAttribute("data-rc-fpick",
          (active === "calendar_sync" && promised > 0 && rows === promised) ? "1" : "0");
        document.body.setAttribute("data-rc-fpick-seen",
          "picked calendar_sync, active " + active
          + ", label promised " + promised + ", table shows " + rows);
      });
    } },
  /* ONE STATE, TWO REFLECTIONS. Picking a feature that also has a chip must
     light that chip — a picker and a chip disagreeing about the active scope
     is the surface lying about what it is showing, and no source assertion
     can see which of the two is lit. */
  { name: "org features · picking a feature lights its chip too",
    path: "/ps/features", needs: '[data-rc-fsync="1"]',
    act: async (pg) => {
      await pg.waitForSelector("[data-feat-fsel]");
      await pg.select("[data-feat-fsel]", "sms_messaging");
      await pg.waitForFunction(() =>
        document.querySelector("[data-feat-fsel]")
          && document.querySelector("[data-feat-fsel]").getAttribute("data-feat-fsel") === "sms_messaging");
      await pg.evaluate(() => {
        const chip = document.querySelector('[data-feat-qvchip="sms"]');
        document.body.setAttribute("data-rc-fsync",
          (chip && chip.classList.contains("on")) ? "1" : "0");
        document.body.setAttribute("data-rc-fsync-seen",
          chip ? "chip class " + chip.className : "no sms chip");
      });
    } },
  /* THE FEATURE PAGE MUST ACCOUNT FOR EVERY ORGANIZATION. Using it, not using
     it and live, not using it and pre-launch have to partition the fleet, and
     the table has to carry one row per user. A page that silently drops an
     org from one side renders exactly as convincingly as one that does not —
     this is the only assertion that can tell them apart. */
  { name: "org features · a feature page accounts for every organization",
    path: "/ps/feature/calendar_sync", needs: '[data-rc-fpage="1"]',
    act: async (pg) => {
      await pg.waitForSelector("[data-feat-fusers]");
      await pg.evaluate(async () => {
        const d = await fetch("/api/data").then(r => r.json()).catch(() => null);
        const total = ((d && d.orgs) || []).length;
        const attr = (sel, name) => {
          const el = document.querySelector(sel);
          return el ? Number(el.getAttribute(name)) : 0;
        };
        const users = attr("[data-feat-fusers]", "data-feat-fusers");
        const live = attr("[data-feat-fmisslive]", "data-feat-fmisslive");
        const pre = attr("[data-feat-fmisspre]", "data-feat-fmisspre");
        const rows = document.querySelectorAll("[data-feat-fuser]").length;
        const good = total > 50 && users > 0 && rows === users && users + live + pre === total;
        document.body.setAttribute("data-rc-fpage", good ? "1" : "0");
        document.body.setAttribute("data-rc-fpage-seen",
          users + " using + " + live + " live missing + " + pre + " pre missing = "
          + (users + live + pre) + " of " + total + " orgs, " + rows + " table rows");
      });
    } },
  { name: "org features · an unknown feature key explains itself",
    path: "/ps/feature/not_a_real_feature", needs: "[data-feat-fcrumb]" },
  /* THE DENOMINATOR IS THE WHOLE CLAIM. "Calendar Sync — 25%" and
     "Calendar Sync — 14%" are both arithmetically true (18 of 73 live, 20 of
     146 all) and only one of them is what this page says it shows. A row
     computed against the wrong denominator renders a perfectly plausible
     percentage, so the case recomputes every row from the feed and requires
     an exact match — and requires the default order to be most-adopted
     first, because a reader arrives asking what is not landing rather than
     looking a feature up alphabetically. */
  { name: "org features · by-feature ranks by adoption, scoped to live orgs",
    path: "/ps/feature", needs: '[data-rc-fslice="1"]',
    act: async (pg) => {
      await pg.waitForSelector("[data-feat-frow]");
      await pg.evaluate(async () => {
        const d = await fetch("/api/data").then(r => r.json()).catch(() => null);
        const live = ((d && d.orgs) || []).filter(o => o.launched).map(o => o.slug);
        const on = (s, k) => {
          const v = (((d.adoption || {})[s] || {})[k]) || null;
          return !!(v && (v === true || v.adopted === true || Number(v.count) > 0));
        };
        const rows = [...document.querySelectorAll("[data-feat-frow]")];
        const seen = rows.map(tr => ({
          key: tr.getAttribute("data-feat-frow"),
          pct: Number(tr.querySelector("[data-feat-adopt]").getAttribute("data-feat-adopt")),
        }));
        const wrong = seen.filter(x =>
          x.pct !== Math.round((live.filter(s => on(s, x.key)).length / live.length) * 100));
        const descending = seen.every((x, i) => i === 0 || seen[i - 1].pct >= x.pct);
        document.body.setAttribute("data-rc-fslice",
          (seen.length >= 40 && !wrong.length && descending && live.length > 20) ? "1" : "0");
        document.body.setAttribute("data-rc-fslice-seen",
          seen.length + " rows over " + live.length + " live orgs, " + wrong.length
          + " mis-scoped" + (wrong.length ? " (e.g. " + wrong[0].key + " at " + wrong[0].pct + "%)" : "")
          + ", descending=" + descending);
      });
    } },
  /* A ROW DRAWS A TREND LINE IFF IT HAS TWO COMPARABLE POINTS, and the line
     carries one vertex per point.

     THIS CASE USED TO REQUIRE A FEATURE WITH NO HISTORY, picked from the feed
     as whichever had the fewest points. THAT PREMISE EXPIRED ON 2026-09-12.
     calendar_sync, payment_plan_autopay, marketing_email and automated_waitlist
     were measured for the first time on the 11th, so the moment the 12th's bake
     landed EVERY tracked feature had two points and there was no fresh feature
     left to be the negative half. The case then went red on a page that was
     working perfectly, and its own diagnostic said as much:
     "marketing_email has 2 point(s), line=true".

     SO THE NEGATIVE HALF IS NO LONGER SOURCED FROM PRODUCTION DATA. It is the
     one claim here that can be made deterministically, and
     org-features-settings.spec.js already makes it: ofFeatureTrend over a
     one-point history returns ready:false, and Trendline run directly returns
     null for it. What only a browser can say is that the PAGE wires that up
     over the real feed, which is the iff below — and unlike the old form it
     keeps discriminating whatever the population happens to be that morning.

     THE VERTEX COUNT IS WHAT REPLACES THE OLD NEGATIVE HALF. That half existed
     to catch a series inventing a month of zeroes under a feature added
     yesterday; a line whose vertex count does not equal its comparable point
     count fails on exactly that, and goes on failing once every feature has
     history. */
  { name: "org features · a row draws a trend line iff it has comparable history",
    path: "/ps/feature", needs: '[data-rc-ftrend="1"]',
    act: async (pg) => {
      await pg.waitForSelector("[data-feat-frow]");
      await pg.evaluate(async () => {
        const d = await fetch("/api/data").then(r => r.json()).catch(() => null);
        const hist = (d && d.history) || [];
        const pts = k => hist.filter(h => h.liveOrgs > 0 && h.featureLive
                                          && h.featureLive[k] != null).length;
        const row = k => document.querySelector('[data-feat-frow="' + k + '"]');
        const poly = k => row(k) && row(k).querySelector("svg.trendline polyline");
        const verts = k => { const p = poly(k);
          return p ? (p.getAttribute("points") || "").trim().split(/\s+/).filter(Boolean).length : 0; };
        const keys = [...document.querySelectorAll("[data-feat-frow]")]
          .map(t => t.getAttribute("data-feat-frow"));
        // A line where the feed carries no history, or none where it does.
        const wrongLine = keys.filter(k => !!poly(k) !== (pts(k) >= 2));
        // A line drawn from a different series than the one the feed carries.
        const wrongLen = keys.filter(k => poly(k) && verts(k) !== pts(k));
        // ...and at least one row must actually draw one, or both checks above
        // pass on a page that renders no trend at all.
        const drawn = keys.filter(k => poly(k)).length;
        const good = keys.length > 20 && drawn > 0
                     && !wrongLine.length && !wrongLen.length;
        document.body.setAttribute("data-rc-ftrend", good ? "1" : "0");
        document.body.setAttribute("data-rc-ftrend-seen",
          drawn + " of " + keys.length + " rows draw a line · "
          + wrongLine.length + " wrong presence"
          + (wrongLine.length ? " (e.g. " + wrongLine[0] + " has " + pts(wrongLine[0])
             + " point(s), line=" + !!poly(wrongLine[0]) + ")" : "")
          + " · " + wrongLen.length + " wrong length"
          + (wrongLen.length ? " (e.g. " + wrongLen[0] + " draws " + verts(wrongLen[0])
             + " vertices for " + pts(wrongLen[0]) + " points)" : ""));
      });
    } },
  /* THE CHART DRAWS THE SERIES THE FEED CARRIES, and opens on the movers.

     Two claims, and neither is visible in source. A polyline is a string of
     coordinates: a chart plotting a truncated series, or one inventing a
     zero for a date a feature was not measured on, renders a perfectly
     plausible line and throws nothing. So the vertex count of every drawn
     line must equal the number of comparable points the feed holds for that
     feature — the same guard the trend column carries, for the same reason.

     AND THE DEFAULT IS THE WHOLE POINT OF THE CHART. Opening on the most
     adopted features draws five flat lines (the top eight by adoption have a
     delta of zero), so the default is "moved most" — asserted as the
     property rather than by re-deriving the sort here, which would only test
     the same mistake twice: every feature on screen must have moved at least
     as much as every plottable feature left off it. */
  { name: "org features · the adoption chart plots the movers, one vertex per measurement",
    path: "/ps/feature", needs: '[data-rc-fchart="1"]',
    act: async (pg) => {
      await pg.waitForSelector("[data-of-chart-line]");
      await pg.evaluate(async () => {
        const d = await fetch("/api/data").then(r => r.json()).catch(() => null);
        const hist = (d && d.history) || [];
        const pts = k => hist.filter(h => h.liveOrgs > 0 && h.featureLive
                                          && h.featureLive[k] != null).length;
        const dl = k => { const p = hist.filter(h => h.liveOrgs > 0 && h.featureLive
                                                     && h.featureLive[k] != null)
                            .map(h => Math.round((h.featureLive[k] / h.liveOrgs) * 100));
                          return p.length > 1 ? Math.abs(p[p.length - 1] - p[0]) : null; };
        const lines = [...document.querySelectorAll("[data-of-chart-line]")];
        const sel = lines.map(l => l.getAttribute("data-of-chart-line"));
        const verts = l => (l.getAttribute("points") || "").trim().split(/\s+/).filter(Boolean).length;
        // A line drawn from a different series than the feed carries.
        const wrongLen = lines.filter(l => verts(l) !== pts(l.getAttribute("data-of-chart-line")));
        // Every plottable feature, from the pills the chart itself offers.
        const all = [...document.querySelectorAll("[data-of-chart-pill]")]
          .map(b => b.getAttribute("data-of-chart-pill"));
        const off = all.filter(k => !sel.includes(k));
        const minOn = Math.min(...sel.map(k => dl(k) == null ? -1 : dl(k)));
        const maxOff = off.length ? Math.max(...off.map(k => dl(k) == null ? -1 : dl(k))) : -Infinity;
        // One line per selected pill, and the selection is the top of the order.
        const litPills = [...document.querySelectorAll("[data-of-chart-pill]")]
          .filter(b => (b.getAttribute("data-of-chart-color") || "") !== "").length;
        const good = lines.length >= 2 && litPills === lines.length
                     && !wrongLen.length && minOn >= maxOff;
        document.body.setAttribute("data-rc-fchart", good ? "1" : "0");
        document.body.setAttribute("data-rc-fchart-seen",
          lines.length + " line(s) for " + litPills + " lit pill(s) · "
          + wrongLen.length + " wrong length"
          + (wrongLen.length ? " (e.g. " + wrongLen[0].getAttribute("data-of-chart-line")
             + " draws " + verts(wrongLen[0]) + " vertices for "
             + pts(wrongLen[0].getAttribute("data-of-chart-line")) + " points)" : "")
          + " · smallest move on screen " + minOn + " vs biggest left off " + maxOff);
      });
    } },
  /* TAKING A LINE OFF MUST NOT REPAINT THE ONES THAT STAY.

     Colour follows the feature, never its position in the list — a reader who
     unticks one feature and finds that another has changed colour has been
     told the data moved. The obvious implementation (colour = index into a
     dense array of selected keys) repaints every series after the one removed,
     renders identically on first paint, and is invisible to any source
     assertion. So the case reads the real stroke of each survivor either side
     of a real click.

     IT ALSO CHECKS THE CAP, in the same pass: the palette was validated six
     deep, so a seventh pill must refuse rather than reach for a hue nobody
     checked. */
  { name: "org features · removing a line leaves the others their own colour",
    path: "/ps/feature", needs: '[data-rc-fcolor="1"]',
    act: async (pg) => {
      await pg.waitForSelector("[data-of-chart-line]");
      const before = await pg.evaluate(() => {
        const m = {};
        document.querySelectorAll("[data-of-chart-line]").forEach(l =>
          m[l.getAttribute("data-of-chart-line")] = l.getAttribute("stroke"));
        return m;
      });
      // Remove the FIRST series — the one every later slot sits behind.
      const first = Object.keys(before)[0];
      await pg.click('[data-of-chart-pill="' + first + '"]');
      await pg.waitForFunction(k => !document.querySelector('[data-of-chart-line="' + k + '"]'),
                               {}, first);
      await pg.evaluate((before2, first2) => {
        const after = {};
        document.querySelectorAll("[data-of-chart-line]").forEach(l =>
          after[l.getAttribute("data-of-chart-line")] = l.getAttribute("stroke"));
        const survivors = Object.keys(before2).filter(k => k !== first2);
        const moved = survivors.filter(k => after[k] && after[k] !== before2[k]);
        const gone = !after[first2];
        const stillThere = survivors.filter(k => after[k]).length;
        document.body.setAttribute("data-rc-fcolor",
          gone && stillThere === survivors.length && !moved.length ? "1" : "0");
        document.body.setAttribute("data-rc-fcolor-seen",
          "removed " + first2 + " · " + stillThere + " of " + survivors.length
          + " survived · " + moved.length + " repainted"
          + (moved.length ? " (e.g. " + moved[0] + " " + before2[moved[0]]
             + " → " + after[moved[0]] + ")" : ""));
      }, before, first);
    } },
  /* THE SEARCH FINDS A FEATURE WITHOUT SCROLLING SIXTY CHIPS, and it does not
     pull anything off the chart while you type.

     Dan: "a search box for the adoption graph would be helpful, for example
     'automated waitlists', I had to read through the entire list of features
     to find it." So the discriminating term is his: "automated waitlist" must
     narrow the pills to the one feature, WITHOUT unplotting the five lines
     already drawn — a series vanishing mid-keystroke is the opposite of
     looking something up, and a pill list that dropped the selected features
     would leave no way to switch them off again. Both halves are asserted,
     because a search wired to the chart instead of the list renders a
     perfectly plausible narrower chart. */
  { name: "org features · the chart search finds one feature without unplotting the rest",
    path: "/ps/feature", needs: '[data-rc-fq="1"]',
    act: async (pg) => {
      await pg.waitForSelector("[data-of-chart-line]");
      const before = await pg.evaluate(() =>
        [...document.querySelectorAll("[data-of-chart-line]")].map(l => l.getAttribute("data-of-chart-line")));
      await pg.type("[data-of-chart-q]", "automated waitlist");
      await pg.waitForFunction(() => document.querySelector("[data-of-chart-qnote]"));
      await pg.evaluate((before2) => {
        const pills = [...document.querySelectorAll("[data-of-chart-pill]")]
          .map(b => b.getAttribute("data-of-chart-pill"));
        const after = [...document.querySelectorAll("[data-of-chart-line]")]
          .map(l => l.getAttribute("data-of-chart-line"));
        // the term finds it, and does not leave the whole catalogue listed
        const found = pills.includes("automated_waitlist");
        // every line that was drawn is still drawn, and still has a pill
        const dropped = before2.filter(k => !after.includes(k));
        const orphan = before2.filter(k => !pills.includes(k));
        const note = document.querySelector("[data-of-chart-qnote]");
        const matched = note ? Number(note.getAttribute("data-of-chart-qnote")) : -1;
        const good = found && matched > 0 && matched < 10
                     && !dropped.length && !orphan.length;
        document.body.setAttribute("data-rc-fq", good ? "1" : "0");
        document.body.setAttribute("data-rc-fq-seen",
          "automated_waitlist " + (found ? "found" : "NOT FOUND") + " \u00b7 " + matched
          + " matched \u00b7 " + pills.length + " pill(s) listed \u00b7 "
          + dropped.length + " line(s) unplotted by typing \u00b7 "
          + orphan.length + " plotted line(s) left with no pill");
      }, before);
    } },
  /* THE RANGE PRESETS, AND THE ONES THE HISTORY CANNOT FILL SAY SO.

     Dan asked for "last 30, last 3 months, 6 months" rather than a date
     range. With the bake only recording since 2026-09-07 every preset is
     still the whole series, so they render DISABLED rather than absent —
     hiding a control he asked for makes "was this built?" unanswerable, and
     all five drawing the same chart would make it look broken. This asserts
     the shape that follows from the data rather than a fixed list: All is
     always pickable, and a preset is enabled iff it would actually cut the
     series. */
  { name: "org features · the range presets offer only what the history can fill",
    path: "/ps/feature", needs: '[data-rc-frange="1"]',
    act: async (pg) => {
      await pg.waitForSelector("[data-of-chart-rangeopt]");
      await pg.evaluate(async () => {
        const d = await fetch("/api/data").then(r => r.json()).catch(() => null);
        const hist = ((d && d.history) || []).filter(h => h && h.liveOrgs > 0);
        const span = hist.length > 1
          ? Math.round((Date.parse(hist[hist.length - 1].date) - Date.parse(hist[0].date)) / 86400000) + 1
          : hist.length;
        const btns = [...document.querySelectorAll("[data-of-chart-rangeopt]")];
        const on = btns.filter(b => b.getAttribute("data-of-chart-rangeon") === "1")
                       .map(b => b.getAttribute("data-of-chart-rangeopt"));
        const days = { "30d": 30, "3m": 91, "6m": 182, "12m": 365 };
        // enabled iff the preset is shorter than the span the feed actually holds
        const wrong = btns.filter(b => {
          const id = b.getAttribute("data-of-chart-rangeopt");
          const en = b.getAttribute("data-of-chart-rangeon") === "1";
          return id === "all" ? !en : en !== (days[id] < span);
        });
        // a disabled preset must also be unclickable, not merely grey
        const clickable = btns.filter(b => b.getAttribute("data-of-chart-rangeon") === "0" && !b.disabled);
        const good = btns.length === 5 && on.includes("all") && !wrong.length && !clickable.length;
        document.body.setAttribute("data-rc-frange", good ? "1" : "0");
        document.body.setAttribute("data-rc-frange-seen",
          btns.length + " preset(s) \u00b7 history spans " + span + " day(s) \u00b7 enabled: "
          + (on.join(",") || "none") + " \u00b7 " + wrong.length + " wrongly gated"
          + (wrong.length ? " (e.g. " + wrong[0].getAttribute("data-of-chart-rangeopt") + ")" : "")
          + " \u00b7 " + clickable.length + " grey but still clickable");
      });
    } },
  /* EVERY LINE IS NAMED ON THE CHART, AND TWO FEATURES AT THE SAME SHARE DO
     NOT STACK THEIR LABELS.

     Colour alone is not enough here: three of the six validated series colours
     sit below 3:1 against this page's white card, and the validator's contrast
     finding obliges visible labels rather than a swatch to match by eye.

     THE CASE PICKS ITS OWN PAIR, and that is the whole design of it. The
     default five finish at 26, 40, 58, 66 and 82 per cent — nowhere near each
     other — so over that selection the de-collision code never runs and
     deleting it changes nothing on screen. It was verified to survive exactly
     that way before this was rewritten. So the case clears the chart and
     selects the CLOSEST PAIR the feed happens to hold, which is the only
     selection where a stacked label and a placed one look different. Computed
     from the pills rather than hardcoded, or it expires the first morning
     those two features drift apart. */
  { name: "org features · two features at the same share still read as two",
    path: "/ps/feature", needs: '[data-rc-fchartlabel="1"]',
    act: async (pg) => {
      await pg.waitForSelector("[data-of-chart-line]");
      // Clear the default selection, then plot the closest pair.
      const pair = await pg.evaluate(() => {
        const pills = [...document.querySelectorAll("[data-of-chart-pill]")];
        const pct = b => Number((b.textContent.match(/(\d+)%/) || [0, -1])[1]);
        const lit = pills.filter(b => (b.getAttribute("data-of-chart-color") || "") !== "")
                         .map(b => b.getAttribute("data-of-chart-pill"));
        let best = null;
        for (let a = 0; a < pills.length; a++)
          for (let b = a + 1; b < pills.length; b++) {
            const gap = Math.abs(pct(pills[a]) - pct(pills[b]));
            if (!best || gap < best.gap)
              best = { gap, keys: [pills[a].getAttribute("data-of-chart-pill"),
                                   pills[b].getAttribute("data-of-chart-pill")] };
          }
        return { lit, pair: best ? best.keys : [], gap: best ? best.gap : -1 };
      });
      for (const k of pair.lit) await pg.click('[data-of-chart-pill="' + k + '"]');
      for (const k of pair.pair) await pg.click('[data-of-chart-pill="' + k + '"]');
      await pg.waitForFunction(() => document.querySelectorAll("[data-of-chart-line]").length === 2);
      await pg.evaluate((gap) => {
        const lines = [...document.querySelectorAll("[data-of-chart-line]")]
          .map(l => l.getAttribute("data-of-chart-line"));
        const labs = [...document.querySelectorAll("[data-of-chart-endlabel]")];
        const named = lines.filter(k =>
          labs.some(t => t.getAttribute("data-of-chart-endlabel") === k
                         && (t.textContent || "").trim().length > 2));
        const ys = labs.map(t => Number(t.getAttribute("y")) || 0).sort((a, b) => a - b);
        const collided = ys.filter((y, i) => i && y - ys[i - 1] < 10).length;
        /* AND THE LABEL HAS TO FIT THE GUTTER IT LIVES IN. A name running off
           the right edge of the viewBox is silently cropped by the SVG \u2014 it
           throws nothing, the label is still "present" by every other test
           here, and the reader loses the end of it. That shipped at r:150 and
           only a screenshot showed it, so it is measured from the real text. */
        const svg = document.querySelector("svg.fchart");
        const vbW = svg ? svg.viewBox.baseVal.width : 0;
        const clipped = labs.filter(t => {
          const bb = t.getBBox ? t.getBBox() : null;
          return bb && (bb.x + bb.width) > vbW;
        });
        document.body.setAttribute("data-rc-fchartlabel",
          lines.length === 2 && named.length === 2 && !collided && !clipped.length ? "1" : "0");
        document.body.setAttribute("data-rc-fchartlabel-seen",
          named.length + " of " + lines.length + " named · the pair is " + gap
          + " point(s) apart · closest labels "
          + (ys.length > 1 ? (ys[1] - ys[0]).toFixed(1) : "n/a") + "px apart"
          + (collided ? " \u2014 STACKED" : "")
          + " \u00b7 " + clipped.length + " clipped"
          + (clipped.length ? " (e.g. " + clipped[0].textContent.trim() + " ends at "
             + (clipped[0].getBBox().x + clipped[0].getBBox().width).toFixed(0)
             + " of " + vbW + ")" : ""));
      }, pair.gap);
    } },
  /* THE SEARCH MUST REACH FIELDS THAT ARE NOT ON SCREEN. "calendar" matching
     Calendar Sync proves almost nothing — the name is right there. The
     discriminating term is one that appears ONLY in the description, because
     a box wired to the visible name renders identically and finds nothing.
     And the KPI row above must NOT move, or the median becomes a different
     statistic every keystroke. */
  { name: "org features · the search reaches the description, and the KPIs do not move",
    path: "/ps/feature", needs: '[data-rc-fsearch="1"]',
    act: async (pg) => {
      await pg.waitForSelector("[data-feat-fq]");
      const before = await pg.evaluate(() => ({
        rows: document.querySelectorAll("[data-feat-frow]").length,
        tracked: document.querySelector("[data-feat-fcount]").getAttribute("data-feat-fcount"),
        median: document.querySelector("[data-feat-fmedian]").getAttribute("data-feat-fmedian"),
      }));
      await pg.type("[data-feat-fq]", "outlook");
      await pg.waitForFunction(() =>
        document.querySelector("[data-feat-fqnote]") !== null);
      await pg.evaluate((b) => {
        const keys = [...document.querySelectorAll("[data-feat-frow]")]
          .map(t => t.getAttribute("data-feat-frow"));
        const after = {
          tracked: document.querySelector("[data-feat-fcount]").getAttribute("data-feat-fcount"),
          median: document.querySelector("[data-feat-fmedian]").getAttribute("data-feat-fmedian"),
        };
        const good = b.rows > 20 && keys.length > 0 && keys.length < b.rows
          && keys.indexOf("calendar_sync") >= 0
          && after.tracked === b.tracked && after.median === b.median;
        document.body.setAttribute("data-rc-fsearch", good ? "1" : "0");
        document.body.setAttribute("data-rc-fsearch-seen",
          b.rows + " rows before, " + keys.length + " after (" + keys.join(",") + ")"
          + ", tracked " + b.tracked + "→" + after.tracked
          + ", median " + b.median + "→" + after.median);
      }, before);
    } },
  /* A SEARCH THAT MATCHES NOTHING IS ITS OWN EMPTY STATE, naming the query,
     rather than the settings message — the two have different fixes. */
  { name: "org features · a search matching nothing says which search",
    path: "/ps/feature", needs: '[data-feat-fempty="zzzznotafeature"]',
    act: async (pg) => {
      await pg.waitForSelector("[data-feat-fq]");
      await pg.type("[data-feat-fq]", "zzzznotafeature");
    } },
  { name: "org features · the slice tabs link the two views", path: "/ps/feature",
    needs: '[data-rc-fslicetab="1"]',
    act: async (pg) => {
      await pg.waitForSelector(".slicetabs");
      await pg.evaluate(() => {
        const tabs = [...document.querySelectorAll(".slicetab")];
        const on = tabs.filter(t => t.classList.contains("on"));
        const good = tabs.length === 2 && on.length === 1
          && on[0].getAttribute("href") === "/ps/feature"
          && tabs.some(t => t.getAttribute("href") === "/ps/features");
        document.body.setAttribute("data-rc-fslicetab", good ? "1" : "0");
        document.body.setAttribute("data-rc-fslicetab-seen",
          tabs.length + " tabs, " + on.length + " lit" + (on[0] ? " (" + on[0].getAttribute("href") + ")" : ""));
      });
    } },
  /* The Settings & Configuration category, on both surfaces. It is the one
     category that exists only because features were MOVED into it, so a
     regroup that half-applies (catalog edited, short label missing) shows
     up here as a 24-character column header rather than as an error. */
  { name: "org features · the Settings column", path: "/ps/features", text: "SETTINGS" },
  { name: "org features · the Settings panel on a drill-in",
    path: "/ps/features/apex-park-and-recreation-district",
    needs: '[data-feat-cat="Settings & Configuration"]' },
  { name: "org features · the settings sheet", path: "/ps/features", needs: "[data-feat-settings]",
    act: async (pg) => {
      await pg.waitForSelector("[data-feat-gear]");
      await pg.click("[data-feat-gear]");
    } },
  { name: "account health", path: "/ps", needs: "table" },
  { name: "bug management", path: "/ps/bugs", needs: "table" },
  /* Text rather than a selector: this page is built from inline styles and
     carries no class of its own. Keyed on a figure it computes from the
     snapshot, so a page that renders its chrome and no data still fails. */
  { name: "cx reporting", path: "/ps/reporting", text: "services" },
  { name: "how this works", path: "/ps/how", needs: "svg" },
  { name: "updates", path: "/ps/updates", needs: ".panel" },
  { name: "the public dashboard", path: "/", needs: ".panel" },

  /* THE GREYED RANGE ROW EXPLAINS ITSELF, WHERE THE BUTTONS ARE. Dan asked
     why the presets were not clickable — the reason was in each button's
     `title` and in the chart's own footnote, and neither reached him.

     THE CASE KEYS ON POSITION, not on the text existing: the footnote below
     the chart already says the same thing, and has since the chart shipped,
     so "a line mentions the history length" passes on the build that
     prompted the question. What is new is that it sits INSIDE the range row,
     beside the controls it explains. */
  { name: "org features · the greyed ranges say why, next to the buttons",
    path: "/ps/feature", needs: '[data-rc-rangenote="1"]',
    act: async (pg) => {
      await pg.waitForSelector(".fchart-ranges");
      await pg.evaluate(() => {
        const row = document.querySelector(".fchart-ranges");
        const note = row && row.querySelector(".fchart-rangenote");
        const gated = [...document.querySelectorAll(".fchart-range[disabled]")];
        const txt = note ? note.textContent : "";
        /* All three: something IS gated (or the note is correctly absent and
           this case is testing nothing), the note is a DESCENDANT of the row
           rather than anywhere on the page, and it names a day count. */
        const ok = gated.length > 0 && !!note && /\d+ days? of history/.test(txt);
        document.body.setAttribute("data-rc-rangenote", ok ? "1" : "0");
        document.body.setAttribute("data-rc-rangenote-seen",
          gated.length + " gated preset(s) · note in the row: " + (!!note)
          + " · " + JSON.stringify(txt.slice(0, 70)));
      });
    } },

  /* ── THE THEME ─────────────────────────────────────────────────────────
     NO SOURCE ASSERTION CAN SEE ANY OF THIS. A stylesheet full of tokens
     reads exactly as plausibly whether or not the dark scope ever wins, and
     `data-theme="dark"` on <html> is an attribute, not a dark page — the
     sibling project shipped a `wx-night` class that named a night sky and
     painted none of it. So these cases read the COMPUTED background of a
     real card and the LUMINANCE of the ink on it, and compare the two modes
     against each other rather than against a hex nobody would notice
     drifting. */
  { name: "theme · a stored Dark really paints dark",
    path: "/ps/features", needs: '[data-rc-dark="1"]',
    pre: async (pg) => pg.evaluateOnNewDocument(() => {
      try { localStorage.setItem("psTheme", "dark"); } catch (e) {} }),
    act: async (pg) => {
      await pg.waitForSelector(".panel");
      await pg.evaluate(() => {
        const lum = (c) => {
          const [r, g, b] = (c.match(/[\d.]+/g) || [255, 255, 255]).slice(0, 3).map(Number);
          const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const panel = document.querySelector(".panel");
        const h2 = panel.querySelector("h2") || panel;
        const bg = lum(getComputedStyle(panel).backgroundColor);
        const ink = lum(getComputedStyle(h2).color);
        const page = lum(getComputedStyle(document.body).backgroundColor);
        /* A DARK CARD ON A DARKER PAGE, WITH LIGHT INK ON IT. All three, or
           a card that stayed white inside a dark page passes the first. */
        document.body.setAttribute("data-rc-dark",
          bg < 0.15 && page < 0.15 && ink > 0.4 ? "1" : "0");
        document.body.setAttribute("data-rc-dark-seen",
          `page lum ${page.toFixed(3)} · card ${bg.toFixed(3)} · ink ${ink.toFixed(3)}`);
      });
    } },

  /* CLICKING IT REPAINTS, WITHOUT A RELOAD. The stamp is written by the head
     script on load; the toggle has to write the same attribute live, or the
     control appears to do nothing until you navigate. */
  { name: "theme · clicking Dark repaints the page",
    path: "/ps/features", needs: '[data-rc-flip="1"]',
    pre: async (pg) => pg.evaluateOnNewDocument(() => {
      try { localStorage.setItem("psTheme", "light"); } catch (e) {} }),
    act: async (pg) => {
      await pg.waitForSelector('.themebtn');
      const read = () => pg.evaluate(() => getComputedStyle(document.querySelector(".panel")).backgroundColor);
      const before = await read();
      await pg.evaluate(() => [...document.querySelectorAll(".themebtn")]
        .find(b => b.textContent.includes("Dark")).click());
      await pg.waitForFunction(() => document.documentElement.getAttribute("data-theme") === "dark",
                               { timeout: 5000 });
      const after = await read();
      await pg.evaluate((b, a) => {
        const lum = (c) => {
          const [r, g, bl] = (c.match(/[\d.]+/g) || [255, 255, 255]).slice(0, 3).map(Number);
          const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
        };
        document.body.setAttribute("data-rc-flip", lum(b) > 0.6 && lum(a) < 0.15 ? "1" : "0");
        document.body.setAttribute("data-rc-flip-seen", `card ${b} -> ${a}`);
      }, before, after);
    } },

  /* AND IT SURVIVES A RELOAD, STAMPED BEFORE THE FIRST PAINT. This is the
     flash test: the attribute has to be on <html> from the head script, so
     it is already there when React mounts rather than being applied by an
     effect a frame later. Reading it inside an early document script is the
     only way to tell those two apart from the outside. */
  { name: "theme · the choice survives a reload, with no light flash",
    path: "/ps/features", needs: '[data-rc-persist="1"]',
    pre: async (pg) => pg.evaluateOnNewDocument(() => {
      try { localStorage.setItem("psTheme", "dark"); } catch (e) {}
      /* SAMPLED THE MOMENT <body> EXISTS, which is while <head> has just
         finished parsing and long before the app script at the foot of the
         document has run. `documentElement` is still null when this hook
         itself runs, so an observer is the only way to catch that instant —
         and it is the instant that matters: a stamp applied from a React
         effect lands frames later, after a white first paint. */
      const obs = new MutationObserver(() => {
        if (!document.body || window.__themeAtStart !== undefined) return;
        window.__themeAtStart = document.documentElement.getAttribute("data-theme");
        window.__rootEmptyAtStart = !document.getElementById("root")
          || !document.getElementById("root").childNodes.length;
        obs.disconnect();
      });
      obs.observe(document, { childList: true, subtree: true });
    }),
    act: async (pg) => {
      await pg.waitForSelector(".panel");
      await pg.evaluate(() => {
        /* BOTH HALVES. "It was dark" alone would pass if the sample simply
           happened after React; requiring the root to have been EMPTY at the
           same instant is what says the stamp beat the app. */
        document.body.setAttribute("data-rc-persist",
          window.__themeAtStart === "dark" && window.__rootEmptyAtStart === true ? "1" : "0");
        document.body.setAttribute("data-rc-persist-seen",
          "data-theme when <body> appeared: " + String(window.__themeAtStart)
          + " · react had not rendered: " + String(window.__rootEmptyAtStart));
      });
    } },

  /* AN UNPINNED VIEWER FOLLOWS THE OS, with no stored value and no script —
     the media query alone. */
  { name: "theme · unpinned follows the OS",
    path: "/ps/features", needs: '[data-rc-os="1"]',
    pre: async (pg) => {
      await pg.evaluateOnNewDocument(() => { try { localStorage.removeItem("psTheme"); } catch (e) {} });
      await pg.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    },
    act: async (pg) => {
      await pg.waitForSelector(".panel");
      await pg.evaluate(() => {
        const lum = (c) => {
          const [r, g, b] = (c.match(/[\d.]+/g) || [255, 255, 255]).slice(0, 3).map(Number);
          const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const bg = lum(getComputedStyle(document.querySelector(".panel")).backgroundColor);
        const stamped = document.documentElement.getAttribute("data-theme");
        /* NO STAMP AND STILL DARK is the whole claim — a stamp here would
           mean the app wrote one, which is not what an unpinned viewer gets. */
        document.body.setAttribute("data-rc-os", bg < 0.15 && !stamped ? "1" : "0");
        document.body.setAttribute("data-rc-os-seen",
          `card lum ${bg.toFixed(3)} · stamp ${String(stamped)}`);
      });
    } },

  /* THE ONE THAT ACTUALLY BREAKS: a pinned Light on a dark machine. Without
     the :not([data-theme="light"]) guard on the media query, the OS wins and
     the toggle silently does nothing in that one direction — which reads as
     the feature being broken rather than as a cascade bug. */
  { name: "theme · a pinned Light beats a dark OS",
    path: "/ps/features", needs: '[data-rc-pinlight="1"]',
    pre: async (pg) => {
      await pg.evaluateOnNewDocument(() => { try { localStorage.setItem("psTheme", "light"); } catch (e) {} });
      await pg.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    },
    act: async (pg) => {
      await pg.waitForSelector(".panel");
      await pg.evaluate(() => {
        const lum = (c) => {
          const [r, g, b] = (c.match(/[\d.]+/g) || [255, 255, 255]).slice(0, 3).map(Number);
          const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const bg = lum(getComputedStyle(document.querySelector(".panel")).backgroundColor);
        document.body.setAttribute("data-rc-pinlight", bg > 0.6 ? "1" : "0");
        document.body.setAttribute("data-rc-pinlight-seen", `card lum ${bg.toFixed(3)} on a dark OS`);
      });
    } },

  /* THE CHART THEMES WITH THE PAGE. Its lines are SVG, and an SVG
     presentation attribute is the one place a token could have failed to
     resolve — so this reads the COMPUTED stroke of a real line in each mode
     and requires the two to differ. A line still painting its light step on
     a dark card is the shape this catches. */
  /* THE SHARED METRIC PILL, which is the one thing here that was actually
     broken and that nothing could see. /feature-pills.js serves BOTH this
     themed page and the light-only public dashboard, so its colours lived as
     hardcoded hex — a "measured zero" pill painted #fff with #cbd5e1 ink,
     i.e. a white chip on a slate card. It renders only inside the A/B compare
     panel, which is why no existing case and no screenshot of the default
     page ever showed it.

     THE FLOOR IS THE LIGHT MODE'S OWN, NOT 3:1. A first draft required 3:1
     of every pill and FAILED ON CORRECT CODE: the two recessive branches are
     deliberately faint in both modes — a measured zero is 1.48:1 on white by
     design, so the number recedes and the column reads as a comparison. A
     blanket floor would have been an assertion about a decision nobody made
     here. What dark must not do is be WORSE than the mode that ships today,
     and it must not paint a light chip on a dark card — so the case measures
     both modes on the same element and compares them. */
  { name: "theme · the shared metric pill is no worse in dark",
    path: "/ps/features", needs: '[data-rc-pill="1"]',
    pre: async (pg) => pg.evaluateOnNewDocument(() => {
      try { localStorage.setItem("psTheme", "dark"); } catch (e) {} }),
    act: async (pg) => {
      await pg.waitForSelector("select");
      /* THE TWO BUSIEST ORGS, read from the snapshot rather than taken as the
         first two options. The first two are alphabetical and pre-launch —
         every metric is a real ZERO, so the ramp's `v === 0` branch returns
         before `t` is ever computed and the WASH is never drawn. A first
         draft did exactly that and an inverted ink mutation survived it:
         a fixture where a wrong implementation cannot look wrong is not a
         guard. */
      await pg.evaluate(async () => {
        const d = await fetch("/api/data").then(r => r.json());
        const tot = (u) => Object.values(u || {}).reduce((a, b) => a + (Number(b) || 0), 0);
        const busiest = Object.entries(d.usage || {})
          .map(([slug, u]) => ({ slug, n: tot(u) }))
          .sort((a, b) => b.n - a.n).slice(0, 2);
        const set = (el, slug) => {
          Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")
            .set.call(el, slug);
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const sels = [...document.querySelectorAll("select")].slice(0, 2);
        set(sels[0], busiest[0].slug); set(sels[1], busiest[1].slug);
        window.__pillOrgs = busiest.map(b => b.slug + " (" + b.n + ")").join(" vs ");
      });
      await pg.waitForSelector(".cmprow .pill.mpill", { timeout: 15000 });
      await pg.evaluate(() => {
        const lum = (c) => {
          const [r, g, b] = (c.match(/[\d.]+/g) || [255, 255, 255]).slice(0, 3).map(Number);
          const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const ratio = (a, b) => {
          const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
          return (x + 0.05) / (y + 0.05);
        };
        /* Read EVERY pill in the panel, not the first: the ramp has three
           branches (not measured, a real zero, the wash) and a case that
           sampled one would pass on the other two being white. */
        const read = () => [...document.querySelectorAll(".cmprow .pill.mpill")].map(p => {
          const st = getComputedStyle(p);
          return { bg: st.backgroundColor, ink: st.color,
                   l: lum(st.backgroundColor), r: ratio(st.color, st.backgroundColor) };
        });
        const dark = read();
        document.documentElement.setAttribute("data-theme", "light");
        const light = read();
        document.documentElement.setAttribute("data-theme", "dark");

        /* A LIGHT CHIP ON A DARK CARD is the regression this exists for, and
           it is the one thing that needs no baseline to judge. */
        const chips = dark.filter(x => x.l > 0.5);
        /* AND NO BRANCH MAY BE WORSE THAN THE MODE THAT SHIPS TODAY. The
           0.15 slack is for compositing rounding, not for a real drop. */
        const worse = dark.map((d, i) => ({ d, l: light[i] }))
          .filter(x => x.l && x.d.r < x.l.r - 0.15);
        /* AND THE WASH MUST HAVE RENDERED. The recessive branches are flat
           token colours; the ramp is the only one that produces a
           translucent fill, so a run where every pill is the same colour as
           its neighbours has exercised nothing. */
        const distinct = new Set(dark.map(x => x.bg)).size;
        document.body.setAttribute("data-rc-pill",
          dark.length > 0 && distinct > 1 && !chips.length && !worse.length ? "1" : "0");
        document.body.setAttribute("data-rc-pill-seen",
          dark.length + " pill(s), " + distinct + " distinct fill(s) · "
          + (window.__pillOrgs || "?") + " · " + chips.length + " light chip(s) · "
          + worse.length + " worse than light"
          + (chips.length ? " (chip bg " + chips[0].bg + ")" : "")
          + (worse.length ? " (" + worse[0].d.r.toFixed(2) + ":1 dark vs "
             + worse[0].l.r.toFixed(2) + ":1 light)" : ""));
      });
    } },

  { name: "theme · the chart's series colours follow the theme",
    path: "/ps/feature", needs: '[data-rc-series="1"]',
    pre: async (pg) => pg.evaluateOnNewDocument(() => {
      try { localStorage.setItem("psTheme", "dark"); } catch (e) {} }),
    act: async (pg) => {
      await pg.waitForSelector("[data-of-chart-line]");
      await pg.evaluate(() => {
        const l = document.querySelector("[data-of-chart-line]");
        const dark = getComputedStyle(l).stroke;
        document.documentElement.setAttribute("data-theme", "light");
        const light = getComputedStyle(l).stroke;
        document.documentElement.setAttribute("data-theme", "dark");
        /* BOTH REAL AND DIFFERENT. A token that failed to resolve computes
           to black in both, which would otherwise pass an "it changed" test
           only by accident. */
        const real = (c) => /^rgb/.test(c) && c !== "rgb(0, 0, 0)";
        document.body.setAttribute("data-rc-series",
          real(dark) && real(light) && dark !== light ? "1" : "0");
        document.body.setAttribute("data-rc-series-seen", `line stroke light ${light} · dark ${dark}`);
      });
    } },
];

for (const c of CASES) {
  if (!c.needs && !c.text) {
    console.error(`✗ case "${c.name}" asserts nothing — a case with neither \`needs\` nor \`text\` passes on a blank page.`);
    process.exit(1);
  }
}

const only = process.argv[2];
const cases = only ? CASES.filter(c => c.name.includes(only)) : CASES;

(async () => {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await wait(250);
    try { up = (await req("GET", "/healthz")).status === 200; } catch { /* not yet */ }
  }
  if (!up) { console.error("✗ the server never answered /healthz\n" + log); child.kill(); process.exit(1); }

  const su = await req("POST", "/api/auth/signup",
    { name: "Render Check", email: "render@example.com", password: "render-check-pw", code: "render-check" });
  if (su.status !== 200) { console.error("✗ could not sign in: " + su.status + " " + su.body); child.kill(); process.exit(1); }
  const [cn, cv] = su.cookies.map(x => x.split(";")[0])[0].split("=");

  const browser = await puppeteer.launch({ executablePath: EXECUTABLE,
    args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  let failed = 0;

  for (const c of cases) {
    const pg = await browser.newPage();
    await pg.setViewport({ width: 1500, height: 1000 });
    const errs = [];
    pg.on("pageerror", e => errs.push(String(e).split("\n")[0]));
    pg.on("console", m => { if (m.type() === "error") errs.push("console: " + m.text().split("\n")[0]); });
    await pg.setCookie({ name: cn, value: cv, domain: "127.0.0.1", path: "/" });
    try {
      /* A `pre` HOOK, BECAUSE SOME STATE DECIDES THE FIRST PAINT. The theme
         is stamped onto <html> by a script in the head, so a theme set from
         `act` is set AFTER the page it decides has already been drawn — the
         case would be testing a repaint rather than a load. Anything that
         has to be true before navigation goes here: seeded localStorage, an
         emulated OS preference. */
      if (c.pre) await c.pre(pg);
      await pg.goto(`http://127.0.0.1:${PORT}${c.path}`, { waitUntil: "networkidle2", timeout: 45000 });
      if (c.act) await c.act(pg);
      if (c.needs) await pg.waitForSelector(c.needs, { timeout: 30000 });
      if (c.text) await pg.waitForFunction(
        t => document.body.innerText.includes(t), { timeout: 30000 }, c.text);
      if (errs.length) throw new Error(errs[0]);
      console.log(`✓ ${c.name}`);
    } catch (e) {
      /* A BLANK PAGE AND A MISSING SELECTOR LOOK THE SAME FROM HERE, so say
         which it was — an unmounted tree leaves an empty <div id="root">. */
      let extra = "";
      try {
        const bodyLen = await pg.evaluate(() => document.body.innerText.trim().length);
        extra = bodyLen < 40 ? "  (the page came up BLANK — likely an uncaught error unmounting React)" : "";
        /* WHAT THE CASE ACTUALLY MEASURED. Every act-driven case stamps a
           `data-rc-*-seen` string and nothing ever read one, so a failure
           reported "the selector never appeared" and left the numbers that
           would explain it sitting on the element. */
        const seen = await pg.evaluate(() => [...document.body.attributes]
          .filter(a => /^data-rc-.*-seen$/.test(a.name))
          .map(a => a.name.replace(/^data-rc-|-seen$/g, "") + ": " + a.value).join(" · "));
        if (seen) extra += "\n    measured — " + seen;
      } catch { /* page is gone */ }
      console.error(`✗ ${c.name}: ${errs[0] || e.message}${extra}`);
      failed++;
    }
    await pg.close();
  }

  await browser.close();
  child.kill();
  if (failed) { console.error(`\n✗ ${failed} of ${cases.length} case(s) failed.`); process.exit(1); }
  console.log(`\n✓ ${cases.length} case(s) render with no uncaught errors.`);
})().catch(e => { console.error("✗ " + e.message + "\n" + log.slice(-1500)); child.kill(); process.exit(1); });
