/**
 * KPI cards, insight text and micro metrics — TypeScript port of `compute_kpis()`,
 * `format_value()`, `format_change()`, `generate_insight()`,
 * `build_inflation_snapshot()`, `_format_month_id()`, `_compute_micro_metrics()`
 * and `generate_micro_insight()` from `app.py`.
 *
 * Every number here comes from the caller's DB rows. Nothing is hardcoded except
 * the IMF WEO projection and the assumption constants that `app.py` itself
 * hardcodes (BBM 2014/2020 baselines, 20 L/month consumption, Susenas
 * expenditure) — those are ported verbatim so the output stays comparable.
 *
 * The insight text is deliberately NOT cached by value: it is recomputed from the
 * rows on every request, exactly like the Flask version, so the wording follows
 * the data. `test_insight_dynamic.py` covers 21 scenarios and each branch below
 * mirrors one of them.
 */

import {
  BI_TARGET_CENTER,
  BI_TARGET_HIGH,
  BI_TARGET_LOW,
  UMP_PROVINSI,
} from "./fetchers";
import type { AllDataEntry, IndicatorDataRow, SeriesRow } from "./db";

// Indicator codes. Defined once so a typo cannot silently desynchronise the
// formatting logic from the fetch/schema logic.
export const GDP_GROWTH_CODE = "NY.GDP.MKTP.KD.ZG";
export const INFLATION_CODE = "FP.CPI.TOTL.ZG";
export const TRADE_BALANCE_CODE = "BN.GSR.GNFS.CD";

// IMF WEO hardcoded projection (April 2026 WEO for Indonesia) — port of
// `PROJECTION`. The Flask version labels this "Data Historis (Estimasi)".
export const PROJECTION: Array<{ year: number; pdb: number; inflasi: number }> = [
  { year: 2024, pdb: 5.0, inflasi: 2.5 },
  { year: 2025, pdb: 5.1, inflasi: 1.9 },
  { year: 2026, pdb: 5.2, inflasi: 2.3 },
  { year: 2027, pdb: 5.3, inflasi: 2.5 },
];

const NOT_UPDATED = "Belum pernah update";

/** `f"{value:.2f}%"` / trade balance in billions USD. Port of `format_value()`. */
export function formatValue(code: string, value: number): string {
  if (code === TRADE_BALANCE_CODE) return `${(value / 1e9).toFixed(1)} miliar USD`;
  return `${value.toFixed(2)}%`;
}

/**
 * Year-over-year change with the indicator's own unit. Port of `format_change()`.
 *
 * Percentage indicators change in percentage points ("pp"); the trade balance
 * changes in USD, so it is shown as an absolute amount. Labelling a USD delta
 * as "pp" produces nonsense like "+829****3081.86 pp".
 */
export function formatChange(code: string, change: number): string {
  if (code === TRADE_BALANCE_CODE) return `${(Math.abs(change) / 1e9).toFixed(1)} miliar USD`;
  return `${Math.abs(change).toFixed(2)} pp`;
}

