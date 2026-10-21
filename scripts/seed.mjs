/**
 * Seed script — creates the D1 schema, fetches every series and stores it.
 *
 * Idempotent: the schema is `CREATE TABLE IF NOT EXISTS`, every write is
 * `INSERT OR REPLACE`, so re-running refreshes values instead of duplicating
 * rows. `--clear` additionally empties the tables first.
 *
 * Usage:
 *   node scripts/seed.mjs              # local D1 (wrangler dev)
 *   node scripts/seed.mjs --remote     # production D1
 *   node scripts/seed.mjs --clear --remote
 *
 * The script talks to the live sources directly (not through the Worker), so it
 * also works before the Worker is deployed.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");

// ---------------------------------------------------------------------------
// D1 access — wrangler CLI is the transport for a Node script.
// ---------------------------------------------------------------------------

/**
 * Run a SQL statement against D1 through the wrangler CLI.
 * `--json` prints a top-level array of result objects.
 */
function d1(sql, { remote = false } = {}) {
  const args = ["d1", "execute", "inthiseconomy-db", "--json"];
  if (remote) args.push("--remote");
  else args.push("--local");
  args.push("--command", sql);

  const res = spawnSync(join(projectRoot, "node_modules", ".bin", "wrangler"), args, {
    encoding: "utf8",
    cwd: projectRoot,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (res.status !== 0) {
    throw new Error(
      `wrangler d1 execute failed (${res.status}): ${(res.stderr || res.stdout || "").trim()}`,
    );
  }
  try {
    const parsed = JSON.parse(res.stdout);
    // `wrangler d1 execute --json` prints [{results, success, meta}].
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch (e) {
    throw new Error(`could not parse wrangler d1 output: ${e.message}\n${res.stdout.slice(0, 500)}`);
  }
}

// ---------------------------------------------------------------------------
// Fetchers — the same logic as src/fetchers.ts, but without the Worker binding.
// ---------------------------------------------------------------------------

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "id-ID,id;q=0.9,en;q=0.8",
};

async function fetchWithRetry(
  url,
  { timeoutMs = 45000, retries = 2, headers = {} } = {},
) {
  let lastError = "unknown error";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { ...HEADERS, ...headers },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      return { ok: true, text, status: res.status };
    } catch (e) {
      clearTimeout(timer);
      lastError =
        e && e.name === "AbortError"
          ? `timeout after ${timeoutMs}ms`
          : e && e.message
            ? e.message
            : String(e);
    }
  }
  return { ok: false, error: lastError };
}

async function fetchJson(url, opts) {
  const res = await fetchWithRetry(url, opts);
  if (!res.ok) return { ok: false, error: res.error };
  try {
    return { ok: true, json: JSON.parse(res.text) };
  } catch (e) {
    return { ok: false, error: `invalid JSON: ${e.message}` };
  }
}

const nowIso = () => new Date().toISOString();
const utcLabel = () => {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
  );
};

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const WB_API = "https://api.worldbank.org/v2/country/IDN/indicator";
const INDICATOR_CODES = {
  "NY.GDP.MKTP.KD.ZG": "PDB Growth",
  "FP.CPI.TOTL.ZG": "Inflasi",
  "BN.GSR.GNFS.CD": "Trade Balance",
};
const WB_SERIES = {
  GINI_CODE: "SI.POV.GINI",
  LIFE_EXP_CODE: "SP.DYN.LE00.IN",
  EDU_EXP_CODE: "SE.XPD.TOTL.GD.ZS",
  LITERACY_CODE: "SE.ADT.LITR.ZS",
};
const WB_FALLBACK = {
  life_exp: [
    ["2023-12-31", 71.9], ["2022-12-31", 71.7], ["2021-12-31", 71.3],
    ["2020-12-31", 71.0], ["2019-12-31", 71.5],
  ],
  edu_exp: [
    ["2023-12-31", 3.0], ["2022-12-31", 3.1], ["2021-12-31", 3.0],
    ["2020-12-31", 3.0], ["2019-12-31", 3.0],
  ],
};
const BI_RATE_URL = "https://www.bi.go.id/id/statistik/indikator/bi-rate.aspx";
const BI_RATE_KNOWN = [
  ["2026-09-23", 5.75], ["2026-08-19", 5.75], ["2026-07-22", 5.75],
  ["2026-06-18", 5.75], ["2026-06-09", 5.5], ["2026-05-20", 5.25],
  ["2026-04-22", 4.75], ["2026-03-17", 4.75], ["2026-02-19", 4.75],
  ["2026-01-21", 4.75],
];
const USD_IDR_URL = "https://api.frankfurter.app/latest?from=USD&to=IDR";
const BPS_API_URL =
  "https://webapi.bps.go.id/v1/api/list/model/infinite/data/0000/1000/0/0";
