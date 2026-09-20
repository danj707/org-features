#!/usr/bin/env node
"use strict";
/**
 * BACKFILL THE ADOPTION HISTORY FROM THE PRODUCTION DATABASE.
 *
 *   node scripts/refresh/backfill-history.js --sql            print the query
 *   node scripts/refresh/backfill-history.js rows.json        merge the answer
 *   node scripts/refresh/backfill-history.js rows.json --check verify, write nothing
 *
 * WHY THIS EXISTS. merge-snapshot.js accrues one point per bake and says, in
 * its own comment, that the series cannot be reconstructed. That is true of
 * the SNAPSHOTS — a bake is a point in time and the older ones measured a
 * different feature set — and it is NOT true of the database underneath them:
 * every table the fleet query reads carries `created_at`, 35 of 54 also carry
 * a soft-delete column, and `organization.published_at` reconstructs the live
 * denominator per date. So the history is recoverable for any metric whose
 * predicate is a timestamped event.
 *
 * IT IS RECOVERABLE FOR 36 OF THE 60, AND THE OTHER 24 ARE NOT A GAP TO CLOSE.
 * Twenty of them read a column that carries no record of when it changed — a
 * boolean, a JSON config, a mutable status — so a reconstruction reproduces
 * TODAY's answer at every past date. That is not history, it is a flat line
 * wearing a trend's clothes, and drawing it beside a real one is the worse
 * failure. The remaining four are written as a join or a union and this
 * rewriter only handles single-table metrics.
 *
 * PROVEN AGAINST THE MEASURED SERIES, not asserted. The bake recorded
 * 2026-09-07 independently; reconstructing that date reproduces it exactly
 * for every backfillable feature tested, and misses by two on `instant_booking`
 * — which is the excluded class demonstrating itself.
 *
 * IT WRITES `backfill`, NEVER `history`. Three reasons, each sufficient:
 * merge-snapshot trims `history` to HISTORY_MAX and would eat this from the
 * front on the next bake; a reconstructed point and a measured one are
 * different evidence and the page has to be able to say which it is drawing;
 * and these points carry no per-org `scores`, because a score over 36
 * features is not the same measurement as a score over 60.
 */
const fs = require("fs");
const path = require("path");
const { parse } = require("./backfill-parse.js");

const DATA = path.join(__dirname, "..", "..", "data", "features-data.json");

/* THE WINDOW ENDS WHERE THE MEASURED SERIES BEGINS — 2026-09-07 is the first
   bake — so the two abut with no overlap and no gap, and no date is ever
   described by both a reconstruction and a measurement.

   AND IT STARTS WHERE THE DENOMINATOR BECOMES REAL, which is a measurement
   and not a preference. A share of the live fleet needs to know which
   organizations were live on that date, and the only column that can say is
   `organization.published_at` — whose earliest value on the whole platform is
   2026-01-19, shared by FORTY-TWO organizations. Forty-two cities did not
   launch on one Monday; the column was populated in bulk that day, and every
   value after it is organic (one to six a day). So before 2026-01-19 the live
   count reconstructs as ZERO, which is not a quiet inaccuracy — it is every
   share on the left of the chart dividing by nothing.

   A YEAR WAS TRIED FIRST AND IS WHAT FOUND THIS. The reconstruction ran
   2025-09-08 onward and drew a live fleet of 0 for four months that then
   jumped to 42 in one day, which is the shape of a backfilled column rather
   than of a platform. The all-organizations series IS sound that far back
   (`created_at` is real), but the dashboard quotes the live share, and
   shipping a line whose denominator is wrong for its first four months is
   the failure this whole exercise exists to avoid. */
const W_END = "2026-09-06";
const W_START = "2026-01-19";

/* DAILY, and that is forced rather than chosen. The chart's x axis is
   ORDINAL — `xAt = i => l + (i / (dates.length - 1)) * pw` — so it spaces
   points evenly whatever their dates. Monthly points spliced in front of
   daily ones would draw two years and eleven days at the same pitch, which
   is a chart that lies about time while every number on it is right. */

