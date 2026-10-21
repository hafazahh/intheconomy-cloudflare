/**
 * External data fetchers — TypeScript port of `data_fetcher.py` (55),
 * `macro_fetcher.py` (259), `micro_fetcher.py` (202) and the parts of
 * `backfill.py` that pull from live APIs.
 *
 * `requests` → `fetch()` with an AbortController timeout and bounded retries.
 * Ported behaviour:
 *   - Every source is fetched for real. Failures are reported, never invented.
 *   - Sources that need an API key (BPS) or that the publisher blocks
 *     (Pertamina) fall back to the same published/hardcoded baseline the Flask
 *     version used — that is ported verbatim, so numbers stay comparable.
 *   - BI-Rate reads the page's `HiddenFieldChartData` JSON blob (129 points back
 *     to 2016) instead of scraping `<td>` cells, which yields only the last 10.
 *   - The World Bank client uses a long timeout with retries: measured from this
 *     host, individual requests occasionally stall for ~130 s and then succeed
 *     on retry, so a 30 s single-shot timeout drops indicators entirely.
 */

import {
  INDICATOR_CODES,
  getLatestSeries,
  setLastUpdated,
  setSeriesMetadata,
  upsertSeries,
} from "./db";

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

/** Browser-like headers: BI and TradingEconomics abort connections without them. */
export const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
};

export interface FetchOutcome {
  ok: boolean;
  /** Parsed JSON body when `json: true` and the response parsed. */
  json?: unknown;
  /** Raw text body. */
  text?: string;
  status?: number;
  error?: string;
}

/**
 * GET with a hard timeout and bounded retries.
 *
 * `timeoutMs` defaults high (45 s) because the World Bank API intermittently
 * stalls: a measured probe of `SI.POV.GINI` returned in 40 ms four times and
 * took 129 220 ms once. A short timeout silently drops the indicator.
 */
export async function fetchWithRetry(
  url: string,
  opts: { timeoutMs?: number; retries?: number; headers?: Record<string, string>; json?: boolean } = {},
): Promise<FetchOutcome> {
  const timeoutMs = opts.timeoutMs ?? 45_000;
  const retries = opts.retries ?? 2;
  const headers = { ...HEADERS, ...(opts.headers ?? {}) };

  let lastError = "unknown error";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal, redirect: "follow" });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      if (opts.json) {
        try {
          return { ok: true, json: JSON.parse(text), text, status: res.status };
        } catch {
          lastError = "invalid JSON";
          continue;
        }
      }
      return { ok: true, text, status: res.status };
    } catch (e) {
      clearTimeout(timer);
      lastError =
        e instanceof Error && e.name === "AbortError"
          ? `timeout after ${timeoutMs}ms`
          : e instanceof Error
            ? e.message
            : String(e);
    }
  }
  return { ok: false, error: lastError };
}

// ---------------------------------------------------------------------------
// World Bank
// ---------------------------------------------------------------------------

export const WB_API = "https://api.worldbank.org/v2/country/IDN/indicator";

/** World Bank indicator code → time-series key (macro fetchers). */
export const WB_SERIES: Record<string, string> = {
  GINI_CODE: "SI.POV.GINI",
  LIFE_EXP_CODE: "SP.DYN.LE00.IN",
  EDU_EXP_CODE: "SE.XPD.TOTL.GD.ZS",
  LITERACY_CODE: "SE.ADT.LITR.ZS",
};

/** One World Bank observation. */
export interface WbEntry {
  value: number | null;
  date: string | null;
}

export interface WbResponse {
  meta: unknown;
  data: WbEntry[];
}

/**
 * Fetch one World Bank indicator and return its non-null observations.
 * Port of `data_fetcher.fetch_indicator()` + `macro_fetcher._fetch_wb_indicator()`.
 */
export async function fetchWbIndicator(
  code: string,
  perPage = 100,
): Promise<{ entries: WbEntry[]; error?: string }> {
  const url = `${WB_API}/${code}?format=json&per_page=${perPage}`;
  const res = await fetchWithRetry(url, { json: true });
  if (!res.ok) return { entries: [], error: res.error };
  const body = res.json as unknown;
  if (!Array.isArray(body) || body.length < 2) {
    return { entries: [], error: "malformed response" };
  }
  const raw = Array.isArray(body[1]) ? (body[1] as WbEntry[]) : [];
  return { entries: raw.filter((e) => e && e.value !== null && e.date !== null) };
}

/**
 * Store World Bank observations into `indicators`.
 * Port of `data_fetcher.fetch_indicator()` — one row per year.
 */
