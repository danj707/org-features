#!/usr/bin/env node
"use strict";
/**
 * THE BACKFILLED HALF OF THE ADOPTION SERIES.
 *
 * Three claims, and they need three different kinds of evidence:
 *
 *   1. THE CLASSIFICATION IS DERIVED, not listed. Every metric in
 *      fleet-query.sql is either mechanically datable or excluded with a
 *      stated reason, and a metric added tomorrow cannot quietly fall
 *      between the two.
 *   2. THE ARITHMETIC IS RIGHT. The expander and the reducer are LIFTED AND
 *      RUN — every defect here is an off-by-one on a step function, and a
 *      regex reads identically either way.
 *   3. THE RECONSTRUCTION MATCHES A MEASUREMENT IT NEVER SAW. The bake
 *      recorded 2026-09-07 from a different query before any of this
 *      existed; the fixture is that same day rebuilt from the database, and
 *      the diff runs here, in CI, with no database access.
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.join(__dirname, "..");
const bf = require("./refresh/backfill-history.js");
const { parse } = require("./refresh/backfill-parse.js");

let passed = 0;
function ok(cond, msg) { assert.ok(cond, msg); passed++; }
function eq(a, b, msg) { assert.strictEqual(a, b, msg); passed++; }

const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "features-data.json"), "utf8"));
const truth = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "backfill-truth-2026-09-07.json"), "utf8"));
const mergeSrc = fs.readFileSync(path.join(__dirname, "refresh", "merge-snapshot.js"), "utf8");
const pageSrc = fs.readFileSync(path.join(ROOT, "public", "ps.html"), "utf8");

/* ── 1. THE CLASSIFICATION ─────────────────────────────────────────────── */
const meta0 = data.backfillMeta || {};
const rows = parse().filter(r => !r.core);
const okKeys = rows.filter(r => r.rw.ok).map(r => r.key);
const noKeys = rows.filter(r => !r.rw.ok);

ok(rows.length >= 55, "fleet-query parsed to only " + rows.length + " adoption metrics — the regex stopped matching");
ok(okKeys.length >= 30, "only " + okKeys.length + " metrics classified backfillable — the rewriter stopped matching");
ok(noKeys.length > 0, "nothing was excluded — the untimestamped denylist stopped matching");

/* EVERY METRIC IS ON EXACTLY ONE SIDE. This is the assertion that fails when
   somebody adds a metric to fleet-query.sql: it is either datable, or it is
   excluded with a reason a reader can act on. There is no third state, and
   "forgot about it" is not one of them. */
const measured = data.measuredFeatures || [];
for (const k of measured) {
  const hit = rows.find(r => r.key === k);
  ok(hit, "measured feature `" + k + "` has no join in fleet-query.sql — the backfill cannot classify it");
  if (!hit) continue;
  const isOk = hit.rw.ok, why = hit.rw.why;
  ok(isOk ? !why : !!why,
    "`" + k + "` is neither backfillable nor excluded with a reason");
}
for (const r of noKeys) {
  ok(typeof r.rw.why === "string" && r.rw.why.length > 20,
    "`" + r.key + "` is excluded with no usable reason");
  /* THE REASON MUST NAME A CAUSE, not a property of this rewriter's regex.
     "not a single-table metric" is about the tool; "reads a column with no
     record of when it changed" is about the data, and it is the one a reader
     can do something with. Both are allowed; a bare refusal is not. */
  ok(/no record of when it changed|reconstructible|not one interval/.test(r.rw.why),
    "`" + r.key + "` is excluded for an unrecognised reason: " + r.rw.why);
}

/* AND THE UNTIMESTAMPED CLASSIFICATION IS CHECKED AGAINST THE SQL rather than
   trusted. A metric excluded as untimestamped must actually read one of those
   columns, or the denylist has drifted into excluding things it should not. */
for (const r of noKeys.filter(x => x.rw.untimestamped)) {
  ok(/no record of when it changed/.test(r.rw.why),
    "`" + r.key + "` is flagged untimestamped but its reason says otherwise");
}

