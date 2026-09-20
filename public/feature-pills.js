/* The heat-coloured metric pill, shared by the standalone Org Features
   dashboard (dashboard.html) and the same view inside the CX dashboard
   shell (ps.html).
 *
 * ONE SCALE, TWO READERS, and that is the whole reason this file exists. The
 * two pages show the same orgs and the same numbers; a second copy of the
 * colour ramp drifts the first time either is touched, and then one org reads
 * "busy" on one page and "quiet" on the other for the same figure. Same rule
 * this codebase applies to reducers with more than one caller.
 *
 * Loaded as a plain script (no modules — these pages are Babel-in-browser),
 * so it hangs one global off window and nothing else.
 *
 * IT READS TOKENS IT DOES NOT DECLARE, and both readers must carry them:
 * --pill-null-bg/-ink, --pill-zero-bg/-ink, --pill-heat-rgb and
 * --pill-ink-strong/-soft. That is the cost of one ramp serving a themed page
 * and a light-only one; the alternative is a copy per page, which is the drift
 * this file exists to prevent. theme.spec.js asserts both pages declare every
 * token this file reads — a missing one paints no background at all, which on
 * a metric pill is an invisible number rather than an obvious break. */
(function (w) {
  "use strict";

  // LOG scale, not linear. Apex has 94,166 registrations against a fleet
  // median in the low thousands, so a linear ramp paints one org dark and
  // every other org indistinguishably pale — the column stops being readable
  // as a comparison, which is the only thing it is for.
  function heat(v, max) {
    // Three states, deliberately distinct. "Not measured" and "measured as
    // zero" are different facts (the absent-is-not-zero rule), so a null gets
    // the grey ground and a real 0 gets white.
    if (v == null) return { background: "var(--pill-null-bg)", color: "var(--pill-null-ink)" };
    if (v === 0)   return { background: "var(--pill-zero-bg)", color: "var(--pill-zero-ink)" };
    const t = Math.log(1 + v) / Math.log(1 + (max || 1));
    const alpha = 0.08 + t * 0.55;
    return {
      /* THE WASH IS TRANSLUCENT OVER THE CARD, so the ramp keeps its shape in
         either theme without a second ramp to maintain — but the HUE has to
         move with the surface or the direction of the scale inverts. On white
         a deep teal at rising alpha reads as "more"; on a dark card the same
         hue reads as "less", because it is closer to the ground than the card
         is. `--pill-heat-rgb` is the light teal in dark mode for exactly that
         reason, so higher always means further from the surface. */
      background: "rgba(var(--pill-heat-rgb)," + alpha.toFixed(3) + ")",
      /* The ink flips at the same point in both modes, but which of the two
         is "strong" swaps with the surface: on a saturated wash the label
         needs the far end of the ramp, and which end that is depends on the
         theme. Two tokens rather than two branches. */
      color: t > 0.6 ? "var(--pill-ink-strong)" : "var(--pill-ink-soft)",
      fontWeight: 600,
    };
  }

  // Column maxima drive the ramp, so each metric is scaled against its own
  // column rather than against the largest number on the page.
  function columnMaxes(rows, keys, pick) {
    const m = {};
    keys.forEach(k => {
      let max = 0;
      rows.forEach(r => {
        const v = Number(pick(r, k));
        if (isFinite(v) && v > max) max = v;
      });
      m[k] = max;
    });
    return m;
  }

  function fmtNum(v) {
    return v == null ? "—" : Number(v).toLocaleString("en-US");
  }

  w.RecPills = { heat, columnMaxes, fmtNum };
})(window);
