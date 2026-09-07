/**
 * A Postgres-backed key/value store for org-features, behind the seams the
 * app already had.
 *
 * WHY THIS EXISTS. The service mounts a Railway volume at /data, and a volume
 * attaches to a SINGLE instance — so numReplicas is pinned at 1 and every
 * deploy is stop-then-start, i.e. an outage. Moving this state off the volume
 * is what lets the service roll. The sibling rental-report project did exactly
 * this on 2026-09-06 and its deploys are now invisible to users (measured:
 * ~950 requests through a cutover, zero non-200s).
 *
 * IT SHIPS DOING NOTHING. With no STORE_DATABASE_URL / DATABASE_URL the store
 * runs in `disk` mode, which is byte-identical to the behaviour before this
 * file existed. The flip is then a sequence of ENVIRONMENT changes, each
 * reversible without a code change:
 *
 *   mode    writes          reads        rollback
 *   disk    the volume      the volume   — (this is today)
 *   dual    BOTH            the volume   drop the env vars
 *   db      both            Postgres     STORE_MODE=dual
 *
 * There is deliberately no fourth "Postgres only" mode: dropping the disk
 * write buys nothing while the volume is mounted, and once it is detached
 * those writes land harmlessly on the container's own filesystem.
 *
 * WHAT ACTUALLY HAS TO MOVE, and it is worth being precise because it is
 * narrower than it looks:
 *
 *   users.json              READ-WRITE at runtime. The PS accounts. This is
 *                           the only state that cannot be re-derived, and the
 *                           only reason this file is load-bearing.
 *   features-data.json      baked snapshots. Re-derivable by re-running a
 *   ps-data.json            bake, and each already falls back to the copy
 *   launches-data.json      committed in the repo, so they degrade safely.
 *   remittance-schedule.json  a repo file, never written. Not stored here.
 *
 * READS ARE SYNCHRONOUS AND THAT IS A CONSTRAINT, NOT A CHOICE. auth.js calls
 * loadUsers() from inside route handlers; making it async would touch every
 * route and every guard. So reads come from an in-memory mirror hydrated at
 * boot, writes update the mirror synchronously and enqueue the upsert.
 *
 * A DEDICATED SCHEMA. All four services in this Railway project share one
 * Postgres, and rental-report already owns `kv`, `events` and `feed_cache` in
 * public. This store lives in its own schema so the two cannot collide, one
 * glance says which app owns what, and splitting to a separate instance later
 * is a dump of one schema rather than a table-by-table untangle.
 */

const fs   = require("fs");
const path = require("path");

const SCHEMA = "orgfeatures";
const POLL_MS = Number(process.env.STORE_POLL_MS || 4000);

const S = {
  mode: "disk",
  pool: null,
  dir: null,
  mirror: new Map(),      // key -> parsed JSON value
  rev: new Map(),         // key -> revision we last saw, for the poll
  pending: new Map(),     // key -> value awaiting its upsert
  flushing: null,
  lastError: null,
  onChange: null,
  timer: null,
};

function note(where, err) {
  S.lastError = `${where}: ${err && err.message ? err.message : String(err)}`;
  console.warn(`[store] ${S.lastError}`);
}

/* Both mode tests are spelled out rather than derived from one another. `dual`
   WRITES to the database and READS from disk, so "does it write" and "does it
   read" are genuinely different questions and collapsing them into one flag is
   how dual mode silently becomes db mode. The sibling project shipped exactly
   that bug for one deploy — events written where nothing read them. */
function writesDb() { return (S.mode === "dual" || S.mode === "db") && !!S.pool; }
function readsDb()  { return S.mode === "db" && !!S.pool; }

function filePath(key) { return path.join(S.dir, `${key}.json`); }

function readDisk(key) {
  try { return JSON.parse(fs.readFileSync(filePath(key), "utf8")); }
  catch { return undefined; }
}

