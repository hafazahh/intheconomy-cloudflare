/**
 * Micro economy page — TypeScript port of `templates/micro.html` (Jinja2) plus
 * the template context built in `micro_economy()` in `app.py`.
 *
 * Same contract as `render.ts`: every number comes from D1, the chart specs are
 * inlined as JSON, and the single inline bootstrap script carries the CSP nonce.
 */

import {
  getLatestSeries,
  getSeries,
  getSeriesMetadata,
  type SeriesRow,
} from "./db";
import { BBM_PER_DAERAH, UMP_PROVINSI } from "./fetchers";
import {
  buildBbmVsWageChart,
  buildIndexedChart,
  buildMicroChart,
  type ChartSpec,
} from "./charts";
import {
  BBM_HISTORY,
  UMP_HISTORY,
  computeMicroMetrics,
  generateMicroInsight,
  num,
  resolveDaerah,
  rupiah,
  type MicroMetrics,
} from "./kpi";
import { esc, jsonAttr } from "./render";

const DATA_UNAVAILABLE = `<p class='text-muted'>Data tidak tersedia</p>`;

const CHART_BOOTSTRAP = `(() => {
  const specs = window.__CHARTS__ || {};
  for (const id of Object.keys(specs)) {
    const el = document.getElementById(id);
    const spec = specs[id];
    if (el && spec) Plotly.newPlot(el, spec.data, spec.layout, spec.config || {});
  }
})();`;

export interface MicroView {
  charts: Record<string, ChartSpec | string>;
  metrics: MicroMetrics;
  latest: Record<string, (SeriesRow & { last_updated?: string }) | null>;
  provinces: string[];
  selected_province: string;
  selected_daerah: string;
  daerah_list: Record<string, { label: string; prices: Record<string, number> }>;
  insight: ReturnType<typeof generateMicroInsight>;
  macro_updated: string;
  micro_updated: string;
}

