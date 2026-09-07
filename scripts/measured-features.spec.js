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

// The four from wave 2 plus the ones whose FILTER is the interesting part.
const NEW = ["events", "ticket_sales", "ai_assistant", "ai_routines"];
const TRAPPED = ["skill_levels", "custom_staff_roles", "storefront_products",
  "group_pricing_tiers", "waivers_contracts", "cash_check_payments",
  "custom_email_domains", "prerequisites", "facility_rentals", "rental_permits"];

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
  // KEYED, NOT POSITIONAL. The payload used to be a flat array mapped onto
  // ADOPTION_KEYS by index — safe while appending, silently catastrophic the
  // first time a metric was inserted in the middle, and there are 56 now.
  ok(/r\.length !== 7/.test(merge),
    "the payload row is [slug,id,name,display,launched,{core},{adoption}]");
  ok(/typeof r\[4\] !== "boolean"/.test(merge), "the launch flag is checked as a boolean");
  // Both drift checks must actually EXIT, not merely be declared — renaming
  // the const to something unused left the substring matching, and that
  // mutation survived the first draft.
  ok(/missingKeys\.length\)?\s*\{[\s\S]{0,400}process\.exit\(1\)/.test(merge),
    "a payload MISSING an adoption key is refused");
  ok(/unknownKeys\.length\)?\s*\{[\s\S]{0,400}process\.exit\(1\)/.test(merge),
    "a payload carrying an UNKNOWN adoption key is refused");
  ok(/typeof k === "string"/.test(merge),
    "ADOPTION_KEYS is checked for HOLES — a stray comma makes it sparse and every other check still passes");
  ok(/new Set\(ADOPTION_KEYS\)\.size !== ADOPTION_KEYS\.length/.test(merge),
    "...and for duplicates");
  // The query's keys and the script's keys must be the same set.
  const sqlKeys = [...sql.matchAll(/'([a-z_]+)', COALESCE\(a_\w+\.n,0\)/g)].map(m => m[1]);
  eq(sqlKeys.length, adoption.length, "the fleet query emits one value per ADOPTION_KEY");
  const onlySql = sqlKeys.filter(k => !adoption.includes(k));
  const onlyJs = adoption.filter(k => !sqlKeys.includes(k));
  eq(onlySql.length, 0, "no key is in the query but not the script" + (onlySql.length ? " — " + onlySql.join(", ") : ""));
  eq(onlyJs.length, 0, "no key is in the script but not the query" + (onlyJs.length ? " — " + onlyJs.join(", ") : ""));
  // Postgres caps json_build_object at 100 args; 56 keys is 112.
  ok(/jsonb_build_object/.test(sql) && sql.split("jsonb_build_object").length - 1 >= 2,
    "the adoption object is built in chunks, because json_build_object caps at 100 arguments");
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

