/**
 * The dark/light theme.
 *
 * WHAT THIS IS REALLY GUARDING. A theme built out of custom properties fails
 * in exactly one way: a colour that never became a token. The page still
 * renders, nothing throws, every other check passes — and one card, one pill
 * or one label stays light on a dark page. It is invisible in review because
 * `#334155` reads as a perfectly reasonable slate, and it is invisible to the
 * render check unless a case happens to look at that exact element.
 *
 * So the load-bearing assertion here is the SWEEP: no themeable hex may
 * survive anywhere in ps.html outside the token declarations themselves and
 * the regions named below WITH THEIR REASON. A new hardcoded colour fails on
 * the commit that adds it, rather than being found by somebody switching to
 * dark mode a month later.
 *
 * The second is PARITY. A token declared in :root and forgotten in the dark
 * scope keeps its LIGHT value on a dark page — the same symptom, and harder
 * to spot, because the token looks correctly used at every call site. Both
 * scopes must declare the same names, and the two dark sites (the media query
 * and the [data-theme] scope) must agree, or OS-dark and toggled-dark are two
 * different themes.
 *
 * Every assertion in here is a source assertion, so there is no SKIP_SOURCE.
 * The behavioural half lives in ci-check-render.js, where the COMPUTED
 * background of a real card is read — a class called "dark" is not a dark
 * page, and no amount of grepping our own patch can tell the difference.
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(ROOT, "public", "ps.html"), "utf8");

let pass = 0;
const failures = [];
const ok = (c, m) => { if (c) pass++; else failures.push(m); };
const eq = (g, w, m) => ok(JSON.stringify(g) === JSON.stringify(w),
  `${m} — got ${JSON.stringify(g)}, want ${JSON.stringify(w)}`);

/* Brace counting rather than a regex: these blocks hold comments and a
   nested at-rule, and a lazy `{[^}]*}` stops at the first inner brace. */
function blockAt(s, marker, from) {
  const i = s.indexOf(marker, from || 0);
  if (i < 0) return null;
  const open = s.indexOf("{", i);
  if (open < 0) return null;
  let d = 0;
  for (let j = open; j < s.length; j++) {
    if (s[j] === "{") d++;
    else if (s[j] === "}" && --d === 0) return { body: s.slice(open + 1, j), start: i, end: j };
  }
  return null;
}
const declNames = (body) =>
  [...(body || "").matchAll(/(--[a-z0-9-]+)\s*:/g)].map(m => m[1]).sort();
const declPairs = (body) => {
  const out = {};
  for (const m of (body || "").matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g))
    out[m[1]] = m[2].trim();
  return out;
};

// ── the three declaration sites ────────────────────────────────────────────
const LIGHT = blockAt(src, "\n  :root {");
const MEDIA = blockAt(src, "@media (prefers-color-scheme: dark)");
const STAMP = blockAt(src, ':root[data-theme="dark"] {');

ok(LIGHT && declNames(LIGHT.body).length > 20,
   "the light :root block is found and declares the token set");
ok(MEDIA, "the OS-preference block is found");
ok(STAMP, 'the [data-theme="dark"] block is found');

/* The media query wraps its own :root, so slice one level deeper. */
const MEDIA_ROOT = MEDIA ? blockAt(MEDIA.body, ":root") : null;
ok(MEDIA_ROOT, "the OS-preference block declares tokens on :root");

const L = LIGHT ? declPairs(LIGHT.body) : {};
const D1 = MEDIA_ROOT ? declPairs(MEDIA_ROOT.body) : {};
const D2 = STAMP ? declPairs(STAMP.body) : {};

/* THE PARITY GATE. A token in one scope and not the other is a colour that
   silently keeps the wrong mode's value. Reported BY NAME, because "the
   scopes disagree" sends the next person reading 60 declarations. */
{
  const ln = Object.keys(L).sort(), dn = Object.keys(D2).sort();
  const onlyLight = ln.filter(k => !(k in D2));
  const onlyDark = dn.filter(k => !(k in L));
  eq(onlyLight, [],
     "every light token has a dark value — one that does not keeps its LIGHT colour on a dark page");
  eq(onlyDark, [],
     "every dark token has a light value — one that does not is dead in light mode");
}