/** Port of `micro_economy()` — reads every series the page shows, from D1. */
export async function buildMicroView(
  db: D1Database,
  query: { daerah?: string; province?: string },
): Promise<MicroView> {
  const daerahKeys = Object.keys(BBM_PER_DAERAH);
  const selectedDaerah = resolveDaerah(query.daerah, daerahKeys);
  const selectedProvince = (query.province ?? "").trim();

  const goldData = await getSeries(db, "gold_gram", 30);
  const pertaliteData = await getSeries(db, `bbm_pertalite__${selectedDaerah}`, 30);
  const ikkData = await getSeries(db, "ikk", 12);
  const biRateData = await getSeries(db, "bi_rate", 12);
  const usdIdrData = await getSeries(db, "usd_idr", 30);

  // Gold vs BBM — both series normalised to an index (first value = 100),
  // port of the `emas_bbm_chart` block in `micro_economy()`.
  const emasBbmChart =
    goldData.length > 0 && pertaliteData.length > 0
      ? buildIndexedChart(
          [goldData, pertaliteData],
          ["Emas (indeks)", "Pertalite (indeks)"],
          ["#FFD700", "#dc3545"],
          "chart-emas-bbm",
          "Tanggal",
          "Indeks (base=100)",
        )
      : DATA_UNAVAILABLE;

  const ikkChart = ikkData.length
    ? buildMicroChart([ikkData], ["IKK"], ["#0d6efd"], "chart-ikk", "Tanggal", "IKK")
    : DATA_UNAVAILABLE;
  const biRateChart = biRateData.length
    ? buildMicroChart([biRateData], ["BI-Rate"], ["#6f42c1"], "chart-bi-rate-micro", "Tanggal", "%")
    : DATA_UNAVAILABLE;
  const usdIdrChart = usdIdrData.length
    ? buildMicroChart([usdIdrData], ["USD/IDR"], ["#20c997"], "chart-usd-idr-micro", "Tanggal", "IDR")
    : DATA_UNAVAILABLE;

  const pertaliteLatest = await getLatestSeries(db, `bbm_pertalite__${selectedDaerah}`);

  // Port of the Flask route's last two statements before the figure is built:
  //   bbm_history[-1] = ("2026-01-01", BBM_PER_DAERAH[selected_daerah]["prices"]["Pertalite"])
  // i.e. the *published per-region price*, not the newest stored observation.
  // The first version of this port used `pertaliteLatest.value` here, which made
  // the last point and one extra ↑/↓ annotation disagree with Flask whenever a
  // re-fetch had moved the stored price.
  const bbmHistory = BBM_HISTORY.slice();
  const publishedPertalite = BBM_PER_DAERAH[selectedDaerah]?.prices?.Pertalite;
  if (bbmHistory.length > 0 && publishedPertalite !== undefined) {
    bbmHistory[bbmHistory.length - 1] = ["2026-01-01", publishedPertalite];
  }
  const bbmVsWageChart = buildBbmVsWageChart(bbmHistory, UMP_HISTORY);

  const metrics = computeMicroMetrics(selectedProvince || null, selectedDaerah, pertaliteLatest?.value);

  const provinceList = Object.keys(UMP_PROVINSI).sort();

  const withTs = (r: SeriesRow | null) =>
    r ? { ...r, last_updated: r.fetched_at ?? "Belum pernah update" } : null;

  const latest = {
    gold_gram: withTs(await getLatestSeries(db, "gold_gram")),
    pertalite: withTs(pertaliteLatest),
    pertamax: withTs(await getLatestSeries(db, `bbm_pertamax__${selectedDaerah}`)),
    pertamax_turbo: withTs(await getLatestSeries(db, `bbm_pertamax_turbo__${selectedDaerah}`)),
    dexlite: withTs(await getLatestSeries(db, `bbm_dexlite__${selectedDaerah}`)),
    solar: withTs(await getLatestSeries(db, `bbm_solar__${selectedDaerah}`)),
    ikk: withTs(await getLatestSeries(db, "ikk")),
    bi_rate: withTs(await getLatestSeries(db, "bi_rate")),
    usd_idr: withTs(await getLatestSeries(db, "usd_idr")),
  };

  return {
    charts: {
      "chart-emas-bbm": emasBbmChart,
      "chart-ikk": ikkChart,
      "chart-bi-rate-micro": biRateChart,
      "chart-usd-idr-micro": usdIdrChart,
      "chart-bbm-vs-wage": bbmVsWageChart,
    },
    metrics,
    latest,
    provinces: provinceList,
    selected_province: metrics.province,
    selected_daerah: selectedDaerah,
    daerah_list: BBM_PER_DAERAH,
    insight: generateMicroInsight(metrics, latest.ikk, latest.bi_rate, await getLatestSeries(db, "inflation_yoy")),
    macro_updated: (await getSeriesMetadata(db, "macro_last_updated")) ?? "Belum pernah update",
    micro_updated: (await getSeriesMetadata(db, "micro_last_updated")) ?? "Belum pernah update",
  };
}