/* THE DENYLIST HAS TO BE SEEN DOING WORK. Gutting it survived the first
   mutation run: fewer exclusions still left the join-and-union four, so every
   count assertion above stayed true while twenty features silently gained a
   history the database cannot support — which is the one outcome this whole
   exercise exists to prevent.

   FOUR ARE NAMED, and they are the four the write-up rests on. `instant_booking`
   is the measured proof (63 on the morning of 2026-09-07, reconstructs as 61,
   because two organizations turned the flag off and nothing recorded when);
   the other three are the same shape on a JSON config. A change that makes any
   of them backfillable is a change somebody has to justify, not one that
   slides through on a count. */
const untimestamped = noKeys.filter(x => x.rw.untimestamped).map(x => x.key);
ok(untimestamped.length >= 15,
  "only " + untimestamped.length + " metrics are excluded as untimestamped — the denylist has been weakened");
for (const k of ["instant_booking", "waitlist", "payment_plans", "auto_renew_memberships"]) {
  ok(untimestamped.indexOf(k) >= 0,
    "`" + k + "` reads a column with no record of when it changed and MUST NOT be backfilled");
  ok(!(meta0.features || []).includes(k),
    "`" + k + "` has backfilled history — its value today says nothing about any past date");
}

/* ── 2. THE ARITHMETIC ─────────────────────────────────────────────────── */
const days = bf.dayList("2026-03-01", "2026-03-05");
eq(days.length, 5, "dayList is inclusive of both ends");
eq(days[0], "2026-03-01", "dayList starts on the start date");
eq(days[4], "2026-03-05", "dayList ends on the end date");

/* A COUNT BEFORE THE FIRST CHANGE POINT IS ZERO. The encoding drops unchanged
   days, so the run before the first entry is the run where nobody had the
   feature — carrying the first recorded value backwards instead would
   back-date every adoption to the start of the window, which is the single
   most flattering way for this to be wrong. */
const e1 = bf.expand("2026-03-03:7,9", days);
eq(e1["2026-03-01"].live, 0, "a day before the first change point must read 0, not the first value");
eq(e1["2026-03-02"].live, 0, "a day before the first change point must read 0, not the first value");
eq(e1["2026-03-03"].live, 7, "a change point applies ON its own date, not the day after");
eq(e1["2026-03-05"].live, 7, "the last value carries forward to the end of the window");
eq(e1["2026-03-03"].alln, 9, "the all-organizations count is read from the same entry");

/* A STEP DOWN IS CARRIED AS FAITHFULLY AS A STEP UP. Adoption is not monotone
   once a soft-delete window is in play, and an expander that only ever climbed
   would silently flatten every removal. */
const e2 = bf.expand("2026-03-01:5,5;2026-03-03:3,4", days);
eq(e2["2026-03-02"].live, 5, "the value holds until the next change point");
eq(e2["2026-03-04"].live, 3, "a decrease is carried like any other change");

/* THE REDUCER NEEDS ITS DENOMINATOR, and says so rather than dividing by
   nothing. A missing __fleet__ row means the query did not run as written. */
assert.throws(() => bf.reduce([["discount_codes", "2026-03-01:1,1"]], days),
  /__fleet__/, "a reduce with no fleet row must throw naming it");
passed++;
assert.throws(() => bf.reduce([["__fleet__", "2026-03-01:1,1"]], days),
  /no feature rows/, "a reduce with no feature rows must throw naming it");
passed++;

const pts = bf.reduce([["__fleet__", "2026-03-01:10,20"],
                       ["discount_codes", "2026-03-03:4,6"]], days);
eq(pts.length, 5, "the reducer emits one point per day");
eq(pts[0].liveOrgs, 10, "the live denominator comes from the fleet row");
eq(pts[0].orgs, 20, "the all-organizations denominator comes from the fleet row");
eq(pts[0].featureLive.discount_codes, 0, "a feature with no change point yet reads 0");
eq(pts[2].featureLive.discount_codes, 4, "a feature reads its change point on the day it lands");
eq(pts[0].backfill, true, "every reconstructed point is marked as one");
ok(pts[0].scores === undefined,
  "a reconstructed point must carry NO per-org scores — a score over 36 features is not a score over 60");
