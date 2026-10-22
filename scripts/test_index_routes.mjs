/**
 * Acceptance test for the `src/index.ts` card (t_c5bed955): the Hono app's
 * `/`, `/health` and `/healthz` routes.
 *
 * Runs the real bundled Worker in-process against a D1 facade over a copy of the
 * local miniflare SQLite state — no `wrangler dev`, no port. Copying the file
 * matters: a running `wrangler dev` (the sibling card t_7c752775 keeps one on
 * 8788) holds the state file, and a standalone process must not read it under
 * that handle.
 *
 * What is asserted, and why each assertion exists:
 *   - `/` answers 200 text/html with 11 KPI cards and all 7 chart mount points,
 *     and every one of those 7 mount points has a non-empty Plotly payload. A
 *     page that renders 7 empty containers would still pass a "7 charts exist"
 *     grep, so the payload is parsed and counted.
 *   - No `data belum tersedia` anywhere on `/`: a missing series must not be
 *     silent, but with the seeded local D1 every series is present.
 *   - `/healthz` answers JSON `{status, rows_stored}` and `rows_stored` equals
 *     the actual `SELECT COUNT(*)` from the same database — the health check is
 *     what a deploy gate reads, so it must not report a hardcoded number.
 *   - `/health` answers JSON with the same shape plus the extras the port added.
 *   - Every inline `<script>` carries the CSP nonce and the CDN script does not.
 *
 * Usage:  node scripts/test_index_routes.mjs
 *
 * Hermetic on purpose: the bundle stubs `./micro` and `./csv`, the two modules
 * owned by the sibling card t_7c752775. A test for `/` and `/healthz` must not
 * fail because a *different* card is mid-edit in `src/micro.ts` — that file is
 * imported by `src/index.ts`, so a syntax error there would otherwise take this
 * test down with it. The stub throws if a stubbed route is ever reached, so a
 * silent fallback cannot pass for a real handler.
 */
