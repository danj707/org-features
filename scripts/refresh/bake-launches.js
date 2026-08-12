/**
 * Bake the launch-pipeline snapshot (data/launches-data.json) from Airtable.
 *
 * Source of truth: the FULL Services table in the Partner Management base
 * (https://airtable.com/apph3ijsChF7vzVFU/tbldMzOCKLs2xErip). All stages are
 * baked — including Launched and Delayed — and the dashboard filters
 * client-side (Launched/Delayed hidden by default, toggleable), so the
 * quarterly revenue and QTD numbers can count completed launches.
 *
 * Two consumers:
 *   - CLI: AIRTABLE_API_KEY=pat... node scripts/refresh/bake-launches.js
 *     writes data/launches-data.json.
 *   - server.js requires { bake } to power POST /api/launches/refresh (the
 *     dashboard's refresh button) and the daily self-refresh, using the
 *     AIRTABLE_API_KEY env var on Railway.
 *
 * The key needs read scope (data.records:read) on the base only.
 */

const BASE_ID  = "apph3ijsChF7vzVFU";
const TABLE_ID = "tbldMzOCKLs2xErip"; // Services

// Airtable pipeline stages carry a " (Module Launch)" suffix; the dashboard
// shows the bare stage name.
const STAGE_SUFFIX = / \(Module Launch\)$/;

const day = (iso) => (iso ? String(iso).slice(0, 10) : null);

function normalizeRecord(fields) {
  return {
    id: fields["Hubspot Record ID"] || null,
    name: fields["Name"] || "",
    company: fields["Company"] || null,
    owner: fields["Service Owner Name"] || "",
    ownerEmail: fields["Service Owner Email"] || null,
    category: fields["Category"] || null,
    stage: fields["Pipeline Stage"] ? String(fields["Pipeline Stage"]).replace(STAGE_SUFFIX, "") : null,
    regLaunch: day(fields["Registration Launch Date"]),
    start: day(fields["Start Date"]),
    end: day(fields["End Date"]),
    loe: fields["LOE"] || null,
    status: fields["Launch Status"] || null,
    acv: typeof fields["Gross ACV"] === "number" ? fields["Gross ACV"] : 0,
  };
}

async function bake(apiKey) {
  if (!apiKey) throw new Error("AIRTABLE_API_KEY is required");
  const services = [];
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${BASE_ID}/${TABLE_ID}`);
    url.searchParams.set("pageSize", "100");
    if (offset) url.searchParams.set("offset", offset);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`Airtable ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const page = await res.json();
    for (const rec of page.records || []) services.push(normalizeRecord(rec.fields || {}));
    offset = page.offset;
  } while (offset);

  // Stable order for clean diffs in the daily-refresh commits.
  services.sort((a, b) => (a.regLaunch || "9999").localeCompare(b.regLaunch || "9999") || a.name.localeCompare(b.name));

  return {
    generatedAt: new Date().toISOString(),
    source: `Airtable Services table (base ${BASE_ID}, all stages) — launch pipeline`,
    services,
  };
}

module.exports = { bake, normalizeRecord, BASE_ID, TABLE_ID };

if (require.main === module) {
  const fs = require("fs");
  const path = require("path");
  const out = path.join(__dirname, "..", "..", "data", "launches-data.json");
  bake(process.env.AIRTABLE_API_KEY)
    .then((snap) => {
      fs.writeFileSync(out, JSON.stringify(snap, null, 2) + "\n");
      console.log(`baked ${snap.services.length} services -> ${out}`);
    })
    .catch((err) => { console.error(err.message); process.exit(1); });
}
