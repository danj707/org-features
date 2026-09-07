#!/usr/bin/env node
// Rebuild data/features-data.json from a fleet-query payload.
//
// Usage: node scripts/refresh/merge-snapshot.js <payload.json>
//
// <payload.json> is the JSON array returned by scripts/refresh/fleet-query.sql
// (the `payload` column value, saved to a file). The feature catalog and the
// core metric labels are carried over from the existing snapshot; the org
// list, usage, adoption and timestamps are rebuilt.
//
// READS BY KEY, NOT BY POSITION. Until 2026-09-07 the payload was a flat
// array and this script mapped columns onto ADOPTION_KEYS by index — fine
// while metrics were only ever appended, silently catastrophic the first time
// one was inserted in the middle, and there are 56 of them now. Both metric
// objects arrive keyed by feature key and are read by name.

const fs = require("fs");
const path = require("path");

const payloadPath = process.argv[2];
if (!payloadPath) {
  console.error("usage: node scripts/refresh/merge-snapshot.js <payload.json>");
  process.exit(1);
}

const repoRoot = path.join(__dirname, "..", "..");
const dataFile = path.join(repoRoot, "data", "features-data.json");
const old = JSON.parse(fs.readFileSync(dataFile, "utf8"));
const rows = JSON.parse(fs.readFileSync(payloadPath, "utf8"));

const fmt = n => n.toLocaleString("en-US");

// Every adoption metric the query emits, and the sentence its cell reads.
// This list IS the measured set: `measuredFeatures` is derived from it rather
// than carried over from the previous snapshot, or adding a metric to the
// query would leave the page still advertising the old count.
const ADOPTION_KEYS = [
  "age_eligibility",
  "waitlist",
  "sms_messaging",
  "email_messaging",
  "payment_plans",
  "discount_codes",
  "scholarships",
  "gift_cards",
  "custom_booking_questions",
  "custom_forms",
  "instant_booking",
  "gl_accounting",
  "seasons",
  "competitions_leagues",
  "events",
  "ticket_sales",
  "ai_assistant",
  "ai_routines",
  "grade_eligibility",
  "residency_eligibility",
  "prerequisites",
  "registration_windows",
  "group_early_access_windows",
  "required_participant_info",
  "waivers_contracts",
  "form_on_file_reuse",
  "guests_allowed",
  "skill_levels",
  "addons",
  "instructors",
  "instructor_certifications",
  "memberships",
  "auto_renew_memberships",
  "passes",
  "benefit_rules",
  "physical_access_devices",
  "facility_rentals",
  "rental_applications",
  "reservation_buffers",
  "security_deposits",
  "rental_permits",
  "group_reservation_windows",
  "store_credit",
  "structured_refund_policies",
  "group_pricing_tiers",
  "tax_collection",
  "cash_check_payments",
  "custom_email_domains",
  "notification_subscriptions",
  "audience_segments",
  "storefront_products",
  "pos_desk_locations",
  "cash_reconciliation",
  "custom_staff_roles",
  "alternate_identities",
  "crm_household_notes",
];

