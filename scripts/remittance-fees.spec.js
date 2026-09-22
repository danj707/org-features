/**
 * The per-org remittance fee schedule.
 *
 * A wrong rate here does not look wrong. It produces a well-formed remittance
 * carrying the wrong money, on a document finance sends to a city — so this
 * guards the MAP rather than the arithmetic (lib/remittance-workbook.js and
 * remittance-workbook.spec.js already hold the arithmetic to the penny).
 *
 * What it pins:
 *   1. every key is a rec.us organization UUID, never a slug or a name
 *   2. every entry is complete, integral and inside a sane band
 *   3. only a placeholder schedule is a draft
 *   4. only the STANDARD fee template ships — the per-transaction-minimum,
 *      technology-fee and ticket-fee orgs stay OUT, by name and structurally,
 *      because this report computes a different thing and would underbill them
 *   5. a FROZEN DIGEST of every rate, so changing one is a deliberate diff
 *      somebody has to justify rather than a line that slips through review
 */
const assert = require("assert");
const crypto = require("crypto");
const rem = require("../remittance.js");

let pass = 0;
const failures = [];
function ok(name, fn) {
  try { fn(); pass++; }
  catch (e) { failures.push(`${name}\n    ${String(e.message).split("\n")[0]}`); }
}
const eq = (name, got, want) => ok(name, () =>
  assert.strictEqual(typeof got === "function" ? got() : got, want));

const FEES = rem.REMITTANCE_FEES;
const entries = Object.entries(FEES);

/* ── 1 · keyed by UUID, never by name ────────────────────────────────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
ok("every key is a rec.us org UUID", () => {
  const bad = entries.filter(([k]) => !UUID.test(k)).map(([k]) => k);
  assert.deepStrictEqual(bad, [],
    `keyed by something that is not a UUID: ${bad.join(", ")} — two orgs are ` +
    `called Pleasant Hill and three some form of San Francisco, so a slug or a ` +
    `name cannot identify one`);
});
ok("the map is not empty", () => assert.ok(entries.length >= 30,
  `only ${entries.length} orgs have a schedule — did the map get truncated?`));

/* ── 2 · every entry complete, integral, in band ─────────────────────────── */

const NUM = ["cardRateBps", "cardFixedCents", "cashRateBps", "checkRateBps", "techRateBps"];
ok("every entry carries every rate as an integer", () => {
  const bad = [];
  for (const [id, f] of entries)
    for (const k of NUM)
      if (!Number.isInteger(f[k])) bad.push(`${id}.${k}=${f[k]}`);
  assert.deepStrictEqual(bad, [], `missing or non-integer rates: ${bad.join(", ")}`);
});
// A band, not a value. It cannot say a rate is RIGHT — only that a fat finger
// (35 for 350, or 3500) is not quietly billed to a city.
ok("no rate is outside a plausible band", () => {
  const bad = [];
  for (const [id, f] of entries) {
    if (f.cardRateBps < 100 || f.cardRateBps > 2000) bad.push(`${id} card ${f.cardRateBps}bps`);
    if (f.cardFixedCents < 0 || f.cardFixedCents > 200) bad.push(`${id} fixed ${f.cardFixedCents}c`);
    for (const k of ["cashRateBps", "checkRateBps", "techRateBps"])
      if (f[k] < 0 || f[k] > 1000) bad.push(`${id} ${k} ${f[k]}`);
  }
  assert.deepStrictEqual(bad, [], `out of band: ${bad.join(", ")}`);
});
ok("chargeFeeOnRefunds is an explicit boolean everywhere", () => {
  const bad = entries.filter(([, f]) => typeof f.chargeFeeOnRefunds !== "boolean").map(([k]) => k);
  assert.deepStrictEqual(bad, [], `not a boolean: ${bad.join(", ")} — undefined reads ` +
    `as "do not charge", which silently under-bills`);
});
ok("rateSource is one of the two known values", () => {
  const bad = [...new Set(entries.map(([, f]) => f.rateSource))].filter(v => v !== "remittance" && v !== "test");
  assert.deepStrictEqual(bad, [], `unknown rateSource: ${bad.join(", ")}`);
});

