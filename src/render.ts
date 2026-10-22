/**
 * HTML renderer — TypeScript port of `templates/dashboard.html` (Jinja2) plus the
 * template context built in `dashboard()` in `app.py`.
 *
 * The Flask version rendered Jinja2 server-side. This version builds the same
 * markup with template literals and inlines the Plotly *specs* as JSON; the
 * client draws the charts. Keeping the structure identical means the page's
 * visible numbers can be diffed directly against the Flask build.
 *
 * Three rules this module exists to keep:
 *
 *   1. Every number is read from D1. Nothing here knows a value.
 *   2. A series that is not in D1 leaves a *placeholder* in the page, never a
 *      guessed number. The literal text is `data belum tersedia`.
 *   3. All seven chart mount points are always present in the markup. A chart
 *      whose series is missing renders the placeholder inside its own container
 *      instead of the container vanishing — a missing div is how a broken chart
 *      hides, and `silent-frontend-failure` exists precisely for that.
 *
 * Two escaping helpers matter here:
 *   - `esc()` for every interpolated value (Jinja2 autoescapes; template
 *     literals do not).
 *   - `jsonAttr()` for data embedded in `<script>` — a `</script>` inside a
 *     JSON string would terminate the block early. Both `</` sequences are
 *     escaped, so the page cannot be broken out of by a data value.
 */

import {
  getAllData,
  getLatestSeries,
  getSeries,
  getSeriesMetadata,
  type AllDataEntry,
  type SeriesRow,
} from "./db";
import {
  BI_TARGET_CENTER,
  BI_TARGET_HIGH,
  BI_TARGET_LOW,
} from "./fetchers";
import {
  buildInflationChart,
  buildMainChart,
  buildSingleChart,
  type ChartSpec,
} from "./charts";
import {
  PROJECTION,
  buildInflationSnapshot,
  computeDashboardKpis,
  computeMacroKpis,
  formatMonthId,
  generateInsight,
} from "./kpi";

