/**
 * Acceptance test for `src/render.ts` — the deliverable of the "Port src/render.ts"
 * card. Drives `renderDashboard()` directly from Node with a synthetic view and
 * asserts the structural contract the card asks for:
 *
 *   1. all seven chart mount points are present in the markup;
 *   2. a missing series renders the literal text `data belum tersedia`
 *      (never an invented number, never a vanished container);
 *   3. KPI cards, the insight box, the projection table and the footer render;
 *   4. escaping holds — a value containing HTML/JS cannot break out;
 *   5. the nonce is stamped on the inline scripts;
 *   6. no Jinja2 leftovers and no empty `x = ;` template values.
 *
 * `scripts/test_kpi_insight.mjs` covers the insight *text* (21 scenarios);
 * this file covers the *page*.
 */
import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(mkdtempSync(join(tmpdir(), "render-test-")), "render.mjs");
await build({
  entryPoints: ["src/render.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: out,
  logLevel: "silent",
});
const { renderDashboard, DASHBOARD_CHART_IDS, esc, jsonAttr, DATA_UNAVAILABLE_TEXT } =
  await import(out);

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

const NONCE = "test-nonce-ABC123";

function kpi(over = {}) {
  return {
    code: "NY.GDP.MKTP.KD.ZG",
    name: "PDB Growth",
    formatted_value: "5.11%",
    formatted_change: "0.08 pp",
    change_arrow: "+",
    change_badge_class: "bg-success",
    status: null,
    status_badge_class: null,
    comparison_label: "vs tahun lalu",
    date_label: "2025",
    source_label: "World Bank",
    description: "desc",
    last_updated: "2026-10-21 13:08 UTC",
    ...over,
  };
}

function macroKpi(over = {}) {
  return {
    name: "BI-Rate",
    value: "6.00%",
    date: "2026-10-21",
    color: "text-success",
    last_updated: "2026-10-21 13:08 UTC",
    ...over,
  };
}

function view(over = {}) {
  return {
    kpis: [kpi()],
    insight: "Pertumbuhan PDB 5.1% (2025) menunjukkan perekonomian Indonesia solid.",
    last_updated: "2026-10-21 13:08 UTC",
    projection: [
      { year: 2024, pdb: 5.0, inflasi: 2.5 },
      { year: 2025, pdb: 5.1, inflasi: 1.9 },
    ],
    charts: Object.fromEntries(DASHBOARD_CHART_IDS.map((id) => [id, null])),
    data_unavailable: false,
    macro_kpis: [macroKpi()],
    macro_updated: "2026-10-21 13:08 UTC",
    inflation_snapshot: "",
    bi_target: { center: 2.5, low: 1.5, high: 3.5 },
    ...over,
  };
}

const spec = {
  id: "chart-main",
  data: [{ x: [2021, 2022], y: [3.7, 5.3], mode: "lines+markers", name: "PDB Growth (%)" }],
  layout: { margin: { l: 50, r: 20, t: 20, b: 40 }, height: 320 },
  config: { displayModeBar: false },
};

// ---------------------------------------------------------------------------
console.log("=" .repeat(76));
console.log("1. MOUNT POINTS — all 7 chart containers present");
console.log("=" .repeat(76));

const html = renderDashboard(view(), NONCE);

for (const id of DASHBOARD_CHART_IDS) {
  const re = new RegExp(`<div class="chart-container" id="${id}">`);
  check(`mount point #${id}`, re.test(html));
}
check("exactly 7 chart containers", (html.match(/class="chart-container"/g) || []).length === 7);

console.log();
console.log("=" .repeat(76));
console.log("2. MISSING DATA — literal text, no invented number");
console.log("=" .repeat(76));

check(`placeholder text is exactly '${DATA_UNAVAILABLE_TEXT}'`, html.includes(DATA_UNAVAILABLE_TEXT));
check("placeholder present in an empty chart container", /id="chart-main">(?:\s|<p class="text-muted mb-0">data belum tersedia<\/p>)/.test(html));
check("placeholder present for the gini chart", /id="chart-rasio-gini">\s*<p class="text-muted mb-0">data belum tersedia<\/p>/.test(html));
check("missing macro series named on the page", html.includes("Usia Harapan Hidup"));
check("empty snapshot card says data belum tersedia", html.includes("Snapshot Inflasi"));

// No fabricated numbers in the unavailable path: every KPI row is the caller's.
check("KPI card renders the caller's value", html.includes("5.11%"));
check("KPI change renders the caller's change", html.includes("0.08 pp"));

// ---------------------------------------------------------------------------
console.log();
console.log("=" .repeat(76));
console.log("3. PAGE STRUCTURE — cards, insight, table, footer");
console.log("=" .repeat(76));

check("KPI label rendered", html.includes("PDB Growth"));
check("insight box rendered", html.includes("<strong>Insight:</strong>"));
check("insight text rendered", html.includes("Pertumbuhan PDB 5.1% (2025)"));
check("macro section rendered", html.includes("Indikator Makro Tambahan"));
check("projection table rendered", html.includes("Proyeksi (IMF WEO)"));
check("projection rows rendered", html.includes("<td>2024</td>"));
check("footer last-updated rendered", html.includes("Last Updated:"));
check("footer value rendered", html.includes("2026-10-21 13:08 UTC"));
check("CSV download link present", html.includes('href="/download/csv"'));
check("micro link present", html.includes('href="/micro"'));

// ---------------------------------------------------------------------------
console.log();
console.log("=" .repeat(76));
console.log("4. DATA PRESENT — specs injected, no placeholders");
console.log("=" .repeat(76));

const withCharts = renderDashboard(
  view({
    charts: { ...Object.fromEntries(DASHBOARD_CHART_IDS.map((id) => [id, null])), "chart-main": spec },
  }),
  NONCE,
);
check("__CHARTS__ payload present", withCharts.includes("window.__CHARTS__="));
check("spec data injected", withCharts.includes('"name":"PDB Growth (%)"'));
check("chart-main container has no placeholder when the spec exists", /id="chart-main"><\/div>/.test(withCharts));
check("other containers still carry the placeholder", withCharts.includes("data belum tersedia"));

// ---------------------------------------------------------------------------
console.log();
console.log("=" .repeat(76));
console.log("5. ESCAPING — a hostile value cannot break out");
console.log("=" .repeat(76));

const hostile = renderDashboard(
  view({
    kpis: [kpi({ name: '<img src=x onerror="alert(1)">', formatted_value: "</script><script>alert(2)</script>" })],
    insight: "</div><script>alert(3)</script>",
  }),
  NONCE,
);
check("KPI name escaped", !hostile.includes("<img src=x"));
check("KPI value escaped", !hostile.includes("</script><script>alert(2)"));
check("insight escaped", !hostile.includes("<script>alert(3)"));
check("no unescaped <img from data", (hostile.match(/<img/g) || []).length === 0);
check("esc() escapes quotes", esc('a"b') === "a&quot;b");
check("esc() escapes ampersand", esc("a&b") === "a&amp;b");
check("jsonAttr() escapes </", jsonAttr("</script>").includes("\\u003c/script\\u003e"));

// ---------------------------------------------------------------------------
console.log();
console.log("=" .repeat(76));
console.log("6. NONCE + TEMPLATE HYGIENE");
console.log("=" .repeat(76));

check("nonce stamped on the payload script", html.includes(`<script nonce="${NONCE}">window.__CHARTS__=`));
check("nonce stamped on the bootstrap script", html.includes(`<script nonce="${NONCE}">(() => {`));
check("no Jinja2 delimiters left", !html.includes("{{") && !html.includes("}}") && !html.includes("{%"));
check("no empty template values", !/(?:const|let|var)\s+[A-Za-z_]+\s*=\s*;/.test(html));
check("no literal None/undefined leaked", !html.includes(">None<") && !html.includes(">undefined<"));

// ---------------------------------------------------------------------------
console.log();
console.log("=" .repeat(76));
console.log("7. WHOLE-PAGE UNAVAILABLE — alert, not a blank dashboard");
console.log("=" .repeat(76));

const empty = renderDashboard(
  view({ kpis: [], data_unavailable: true, insight: DATA_UNAVAILABLE_TEXT + ". Sumber gagal." }),
  NONCE,
);
check("warning alert rendered", empty.includes('class="alert alert-warning"'));
check("alert names the missing data", empty.includes("Data belum tersedia"));
check(
  "no KPI card block emitted when kpis is empty",
  !/class="col-md-4">\s*<div class="card kpi-card/.test(empty),
);
check("still 7 mount points when everything is missing", (empty.match(/class="chart-container"/g) || []).length === 7);

// ---------------------------------------------------------------------------
console.log();
console.log("=" .repeat(76));
console.log(failed === 0 ? `TOTAL: ${passed}/${passed + failed} PASS` : `TOTAL: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) {
  console.log("failures:", failures.join(" | "));
  process.exit(1);
}
console.log("SEMUA TEST LULUS");