/** The micro page markup. */
export function renderMicro(view: MicroView, nonce: string): string {
  const m = view.metrics;
  const d = view.daerah_list[view.selected_daerah];
  const hasChart = (spec: ChartSpec | string): spec is ChartSpec => typeof spec === "object";

  return `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Micro Economy — Indonesia Economic Dashboard</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
    <script src="https://cdn.plot.ly/plotly-4.1.1.min.js"></script>
    <style>
        body { background-color: #f8f9fa; }
        .kpi-card { border: none; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); transition: transform 0.2s; }
        .kpi-card:hover { transform: translateY(-3px); }
        .kpi-value { font-size: 1.8rem; font-weight: 700; }
        .kpi-label { color: #6c757d; font-size: 0.85rem; }
        .insight-box { border-left: 4px solid #0d6efd; background: #e7f1ff; border-radius: 8px; }
        .section-title { font-weight: 600; margin-bottom: 1rem; }
        .chart-container { position: relative; height: 300px; }
        .metric-card { background: #fff; border-radius: 10px; padding: 1rem; border: 1px solid #dee2e6; }
        .metric-value { font-size: 1.5rem; font-weight: 700; color: #0d6efd; }
        .metric-label { font-size: 0.8rem; color: #6c757d; }
        .province-select { max-width: 300px; }
        .assumption-box { background: #fff3cd; border: 1px solid #ffc107; border-radius: 8px; padding: 0.75rem 1rem; }
        footer { margin-top: 3rem; padding: 1.5rem 0; border-top: 1px solid #dee2e6; }
    </style>
</head>
<body>
<div class="container py-4">
    <header class="mb-4">
        <div class="d-flex justify-content-between align-items-start flex-wrap gap-2">
            <div>
                <h1>Micro Economy</h1>
                <p class="text-muted">Perbandingan Emas vs BBM, IKK, dan Metrik Gabungan</p>
            </div>
            <a href="/" class="btn btn-outline-primary btn-sm">Dashboard Makro</a>
        </div>
    </header>

    <div class="card mb-4">
        <div class="card-body">
            <form method="get" action="/micro" class="row g-2 align-items-end">
                <div class="col-auto">
                    <label for="daerah" class="form-label mb-0">Pilih Wilayah (BBM)</label>
                </div>
                <div class="col-auto province-select">
                    <select name="daerah" id="daerah" class="form-select form-select-sm">
${Object.entries(view.daerah_list)
  .map(
    ([key, info]) =>
      `                        <option value="${esc(key)}"${key === view.selected_daerah ? " selected" : ""}>${esc(info.label)}</option>`,
  )
  .join("\n")}
                    </select>
                </div>
                <div class="col-auto">
                    <label for="province" class="form-label mb-0">Pilih Provinsi (UMP)</label>
                </div>
                <div class="col-auto province-select">
                    <select name="province" id="province" class="form-select form-select-sm">
                        <option value="">Rata-rata Nasional</option>
${view.provinces
  .map(
    (p) =>
      `                        <option value="${esc(p)}"${p === view.selected_province ? " selected" : ""}>${esc(p)}</option>`,
  )
  .join("\n")}
                    </select>
                </div>
                <div class="col-auto">
                    <button type="submit" class="btn btn-primary btn-sm">Tampilkan</button>
                </div>
            </form>
        </div>
    </div>

    <div class="row g-3 mb-4">
${renderMicroKpi("Emas 1gr", view.latest.gold_gram, rupiah(view.latest.gold_gram?.value ?? NaN), "text-warning", null)}
${renderMicroKpi("Pertalite", view.latest.pertalite, rupiah(view.latest.pertalite?.value ?? NaN), "text-danger", "Okt 2026")}
${renderMicroKpi("Pertamax", view.latest.pertamax, rupiah(view.latest.pertamax?.value ?? NaN), "text-danger", "Okt 2026")}
${renderMicroKpi("Pertamax Turbo", view.latest.pertamax_turbo, rupiah(view.latest.pertamax_turbo?.value ?? NaN), "text-danger", "Okt 2026")}
${renderMicroKpi("Dexlite", view.latest.dexlite, rupiah(view.latest.dexlite?.value ?? NaN), "text-danger", "Okt 2026")}
${renderMicroKpi("Solar", view.latest.solar, rupiah(view.latest.solar?.value ?? NaN), "text-danger", "Okt 2026")}
${renderMicroKpi("IKK", view.latest.ikk, view.latest.ikk ? view.latest.ikk.value.toFixed(1) : "", "text-primary", null)}
${renderMicroKpi("BI-Rate", view.latest.bi_rate, view.latest.bi_rate ? `${view.latest.bi_rate.value.toFixed(2)}%` : "", "text-success", null)}
${renderMicroKpi("USD/IDR", view.latest.usd_idr, rupiah(view.latest.usd_idr?.value ?? NaN), "text-info", null)}
    </div>

${renderChartSection("Perbandingan Emas vs BBM (Indeks)", view.charts["chart-emas-bbm"], "chart-emas-bbm", hasChart)}
    <div class="card mb-4">
        <div class="card-body">
            <h5 class="section-title">Indeks Harga BBM vs Indeks Upah Minimum
                <span class="badge bg-warning text-dark ms-2">Data Historis (Estimasi)</span>
            </h5>
            <div class="chart-container" id="chart-bbm-vs-wage"></div>
            <small class="text-muted">Indeks 2014=100. Anotasi ↑/↓ menandai kenaikan/penurunan harga BBM signifikan (>10%).</small>
            <br><small class="text-warning">⚠ Data historis BBM dan UMP adalah estimasi berdasarkan riwayat kebijakan harga.</small>
        </div>
    </div>

${renderChartSection("Indeks Keyakinan Konsumen (IKK)", view.charts["chart-ikk"], "chart-ikk", hasChart)}
${renderChartSection("BI-Rate", view.charts["chart-bi-rate-micro"], "chart-bi-rate-micro", hasChart)}
${renderChartSection("Kurs USD/IDR", view.charts["chart-usd-idr-micro"], "chart-usd-idr-micro", hasChart)}

    <div class="card mb-4">
        <div class="card-body">
            <h5 class="section-title">Metrik Gabungan — ${esc(m.province)} <span class="badge bg-warning text-dark ms-2">Data Oktober 2026</span></h5>
            <div class="row g-3">
                <div class="col-md-3 col-sm-6">
                    <div class="metric-card">
                        <div class="metric-value">${num(m.liters_per_ump)}</div>
                        <div class="metric-label">Liter Pertalite per Upah Minimum (${esc(m.province)})</div>
                    </div>
                </div>
                <div class="col-md-3 col-sm-6">
                    <div class="metric-card">
                        <div class="metric-value">${num(m.hours_per_liter)}</div>
                        <div class="metric-label">Jam Kerja per Liter Pertalite</div>
                    </div>
                </div>
                <div class="col-md-3 col-sm-6">
                    <div class="metric-card">
                        <div class="metric-value">${num(m.bbm_vs_wage)}</div>
                        <div class="metric-label">Indeks BBM vs Indeks Upah</div>
                    </div>
                </div>
                <div class="col-md-3 col-sm-6">
                    <div class="metric-card">
                        <div class="metric-value">${num(m.bbm_burden)}%</div>
                        <div class="metric-label">Beban BBM terhadap Pengeluaran</div>
                    </div>
                </div>
            </div>

            <div class="assumption-box mt-3">
                <strong>Asumsi Perhitungan:</strong>
                <ul class="mb-0 mt-1">
                    <li>UMP ${esc(m.province)}: Rp ${rupiah(m.ump_monthly)}/bulan — <strong>BPS</strong></li>
                    <li>Upah per jam: Rp ${rupiah(m.ump_hourly)} (173 jam kerja/bulan)</li>
                    <li>Harga Pertalite (${esc(d?.label ?? view.selected_daerah)}): Rp ${rupiah(m.bbm_price)}/liter — <strong>Pertamina Patra Niaga</strong></li>
                    <li>Konsumsi BBM: ${m.monthly_consumption} liter/bulan (asumsi)</li>
                    <li>Total pengeluaran: Rp ${rupiah(m.monthly_expenditure)}/bulan — <strong>BPS Susenas 2024</strong></li>
                    <li>Indeks BBM &amp; upah: base 2020 (Pertalite Rp 6.500, UMP Rp 2.800)</li>
                </ul>
            </div>
        </div>
    </div>

    <div class="card mb-4">
        <div class="card-body">
            <h5 class="section-title">💡 Insight (dynamic, per daerah)</h5>

            <div class="insight-box p-3 mb-3">
                <h6 class="fw-bold mb-2">Temuan utama</h6>
                <ul class="mb-0" style="font-size: 0.95rem; line-height: 1.6;">
${view.insight.main_findings.map((f) => `                    <li>${esc(f)}</li>`).join("\n")}
                </ul>
            </div>

            <div class="insight-box p-3 mb-3">
                <h6 class="fw-bold mb-2">Analisis tambahan</h6>
                <ul class="mb-0" style="font-size: 0.95rem; line-height: 1.6;">
${view.insight.additional_analysis.map((f) => `                    <li>${esc(f)}</li>`).join("\n")}
                </ul>
            </div>

${
  view.insight.deficit_info.is_deficit
    ? `            <div class="alert alert-warning mb-0" style="font-size: 0.95rem; line-height: 1.6;">
                <strong>⚠️ Defisit UMP vs Pengeluaran</strong><br>
                UMP ${esc(view.insight.deficit_info.province)} (Rp ${rupiah(view.insight.deficit_info.ump)}) berada DI BAWAH rata-rata pengeluaran rumah tangga (Rp ${rupiah(view.insight.deficit_info.expenditure)}), defisit Rp ${rupiah(view.insight.deficit_info.amount)}/bulan (${num(view.insight.deficit_info.percentage)}%). Upah minimum belum mencukupi kebutuhan hidup layak.
            </div>`
    : `            <div class="alert alert-success mb-0" style="font-size: 0.95rem; line-height: 1.6;">
                <strong>✅ Surplus UMP vs Pengeluaran</strong><br>
                UMP ${esc(view.insight.deficit_info.province)} (Rp ${rupiah(view.insight.deficit_info.ump)}) melebihi rata-rata pengeluaran (Rp ${rupiah(view.insight.deficit_info.expenditure)}), surplus Rp ${rupiah(view.insight.deficit_info.amount)}/bulan.
            </div>`
}
        </div>
    </div>

    <footer>
        <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
            <div>
                <strong>Sumber Data:</strong> Bank Indonesia (BI-Rate, IKK), Frankfurter (USD/IDR), World Bank (Gini), Logam Mulia (Emas), Pertamina (BBM), BPS/Kemnaker (UMP), BPS Susenas (pengeluaran rumah tangga)
                &nbsp;|&nbsp;
                <strong>Makro Updated:</strong> ${esc(view.macro_updated)}
                &nbsp;|&nbsp;
                <strong>Micro Updated:</strong> ${esc(view.micro_updated)}
            </div>
            <div>
                <a href="/download/csv" class="btn btn-outline-primary btn-sm">Download CSV</a>
            </div>
        </div>
    </footer>
</div>
<script nonce="${esc(nonce)}">window.__CHARTS__=${jsonAttr(view.charts)};</script>
<script nonce="${esc(nonce)}">${CHART_BOOTSTRAP}</script>
</body>
</html>`;
}