ok(pts[0].setKey === undefined,
  "a reconstructed point must carry NO setKey, so the per-org series drops it");

/* ── 3. AGAINST A MEASUREMENT IT NEVER SAW ─────────────────────────────── */
const bake = (data.history || []).find(h => h.date === truth.date);
ok(bake, "the bake's " + truth.date + " point is gone — the truth check has nothing to compare against");
if (bake) {
  eq(truth.liveOrgs, bake.liveOrgs,
    "the reconstructed live denominator disagrees with the bake that measured it");
  const keys = Object.keys(truth.featureLive).filter(k => bake.featureLive[k] != null);
  ok(keys.length >= 30, "only " + keys.length + " features are comparable — the fixture drifted from the bake");
  const differ = keys.filter(k => bake.featureLive[k] !== truth.featureLive[k]);
  ok(keys.length - differ.length >= 33,
    "only " + (keys.length - differ.length) + " of " + keys.length
    + " features reproduce the bake exactly — the reconstruction has regressed");
  /* EVERY DIFFERENCE IS NAMED, not tolerated. A tolerance would swallow the
     next one silently, and the next one is the one worth hearing about. */
  const known = ["email_messaging", "group_reservation_windows"];
  for (const k of differ) {
    ok(known.indexOf(k) >= 0,
      "`" + k + "` now disagrees with the bake (measured " + bake.featureLive[k]
      + ", reconstructed " + truth.featureLive[k] + ") and is not one of the two explained differences");
  }
}

/* ── 4. WHAT WAS WRITTEN ───────────────────────────────────────────────── */
const back = data.backfill || [];
const meta = data.backfillMeta || {};
ok(back.length > 200, "only " + back.length + " backfilled points — the series was truncated");
eq(back[0].date, meta.from, "the first point does not start where the metadata says");
eq(back[back.length - 1].date, meta.to, "the last point does not end where the metadata says");

/* THE TWO SERIES ABUT AND DO NOT OVERLAP. No date may be described by both a
   reconstruction and a measurement — a reader hovering one date must not get
   two different answers depending on which array won. */
const liveDates = new Set((data.history || []).map(h => h.date));
for (const p of back) {
  ok(!liveDates.has(p.date), "reconstructed point " + p.date + " overlaps a measured bake");
}
const firstBake = [...liveDates].sort()[0];
ok(back[back.length - 1].date < firstBake,
  "the reconstruction runs past the first measured bake (" + firstBake + ")");

let prev = "";
for (const p of back) {
  ok(p.date > prev, "backfill dates are not strictly ascending at " + p.date);
  prev = p.date;
  ok(p.scores === undefined, "backfilled point " + p.date + " carries per-org scores");
  ok(p.setKey === undefined, "backfilled point " + p.date + " carries a setKey");
  ok(p.liveOrgs > 0, "backfilled point " + p.date + " has no live denominator");
}
/* EVERY POINT CARRIES EVERY BACKFILLED FEATURE AND NOTHING ELSE. A point
   missing a key makes that feature's line skip a day; a point carrying an
   extra one would give a feature history the method cannot support. */
const featureSet = (meta.features || []).slice().sort().join(",");
ok(featureSet.length > 0, "backfillMeta lists no features");
for (const p of back) {
  eq(Object.keys(p.featureLive).sort().join(","), featureSet,
    "backfilled point " + p.date + " does not carry exactly the declared feature set");
}
/* AND NONE OF THE EXCLUDED ONES LEAKED IN. This is the assertion that fails if
   the denylist is weakened — the whole point is that these 24 have no
   reconstructable history, so a line for one of them would be invented. */
for (const x of meta.excluded || []) {
  ok(!(x.key in back[0].featureLive),
    "`" + x.key + "` is excluded but has backfilled history anyway");
}
eq((meta.excluded || []).length + (meta.features || []).length, measured.length,
  "the backfilled and excluded sets do not add up to the measured catalog");

/* ── 5. THE NIGHTLY BAKE MUST NOT EAT IT ───────────────────────────────── */
/* `out` is assembled from scratch every morning, so a key not named there is
   deleted by the next refresh — silently, in a commit whose diff looks
   routine. That would have happened the first morning after this landed. */
