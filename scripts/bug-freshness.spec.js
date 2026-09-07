/**
 * The Bug Management org filter, and the snapshot-freshness readout.
 *
 * WHY THIS EXISTS. data/ps-data.json was baked once by hand on 2026-07-31 and
 * nothing refreshed it — the daily Routine only rebuilds features-data.json.
 * Five weeks later the page still listed PLA-1880 as "In Code Review" when it
 * had gone Done on 2026-08-04, and six of the seven rows at the top of the
 * Urgent list were closed. The sidebar said "Snapshot <date> · refreshed
 * daily" throughout, which is a claim the system was not keeping.
 *
 * So there are two guards here and they are different in kind:
 *
 *   1. The freshness helpers are LIFTED AND RUN. A regex over
 *      `d >= SNAP_STALE_DAYS` passes just as happily on an inverted
 *      comparison, and the whole point of these three functions is which way
 *      the comparison goes.
 *   2. The org filter and the bake script are source-asserted, each
 *      assertion scoped to the thing it is about — the page builds its DOM
 *      through React.createElement, so there is no component to mount here.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, "public", "ps.html"), "utf8");
const bake = fs.readFileSync(path.join(root, "scripts", "refresh", "merge-ps-bugs.js"), "utf8");

let pass = 0;
const failures = [];
const ok = (c, m) => { if (c) pass++; else failures.push(m); };
const eq = (g, w, m) => ok(g === w, `${m} — got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`);

process.on("exit", () => {
  if (failures.length) {
    console.error(`\n✗ bug-freshness.spec.js — ${failures.length} failure(s):\n`);
    failures.forEach(f => console.error("  ✗ " + f));
    console.error(`\n${pass} passed, ${failures.length} failed.\n`);
    process.exitCode = 1;
  } else {
    console.log(`✓ bug-freshness.spec.js — ${pass} assertions passed.`);
  }
});

// ── LIFT AND RUN THE FRESHNESS HELPERS ─────────────────────────────────────
let H = null;
{
  const start = src.indexOf("const SNAP_STALE_DAYS");
  const end = src.indexOf("function snapAgeLabel");
  ok(start > 0 && end > start, "the freshness helpers were found in ps.html");
  const block = src.slice(start, src.indexOf("\n  }\n", end) + 5);
  ok(/snapAgeDays/.test(block) && /snapStale/.test(block) && /snapAgeLabel/.test(block),
    "the lifted block carries all three helpers");
  try {
    H = new Function(block + "; return { snapAgeDays, snapStale, snapAgeLabel, SNAP_STALE_DAYS };")();
  } catch (ex) {
    failures.push("the freshness helpers THREW when lifted: " + ex.message);
  }
}

if (H) {
  const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString();

  // Age is measured, not asserted.
  eq(H.snapAgeDays(daysAgo(0)), 0, "a snapshot taken now is 0 days old");
  eq(H.snapAgeDays(daysAgo(1)), 1, "a snapshot from yesterday is 1 day old");
  eq(H.snapAgeDays(daysAgo(38)), 38, "the real 38-day-old snapshot reads 38 days old");

  // THE STALENESS BOUNDARY. The bake runs at 6am ET, so a reader before it
  // lands is legitimately looking at yesterday's snapshot. One day must not
  // warn; two days means a refresh was actually missed.
  eq(H.SNAP_STALE_DAYS, 2, "the staleness threshold is 2 days");
  eq(H.snapStale(daysAgo(0)), false, "today's snapshot is not stale");
  eq(H.snapStale(daysAgo(1)), false, "yesterday's snapshot is NOT stale — the bake runs at 6am ET");
  eq(H.snapStale(daysAgo(2)), true, "a two-day-old snapshot IS stale — a refresh was missed");
  eq(H.snapStale(daysAgo(38)), true, "the snapshot Dan was looking at would have been flagged");

  // An unreadable or absent date must fail TOWARD the warning. Treating it
  // as fresh is how the original went unnoticed: "cannot tell" is not "fine".
  eq(H.snapAgeDays(null), null, "a missing date has no age rather than an age of 0");
  eq(H.snapAgeDays("not a date"), null, "an unparseable date has no age rather than an age of 0");
  eq(H.snapStale(null), true, "a MISSING date counts as stale, never as fresh");
  eq(H.snapStale("not a date"), true, "an UNPARSEABLE date counts as stale, never as fresh");

  // A future timestamp (clock skew between the baking box and the reader)
  // must not render as a negative age.
  eq(H.snapAgeDays(daysAgo(-3)), 0, "a future timestamp clamps to 0 rather than going negative");

  eq(H.snapAgeLabel(daysAgo(0)), "today", "today reads as today");
  eq(H.snapAgeLabel(daysAgo(1)), "yesterday", "one day reads as yesterday");
  eq(H.snapAgeLabel(daysAgo(9)), "9 days old", "older reads as a day count");
  eq(H.snapAgeLabel(null), "date unreadable", "an unreadable date says so rather than printing a number");
}

// ── THE FOOTER STATES AGE AND NO LONGER PROMISES A CADENCE ─────────────────
{
  const foot = src.slice(src.indexOf('"Snapshot "') - 400, src.indexOf('"Snapshot "') + 900);
  ok(foot.length > 100, "the sidebar footer was found");
  // Asserted over a comment-STRIPPED copy, because the comment beside the
  // fix quotes the broken wording on purpose. Line comments are stripped
  // first: a `/*` inside a template literal makes block-first unsound, and
  // this repo's notes already record that biting nine specs.
  const noComments = src.replace(/^\s*\/\/.*$/gm, "");
  ok(noComments.length < src.length, "the comment strip actually removed something");
  ok(/refreshed daily/.test(src) && !/refreshed daily/.test(noComments),
    'the footer no longer claims "refreshed daily" in CODE — it said that for 38 days while nothing refreshed the bugs');
  ok(/snapStale\(data\.generatedAt\)/.test(foot),
    "the footer asks snapStale rather than rendering the date unconditionally");
  ok(/snapAgeDays\(data\.generatedAt\)/.test(foot),
    "the footer carries data-snap-age so a browser check can read the age");
  ok(/days old/.test(foot), "the stale branch says how old the snapshot is");
}

// ── THE ORG FILTER ─────────────────────────────────────────────────────────
{
  // Scope every assertion to the Bugs component: the page has other selects
  // and other panels, and a file-wide match would pass on any of them.
  const bugsFn = src.slice(src.indexOf("function Bugs({ data })"), src.indexOf("// ---------------- CX Reporting"));
  ok(bugsFn.length > 500, "the Bugs component was found and sliced");

  ok(/const \[org, setOrg\] = useState\(""\)/.test(bugsFn), "Bug Management holds an org selection");
  ok(/All orgs/.test(bugsFn), "the control offers an all-orgs option");
  ok(/b\.customers\.indexOf\(org\) >= 0/.test(bugsFn),
    "the funnel filters on the bug's own customer list");
  ok(/!org \|\|/.test(bugsFn),
    "an empty org selection means ALL orgs, not none — the same rule as the other filters here");

  // Options come from the bugs in hand, so an org with nothing open cannot
  // be picked and the filter can never produce an empty table.
  ok(/orgCounts\[c\] \|\| 0\) \+ 1/.test(bugsFn) || /\(m\[c\] \|\| 0\) \+ 1/.test(bugsFn),
    "the options are counted off the bugs themselves");
  ok(/orgCounts\[b\] - orgCounts\[a\] \|\| a\.localeCompare\(b\)/.test(bugsFn),
    "options are busiest-first with name as the tie-break, so two runs cannot disagree on order");
  ok(/orgs\.length \? e\("select"/.test(bugsFn),
    "no org control renders when no bug carries a customer — a filter with one empty option is a dead end");

  // NAMES ARE NEVER FOLDED. Linear holds near-duplicate customer records and
  // 52 of its 81 have no domain, so nothing can establish identity; matching
  // against Rec's own org list resolves 11 of 24 and the rest is a guess.
  // Merging two orgs on a page used to decide what to work on is silent and
  // wrong, so the guard is that no normalisation creeps in.
  ok(!/toLowerCase\(\)\.replace\(/.test(bugsFn),
    "org names are NOT normalised for grouping — that would silently merge two different orgs");
  ok(/verbatim/i.test(bugsFn), "the no-folding decision is recorded where the next person will read it");

  // COVERAGE IS STATED. Only a minority of open bugs carry a customer, so
  // the filter necessarily hides the untagged majority.
  ok(/data-bug-orgnote/.test(bugsFn), "picking an org renders a coverage note");
  ok(/carry no customer at all and are hidden by this filter/.test(bugsFn),
    "the note says what the filter hides rather than leaving the count to read as a total");
  ok(/org \? e\("div", \{ className: "note"/.test(bugsFn),
    "the note appears only when an org is actually selected");
}

// ── THE BAKE SCRIPT ────────────────────────────────────────────────────────
{
  ok(/statusType/.test(bake), "the bake reads Linear's statusType");
  ok(/"backlog", "unstarted", "started", "triage"/.test(bake),
    "open is defined as the four open state types");
  ok(/closed\.length/.test(bake),
    "the bake REFUSES a payload carrying closed issues — shipping those is the bug it exists to fix");
  ok(/issues\.length < 100/.test(bake) && /customers\.length < 20/.test(bake),
    "both floors are checked, so a partial fetch cannot overwrite a good snapshot");
  ok(/process\.exit\(1\)/.test(bake), "a failed sanity check exits non-zero rather than writing");

  // The bug -> org mapping comes from customer NEEDS, which is one call.
  ok(/need\.issue && need\.issue\.id/.test(bake), "orgs are attached via each need's issue id");
  ok(/\[\.\.\.new Set\(orgsByIssue\[i\.id\] \|\| \[\]\)\]/.test(bake),
    "an org attached twice to one bug is counted once");

  // Ordering: Linear scores "No priority" as 0, which would sort it above
  // Urgent. The page renders file order and does no sorting of its own.
  ok(/priorityValue === 0 \? 5/.test(bake),
    '"No priority" is ranked behind Low rather than ahead of Urgent');
  ok(/priorityValue: \(i\.priority && i\.priority\.value\) \|\| 0/.test(bake),
    "the stored priorityValue keeps Linear's own meaning rather than being rewritten for sorting");

  // The other two sections have their own sources and must survive a bake.
  ok(/\.\.\.old,/.test(bake), "everything else in ps-data.json is carried over");
  ok(!/accounts:/.test(bake) && !/featureRequests:/.test(bake),
    "the bake never writes accounts or featureRequests — those come from HubSpot and Airtable");
}

// ── AND THE SNAPSHOT IN THE REPO IS ACTUALLY OPEN BUGS ─────────────────────
{
  const snap = JSON.parse(fs.readFileSync(path.join(root, "data", "ps-data.json"), "utf8"));
  const OPEN = new Set(["backlog", "unstarted", "started", "triage"]);
  const closed = snap.bugs.filter(b => !OPEN.has(b.statusType));
  eq(closed.length, 0,
    `the committed snapshot carries no closed bugs${closed.length ? " — e.g. " + closed[0].id + " is " + closed[0].statusType : ""}`);
  ok(snap.bugs.length > 50, "the committed snapshot has a plausible number of open bugs");
  ok(snap.bugs.every(b => Array.isArray(b.customers)),
    "every bug carries a customers array, so the org filter can never read undefined");
}