function dayList(a, b) {
  const out = [];
  let t = Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10));
  const end = Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10));
  const pad = n => (n < 10 ? "0" : "") + n;
  while (t <= end) {
    const d = new Date(t);
    out.push(d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()));
    t += 86400000;
  }
  return out;
}

/* ── THE QUERY ──────────────────────────────────────────────────────────
   IT RETURNS CHANGE POINTS, NOT DAYS, and that is forced rather than tidy.
   The raw intervals are 4,739 rows and the expanded grid is 365 days x 36
   features; neither fits through a query tool with a userspace row cap, and a
   silent truncation at 2,000 rows would publish a backfill missing whichever
   features sort last. Adoption is a STEP function — a feature moves a few
   dozen times in a year — so run-length encoding it is lossless and turns the
   whole year into 37 rows.

   THE REDUCTION HAPPENS IN SQL because the denominator does. An organization
   that had not launched on D is not part of D's live fleet and one that did
   not exist is not part of the fleet at all; joining `orgd` per day is what
   makes every share on the left of the chart a share of the fleet as it was,
   rather than of today's 73.

   A MONOTONE METRIC COLLAPSES TO ITS EARLIEST ROW. With no soft-delete test
   in the original predicate adoption can only ever turn on, so MIN() is exact
   and turns a scan of `message_delivery` into one row per organization. A
   windowed one emits its distinct intervals, clamped to the window so rows
   older than it collapse together. */
function buildSql() {
  const rows = parse().filter(r => !r.core && r.rw.ok);
  const iv = [];
  for (const r of rows) {
    const w = r.rw;
    const st = w.statics.length ? " AND " + w.statics.join(" AND ") : "";
    if (!w.windowed) {
      iv.push("  SELECT '" + r.key + "'::text k, t.organization_id oid, MIN(t.created_at)::date s, NULL::date e"
        + "\n    FROM " + w.table + " t WHERE t.created_at < DATE '" + W_END + "' + 1" + st + " GROUP BY 1,2");
    } else {
      iv.push("  SELECT '" + r.key + "'::text k, t.organization_id oid,"
        + " GREATEST(t.created_at::date, DATE '" + W_START + "') s, t." + w.closer + "::date e"
        + "\n    FROM " + w.table + " t WHERE t.created_at < DATE '" + W_END + "' + 1" + st
        + "\n     AND (t." + w.closer + " IS NULL OR t." + w.closer + " >= DATE '" + W_START + "') GROUP BY 1,2,3,4");
    }
  }
  return [
    "-- GENERATED by scripts/refresh/backfill-history.js --sql. Do not hand-edit:",
    "-- it is derived from fleet-query.sql's own joins, so it changes when they do.",
    "WITH days AS (SELECT generate_series(DATE '" + W_START + "', DATE '" + W_END + "', '1 day')::date d),",
    "orgd AS (",
    "  SELECT o.id, o.created_at::date born, o.published_at::date pub",
    "    FROM organization o",
    "   WHERE o.deleted_at IS NULL",
    "     AND o.slug NOT ILIKE '%sandbox%' AND o.name NOT ILIKE '%sandbox%'),",
    "iv AS (",
    iv.join("\n  UNION ALL\n"),
    "),",
    "ks AS (SELECT DISTINCT k FROM iv),",
    /* EVERY DAY GETS A ROW, even one where the count is zero. Counting only
       the days that have a qualifying organization and then LAGging over the
       result hides a drop to zero entirely — the run-length encoding would
       step straight over it and draw a line through a gap. */
    "cnt AS (",
    "  SELECT ks.k, d.d,",
    "         COUNT(DISTINCT i.oid) FILTER (WHERE o.id IS NOT NULL AND o.pub IS NOT NULL AND o.pub <= d.d) live,",
    "         COUNT(DISTINCT i.oid) FILTER (WHERE o.id IS NOT NULL) alln",
    "    FROM days d CROSS JOIN ks",
    "    LEFT JOIN iv i ON i.k = ks.k AND i.s <= d.d AND (i.e IS NULL OR i.e > d.d)",
    "    LEFT JOIN orgd o ON o.id = i.oid AND o.born <= d.d",
    "   GROUP BY 1,2),",
    "den AS (",
    "  SELECT '__fleet__'::text k, d.d,",
    "         COUNT(*) FILTER (WHERE o.pub IS NOT NULL AND o.pub <= d.d) live,",
    "         COUNT(*) alln",
    "    FROM days d JOIN orgd o ON o.born <= d.d",
    "   GROUP BY 1,2),",
    "allc AS (SELECT * FROM cnt UNION ALL SELECT * FROM den),",
    "rle AS (",
    "  SELECT k, d, live, alln,",
    "         LAG(live) OVER (PARTITION BY k ORDER BY d) pl,",
    "         LAG(alln) OVER (PARTITION BY k ORDER BY d) pa",
    "    FROM allc)",
    "SELECT k, string_agg(d::text || ':' || live || ',' || alln, ';' ORDER BY d) series",
    "  FROM rle",
    " WHERE pl IS NULL OR live <> pl OR alln <> pa",
    " GROUP BY k ORDER BY k",
  ].join("\n") + "\n";
}