const TEMPLATES = {
  age_eligibility: n => `${fmt(n)} sections with age rules`,
  grade_eligibility: n => `${fmt(n)} sections with grade rules`,
  residency_eligibility: n => `${fmt(n)} residency zones`,
  prerequisites: n => `${fmt(n)} prerequisites set up`,
  registration_windows: n => `${fmt(n)} registration windows`,
  group_early_access_windows: n => `${fmt(n)} member early-access windows`,
  restricted_registration_mode: n => `${fmt(n)} sections`,
  required_participant_info: n => `${fmt(n)} sections requiring extra info`,
  waitlist: n => `${fmt(n)} sections with waitlist`,
  custom_booking_questions: n => `${fmt(n)} programs with questions`,
  custom_forms: n => `${fmt(n)} forms`,
  waivers_contracts: n => `${fmt(n)} policy/waiver versions`,
  form_on_file_reuse: n => `${fmt(n)} forms reused from file`,
  guests_allowed: n => `${fmt(n)} programs allowing guests`,
  skill_levels: n => `${fmt(n)} sections with a skill level`,
  addons: n => `${fmt(n)} add-on products`,
  seasons: n => `${fmt(n)} seasons`,
  instructors: n => `${fmt(n)} instructors`,
  instructor_certifications: n => `${fmt(n)} certifications tracked`,
  memberships: n => `${fmt(n)} membership plans`,
  auto_renew_memberships: n => `${fmt(n)} auto-renewing plans`,
  passes: n => `${fmt(n)} pass types`,
  benefit_rules: n => `${fmt(n)} benefit rules`,
  physical_access_devices: n => `${fmt(n)} access devices`,
  facility_rentals: n => `${fmt(n)} facility rentals`,
  rental_applications: n => `${fmt(n)} rental applications`,
  instant_booking: n => `${fmt(n)} instant-bookable sites`,
  reservation_buffers: n => `${fmt(n)} sites with a buffer`,
  security_deposits: n => `${fmt(n)} deposits taken`,
  rental_permits: n => `${fmt(n)} permits issued`,
  group_reservation_windows: n => `${fmt(n)} member booking windows`,
  discount_codes: n => `${fmt(n)} promo codes`,
  payment_plans: n => `${fmt(n)} sections with plans`,
  gift_cards: n => `${fmt(n)} gift card products`,
  scholarships: n => `${fmt(n)} scholarship programs`,
  store_credit: n => `${fmt(n)} account credits issued`,
  structured_refund_policies: n => `${fmt(n)} refund policies`,
  group_pricing_tiers: n => `${fmt(n)} sections with member pricing`,
  tax_collection: n => `${fmt(n)} taxed products/sites`,
  cash_check_payments: n => `${fmt(n)} cash/check payments`,
  gl_accounting: n => `${fmt(n)} GL accounts`,
  sms_messaging: n => `${fmt(n)} SMS sent`,
  email_messaging: n => `${fmt(n)} emails sent`,
  custom_email_domains: n => `${fmt(n)} verified sending domains`,
  notification_subscriptions: n => `${fmt(n)} notification types`,
  audience_segments: n => `${fmt(n)} audience segments`,
  competitions_leagues: n => `${fmt(n)} leagues/competitions`,
  events: n => `${fmt(n)} events`,
  // "sold", not "tickets" — the count deliberately excludes the ~30% of rows
  // that are pending (unpaid, sitting in a cart).
  ticket_sales: n => `${fmt(n)} tickets sold`,
  storefront_products: n => `${fmt(n)} products in the public store`,
  pos_desk_locations: n => `${fmt(n)} desk locations`,
  cash_reconciliation: n => `${fmt(n)} cash-out reports`,
  // "asked" rather than "turns": counts turns a PERSON initiated, with the
  // automatic thread-titling and summarizing turns excluded.
  ai_assistant: n => `${fmt(n)} questions asked`,
  ai_routines: n => `${fmt(n)} routines set up`,
  custom_staff_roles: n => `${fmt(n)} custom roles`,
  alternate_identities: n => `${fmt(n)} alternate IDs`,
  crm_household_notes: n => `${fmt(n)} household notes`,
};


// ADOPTION_KEYS MUST BE DENSE AND UNIQUE. A stray comma turns this into a
// sparse array — `["a",,"b",]` has length 3 — and every other check here
// still passes, because the payload's keys are all present and none are
// unknown. Only the reported count is wrong, which is exactly the kind of
// quiet nonsense that ends up on a card ("111 of 57 features measured").
if (ADOPTION_KEYS.length !== ADOPTION_KEYS.filter(k => typeof k === "string").length) {
  console.error(`ADOPTION_KEYS has ${ADOPTION_KEYS.length - ADOPTION_KEYS.filter(k => typeof k === "string").length} hole(s) — a stray comma made it sparse`);
  process.exit(1);
}
if (new Set(ADOPTION_KEYS).size !== ADOPTION_KEYS.length) {
  console.error("ADOPTION_KEYS contains a duplicate");
  process.exit(1);
}

// ── SANITY, before anything is written ────────────────────────────────────
// The counts move daily and must not be pinned, but the SHAPE must not drift.
// A payload that is obviously a partial fetch or a stale query is refused
// rather than overwriting a good snapshot.
if (!Array.isArray(rows) || rows.length < 100) {
  console.error(`payload sanity check failed: ${Array.isArray(rows) ? rows.length : "not an array"} rows; expected >=100`);
  process.exit(1);
}
const badShape = rows.filter(r => !Array.isArray(r) || r.length !== 7
  || typeof r[4] !== "boolean" || typeof r[5] !== "object" || typeof r[6] !== "object");
if (badShape.length) {
  console.error(`payload sanity check failed: ${badShape.length} row(s) are not [slug,id,name,display,launched,{core},{adoption}] — re-run the CURRENT fleet-query.sql`);
  process.exit(1);
}
// Every key this script expects must be present in the payload, or a metric
// silently reads 0 for the whole fleet because the query was not re-run.
const missingKeys = ADOPTION_KEYS.filter(k => !(k in rows[0][6]));
if (missingKeys.length) {
  console.error(`payload is missing ${missingKeys.length} adoption key(s): ${missingKeys.join(", ")}`);
  console.error("the fleet query and this script have drifted — re-generate the query");
  process.exit(1);
}
// And any key the payload carries that this script does not know about would
// be dropped on the floor, which is the same drift in the other direction.
const unknownKeys = Object.keys(rows[0][6]).filter(k => !ADOPTION_KEYS.includes(k));
if (unknownKeys.length) {
  console.error(`payload carries ${unknownKeys.length} unknown adoption key(s): ${unknownKeys.join(", ")}`);
  process.exit(1);
}
const templateless = ADOPTION_KEYS.filter(k => typeof TEMPLATES[k] !== "function");
if (templateless.length) {
  console.error(`no detail TEMPLATE for: ${templateless.join(", ")}`);
  process.exit(1);
}