function writeDisk(key, value) {
  try {
    fs.mkdirSync(S.dir, { recursive: true });
    const tmp = `${filePath(key)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, filePath(key));   // atomic, so a crash cannot corrupt it
    return true;
  } catch (e) { note(`writeDisk ${key}`, e); return false; }
}

/**
 * THE READ. Synchronous by necessity (see the header).
 *
 * In `db` mode a key the mirror has never seen FALLS THROUGH TO DISK rather
 * than to the caller's fallback. "Postgres has no row for this" and "there is
 * no such data" are different facts, and defaulting would silently reset any
 * store the import missed — the users file above all. Same rule as the
 * presence gates in the sibling project: absent is not zero.
 */
function readJSON(key, fallback) {
  if (readsDb()) {
    if (S.mirror.has(key)) return S.mirror.get(key);
    const onDisk = readDisk(key);
    return onDisk === undefined ? fallback : onDisk;
  }
  const onDisk = readDisk(key);
  if (onDisk !== undefined) return onDisk;
  if (S.mirror.has(key)) return S.mirror.get(key);
  return fallback;
}

/**
 * THE WRITE. Updates the mirror synchronously so the next read is correct in
 * this process whatever the database is doing, writes to disk while a volume
 * is still mounted, and enqueues the upsert.
 */
function writeJSON(key, value) {
  S.mirror.set(key, value);
  let ok = true;
  if (S.mode !== "db" || !S.pool) ok = writeDisk(key, value);
  else writeDisk(key, value);          // keep the volume warm for a rollback
  if (writesDb()) {
    S.pending.set(key, value);
    flush().catch(e => note("flush", e));
  }
  return ok;
}

/* THE FLUSH JOINS A RUN ALREADY IN PROGRESS rather than returning early.
   Returning early is the tempting shape and it loses data: writeJSON kicks a
   flush without awaiting it, so a flush is usually already running, and a
   close() that awaited that early return would end the pool mid-drain. */
async function flush() {
  if (S.flushing) return S.flushing;
  S.flushing = (async () => {
    while (S.pending.size && writesDb()) {
      const batch = [...S.pending.entries()];
      S.pending.clear();
      for (const [key, value] of batch) {
        try {
          const r = await S.pool.query(
            `INSERT INTO ${SCHEMA}.kv (k, v, rev, updated_at)
             VALUES ($1, $2::jsonb, 1, now())
             ON CONFLICT (k) DO UPDATE
               SET v = $2::jsonb, rev = ${SCHEMA}.kv.rev + 1, updated_at = now()
             RETURNING rev`, [key, JSON.stringify(value)]);
          if (r.rows[0]) S.rev.set(key, Number(r.rows[0].rev));
        } catch (e) {
          note(`upsert ${key}`, e);
          /* PUT IT BACK, but never over a newer value this process has since
             written — re-queuing unconditionally would resurrect a stale
             payload on top of a fresh one. */
          if (!S.pending.has(key)) S.pending.set(key, value);
          await new Promise(r => setTimeout(r, 250));
        }
      }
    }
  })().finally(() => { S.flushing = null; });
  return S.flushing;
}

/* THE POLL. Another replica's write has to reach this one, and some of what
   this app reads is folded into module-level state at boot (see
   onKeyChange) rather than read per request. Revisions only — the payloads
   here are small, but fetching every row every few seconds to answer "did
   anything change" is still traffic for nothing. */
async function poll() {
  if (!S.pool) return;
  try {
    const r = await S.pool.query(`SELECT k, rev FROM ${SCHEMA}.kv`);
    const changed = [];
    for (const row of r.rows) {
      const rev = Number(row.rev);
      /* SKIP KEYS THIS PROCESS HAS UNFLUSHED WRITES FOR. Without this the
         poll can overwrite a local write with the row it is replacing — the
         race the sibling project needed three drafts to reproduce. */
      if (S.pending.has(row.k)) continue;
      if (S.rev.get(row.k) !== rev) { S.rev.set(row.k, rev); changed.push(row.k); }
    }
    if (!changed.length) return;
    const got = await S.pool.query(
      `SELECT k, v FROM ${SCHEMA}.kv WHERE k = ANY($1::text[])`, [changed]);
    for (const row of got.rows) S.mirror.set(row.k, row.v);
    if (S.onChange) { try { S.onChange(changed); } catch (e) { note("onChange", e); } }
  } catch (e) { note("poll", e); }
}

function onKeyChange(fn) { S.onChange = fn; }

async function configure({ dataDir, url, mode }) {
  S.dir = dataDir;
  const dsn = url || process.env.STORE_DATABASE_URL || process.env.DATABASE_URL || "";
  const want = (mode || process.env.STORE_MODE || (dsn ? "dual" : "disk")).toLowerCase();

  if (!dsn) {
    S.mode = "disk";
    console.log("[store] disk mode — no database url, behaviour unchanged");
    return S.mode;
  }

  try {
    const { Pool } = require("pg");
    S.pool = new Pool({
      connectionString: dsn,
      max: Number(process.env.STORE_POOL_MAX || 4),
      connectionTimeoutMillis: 8000,
      ssl: /localhost|127\.0\.0\.1|\.railway\.internal/.test(dsn) ? false : { rejectUnauthorized: false },
    });
    await S.pool.query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
    await S.pool.query(
      `CREATE TABLE IF NOT EXISTS ${SCHEMA}.kv (
         k          text PRIMARY KEY,
         v          jsonb NOT NULL,
         rev        bigint NOT NULL DEFAULT 1,
         updated_at timestamptz NOT NULL DEFAULT now())`);
    const r = await S.pool.query(`SELECT k, v, rev FROM ${SCHEMA}.kv`);
    for (const row of r.rows) { S.mirror.set(row.k, row.v); S.rev.set(row.k, Number(row.rev)); }
    S.mode = want === "db" ? "db" : "dual";
    S.timer = setInterval(() => poll(), POLL_MS);
    if (S.timer.unref) S.timer.unref();
    console.log(`[store] ${S.mode} mode — ${r.rows.length} key(s) hydrated from ${SCHEMA}.kv`);
  } catch (e) {
    /* AN UNREACHABLE DATABASE FALLS BACK TO THE VOLUME rather than failing the
       boot. The flip has to be able to be a no-op; it must never be an outage.
       Same asymmetry the sibling project pins for its leader lock. */
    note("configure", e);
    if (S.pool) { try { await S.pool.end(); } catch { /* ignore */ } S.pool = null; }
    S.mode = "disk";
    console.warn("[store] falling back to disk mode — the volume still serves");
  }
  return S.mode;
}

/* IMPORT IS IDEMPOTENT, because a flip gets retried. DO NOTHING rather than
   DO UPDATE: a re-run must never put a stale file back over a row the running
   app has since written. */
async function importFromDisk(keys) {
  if (!S.pool) return { imported: 0, skipped: 0, mode: S.mode };
  let imported = 0, skipped = 0;
  for (const key of keys) {
    const value = readDisk(key);
    if (value === undefined) { skipped++; continue; }
    try {
      const r = await S.pool.query(
        `INSERT INTO ${SCHEMA}.kv (k, v) VALUES ($1, $2::jsonb)
         ON CONFLICT (k) DO NOTHING RETURNING k`, [key, JSON.stringify(value)]);
      if (r.rowCount) { imported++; S.mirror.set(key, value); } else skipped++;
    } catch (e) { note(`import ${key}`, e); skipped++; }
  }
  return { imported, skipped, mode: S.mode };
}

async function close() {
  if (S.timer) clearInterval(S.timer);
  await flush();                     // writeJSON only enqueues; this is the drain
  if (S.pool) { try { await S.pool.end(); } catch { /* ignore */ } S.pool = null; }
}

function status() {
  return {
    mode: S.mode, schema: SCHEMA, keys: S.mirror.size,
    pending: S.pending.size, dataDir: S.dir,
    /* REDACTED on the way out even for an authenticated caller: a pg failure
       message carries the host and user it could not reach, and this response
       is exactly the sort of thing pasted into a chat mid-flip. */
    lastError: S.lastError ? "see server logs" : null,
  };
}

module.exports = {
  configure, readJSON, writeJSON, flush, close, status,
  importFromDisk, onKeyChange, readsDb, writesDb,
  _schema: SCHEMA,
};