/* COPIED VERBATIM, and the message says both ways that can fail. An earlier
   run mutated this into `(old.backfill || []).concat([point])` and was caught
   here reading "the next bake deletes it" — true of one failure and not of
   the one in front of it, and a mutation caught by a message that misdescribes
   it has not shown the assertion works. */
ok(/backfill:\s*old\.backfill\s*,/.test(mergeSrc),
  "merge-snapshot does not copy `backfill` forward verbatim — the next bake would delete it, "
  + "or rewrite it with measured points");
ok(/backfillMeta:\s*old\.backfillMeta/.test(mergeSrc),
  "merge-snapshot does not carry `backfillMeta` forward — the next bake deletes it");
/* NAMING THE MUTATION, not its neighbourhood. The first version of this
   asserted that HISTORY_MAX did not appear within 200 characters of
   `backfill` — and failed on correct code, because the comment explaining
   WHY the trim does not apply says both words in one sentence. A guard that
   a comment can trip is a guard people learn to work around; it tests for
   the statements that would actually do the damage. */
for (const bad of ["backfill.push(", "backfill.shift(", "backfill.pop(",
                   "backfill.splice(", "backfill.concat(", "backfill.sort("]) {
  ok(mergeSrc.indexOf(bad) < 0,
    "merge-snapshot calls " + bad + ") — reconstructed points and measured ones must not mix");
}
ok(!/while\s*\([^)]*backfill[^)]*\)/.test(mergeSrc),
  "merge-snapshot trims `backfill` in a loop — it is a fixed series, not a growing one");

/* ── 6. THE PAGE READS BOTH, AND SAYS WHICH ────────────────────────────── */
function lift(name) {
  const at = pageSrc.indexOf("function " + name + "(");
  assert.ok(at > 0, "could not find " + name + " in ps.html");
  let i = pageSrc.indexOf("{", pageSrc.indexOf(")", at)), depth = 0, j = i;
  for (; j < pageSrc.length; j++) {
    if (pageSrc[j] === "{") depth++;
    else if (pageSrc[j] === "}" && --depth === 0) break;
  }
  return pageSrc.slice(at, j + 1);
}
const pageFns = new Function(
  lift("ofSeriesHistory") + lift("ofBackfilledKeys") + lift("ofChartProvenance") + lift("ofTrend")
  + " const TREND_MIN_POINTS = 2;"
  + " return { ofSeriesHistory, ofBackfilledKeys, ofChartProvenance, ofTrend };")();

const merged = pageFns.ofSeriesHistory({
  backfill: [{ date: "2026-01-19" }, { date: "2026-02-01" }],
  history: [{ date: "2026-09-07" }],
});
eq(merged.length, 3, "the page does not merge the two series");
eq(merged[0].date, "2026-01-19", "the merged series is not sorted oldest first");
eq(merged[2].date, "2026-09-07", "the measured points do not come last");

/* THE PER-ORG SERIES MUST STILL DROP THE RECONSTRUCTION. Those points have no
   scores and no setKey, and `ofTrend` has to reject them on both counts — a
   score over 36 features plotted against one over 60 is a definition change
   drawn as organization behaviour, which is the exact thing the setKey
   mechanism was built to prevent. */
const orgTrend = pageFns.ofTrend(
  [{ date: "2026-01-19", featureLive: { a: 1 } },
   { date: "2026-09-07", setKey: "60:x", scores: { apex: 50 } },
   { date: "2026-09-08", setKey: "60:x", scores: { apex: 55 } }],
  "apex", "60:x");
eq(orgTrend.points.length, 2, "the per-organization trend picked up a reconstructed point");

const bfKeys = pageFns.ofBackfilledKeys({ backfillMeta: { features: ["a", "b"] } });
ok(bfKeys.has("a") && !bfKeys.has("c"), "ofBackfilledKeys does not read backfillMeta.features");
eq(pageFns.ofBackfilledKeys({}).size, 0, "ofBackfilledKeys must not throw on a file with no backfill");

/* THE PROVENANCE NOTE ONLY EXISTS WHILE IT IS TRUE. All-reconstructed and
   none-reconstructed are both states where the sentence is noise, and noise is
   what the next reader learns to skip. */