export async function storeWbIndicator(
  db: D1Database,
  code: string,
  name: string,
): Promise<{ stored: number; error?: string }> {
  const { entries, error } = await fetchWbIndicator(code);
  if (error) return { stored: 0, error };
  if (entries.length === 0) return { stored: 0, error: "no data returned" };

  const statements = entries.map((e) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO indicators (code, name, value, year, fetched_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(code, name, Number(e.value), Number(e.date), new Date().toISOString()),
  );
  await db.batch(statements);
  return { stored: entries.length };
}

/**
 * Store World Bank observations as a `time_series`, dated `YYYY-12-31`.
 * Port of `macro_fetcher._fetch_wb_indicator()` (annual series).
 */
export async function storeWbSeries(
  db: D1Database,
  seriesKey: string,
  code: string,
  fallback: Array<[string, number]>,
): Promise<{ stored: number; usedFallback: boolean; error?: string }> {
  const { entries, error } = await fetchWbIndicator(code);
  if (error || entries.length === 0) {
    const statements = fallback.map(([dateStr, value]) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO time_series (series_key, date, value, fetched_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(seriesKey, dateStr, value, new Date().toISOString()),
    );
    await db.batch(statements);
    return { stored: fallback.length, usedFallback: true, error };
  }
  const statements = entries.map((e) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO time_series (series_key, date, value, fetched_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(seriesKey, `${e.date}-12-31`, Number(e.value), new Date().toISOString()),
  );
  await db.batch(statements);
  return { stored: entries.length, usedFallback: false };
}

// World Bank fallback baselines. Ported verbatim from `macro_fetcher.WB_FALLBACK`
// (published figures scraped 2026-10-13) so a failed fetch stays comparable.
export const WB_FALLBACK: Record<string, Array<[string, number]>> = {
  life_exp: [
    ["2023-12-31", 71.9],
    ["2022-12-31", 71.7],
    ["2021-12-31", 71.3],
    ["2020-12-31", 71.0],
    ["2019-12-31", 71.5],
  ],
  edu_exp: [
    ["2023-12-31", 3.0],
    ["2022-12-31", 3.1],
    ["2021-12-31", 3.0],
    ["2020-12-31", 3.0],
    ["2019-12-31", 3.0],
  ],
};

// ---------------------------------------------------------------------------
// BI-Rate
// ---------------------------------------------------------------------------

export const BI_RATE_URL = "https://www.bi.go.id/id/statistik/indikator/bi-rate.aspx";

/**
 * BI-Rate fallback. Ported from `macro_fetcher.BI_RATE_KNOWN` — only used if the
 * page cannot be read or parsed at all.
 */
export const BI_RATE_KNOWN: Array<[string, number]> = [
  ["2026-09-23", 5.75],
  ["2026-08-19", 5.75],
  ["2026-07-22", 5.75],
  ["2026-06-18", 5.75],
  ["2026-06-09", 5.5],
  ["2026-05-20", 5.25],
  ["2026-04-22", 4.75],
  ["2026-03-17", 4.75],
  ["2026-02-19", 4.75],
  ["2026-01-21", 4.75],
];

/**
 * BI publishes the rate history as a hidden input holding
 * `[[epochMs, rate, "5,75 %"], ...]`. Reading that blob is more reliable than
 * the table markup and reaches back to 2016 instead of 10 rows.
 */
export function parseBiRateChartData(html: string): Array<[string, number]> {
  const m = html.match(/id="HiddenFieldChartData" value="([^"]*)"/);
  if (!m) return [];
  let raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  try {
    const arr = JSON.parse(raw) as Array<[number, number, string]>;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p) => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number")
      .map(([ts, rate]) => [new Date(ts).toISOString().slice(0, 10), rate] as [string, number]);
  } catch {
    return [];
  }
}

/**
 * Parse BI-Rate rows from the HTML table (Indonesian month names, comma decimal).
 * Port of `macro_fetcher._parse_bi_rate_html()`. Kept as the fallback when the
 * hidden blob is absent.
 */
export function parseBiRateHtml(html: string): Array<[string, number]> {
  const re = /<td[^>]*>\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s*<\/td>\s*<td[^>]*>\s*([\d,.]+)\s*%/gi;
  const bulanMap: Record<string, number> = {
    januari: 1, februari: 2, maret: 3, april: 4, mei: 5, juni: 6,
    juli: 7, agustus: 8, september: 9, oktober: 10, november: 11, desember: 12,
  };
  const out: Array<[string, number]> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const month = bulanMap[m[2].toLowerCase()];
    if (!month) continue;
    out.push([
      `${m[3]}-${String(month).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`,
      parseFloat(m[4].replace(",", ".")),
    ]);
  }
  return out;
}

