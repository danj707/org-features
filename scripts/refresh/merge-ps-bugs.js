#!/usr/bin/env node
// Rebuild the `bugs` section of data/ps-data.json from a Linear payload.
//
// Usage: node scripts/refresh/merge-ps-bugs.js <payload.json>
//
// <payload.json> is { issues: [...], customers: [...] } where:
//   issues    — the `issues` arrays from Linear `list_issues`, label "Bug",
//               concatenated across state types (backlog/unstarted/started/
//               triage). Fetch per STATE, not by paging the whole label:
//               closed bugs outnumber open ones ~5:1 and paging wades
//               through all of them.
//   customers — the `customers` array from Linear `list_customers` with
//               includeNeeds: true. One call, no pagination. Each need
//               carries `issue.id`, which is the whole bug -> org mapping.
//
// Everything else in ps-data.json (accounts, featureRequests, sources) is
// carried over untouched — those come from HubSpot and Airtable and have
// their own refresh.

const fs = require("fs");
const path = require("path");

const payloadPath = process.argv[2];
if (!payloadPath) {
  console.error("usage: node scripts/refresh/merge-ps-bugs.js <payload.json>");
  process.exit(1);
}

const repoRoot = path.join(__dirname, "..", "..");
const dataFile = path.join(repoRoot, "data", "ps-data.json");
const old = JSON.parse(fs.readFileSync(dataFile, "utf8"));
const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));

const issues = payload.issues;
const customers = payload.customers;

// An open bug is one Linear has not finished with. `completed`, `canceled`
// and `duplicate` are all closed and must never reach the page — the whole
// reason this script exists is that a snapshot baked in July was still
// showing PLA-1880 as "In Code Review" five weeks after it went Done.
const OPEN = new Set(["backlog", "unstarted", "started", "triage"]);

if (!Array.isArray(issues) || !Array.isArray(customers)) {
  console.error("payload must be { issues: [...], customers: [...] }");
  process.exit(1);
}
// Sanity checks, in the spirit of merge-snapshot.js: refuse to write a
// snapshot that is obviously a partial fetch rather than a real change.
// The counts move daily, so these are floors, not equalities.
if (issues.length < 100) {
  console.error(`only ${issues.length} issues in payload; expected >=100 — looks like a partial fetch`);
  process.exit(1);
}
if (customers.length < 20) {
  console.error(`only ${customers.length} customers in payload; expected >=20 — looks like a partial fetch`);
  process.exit(1);
}
const closed = issues.filter(i => !OPEN.has(i.statusType));
if (closed.length) {
  console.error(`payload carries ${closed.length} closed issue(s) (e.g. ${closed[0].id} = ${closed[0].statusType}) — fetch by open state only`);
  process.exit(1);
}

// bug id -> the customer names that have a need attached to it.
// Names are used verbatim. Linear's customer list carries near-duplicate
// records for one org (three Jurupa Valley variants including a typo,
// Jeffersonville twice, Chico / City of Chico) and 52 of 81 records have no
// domain, so there is nothing to establish identity against. Folding them
// on name similarity would silently merge two different orgs, which is
// worse on a page used to decide what to work on. The fix belongs in
// Linear: give every customer the rec org UUID as its external ID, the way
// City of Torrance already does.
const orgsByIssue = {};
for (const c of customers) {
  for (const need of (c.needs || [])) {
    const id = need.issue && need.issue.id;
    if (!id) continue;
    (orgsByIssue[id] = orgsByIssue[id] || []).push(c.name);
  }
}

const now = Date.now();
const bugs = issues.map(i => ({
  id: i.id,
  title: i.title,
  team: i.team || null,
  status: i.status,
  statusType: i.statusType,
  priority: (i.priority && i.priority.name) || "No priority",
  // Linear's own value, kept verbatim: 1=Urgent .. 4=Low, 0=No priority.
  // Ordering is handled by prioRank below rather than by rewriting this,
  // so the stored field keeps meaning what Linear means by it.
  priorityValue: (i.priority && i.priority.value) || 0,
  labels: i.labels || [],
  createdAt: i.createdAt,
  ageDays: i.createdAt ? Math.floor((now - Date.parse(i.createdAt)) / 864e5) : null,
  createdBy: i.createdBy || null,
  assignee: i.assignee || null,
  url: i.url,
  customers: [...new Set(orgsByIssue[i.id] || [])].sort(),
}));

// Urgent first, then oldest — the order the page presents, since the table
// renders file order and does no sorting of its own. Linear scores
// "No priority" as 0, which would otherwise sort it ahead of Urgent, so
// rank it behind Low instead.
const prioRank = b => (b.priorityValue === 0 ? 5 : b.priorityValue);
bugs.sort((a, b) => prioRank(a) - prioRank(b) || (b.ageDays || 0) - (a.ageDays || 0));

const out = {
  ...old,
  generatedAt: new Date().toISOString(),
  sources: { ...old.sources },
  bugs,
};
out.sources.bugs = "Linear — open issues labeled Bug (backlog/todo/in-progress/triage), customers attached via Linear customer needs. Org names are Linear customer names verbatim; that list holds near-duplicate records for some orgs.";

fs.writeFileSync(dataFile, JSON.stringify(out, null, 2) + "\n");
const tagged = bugs.filter(b => b.customers.length).length;
console.log(`wrote ${dataFile}`);
console.log(`  ${bugs.length} open bugs (was ${old.bugs.length}), ${tagged} tagged to >=1 org`);
console.log(`  generatedAt ${out.generatedAt} (was ${old.generatedAt})`);
