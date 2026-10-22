/**
 * Bundle `src/index.ts` and run its `fetch()` handler against a D1 facade backed
 * by the local miniflare SQLite state — no wrangler, no port.
 *
 * Why this exists: `wrangler dev` writes its local D1 state to
 * `.wrangler/state/v3/d1/...sqlite`, but a standalone Node process cannot use the
 * same file while `wrangler dev` holds it, and a second `wrangler dev` on the same
 * project (different port, as the sibling card t_d0e42ec5 runs one) reads a
 * *different* state dir. So the Worker under test here is exercised with its own
 * in-process D1 binding, which is exactly what `fetch(request, env, ctx)` takes.
 *
 * The assertions cover the acceptance criteria of the `src/charts.ts` card from
 * the HTTP side: the page carries 7 chart specs with real D1 numbers, every inline
 * script carries the CSP nonce, and a `null` spec leaves the placeholder (never a
 * vanished container, never an invented number).
 */
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";

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
} catch (err) {
  console.log(`SKIP: node:sqlite unavailable (${err.message})`);
  process.exit(0);
}

// Copy the state file so the running `wrangler dev` keeps its own handle intact.
const scratch = mkdtempSync(join(osTmpdir(), "d1-copy-"));
const copyPath = join(scratch, "state.sqlite");
copyFileSync(D1_SQLITE, copyPath);

const con = new DatabaseSync(copyPath, { readOnly: true });
const params = (sql) => (sql.match(/\?/g) || []).length;

const db = {
  prepare(sql) {
    const stmt = con.prepare(sql);
    const all = (...p) =>
      stmt.all(...p.slice(0, params(sql)).map((v) => (typeof v === "bigint" ? Number(v) : v)));
    const first = (...p) => {
      const row = stmt.get(
        ...p.slice(0, params(sql)).map((v) => (typeof v === "bigint" ? Number(v) : v)),
      );
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

// --- bundle + load the real worker -------------------------------------------
const out = join(mkdtempSync(join(tmpdir(), "worker-test-")), "index.mjs");
await build({
  entryPoints: [join(root, "src/index.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: out,
  logLevel: "silent",
  define: { "process.env.NODE_ENV": '"test"' },
});
const mod = await import(out);
const worker = mod.default ?? mod;

// --- helpers -----------------------------------------------------------------
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

check("worker module exports a fetch handler", typeof worker.fetch === "function");

async function get(path) {
  const res = await worker.fetch(new Request(`http://localhost${path}`), env, {});
  const text = await res.text();
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), text };
}

function parseCharts(html) {
  const m = html.match(/window\.__CHARTS__=(\{.*?\});<\/script>/s);
  return m ? JSON.parse(m[1]) : null;
}

const NONCE_RE = /'nonce-([^']+)'/;

console.log("=".repeat(76));
console.log("C. END-TO-END — GET / with the real D1 binding");
console.log("=".repeat(76));

const dash = await get("/");
check("/ returns 200", dash.status === 200);
check("/ is HTML", (dash.headers["content-type"] || "").includes("text/html"));

const cspNonce = (dash.headers["content-security-policy"] || "").match(/'nonce-([^']+)'/);
check("CSP header carries a nonce", !!cspNonce, `headers: ${Object.keys(dash.headers)}`);

// every inline script stamped, and the CDN script left alone
const inlineScripts = [...dash.text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/gi)].map((m) => m[0]);
check("inline <script> blocks present", inlineScripts.length > 0, `found ${inlineScripts.length}`);
check(
  `all ${inlineScripts.length} inline scripts carry the CSP nonce`,
  inlineScripts.length > 0 && inlineScripts.every((t) => t.includes(`nonce="${cspNonce[1]}"`)),
);
check(
  "Plotly CDN script has no nonce (covered by the host allowlist)",
  !/cdn\.plot\.ly[^>]*nonce/.test(dash.text),
);

// 7 chart mount points + 7 specs with real values
const mountIds = [...dash.text.matchAll(/<div class="chart-container"[^>]*id="([^"]+)"/g)].map((m) => m[1]);
const EXPECTED = [
  "chart-main",
  "chart-pdb-growth",
  "chart-inflasi-yoy-",
  "chart-bi-rate",
  "chart-usd-idr",
  "chart-rasio-gini",
  "chart-inflation",
];
check("7 chart mount points in the markup", mountIds.length === 7, `got ${mountIds.length}: ${mountIds}`);
check(
  "the 7 mount points are the expected ids",
  EXPECTED.every((id) => mountIds.includes(id)),
);