/**
 * Fetch BI-Rate into the `bi_rate` series.
 * Port of `macro_fetcher.fetch_bi_rate()`.
 */
export async function fetchBiRate(db: D1Database): Promise<{ stored: number; usedFallback: boolean; latest?: [string, number] }> {
  const res = await fetchWithRetry(BI_RATE_URL, { timeoutMs: 30_000 });
  let rows: Array<[string, number]> = [];
  let usedFallback = false;

  if (res.ok && res.text) {
    rows = parseBiRateChartData(res.text);
    if (rows.length === 0) rows = parseBiRateHtml(res.text);
  }
  if (rows.length === 0) {
    if (!res.ok) console.log(`  BI-Rate: fetch failed (${res.error}), using fallback`);
    else console.log("  BI-Rate: no rows parsed from BI page, using fallback");
    rows = BI_RATE_KNOWN;
    usedFallback = true;
  }

  await db.batch(
    rows.map(([dateStr, rate]) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO time_series (series_key, date, value, fetched_at)
           VALUES ('bi_rate', ?, ?, ?)`,
        )
        .bind(dateStr, rate, new Date().toISOString()),
    ),
  );
  const newest = rows.slice().sort((a, b) => (a[0] < b[0] ? 1 : -1))[0];
  console.log(
    `  BI-Rate: ${rows.length} rows stored (latest=${newest[1]}% on ${newest[0]})` +
      (usedFallback ? " [FALLBACK]" : ""),
  );
  return { stored: rows.length, usedFallback, latest: newest };
}

// ---------------------------------------------------------------------------
// USD/IDR
// ---------------------------------------------------------------------------

export const USD_IDR_URL = "https://api.frankfurter.app/latest?from=USD&to=IDR";

/**
 * Fetch USD/IDR from frankfurter.app. Port of `macro_fetcher.fetch_usd_idr()`.
 */
export async function fetchUsdIdr(db: D1Database): Promise<{ stored: number; error?: string }> {
  const res = await fetchWithRetry(USD_IDR_URL, { json: true });
  if (!res.ok) {
    console.log(`  USD/IDR: ERROR ${res.error}`);
    return { stored: 0, error: res.error };
  }
  const body = res.json as { rates?: Record<string, number>; date?: string };
  const rate = body.rates?.IDR;
  const dateStr = body.date;
  if (!rate || !dateStr) {
    console.log("  USD/IDR: no date in response");
    return { stored: 0, error: "no date in response" };
  }
  await upsertSeries(db, "usd_idr", dateStr, rate);
  console.log(`  USD/IDR: ${rate} on ${dateStr}`);
  return { stored: 1 };
}

/**
 * Monthly-first-day history for USD/IDR (frankfurter range endpoint).
 * Port of `backfill.fetch_usd_idr_history()`.
 */
export async function backfillUsdIdr(db: D1Database): Promise<{ stored: number; error?: string }> {
  const url = "https://api.frankfurter.app/2024-01-01..?from=USD&to=IDR";
  const res = await fetchWithRetry(url, { json: true, timeoutMs: 60_000 });
  if (!res.ok) return { stored: 0, error: res.error };
  const rates = (res.json as { rates?: Record<string, { IDR: number }> }).rates ?? {};
  // First trading day of each month from 2024 on.
  const monthly = new Map<string, [string, number]>();
  for (const dateStr of Object.keys(rates).sort()) {
    if (dateStr < "2024-01-01") continue;
    const month = dateStr.slice(0, 7);
    if (!monthly.has(month)) monthly.set(month, [dateStr, rates[dateStr].IDR]);
  }
  await db.batch(
    [...monthly.values()].map(([dateStr, rate]) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO time_series (series_key, date, value, fetched_at)
           VALUES ('usd_idr', ?, ?, ?)`,
        )
        .bind(dateStr, rate, new Date().toISOString()),
    ),
  );
  console.log(`  usd_idr history: ${monthly.size} monthly points`);
  return { stored: monthly.size };
}

// ---------------------------------------------------------------------------
// Inflation YoY (BPS)
// ---------------------------------------------------------------------------

export const BPS_API_URL =
  "https://webapi.bps.go.id/v1/api/list/model/infinite/data/0000/1000/0/0";

/**
 * BPS inflation YoY fallback. Ported verbatim from `macro_fetcher.INFLATION_YOY_KNOWN`.
 */