function renderMicroKpi(
  label: string,
  row: (SeriesRow & { last_updated?: string }) | null,
  value: string,
  color: string,
  badge: string | null,
): string {
  return `        <div class="col-md-2 col-sm-4">
            <div class="card kpi-card h-100">
                <div class="card-body text-center">
                    <div class="kpi-label">${esc(label)}${badge ? ` <span class="badge bg-warning text-dark ms-1" title="Data Oktober 2026">${esc(badge)}</span>` : ""}</div>
                    <div class="kpi-value ${esc(color)}">
                        ${row ? esc(value) : "-"}
                    </div>
                    <small class="text-muted">${row ? esc(row.date) : ""}</small>
                    ${row ? `<br><small class="text-muted">Diperbarui: ${esc(row.last_updated)}</small>` : ""}
                </div>
            </div>
        </div>`;
}

function renderChartSection(
  title: string,
  spec: ChartSpec | string,
  id: string,
  hasChart: (s: ChartSpec | string) => s is ChartSpec,
): string {
  if (!hasChart(spec)) {
    return `    <div class="card mb-4">
        <div class="card-body">
            <h5 class="section-title">${esc(title)}</h5>
            ${spec}
        </div>
    </div>`;
  }
  void id;
  return `    <div class="card mb-4">
        <div class="card-body">
            <h5 class="section-title">${esc(title)}</h5>
            <div class="chart-container" id="${esc(spec.id)}"></div>
        </div>
    </div>`;
}
