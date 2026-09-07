/**
 * The server must boot and answer in DISK mode — which, with no database url
 * set, is exactly what every deploy gets today. A green run here is what makes
 * "the store change is inert" a measured claim rather than an assertion.
 */
const { spawn } = require("child_process");
const http = require("http");
const os = require("os");
const fs = require("fs");
const path = require("path");

const PORT = 3399;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "of-boot-"));
const env = { ...process.env, PORT: String(PORT), DATA_DIR: dir, SESSION_SECRET: "boot-check", SIGNUP_CODE: "x" };
delete env.STORE_DATABASE_URL; delete env.DATABASE_URL; delete env.STORE_MODE;

const child = spawn("node", [path.join(__dirname, "..", "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", d => { log += d; });
child.stderr.on("data", d => { log += d; });

const get = (p) => new Promise((res, rej) => {
  const r = http.get({ host: "127.0.0.1", port: PORT, path: p, timeout: 8000 },
    resp => { let b = ""; resp.on("data", c => b += c); resp.on("end", () => res({ status: resp.statusCode, body: b })); });
  r.on("error", rej); r.on("timeout", () => { r.destroy(); rej(new Error("timeout")); });
});

const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    await wait(250);
    try { const r = await get("/healthz"); up = r.status === 200; } catch { /* not yet */ }
  }
  if (!up) { console.error("✗ server never answered /healthz\n" + log); child.kill(); process.exit(1); }

  const checks = [
    ["/healthz", 200], ["/api/data", 200],
    // PS surfaces must REFUSE without a session — the store change must not
    // have loosened anything.
    ["/api/ps-data", 401], ["/api/launches", 401], ["/api/store", 401],
  ];
  let failed = 0;
  for (const [p, want] of checks) {
    try {
      const r = await get(p);
      if (r.status === want) console.log(`✓ ${p} → ${r.status}`);
      else { console.error(`✗ ${p} → ${r.status}, want ${want}`); failed++; }
    } catch (e) { console.error(`✗ ${p} threw ${e.message}`); failed++; }
  }
  if (!/disk mode/.test(log)) { console.error("✗ the store did not report disk mode:\n" + log); failed++; }
  else console.log("✓ store reported disk mode");

  child.kill();
  if (failed) process.exit(1);
  console.log("✓ boots and serves in disk mode");
})().catch(e => { console.error("✗ " + e.message + "\n" + log); child.kill(); process.exit(1); });