/* ── 3 · only a placeholder is a draft ───────────────────────────────────── */

// A schedule read out of an org's own last remittance and checked against it is
// the rate Rec actually billed, so it must NOT be stamped DRAFT — a report that
// calls itself a draft is one finance will not send.
eq("a 'remittance' schedule is not a draft",
   rem.ratesAreDraft({ rateSource: "remittance" }), false);
eq("a 'test' schedule IS a draft", rem.ratesAreDraft({ rateSource: "test" }), true);
eq("no schedule at all is a draft", rem.ratesAreDraft(null), true);
ok("exactly the placeholder orgs are drafts", () => {
  const drafts = entries.filter(([, f]) => rem.ratesAreDraft(f)).map(([k]) => k);
  assert.deepStrictEqual(drafts, ["a976a11a-5303-4785-838a-1b281ca77678"],
    `expected only City of Niagara Falls to be a draft, got ${drafts.length}: ${drafts.join(", ")}`);
});

/* ── 4 · only the STANDARD template ships ────────────────────────────────── */

// This map is one fee template: rate + fixed per card payment, flat on cash and
// cheque. Three other shapes exist on real remittances, and each is a separate
// template to be flagged per org in Airtable. Adding one of these orgs here
// produces a plausible number that is wrong, which is the failure this whole
// map is shaped to avoid.

// max(rate x amount, minimum) PER PAYMENT, against this report's
// rate x period total + fixed x count. Different arithmetic, not a different
// number.
const MINIMUM_MODEL = {
  "6bc65b55-27e4-4447-9c07-22c98c8dd99b": "Emeryville",
  "37478841-ab2a-48ce-8176-9197b719edd4": "Jeffersonville",
  "2dcbb832-c8b3-44c6-a729-703ee275d996": "Sebastopol Community Cultural Center",
  "ee3c6fb6-ddc6-479f-bf26-f112ea714e09": "Taylor",
};
ok("per-transaction-minimum orgs have no schedule", () => {
  const present = Object.keys(MINIMUM_MODEL).filter(id => FEES[id]).map(id => MINIMUM_MODEL[id]);
  assert.deepStrictEqual(present, [],
    `${present.join(", ")} bill on a per-transaction minimum, which this report ` +
    `does not compute — see docs/remittance-rates.md`);
});

// A technology fee is a percentage of TOTAL sales, taken off the remittance
// below "Total Rec Fee" — which is exactly why no rate check ever covered it:
// the check reproduces that total, and this sits outside it. Two of these label
// it "Technology Fee" where the rest write "Net Technology Fee", so they parsed
// as having none and would have billed $0 against a real fee.
const TECH_FEE = {
  "86cb6718-c7a4-4639-9f8b-1495f0dc9969": "Belton",
  "a6aef5df-f742-41a2-9088-1fb6d48c3cb1": "Danvers, MA",
  "f4338fa8-009b-49eb-9a2b-16ca4688694a": "Easton",
  "2a118b52-99af-42f3-9727-d9b46b8d31e4": "Euclid",
  "9acfb33a-4114-4f0f-be3c-2eb0a3930550": "Prescott Valley",
  "35861ae4-e71e-44e9-a574-9c5d6e691612": "The Dance Palace",
  "d781690b-c5a0-43c5-8443-9ae43899528c": "Watertown, MA",
  "1c80a358-74c2-477d-aa0b-87bb2d0514b3": "Windham, ME",
};
ok("technology-fee orgs have no schedule", () => {
  const present = Object.keys(TECH_FEE).filter(id => FEES[id]).map(id => TECH_FEE[id]);
  assert.deepStrictEqual(present, [],
    `${present.join(", ")} carry a technology fee, which no check here covers`);
});

