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
  { name: "org features · the list", path: "/ps/features", needs: "[data-feat-fp]" },
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