export const INFLATION_YOY_KNOWN: Array<[string, number]> = [
  ["2025-01-01", 1.57], ["2025-02-01", 1.80], ["2025-03-01", 2.10],
  ["2025-04-01", 2.30], ["2025-05-01", 2.40], ["2025-06-01", 2.60],
  ["2025-07-01", 2.80], ["2025-08-01", 3.00], ["2025-09-01", 3.19],
  ["2025-10-01", 3.10], ["2025-11-01", 3.00], ["2025-12-01", 2.90],
  ["2026-01-01", 2.80], ["2026-02-01", 2.70], ["2026-03-01", 2.60],
  ["2026-04-01", 2.50], ["2026-05-01", 2.40], ["2026-06-01", 2.30],
  ["2026-07-01", 2.20], ["2026-08-01", 2.10], ["2026-09-01", 3.28],
];

/** BI inflation target corridor: 2.5% ± 1% → 1.5%–3.5%. Port of macro constants. */
export const BI_TARGET_CENTER = 2.5;
export const BI_TARGET_BAND = 1.0;
export const BI_TARGET_LOW = BI_TARGET_CENTER - BI_TARGET_BAND;
export const BI_TARGET_HIGH = BI_TARGET_CENTER + BI_TARGET_BAND;

/**
 * Fetch monthly inflation YoY from BPS.
 * Port of `macro_fetcher.fetch_inflation_yoy()`.
 *
 * BPS requires an API key for every endpoint. Without a key the API answers
 * 200 with `{"status":"Error","message":"Parameter Key is Missing."}` — that is
 * not data, so the port falls back to the published BPS figures instead of
 * writing an error object into the series.
 */
