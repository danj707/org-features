#!/usr/bin/env node
// Rebuild data/features-data.json from a fleet-query payload.
//
// Usage: node scripts/refresh/merge-snapshot.js <payload.json>
//
// <payload.json> is the JSON array returned by scripts/refresh/fleet-query.sql
// (the `payload` column value, saved to a file). The feature catalog, core
// metric labels, and measuredFeatures list are carried over from the existing
// snapshot; usage, adoption, org list, and timestamps are rebuilt.

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

if (!Array.isArray(rows) || rows.length < 50 || rows.some(r => r.length !== 28)) {
  console.error(`payload sanity check failed: ${rows.length} rows; expected >=50 rows of 28 columns`);
  process.exit(1);
}

const fmt = n => n.toLocaleString("en-US");
const ADOPTION_KEYS = [
  "age_eligibility", "waitlist", "sms_messaging", "email_messaging",
  "payment_plans", "discount_codes", "scholarships", "gift_cards",
  "custom_booking_questions", "custom_forms", "instant_booking",
  "gl_accounting", "seasons", "competitions_leagues",
  // Added 2026-09-07. Order matters: these map onto payload columns 24-27 by
  // POSITION, so appending is safe and inserting is not.
  "events", "ticket_sales", "ai_assistant", "ai_routines",
];
const TEMPLATES = {
  age_eligibility: n => `${fmt(n)} sections with age rules`,
  waitlist: n => `${fmt(n)} sections with waitlist`,
  sms_messaging: n => `${fmt(n)} SMS sent`,
  email_messaging: n => `${fmt(n)} emails sent`,
  payment_plans: n => `${fmt(n)} sections with plans`,
  discount_codes: n => `${fmt(n)} promo codes`,
  scholarships: n => `${fmt(n)} scholarship programs`,
  gift_cards: n => `${fmt(n)} gift card products`,
  custom_booking_questions: n => `${fmt(n)} programs with questions`,
  custom_forms: n => `${fmt(n)} forms`,
  instant_booking: n => `${fmt(n)} instant-bookable sites`,
  gl_accounting: n => `${fmt(n)} GL accounts`,
  seasons: n => `${fmt(n)} seasons`,
  competitions_leagues: n => `${fmt(n)} leagues/competitions`,
  events: n => `${fmt(n)} events`,
  // "sold", not "tickets" — the count deliberately excludes the 30% of rows
  // that are pending (unpaid, sitting in a cart), and the wording has to say
  // which of the two numbers this is.
  ticket_sales: n => `${fmt(n)} tickets sold`,
  // "asked" rather than "turns": this counts turns a PERSON initiated, with
  // the automatic thread-titling and summarizing turns excluded.
  ai_assistant: n => `${fmt(n)} questions asked`,
  ai_routines: n => `${fmt(n)} routines set up`,
};

const orgs = [], usage = {}, adoption = {};
for (const r of rows) {
  const [slug, id, name, displayName] = r;
  orgs.push({ id, slug, name, displayName });
  usage[slug] = {
    programs: r[4], registrations: r[5], memberships: r[6],
    passes: r[7], facilities: r[8], reservations: r[9],
  };
  const a = {};
  ADOPTION_KEYS.forEach((k, i) => {
    const n = r[10 + i];
    a[k] = { adopted: n > 0, count: n, detail: n > 0 ? TEMPLATES[k](n) : "Not using" };
  });
  adoption[slug] = a;
}

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
  notes: `Core usage + adoption (${ADOPTION_KEYS.length} of ${old.features.length} catalog features) re-baked ${new Date().toISOString().slice(0, 10)} from the production read replica via scripts/refresh/fleet-query.sql. Metric definitions documented in that file. Absent adoption cells = not yet verifiable. Remaining ${old.features.length - ADOPTION_KEYS.length} features queued for later waves.`,
  measuredFeatures: ADOPTION_KEYS,
};

fs.writeFileSync(dataFile, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${dataFile}: ${orgs.length} orgs, generatedAt ${out.generatedAt}`);