const INFLATION_YOY_KNOWN = [
  ["2025-01-01", 1.57], ["2025-02-01", 1.80], ["2025-03-01", 2.10],
  ["2025-04-01", 2.30], ["2025-05-01", 2.40], ["2025-06-01", 2.60],
  ["2025-07-01", 2.80], ["2025-08-01", 3.00], ["2025-09-01", 3.19],
  ["2025-10-01", 3.10], ["2025-11-01", 3.00], ["2025-12-01", 2.90],
  ["2026-01-01", 2.80], ["2026-02-01", 2.70], ["2026-03-01", 2.60],
  ["2026-04-01", 2.50], ["2026-05-01", 2.40], ["2026-06-01", 2.30],
  ["2026-07-01", 2.20], ["2026-08-01", 2.10], ["2026-09-01", 3.28],
];
const GOLD_API_URL =
  "https://logam-mulia-api.iamutaki.workers.dev/api/prices/anekalogam";
const GOLD_HISTORY_URL =
  "https://logam-mulia-api.iamutaki.workers.dev/api/prices/anekalogam/history";
const GOLD_KNOWN = 2574000;

/**
 * Gold history baseline. Ported from `backfill.GOLD_KNOWN`.
 *
 * The live history endpoint only serves roughly the last five months (measured
 * 2026-10-21: 500 items reach back to 2026-08-27, 76 pages of 20 to
 * 2026-05-06, then empty). These published figures cover the gap so the series
 * stays comparable with the Flask version.
 */
const GOLD_HISTORY_KNOWN = [
  ["2024-01-01", 1129000], ["2024-02-01", 1143000], ["2024-03-01", 1142000],
  ["2024-04-01", 1254000], ["2024-05-01", 1310000], ["2024-06-01", 1336000],
  ["2024-07-01", 1363000], ["2024-11-01", 1547000],
  ["2025-01-01", 1608000], ["2025-10-01", 2400000],
];
const IKK_URL = "https://tradingeconomics.com/indonesia/consumer-confidence";
const IKK_KNOWN = 118.1;
const IKK_KNOWN_HISTORY = [
  ["2024-01-01", 123.8], ["2024-02-01", 123.1], ["2024-03-01", 123.8],
  ["2024-04-01", 127.7], ["2024-05-01", 125.2], ["2024-06-01", 123.3],
  ["2024-07-01", 124.3], ["2024-08-01", 124.4], ["2024-09-01", 123.5],
  ["2024-10-01", 121.1], ["2024-11-01", 125.9], ["2024-12-01", 127.7],
  ["2025-01-01", 127.2], ["2025-02-01", 126.4], ["2025-03-01", 121.1],
  ["2025-04-01", 121.7], ["2025-05-01", 117.5], ["2025-06-01", 117.8],
  ["2025-07-01", 118.1], ["2025-08-01", 117.2], ["2025-09-01", 115.0],
  ["2025-10-01", 121.2], ["2025-12-01", 123.5], ["2026-09-01", 118.1],
];
const BBM_PER_DAERAH = {
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
const BBM_KNOWN = {
  Pertalite: { "2020-01-01": 7500, "2021-01-01": 8000, "2022-01-01": 10000, "2023-01-01": 10000, "2024-01-01": 10000, "2025-01-01": 10000, "2026-01-01": 10000, "2026-10-01": 10000 },
  Pertamax: { "2020-01-01": 12500, "2021-01-01": 12500, "2022-01-01": 12500, "2023-01-01": 14950, "2024-01-01": 14950, "2025-01-01": 15950, "2026-01-01": 15950, "2026-10-01": 15950 },
  "Pertamax Turbo": { "2020-01-01": 15000, "2021-01-01": 15000, "2022-01-01": 15000, "2023-01-01": 18550, "2024-01-01": 18550, "2025-01-01": 19600, "2026-01-01": 19600, "2026-10-01": 19600 },
  Dexlite: { "2020-01-01": 10000, "2021-01-01": 10000, "2022-01-01": 10000, "2023-01-01": 23700, "2024-01-01": 23700, "2025-01-01": 23700, "2026-01-01": 23700, "2026-10-01": 23700 },
  Solar: { "2020-01-01": 6500, "2021-01-01": 6500, "2022-01-01": 6500, "2023-01-01": 6800, "2024-01-01": 6800, "2025-01-01": 6800, "2026-01-01": 6800, "2026-10-01": 6800 },
};
const bbmSeriesKey = (product, daerah) =>
  `bbm_${product.toLowerCase().replace(/ /g, "_")}__${daerah}`;

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

function parseBiRateChartData(html) {
  const m = html.match(/id="HiddenFieldChartData" value="([^"]*)"/);
  if (!m) return [];
  const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((p) => Array.isArray(p) && typeof p[0] === "number" && typeof p[1] === "number")
      .map(([ts, rate]) => [new Date(ts).toISOString().slice(0, 10), rate]);
  } catch {
    return [];
  }
}