const prov = pageFns.ofChartProvenance(["a", "b", "c"], new Set(["a", "b"]), "Jan 19");
ok(/2 reconstructed/.test(prov) && /1 measured/.test(prov),
  "the provenance note does not count the two halves: " + prov);
eq(pageFns.ofChartProvenance(["a", "b"], new Set(["a", "b"]), "Jan 19"), null,
  "the note must be absent when every series is reconstructed");
eq(pageFns.ofChartProvenance(["a", "b"], new Set(), "Jan 19"), null,
  "the note must be absent when nothing is reconstructed");

/* ── THE RANKING COMPARES LIKE WITH LIKE ───────────────────────────────
   "Moved most" over each series' own span is not a comparison once the two
   halves exist: eight months of drift beats three weeks of real movement
   every time. Measured on the real feed before this was scoped, it pushed
   ALL 24 measured-only features off the chart — 14 pills, every one
   reconstructed. The rank window is the first measured bake onward, which
   every feature has by construction. */
const rankFns = new Function(
  lift("ofChartRankFrom") + lift("ofChartRankDelta")
  + " const TREND_MIN_POINTS = 2;"
  + " return { ofChartRankFrom, ofChartRankDelta };")();

eq(rankFns.ofChartRankFrom([{ date: "2026-01-19", backfill: true },
                             { date: "2026-09-07" }, { date: "2026-09-08" }]),
   "2026-09-07", "the rank window must start at the first MEASURED bake");
eq(rankFns.ofChartRankFrom([{ date: "2026-09-07" }]), "2026-09-07",
   "with no reconstruction the rank window is the whole series");
eq(rankFns.ofChartRankFrom([{ date: "2026-01-19", backfill: true }]), null,
   "with nothing measured there is no shared window to rank over");

/* THE DISCRIMINATING CASE: a long series that drifted 20 points over eight
   months against a short one that moved 6 in the shared window. Unscoped the
   first wins on 20; scoped it moves 1 and correctly loses. A fixture where
   both rank the same way could not tell the two implementations apart. */
const longSeries = { points: [
  { date: "2026-01-19", v: 30 }, { date: "2026-09-07", v: 49 }, { date: "2026-09-20", v: 50 } ] };
const shortSeries = { points: [
  { date: "2026-09-07", v: 10 }, { date: "2026-09-20", v: 16 } ] };
eq(rankFns.ofChartRankDelta(longSeries, "2026-09-07"), 1,
   "the long series' rank delta must be taken from the shared window, not its own start");
eq(rankFns.ofChartRankDelta(shortSeries, "2026-09-07"), 6,
   "the short series' rank delta is its whole span");
ok(Math.abs(rankFns.ofChartRankDelta(shortSeries, "2026-09-07"))
   > Math.abs(rankFns.ofChartRankDelta(longSeries, "2026-09-07")),
   "the short series still ranks below the long one — the window is not being applied");
eq(rankFns.ofChartRankDelta(longSeries, null), 20,
   "with no shared window the delta is the whole span, i.e. the old behaviour");
eq(rankFns.ofChartRankDelta({ points: [{ date: "2026-09-20", v: 5 }] }, "2026-09-07"), null,
   "one point in the window is not a delta");

ok(/ofChartOrder\(wrows, rankFrom\)/.test(pageSrc),
  "the chart still ranks over each series' own span — the 24 measured-only features get buried");
ok(/ofChartDefault\(ofChartRows\(rows, history\), ofChartRankFrom\(history\)\)/.test(pageSrc),
  "the chart's DEFAULT selection is not ranked over the shared window");

/* AND THE CHART IS WIRED TO THE MERGED SERIES, not to the measured half. */
ok(/history:\s*ofSeriesHistory\(d\)/.test(pageSrc),
  "the view model still reads d.history directly — the reconstruction never reaches the chart");
ok(/"data-of-chart-bf"/.test(pageSrc),
  "the chart pills do not mark which features are reconstructed");
ok(/data-of-chart-prov/.test(pageSrc),
  "the chart footnote does not carry the provenance note");

console.log("✓ backfill.spec.js — " + passed + " assertions passed.");
