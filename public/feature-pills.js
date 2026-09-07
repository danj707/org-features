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
 * so it hangs one global off window and nothing else. */
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
    if (v == null) return { background: "#f8fafc", color: "#94a3b8" };
    if (v === 0)   return { background: "#fff", color: "#cbd5e1" };
    const t = Math.log(1 + v) / Math.log(1 + (max || 1));
    const alpha = 0.08 + t * 0.55;
    return {
      background: "rgba(15,111,92," + alpha.toFixed(3) + ")",
      color: t > 0.6 ? "#fff" : "#0f3d33",
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
