/**
 * Chart builders — TypeScript port of the Plotly builders in `app.py`.
 *
 * The Flask version called `plotly.py` and embedded the resulting HTML. Plotly
 * does not exist on Workers, so this module builds the *spec* (traces + layout)
 * and the client renders it with `Plotly.newPlot()` from the CDN. Each spec is
 * JSON-serialised into the page, which is what `acceptance` checks for
 * (`(chart.data||[]).length > 0`) — a div with no data is not a chart.
 *
 * Layout values are copied verbatim from `app.py` (`_base_layout()`,
 * `build_main_chart`, `build_single_chart`, `build_inflation_chart`,
 * `_build_micro_chart`, `bbm_vs_wage` figure) so the rendered charts are
 * visually identical, not merely similar.
 */

import type { SeriesRow } from "./db";
import { BI_TARGET_HIGH, BI_TARGET_LOW } from "./fetchers";

// ---------------------------------------------------------------------------
// CSP nonce
// ---------------------------------------------------------------------------

/**
 * Inline `<script>` blocks only — a tag carrying `src=` is covered by the host
 * allowlist in `script-src`, and a tag that already carries `nonce=` must not be
 * stamped twice. Identical regex to `app.py`'s `_INLINE_SCRIPT_RE`.
 */
const INLINE_SCRIPT_RE = /<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)/gi;

/**
 * Stamp every inline `<script>` in a rendered fragment with the CSP nonce.
 *
 * This lives here, not in `headers.ts`, because the chart payload is what makes
 * the pages depend on inline scripts: without a nonce the bootstrap script is
 * blocked by the browser in every real browser while curl still sees a 200.
 * `headers.ts` re-exports it so the CSP policy and the stamping share one
 * implementation — two copies of the regex would drift.
 */
export function applyNonce(html: string, nonce: string): string {
  return html.replace(INLINE_SCRIPT_RE, `<script nonce="${nonce}"`);
}

