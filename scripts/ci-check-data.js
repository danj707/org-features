/**
 * The baked snapshots must be valid JSON AND carry the keys the pages read.
 *
 * WHY: the daily refresh Routine commits data/features-data.json straight to
 * main, and Railway deploys main. A snapshot that will not parse, or that
 * parses but lost a key, takes the dashboard down without any code changing.
 * This is the cheapest possible guard on the file that changes most often.
 *
 * Deliberately shape-only. It does NOT assert row counts or thresholds: the
 * numbers are supposed to move every day, and a guard that fails on real
 * change gets deleted.
 */
const fs = require("fs");
const path = require("path");
const DIR = path.join(__dirname, "..", "data");

const REQUIRED = {
  "features-data.json": ["generatedAt", "orgs", "coreMetrics", "usage", "features", "adoption", "measuredFeatures"],
  "ps-data.json":       ["generatedAt", "accounts", "bugs", "featureRequests"],
  "launches-data.json": ["generatedAt", "services"],
  "remittance-schedule.json": ["years"],
};

let failed = 0;
for (const [file, keys] of Object.entries(REQUIRED)) {
  const p = path.join(DIR, file);
  if (!fs.existsSync(p)) { console.error(`✗ ${file} is missing`); failed++; continue; }
  let json;
  try { json = JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (e) { console.error(`✗ ${file} is not valid JSON — ${e.message}`); failed++; continue; }
  const missing = keys.filter(k => !(k in json));
  if (missing.length) { console.error(`✗ ${file} lost key(s): ${missing.join(", ")}`); failed++; continue; }
  /* AN EMPTY ORG LIST IS A BROKEN BAKE, not a quiet day. The refresh script
     has its own sanity checks, but this one runs on the committed artefact. */
  if (file === "features-data.json" && (!Array.isArray(json.orgs) || !json.orgs.length)) {
    console.error("✗ features-data.json has no orgs — a bake that produced nothing must not ship"); failed++; continue;
  }
  console.log(`✓ ${file} — ${keys.length} key(s) present`);
}
process.exit(failed ? 1 : 0);