function parseBiRateHtml(html) {
  const re = /<td[^>]*>\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s*<\/td>\s*<td[^>]*>\s*([\d,.]+)\s*%/gi;
  const bulan = {
    januari: 1, februari: 2, maret: 3, april: 4, mei: 5, juni: 6,
    juli: 7, agustus: 8, september: 9, oktober: 10, november: 11, desember: 12,
  };
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const month = bulan[m[2].toLowerCase()];
    if (!month) continue;
    out.push([
      `${m[3]}-${String(month).padStart(2, "0")}-${String(Number(m[1])).padStart(2, "0")}`,
      parseFloat(m[4].replace(",", ".")),
    ]);
  }
  return out;
}

function parseIkk(html) {
  const m = html.match(
    /(?:declined|increased|rose|fell|dropped|climbed)\s+to\s+([\d.]+)\s+in\s+(\w+)\s+(\d{4})/i,
  );
  if (!m) return null;
  const months = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  const month = months[m[2].toLowerCase()];
  if (!month) return null;
  return { value: Number(m[1]), dateStr: `${m[3]}-${String(month).padStart(2, "0")}-01` };
}

// ---------------------------------------------------------------------------
// Insert helpers (single SQL statement, batched rows)
// ---------------------------------------------------------------------------

function sqlStr(v) {
  return `'${String(v).replace(/'/g, "''")}'`;
}

function indicatorInserts(rows) {
  const values = rows
    .map(
      (r) =>
        `(${sqlStr(r.code)}, ${sqlStr(r.name)}, ${r.value}, ${r.year}, ${sqlStr(r.fetched_at)})`,
    )
    .join(",\n");
  return `INSERT OR REPLACE INTO indicators (code, name, value, year, fetched_at) VALUES\n${values};`;
}

function seriesInserts(rows) {
  const values = rows
    .map(
      (r) =>
        `(${sqlStr(r.series_key)}, ${sqlStr(r.date)}, ${r.value}, ${sqlStr(r.fetched_at)})`,
    )
    .join(",\n");
  return `INSERT OR REPLACE INTO time_series (series_key, date, value, fetched_at) VALUES\n${values};`;
}

function metaInserts(rows) {
  const values = rows.map((r) => `(${sqlStr(r.key)}, ${sqlStr(r.value)})`).join(",\n");
  return `INSERT OR REPLACE INTO metadata (key, value) VALUES\n${values};`;
}