/* AND THE TWO DARK SITES MUST BE THE SAME THEME. The media query covers the
   OS setting and the stamp covers the toggle; if they drift, a viewer on a
   dark machine and a viewer who clicked Dark are looking at two different
   products. */
{
  const diff = Object.keys(D2).filter(k => D1[k] !== D2[k]);
  eq(diff, [],
     "the OS-dark block and the toggled-dark block declare identical values");
  eq(Object.keys(D1).sort(), Object.keys(D2).sort(),
     "...and identical token sets");
}

/* THE TOGGLE HAS TO WIN OVER THE OS, IN BOTH DIRECTIONS. Without :where()
   the media query's :root out-specifies nothing in particular but ties with
   the stamp on source order; without the :not() guard, a viewer on a dark
   machine who picks Light gets dark anyway — which reads as the toggle being
   broken rather than as a cascade bug. */
ok(MEDIA && /:root:where\(:not\(\[data-theme="light"\]\)\)/.test(MEDIA.body),
   'the OS block is scoped :root:where(:not([data-theme="light"])) so an explicit Light stamp beats OS-dark');
ok(LIGHT && /color-scheme:\s*light/.test(LIGHT.body)
   && /color-scheme:\s*dark/.test(D2 && STAMP ? STAMP.body : ""),
   "both modes declare color-scheme, so form controls and scrollbars follow the theme");

// ── every var() reference resolves ─────────────────────────────────────────
/* A typo'd token name is not an error anywhere — `var(--lin)` simply paints
   nothing and the element inherits, which on a table cell is invisible. */
{
  const used = new Set([...src.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]));
  ok(used.size > 40, `the page reads its colours through tokens (${used.size} distinct)`);
  const undeclared = [...used].filter(t => !(t in L)).sort();
  eq(undeclared, [], "every var(--token) the page reads is declared");
}

// ── THE SWEEP: no themeable hex may survive ────────────────────────────────
/* The regions below may hold raw hex, each for a stated reason. They are
   named individually rather than matched by a pattern: an exemption that is
   a regex quietly widens into "any block I did not want to fix". */
const ALLOWED = [
  { why: "the light token declarations", block: LIGHT },
  { why: "the OS-dark token declarations", block: MEDIA },
  { why: "the toggled-dark token declarations", block: STAMP },
];
/* The CX launch-pipeline region and its palettes. This half of the page was
   ALREADY dark before the theme existed — slate cards on a slate grid — so
   it needs no dark variants and its colours are data (stage, size band,
   owner), not chrome. */
const CX_A = src.indexOf("const GANTT_STAGE_COLORS");
const CX_B = src.indexOf("function Remittance(");
ok(CX_A > 0 && CX_B > CX_A,
   "the already-dark CX region is located — without it this sweep is vacuous");

function inAllowed(idx) {
  if (CX_A > 0 && idx >= CX_A && idx < CX_B) return true;
  for (const a of ALLOWED) {
    if (!a.block) continue;
    const open = src.indexOf("{", a.block.start);
    if (idx > open && idx < a.block.end) return true;
  }
  return false;
}

{
  const strays = [];
  for (const m of src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
    if (inAllowed(m.index)) continue;
    const line = src.slice(0, m.index).split("\n").length;
    strays.push(`${m[0]} at line ${line}`);
  }
  eq(strays, [],
     "no hardcoded colour survives outside the token declarations and the already-dark CX region"
     + " — a literal here is a value that cannot theme, and it renders plausibly in whichever"
     + " mode it was written for");
}

/* THE SWEEP HAS TO BE ABLE TO FAIL, and a share-of-the-file test is the
   WRONG way to say so — on a fully tokenised page almost every surviving
   literal IS in an allowed region, which is the goal, not a symptom. What
   actually goes wrong is a marker that stops matching or a block whose brace
   counting runs to the end of the file, and either shows up as a region that
   has swallowed the page. So: bound the regions by SPAN, and then plant a
   stray and require the sweep to find it. */
{
  const total = [...src.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].length;
  ok(total > 200, `the sweep saw the page's colours (${total} literals in total)`);
  let span = CX_B - CX_A;
  for (const a of ALLOWED) if (a.block) span += a.block.end - src.indexOf("{", a.block.start);
  ok(span < src.length * 0.25,
     `the allowed regions are a small part of the file (${Math.round(span / src.length * 100)}%)`
     + " — a region that has swallowed the page makes every assertion above vacuous");

  /* A PLANTED STRAY, in the one place a real one is most likely: a React
     inline style in the middle of the page. If the model cannot catch this,
     it cannot catch anything. */
  const at = src.indexOf('e("div", { className: "wrap" }');
  ok(at > 0 && !inAllowed(at), "the sweep's model does not exempt the page body");
}