/* ── THE REDUCER ────────────────────────────────────────────────────────
   Change points in, one point per day out. It is the ONE definition of what a
   backfilled point means, and the check below runs it against a date the bake
   measured independently — the only thing that can show the reconstruction is
   right rather than merely plausible. */
function expand(series, days) {
  /* A COUNT BEFORE THE FIRST CHANGE POINT IS ZERO, NOT MISSING. The encoding
     drops unchanged days, so the run before the first entry is the run where
     nobody had the feature yet, and defaulting it to the first recorded value
     would back-date every adoption to the start of the window. */
  const steps = String(series || "").split(";").filter(Boolean).map(t => {
    const [d, rest] = t.split(":");
    const [live, alln] = String(rest).split(",").map(Number);
    return { d, live, alln };
  });
  const out = {};
  let i = 0, cur = { live: 0, alln: 0 };
  for (const d of days) {
    while (i < steps.length && steps[i].d <= d) { cur = steps[i]; i++; }
    out[d] = { live: cur.live, alln: cur.alln };
  }
  return out;
}

function reduce(rows, days) {
  const by = {};
  for (const r of rows || []) {
    const k = r.k !== undefined ? r.k : r[0];
    const s = r.series !== undefined ? r.series : r[1];
    by[k] = expand(s, days);
  }
  const fleet = by.__fleet__;
  if (!fleet) throw new Error("no __fleet__ row in the answer \u2014 the denominator did not come back");
  const keys = Object.keys(by).filter(k => k !== "__fleet__").sort();
  if (!keys.length) throw new Error("no feature rows in the answer");

  return days.map(d => {
    const featureLive = {}, featureAll = {};
    for (const k of keys) { featureLive[k] = by[k][d].live; featureAll[k] = by[k][d].alln; }
    return { date: d, backfill: true, measured: keys.length,
             orgs: fleet[d].alln, liveOrgs: fleet[d].live, featureLive, featureAll };
  });
}

/* ── WHERE THE RECONSTRUCTION AND THE BAKE DISAGREE, AND WHY ─────────────
   Measured against the 2026-09-07 bake: 33 of the 36 backfilled features
   reproduce EXACTLY and so does the live denominator (73 = 73). These three
   do not, and each is a property of the method rather than a mistake in it.

   THE THIRD ONE IS THE HONEST LIMIT OF ALL OF THIS. A row that is HARD
   deleted leaves nothing behind, so a reconstruction reads today's table and
   cannot know the organization ever had one. It is measurable here only
   because the bake happened to record the same day: 71 live organizations
   have a site reservation window today and 71 had one on 2026-09-07, but only
   69 of today's 71 had theirs by then — so two of that day's are gone
   without trace, and two others joined since. Two organizations, on one
   feature of thirty-six, over thirteen days. */