import { build } from "esbuild";
import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const require = createRequire(import.meta.url);
let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch (err) {
  console.log(`SKIP: node:sqlite unavailable (${err.message})`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// D1 facade over the local miniflare state (copied, so the dev server is safe)
// ---------------------------------------------------------------------------

const d1Dir = join(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
const candidates = readdirSync(d1Dir).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite");
if (candidates.length !== 1) {
  console.log(`SKIP: expected exactly one D1 state file, found ${candidates.length}`);
  process.exit(0);
}
const scratch = mkdtempSync(join(tmpdir(), "index-routes-d1-"));
const copyPath = join(scratch, "state.sqlite");
copyFileSync(join(d1Dir, candidates[0]), copyPath);

const con = new DatabaseSync(copyPath, { readOnly: true });
const paramCount = (sql) => (sql.match(/\?/g) || []).length;

const db = {
  prepare(sql) {
    const stmt = con.prepare(sql);
    const cast = (v) => (typeof v === "bigint" ? Number(v) : v);
    const all = (...p) => stmt.all(...p.slice(0, paramCount(sql)).map(cast));
    const first = (...p) => {
      const row = stmt.get(...p.slice(0, paramCount(sql)).map(cast));
      return row === undefined ? null : row;
    };
    return {
      bind: (...p) => ({ all: () => ({ results: all(...p) }), first: () => first(...p), run: () => undefined }),
      all: () => ({ results: all() }),
      first: () => first(),
      run: () => undefined,
    };
  },
  batch: async () => [],
};

const env = {
  DB: db,
  CACHE_KV: {},
  ENVIRONMENT: "test",
  SITE_URL: "http://localhost",
};

// The ground truth the health route must agree with.
const truthRows = con.prepare("SELECT COUNT(*) AS n FROM indicators").get().n;
const truthSeries = con.prepare("SELECT COUNT(*) AS n FROM time_series").get().n;

// ---------------------------------------------------------------------------
// Bundle + load the real Worker
// ---------------------------------------------------------------------------

const out = join(mkdtempSync(join(tmpdir(), "index-routes-bundle-")), "index.mjs");
await build({
  entryPoints: [join(root, "src/index.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: out,
  logLevel: "silent",
  define: { "process.env.NODE_ENV": '"test"' },
  plugins: [
    {
      name: "stub-sibling-route-modules",
      setup(pluginBuild) {
        // `./micro` and `./csv` belong to t_7c752775. Replace them so this test
        // exercises `/` and `/healthz` only, and never fails on a sibling's
        // in-flight edit.
        pluginBuild.onResolve({ filter: /^\.\/(micro|csv)$/ }, (args) => ({
          path: args.path,
          namespace: "sibling-stub",
        }));
        pluginBuild.onLoad({ filter: /.*/, namespace: "sibling-stub" }, (args) =>
          args.path === "./micro"
            ? {
                loader: "js",
                contents: [
                  "export async function buildMicroView() { throw new Error('buildMicroView is stubbed in test_index_routes.mjs'); }",
                  "export function renderMicro() { throw new Error('renderMicro is stubbed in test_index_routes.mjs'); }",
                ].join("\n"),
              }
            : {
                loader: "js",
                contents:
                  "export function csvSafe(value) { return String(value ?? ''); }",
              },
        );
      },
    },
  ],
});
const mod = await import(out);
const worker = mod.default ?? mod;

let passed = 0;
let failed = 0;
function check(label, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`[PASS] ${label}`);
  } else {
    failed += 1;
    console.log(`[FAIL] ${label}${detail ? `: ${detail}` : ""}`);
  }
}

async function get(path) {
  const res = await worker.fetch(new Request(`http://localhost${path}`), env, {});
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    text: await res.text(),
  };
}

function parseCharts(html) {
  const m = html.match(/window\.__CHARTS__=(\{.*?\});<\/script>/s);
  return m ? JSON.parse(m[1]) : null;
}

console.log("=".repeat(76));
console.log("GET / — dashboard makro");
console.log("=".repeat(76));

check("worker module exports a fetch handler", typeof worker.fetch === "function");

const dash = await get("/");
check("/ returns 200", dash.status === 200, `got ${dash.status}`);
check("/ is text/html", (dash.headers["content-type"] || "").includes("text/html"), dash.headers["content-type"]);

const kpiCards = (dash.text.match(/class="card kpi-card/g) || []).length;
check("11 KPI cards in the markup", kpiCards === 11, `got ${kpiCards}`);

const EXPECTED_MOUNTS = [
  "chart-main",
  "chart-pdb-growth",
  "chart-inflasi-yoy-",
  "chart-bi-rate",
  "chart-usd-idr",
  "chart-rasio-gini",
  "chart-inflation",
];
const mounts = [...dash.text.matchAll(/<div class="chart-container"[^>]*id="([^"]+)"/g)].map((m) => m[1]);
check("7 chart mount points in the markup", mounts.length === 7, `got ${mounts.length}: ${mounts}`);
check(
  "the 7 mount points are the expected ids",
  EXPECTED_MOUNTS.every((id) => mounts.includes(id)),
  `missing: ${EXPECTED_MOUNTS.filter((id) => !mounts.includes(id))}`,
);

const charts = parseCharts(dash.text);
check("window.__CHARTS__ payload parses as JSON", charts !== null);
const chartKeys = charts ? Object.keys(charts) : [];
check("7 chart specs in the payload", chartKeys.length === 7, `got ${chartKeys.length}: ${chartKeys}`);
check(
  "every chart spec has non-empty data traces",
  chartKeys.length === 7 && chartKeys.every((k) => Array.isArray(charts[k]?.data) && charts[k].data.length > 0),
  chartKeys.map((k) => `${k}:${charts[k]?.data?.length ?? 0}`).join(" "),
);

check(
  "no 'data belum tersedia' on the seeded dashboard",
  !dash.text.includes("data belum tersedia"),
);

// CSP nonce story on the macro page
const cspNonce = (dash.headers["content-security-policy"] || "").match(/'nonce-([^']+)'/);
check("CSP header carries a nonce", !!cspNonce, `headers: ${Object.keys(dash.headers)}`);
const inlineScripts = [...dash.text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)].map((m) => m[0]);
check("inline <script> blocks present", inlineScripts.length > 0, `found ${inlineScripts.length}`);
check(
  `all ${inlineScripts.length} inline scripts carry the CSP nonce`,
  inlineScripts.length > 0 && inlineScripts.every((t) => t.includes(`nonce="${cspNonce?.[1]}"`)),
);
check("Plotly CDN script has no nonce (host allowlist covers it)", !/cdn\.plot\.ly[^>]*nonce/.test(dash.text));

console.log();
console.log("=".repeat(76));
console.log("GET /healthz  —  GET /health");
console.log("=".repeat(76));

const hz = await get("/healthz");
let hzBody = null;
try {
  hzBody = JSON.parse(hz.text);
} catch {
  /* asserted below */
}
check("/healthz returns 200", hz.status === 200, `got ${hz.status}`);
check("/healthz is application/json", (hz.headers["content-type"] || "").includes("application/json"), hz.headers["content-type"]);
check("/healthz body is JSON", hzBody !== null, hz.text.slice(0, 120));
check("/healthz status is ok", hzBody?.status === "ok", JSON.stringify(hzBody));
check(
  "/healthz rows_stored is a number equal to the real D1 count",
  typeof hzBody?.rows_stored === "number" && hzBody.rows_stored === truthRows,
  `reported ${hzBody?.rows_stored}, D1 says ${truthRows}`,
);
check("/healthz rows_stored > 0", typeof hzBody?.rows_stored === "number" && hzBody.rows_stored > 0);

const h = await get("/health");
let hBody = null;
try {
  hBody = JSON.parse(h.text);
} catch {
  /* asserted below */
}
check("/health returns 200", h.status === 200, `got ${h.status}`);
check("/health is JSON", hBody !== null, h.text.slice(0, 120));
check("/health status is ok", hBody?.status === "ok", JSON.stringify(hBody));
check(
  "/health rows_stored matches the real D1 count",
  hBody?.rows_stored === truthRows,
  `reported ${hBody?.rows_stored}, D1 says ${truthRows}`,
);
check("/health reports the series count", hBody?.series_stored === truthSeries, `reported ${hBody?.series_stored}, D1 says ${truthSeries}`);

// Isolation proof: `/micro` is stubbed in this bundle, so it must fail loudly
// rather than render a page. If someone deletes the esbuild plugin, this check
// fails and says so — a real micro page here means the test stopped being
// hermetic and started depending on t_7c752775's file.
const microRes = await get("/micro");
check(
  "GET /micro is stubbed out of this bundle (isolation proof)",
  microRes.status === 500 && !microRes.text.includes("<!DOCTYPE html>"),
  `status ${microRes.status}`,
);

console.log();
console.log(`RESULT: ${passed} PASS, ${failed} FAIL  (D1 truth: indicators=${truthRows}, time_series=${truthSeries})`);

rmSync(scratch, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