/** Jinja2 `|e` equivalent. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `JSON.stringify` safe for embedding inside a `<script>` element. */
export function jsonAttr(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * The literal string a missing data source renders. Deliberately lowercase and
 * exact: acceptance greps for it, and it is the same phrase the whole-page
 * alert uses, so a reader cannot tell a partial gap from a total one.
 */
export const DATA_UNAVAILABLE_TEXT = "data belum tersedia";

const DATA_UNAVAILABLE_PLACEHOLDER = `<p class="text-muted mb-0">${DATA_UNAVAILABLE_TEXT}</p>`;

// ---------------------------------------------------------------------------
// Client-side chart bootstrap
// ---------------------------------------------------------------------------

/**
 * The one inline script on the page: reads `window.__CHARTS__` and calls
 * `Plotly.newPlot` per entry. Kept in one place so the nonce story stays
 * single-sourced — this is the only inline script on `/`.
 */
const CHART_BOOTSTRAP = `(() => {
  const specs = window.__CHARTS__ || {};
  for (const id of Object.keys(specs)) {
    const el = document.getElementById(id);
    const spec = specs[id];
    if (el && spec) Plotly.newPlot(el, spec.data, spec.layout, spec.config || {});
  }
})();`;

export interface DashboardView {
  kpis: ReturnType<typeof computeDashboardKpis>;
  insight: string;
  last_updated: string;
  projection: typeof PROJECTION;
  charts: Record<string, ChartSpec | null>;
  data_unavailable: boolean;
  macro_kpis: ReturnType<typeof computeMacroKpis>;
  macro_updated: string;
  inflation_snapshot: string;
  bi_target: { center: number; low: number; high: number };
}

/**
 * The chart ids the page emits, in document order. `renderDashboard` walks this
 * list to guarantee the markup contains all seven mount points, and the payload
 * is filtered against it — a spec with no container, or a container with no
 * spec, is a chart that silently does nothing.
 */
export const DASHBOARD_CHART_IDS = [
  "chart-main",
  "chart-pdb-growth",
  "chart-inflasi-yoy-",
  "chart-bi-rate",
  "chart-usd-idr",
  "chart-rasio-gini",
  "chart-inflation",
] as const;

export type DashboardChartId = (typeof DASHBOARD_CHART_IDS)[number];

/** Card titles for the macro chart row. Port of the three `{% if %}` blocks in the Jinja template. */
const MACRO_CHART_TITLES: Record<string, string> = {
  "chart-bi-rate": "BI-Rate",
  "chart-usd-idr": "Kurs USD/IDR",
  "chart-rasio-gini": "Rasio Gini",
};

/** The macro series each card reads, so a missing one can be named in the page. */
const MACRO_SERIES_LABELS: Record<string, string> = {
  gini: "Rasio Gini",
  life_exp: "Usia Harapan Hidup",
  edu_exp: "Pendidikan (% PDB)",
  literacy: "Literasi",
};

const GDP_CODE = "NY.GDP.MKTP.KD.ZG";
const INFL_CODE = "FP.CPI.TOTL.ZG";

const DATA_UNAVAILABLE_INSIGHT =
  `${DATA_UNAVAILABLE_TEXT[0].toUpperCase()}${DATA_UNAVAILABLE_TEXT.slice(1)}. ` +
  "Sumber World Bank API tidak dapat dihubungi saat " +
  "aplikasi dijalankan. Data akan dimuat otomatis pada pembaruan berikutnya " +
  "(setiap 6 jam).";

/** Same month one year earlier, looked up inside the series window. */
function lastUpdatedSync(data: Record<string, AllDataEntry>, code: string): string | null {
  return data[code]?.latest?.fetched_at ?? null;
}

/** Same month one year earlier, looked up inside the series window. */
function yearAgoRow(rows: SeriesRow[], latest: SeriesRow): SeriesRow | null {
  const year = Number(latest.date.slice(0, 4));
  const month = latest.date.slice(5, 7);
  return rows.find((r) => r.date === `${year - 1}-${month}-01`) ?? null;
}

/**
 * The chart container. Always emitted, whatever the data state — the spec goes
 * into `window.__CHARTS__`, the placeholder stays in the DOM when it does not.
 */
function chartMount(id: string, spec: ChartSpec | null | undefined): string {
  const body = spec ? "" : DATA_UNAVAILABLE_PLACEHOLDER;
  return `                    <div class="chart-container" id="${esc(id)}">${body}</div>`;
}

// ---------------------------------------------------------------------------
// View assembly — port of `dashboard()`
// ---------------------------------------------------------------------------

/** Port of `dashboard()` — every value below is read from D1. */
export async function buildDashboardView(db: D1Database): Promise<DashboardView> {
  const data = await getAllData(db);

  const inflationYoyLatest = await getLatestSeries(db, "inflation_yoy");
  const inflationYoyData = await getSeries(db, "inflation_yoy", 12);

  const kpis = computeDashboardKpis(data, inflationYoyLatest, inflationYoyData, (code) =>
    lastUpdatedSync(data, code),
  );

  const insight =
    kpis.length === 0
      ? DATA_UNAVAILABLE_INSIGHT
      : generateInsight(data, inflationYoyLatest);

  // Chart data: 5 years ascending.
  const pdbRows = [...(data[GDP_CODE]?.data ?? [])].sort((a, b) => a.year - b.year);
  const inflasiRows = [...(data[INFL_CODE]?.data ?? [])].sort((a, b) => a.year - b.year);
  const years = pdbRows.map((r) => r.year);
  const pdbValues = pdbRows.map((r) => r.value);
  const inflasiValues = inflasiRows.map((r) => r.value);

  const biRateData = await getSeries(db, "bi_rate", 12);
  const usdIdrData = await getSeries(db, "usd_idr", 30);
  const giniData = await getSeries(db, "gini", 10);

  const inflationSnapshot =
    inflationYoyLatest && inflationYoyData.length > 0
      ? buildInflationSnapshot(inflationYoyLatest, yearAgoRow(inflationYoyData, inflationYoyLatest))
      : "";

  const macroLatest: Record<string, SeriesRow | null> = {
    bi_rate: await getLatestSeries(db, "bi_rate"),
    usd_idr: await getLatestSeries(db, "usd_idr"),
    gini: await getLatestSeries(db, "gini"),
    life_exp: await getLatestSeries(db, "life_exp"),
    edu_exp: await getLatestSeries(db, "edu_exp"),
    literacy: await getLatestSeries(db, "literacy"),
  };

  return {
    kpis,
    insight,
    last_updated: (await getSeriesMetadata(db, "last_updated")) ?? "Belum pernah update",
    projection: PROJECTION,
    charts: {
      "chart-main": years.length ? buildMainChart(years, pdbValues, inflasiValues) : null,
      "chart-pdb-growth": years.length
        ? buildSingleChart(years, pdbValues, "PDB Growth (%)", "#0d6efd", "chart-pdb-growth")
        : null,
      "chart-inflasi-yoy-": years.length
        ? buildSingleChart(years, inflasiValues, "Inflasi YoY (%)", "#dc3545", "chart-inflasi-yoy-")
        : null,
      "chart-bi-rate": biRateData.length
        ? buildSingleChart(
            biRateData.map((r) => r.date),
            biRateData.map((r) => r.value),
            "BI-Rate (%)",
            "#6f42c1",
            "chart-bi-rate",
          )
        : null,
      "chart-usd-idr": usdIdrData.length
        ? buildSingleChart(
            usdIdrData.map((r) => r.date),
            usdIdrData.map((r) => r.value),
            "USD/IDR",
            "#20c997",
            "chart-usd-idr",
          )
        : null,
      "chart-rasio-gini": giniData.length
        ? buildSingleChart(
            giniData.map((r) => r.date),
            giniData.map((r) => r.value),
            "Rasio Gini",
            "#fd7e14",
            "chart-rasio-gini",
          )
        : null,
      "chart-inflation": inflationYoyData.length
        ? buildInflationChart(
            inflationYoyData.map((r) => r.date),
            inflationYoyData.map((r) => r.value),
          )
        : null,
    },
    data_unavailable: kpis.length === 0,
    macro_kpis: computeMacroKpis(macroLatest),
    macro_updated: (await getSeriesMetadata(db, "macro_last_updated")) ?? "Belum pernah update",
    inflation_snapshot: inflationSnapshot,
    bi_target: { center: BI_TARGET_CENTER, low: BI_TARGET_LOW, high: BI_TARGET_HIGH },
  };
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

/**
 * The dashboard page. `nonce` stamps the single inline script; `applyNonce` from
 * `headers.ts` is the shared helper and is used by the route so a second inline
 * block would also be stamped.
 */
export function renderDashboard(view: DashboardView, nonce: string): string {
  const charts = view.charts;
  // Only the specs that actually exist go into the payload; every container is
  // still emitted (above) so a missing series is visible, not a missing div.
  const payload = Object.fromEntries(
    Object.entries(charts).filter(([, spec]) => spec !== null),
  );
  const chartJson = jsonAttr(payload);

  // A spec that is not in DASHBOARD_CHART_IDS has no container on the page —
  // it would be dropped by the bootstrap loop with nothing to show for it.
  const unknownIds = Object.keys(payload).filter(
    (id) => !(DASHBOARD_CHART_IDS as readonly string[]).includes(id),
  );
  if (unknownIds.length > 0) {
    throw new Error(`renderDashboard: chart spec without a mount point: ${unknownIds.join(", ")}`);
  }

  const macroMissing = (["gini", "life_exp", "edu_exp", "literacy"] as const).filter(
    (key) => !view.macro_kpis.some((card) => card.name === MACRO_SERIES_LABELS[key]),
  );

  return `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Indonesia Economic Dashboard</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <script src="https://cdn.plot.ly/plotly-4.1.1.min.js"></script>
    <style>
        body { background-color: #f8f9fa; }
        .kpi-card { border: none; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); transition: transform 0.2s; }
        .kpi-card:hover { transform: translateY(-3px); }
        .kpi-value { font-size: 2rem; font-weight: 700; }
        .kpi-label { color: #6c757d; font-size: 0.9rem; }
        .status-badge { font-size: 0.8rem; }
        .insight-box { border-left: 4px solid #0d6efd; background: #e7f1ff; border-radius: 8px; }
        .section-title { font-weight: 600; margin-bottom: 1rem; }
        .chart-container { position: relative; height: 300px; }
        footer { margin-top: 3rem; padding: 1.5rem 0; border-top: 1px solid #dee2e6; }
    </style>
</head>
<body>
<div class="container py-4">
    <header class="mb-4 d-flex justify-content-between align-items-start flex-wrap gap-2">
        <div>
            <h1>Indonesia Economic Dashboard</h1>
            <p class="text-muted">Data Makro untuk Akademisi &amp; Pebisnis</p>
        </div>
        <a href="/micro" class="btn btn-outline-success btn-sm mt-2">Micro Economy</a>
    </header>

${view.data_unavailable ? DATA_UNAVAILABLE_ALERT : ""}
    <div class="row g-3 mb-4">
${view.kpis.map(renderKpiCard).join("\n")}
    </div>

    <div class="insight-box p-3 mb-4">
        <strong>Insight:</strong> ${esc(view.insight)}
    </div>

${
  view.macro_kpis.length > 0
    ? `    <h4 class="section-title">Indikator Makro Tambahan</h4>
    <div class="row g-3 mb-4">
${view.macro_kpis.map(renderMacroKpi).join("\n")}
    </div>
${
  macroMissing.length > 0
    ? `<small class="text-muted">${esc(macroMissing.map((key) => MACRO_SERIES_LABELS[key]).join(", "))}: ${DATA_UNAVAILABLE_TEXT}</small>`
    : ""
}
`
    : ""
}
    <div class="row g-3 mb-4">
${renderMacroCharts(charts)}
    </div>
    <small class="text-muted">Terakhir diperbarui: ${esc(view.macro_updated)}</small>
    <div class="row g-3 mb-4">
        <div class="col-md-8">
            <div class="card h-100">
                <div class="card-body">
                    <h5 class="section-title">Inflasi Bulanan (YoY) — 12 Bulan Terakhir</h5>
${chartMount("chart-inflation", charts["chart-inflation"])}
                </div>
            </div>
        </div>
        <div class="col-md-4">
            <div class="card h-100">
                <div class="card-body">
                    <h5 class="section-title">Snapshot Inflasi</h5>
                    ${
                      view.inflation_snapshot
                        ? `<p class="mb-2">${esc(view.inflation_snapshot)}</p>`
                        : DATA_UNAVAILABLE_PLACEHOLDER
                    }
                    <small class="text-muted">
                        Target BI: ${view.bi_target.center.toFixed(1)}% ±1% (corridor ${view.bi_target.low.toFixed(1)}%–${view.bi_target.high.toFixed(1)}%).
                        Data: BPS (IHK YoY).
                    </small>
                </div>
            </div>
        </div>
    </div>

    <div class="card mb-4">
        <div class="card-body">
            <h5 class="section-title">Tren 5 Tahun: PDB Growth &amp; Inflasi</h5>
${chartMount("chart-main", charts["chart-main"])}
        </div>
    </div>

    <div class="row g-3 mb-4">
        <div class="col-md-6">
            <div class="card h-100">
                <div class="card-body">
                    <h5 class="section-title">PDB Growth (Detail)</h5>
${chartMount("chart-pdb-growth", charts["chart-pdb-growth"])}
                </div>
            </div>
        </div>
        <div class="col-md-6">
            <div class="card h-100">
                <div class="card-body">
                    <h5 class="section-title">Inflasi YoY (Detail)</h5>
${chartMount("chart-inflasi-yoy-", charts["chart-inflasi-yoy-"])}
                </div>
            </div>
        </div>
    </div>

    <div class="card mb-4">
        <div class="card-body">
            <h5 class="section-title">Proyeksi (IMF WEO) <span class="badge bg-warning text-dark ms-2">Data Historis (Estimasi)</span></h5>
            <table class="table table-striped">
                <thead>
                    <tr><th>Tahun</th><th>PDB Growth (%)</th><th>Inflasi (%)</th></tr>
                </thead>
                <tbody>
${view.projection
  .map(
    (row) =>
      `                    <tr>\n                        <td>${row.year}</td>\n                        <td>${row.pdb.toFixed(1)}</td>\n                        <td>${row.inflasi.toFixed(1)}</td>\n                    </tr>`,
  )
  .join("\n")}
                </tbody>
            </table>
            <small class="text-muted">Sumber: IMF World Economic Outlook (hardcoded), data historis: World Bank.</small>
        </div>
    </div>

    <footer>
        <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
            <div>
                <strong>Sumber Data:</strong> World Bank API, IMF WEO, BPS &nbsp;|&nbsp;
                <strong>Last Updated:</strong> ${esc(view.last_updated)}
            </div>
            <div>
                <a href="/download/csv" class="btn btn-outline-primary btn-sm">Download CSV</a>
            </div>
        </div>
    </footer>
</div>
<script nonce="${esc(nonce)}">window.__CHARTS__=${chartJson};</script>
<script nonce="${esc(nonce)}">${CHART_BOOTSTRAP}</script>
</body>
</html>`;
}

const DATA_UNAVAILABLE_ALERT = `    <div class="alert alert-warning" role="alert">
        <strong>${DATA_UNAVAILABLE_TEXT[0].toUpperCase()}${DATA_UNAVAILABLE_TEXT.slice(1)}.</strong>
        Sumber World Bank API tidak dapat dihubungi saat aplikasi dijalankan.
        Data akan dimuat otomatis pada pembaruan berikutnya (setiap 6 jam).
    </div>`;

function renderKpiCard(kpi: DashboardView["kpis"][number]): string {
  return `        <div class="col-md-4">
            <div class="card kpi-card h-100">
                <div class="card-body">
                    <div class="kpi-label">${esc(kpi.name)}</div>
                    <div class="kpi-value">${esc(kpi.formatted_value)}</div>
                    <div class="mt-2">
                        <span class="badge ${esc(kpi.change_badge_class)} status-badge">
                            ${esc(kpi.change_arrow)}${esc(kpi.formatted_change)}
                        </span>
                        ${kpi.comparison_label ? `<small class="text-muted">${esc(kpi.comparison_label)}</small>` : ""}
                    </div>
                    ${
                      kpi.status
                        ? `<div class="mt-2">
                        <span class="badge ${esc(kpi.status_badge_class)} status-badge">${esc(kpi.status)}</span>
                    </div>`
                        : ""
                    }
                    ${
                      kpi.date_label || kpi.source_label
                        ? `<div class="mt-2">
                        ${kpi.date_label ? `<span class="badge bg-secondary status-badge">${esc(kpi.date_label)}</span>` : ""}
                        ${kpi.source_label ? `<span class="badge bg-light text-dark status-badge">${esc(kpi.source_label)}</span>` : ""}
                    </div>`
                        : ""
                    }
                    ${kpi.description ? `<div class="mt-2">\n                        <small class="text-muted">${esc(kpi.description)}</small>\n                    </div>` : ""}
                    <div class="mt-2">
                        <small class="text-muted">Diperbarui: ${esc(kpi.last_updated)}</small>
                    </div>
                </div>
            </div>
        </div>`;
}

function renderMacroKpi(mk: DashboardView["macro_kpis"][number]): string {
  return `    <div class="col-md-2 col-sm-4">
        <div class="card kpi-card h-100">
            <div class="card-body text-center">
                <div class="kpi-label">${esc(mk.name)}</div>
                <div class="kpi-value ${esc(mk.color)}">${esc(mk.value)}</div>
                <small class="text-muted">${esc(mk.date)}</small>
                ${mk.description ? `<div class="mt-1">\n                    <small class="text-muted">${esc(mk.description)}</small>\n                </div>` : ""}
                ${mk.source ? `<div class="mt-1">\n                    <small class="text-muted">Sumber: ${esc(mk.source)}</small>\n                </div>` : ""}
                <div class="mt-1">
                    <small class="text-muted">Diperbarui: ${esc(mk.last_updated)}</small>
                </div>
            </div>
        </div>
    </div>`;
}

/**
 * The macro chart row. The row is always emitted (as in the Jinja template);
 * each of the three cards renders its own container, with the placeholder when
 * that series has no rows.
 */
function renderMacroCharts(charts: DashboardView["charts"]): string {
  return Object.entries(MACRO_CHART_TITLES)
    .map(
      ([id, title]) => `        <div class="col-md-4">
            <div class="card h-100">
                <div class="card-body">
                    <h5 class="section-title">${esc(title)}</h5>
${chartMount(id, charts[id])}
                </div>
            </div>
        </div>`,
    )
    .join("\n");
}

export { formatMonthId };
