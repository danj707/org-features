#!/usr/bin/env node
/**
 * Fetch the fleet snapshot from Metabase card 21616 and write its `payload`
 * cell to a file, ready for merge-snapshot.js.
 *
 * Usage: MB_API_KEY=... node scripts/refresh/fetch-card.js <out.json>
 *
 * WHY A CARD RATHER THAN THE SQL FILE. The query is 56 LEFT JOINs and it
 * needs a database connection; the card already holds it, already points at
 * the read replica, and carries NO template tags — so there is nothing an
 * API save can break, which is the trap the sibling project hits on every
 * card push. `scripts/refresh/fleet-query.sql` stays the readable copy and
 * documents what each metric means; card 21616 is what actually runs. If you
 * change one, change the other — measured-features.spec.js reads the file.
 */
const fs = require("fs");
const https = require("https");

const HOST = process.env.MB_HOST || "rec.metabaseapp.com";
const CARD = process.env.MB_CARD_ID || "21616";
const KEY = process.env.MB_API_KEY || "";
const out = process.argv[2];

if (!out) { console.error("usage: node scripts/refresh/fetch-card.js <out.json>"); process.exit(1); }
if (!KEY) {
  // NAME THE SECRET. A refresh that dies on a missing credential should say
  // which one and where it goes, or the next person re-derives it from the
  // workflow file.
  console.error("MB_API_KEY is not set.");
  console.error("Mint one in Metabase (Admin → Authentication → API keys, group: a read-only");
  console.error("group with access to Rec-Prod-ReadReplica) and add it to this repo's");
  console.error("Actions secrets as MB_API_KEY. Nothing was fetched and nothing was written.");
  process.exit(1);
}

const body = JSON.stringify({ ignore_cache: true });

const req = https.request({
  host: HOST, path: `/api/card/${CARD}/query/json`, method: "POST",
  headers: {
    "x-api-key": KEY,
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  },
  // The card reads the whole platform across 56 joins. It has taken over a
  // minute; a short timeout here would look exactly like a broken card.
  timeout: 15 * 60 * 1000,
}, res => {
  let raw = "";
  res.on("data", c => raw += c);
  res.on("end", () => {
    if (res.statusCode !== 200) {
      // Metabase puts the real reason in the body — a statement timeout and a
      // revoked key both come back as a 4xx, and they are opposite problems.
      console.error(`Metabase answered HTTP ${res.statusCode}: ${raw.slice(0, 400)}`);
      process.exit(1);
    }
    let rows;
    try { rows = JSON.parse(raw); }
    catch { console.error("Metabase did not answer JSON: " + raw.slice(0, 300)); process.exit(1); }

    // /query/json answers an ARRAY of row objects, and an error can also
    // arrive with a 200 as {"error": ...} — so the shape is checked rather
    // than indexed into.
    if (!Array.isArray(rows)) {
      console.error("expected an array of rows, got: " + JSON.stringify(rows).slice(0, 300));
      process.exit(1);
    }
    if (rows.length !== 1) {
      console.error(`expected exactly 1 row from card ${CARD}, got ${rows.length}`);
      process.exit(1);
    }
    const payload = rows[0] && rows[0].payload;
    // NULL IS NOT AN EMPTY SNAPSHOT. json_agg over no rows is NULL, so a
    // query that matched no organizations must fail here rather than write
    // "null" and let merge-snapshot decide what that means.
    if (typeof payload !== "string" || !payload.trim() || payload.trim() === "null") {
      console.error("the card's `payload` cell is empty or null — no organizations matched");
      process.exit(1);
    }
    // Parse before writing, so a truncated response fails here rather than
    // one step later with a less obvious message.
    let parsed;
    try { parsed = JSON.parse(payload); }
    catch (e) { console.error("`payload` is not valid JSON (truncated?): " + e.message); process.exit(1); }
    if (!Array.isArray(parsed) || !parsed.length) {
      console.error("`payload` is not a non-empty array"); process.exit(1);
    }
    fs.writeFileSync(out, payload);
    console.log(`✓ card ${CARD} → ${out} (${parsed.length} orgs, ${(payload.length / 1024).toFixed(0)}KB)`);
  });
});
req.on("timeout", () => { req.destroy(); console.error("Metabase timed out"); process.exit(1); });
req.on("error", e => { console.error("request failed: " + e.message); process.exit(1); });
req.write(body);
req.end();
