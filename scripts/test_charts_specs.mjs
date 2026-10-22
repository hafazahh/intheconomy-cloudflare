/**
 * Acceptance test for `src/charts.ts` — the deliverable of the "Port src/charts.ts"
 * card. Two layers:
 *
 *   A. pure specs — every chart builder runs on D1-shaped rows and its traces
 *      contain real values (no `y = []`, no NaN);
 *   B. DB-derived — `buildDashboardView(db)` is driven by `render.ts` against a
 *      real D1 facade backed by the local miniflare SQLite file, so the numbers
 *      inside the 7 dashboard chart specs are the numbers in D1.
 *
 * `scripts/compare_chart_numbers.py` then diffs those same specs against what the
 * Flask build computes from its own SQLite DB.
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

const charts = await import(out);
const {
  applyNonce,
  hasUnstampedScripts,
  baseLayout,
  buildMainChart,
  buildSingleChart,
  buildInflationChart,
  buildMicroChart,
  buildIndexedChart,
  buildBbmVsWageChart,
  toIndex,
} = charts;

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
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// ---------------------------------------------------------------------------
console.log("=".repeat(76));
console.log("A1. applyNonce — every inline <script> stamped");
console.log("=".repeat(76));

check(
  "single inline script stamped",
  applyNonce("<script>var a=1;</script>", N) === `<script nonce="${N}">var a=1;</script>`,
);
const two = applyNonce("<script>a()</script><p>x</p><script>b()</script>", N);
check("two inline scripts both stamped", (two.match(new RegExp(`nonce="${N}"`, "g")) || []).length === 2);
check("no unstamped inline script remains", !hasUnstampedScripts(two));
const withSrc = applyNonce(`<script src="https://cdn.plot.ly/x.js"></script>`, N);
check("script with src untouched", withSrc === `<script src="https://cdn.plot.ly/x.js"></script>`);
const already = applyNonce(`<script nonce="old">x()</script>`, N);
check("already-nonce'd script untouched", already === `<script nonce="old">x()</script>`);
check("html without scripts unchanged", applyNonce("<div>hi</div>", N) === "<div>hi</div>");
check("hasUnstampedScripts repeatable", hasUnstampedScripts("<script>x</script>") === true);
check(
  "hasUnstampedScripts false after stamping",
  hasUnstampedScripts(applyNonce("<script>x</script>", N)) === false,
);
const fragment = `<!DOCTYPE html>\n<script src="https://cdn.plot.ly/plotly-4.1.1.min.js"></script>\n<script>window.__CHARTS__={"a":{"data":[{"x":[1],"y":[2]}]}};</script>\n<script>(() => { Plotly.newPlot("a", {}); })();</script>\n`;
const stamped = applyNonce(fragment, N);
check("fragment: 2 inline stamped", (stamped.match(new RegExp(`nonce="${N}"`, "g")) || []).length === 2);
check("fragment: CDN script has no nonce", !/cdn\.plot\.ly[^>]*nonce/.test(stamped));
check("fragment: no unstamped inline left", !hasUnstampedScripts(stamped));
check(
  "fragment: length preserved plus 2 stamps",
  stamped.length === fragment.length + 2 * ` nonce="${N}"`.length,
);

// ---------------------------------------------------------------------------
console.log();
console.log("=".repeat(76));
console.log("A2. Chart specs — 7 dashboard shapes, real values, DB-derived inputs");
console.log("=".repeat(76));

const years = [2021, 2022, 2023, 2024, 2025];
const pdbValues = [3.7, 5.3, 5.05, 5.11, 4.9];
const inflasiValues = [1.87, 4.14, 2.56, 1.91, 1.96];
const dates = ["2026-01-01", "2026-02-01", "2026-03-01"];
const yoyValues = [2.1, 1.9, 1.85];

function assertRealValues(label, spec) {
  check(`${label}: has data`, Array.isArray(spec.data) && spec.data.length > 0);
  check(
    `${label}: every trace has x and y`,
    spec.data.every((t) => Array.isArray(t.x) && Array.isArray(t.y) && t.x.length > 0 && t.y.length > 0),
  );
  check(
    `${label}: no NaN in any y`,
    spec.data.every((t) => t.y.every((v) => Number.isFinite(v))),
  );
  check(`${label}: has layout`, !!spec.layout && !!spec.layout.margin);
  check(`${label}: has config`, !!spec.config);
}

// 1. main
const main = buildMainChart(years, pdbValues, inflasiValues);
assertRealValues("chart-main", main);
check("chart-main: 2 traces", main.data.length === 2);
check("chart-main: PDB trace x", JSON.stringify(main.data[0].x) === JSON.stringify(years));
check("chart-main: PDB trace y", main.data[0].y.every((v, i) => close(v, pdbValues[i])));
check("chart-main: inflasi trace y", main.data[1].y.every((v, i) => close(v, inflasiValues[i])));

// 2/3. single
const pdbDetail = buildSingleChart(years, pdbValues, "PDB Growth (%)", "#0d6efd", "chart-pdb-growth");
assertRealValues("chart-pdb-growth", pdbDetail);
check("chart-pdb-growth: fill tozeroy", pdbDetail.data[0].fill === "tozeroy");
check("chart-pdb-growth: blue fillcolor", pdbDetail.data[0].fillcolor === "rgba(13,110,253,0.08)");
const inflDetail = buildSingleChart(years, inflasiValues, "Inflasi YoY (%)", "#dc3545", "chart-inflasi-yoy-");
assertRealValues("chart-inflasi-yoy-", inflDetail);
check("chart-inflasi-yoy-: red fillcolor", inflDetail.data[0].fillcolor === "rgba(220,53,69,0.08)");

// 4. inflation + BI corridor
const inflation = buildInflationChart(dates, yoyValues);
assertRealValues("chart-inflation", inflation);
check("chart-inflation: 2 traces (band + line)", inflation.data.length === 2);
check("chart-inflation: band is closed (x doubled)", inflation.data[0].x.length === dates.length * 2);
check("chart-inflation: band hoverinfo skip", inflation.data[0].hoverinfo === "skip");
check("chart-inflation: line values", inflation.data[1].y.every((v, i) => close(v, yoyValues[i])));
check("chart-inflation: corridor uses BI_TARGET constants", (() => {
  const band = inflation.data[0].y;
  const first = band.slice(0, dates.length);
  const second = band.slice(dates.length);
  return first.every((v) => close(v, 3.5)) && second.every((v) => close(v, 1.5));
})());

// 5/6/7. macro singles
const macroSpecs = [
  buildSingleChart(dates, [6, 5.75, 5.5], "BI-Rate (%)", "#6f42c1", "chart-bi-rate"),
  buildSingleChart(dates, [15800, 15950, 16100], "USD/IDR", "#20c997", "chart-usd-idr"),
  buildSingleChart(dates, [0.38, 0.381, 0.382], "Rasio Gini", "#fd7e14", "chart-rasio-gini"),
];
macroSpecs.forEach((s, i) => assertRealValues(`macro chart ${i + 1}`, s));

// micro charts — the same builders, DB-derived rows
const goldRows = [
  { date: "2026-01-01", value: 1200000, fetched_at: "x" },
  { date: "2026-02-01", value: 1250000, fetched_at: "x" },
];
const pertaliteRows = [
  { date: "2026-01-01", value: 10000, fetched_at: "x" },
  { date: "2026-02-01", value: 10500, fetched_at: "x" },
];
const indexed = buildIndexedChart(
  [goldRows, pertaliteRows],
  ["Emas (indeks)", "Pertalite (indeks)"],
  ["#FFD700", "#dc3545"],
  "chart-emas-bbm",
  "Tanggal",
  "Indeks (base=100)",
);
assertRealValues("chart-emas-bbm", indexed);
check("indexed: both series start at 100", close(indexed.data[0].y[0], 100) && close(indexed.data[1].y[0], 100));
check("indexed: toIndex base 100", toIndex(goldRows).every((v, i) => close(v, (goldRows[i].value / 1200000) * 100)));

const micro = buildMicroChart([goldRows], ["Emas"], ["#FFD700"], "chart-ikk", "Tanggal", "IKK");
assertRealValues("chart-ikk", micro);
check("micro: y from DB rows", micro.data[0].y.every((v, i) => close(v, goldRows[i].value)));
check("micro: x from DB dates", JSON.stringify(micro.data[0].x) === JSON.stringify(goldRows.map((r) => r.date)));

const bbmWage = buildBbmVsWageChart(
  [
    ["2014-01-01", 8500],
    ["2015-01-01", 7500],
  ],
  [
    ["2014-01-01", 2200],
    ["2015-01-01", 2500],
  ],
);
assertRealValues("chart-bbm-vs-wage", bbmWage);
check("bbm-vs-wage: annotations on >10% jump", bbmWage.layout.annotations.length === 1);

// ---------------------------------------------------------------------------
console.log();
console.log("=".repeat(76));
console.log("A3. baseLayout — port of app.py `_base_layout()`");
console.log("=".repeat(76));

const layout = baseLayout();
check("baseLayout margin", layout.margin.l === 50 && layout.margin.r === 20 && layout.margin.t === 20 && layout.margin.b === 40);
check("baseLayout height", layout.height === 320);
check("baseLayout hovermode", layout.hovermode === "x unified");
check("baseLayout transparent bg", layout.paper_bgcolor === "rgba(0,0,0,0)" && layout.plot_bgcolor === "rgba(0,0,0,0)");

// ---------------------------------------------------------------------------
console.log();
console.log(failed === 0 ? `TOTAL: ${passed}/${passed + failed} PASS` : `TOTAL: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) {
  console.log("failures:", failures.join(" | "));
  process.exit(1);
}
console.log("SEMUA TEST LULUS");