/** `f"{value:,.0f}"` with Indonesian grouping (1.234.567). */
export function rupiah(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** `f"{value:,.1f}"` / `{:,.2f}` with Indonesian grouping. */
export function num(value: number, decimals = 1): string {
  const fixed = value.toFixed(decimals);
  const [int, frac] = fixed.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return frac === undefined ? grouped : `${grouped},${frac}`;
}

const BULAN_ID: Record<string, string> = {
  "01": "Januari", "02": "Februari", "03": "Maret", "04": "April",
  "05": "Mei", "06": "Juni", "07": "Juli", "08": "Agustus",
  "09": "September", "10": "Oktober", "11": "November", "12": "Desember",
};

/**
 * `'2026-09-01'` → `'September 2026'` (Indonesian month names).
 * Port of `_format_month_id()`. On a malformed string it returns the input
 * unchanged, matching the Python `except` branch.
 */
export function formatMonthId(dateStr: string): string {
  const parts = (dateStr ?? "").split("-");
  if (parts.length < 2) return dateStr;
  return `${BULAN_ID[parts[1]] ?? parts[1]} ${parts[0]}`;
}

/** An inflation reading: either the annual World Bank row or the monthly BPS row. */
export interface InflasiReading {
  value: number;
  /** `YYYY` for the World Bank annual row. */
  year: number | null;
  /** `YYYY-MM-DD` for the monthly BPS row. */
  date?: string;
}

// ---------------------------------------------------------------------------
// KPI cards
// ---------------------------------------------------------------------------

export interface KpiCard {
  code: string;
  name: string;
  formatted_value: string;
  formatted_change: string;
  change_arrow: string;
  change_badge_class: string;
  status: string | null;
  status_badge_class: string | null;
  comparison_label: string;
  date_label?: string;
  source_label?: string;
  description?: string;
  last_updated: string;
}

/**
 * KPI cards for the annual World Bank indicators.
 * Port of `compute_kpis()` — note the World Bank inflation indicator is skipped
 * on purpose: the inflation card comes from the monthly BPS series instead, and
 * is inserted at the front by `computeDashboardKpis()`.
 */
export function computeKpis(
  data: Record<string, AllDataEntry>,
  lastUpdated: (code: string) => string | null,
): KpiCard[] {
  const kpis: KpiCard[] = [];
  for (const [code, info] of Object.entries(data)) {
    if (code === INFLATION_CODE) continue;
    const rows = info.data; // desc by year
    if (rows.length === 0) continue;

    const latest = rows[0];
    const prev = rows.length > 1 ? rows[1] : null;
    const change = prev ? latest.value - prev.value : 0;
    const hasPrev = prev !== null;
    const arrow = change > 0 ? "+" : change < 0 ? "-" : "";
    kpis.push({
      code,
      name: info.name,
      formatted_value: formatValue(code, latest.value),
      formatted_change: hasPrev ? formatChange(code, change) : "Data tidak cukup",
      change_arrow: hasPrev ? arrow : "",
      change_badge_class: hasPrev ? (change >= 0 ? "bg-success" : "bg-danger") : "bg-secondary",
      status: null,
      status_badge_class: null,
      comparison_label: "vs tahun lalu",
      last_updated: lastUpdated(code) ?? NOT_UPDATED,
    });
  }
  return kpis;
}

/**
 * Full KPI list for `/`: the annual World Bank inflation card first, then the
 * monthly BPS inflation card, then the other indicators.
 * Port of the KPI assembly in `dashboard()`.
 *
 * The order matters and is easy to get wrong: `dashboard()` does
 * `insert(0, bps)` **then** `insert(0, wb)`, so the World Bank card ends up in
 * front. Inserting in the same sequence here (BPS first, then WB) reproduces it.
 */
export function computeDashboardKpis(
  data: Record<string, AllDataEntry>,
  inflationYoyLatest: SeriesRow | null,
  inflationYoyData: SeriesRow[],
  lastUpdated: (code: string) => string | null,
): KpiCard[] {
  const kpis = computeKpis(data, lastUpdated);

  // Card "Inflasi YoY (BPS)" — monthly. Inserted first because the World Bank
  // card below is inserted after it and therefore lands in front.
  if (inflationYoyLatest) {
    const val = inflationYoyLatest.value;
    const monthYear = formatMonthId(inflationYoyLatest.date);

    let status: string;
    let statusBadge: string;
    if (val < BI_TARGET_LOW) {
      status = "Di bawah target BI";
      statusBadge = "bg-info";
    } else if (val <= BI_TARGET_HIGH) {
      status = "Dalam target BI";
      statusBadge = "bg-success";
    } else {
      status = "Di atas target BI";
      statusBadge = "bg-danger";
    }

    const prevRow = inflationYoyData.length >= 2 ? inflationYoyData[inflationYoyData.length - 2] : null;
    let arrow = "";
    let changeBadge = "bg-secondary";
    let formattedChange = "Data tidak cukup";
    let comparisonLabel = "";
    if (prevRow) {
      const momChange = val - prevRow.value;
      arrow = momChange > 0 ? "+" : momChange < 0 ? "-" : "";
      // Rising inflation is bad news → red; falling → green. (Matches app.py.)
      changeBadge = momChange > 0 ? "bg-danger" : "bg-success";
      formattedChange = `${arrow}${Math.abs(momChange).toFixed(2)} pp`;
      comparisonLabel = "vs bulan lalu";
    }

    kpis.unshift({
      code: "inflation_yoy",
      name: "Inflasi YoY (BPS)",
      formatted_value: `${val.toFixed(2)}%`,
      formatted_change: formattedChange,
      change_arrow: arrow,
      change_badge_class: changeBadge,
      status,
      status_badge_class: statusBadge,
      comparison_label: comparisonLabel,
      date_label: monthYear,
      source_label: "BPS",
      last_updated: inflationYoyLatest.fetched_at ?? NOT_UPDATED,
    });
  }

  const wbInfo = data[INFLATION_CODE];
  const wbLatest = wbInfo?.latest ?? null;
  const wbPrev = wbInfo && wbInfo.data.length > 1 ? wbInfo.data[1] : null;

  // Card "Inflasi Tahunan (World Bank)" — annual data, separate from the BPS card.
  // Inserted last so it is the first card on the page, as in `dashboard()`.
  if (wbLatest) {
    const change = wbPrev ? wbLatest.value - wbPrev.value : 0;
    const arrow = change > 0 ? "+" : change < 0 ? "-" : "";
    kpis.unshift({
      code: INFLATION_CODE,
      name: "Inflasi Tahunan (World Bank)",
      formatted_value: `${wbLatest.value.toFixed(2)}%`,
      formatted_change: wbPrev ? `${arrow}${Math.abs(change).toFixed(2)} pp` : "Data tidak cukup",
      change_arrow: arrow,
      change_badge_class: change >= 0 ? "bg-success" : "bg-danger",
      status: null,
      status_badge_class: null,
      comparison_label: wbPrev ? "vs tahun lalu" : "",
      date_label: String(wbLatest.year),
      source_label: "World Bank",
      description: "Rata-rata inflasi seluruh tahun",
      last_updated: lastUpdated(INFLATION_CODE) ?? NOT_UPDATED,
    });
  }

  return kpis;
}

// ---------------------------------------------------------------------------
// Macro KPI cards
// ---------------------------------------------------------------------------

export interface MacroKpi {
  name: string;
  value: string;
  date: string;
  color: string;
  last_updated: string;
  description?: string;
  source?: string;
}

/** Port of the macro-KPI assembly in `dashboard()` (BI-Rate → literacy). */
export function computeMacroKpis(
  latest: Record<string, SeriesRow | null>,
): MacroKpi[] {
  const out: MacroKpi[] = [];
  const stamp = (r: SeriesRow | null) => r?.fetched_at ?? NOT_UPDATED;

  if (latest.bi_rate) {
    out.push({
      name: "BI-Rate",
      value: `${latest.bi_rate.value.toFixed(2)}%`,
      date: latest.bi_rate.date,
      color: "text-success",
      last_updated: stamp(latest.bi_rate),
    });
  }
  if (latest.usd_idr) {
    out.push({
      name: "Kurs USD/IDR",
      value: rupiah(latest.usd_idr.value),
      date: latest.usd_idr.date,
      color: "text-info",
      last_updated: stamp(latest.usd_idr),
    });
  }
  if (latest.gini) {
    out.push({
      name: "Rasio Gini",
      value: latest.gini.value.toFixed(1),
      date: latest.gini.date,
      color: "text-warning",
      last_updated: stamp(latest.gini),
    });
  }
  if (latest.life_exp) {
    out.push({
      name: "Usia Harapan Hidup",
      value: `${latest.life_exp.value.toFixed(1)} thn`,
      date: latest.life_exp.date,
      color: "text-primary",
      last_updated: stamp(latest.life_exp),
    });
  }
  if (latest.edu_exp) {
    out.push({
      name: "Pendidikan (% PDB)",
      value: `${latest.edu_exp.value.toFixed(1)}%`,
      date: latest.edu_exp.date,
      color: "text-secondary",
      last_updated: stamp(latest.edu_exp),
      description:
        `Alokasi belanja pendidikan Indonesia sebesar ${latest.edu_exp.value.toFixed(1)}% PDB ` +
        `(${latest.edu_exp.date.slice(0, 4)}). Angka ini menunjukkan kontribusi sektor ` +
        `pendidikan terhadap ekonomi nasional.`,
      source: "World Bank (SE.XPD.TOTL.GD.ZS)",
    });
  }
  if (latest.literacy) {
    out.push({
      name: "Literasi",
      value: `${latest.literacy.value.toFixed(1)}%`,
      date: latest.literacy.date,
      color: "text-dark",
      last_updated: stamp(latest.literacy),
      description:
        `Tingkat literasi dasar (baca tulis) Indonesia mencapai ` +
        `${latest.literacy.value.toFixed(1)}% (${latest.literacy.date.slice(0, 4)}). ` +
        `Data BPS mengukur kemampuan penduduk usia 15+ untuk membaca dan menulis.`,
      source: "World Bank (SE.ADT.LITR.ZS)",
    });
  }

  // PISA 2022 card — a published OECD figure, hardcoded in app.py as well.
  out.push({
    name: "Literasi Membaca (PISA 2022)",
    value: "359",
    date: "2022",
    color: "text-danger",
    last_updated: "2022-12-31",
    description:
      "Skor membaca PISA 2022 Indonesia 359 (OECD avg 476). " +
      "Hanya 25% siswa usia 15 thn memadai (OECD avg 74%). " +
      "Peringkat 73/80 negara.",
    source: "OECD PISA 2022",
  });

  return out;
}

// ---------------------------------------------------------------------------
// Dashboard insight
// ---------------------------------------------------------------------------

/**
 * Insight text from the latest data. Port of `generate_insight()`.
 *
 * Recomputed from whatever is in the database, so the text follows the data
 * after each scheduled refresh. `bpsInflation` (monthly BPS) takes priority over
 * the annual World Bank inflation row, exactly as in the Flask version.
 */
export function generateInsight(
  data: Record<string, AllDataEntry>,
  bpsInflation?: SeriesRow | null,
): string {
  const pdbInfo = data[GDP_GROWTH_CODE];
  const inflasiInfo = data[INFLATION_CODE];
  const tradeInfo = data[TRADE_BALANCE_CODE];

  const pdb = pdbInfo?.latest ?? null;
  const trade = tradeInfo?.latest ?? null;

  // `inflasi` is the union of the annual World Bank row and the monthly BPS row;
  // callers pass whichever source they are rendering.
  const inflasi: InflasiReading | null = bpsInflation
    ? { value: bpsInflation.value, year: null, date: bpsInflation.date }
    : inflasiInfo?.latest
      ? { value: inflasiInfo.latest.value, year: inflasiInfo.latest.year }
      : null;

  const pdbRows = pdbInfo?.data ?? [];
  const tradeRows = tradeInfo?.data ?? [];
  const pdbPrev = pdbRows.length > 1 ? pdbRows[1] : null;
  const tradePrev = tradeRows.length > 1 ? tradeRows[1] : null;

  const parts: string[] = [];

  // 1. PDB Growth — with YoY trend context
  if (pdb) {
    const val = pdb.value;
    let trend: string;
    if (pdbPrev) {
      const change = val - pdbPrev.value;
      if (change > 0) trend = "solid dan membaik";
      else if (val >= 5.0) trend = "masih solid meskipun melambat";
      else if (val >= 4.5) trend = "melambat";
      else trend = "moderat";
    } else {
      trend = val >= 5.0 ? "solid" : "moderat";
    }

    parts.push(
      `Pertumbuhan PDB ${val.toFixed(1)}% (${pdb.year}) menunjukkan ` +
        `perekonomian Indonesia ${trend}. ` +
        `Bagi pebisnis, kondisi ini ` +
        `${val >= 5.0 ? "mendukung ekspansi pasar domestik" : "mendorong kehati-hatian dalam ekspansi"}.`,
    );
  }

  // 2. Inflasi — 3 granular conditions; BPS monthly preferred
  if (inflasi) {
    const val = inflasi.value;
    let kondisi: string;
    if (val < 2.0) {
      kondisi = "di bawah target BI (2-4%), memberi ruang kebijakan moneter yang akomodatif";
    } else if (val <= 4.0) {
      kondisi = "berada dalam target BI (2-4%)";
    } else {
      kondisi = "di atas target BI (2-4%), menekan ruang kebijakan moneter";
    }

    const sourceLabel = bpsInflation ? "BPS (IHK YoY)" : String(inflasi.year);
    const dateLabel = bpsInflation ? formatMonthId(inflasi.date ?? "") : String(inflasi.year);
    // BPS monthly: 2 decimals (3.28%). World Bank annual: 1 decimal (1.9%).
    const valStr = bpsInflation ? val.toFixed(2) : val.toFixed(1);
    parts.push(`Inflasi ${valStr}% (${dateLabel}, ${sourceLabel}) ${kondisi}.`);
  }

  // 3. Trade Balance — magnitude + YoY trend
  if (trade) {
    const val = trade.value;
    const surplus = val > 0;
    const magnitude = Math.abs(val) / 1e9;

    let desc: string;
    if (surplus) {
      if (magnitude >= 20) desc = "surplus besar";
      else if (magnitude >= 10) desc = "surplus moderat";
      else desc = "surplus kecil";
    } else {
      if (magnitude >= 20) desc = "defisit besar";
      else if (magnitude >= 10) desc = "defisit moderat";
      else desc = "defisit kecil";
    }

    let yoyText = "";
    if (tradePrev) {
      const prevVal = tradePrev.value;
      if (surplus && prevVal > 0) yoyText = val > prevVal ? ", surplus melebar" : ", surplus menyempit";
      else if (!surplus && prevVal < 0) yoyText = val < prevVal ? ", defisit melebar" : ", defisit menyempit";
      else if (surplus && prevVal <= 0) yoyText = ", berubah dari defisit";
      else if (!surplus && prevVal >= 0) yoyText = ", berubah dari surplus";
    }

    parts.push(
      `Neraca perdagangan mencatat ${desc} ` +
        `${magnitude.toFixed(1)} miliar USD (${trade.year})${yoyText}, ` +
        `mencerminkan ${surplus ? "kinerja ekspor yang kuat" : "tekanan pada sektor perdagangan"}.`,
    );
  }

  // 4. Combined macro condition
  if (pdb && inflasi) {
    const pdbVal = pdb.value;
    const infVal = inflasi.value;
    if (pdbVal >= 5.0 && infVal < 2.0) {
      parts.push("Kombinasi pertumbuhan tinggi dan inflasi rendah menciptakan kondisi makro yang mendukung ekspansi.");
    } else if (pdbVal < 4.5 && infVal > 4.0) {
      parts.push("Pertumbuhan yang melambat dengan inflasi tinggi memerlukan kehati-hatian dalam pengambilan keputusan.");
    }
  }

  return parts.join(" ");
}

/**
 * Inflation insight snapshot: current vs year-ago comparison.
 * Port of `build_inflation_snapshot()`.
 */
export function buildInflationSnapshot(latest: SeriesRow | null, yearAgo: SeriesRow | null): string {
  if (!latest) return "";
  const val = latest.value;
  const monthYear = formatMonthId(latest.date);

  let corridorStatus: string;
  if (val >= BI_TARGET_LOW && val <= BI_TARGET_HIGH) corridorStatus = "masih berada di dalam target BI";
  else if (val < BI_TARGET_LOW) corridorStatus = "berada di bawah target BI";
  else corridorStatus = "berada di atas target BI";

  if (yearAgo) {
    const prevVal = yearAgo.value;
    const prevMonthYear = formatMonthId(yearAgo.date);
    const delta = val - prevVal;
    let trend: string;
    if (Math.abs(delta) < 0.005) trend = "sama dengan";
    else if (delta > 0) trend = `naik ${delta.toFixed(2)} pp dari`;
    else trend = `turun ${Math.abs(delta).toFixed(2)} pp dari`;
    return (
      `Inflasi ${monthYear} tercatat ${val.toFixed(2)}% (yoy), ` +
      `${corridorStatus} (${BI_TARGET_CENTER.toFixed(1)}% ±1%). ` +
      `Angka ini ${trend} ${prevVal.toFixed(2)}% pada ${prevMonthYear}.`
    );
  }
  return (
    `Inflasi ${monthYear} tercatat ${val.toFixed(2)}% (yoy), ` +
    `${corridorStatus} (${BI_TARGET_CENTER.toFixed(1)}% ±1%).`
  );
}

// ---------------------------------------------------------------------------
// Micro economy metrics
// ---------------------------------------------------------------------------

export interface MicroMetrics {
  province: string;
  ump_monthly: number;
  ump_hourly: number;
  bbm_price: number;
  liters_per_ump: number;
  hours_per_liter: number;
  bbm_index: number;
  wage_index: number;
  bbm_vs_wage: number;
  bbm_burden: number;
  monthly_consumption: number;
  monthly_expenditure: number;
  bbm_index_2014: number;
  wage_index_2014: number;
}

/** Working hours per month — the Flask version uses 173 in both places. */
export const WORKING_HOURS_PER_MONTH = 173;

/**
 * Combined micro metrics for a province (or the national average).
 * Port of `_compute_micro_metrics()` — the 2014/2020 baselines, the 20 L/month
 * consumption and the Susenas expenditure are the same constants `app.py` uses,
 * so a different province or fuel price changes every derived number.
 */
export function computeMicroMetrics(province?: string | null, daerah = "jawa", bbmPrice?: number): MicroMetrics {
  const pertalite = bbmPrice ?? 10_000;

  let ump: number;
  if (province && province in UMP_PROVINSI) {
    ump = UMP_PROVINSI[province];
  } else {
    const values = Object.values(UMP_PROVINSI);
    ump = Math.trunc(values.reduce((a, b) => a + b, 0) / values.length);
  }

  const umpMonthly = ump * 1000; // Rupiah
  const umpHourly = umpMonthly / WORKING_HOURS_PER_MONTH;
  const litersPerUmp = umpMonthly / pertalite;
  const hoursPerLiter = pertalite / umpHourly;

  // Indices vs 2020 baseline
  const bbm2020 = 6500;
  const ump2020 = 2800;
  const bbmIndex = (pertalite / bbm2020) * 100;
  const wageIndex = (ump / ump2020) * 100;
  const bbmVsWage = (bbmIndex / wageIndex) * 100;

  // Indices vs 2014 baseline (used by the insight text)
  const bbm2014 = 8500;
  const ump2014 = 2200;
  const bbmIndex2014 = (pertalite / bbm2014) * 100;
  const wageIndex2014 = (ump / ump2014) * 100;

  // Assumptions: 20 L/month consumption, BPS Susenas 2024 monthly expenditure.
  const monthlyConsumption = 20;
  const monthlyExpenditure = 5_000_000;
  const bbmBurden = ((monthlyConsumption * pertalite) / monthlyExpenditure) * 100;

  return {
    province: province || "Rata-rata Nasional",
    ump_monthly: umpMonthly,
    ump_hourly: umpHourly,
    bbm_price: pertalite,
    liters_per_ump: litersPerUmp,
    hours_per_liter: hoursPerLiter,
    bbm_index: bbmIndex,
    wage_index: wageIndex,
    bbm_vs_wage: bbmVsWage,
    bbm_burden: bbmBurden,
    monthly_consumption: monthlyConsumption,
    monthly_expenditure: monthlyExpenditure,
    bbm_index_2014: bbmIndex2014,
    wage_index_2014: wageIndex2014,
  };
}

export interface MicroInsight {
  main_findings: string[];
  additional_analysis: string[];
  deficit_info: {
    is_deficit: boolean;
    amount: number;
    percentage: number;
    ump: number;
    expenditure: number;
    province: string;
  };
  all_text: string;
}

/**
 * Dynamic insight for the micro economy page.
 * Port of `generate_micro_insight()` — all content is dynamic, no province name
 * or value is hardcoded.
 */
export function generateMicroInsight(
  metrics: MicroMetrics,
  ikkLatest?: SeriesRow | null,
  biRateLatest?: SeriesRow | null,
  inflationYoyLatest?: SeriesRow | null,
): MicroInsight {
  const {
    province, ump_monthly, bbm_price, liters_per_ump, hours_per_liter,
    bbm_index_2014, wage_index_2014, bbm_burden, monthly_consumption, monthly_expenditure,
  } = metrics;

  const mainFindings: string[] = [];

  mainFindings.push(
    `Dengan 1 bulan upah minimum di ${province} (Rp ${rupiah(ump_monthly)}), ` +
      `bisa membeli ${rupiah(liters_per_ump)} liter Pertalite. ` +
      `Ini menunjukkan daya beli upah terhadap kebutuhan bakar kendaraan.`,
  );

  mainFindings.push(
    `Pekerja di ${province} harus bekerja ${num(hours_per_liter)} jam untuk membeli 1 liter Pertalite. ` +
      `Semakin kecil angka ini, semakin ringan beban hidup.`,
  );

  const bbmChange = bbm_index_2014 - 100;
  const wageChange = wage_index_2014 - 100;
  let comparison: string;
  if (bbmChange > wageChange) comparison = "naik lebih cepat dari upah";
  else if (bbmChange < wageChange) comparison = "naik lebih lambat dari upah";
  else comparison = "naik seimbang dengan upah";
  mainFindings.push(
    `Sejak 2014, harga BBM naik ${bbmChange.toFixed(0)}% sedangkan upah naik ${wageChange.toFixed(0)}%. ` +
      `BBM ${comparison}.`,
  );

  const bbmSpending = monthly_consumption * bbm_price;
  mainFindings.push(
    `Keluaran Rp ${rupiah(bbmSpending)}/bulan habis untuk BBM, sekitar ${num(bbm_burden)}% ` +
      `dari total pengeluaran (Rp ${rupiah(monthly_expenditure)}/bulan).`,
  );

  const additionalAnalysis: string[] = [];

  const deficitAmount = ump_monthly - monthly_expenditure;
  const deficitPct = (Math.abs(deficitAmount) / monthly_expenditure) * 100;
  let deficitText: string;
  let isDeficit: boolean;
  if (deficitAmount < 0) {
    deficitText =
      `Catatan: Ump ${province} (Rp ${rupiah(ump_monthly)}) berada DI BAWAH rata-rata ` +
      `pengeluaran rumah tangga (Rp ${rupiah(monthly_expenditure)}), defisit ` +
      `Rp ${rupiah(Math.abs(deficitAmount))}/bulan (${num(deficitPct)}%). ` +
      `Upah minimum belum mencukupi kebutuhan hidup layak.`;
    isDeficit = true;
  } else {
    deficitText =
      `Ump ${province} (Rp ${rupiah(ump_monthly)}) melebihi rata-rata pengeluaran ` +
      `(Rp ${rupiah(monthly_expenditure)}), surplus Rp ${rupiah(deficitAmount)}/bulan.`;
    isDeficit = false;
  }
  additionalAnalysis.push(deficitText);

  const rasio = ump_monthly > 0 ? (monthly_expenditure / ump_monthly) * 100 : 0;
  additionalAnalysis.push(`Rasio pengeluaran terhadap pendapatan: ${num(rasio)}%`);

  const proj2027 = PROJECTION.find((p) => p.year === 2027);
  if (proj2027) {
    additionalAnalysis.push(
      `Jika inflasi tetap dalam target BI dan BI-Rate stabil, proyeksi PDB 2027 ` +
        `mencapai ${proj2027.pdb.toFixed(1)}% (IMF WEO).`,
    );
  }

  if (bbmChange > wageChange) {
    additionalAnalysis.push(
      "Jika harga BBM naik lebih cepat dari upah, beban rumah tangga akan meningkat " +
        "dan dapat menekan konsumsi.",
    );
  } else {
    additionalAnalysis.push("Jika harga BBM naik lebih lambat dari upah, daya beli relatif terjaga.");
  }

  if (ikkLatest) {
    const ikkVal = ikkLatest.value;
    if (ikkVal > 100) {
      additionalAnalysis.push(
        `Jika IKK tetap optimis (${num(ikkVal)} > 100), konsumsi rumah tangga ` +
          `menjadi penopang pertumbuhan.`,
      );
    } else {
      additionalAnalysis.push(
        `Jika IKK tetap di bawah 100 (${num(ikkVal)}), konsumsi rumah tangga dapat melemah.`,
      );
    }
  }

  return {
    main_findings: mainFindings,
    additional_analysis: additionalAnalysis,
    deficit_info: {
      is_deficit: isDeficit,
      amount: Math.abs(deficitAmount),
      percentage: deficitPct,
      ump: ump_monthly,
      expenditure: monthly_expenditure,
      province,
    },
    all_text: [...mainFindings, ...additionalAnalysis].join(" "),
  };
}

/** Port of the historical series constants used by the BBM-vs-upah chart. */
export const BBM_HISTORY: Array<[string, number]> = [
  ["2014-01-01", 8500], ["2014-11-01", 10500], ["2015-01-01", 7500],
  ["2015-05-01", 8500], ["2016-01-01", 6500], ["2016-07-01", 7500],
  ["2017-01-01", 7000], ["2018-01-01", 7500], ["2019-01-01", 7500],
  ["2020-01-01", 7500], ["2021-01-01", 8000], ["2022-04-01", 9500],
  ["2022-09-01", 12000], ["2023-01-01", 10500], ["2024-01-01", 11000],
  ["2025-01-01", 13000], ["2026-01-01", 13000],
];

export const UMP_HISTORY: Array<[string, number]> = [
  ["2014-01-01", 2200], ["2015-01-01", 2500], ["2016-01-01", 2800],
  ["2017-01-01", 3000], ["2018-01-01", 3200], ["2019-01-01", 3400],
  ["2020-01-01", 3400], ["2021-01-01", 3400], ["2022-01-01", 3500],
  ["2023-01-01", 3600], ["2024-01-01", 3700], ["2025-01-01", 3750],
  ["2026-01-01", 3800],
];

/** Aliases: common province/region names → `BBM_PER_DAERAH` keys. Port of `DAERAH_ALIASES`. */
export const DAERAH_ALIASES: Record<string, string> = {
  Aceh: "aceh_sumut",
  "Sumatera Utara": "aceh_sumut",
  Sumut: "aceh_sumut",
  Jambi: "aceh_sumut",
  Bengkulu: "aceh_sumut",
  "Sumatera Selatan": "aceh_sumut",
  Sumsel: "aceh_sumut",
  Lampung: "aceh_sumut",
  "Bangka Belitung": "aceh_sumut",
  Babel: "aceh_sumut",
  "Sumatera Barat": "sumbar_riau",
  Sumbar: "sumbar_riau",
  Riau: "sumbar_riau",
  "Kepulauan Riau": "sumbar_riau",
  Kepri: "sumbar_riau",
  "Kalimantan Utara": "sumbar_riau",
  Kalut: "sumbar_riau",
  Jawa: "jawa",
  "Jawa Barat": "jawa",
  Jabar: "jawa",
  "Jawa Tengah": "jawa",
  Jateng: "jawa",
  "Jawa Timur": "jawa",
  Jatim: "jawa",
  "DKI Jakarta": "jawa",
  Jakarta: "jawa",
  Banten: "jawa",
  "DI Yogyakarta": "jawa",
  Yogyakarta: "jawa",
  Bali: "jawa",
  "Nusa Tenggara Barat": "jawa",
  NTB: "jawa",
  "Nusa Tenggara Timur": "indonesia_timur",
  NTT: "indonesia_timur",
  Maluku: "indonesia_timur",
  "Maluku Utara": "indonesia_timur",
  Papua: "indonesia_timur",
  "Papua Barat": "indonesia_timur",
  "Papua Tengah": "indonesia_timur",
  "Papua Pegunungan": "indonesia_timur",
  "Papua Selatan": "indonesia_timur",
  "Papua Barat Daya": "indonesia_timur",
  Sulawesi: "indonesia_timur",
  Kalimantan: "indonesia_timur",
  "Indonesia Timur": "indonesia_timur",
};

/** Resolve a `?daerah=` query value to a `BBM_PER_DAERAH` key. Port of the alias block in `micro_economy()`. */
export function resolveDaerah(raw: string | undefined, allowed: string[]): string {
  const key = raw?.trim() ?? "jawa";
  const resolved = DAERAH_ALIASES[key] ?? key;
  return allowed.includes(resolved) ? resolved : "jawa";
}

/** Rows to embed in the page for the client-side chart renderer. */
export interface IndicatorPayload {
  code: string;
  name: string;
  value: number;
  year: number | null;
  fetched_at: string;
}

export type { IndicatorDataRow };