/** D1 caps a statement at 100 bound parameters; chunk large inserts. */
function chunks(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS indicators (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL,
  year INTEGER,
  fetched_at TEXT NOT NULL,
  UNIQUE(code, year)
);
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS time_series (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series_key TEXT NOT NULL,
  date TEXT NOT NULL,
  value REAL NOT NULL,
  fetched_at TEXT NOT NULL,
  UNIQUE(series_key, date)
);
CREATE INDEX IF NOT EXISTS idx_indicators_code_year ON indicators(code, year);
CREATE INDEX IF NOT EXISTS idx_time_series_key_date ON time_series(series_key, date);
`;

const report = {
  indicators: [],
  macro: [],
  micro: [],
  failures: [],
};

async function run({ remote = false, clear = false } = {}) {
  console.log(`\n=== inthiseconomy seed (${remote ? "REMOTE" : "LOCAL"}) ===`);

  if (clear) {
    console.log("-- clearing tables");
    d1(`DELETE FROM indicators; DELETE FROM time_series; DELETE FROM metadata;`, { remote });
  }

  console.log("-- schema");
  d1(SCHEMA_SQL, { remote });

  // --- World Bank indicators -------------------------------------------
  const indicatorRows = [];
  for (const [code, name] of Object.entries(INDICATOR_CODES)) {
    const res = await fetchJson(`${WB_API}/${code}?format=json&per_page=100`);
    if (!res.ok) {
      console.log(`  ${name} (${code}): ERROR ${res.error}`);
      report.indicators.push({ code, name, stored: 0, error: res.error });
      continue;
    }
    const body = res.json;
    const entries = Array.isArray(body?.[1]) ? body[1] : [];
    const usable = entries.filter((e) => e && e.value !== null && e.date !== null);
    for (const e of usable) {
      indicatorRows.push({
        code,
        name,
        value: Number(e.value),
        year: Number(e.date),
        fetched_at: nowIso(),
      });
    }
    console.log(`  ${name} (${code}): ${usable.length} rows`);
    report.indicators.push({ code, name, stored: usable.length });
  }

  // --- Macro series -----------------------------------------------------
  const macroRows = [];
  const metaRows = [];

  // BI-Rate
  const bi = await fetchWithRetry(BI_RATE_URL, { timeoutMs: 30000 });
  let biRows = [];
  if (bi.ok) biRows = parseBiRateChartData(bi.text) || parseBiRateHtml(bi.text);
  if (biRows.length === 0) {
    biRows = BI_RATE_KNOWN;
    report.failures.push("bi_rate: fallback used (page unreadable or unparseable)");
  }
  for (const [date, rate] of biRows) {
    macroRows.push({ series_key: "bi_rate", date, value: rate, fetched_at: nowIso() });
  }
  console.log(`  bi_rate: ${biRows.length} rows${biRows === BI_RATE_KNOWN ? " [FALLBACK]" : ""}`);
  report.macro.push({ source: "bi_rate", stored: biRows.length, usedFallback: biRows === BI_RATE_KNOWN });

  // USD/IDR latest + history
  const usd = await fetchJson(USD_IDR_URL);
  if (usd.ok) {
    const rate = usd.json?.rates?.IDR;
    const date = usd.json?.date;
    if (rate && date) {
      macroRows.push({ series_key: "usd_idr", date, value: rate, fetched_at: nowIso() });
      console.log(`  usd_idr: ${rate} on ${date}`);
      report.macro.push({ source: "usd_idr", stored: 1 });
    } else {
      report.failures.push("usd_idr: no rate/date in response");
    }
  } else {
    report.failures.push(`usd_idr: ${usd.error}`);
  }

  const usdHist = await fetchJson("https://api.frankfurter.app/2024-01-01..?from=USD&to=IDR", {
    timeoutMs: 60000,
  });
  if (usdHist.ok) {
    const rates = usdHist.json?.rates ?? {};
    const monthly = new Map();
    for (const date of Object.keys(rates).sort()) {
      if (date < "2024-01-01") continue;
      const month = date.slice(0, 7);
      if (!monthly.has(month)) monthly.set(month, [date, rates[date].IDR]);
    }
    for (const [date, rate] of monthly.values()) {
      macroRows.push({ series_key: "usd_idr", date, value: rate, fetched_at: nowIso() });
    }
    console.log(`  usd_idr history: ${monthly.size} monthly points`);
  } else {
    report.failures.push(`usd_idr history: ${usdHist.error}`);
  }

  // World Bank series
  for (const [key, code] of Object.entries(WB_SERIES)) {
    const res = await fetchJson(`${WB_API}/${code}?format=json&per_page=100`);
    let usedFallback = false;
    let rows = [];
    if (res.ok) {
      const entries = Array.isArray(res.json?.[1]) ? res.json[1] : [];
      rows = entries
        .filter((e) => e && e.value !== null && e.date !== null)
        .map((e) => [`${e.date}-12-31`, Number(e.value)]);
    }
    if (rows.length === 0) {
      rows = WB_FALLBACK[key] ?? [];
      usedFallback = true;
      report.failures.push(`${key}: fallback used${res.ok ? "" : ` (${res.error})`}`);
    }
    for (const [date, value] of rows) {
      macroRows.push({ series_key: key, date, value, fetched_at: nowIso() });
    }
    console.log(`  ${key} (${code}): ${rows.length} rows${usedFallback ? " [FALLBACK]" : ""}`);
    report.macro.push({ source: key, stored: rows.length, usedFallback });
  }

  // Inflation YoY (BPS)
  const bpsKey = process.env.BPS_API_KEY;
  const bps = await fetchJson(bpsKey ? `${BPS_API_URL}?key=${encodeURIComponent(bpsKey)}` : BPS_API_URL);
  let inflRows = [];
  let inflFallback = false;
  if (bps.ok) {
    const status = bps.json?.status;
    const data = bps.json?.data;
    if (status === "Error" || !Array.isArray(data) || data.length === 0) {
      inflFallback = true;
      console.log(`  inflation_yoy: BPS API unusable (${status ?? "no data"}), using fallback`);
    } else {
      inflRows = data
        .filter((e) => Array.isArray(e) && e.length >= 2 && e[0] && e[1] !== null)
        .map((e) => [String(e[0]), Number(e[1])]);
    }
  } else {
    inflFallback = true;
    report.failures.push(`inflation_yoy: ${bps.error}`);
  }
  if (inflRows.length === 0) {
    inflRows = INFLATION_YOY_KNOWN;
    inflFallback = true;
  }
  for (const [date, value] of inflRows) {
    macroRows.push({ series_key: "inflation_yoy", date, value, fetched_at: nowIso() });
  }
  console.log(`  inflation_yoy: ${inflRows.length} rows${inflFallback ? " [FALLBACK]" : ""}`);
  report.macro.push({ source: "inflation_yoy", stored: inflRows.length, usedFallback: inflFallback });

  // --- Micro series -----------------------------------------------------
  const today = new Date().toISOString().slice(0, 10);

  // Gold latest
  const gold = await fetchJson(GOLD_API_URL, { timeoutMs: 30000 });
  let goldPrice = null;
  let goldFallback = false;
  if (gold.ok) {
    const entry = Array.isArray(gold.json?.data)
      ? gold.json.data.find((d) => d.weight === 1 && d.material === "gold")
      : null;
    if (entry?.sellPrice) goldPrice = Number(entry.sellPrice);
  }
  if (goldPrice === null) {
    goldPrice = GOLD_KNOWN;
    goldFallback = true;
    report.failures.push("gold: fallback used");
  }
  macroRows.push({ series_key: "gold_gram", date: today, value: goldPrice, fetched_at: nowIso() });
  metaRows.push({ key: "gold_last_updated", value: today });
  console.log(`  gold_gram: Rp ${goldPrice.toLocaleString("id-ID")}/gram${goldFallback ? " [FALLBACK]" : ""}`);
  report.micro.push({ source: "gold_gram", stored: 1, usedFallback: goldFallback });

  // Gold history — live endpoint first (last ~5 months only), then the published baseline.
  const goldMonthly = new Map();
  for (const [date, price] of GOLD_HISTORY_KNOWN) {
    goldMonthly.set(date.slice(0, 7), [date, price]);
  }
  const goldPages = [];
  for (let page = 1; page <= 10; page++) {
    const res = await fetchJson(`${GOLD_HISTORY_URL}?page=${page}&length=500`, {
      timeoutMs: 30000,
    });
    if (!res.ok) {
      report.failures.push(`gold_gram history page ${page}: ${res.error}`);
      break;
    }
    const data = res.json?.data;
    if (!Array.isArray(data) || data.length === 0) break;
    for (const item of data) {
      if (item.weight === 1 && item.material === "gold" && item.recordedDate && item.sellPrice) {
        goldMonthly.set(item.recordedDate.slice(0, 7), [
          item.recordedDate,
          Number(item.sellPrice),
        ]);
      }
    }
    const last = data[data.length - 1]?.recordedDate ?? "";
    goldPages.push(page);
    if (last && last < "2024-01-01") break;
  }
  for (const [date, price] of goldMonthly.values()) {
    macroRows.push({ series_key: "gold_gram", date, value: price, fetched_at: nowIso() });
  }
  console.log(
    `  gold_gram history: ${goldMonthly.size} monthly points (live pages: ${goldPages.length || 0})`,
  );

  // BBM current
  let bbmCount = 0;
  for (const [daerah, info] of Object.entries(BBM_PER_DAERAH)) {
    for (const [product, price] of Object.entries(info.prices)) {
      macroRows.push({
        series_key: bbmSeriesKey(product, daerah),
        date: today,
        value: price,
        fetched_at: nowIso(),
      });
      bbmCount++;
    }
  }
  metaRows.push({ key: "bbm_last_updated", value: today });
  console.log(`  bbm_*: ${bbmCount} current prices`);
  report.micro.push({ source: "bbm", stored: bbmCount, usedFallback: true });

  // BBM history
  let bbmHistCount = 0;
  for (const [daerah, info] of Object.entries(BBM_PER_DAERAH)) {
    for (const [product, currentPrice] of Object.entries(info.prices)) {
      const key = bbmSeriesKey(product, daerah);
      for (const [date, price] of Object.entries(BBM_KNOWN[product] ?? {})) {
        macroRows.push({ series_key: key, date, value: price, fetched_at: nowIso() });
        bbmHistCount++;
      }
      macroRows.push({
        series_key: key,
        date: today,
        value: currentPrice,
        fetched_at: nowIso(),
      });
      bbmHistCount++;
    }
  }
  console.log(`  bbm_* history: ${bbmHistCount} rows`);

  // IKK latest
  const ikk = await fetchWithRetry(IKK_URL, { timeoutMs: 30000 });
  let ikkValue = null;
  let ikkDate = null;
  let ikkFallback = false;
  if (ikk.ok) {
    const parsed = parseIkk(ikk.text);
    if (parsed) {
      ikkValue = parsed.value;
      ikkDate = parsed.dateStr;
    }
  }
  if (ikkValue === null) {
    ikkValue = IKK_KNOWN;
    ikkDate = today;
    ikkFallback = true;
    report.failures.push("ikk: fallback used");
  }
  macroRows.push({ series_key: "ikk", date: ikkDate, value: ikkValue, fetched_at: nowIso() });
  metaRows.push({ key: "ikk_last_updated", value: ikkDate });
  console.log(`  ikk: ${ikkValue} on ${ikkDate}${ikkFallback ? " [FALLBACK]" : ""}`);
  report.micro.push({ source: "ikk", stored: 1, usedFallback: ikkFallback });

  // IKK history
  for (const [date, value] of IKK_KNOWN_HISTORY) {
    macroRows.push({ series_key: "ikk", date, value, fetched_at: nowIso() });
  }
  console.log(`  ikk history: ${IKK_KNOWN_HISTORY.length} rows`);

  // --- Write ------------------------------------------------------------
  console.log(`\n-- writing ${indicatorRows.length} indicator rows, ${macroRows.length} series rows`);

  for (const chunk of chunks(indicatorRows, 50)) {
    d1(indicatorInserts(chunk), { remote });
  }
  for (const chunk of chunks(macroRows, 50)) {
    d1(seriesInserts(chunk), { remote });
  }

  metaRows.push({ key: "last_updated", value: utcLabel() });
  metaRows.push({ key: "macro_last_updated", value: utcLabel() });
  metaRows.push({ key: "micro_last_updated", value: utcLabel() });
  metaRows.push({ key: "backfill_last_run", value: nowIso() });
  d1(metaInserts(metaRows), { remote });

  // --- Verify -----------------------------------------------------------
  const countRes = d1(
    `SELECT
       (SELECT COUNT(*) FROM indicators) AS indicators,
       (SELECT COUNT(*) FROM time_series) AS series,
       (SELECT COUNT(DISTINCT series_key) FROM time_series) AS series_keys;`,
    { remote },
  );
  const rows = countRes?.results?.[0] ?? {};

  console.log(`\n=== DONE ===`);
  console.log(`indicators: ${rows.indicators}`);
  console.log(`time_series: ${rows.series}`);
  console.log(`series keys: ${rows.series_keys}`);
  console.log(`fallbacks: ${report.failures.length ? report.failures.join(" | ") : "none"}`);

  return {
    indicators: rows.indicators ?? 0,
    series: rows.series ?? 0,
    series_keys: rows.series_keys ?? 0,
    failures: report.failures,
    report,
  };
}

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const clear = args.includes("--clear");

run({ remote, clear })
  .then((r) => {
    process.exitCode = r.indicators > 0 && r.series > 0 ? 0 : 1;
  })
  .catch((e) => {
    console.error(`seed failed: ${e.message}`);
    process.exitCode = 1;
  });