/** True when no inline script in `html` is left unstamped. */
export function hasUnstampedScripts(html: string): boolean {
  INLINE_SCRIPT_RE.lastIndex = 0;
  return INLINE_SCRIPT_RE.test(html);
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface Trace {
  type?: string;
  x: Array<string | number>;
  y: number[];
  mode?: string;
  name?: string;
  line?: Record<string, unknown>;
  marker?: Record<string, unknown>;
  fill?: string;
  fillcolor?: string;
  hoverinfo?: string;
}

export interface Layout {
  margin: { l: number; r: number; t: number; b: number };
  height: number;
  hovermode: string;
  legend: Record<string, unknown>;
  paper_bgcolor: string;
  plot_bgcolor: string;
  xaxis?: Record<string, unknown>;
  yaxis?: Record<string, unknown>;
  annotations?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface ChartSpec {
  /** Stable chart id — the client looks these up in `window.__CHARTS__`. */
  id: string;
  data: Trace[];
  layout: Layout;
  config: { displayModeBar: boolean };
}

// ---------------------------------------------------------------------------
// Shared layout — port of `_base_layout()`
// ---------------------------------------------------------------------------

export function baseLayout(): Layout {
  return {
    margin: { l: 50, r: 20, t: 20, b: 40 },
    height: 320,
    hovermode: "x unified",
    legend: { orientation: "h", yanchor: "bottom", y: 1.02, xanchor: "left", x: 0 },
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
  };
}

function axisTitles(xTitle: string, yTitle: string) {
  return {
    xaxis: { title: { text: xTitle }, showgrid: false },
    yaxis: { title: { text: yTitle }, gridcolor: "#e9ecef", zeroline: true },
  };
}

const CHART_CONFIG = { displayModeBar: false };

// ---------------------------------------------------------------------------
// Dashboard charts
// ---------------------------------------------------------------------------

/**
 * Combined 5-year line chart: PDB Growth + Inflasi.
 * Port of `build_main_chart()`.
 */
export function buildMainChart(
  years: number[],
  pdbValues: number[],
  inflasiValues: number[],
  id = "chart-main",
): ChartSpec {
  return {
    id,
    data: [
      {
        x: years,
        y: pdbValues,
        mode: "lines+markers",
        name: "PDB Growth (%)",
        line: { color: "#0d6efd", width: 3 },
        marker: { size: 8 },
      },
      {
        x: years,
        y: inflasiValues,
        mode: "lines+markers",
        name: "Inflasi (%)",
        line: { color: "#dc3545", width: 3 },
        marker: { size: 8 },
      },
    ],
    layout: { ...baseLayout(), ...axisTitles("Tahun", "Persen (%)") },
    config: CHART_CONFIG,
  };
}

/**
 * Single-indicator line chart with an area fill, for the detail section.
 * Port of `build_single_chart()`.
 */
export function buildSingleChart(
  x: Array<string | number>,
  values: number[],
  label: string,
  color: string,
  id = `chart-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
): ChartSpec {
  return {
    id,
    data: [
      {
        x,
        y: values,
        mode: "lines+markers",
        name: label,
        line: { color, width: 3 },
        marker: { size: 8 },
        fill: "tozeroy",
        fillcolor: color === "#0d6efd" ? "rgba(13,110,253,0.08)" : "rgba(220,53,69,0.08)",
      },
    ],
    layout: { ...baseLayout(), ...axisTitles("Tahun", "Persen (%)") },
    config: CHART_CONFIG,
  };
}

/**
 * Monthly inflation YoY chart with the BI target corridor (1.5%–3.5%) as a band.
 * Port of `build_inflation_chart()`.
 */
export function buildInflationChart(dates: string[], values: number[], id = "chart-inflation"): ChartSpec {
  return {
    id,
    data: [
      {
        x: [...dates, ...dates.slice().reverse()],
        y: [...Array(dates.length).fill(BI_TARGET_HIGH), ...Array(dates.length).fill(BI_TARGET_LOW)],
        fill: "toself",
        fillcolor: "rgba(40,167,69,0.1)",
        line: { color: "rgba(0,0,0,0)" },
        name: "Target BI (1.5%–3.5%)",
        hoverinfo: "skip",
      },
      {
        x: dates,
        y: values,
        mode: "lines+markers",
        name: "Inflasi YoY (%)",
        line: { color: "#dc3545", width: 3 },
        marker: { size: 7 },
      },
    ],
    layout: { ...baseLayout(), ...axisTitles("Bulan", "Persen (%)") },
    config: CHART_CONFIG,
  };
}

// ---------------------------------------------------------------------------
// Micro economy charts
// ---------------------------------------------------------------------------

/**
 * Multi-line chart for micro economy series.
 * Port of `_build_micro_chart()`.
 */
export function buildMicroChart(
  seriesList: SeriesRow[][],
  labels: string[],
  colors: string[],
  id: string,
  xTitle: string,
  yTitle: string,
): ChartSpec {
  // Accept already-indexed rows without a second copy of the series: callers
  // may pass `{ date, value }` rows where `value` is the index they want.
  return {
    id,
    data: seriesList.map((rows, i) => ({
      x: rows.map((r) => r.date),
      y: rows.map((r) => r.value),
      mode: "lines+markers",
      name: labels[i],
      line: { color: colors[i], width: 3 },
      marker: { size: 6 },
    })),
    layout: { ...baseLayout(), ...axisTitles(xTitle, yTitle) },
    config: CHART_CONFIG,
  };
}

/** Series with `y = value / first value * 100` (index, base = 100). */
export function toIndex(rows: SeriesRow[]): number[] {
  if (rows.length === 0) return [];
  const base = rows[0].value;
  if (!base) return rows.map(() => 0);
  return rows.map((r) => (r.value / base) * 100);
}

/**
 * Multi-line chart where each line is already an index series. Port of the
 * `emas_bbm_chart` block in `micro_economy()`, which normalises gold and
 * Pertalite to a base-100 index before plotting them on one axis.
 */
export function buildIndexedChart(
  seriesList: SeriesRow[][],
  labels: string[],
  colors: string[],
  id: string,
  xTitle: string,
  yTitle: string,
): ChartSpec {
  return buildMicroChart(
    seriesList.map((rows) => {
      const idx = toIndex(rows);
      return rows.map((r, i) => ({ ...r, value: idx[i] }));
    }),
    labels,
    colors,
    id,
    xTitle,
    yTitle,
  );
}

/**
 * BBM vs upah minimum, indexed to 2014 = 100, with annotations on any BBM
 * change larger than 10%. Port of the `bbm_vs_wage` figure in `app.py`.
 */
export function buildBbmVsWageChart(
  bbmHistory: Array<[string, number]>,
  umpHistory: Array<[string, number]>,
): ChartSpec {
  const bbmIdx = bbmHistory.map(([, v]) => (v / bbmHistory[0][1]) * 100);
  const umpIdx = umpHistory.map(([, v]) => (v / umpHistory[0][1]) * 100);

  const annotations: Array<Record<string, unknown>> = [];
  for (let i = 1; i < bbmHistory.length; i++) {
    const prevPrice = bbmHistory[i - 1][1];
    const currPrice = bbmHistory[i][1];
    if (prevPrice > 0 && Math.abs(currPrice - prevPrice) / prevPrice > 0.1) {
      annotations.push({
        x: bbmHistory[i][0],
        y: bbmIdx[i],
        text: `${currPrice > prevPrice ? "↑" : "↓"} BBM`,
        showarrow: true,
        arrowhead: 2,
        ax: 0,
        ay: -30,
        font: { size: 10, color: "#dc3545" },
      });
    }
  }

  return {
    id: "chart-bbm-vs-wage",
    data: [
      {
        x: bbmHistory.map(([d]) => d),
        y: bbmIdx,
        mode: "lines+markers",
        name: "Indeks Harga BBM",
        line: { color: "#dc3545", width: 3 },
        marker: { size: 8 },
      },
      {
        x: umpHistory.map(([d]) => d),
        y: umpIdx,
        mode: "lines+markers",
        name: "Indeks Upah Minimum",
        line: { color: "#0d6efd", width: 3 },
        marker: { size: 8 },
      },
    ],
    layout: {
      ...baseLayout(),
      ...axisTitles("Tahun", "Indeks (2014=100)"),
      annotations,
    },
    config: CHART_CONFIG,
  };
}
