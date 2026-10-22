/**
 * Acceptance test for `applyNonce` / `hasUnstampedScripts` in src/charts.ts.
 * Bundles the real module with esbuild and drives the exported helpers.
 */
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(mkdtempSync(join(tmpdir(), "charts-test-")), "charts.mjs");
await build({
  entryPoints: ["src/charts.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: out,
  logLevel: "silent",
});
const { applyNonce, hasUnstampedScripts } = await import(out);

let passed = 0;
let failed = 0;
const failures = [];

function check(label, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`[PASS] ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`[FAIL] ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const N = "nonce-ABC-123";

// 1. one inline script gets stamped
check(
  "single inline script stamped",
  applyNonce("<script>var a=1;</script>", N) === `<script nonce="${N}">var a=1;</script>`,
);

// 2. two inline scripts both stamped
const two = applyNonce("<script>a()</script><p>x</p><script>b()</script>", N);
check("two inline scripts both stamped", (two.match(new RegExp(`nonce="${N}"`, "g")) || []).length === 2);
check("no unstamped inline script remains", !hasUnstampedScripts(two));

// 3. src= is not stamped
const withSrc = applyNonce(`<script src="https://cdn.plot.ly/x.js"></script>`, N);
check("script with src untouched", withSrc === `<script src="https://cdn.plot.ly/x.js"></script>`);

// 4. already-nonce'd script is not stamped twice
const already = applyNonce(`<script nonce="old">x()</script>`, N);
check("already-nonce'd script untouched", already === `<script nonce="old">x()</script>`);

// 5. case-insensitive tag name + attribute order
// The replacement text is a literal lowercase `<script nonce="…"` — identical to
// `app.py`'s `_INLINE_SCRIPT_RE.sub(f'<script nonce="{nonce}"', html)`, which also
// lowercases the tag name. The expectation must match the Python behaviour, not
// the prettier "preserve the original case" version: parity is the requirement.
check(
  "uppercase SCRIPT stamped (lowercased, matching app.py re.sub)",
  applyNonce("<SCRIPT>a()</SCRIPT>", N) === `<script nonce="${N}">a()</SCRIPT>`,
);
check(
  "nonce after other attributes",
  applyNonce(`<script type="text/javascript">a()</script>`, N) ===
    `<script nonce="${N}" type="text/javascript">a()</script>`,
);
check(
  "src with surrounding attributes untouched",
  applyNonce(`<script type="module" src="/a.js"></script>`, N) ===
    `<script type="module" src="/a.js"></script>`,
);

// 6. no script at all is a no-op
check("html without scripts unchanged", applyNonce("<div>hi</div>", N) === "<div>hi</div>");

// 7. regex state: hasUnstampedScripts must be repeatable (global regex lastIndex)
check("hasUnstampedScripts repeatable (true)", hasUnstampedScripts("<script>x</script>") === true);
check("hasUnstampedScripts repeatable (true again)", hasUnstampedScripts("<script>x</script>") === true);
check("hasUnstampedScripts false after stamping", hasUnstampedScripts(applyNonce("<script>x</script>", N)) === false);

// 8. realistic dashboard fragment: payload + bootstrap stamped, CDN script left alone
const fragment = `<!DOCTYPE html>
<script src="https://cdn.plot.ly/plotly-4.1.1.min.js"></script>
<script>window.__CHARTS__={"a":{"data":[{"x":[1],"y":[2]}]}};</script>
<script>(() => { Plotly.newPlot("a", {}); })();</script>
`;
const stamped = applyNonce(fragment, N);
check("fragment: 2 inline stamped", (stamped.match(new RegExp(`nonce="${N}"`, "g")) || []).length === 2);
check("fragment: CDN script has no nonce", !/cdn\.plot\.ly[^>]*nonce/.test(stamped));
check("fragment: no unstamped inline left", !hasUnstampedScripts(stamped));
check("fragment: original length preserved plus 2 stamps", stamped.length === fragment.length + 2 * ` nonce="${N}"`.length);

console.log();
console.log(failed === 0 ? `TOTAL: ${passed}/${passed + failed} PASS` : `TOTAL: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) {
  console.log("failures:", failures.join(" | "));
  process.exit(1);
}
console.log("SEMUA TEST LULUS");
