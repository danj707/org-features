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

let puppeteer;
try { puppeteer = require("puppeteer"); }
catch { /* resolved below */ }
if (!puppeteer) {
  for (const guess of ["/home/user/rental-report/node_modules/puppeteer",
                       path.join(__dirname, "..", "node_modules", "puppeteer")]) {
    try { puppeteer = require(guess); break; } catch { /* keep looking */ }
  }
}
/* SKIPS WITH A MESSAGE, never passes silently. A render check that reports
   success without having opened a browser is the warm-cache sign-off this
   repo family already has a rule about. */
if (!puppeteer) {
  console.log("⊘ ci-check-render.js SKIPPED — puppeteer is not installed. This check proves nothing without it.");
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