// "Net Ticket Service Fees", which this report does not compute at all. Nine of
// these read $0.00 today and are held back with the one that does not: the money
// is identical this period, and the failure is next period, when the line moves
// and a workbook that cannot express it under-bills in silence.
const TICKET_FEE = {
  "71bf9bc4-cd62-482a-aee5-5d790cdba811": "Boerne",
  "baa12a2d-b31b-4900-85a1-e6f634f0a3ce": "Madeira Beach",
  "574923bd-9e7b-43e0-9e5f-7ce256189cbf": "Norman, OK",
  "70ea2e35-d1c7-4214-8074-3a598aa991f9": "Northern Door Sports and Recreation",
  "0a9c47af-b4c3-4601-ab0f-d2f401bb787a": "Shrewsbury, MA",
  "efc0724c-8f32-481a-bab3-fc19c724f3a7": "Smyrna",
  "7d22bf62-060a-4881-9821-9dea6a0538d6": "West Sacramento",
  "b026a7c3-1e7e-48e1-9f0a-b2f7154b117d": "Yerba Buena Gardens",
};
// NOTE this one can only ever be a name list. A technology fee shows up in the
// schedule as a non-zero techRateBps, so it has the structural guard below;
// nothing in a schedule says "this org sells tickets". A template flag on the
// Airtable record is what would make it structural.
ok("ticket-fee orgs have no schedule", () => {
  const present = Object.keys(TICKET_FEE).filter(id => FEES[id]).map(id => TICKET_FEE[id]);
  assert.deepStrictEqual(present, [],
    `${present.join(", ")} carry ticket service fees, which this report cannot compute`);
});

// The structural form of the same rule, so a NEW org on a non-standard template
// cannot arrive under a UUID no list above happens to name. Only the placeholder
// may carry a technology fee — it is what keeps lib/'s tech path exercised.
ok("no contracted schedule carries a technology fee", () => {
  const bad = entries.filter(([, f]) => f.rateSource !== "test" && f.techRateBps !== 0)
                     .map(([id]) => id);
  assert.deepStrictEqual(bad, [],
    `${bad.join(", ")} bills a technology fee — that is a separate template`);
});
ok("feesFor refuses an org with no schedule", () => {
  assert.strictEqual(rem.feesFor("6bc65b55-27e4-4447-9c07-22c98c8dd99b"), null);
  assert.strictEqual(rem.feesFor("not-an-org"), null);
});

/* ── 5 · the rates are frozen ────────────────────────────────────────────── */

// Every schedule below was read out of that org's own most recent remittance
// and checked twice — the rate reproduces that sheet's card fee, and the org
// UUID reproduces that sheet's card total from live Metabase. Changing one is a
// billing change, so it fails here until the digest is updated WITH the reason.
const digest = crypto.createHash("sha256").update(JSON.stringify(
  entries.map(([id, f]) => [id, f.cardRateBps, f.cardFixedCents, f.cashRateBps,
                            f.checkRateBps, f.techRateBps, !!f.chargeFeeOnRefunds])
         .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
)).digest("hex");
// A LITERAL, not an env var: a digest that can be supplied from the
// environment is one a red build can be waved through with.
const FROZEN = "50ae18167899775e31df44f029e06508bc1d3627328ee6efdd89394ce934a7fa";
eq("the fee schedules are unchanged", digest, FROZEN);

/* ── report ──────────────────────────────────────────────────────────────── */

process.on("exit", () => {
  if (failures.length) {
    for (const f of failures) console.error("  ✗ " + f);
    console.error(`✗ remittance-fees.spec.js — ${failures.length} failure(s), ${pass} passed.`);
    process.exitCode = 1;
  } else {
    console.log(`✓ remittance-fees.spec.js — ${pass} assertions passed (${entries.length} org schedules).`);
  }
});