export async function fetchInflationYoy(
  db: D1Database,
  apiKey?: string,
): Promise<{ stored: number; usedFallback: boolean; error?: string }> {
  const url = apiKey ? `${BPS_API_URL}?key=${encodeURIComponent(apiKey)}` : BPS_API_URL;
  const res = await fetchWithRetry(url, { json: true, timeoutMs: 30_000 });

  let parsed: Array<[string, number]> = [];
  if (res.ok) {
    const body = res.json as unknown;
    if (body && typeof body === "object") {
      const status = (body as { status?: string }).status;
      const raw = (body as { data?: unknown }).data;
      if (status === "Error" || !Array.isArray(raw) || raw.length === 0) {
        console.log(`  inflation_yoy: BPS API unusable (${status ?? "no data"}), using fallback`);
      } else {
        for (const entry of raw as unknown[]) {
          if (Array.isArray(entry) && entry.length >= 2 && entry[0] && entry[1] !== null) {
            parsed.push([String(entry[0]), Number(entry[1])]);
          }
        }
      }
    }
  }

  if (parsed.length === 0) {
    await db.batch(
      INFLATION_YOY_KNOWN.map(([dateStr, value]) =>
        db
          .prepare(
            `INSERT OR REPLACE INTO time_series (series_key, date, value, fetched_at)
             VALUES ('inflation_yoy', ?, ?, ?)`,
          )
          .bind(dateStr, value, new Date().toISOString()),
      ),
    );
    console.log(`  inflation_yoy: ${INFLATION_YOY_KNOWN.length} fallback rows stored`);
    return { stored: INFLATION_YOY_KNOWN.length, usedFallback: true, error: res.ok ? undefined : res.error };
  }

  await db.batch(
    parsed.map(([dateStr, value]) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO time_series (series_key, date, value, fetched_at)
           VALUES ('inflation_yoy', ?, ?, ?)`,
        )
        .bind(dateStr, value, new Date().toISOString()),
    ),
  );
  console.log(`  inflation_yoy (BPS API): ${parsed.length} rows`);
  return { stored: parsed.length, usedFallback: false };
}

// ---------------------------------------------------------------------------
// Gold
// ---------------------------------------------------------------------------

export const GOLD_API_URL =
  "https://logam-mulia-api.iamutaki.workers.dev/api/prices/anekalogam";

/** Gold fallback. Ported from `micro_fetcher.GOLD_KNOWN`. */
export const GOLD_KNOWN = 2_574_000;

/**
 * Gold history baseline. Ported from `backfill.GOLD_KNOWN`.
 *
 * The live history endpoint only serves roughly the last five months (measured
 * 2026-10-21: 500 items reach 2026-08-27; 76 pages of 20 reach 2026-05-06, then
 * empty). These published figures cover the gap so the series stays comparable
 * with the Flask version.
 */
export const GOLD_HISTORY_KNOWN: Array<[string, number]> = [
  ["2024-01-01", 1129000], ["2024-02-01", 1143000], ["2024-03-01", 1142000],
  ["2024-04-01", 1254000], ["2024-05-01", 1310000], ["2024-06-01", 1336000],
  ["2024-07-01", 1363000], ["2024-11-01", 1547000],
  ["2025-01-01", 1608000], ["2025-10-01", 2400000],
];

interface GoldEntry {
  source?: string;
  material?: string;
  weight?: number;
  sellPrice?: number;
  recordedDate?: string;
}

/**
 * Fetch the 1-gram gold sell price.
 * Port of `micro_fetcher.fetch_gold()`.
 */
export async function fetchGold(db: D1Database): Promise<{ stored: number; usedFallback: boolean; price?: number; date?: string }> {
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetchWithRetry(GOLD_API_URL, { json: true, timeoutMs: 30_000 });

  let price: number | undefined;
  let usedFallback = false;
  if (res.ok) {
    const body = res.json as { data?: GoldEntry[] };
    const entry = Array.isArray(body.data)
      ? body.data.find((d) => d.weight === 1 && d.material === "gold")
      : undefined;
    if (entry?.sellPrice) {
      price = Number(entry.sellPrice);
    } else {
      console.log("  Gold: no weight=1 entry found, using fallback");
      price = GOLD_KNOWN;
      usedFallback = true;
    }
  } else {
    console.log(`  Gold: ERROR ${res.error}, using fallback`);
    price = GOLD_KNOWN;
    usedFallback = true;
  }

  await upsertSeries(db, "gold_gram", today, price);
  await setSeriesMetadata(db, "gold_last_updated", today);
  console.log(`  Gold: Rp ${price.toLocaleString("id-ID")}/gram on ${today}${usedFallback ? " (fallback)" : ""}`);
  return { stored: 1, usedFallback, price, date: today };
}

/**
 * Gold history: monthly samples from the paginated history endpoint, merged
 * with the published baseline.
 * Port of `backfill.fetch_gold_history()` + `backfill.backfill_gold()`.
 */
export async function backfillGold(
  db: D1Database,
  maxPages = 10,
): Promise<{ stored: number; error?: string }> {
  const monthly = new Map<string, [string, number]>();
  // Baseline first so a failed API call still leaves a usable series.
  for (const [date, price] of GOLD_HISTORY_KNOWN) {
    monthly.set(date.slice(0, 7), [date, price]);
  }

  const url = "https://logam-mulia-api.iamutaki.workers.dev/api/prices/anekalogam/history";
  let pages = 0;
  for (let page = 1; page <= maxPages; page++) {
    const res = await fetchWithRetry(`${url}?page=${page}&length=500`, { json: true, timeoutMs: 30_000 });
    if (!res.ok) {
      console.log(`  gold history page ${page}: ERROR ${res.error}`);
      break;
    }
    const body = res.json as { success?: boolean; data?: GoldEntry[] };
    if (!body.success || !Array.isArray(body.data) || body.data.length === 0) break;

    for (const item of body.data) {
      if (item.weight === 1 && item.material === "gold" && item.recordedDate && item.sellPrice) {
        monthly.set(item.recordedDate.slice(0, 7), [
          item.recordedDate,
          Number(item.sellPrice),
        ]);
      }
    }
    pages = page;
    // Stop once the page has walked past 2024.
    const last = body.data[body.data.length - 1]?.recordedDate ?? "";
    if (last && last < "2024-01-01") break;
  }

  if (monthly.size === 0) return { stored: 0, error: "no history available" };

  await db.batch(
    [...monthly.values()].map(([dateStr, price]) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO time_series (series_key, date, value, fetched_at)
           VALUES ('gold_gram', ?, ?, ?)`,
        )
        .bind(dateStr, price, new Date().toISOString()),
    ),
  );
  console.log(`  gold_gram history: ${monthly.size} monthly points (live pages: ${pages})`);
  return { stored: monthly.size };
}

// ---------------------------------------------------------------------------
// BBM (fuel)
// ---------------------------------------------------------------------------

export const BBM_URL = "https://www.pertamina.com/id/harga-bbm";

/**
 * BBM prices per region. Ported verbatim from `micro_fetcher.BBM_PER_DAERAH`
 * (published Pertamina Patra Niaga figures, Oktober 2026).
 *
 * Pertamina blocks scraping and serves a JS shell with no price payload, so the
 * live page cannot be a source. The port keeps the same baseline rather than
 * inventing a scrape.
 */
export const BBM_PER_DAERAH: Record<string, { label: string; prices: Record<string, number> }> = {
  jawa: {
    label: "Jawa, Bali, NTB",
    prices: { Pertalite: 10000, Pertamax: 15950, "Pertamax Turbo": 19600, Dexlite: 23700, Solar: 6800 },
  },
  aceh_sumut: {
    label: "Aceh, Sumut, Jambi, Bengkulu, Sumsel, Babel, Lampung",
    prices: { Pertalite: 10000, Pertamax: 16300, "Pertamax Turbo": 19600, Dexlite: 24200, Solar: 6800 },
  },
  sumbar_riau: {
    label: "Sumbar, Riau, Kepri, Kalut",
    prices: { Pertalite: 10000, Pertamax: 16650, "Pertamax Turbo": 20450, Dexlite: 24200, Solar: 6800 },
  },
  indonesia_timur: {
    label: "Indonesia Timur (Maluku, Papua, NTT, dll)",
    prices: { Pertalite: 10000, Pertamax: 14950, "Pertamax Turbo": 18550, Dexlite: 23700, Solar: 6800 },
  },
};

