/**
 * Layer B for `src/charts.ts`: drive the chart builders with rows read from the
 * real D1 database (local miniflare SQLite state) and assert the 7 dashboard
 * chart specs contain D1's numbers — not a fixture, not a constant.
 *
 * This is the "no hardcoded numbers" half of the card's acceptance criteria.
 * `scripts/compare_chart_numbers.py` does the same comparison against the Flask
 * build's own SQLite DB; this file needs no Flask, only D1.
 */
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const D1_SQLITE = join(
  root,
  ".wrangler/state/v3/d1/miniflare-D1DatabaseObject",
  "835495cd993b39989a3bb0a40c7ec0f058d41a7629faf5f3150cf1afe53543ce.sqlite",
);

const require = createRequire(import.meta.url);
let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  console.log("node:sqlite unavailable — skipping DB-derived layer");
  process.exit(0);
}

const con = new DatabaseSync(D1_SQLITE, { readOnly: true });
const all = (sql, ...params) => con.prepare(sql).all(...params);
const first = (sql, ...params) => con.prepare(sql).get(...params) ?? null;

const INDICATOR_CODES = {
  "NY.GDP.MKTP.KD.ZG": "PDB Growth",
  "FP.CPI.TOTL.ZG": "Inflasi",
  "BN.GSR.GNFS.CD": "Trade Balance",
};

// --- port of the D1 facade ---------------------------------------------------
const db = {
  prepare(sql) {
    const stmt = con.prepare(sql);
    const rowParams = (s) => (s.match(/\?/g) || []).length;
    const normalize = (p) => {
      const raw = p.slice(0, rowParams(sql)).map((v) => (typeof v === "bigint" ? Number(v) : v));
      return raw;
    };
    return {
      bind: (...p) => ({
        all: () => ({ results: all(sql, ...normalize(p)) }),
        first: () => first(sql, ...normalize(p)),
        run: () => undefined,
      }),
      all: () => ({ results: all(sql) }),
      first: () => first(sql),
      run: () => undefined,
    };
  },
  batch: async () => [],
};

// --- read the D1 numbers -----------------------------------------------------
async function readD1() {
  const out = {};
  for (const code of Object.keys(INDICATOR_CODES)) {
    out[code] = {
      data: all(
        "SELECT code, name, value, year, fetched_at FROM indicators WHERE code = ? AND value IS NOT NULL ORDER BY year DESC LIMIT 5",
        code,
      ),
      latest: first(
        "SELECT code, name, value, year, fetched_at FROM indicators WHERE code = ? AND value IS NOT NULL ORDER BY year DESC LIMIT 1",
        code,
      ),
    };
  }
  const series = (key, limit) =>
    all(
      "SELECT date, value, fetched_at FROM time_series WHERE series_key = ? AND value IS NOT NULL ORDER BY date DESC LIMIT ?",
      key,
      limit,
    ).reverse();
  out._series = {
    bi_rate: series("bi_rate", 12),
    usd_idr: series("usd_idr", 30),
    gini: series("gini", 10),
    inflation_yoy: series("inflation_yoy", 12),
  };
  return out;
}

const data = await readD1();

// --- build the view with the real code path ----------------------------------
const renderOut = join(mkdtempSync(join(tmpdir(), "charts-db-")), "render.mjs");
await build({
  entryPoints: [join(root, "src/render.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: renderOut,
  logLevel: "silent",
});
const { buildDashboardView } = await import(renderOut);
const view = await buildDashboardView(db);
con.close();

const charts = view.charts;
const specs = Object.entries(charts).filter(([, s]) => s && typeof s === "object");
const DASHBOARD_CHART_IDS = [
  "chart-main",
  "chart-pdb-growth",
  "chart-inflasi-yoy-",
  "chart-bi-rate",
  "chart-usd-idr",
  "chart-rasio-gini",
  "chart-inflation",
];

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
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

console.log("=".repeat(76));
console.log("B. DB-DERIVED SPECS — the 7 dashboard charts against real D1 rows");
console.log("=".repeat(76));

check("all 7 chart ids present in the view", DASHBOARD_CHART_IDS.every((id) => id in charts));
check("7 chart specs produced", specs.length === 7, `got ${specs.length}`);
check(
  "every spec has traces with real values",
  specs.every(([, s]) => s.data.length > 0 && s.data.every((t) => t.x.length > 0 && t.y.every((v) => Number.isFinite(v)))),
);

// chart-main: years + PDB + inflation, ascending
const pdbRows = [...data["NY.GDP.MKTP.KD.ZG"].data].sort((a, b) => a.year - b.year);
const inflRows = [...data["FP.CPI.TOTL.ZG"].data].sort((a, b) => a.year - b.year);
const years = pdbRows.map((r) => r.year);
const main = charts["chart-main"];
check("chart-main years come from D1 indicators", JSON.stringify(main.data[0].x) === JSON.stringify(years));
check(
  "chart-main PDB values == D1 PDB values",
  main.data[0].y.every((v, i) => close(v, pdbRows[i].value)),
);
check(
  "chart-main inflation values == D1 inflation values",
  main.data[1].y.every((v, i) => close(v, inflRows[i].value)),
);
check("chart-main has both traces", main.data.length === 2);

// detail charts
check(
  "chart-pdb-growth values == D1 PDB values",
  charts["chart-pdb-growth"].data[0].y.every((v, i) => close(v, pdbRows[i].value)),
);
check(
  "chart-inflasi-yoy- values == D1 inflation values",
  charts["chart-inflasi-yoy-"].data[0].y.every((v, i) => close(v, inflRows[i].value)),
);

// macro charts: series dates + values straight from D1
for (const [id, key] of [
  ["chart-bi-rate", "bi_rate"],
  ["chart-usd-idr", "usd_idr"],
  ["chart-rasio-gini", "gini"],
]) {
  const rows = data._series[key];
  const spec = charts[id];
  check(`${id}: x == D1 ${key} dates`, JSON.stringify(spec.data[0].x) === JSON.stringify(rows.map((r) => r.date)));
  check(
    `${id}: y == D1 ${key} values`,
    spec.data[0].y.every((v, i) => close(v, rows[i].value)),
  );
}

// inflation + corridor
const yoy = data._series.inflation_yoy;
const inflSpec = charts["chart-inflation"];
check(
  "chart-inflation line y == D1 inflation_yoy values",
  inflSpec.data[1].y.every((v, i) => close(v, yoy[i].value)),
);
check(
  "chart-inflation line x == D1 inflation_yoy dates",
  JSON.stringify(inflSpec.data[1].x) === JSON.stringify(yoy.map((r) => r.date)),
);
check(
  "chart-inflation corridor band == 3.5 / 1.5",
  inflSpec.data[0].y
    .slice(0, yoy.length)
    .every((v) => close(v, 3.5)) &&
    inflSpec.data[0].y.slice(yoy.length).every((v) => close(v, 1.5)),
);

// the numbers must not be constants: two charts must disagree on their y values
check(
  "specs are not a shared constant (bi_rate != usd_idr values)",
  !charts["chart-bi-rate"].data[0].y.every((v, i) => close(v, charts["chart-usd-idr"].data[0].y[i] ?? NaN)),
);

console.log();
console.log(failed === 0 ? `TOTAL: ${passed}/${passed + failed} PASS` : `TOTAL: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) {
  console.log("failures:", failures.join(" | "));
  process.exit(1);
}
console.log("SEMUA TEST LULUS — semua angka chart dari D1");