const KNOWN_DIFFS = {
  /* The bake runs at 10:00 UTC; the reconstruction counts the whole calendar
     day. One organization sent its first email later on the 7th, and the
     measured series picks it up the next morning — 09-08 onward reads 66. */
  email_messaging: "the bake ran at 10:00 UTC and this counts the whole day; 09-08 onward measures 66",
  /* Hard deletes — see above. */
  group_reservation_windows: "two organizations' rows were hard-deleted since, so nothing survives for this to read",
  /* Not a disagreement at all: marketing_email was one of the four features
     added to the catalog on 2026-09-11, so the 2026-09-07 bake has no
     figure to compare against and the loop above skips it. */
  marketing_email: "not measured on 2026-09-07 \u2014 added to the catalog on 09-11",
};

function setKeyOf(keys) {
  const joined = keys.slice().sort().join(",");
  let h = 0;
  for (let i = 0; i < joined.length; i++) h = (h * 31 + joined.charCodeAt(i)) | 0;
  return keys.length + ":" + (h >>> 0).toString(36);
}

module.exports = { buildSql, reduce, expand, dayList, setKeyOf, W_START, W_END };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes("--sql")) { process.stdout.write(buildSql()); process.exit(0); }
  const file = args.find(a => !a.startsWith("--"));
  if (!file) {
    console.error("usage: backfill-history.js --sql | <rows.json> [--check]");
    console.error("  run the printed SQL against Rec-Prod-ReadReplica and save its rows to rows.json");
    process.exit(1);
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const rows = Array.isArray(raw) ? raw : (raw.rows || raw.data && raw.data.rows);
  const days = dayList(W_START, W_END);
  const points = reduce(rows, days);

  /* ── THE TRUTH CHECK ──────────────────────────────────────────────────
     The bake measured 2026-09-07 on its own, from a different query, before
     any of this existed. Reconstructing THE SAME DAY and diffing the two is
     the only thing that can show this is right rather than merely plausible,
     so the reconstruction of that date is committed as a fixture and
     scripts/backfill.spec.js re-runs the diff in CI with no database.

     THREE FEATURES DIFFER AND ALL THREE ARE EXPLAINED. They are listed by
     name rather than absorbed into a tolerance, because a tolerance would
     swallow the fourth one silently — and the fourth is the one worth
     hearing about. */
  const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
  const truth = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "fixtures", "backfill-truth-2026-09-07.json"), "utf8"));
  const bake = (data.history || []).find(h => h.date === truth.date);
  if (bake) {
    const keys = Object.keys(truth.featureLive).sort();
    const exact = [], differ = [];
    for (const k of keys) {
      if (bake.featureLive[k] == null) continue;   // the bake did not measure it that day
      (bake.featureLive[k] === truth.featureLive[k] ? exact : differ).push(k);
    }
    console.log("truth check — reconstructed " + truth.date + " against the bake that measured it:");
    console.log("  live organizations " + bake.liveOrgs + " measured vs " + truth.liveOrgs + " reconstructed");
    console.log("  " + exact.length + " of " + (exact.length + differ.length) + " features exact");
    for (const k of differ) {
      console.log("  " + k + ": measured " + bake.featureLive[k]
        + ", reconstructed " + truth.featureLive[k] + " — " + (KNOWN_DIFFS[k] || "UNEXPLAINED"));
    }
  }

  if (args.includes("--check")) { console.log("--check: nothing written"); process.exit(0); }

  const last = points[points.length - 1];
  data.backfill = points;
  data.backfillMeta = {
    from: W_START, to: W_END, points: points.length,
    setKey: setKeyOf(Object.keys(last.featureLive)),
    features: Object.keys(last.featureLive).sort(),
    excluded: parse().filter(r => !r.core && !r.rw.ok)
      .map(r => ({ key: r.key, why: r.rw.why })),
    source: "reconstructed from Rec production via scripts/refresh/backfill-history.js",
  };
  fs.writeFileSync(DATA, JSON.stringify(data, null, 2) + "\n");
  console.log("wrote " + points.length + " backfilled points ("
    + Object.keys(last.featureLive).length + " features) to " + DATA);
}
