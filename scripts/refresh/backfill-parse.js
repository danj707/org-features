"use strict";
/**
 * PARSE fleet-query.sql's OWN JOINS. Nothing here restates a metric.
 *
 * WHY DERIVED RATHER THAN LISTED: a hand-kept second copy of sixty metric
 * definitions is the drift this repo family keeps writing down — the copy is
 * only ever as current as the last person to edit it, and a metric that grows
 * a predicate would keep backfilling under the old one, silently, on a chart
 * nobody can check by eye. So the backfill reads the shipping query, and a
 * metric it cannot mechanically rewrite is a THROW rather than an omission.
 */
const fs = require("fs");
const path = require("path");

const SQL = path.join(__dirname, "fleet-query.sql");

/* A PREDICATE THAT READS A COLUMN WITH NO TIMESTAMP CANNOT BE DATED, and the
   list is measured rather than guessed: each of these is a column whose value
   today says nothing about its value on an earlier date, because nothing
   anywhere records when it changed. Reconstructing one reproduces TODAY's
   answer at every historical date — a flat line wearing a trend's clothes.

   PROVEN ON REAL DATA, 2026-09-07: `instant_booking` was measured at 63 that
   morning and reconstructs as 61, which is today's figure. Two organizations
   turned the flag off in between and the database kept no record of it. */
const UNTIMESTAMPED = [
  "is_instant_bookable", "allow_guests", "auto_renewal", "use_form_on_file",
  "publish_to_public", "tax_bps", "buffer_minutes_between_reservations",
  "waitlist_config", "available_payment_plans", "required_info_config",
  "skill_level", "pricing_policy", "oauth_connection_id", "requireAutopay",
  "status", "name NOT IN",
];

/* THE SOFT-DELETE COLUMNS, which are the opposite case: each one carries the
   INSTANT of the transition, so `(x IS NULL OR x >= D)` reconstructs the
   predicate exactly at any past date rather than approximately. */
const CLOSERS = ["deleted_at", "archived_at", "canceled_at"];

function joins(sql) {
  const out = [];
  for (const line of String(sql).split("\n")) {
    if (!/^LEFT JOIN \(/.test(line)) continue;
    const alias = (/\)\s+([a-z0-9_]+)\s+ON\s/i.exec(line) || [])[1] || null;
    const inner = line.slice(line.indexOf("(") + 1, line.lastIndexOf(") " + alias));
    out.push({ alias, key: alias ? alias.replace(/^[ac]_/, "") : null,
               core: /^c_/.test(alias || ""), line, inner });
  }
  return out;
}

/* THE REWRITE, and it is deliberately narrow. It handles the one shape the
   query actually uses sixty times over — `SELECT organization_id, COUNT(*)
   FROM <table> [WHERE ...] GROUP BY 1` — and refuses everything else rather
   than guessing. A metric written as a UNION, a LATERAL or a join is not
   mechanically datable here and has to be excluded by name, with a reason. */
function rewrite(j) {
  const m = /FROM\s+([a-z0-9_"]+)\s*(?:WHERE\s+(.*?))?\s*GROUP BY 1\s*$/i.exec(j.inner);
  if (!m) return { ok: false, why: "written as a join or union \u2014 its history is reconstructible, this backfill only rewrites single-table metrics" };
  const table = m[1];
  const where = (m[2] || "").trim();
  const blocked = UNTIMESTAMPED.filter(c => where.includes(c));
  if (blocked.length) return { ok: false, why: "reads " + blocked.join(", ") + " — no record of when it changed", untimestamped: true };

  /* SPLIT THE PREDICATE IN TWO. A soft-delete test becomes the closing end of
     an interval; everything else is a property of the row that was true when
     it was written, so it rides along unchanged. */
  const parts = where ? where.split(/\s+AND\s+/i).map(s => s.trim()).filter(Boolean) : [];
  const statics = [], closers = [];
  for (const p of parts) {
    const c = CLOSERS.find(x => new RegExp("\\b" + x + "\\s+IS NULL$", "i").test(p));
    if (c) closers.push(c); else statics.push(p);
  }
  if (closers.length > 1) return { ok: false, why: "two closing columns (" + closers.join(", ") + ") \u2014 not one interval" };
  return { ok: true, table, statics, closer: closers[0] || null,
           windowed: !!closers[0] };
}

function parse() {
  const sql = fs.readFileSync(SQL, "utf8");
  const all = joins(sql);
  if (all.length < 50) throw new Error("fleet-query.sql parsed to only " + all.length + " joins — the regex stopped matching");
  return all.map(j => Object.assign({}, j, { rw: rewrite(j) }));
}

module.exports = { parse, joins, rewrite, UNTIMESTAMPED, CLOSERS, SQL };

if (require.main === module) {
  const rows = parse();
  const ok = rows.filter(r => !r.core && r.rw.ok);
  const no = rows.filter(r => !r.core && !r.rw.ok);
  console.log("adoption metrics: " + rows.filter(r => !r.core).length
    + "  backfillable: " + ok.length + "  not: " + no.length);
  console.log("\nNOT BACKFILLABLE");
  for (const r of no) console.log("  " + r.key.padEnd(28) + r.rw.why);
  console.log("\nBACKFILLABLE (" + ok.filter(r => r.rw.windowed).length + " windowed)");
  for (const r of ok) console.log("  " + r.key.padEnd(28) + r.rw.table + (r.rw.closer ? "  [" + r.rw.closer + "]" : ""));
}
