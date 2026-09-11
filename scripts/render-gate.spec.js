#!/usr/bin/env node
/* THE RENDER JOB WAS GREEN AND HAD NEVER OPENED A BROWSER.
 *
 * `ci-check-render.js` is the only check in this repo that can see the class
 * of bug that blanks a page - a value read above its own declaration inside
 * the one Babel block, which parses, boots, serves a 200, and renders nothing.
 * The workflow ran `npx puppeteer browsers install chrome`, which installs a
 * BROWSER and not the LIBRARY, so `require("puppeteer")` failed on every run,
 * the script printed its skip line, exited 0, and GitHub drew a tick.
 *
 * A green tick on a check that never ran is worse than no check, because it is
 * trusted. So there are two halves here and both are load-bearing:
 *   1. the dependency is declared AND locked, so `npm ci` installs it, and
 *   2. the script FAILS rather than skips when CI is set, so if the install
 *      ever breaks again the job goes red instead of silently green.
 * Either alone leaves the hole: a declared dependency can stop resolving, and
 * a hard failure with nothing installed fails every run.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
let passed = 0; const failures = [];
function ok(cond, msg) { if (cond) passed++; else failures.push(msg); }
function eq(a, b, msg) { ok(a === b, msg + " (got " + JSON.stringify(a) + ", want " + JSON.stringify(b) + ")"); }

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(ROOT, "package-lock.json"), "utf8"));
const wf = fs.readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");
const src = fs.readFileSync(path.join(ROOT, "scripts", "ci-check-render.js"), "utf8");

/* ---- 1. the dependency is declared and LOCKED ------------------------- */
const dev = pkg.devDependencies || {};
ok(dev.puppeteer, "puppeteer is a devDependency - the render check cannot require what npm never installs");
ok(!(pkg.dependencies || {}).puppeteer,
   "...and a DEV dependency, not a runtime one: the server never launches a browser and Railway should not ship a 170MB Chrome");
/* `npm ci` installs from the lockfile alone and FAILS OUTRIGHT on a
   devDependency the lock does not carry, so the pair has to be checked. */
const locked = Object.keys(lock.packages || {}).some(k => k === "node_modules/puppeteer");
ok(locked, "puppeteer is in package-lock.json - `npm ci` reads the lock, not package.json, and errors on a mismatch");
ok(pkg.scripts && /ci-check-render/.test(pkg.scripts.render || ""),
   "`npm run render` still runs the render check");

/* ---- 2. the workflow ------------------------------------------------- */
const jobs = {};
{
  const lines = wf.slice(wf.indexOf("\njobs:")).split("\n");
  let cur = null;
  for (const ln of lines) {
    const m = /^  ([a-z][\w-]*):\s*$/.exec(ln);
    if (m) { cur = m[1]; jobs[cur] = []; continue; }
    if (cur) jobs[cur].push(ln);
  }
}
ok(Object.keys(jobs).length >= 3, "the workflow's jobs were found - " + Object.keys(jobs).join(", "));
const render = (jobs.render || []).join("\n");
ok(render, "there is a `render` job");
ok(/npm ci/.test(render), "the render job installs dependencies");
ok(/npm run render/.test(render), "...and runs the render check");
/* THE STEP THAT MADE THE GAP LOOK COVERED. It fetched a browser and nothing
   else, which reads in the log exactly like preparing to drive one. */
ok(!/browsers install/.test(render),
   "the render job does NOT install a browser by itself - that step is what made a library-less job look prepared");
/* SKIPPING THE DOWNLOAD IN THE RENDER JOB WOULD REINSTATE THE BUG IN ITS
   PUREST FORM: the library present, no browser, and the launch failing. */
ok(!/PUPPETEER_SKIP_DOWNLOAD/.test(render),
   "the render job does NOT skip the browser download - it is the one job that needs the browser");
for (const j of ["validate", "boot"]) {
  ok(/PUPPETEER_SKIP_DOWNLOAD/.test((jobs[j] || []).join("\n")),
     "the " + j + " job skips the browser download - it never drives one, and the fetch is ~170MB per run");
}

/* ---- 3. the gate, RUN rather than read ------------------------------- */
/* A regex over the branch proves the text is there. Only running it proves
   which way it goes, and the direction is the whole point. The copy lands in
   a directory with no node_modules anywhere above it, so `require("puppeteer")`
   genuinely cannot resolve - which is the CI condition reproduced rather than
   simulated. */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "render-gate-"));
const sub = path.join(tmp, "scripts");
fs.mkdirSync(sub);
const copy = path.join(sub, "ci-check-render.js");
fs.writeFileSync(copy, src);
function run(env) {
  const e = { ...process.env, ...env };
  delete e.NODE_PATH;
  return spawnSync(process.execPath, [copy], { env: e, encoding: "utf8", timeout: 60000 });
}
{
  const r = run({ CI: "1" });
  eq(r.status, 1, "with CI set and puppeteer unresolvable the render check EXITS NONZERO - this is the bug, and it used to exit 0");
  ok(/FAILURE/.test(r.stderr || ""), "...and says so on stderr rather than leaving a silent red");
  ok(/devDependencies/.test((r.stderr || "") + (r.stdout || "")),
     "...naming the remedy, because the next person to hit this has to know it is an install problem and not a browser one");
}
{
  const e = { ...process.env }; delete e.CI;
  const r = run({ CI: undefined, ...{} });
  const r2 = spawnSync(process.execPath, [copy], { env: e, encoding: "utf8", timeout: 60000 });
  eq(r2.status, 0, "OUTSIDE CI it still skips rather than failing - a contributor without a browser must not be blocked");
  ok(/SKIPPED/.test(r2.stdout || ""), "...and says it skipped, so nobody reads a silent pass as a pass");
  void r;
}
fs.rmSync(tmp, { recursive: true, force: true });

/* ---- 4. no hand-written path to another project's copy ---------------- */
/* The old block reached for `/home/user/rental-report/node_modules/puppeteer`.
   That is a path on one machine belonging to a different repository, and it is
   why a missing dependency never bit anyone locally while CI ran nothing. */
ok(!/rental-report\/node_modules/.test(src),
   "the render check does not borrow another project's puppeteer - that fallback is what hid the missing dependency");
ok(!/for \(const guess of/.test(src),
   "...and has no hand-rolled resolution loop at all; plain require plus the gate above");

if (failures.length) {
  console.error("✗ render-gate.spec.js — " + failures.length + " failure(s):");
  failures.forEach(f => console.error("  ✗ " + f));
  process.exit(1);
}
console.log("✓ render-gate.spec.js — " + passed + " assertions passed.");