/** BBM history by product. Ported from `backfill.BBM_KNOWN`. */
export const BBM_KNOWN: Record<string, Record<string, number>> = {
  Pertalite: { "2020-01-01": 7500, "2021-01-01": 8000, "2022-01-01": 10000, "2023-01-01": 10000, "2024-01-01": 10000, "2025-01-01": 10000, "2026-01-01": 10000, "2026-10-01": 10000 },
  Pertamax: { "2020-01-01": 12500, "2021-01-01": 12500, "2022-01-01": 12500, "2023-01-01": 14950, "2024-01-01": 14950, "2025-01-01": 15950, "2026-01-01": 15950, "2026-10-01": 15950 },
  "Pertamax Turbo": { "2020-01-01": 15000, "2021-01-01": 15000, "2022-01-01": 15000, "2023-01-01": 18550, "2024-01-01": 18550, "2025-01-01": 19600, "2026-01-01": 19600, "2026-10-01": 19600 },
  Dexlite: { "2020-01-01": 10000, "2021-01-01": 10000, "2022-01-01": 10000, "2023-01-01": 23700, "2024-01-01": 23700, "2025-01-01": 23700, "2026-01-01": 23700, "2026-10-01": 23700 },
  Solar: { "2020-01-01": 6500, "2021-01-01": 6500, "2022-01-01": 6500, "2023-01-01": 6800, "2024-01-01": 6800, "2025-01-01": 6800, "2026-01-01": 6800, "2026-10-01": 6800 },
};

export function bbmSeriesKey(product: string, daerah: string): string {
  return `bbm_${product.toLowerCase().replace(/ /g, "_")}__${daerah}`;
}

/**
 * Store current BBM prices for every region/product.
 * Port of `micro_fetcher.fetch_bbm()`.
 */