const orgs = [], usage = {}, adoption = {};
for (const r of rows) {
  const [slug, id, name, displayName, launched, core, adopt] = r;
  // `launched` travels with the org rather than filtering it out: an
  // unlaunched org mid-configuration is exactly who an adoption dashboard is
  // for, and an unlabelled one would drag every fleet figure down.
  orgs.push({ id, slug, name, displayName, launched });
  usage[slug] = core;
  const a = {};
  for (const k of ADOPTION_KEYS) {
    const n = Number(adopt[k]) || 0;
    a[k] = { adopted: n > 0, count: n, detail: n > 0 ? TEMPLATES[k](n) : "Not using" };
  }
  adoption[slug] = a;
}

const live = orgs.filter(o => o.launched).length;

/* ── THE ADOPTION HISTORY ────────────────────────────────────────────────
   One point per bake, so the org list can draw a trend. Nothing else in the
   snapshot is dated — it is a point-in-time bake — so the series has to
   accrue from here rather than be reconstructed.

   IT CANNOT BE BACKFILLED FROM GIT, and that is a measurement not a
   limitation. The only older bake in this repo (2026-08-22) measured
   FOURTEEN features against today's fifty-six. Apex reads 86% there and 89%
   here, which looks like a +3 trend and is nothing of the kind: the
   denominator quadrupled. Diffing across it would publish a definition change
   as org behaviour.

   SO EVERY POINT CARRIES THE SET IT WAS SCORED OVER. `setKey` is a cheap hash
   of the sorted measured keys; the page drops any point whose key differs
   from today's, because a score over a different denominator is a different
   measurement. That is what makes the sparkline trustworthy the next time a
   feature is added or a definition is fixed. */
function setKeyOf(keys) {
  const joined = keys.slice().sort().join(",");
  let h = 0;
  for (let i = 0; i < joined.length; i++) { h = (h * 31 + joined.charCodeAt(i)) | 0; }
  return keys.length + ":" + (h >>> 0).toString(36);
}
const HISTORY_MAX = 120;                       // ~4 months of daily bakes
const today = new Date().toISOString().slice(0, 10);
const scores = {};
for (const o of orgs) {
  const a = adoption[o.slug] || {};
  const used = ADOPTION_KEYS.filter(k => a[k] && a[k].adopted).length;
  scores[o.slug] = ADOPTION_KEYS.length
    ? Math.round((used / ADOPTION_KEYS.length) * 100)
    : null;
}
const point = { date: today, setKey: setKeyOf(ADOPTION_KEYS),
                measured: ADOPTION_KEYS.length, scores };
/* IDEMPOTENT PER DATE. The workflow can be re-run by hand on the same day —
   it was, three times, the day it was written — and appending each run would
   put three points on one date and make a day look like a week. */
const history = (old.history || []).filter(h => h && h.date !== today);
history.push(point);
history.sort((x, y) => String(x.date).localeCompare(String(y.date)));
while (history.length > HISTORY_MAX) history.shift();

const out = {
  generatedAt: new Date().toISOString(),
  source: "Rec production database (Rec-Prod-ReadReplica via Metabase), fleet-wide SQL snapshot",
  status: old.status,
  orgs,
  coreMetrics: old.coreMetrics,
  usage,
  featureCategories: old.featureCategories,
  features: old.features,
  adoption,
  notes: `${ADOPTION_KEYS.length} of ${old.features.length} catalog features measured, re-baked ${new Date().toISOString().slice(0, 10)} from the production read replica via scripts/refresh/fleet-query.sql. Metric definitions and their traps are documented in that file. Sandbox organizations are excluded; unlaunched organizations are included and flagged. ${live} of ${orgs.length} organizations are live on rec.us.`,
  measuredFeatures: ADOPTION_KEYS,
  history,
};

fs.writeFileSync(dataFile, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${dataFile}`);
console.log(`  ${orgs.length} orgs (${live} launched, ${orgs.length - live} not), ${ADOPTION_KEYS.length} adoption metrics`);
console.log(`  generatedAt ${out.generatedAt}`);
const comparable = history.filter(h => h.setKey === point.setKey).length;
console.log(`  history ${history.length} point(s), ${comparable} comparable to today's set `
  + `(${point.setKey})${comparable < 2 ? " — the trend needs two, so it draws nothing yet" : ""}`);
