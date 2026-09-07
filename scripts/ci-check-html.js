/**
 * Every inline <script> in public/*.html must parse.
 *
 * WHY: both dashboards are one large `text/babel` block inside an HTML file.
 * A syntax error there is invisible to `node --check` (the file is HTML), the
 * server still returns 200 with a complete document, and the page renders a
 * blank white screen. The sibling project shipped that to production twice
 * before adding this check.
 */
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "public");
let babel = null;
try { babel = require("@babel/parser"); } catch { /* fall back below */ }

let blocks = 0, files = 0, failed = 0;
for (const name of fs.readdirSync(DIR)) {
  if (!name.endsWith(".html")) continue;
  files++;
  const html = fs.readFileSync(path.join(DIR, name), "utf8");
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || "";
    const code  = m[2] || "";
    if (/\bsrc\s*=/.test(attrs)) continue;      // external, nothing inline to parse
    if (!code.trim()) continue;
    blocks++;
    const isJsx = /text\/babel/.test(attrs);
    try {
      if (isJsx) {
        if (babel) babel.parse(code, { sourceType: "script", plugins: ["jsx"] });
        else {
          /* NO BABEL PARSER INSTALLED. Rather than silently pass — which is
             the warm-cache sign-off mistake — say so and check what can be
             checked: an unbalanced brace/paren count is a crude but real
             signal on a hand-edited block. */
          const bal = (s, a, b) => (s.split(a).length - s.split(b).length);
          if (bal(code, "{", "}") !== 0 || bal(code, "(", ")") !== 0)
            throw new Error("unbalanced braces or parens (no @babel/parser installed for a full parse)");
        }
      } else {
        new Function(code);
      }
    } catch (e) {
      failed++;
      console.error(`✗ ${name}: inline ${isJsx ? "JSX" : "JS"} block failed to parse — ${e.message}`);
    }
  }
}
if (!blocks) { console.error("✗ no inline script blocks found — this check would be vacuous"); process.exit(1); }
if (failed) process.exit(1);
console.log(`✓ ${blocks} inline block(s) across ${files} HTML file(s) parse${babel ? "" : " (brace-balance only — @babel/parser not installed)"}`);