export async function fetchBbm(db: D1Database): Promise<{ stored: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const statements: D1PreparedStatement[] = [];
  let count = 0;
  for (const [daerah, info] of Object.entries(BBM_PER_DAERAH)) {
    for (const [product, price] of Object.entries(info.prices)) {
      statements.push(
        db
          .prepare(
            `INSERT OR REPLACE INTO time_series (series_key, date, value, fetched_at)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(bbmSeriesKey(product, daerah), today, price, new Date().toISOString()),
      );
      count++;
    }
  }
  await db.batch(statements);
  await setSeriesMetadata(db, "bbm_last_updated", today);
  console.log(`  BBM: ${count} products stored on ${today}`);
  return { stored: count };
}

/**
 * Store the historical BBM series for every region.
 * Port of `backfill.backfill_bbm()`.
 */
export async function backfillBbm(db: D1Database): Promise<{ stored: number }> {
  const today = new Date().toISOString().slice(0, 10);
  const statements: D1PreparedStatement[] = [];
  let count = 0;
  for (const [daerah, info] of Object.entries(BBM_PER_DAERAH)) {
    for (const [product, currentPrice] of Object.entries(info.prices)) {
      const key = bbmSeriesKey(product, daerah);
      for (const [dateStr, price] of Object.entries(BBM_KNOWN[product] ?? {})) {
        statements.push(
          db
            .prepare(
              `INSERT OR REPLACE INTO time_series (series_key, date, value, fetched_at)
               VALUES (?, ?, ?, ?)`,
            )
            .bind(key, dateStr, price, new Date().toISOString()),
        );
        count++;
      }
      statements.push(
        db
          .prepare(
            `INSERT OR REPLACE INTO time_series (series_key, date, value, fetched_at)
             VALUES (?, ?, ?, ?)`,
          )
          .bind(key, today, currentPrice, new Date().toISOString()),
      );
      count++;
    }
  }
  await db.batch(statements);
  console.log(`  bbm_* history: ${count} rows`);
  return { stored: count };
}

// ---------------------------------------------------------------------------
// IKK (consumer confidence)
// ---------------------------------------------------------------------------

export const IKK_URL =
  "https://tradingeconomics.com/indonesia/consumer-confidence";

/** IKK fallback. Ported from `micro_fetcher.IKK_KNOWN`. */
export const IKK_KNOWN = 118.1;

/** IKK history. Ported from `backfill.IKK_KNOWN`. */
export const IKK_KNOWN_HISTORY: Array<[string, number]> = [
  ["2024-01-01", 123.8], ["2024-02-01", 123.1], ["2024-03-01", 123.8],
  ["2024-04-01", 127.7], ["2024-05-01", 125.2], ["2024-06-01", 123.3],
  ["2024-07-01", 124.3], ["2024-08-01", 124.4], ["2024-09-01", 123.5],
  ["2024-10-01", 121.1], ["2024-11-01", 125.9], ["2024-12-01", 127.7],
  ["2025-01-01", 127.2], ["2025-02-01", 126.4], ["2025-03-01", 121.1],
  ["2025-04-01", 121.7], ["2025-05-01", 117.5], ["2025-06-01", 117.8],
  ["2025-07-01", 118.1], ["2025-08-01", 117.2], ["2025-09-01", 115.0],
  ["2025-10-01", 121.2], ["2025-12-01", 123.5], ["2026-09-01", 118.1],
];

/**
 * Extract the latest IKK reading from the TradingEconomics page summary.
 * Port of `micro_fetcher.fetch_ikk()` — the page carries a sentence such as
 * "decreased to 118.10 points in September from 118.50 points in August of 2026".
 */
export function parseIkk(html: string): { value: number; dateStr: string } | null {
  const m = html.match(
    /(?:declined|increased|rose|fell|dropped|climbed)\s+to\s+([\d.]+)\s+in\s+(\w+)\s+(\d{4})/i,
  );
  if (!m) return null;
  const monthMap: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  const month = monthMap[m[2].toLowerCase()];
  if (!month) return null;
  return { value: Number(m[1]), dateStr: `${m[3]}-${String(month).padStart(2, "0")}-01` };
}

/**
 * Fetch IKK. Port of `micro_fetcher.fetch_ikk()`.
 */
export async function fetchIkk(db: D1Database): Promise<{ stored: number; usedFallback: boolean; value?: number }> {
  const res = await fetchWithRetry(IKK_URL, { timeoutMs: 30_000 });
  let value: number;
  let dateStr: string;
  let usedFallback = false;

  const parsed = res.ok && res.text ? parseIkk(res.text) : null;
  if (parsed) {
    value = parsed.value;
    dateStr = parsed.dateStr;
  } else {
    console.log(
      `  IKK: could not parse from TradingEconomics (${res.ok ? "no pattern" : res.error}), using fallback`,
    );
    value = IKK_KNOWN;
    dateStr = new Date().toISOString().slice(0, 10);
    usedFallback = true;
  }

  await upsertSeries(db, "ikk", dateStr, value);
  await setSeriesMetadata(db, "ikk_last_updated", dateStr);
  console.log(`  IKK: ${value} on ${dateStr}${usedFallback ? " (fallback)" : ""}`);
  return { stored: 1, usedFallback, value };
}

/**
 * Store the IKK history series.
 * Port of `backfill.backfill_ikk()`.
 */
export async function backfillIkk(db: D1Database): Promise<{ stored: number }> {
  await db.batch(
    IKK_KNOWN_HISTORY.map(([dateStr, value]) =>
      db
        .prepare(
          `INSERT OR REPLACE INTO time_series (series_key, date, value, fetched_at)
           VALUES ('ikk', ?, ?, ?)`,
        )
        .bind(dateStr, value, new Date().toISOString()),
    ),
  );
  console.log(`  ikk history: ${IKK_KNOWN_HISTORY.length} rows`);
  return { stored: IKK_KNOWN_HISTORY.length };
}

// ---------------------------------------------------------------------------
// UMP (provincial minimum wage)
// ---------------------------------------------------------------------------

/** UMP per province. Ported from `micro_fetcher.UMP_PROVINSI`. */
export const UMP_PROVINSI: Record<string, number> = {
  Aceh: 3698, "Sumatera Utara": 3958, "Sumatera Barat": 3200, Riau: 4044,
  Jambi: 3384, "Sumatera Selatan": 3642, Bengkulu: 2694, Lampung: 3135,
  "Kepulauan Bangka Belitung": 3825, "Kepulauan Riau": 4363, "DKI Jakarta": 5397,
  "Jawa Barat": 4170, "Jawa Tengah": 3179, "DI Yogyakarta": 2723, "Jawa Timur": 3276,
  Banten: 4958, Bali: 3187, "Nusa Tenggara Barat": 2901, "Nusa Tenggara Timur": 2568,
  "Kalimantan Barat": 3135, "Kalimantan Tengah": 3503, "Kalimantan Selatan": 3545,
  "Kalimantan Timur": 4034, "Kalimantan Utara": 3795, "Sulawesi Utara": 4044,
  "Sulawesi Tengah": 3444, "Sulawesi Selatan": 3900, "Sulawesi Tenggara": 3401,
  Gorontalo: 3521, "Sulawesi Barat": 3147, Maluku: 2900, "Maluku Utara": 3330,
  Papua: 4350, "Papua Barat": 3800, "Papua Tengah": 4120, "Papua Pegunungan": 4300,
  "Papua Selatan": 4000, "Papua Barat Daya": 3900,
};

// ---------------------------------------------------------------------------
// Aggregate fetch entry points
// ---------------------------------------------------------------------------

/** Result of one fetch pass, used by the seed script and the cron handler. */
export interface FetchReport {
  indicators: Array<{ code: string; name: string; stored: number; error?: string }>;
  macro: Array<{ source: string; stored: number; usedFallback: boolean; error?: string }>;
  micro: Array<{ source: string; stored: number; usedFallback: boolean; error?: string }>;
}

/**
 * Fetch and store the three World Bank indicators.
 * Port of `data_fetcher.fetch_all()`.
 */
export async function fetchAllIndicators(db: D1Database): Promise<{ total: number }> {
  let total = 0;
  for (const [code, name] of Object.entries(INDICATOR_CODES)) {
    const { stored, error } = await storeWbIndicator(db, code, name);
    console.log(`  ${name} (${code}): ${stored} rows stored${error ? ` [ERROR ${error}]` : ""}`);
    total += stored;
  }
  if (total > 0) await setLastUpdated(db);
  console.log(`Indicators total: ${total} rows stored`);
  return { total };
}

/**
 * Fetch all macro series.
 * Port of `macro_fetcher.fetch_all_macro()`.
 */
export async function fetchAllMacro(
  db: D1Database,
  opts: { bpsApiKey?: string } = {},
): Promise<{ total: number; failures: string[] }> {
  const failures: string[] = [];
  let total = 0;

  const bi = await fetchBiRate(db);
  if (bi.usedFallback) failures.push(`bi_rate: ${bi.latest?.[1]}% fallback`);
  total += bi.stored;

  const usd = await fetchUsdIdr(db);
  if (usd.error) failures.push(`usd_idr: ${usd.error}`);
  total += usd.stored;

  const series: Array<{ key: string; code: string; fallback: Array<[string, number]> }> = [
    { key: "gini", code: WB_SERIES.GINI_CODE, fallback: [] },
    { key: "life_exp", code: WB_SERIES.LIFE_EXP_CODE, fallback: WB_FALLBACK.life_exp },
    { key: "edu_exp", code: WB_SERIES.EDU_EXP_CODE, fallback: WB_FALLBACK.edu_exp },
    { key: "literacy", code: WB_SERIES.LITERACY_CODE, fallback: [] },
  ];
  for (const s of series) {
    const res = await storeWbSeries(db, s.key, s.code, s.fallback);
    if (res.usedFallback) {
      failures.push(`${s.key}: fallback used${res.error ? ` (${res.error})` : ""}`);
    }
    total += res.stored;
    console.log(`  ${s.key} (${s.code}): ${res.stored} rows${res.usedFallback ? " [FALLBACK]" : ""}`);
  }

  const infl = await fetchInflationYoy(db, opts.bpsApiKey);
  if (infl.usedFallback) failures.push(`inflation_yoy: fallback used`);
  total += infl.stored;

  await setSeriesMetadata(
    db,
    "macro_last_updated",
    new Date().toISOString().slice(0, 19).replace("T", " ").replace("Z", " UTC"),
  );
  console.log(`Macro total: ${total} rows stored`);
  return { total, failures };
}

/**
 * Fetch all micro series.
 * Port of `micro_fetcher.fetch_all_micro()`.
 */
export async function fetchAllMicro(db: D1Database): Promise<{ total: number; failures: string[] }> {
  const failures: string[] = [];
  let total = 0;

  const gold = await fetchGold(db);
  if (gold.usedFallback) failures.push("gold: fallback used");
  total += gold.stored;

  total += (await fetchBbm(db)).stored;

  const ikk = await fetchIkk(db);
  if (ikk.usedFallback) failures.push("ikk: fallback used");
  total += ikk.stored;

  await setSeriesMetadata(
    db,
    "micro_last_updated",
    new Date().toISOString().slice(0, 19).replace("T", " ").replace("Z", " UTC"),
  );
  console.log(`Micro total: ${total} rows stored`);
  return { total, failures };
}

/** True when a series has at least one stored row. Used by the seed script. */
export async function seriesExists(db: D1Database, seriesKey: string): Promise<boolean> {
  const row = await getLatestSeries(db, seriesKey);
  return row !== null;
}
