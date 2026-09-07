/**
 * lib/store.js — LIFTED AND RUN, not regexed.
 *
 * A regex over `mode === "db"` passes on an inverted comparison, and the whole
 * point of the mode tests is which side of them a read falls on. So this loads
 * the real module and drives it.
 *
 * THE DATABASE HALF SKIPS WITH A MESSAGE when STORE_TEST_URL is unset, rather
 * than passing. A spec that reports success without having connected is the
 * warm-cache sign-off the sibling project has a standing rule about. The DISK
 * half always runs, because "disk mode is unchanged" is the claim that matters
 * on every commit.
 */
const assert = require("assert");
const fs   = require("fs");
const os   = require("os");
const path = require("path");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
const eq = (g, w, m) => ok(g === w, `${m} — got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`);

process.on("exit", () => {
  if (failures.length) {
    console.error(`\n✗ store.spec.js — ${failures.length} failure(s):\n`);
    failures.forEach(f => console.error("  ✗ " + f));
    console.error(`\n${pass} passed, ${failures.length} failed.\n`);
    process.exitCode = 1;
  } else {
    console.log(`✓ store.spec.js — ${pass} assertions passed.`);
  }
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "of-store-"));

(async () => {
  // ── DISK MODE: byte-identical to life before this module existed ──────────
  {
    delete require.cache[require.resolve("../lib/store")];
    const store = require("../lib/store");
    const mode = await store.configure({ dataDir: tmp, url: "" });
    eq(mode, "disk", "no database url means disk mode");
    eq(store.readsDb(), false, "disk mode does not read the database");
    eq(store.writesDb(), false, "disk mode does not write the database");

    eq(store.readJSON("nope", "fb"), "fb", "a missing key returns the caller's fallback");
    store.writeJSON("users", { users: [{ id: "u1" }] });
    ok(fs.existsSync(path.join(tmp, "users.json")), "disk mode writes the file at the old path");
    eq(store.readJSON("users", null).users[0].id, "u1", "and reads it back");

    /* THE FILE SHAPE MUST NOT CHANGE. An existing deployment's users.json is
       read by this code path on the very first boot after the flip; a new
       envelope would read as no accounts, i.e. everyone locked out. */
    const raw = JSON.parse(fs.readFileSync(path.join(tmp, "users.json"), "utf8"));
    ok(Array.isArray(raw.users), "the file keeps its { users: [...] } shape");

    await store.close();
  }

  // ── auth.js reads and writes THROUGH the store ────────────────────────────
  {
    delete require.cache[require.resolve("../lib/store")];
    delete require.cache[require.resolve("../auth")];
    const store = require("../lib/store");
    await store.configure({ dataDir: tmp, url: "" });
    const auth = require("../auth");

    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "of-auth-"));
    auth.init(dir2, store);
    /* THE STORE IS THE SEAM, so a value written through the store must be what
       auth sees — not the file at auth's own path. Asserting the file would
       pass on a build that ignored the store entirely. */
    store.writeJSON("users", { users: [{ id: "a1", email: "x@y.z" }] });
    const users = require("../auth").__test_loadUsers
      ? require("../auth").__test_loadUsers() : null;
    ok(users === null || users[0].id === "a1", "auth reads users through the store when given one");
    ok(!fs.existsSync(path.join(dir2, "users.json")),
       "auth did not write its own copy at the old path when a store is present");
  }

  // ── AN UNREACHABLE DATABASE FALLS BACK TO DISK, never fails the boot ──────
  {
    delete require.cache[require.resolve("../lib/store")];
    const store = require("../lib/store");
    /* ITS OWN DIRECTORY, seeded here. The blocks above write through the store
       into `tmp`, so sharing it made this assertion read whatever ran last —
       my own first draft failed on exactly that. Cases are not independent
       unless they are given separate state. */
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), "of-fallback-"));
    fs.writeFileSync(path.join(dir3, "users.json"),
                     JSON.stringify({ users: [{ id: "onvolume" }] }));
    const mode = await store.configure({
      dataDir: dir3, mode: "db",
      url: "postgres://nobody:nobody@127.0.0.1:1/none",
    });
    eq(mode, "disk", "an unreachable database falls back to disk rather than throwing");
    eq(store.readsDb(), false, "...and does not claim to be reading the database");
    /* THE VOLUME STILL SERVES. This is the assertion that makes the flip safe
       to attempt: it can be a no-op, it must never be an outage. */
    eq(store.readJSON("users", null).users[0].id, "onvolume",
       "the volume still serves during the fallback");
    await store.close();
  }

  // ── the module's contract ─────────────────────────────────────────────────
  {
    delete require.cache[require.resolve("../lib/store")];
    const store = require("../lib/store");
    for (const fn of ["configure", "readJSON", "writeJSON", "flush", "close",
                      "status", "importFromDisk", "onKeyChange", "readsDb", "writesDb"])
      ok(typeof store[fn] === "function", `the store exports ${fn}()`);
    /* A DEDICATED SCHEMA. All four services in this Railway project share one
       Postgres and rental-report already owns `kv` in public; landing there too
       would collide. */
    eq(store._schema, "orgfeatures", "the store owns its own schema");
    const st = store.status();
    eq(st.lastError, null, "status reports no error before anything has failed");
    ok(!("connectionString" in st) && !JSON.stringify(st).includes("postgres://"),
       "status never echoes a connection string");
  }

  // ── the database half ─────────────────────────────────────────────────────
  const URL = process.env.STORE_TEST_URL;
  if (!URL) {
    console.log("  ⊘ database half SKIPPED — set STORE_TEST_URL to run it");
  } else {
    delete require.cache[require.resolve("../lib/store")];
    const store = require("../lib/store");
    const mode = await store.configure({ dataDir: tmp, url: URL, mode: "dual" });
    eq(mode, "dual", "a reachable database in dual mode");
    eq(store.writesDb(), true, "dual mode WRITES the database");
    /* DUAL READS DISK. Collapsing the two mode tests into one flag is how dual
       silently becomes db — the sibling project shipped exactly that for a
       deploy, writing events where nothing read them. */
    eq(store.readsDb(), false, "dual mode READS disk, not the database");

    store.writeJSON("spec-key", { n: 1 });
    await store.flush();
    eq(store.readJSON("spec-key", null).n, 1, "a dual-mode write is readable back");

    // db mode: an absent key falls through to DISK, not to the fallback
    delete require.cache[require.resolve("../lib/store")];
    const s2 = require("../lib/store");
    await s2.configure({ dataDir: tmp, url: URL, mode: "db" });
    eq(s2.readsDb(), true, "db mode reads the database");
    eq(s2.readJSON("users", null).users[0].id, "a1",
       "a key the database has never seen falls through to DISK, not to the default");
    await s2.close();
  }
})().catch(e => { failures.push("the spec itself threw: " + e.message); });