// ── THE WAVE-3 TRAPS ──────────────────────────────────────────────────────
// Every one of these is a filter that returns a WRONG NUMBER rather than an
// error, and each was measured against production rather than assumed.
{
  const code = sql.replace(/^\s*--.*$/gm, "");
  ok(code.length < sql.length, "the SQL comment strip removed something");

  // 'all' MEANS NO RESTRICTION and is the commonest skill_level (29,257).
  ok(/skill_level::text <> 'all'/.test(code),
    "skill levels exclude 'all', which means NO restriction and is the commonest value");
  // Staff roles are platform-seeded: Full Access at 156 orgs, Limited at 78.
  ok(/name NOT IN \('Full Access','Limited Access'\)/.test(code),
    "custom staff roles exclude the two platform-seeded role names");
  // display_in_store is true on 4,685 of 5,860 products — a default.
  ok(/publish_to_public = true/.test(code) && !/display_in_store/.test(code),
    "storefront products key on publish_to_public, not the default-true display_in_store");
  // section_price is GONE; group pricing lives in a JSONB column.
  ok(/pricing_policy #> '\{default,groupCents\}'/.test(code),
    "group pricing reads section.pricing_policy groupCents — the section_price table no longer exists");
  ok(!/section_price/.test(code), "nothing references the dropped section_price table");
  // payment_method_type uses hyphens.
  ok(/'cash','check'/.test(code), "cash/check payments use the real hyphenated values");
  ok(!/organizationCredit/.test(code), "no camelCase payment method survives");
  // A domain that is not verified cannot send mail.
  ok(/organization_email_domain WHERE status='verified'/.test(code),
    "custom email domains count VERIFIED ones only");
  // 1,186 prereqs exist and ZERO are activated.
  ok(/FROM prereq GROUP BY/.test(code) && !/prereq WHERE activated_at/.test(code),
    "prerequisites count configured rows, not activated ones — zero are activated platform-wide");
  // Canceled rentals and non-issued permits are not the feature in use.
  ok(/facility_rental WHERE status <> 'canceled'/.test(code), "canceled facility rentals are excluded");
  ok(/facility_rental_permit WHERE status='issued'/.test(code), "only issued permits count");

  // THE ORG SET. Sandboxes out, unlaunched in and flagged.
  ok(/slug NOT ILIKE '%sandbox%'/.test(code) && /name NOT ILIKE '%sandbox%'/.test(code),
    "sandbox orgs are excluded on BOTH slug and display name");
  // Scoped to the org CTE's WHERE clause, and matched after the launched
  // ALIAS is removed — otherwise the alias itself satisfies the pattern and
  // re-adding the filter survives, which it did on the first draft.
  const orgWhere = code.slice(code.indexOf("FROM organization"), code.indexOf(")", code.indexOf("FROM organization")))
    .replace(/\(published_at IS NOT NULL\) AS launched/g, "");
  ok(!/published_at/.test(orgWhere),
    "unlaunched orgs are NOT filtered out of the org set — they are included and flagged");
  ok(/\(published_at IS NOT NULL\) AS launched/.test(code),
    "launch state travels with each org as a flag");
}

// ── EVERY MEASURED FEATURE IS DOCUMENTED, AND THE ONE THAT IS NOT ─────────
// MEASURABLE SAYS WHY. A feature with no schema support must not get a
// plausible-looking number: section.registration_mode carries only
// 'section' and 'per-session', so `<> 'open'` would report 100% adoption.
{
  const byKey = {}; snap.features.forEach(f => { byKey[f.key] = f; });
  snap.measuredFeatures.forEach(k => {
    ok(byKey[k], k + " has a catalog entry");
    ok(byKey[k] && byKey[k].adoption_definition && byKey[k].adoption_definition.length > 60,
      k + " documents what adoption means");
  });
  const unmeasured = snap.features.filter(f => !snap.measuredFeatures.includes(f.key));
  eq(unmeasured.length, 1, "exactly one catalog feature is unmeasured");
  eq(unmeasured[0] && unmeasured[0].key, "restricted_registration_mode",
    "...and it is the one with no schema support");
  ok(unmeasured[0] && unmeasured[0].not_measurable,
    "the unmeasured feature records WHY rather than looking merely forgotten");
  ok(/NOT MEASURABLE/.test(unmeasured[0].adoption_definition),
    "...and says so in its adoption definition");

  TRAPPED.forEach(k => {
    const def = byKey[k].adoption_definition + " " + byKey[k].signal;
    // Require a FIGURE, not a word: the point of these definitions is that
    // the filter was measured against production, and a number is the only
    // evidence of that which cannot be written without having looked.
    ok(/\d/.test(def), k + " cites a measured figure behind its filter");
  });

  // The launch flag reaches the snapshot.
  ok(snap.orgs.every(o => typeof o.launched === "boolean"),
    "every org carries a boolean launched flag");
  const live = snap.orgs.filter(o => o.launched).length;
  ok(live > 0 && live < snap.orgs.length,
    `both launched and unlaunched orgs are present — ${live} of ${snap.orgs.length}`);
  ok(!snap.orgs.some(o => /sandbox/i.test(o.slug) || /sandbox/i.test(o.name || "")),
    "no sandbox org reached the snapshot");
}
