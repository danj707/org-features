/**
 * The four measurements added 2026-09-07 — events, ticket sales, Seb, and Seb
 * routines — and the invariants that keep the fleet query, the merge script
 * and the catalog in step.
 *
 * WHY THIS EXISTS. Dan: "there's a bunch of stuff we're NOT measuring here.
 * Events/ticket sales, SMS usage, Seb usage". SMS was already measured (17 of
 * 73 orgs, 17,167 sent); the other two were absent from the catalog entirely.
 *
 * Every assertion here is about a filter that would return a WRONG NUMBER
 * rather than an error, which is the only kind worth a guard on a snapshot
 * whose figures move daily:
 *
 *   - ai_chat_turn.status is 'succeeded'. 'completed' — the obvious guess —
 *     matches 0 of 5,337 rows, so every org reports as a non-user.
 *   - thread-titler / bulk-summarizer / routine-draft-summarizer are the
 *     SYSTEM titling threads, not a person using Seb: 1,077 turns
 *     platform-wide, and at chicorec they outnumber the real ones 59 to 101.
 *   - event_ticket.status='pending' is a ticket sitting unpaid in a cart:
 *     5,095 of 17,112 rows, 1,082 at one org. Not a sale.
 *   - event_session is EMPTY (0 rows platform-wide), so anything measured
 *     through it is zero for everybody.
 *
 * The COUNTS are deliberately not pinned. They are meant to move daily, and a
 * guard that fails on real change gets deleted. What is pinned is the shape.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const sql = fs.readFileSync(path.join(root, "scripts", "refresh", "fleet-query.sql"), "utf8");
const merge = fs.readFileSync(path.join(root, "scripts", "refresh", "merge-snapshot.js"), "utf8");
const snap = JSON.parse(fs.readFileSync(path.join(root, "data", "features-data.json"), "utf8"));

let pass = 0;
const failures = [];
const ok = (c, m) => { if (c) pass++; else failures.push(m); };
const eq = (g, w, m) => ok(g === w, `${m} — got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`);

process.on("exit", () => {
  if (failures.length) {
    console.error(`\n✗ measured-features.spec.js — ${failures.length} failure(s):\n`);
    failures.forEach(f => console.error("  ✗ " + f));
    console.error(`\n${pass} passed, ${failures.length} failed.\n`);
    process.exitCode = 1;
  } else {
    console.log(`✓ measured-features.spec.js — ${pass} assertions passed.`);
  }
});

const NEW = ["events", "ticket_sales", "ai_assistant", "ai_routines"];

// ── THE THREE LISTS MUST AGREE, OR THE PAGE RENDERS RAW KEYS ──────────────
// merge-snapshot maps payload columns onto ADOPTION_KEYS by POSITION, and the
// page looks each key up in the catalog for its label. A key in one list and
// not the others is a silent break: a missing catalog entry renders the bare
// slug, and a missing ADOPTION_KEY drops a column the SQL still computes.
{
  const keys = (merge.match(/const ADOPTION_KEYS = \[([\s\S]*?)\];/) || ["", ""])[1];
  ok(keys.length > 50, "ADOPTION_KEYS was found in merge-snapshot.js");
  const adoption = [...keys.matchAll(/"([a-z_]+)"/g)].map(m => m[1]);
  const templates = (merge.match(/const TEMPLATES = \{([\s\S]*?)\n\};/) || ["", ""])[1];
  const catalogKeys = new Set(snap.features.map(f => f.key));

  NEW.forEach(k => {
    ok(adoption.includes(k), k + " is in ADOPTION_KEYS");
    ok(new RegExp("\\b" + k + ":").test(templates), k + " has a detail TEMPLATE (or its cell renders nothing)");
    ok(catalogKeys.has(k), k + " has a catalog entry (or the page renders the raw slug)");
    ok(snap.measuredFeatures.includes(k), k + " is in the snapshot's measuredFeatures");
  });

  // Every measured key must be in the catalog, not just the new ones.
  const orphans = snap.measuredFeatures.filter(k => !catalogKeys.has(k));
  eq(orphans.length, 0, "no measured key is missing from the catalog" + (orphans.length ? " — " + orphans.join(", ") : ""));
  // And every template must correspond to a real key, or it is dead code.
  eq(adoption.length, snap.measuredFeatures.length,
    "ADOPTION_KEYS and the snapshot's measuredFeatures are the same length");

  // measuredFeatures is DERIVED from ADOPTION_KEYS rather than carried over
  // from the previous snapshot — otherwise adding a key to the query leaves
  // the page still advertising the old count.
  ok(/measuredFeatures: ADOPTION_KEYS/.test(merge),
    "measuredFeatures is derived from ADOPTION_KEYS, not carried over from the old snapshot");
  // The column-count check has to match the payload width or the whole bake
  // is refused (28 = 4 identity + 6 core + 18 adoption).
  ok(/r\.length !== 28/.test(merge), "the payload sanity check expects 28 columns");
  const cols = (sql.match(/COALESCE\(\w+\.n,0\)/g) || []).length;
  eq(cols + 4, 28, "the fleet query emits 28 columns per org");
}

// ── THE FOUR TRAPS ────────────────────────────────────────────────────────
{
  // Comments quote the broken forms on purpose (that is what they are for),
  // so the SQL assertions run over a comment-stripped copy. Line comments
  // first: this is a .sql file and every comment here is a -- line.
  const code = sql.replace(/^\s*--.*$/gm, "");
  ok(code.length < sql.length, "the comment strip removed something");

  // 1. status is 'succeeded'. 'completed' matches nothing at all.
  ok(/status='succeeded'/.test(code), "the Seb count filters status='succeeded'");
  ok(!/status='completed'/.test(code),
    "the Seb count does NOT filter status='completed' — that matches 0 of 5,337 rows");

  // 2. the automatic agents are excluded, or usage is inflated by ~20%
  //    overall and by 58% at the worst org.
  ["thread-titler", "bulk-summarizer", "routine-draft-summarizer"].forEach(a =>
    ok(new RegExp("'" + a + "'").test(code), "the Seb count excludes the automatic agent " + a));
  ok(/NOT IN \('thread-titler'/.test(code), "they are EXCLUDED rather than counted");
  // A NULL agent must not silently drop the row: `agent NOT IN (...)` is NULL
  // for a NULL agent, which excludes it.
  ok(/COALESCE\(agent,''\) NOT IN/.test(code),
    "a NULL agent is coalesced, or NOT IN evaluates to NULL and drops the row");
  // Routine runs are a different question from a person asking something.
  ok(/'routine'\)/.test(code), "turns from scheduled routines are excluded from the human count");

  // 3. a pending ticket is not a sale.
  ok(/status='confirmed'/.test(code), "ticket sales count confirmed tickets");
  ok(/canceled_at IS NULL AND status='confirmed'/.test(code),
    "and only non-canceled ones");
  ok(!/status='pending'/.test(code), "pending tickets are not counted as sales");

  // 4. event_session is empty platform-wide — measuring through it is zero
  //    for everybody, which reads as "nobody uses events".
  ok(!/FROM event_session/.test(code), "nothing is measured through the empty event_session table");
  ok(/FROM event WHERE deleted_at IS NULL/.test(code), "events are counted off the event table");
}

// ── THE SNAPSHOT ACTUALLY CARRIES THEM ────────────────────────────────────
{
  const orgs = Object.keys(snap.adoption);
  ok(orgs.length > 50, "the snapshot has adoption records");
  NEW.forEach(k => {
    const missing = orgs.filter(s => !snap.adoption[s] || snap.adoption[s][k] === undefined);
    eq(missing.length, 0, "every org has an " + k + " cell" + (missing.length ? " — " + missing.length + " missing" : ""));
    // A cell must be adopted iff its count is above zero, or the checklist
    // and the number disagree with each other.
    const bad = orgs.filter(s => {
      const c = snap.adoption[s][k];
      return !!c.adopted !== (Number(c.count) > 0);
    });
    eq(bad.length, 0, k + ": adopted agrees with count everywhere" + (bad.length ? " — " + bad[0] : ""));
    // Adopted cells carry a detail sentence; unadopted ones say "Not using"
    // rather than being blank.
    ok(orgs.every(s => typeof snap.adoption[s][k].detail === "string" && snap.adoption[s][k].detail.length),
      k + ": every cell has a detail string");
  });

  // At least one org must actually have each of these, or the measurement is
  // returning nothing and nobody would notice — the whole failure mode here.
  NEW.forEach(k => {
    const on = Object.values(snap.adoption).filter(a => a[k] && a[k].adopted).length;
    ok(on > 0, k + " is adopted by at least one org (a metric measuring zero everywhere is a broken filter)");
  });

  // Wording: the two counts that are easy to misread say which they are.
  const t = Object.values(snap.adoption).find(a => a.ticket_sales.adopted);
  ok(/tickets sold/.test(t.ticket_sales.detail),
    'the ticket detail says "sold", because the count deliberately excludes pending');
  const s = Object.values(snap.adoption).find(a => a.ai_assistant.adopted);
  ok(/questions asked/.test(s.ai_assistant.detail),
    'the Seb detail says "questions asked", because it counts what a person initiated');

  // The catalog entries record WHY, so the next person does not re-derive the
  // four traps from scratch.
  NEW.forEach(k => {
    const f = snap.features.find(x => x.key === k);
    ok(f.adoption_definition && f.adoption_definition.length > 80,
      k + " carries an adoption_definition explaining the filter");
    ok(f.signal && f.signal.length > 40, k + " names the tables its signal comes from");
  });
  ok(/succeeded/.test(snap.features.find(f => f.key === "ai_assistant").signal),
    "the Seb catalog entry records that the status value is 'succeeded'");
  ok(/EMPTY|empty/.test(snap.features.find(f => f.key === "events").signal),
    "the events catalog entry warns that event_session is empty");
  ok(/pending/.test(snap.features.find(f => f.key === "ticket_sales").adoption_definition),
    "the tickets catalog entry records that pending rows are excluded");
}