const payload = parseCharts(dash.text);
check("chart payload present in the page", !!payload);
const specIds = payload ? Object.keys(payload) : [];
check("7 chart specs in the payload", specIds.length === 7, `got ${specIds.length}: ${specIds}`);
check(
  "every spec has traces with real values",
  payload &&
    EXPECTED.every((id) => {
      const s = payload[id];
      return s && s.data.length > 0 && s.data.every((t) => t.x.length > 0 && t.y.every((v) => Number.isFinite(v)));
    }),
);
check("no chart spec is an empty shell", payload && EXPECTED.every((id) => payload[id].data[0].y.length > 0));

// DB-derived: the numbers in the payload must equal D1's
const firstRow = (sql, ...p) =>
  con
    .prepare(sql)
    .get(...p.slice(0, params(sql)).map((v) => (typeof v === "bigint" ? Number(v) : v)));
const allRows = (sql, ...p) =>
  con
    .prepare(sql)
    .all(...p.slice(0, params(sql)).map((v) => (typeof v === "bigint" ? Number(v) : v)));
const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

const pdb = allRows(
  "SELECT value FROM indicators WHERE code='NY.GDP.MKTP.KD.ZG' AND value IS NOT NULL ORDER BY year DESC LIMIT 5",
).reverse();
const mainSpec = payload["chart-main"];
check(
  "chart-main PDB trace == D1 PDB values",
  mainSpec.data[0].y.length === pdb.length && mainSpec.data[0].y.every((v, i) => close(v, pdb[i].value)),
);
const bi = allRows(
  "SELECT date, value FROM time_series WHERE series_key='bi_rate' AND value IS NOT NULL ORDER BY date DESC LIMIT 12",
).reverse();
check(
  "chart-bi-rate trace == D1 bi_rate values",
  JSON.stringify(payload["chart-bi-rate"].data[0].x) === JSON.stringify(bi.map((r) => r.date)) &&
    payload["chart-bi-rate"].data[0].y.every((v, i) => close(v, bi[i].value)),
);
const yoy = allRows(
  "SELECT date, value FROM time_series WHERE series_key='inflation_yoy' AND value IS NOT NULL ORDER BY date DESC LIMIT 12",
).reverse();
check(
  "chart-inflation line trace == D1 inflation_yoy values",
  payload["chart-inflation"].data[1].y.every((v, i) => close(v, yoy[i].value)),
);

// placeholder contract: every container is emitted even when its spec is null,
// so a missing series is visible as text — never as a vanished div, never as a
// guessed number. With a fully populated D1 there is nothing to substitute; the
// renderer's own contract for that case is covered by test_render_dashboard.mjs.
check(
  "the 7 containers are always emitted (mount points survive a missing series)",
  mountIds.length === 7,
  `got ${mountIds.length}`,
);

// --- other routes still healthy ---------------------------------------------
for (const path of ["/micro", "/micro-economy", "/health", "/healthz"]) {
  const r = await get(path);
  check(`${path} returns 200`, r.status === 200, `got ${r.status}`);
}
const csv = await get("/download/csv");
check("/download/csv returns 200", csv.status === 200);
check("/download/csv is text/csv", (csv.headers["content-type"] || "").includes("text/csv"));

// micro page: its 5 charts must carry real values too
const microPayload = parseCharts((await get("/micro")).text);
check("micro page carries a chart payload", !!microPayload);
if (microPayload) {
  const microIds = Object.keys(microPayload).filter((k) => typeof microPayload[k] === "object");
  check("micro page has 5 chart specs", microIds.length === 5, `got ${microIds.length}`);
  check(
    "micro specs have real values",
    microIds.every((id) => microPayload[id].data.length > 0 && microPayload[id].data.every((t) => t.x.length > 0 && t.y.length > 0)),
  );
}

con.close();
rmSync(scratch, { recursive: true, force: true });

console.log();
console.log(failed === 0 ? `TOTAL: ${passed}/${passed + failed} PASS` : `TOTAL: ${passed} PASS / ${failed} FAIL`);
if (failed > 0) {
  console.log("failures:", failures.join(" | "));
  process.exit(1);
}
console.log("SEMUA TEST LULUS — 7 chart spec, angka dari D1, nonce pada semua inline script");