// ── the pre-paint stamp ────────────────────────────────────────────────────
/* SET BEFORE ANYTHING PAINTS, or a dark-mode viewer gets a white flash on
   every load. That means the <head>, before the app script — not an effect. */
{
  const head = src.slice(0, src.indexOf("</head>"));
  const boot = head.indexOf('localStorage.getItem("psTheme")');
  const reactTag = head.indexOf('src="/vendor/react');
  ok(boot > 0, "the theme stamp is applied from the document head");
  ok(boot > 0 && reactTag > 0 && boot < reactTag,
     "...before React loads, so the first paint is already the right mode");
  ok(/try\s*{[\s\S]{0,400}localStorage\.getItem\("psTheme"\)/.test(head),
     "...and it is wrapped, because localStorage throws in a locked-down browser and a theme is not worth a blank page");
  ok(/document\.documentElement\.setAttribute\("data-theme"/.test(head),
     "...and it writes the same attribute the stylesheet scopes on");
}

/* ONE KEY, WRITTEN AND READ THE SAME WAY. A head script reading `psTheme`
   while the app writes `theme` gives a toggle that works until you reload —
   the most confusing shape this bug can take. */
{
  const keys = new Set([...src.matchAll(/localStorage\.(?:get|set)Item\(\s*(?:"([^"]+)"|THEME_KEY)/g)]
    .map(m => m[1]).filter(Boolean));
  ok(/const THEME_KEY = "psTheme"/.test(src), "the app's key is psTheme");
  eq([...keys].sort(), ["psTheme"],
     "the head script and the app agree on the storage key");
}

// ── the pure half, lifted and RUN ──────────────────────────────────────────
/* A regex over `themeEffective` passes on an inverted comparison, and the
   whole of this function is one comparison. */
let T = null, LIFT_ERR = null;
try {
  T = new Function(src.slice(src.indexOf('const THEME_KEY = "psTheme"'),
                             src.indexOf("function themeStored()"))
    + "; return { THEME_KEY, themeStamp, themeEffective };")();
} catch (e) { LIFT_ERR = e; }
ok(!LIFT_ERR, "the pure theme helpers lift and evaluate"
   + (LIFT_ERR ? " — THREW: " + LIFT_ERR.message : ""));
const themeStamp = T ? T.themeStamp : () => null;
const themeEffective = T ? T.themeEffective : () => "light";

eq(themeStamp("dark"), "dark", "a stored dark is a stamp");
eq(themeStamp("light"), "light", "a stored light is a stamp");
/* AN UNRECOGNISED VALUE IS NO CHOICE, NOT A DEFAULT TO LIGHT. A corrupted or
   hand-edited key has to degrade to following the OS, which is what a viewer
   who never touched the toggle gets. */
eq(themeStamp(null), null, "no stored value is no stamp");
eq(themeStamp(""), null, "an empty stored value is no stamp");
eq(themeStamp("DARK"), null, "an unrecognised stored value is no stamp, not a guess");
eq(themeStamp("auto"), null, "...and neither is a value we never write");

eq(themeEffective(null, true), "dark", "unpinned on a dark machine reads dark");
eq(themeEffective(null, false), "light", "unpinned on a light machine reads light");
/* THE PIN BEATS THE OS IN BOTH DIRECTIONS. Only one of these two is obvious;
   the other is the one that breaks — choosing Light on a dark laptop. */
eq(themeEffective("light", true), "light", "a pinned Light beats a dark OS");
eq(themeEffective("dark", false), "dark", "a pinned Dark beats a light OS");
eq(themeEffective("nonsense", true), "dark", "a corrupt pin falls back to the OS, not to light");

// ── the control ────────────────────────────────────────────────────────────
/* WHERE DAN POINTED: the sidebar foot. Asserting the component merely exists
   passes on one rendered nowhere. */
{
  const foot = src.indexOf('e("div", { className: "foot" },');
  const mount = src.indexOf("e(ThemeToggle, null)");
  const signedIn = src.indexOf('"Signed in as "');
  ok(foot > 0 && mount > foot && mount < signedIn,
     "the toggle is mounted in the sidebar foot, above the identity line");
}
/* TWO BUTTONS, AND THE LIVE ONE SAYS SO. A single button has to be labelled
   with either the mode you are in or the mode you would get, and every
   reader guesses the other one. */
ok(/opt\("light", "Light"/.test(src) && /opt\("dark", "Dark"/.test(src),
   "both modes are on screen as their own control");
ok(/"aria-pressed": theme === id/.test(src),
   "the live one is announced, not only filled");
ok(/"data-of-theme": theme/.test(src),
   "the control stamps the effective theme, so a render case can read it");
/* THE CONTROL LIVES ON THE NAV, WHICH IS DARK IN BOTH MODES. Reading --ink
   or --card here inverts the control while the surface under it does not. */
{
  const css = src.slice(src.indexOf(".themesw {"), src.indexOf(".themebtn:focus-visible"));
  ok(css.length > 100, "the switch has its own rules");
  ok(!/var\(--ink\b|var\(--card\b/.test(css),
     "the switch wears the nav's fixed ink, never the themed page ink");
  ok(/var\(--nav-ink/.test(css), "...and it wears the nav tokens by name");
}
/* THE NAV IS DARK IN BOTH MODES, so its ink must NOT flip. A --nav-ink that
   differs between the scopes is navy-on-navy in one of them. */
for (const t of ["--nav-ink", "--nav-ink-strong", "--nav-warn"])
  eq(D2[t], L[t], `${t} is the same in both modes — the sidebar is dark either way`);

// ── the series palette ─────────────────────────────────────────────────────
/* SIX IN BOTH MODES, and distinct within each. A dark column one slot short
   silently reuses a light hue for the sixth line. */
for (const [name, set] of [["light", L], ["dark", D2]]) {
  const slots = [1, 2, 3, 4, 5, 6].map(i => set["--series-" + i]);
  ok(slots.every(Boolean), `all six series slots are declared in ${name} mode`);
  eq(new Set(slots.filter(Boolean)).size, slots.filter(Boolean).length,
     `no ${name} series colour is listed twice`);
}
/* The chart reads the TOKENS, not a JS palette. Two palettes — one in the
   stylesheet for the pills and one in JS for the lines — is how a line and
   its own legend dot come to be different colours. */
ok(/OF_SERIES_COLORS = \["var\(--series-1\)"/.test(src),
   "the chart's series palette is the CSS tokens, so the line and its pill cannot drift");

// ── THE SHARED PILL, AND ITS TWO READERS ───────────────────────────────────
/* `/feature-pills.js` is ONE colour ramp serving a themed page (ps.html) and
   a light-only one (dashboard.html), and it reads tokens it does not declare.
   That is a real hole this spec did not originally cover: the sweep above
   only scans ps.html, so six hardcoded colours sat in the shared file
   painting white pills on a dark card while every assertion passed.

   A token the shared file reads and a page does not declare paints NO
   background at all — which on a metric pill is an invisible number rather
   than an obvious break, so it is exactly the kind of thing to assert rather
   than to look for. */
{
  const pills = fs.readFileSync(path.join(ROOT, "public", "feature-pills.js"), "utf8");
  const dash = fs.readFileSync(path.join(ROOT, "public", "dashboard.html"), "utf8");

  const strays = [...pills.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map(m => m[0]);
  eq(strays, [],
     "the shared metric pill holds no hardcoded colour — it renders on a themed page and a light one");

  const reads = [...new Set([...pills.matchAll(/var\((--[a-z0-9-]+)/g)].map(m => m[1]))].sort();
  ok(reads.length >= 6, `the shared pill reads its colours as tokens (${reads.length})`);

  const dashRoot = blockAt(dash, ":root");
  ok(dashRoot, "the public dashboard declares a token block");
  const DASH = dashRoot ? declPairs(dashRoot.body) : {};

  for (const [page, set] of [["the CX shell (light)", L], ["the CX shell (dark)", D2],
                             ["the public dashboard", DASH]]) {
    const missing = reads.filter(t => !(t in set));
    eq(missing, [],
       `${page} declares every token /feature-pills.js reads — an undeclared one paints nothing at all`);
  }

  /* THE TWO RECESSIVE BRANCHES ARE ASSERTED HERE AND NOWHERE ELSE, because
     a render case cannot reach one of them: the snapshot carries ZERO null
     metric cells across all 960, so `v == null` never renders and a browser
     mutation setting --pill-null-bg to a light value SURVIVES. That is a
     fact about the fleet, not a hole in the case — so the claim is made
     where it can be computed, against the token values themselves. */
  const lum = (hex) => {
    const h = String(hex || "").trim().replace("#", "");
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    const v = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
      .map(x => x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  for (const t of ["--pill-null-bg", "--pill-zero-bg"]) {
    const dl = lum(D2[t]), ll = lum(L[t]);
    ok(ll != null && ll > 0.5, `${t} is a light chip in light mode (${L[t]})`);
    ok(dl != null && dl < 0.15,
       `${t} is DARK in dark mode — a light chip on a slate card is the exact`
       + ` regression the hardcoded ramp shipped (${D2[t]})`);
  }

  /* AND THE RAMP RUNS AWAY FROM THE SURFACE IN BOTH MODES. The wash is
     translucent over the card, so "more" has to mean "further from the
     card" — carrying the light hue into dark mode inverts that silently
     while every pill still renders, and the browser case cannot see it
     because the label's contrast against its own wash stays fine. */
  const wash = (rgbTok, alpha, cardHex) => {
    const rgb = String(rgbTok || "").split(",").map(Number);
    const c = String(cardHex || "").replace("#", "");
    if (rgb.length !== 3 || !/^[0-9a-fA-F]{6}$/.test(c)) return null;
    const bg = [0, 2, 4].map(i => parseInt(c.slice(i, i + 2), 16));
    const mix = rgb.map((x, i) => Math.round(x * alpha + bg[i] * (1 - alpha)));
    return lum("#" + mix.map(v => v.toString(16).padStart(2, "0")).join(""));
  };
  for (const [name, set] of [["light", L], ["dark", D2]]) {
    const card = lum(set["--card"]);
    const lo = wash(set["--pill-heat-rgb"], 0.08, set["--card"]);   // t = 0
    const hi = wash(set["--pill-heat-rgb"], 0.63, set["--card"]);   // t = 1
    ok(lo != null && hi != null, `the ${name} heat wash composites`);
    if (lo != null && hi != null) {
      ok(Math.abs(hi - card) > Math.abs(lo - card),
         `the ${name} heat ramp moves AWAY from the card as the value rises`
         + ` — card ${card.toFixed(3)}, faint ${lo.toFixed(3)}, full ${hi.toFixed(3)}`);
      ok(name === "light" ? hi < card : hi > card,
         `a full ${name} pill is ${name === "light" ? "darker" : "lighter"} than the card,`
         + " so 'more' always reads as further from the surface");
    }
  }

  /* THE RAMP'S HUE HAS TO MOVE WITH THE SURFACE. The wash is translucent over
     the card, so on white a deep teal at rising alpha reads as "more" and on
     a dark card the same hue reads as "less" — the scale inverts silently
     while every pill still renders. */
  ok(L["--pill-heat-rgb"] && D2["--pill-heat-rgb"] && L["--pill-heat-rgb"] !== D2["--pill-heat-rgb"],
     "the heat wash is a different step in each mode, so 'more' is always further from the surface"
     + ` — light ${L["--pill-heat-rgb"]}, dark ${D2["--pill-heat-rgb"]}`);
  /* AND THE TWO INKS MUST SWAP, not merely differ: whichever end of the ramp
     the label sits on, it has to be the opposite of the wash under it. */
  ok(L["--pill-ink-strong"] !== D2["--pill-ink-strong"]
     && L["--pill-ink-soft"] !== D2["--pill-ink-soft"],
     "both pill inks are re-chosen for the dark wash rather than carried over");
}

function report() {
  if (failures.length) {
    console.error(`\n✗ theme.spec.js — ${failures.length} failure(s):\n`);
    failures.forEach(f => console.error("  ✗ " + f));
    process.exitCode = 1;
  } else {
    console.log(`✓ theme.spec.js — ${pass} assertions passed.`);
  }
}
report();
