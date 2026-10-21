/**
 * D1 data layer — TypeScript port of `models.py` (241 lines) from the Flask
 * archive at ../models.py.
 *
 * SQLite concepts that do NOT exist in D1:
 *   - `PRAGMA journal_mode=WAL` / `busy_timeout` — local-file concerns, drop them.
 *   - A per-request connection — D1 uses prepared statements on the binding.
 *
 * Every function below maps 1:1 to a `models.py` function of the same name.
 */

export interface Env {
  DB: D1Database;
  CACHE_KV: KVNamespace;
  ENVIRONMENT: string;
  SITE_URL: string;
}

/** World Bank indicator code → Indonesian label. Port of `INDICATOR_CODES`. */
export const INDICATOR_CODES: Record<string, string> = {
  "NY.GDP.MKTP.KD.ZG": "PDB Growth",
  "FP.CPI.TOTL.ZG": "Inflasi",
  "BN.GSR.GNFS.CD": "Trade Balance",
};

export interface IndicatorRow {
  id: number;
  code: string;
  name: string;
  value: number | null;
  year: number | null;
  fetched_at: string;
}

export interface IndicatorDataRow {
  code: string;
  name: string;
  value: number;
  year: number;
  fetched_at: string;
}

export interface SeriesRow {
  date: string;
  value: number;
  fetched_at: string;
}

export interface AllDataEntry {
  name: string;
  data: IndicatorDataRow[];
  latest: IndicatorDataRow | null;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * DDL for all three tables. Port of `init_db()` + `init_time_series()`.
 * Idempotent (IF NOT EXISTS), so the seed script and `wrangler dev` can both
 * call it. Split into a const so callers can send it in a single batch.
 */
export const SCHEMA_SQL = `
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

/**
 * Create the schema if it does not exist yet.
 * Port of `init_db()` + `init_time_series()` (the `PRAGMA` lines are dropped —
 * they are SQLite-local-file settings that have no meaning in D1).
 */
export async function initDb(db: D1Database): Promise<D1Result[]> {
  const statements = SCHEMA_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  return db.batch(statements.map((stmt) => db.prepare(stmt)));
}

// ---------------------------------------------------------------------------
// indicators
// ---------------------------------------------------------------------------

/** ISO timestamp now. `new Date().toISOString()` == Python `utcnow().isoformat()`. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** `YYYY-MM-DD HH:MM UTC`. Matches `models.set_last_updated()` exactly. */
export function nowUtcLabel(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`
  );
}

/**
 * Insert or update an indicator value.
 * Port of `upsert_indicator()`. `INSERT OR REPLACE` is valid D1 SQLite syntax.
 */
export async function upsertIndicator(
  db: D1Database,
  code: string,
  name: string,
  value: number,
  year: number,
): Promise<D1Result> {
  return db
    .prepare(
      `INSERT OR REPLACE INTO indicators (code, name, value, year, fetched_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(code, name, value, year, nowIso())
    .run();
}

/**
 * Last N years of data for an indicator, ordered by year desc.
 * Port of `get_indicator_data()`. Rows with a NULL value are excluded — the
 * World Bank returns explicit nulls for missing years, and the Flask version
 * skipped them.
 */
export async function getIndicatorData(
  db: D1Database,
  code: string,
  years = 5,
): Promise<IndicatorDataRow[]> {
  const res = await db
    .prepare(
      `SELECT code, name, value, year, fetched_at
         FROM indicators
        WHERE code = ? AND value IS NOT NULL
        ORDER BY year DESC LIMIT ?`,
    )
    .bind(code, years)
    .all<IndicatorDataRow>();
  return res.results ?? [];
}

/**
 * Latest value for an indicator.
 * Port of `get_latest()`.
 */
export async function getLatest(
  db: D1Database,
  code: string,
): Promise<IndicatorDataRow | null> {
  const res = await db
    .prepare(
      `SELECT code, name, value, year, fetched_at
         FROM indicators
        WHERE code = ? AND value IS NOT NULL
        ORDER BY year DESC LIMIT 1`,
    )
    .bind(code)
    .first<IndicatorDataRow>();
  return res ?? null;
}

// ---------------------------------------------------------------------------
// metadata
// ---------------------------------------------------------------------------

/**
 * Last-updated timestamp from metadata.
 * Port of `get_last_updated()`.
 */
export async function getLastUpdated(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM metadata WHERE key = 'last_updated'`)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/**
 * Set last-updated timestamp.
 * Port of `set_last_updated()`.
 */
export async function setLastUpdated(db: D1Database): Promise<D1Result> {
  return db
    .prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_updated', ?)`)
    .bind(nowUtcLabel())
    .run();
}

/**
 * Arbitrary metadata read by key.
 * Port of `get_series_metadata()` (same table, generic key).
 */
export async function getSeriesMetadata(
  db: D1Database,
  key: string,
): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM metadata WHERE key = ?`)
    .bind(key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

/**
 * Arbitrary metadata write by key.
 * Port of `set_series_metadata()`.
 */
export async function setSeriesMetadata(
  db: D1Database,
  key: string,
  value: string,
): Promise<D1Result> {
  return db
    .prepare(`INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)`)
    .bind(key, value)
    .run();
}

// ---------------------------------------------------------------------------
// indicators — per-indicator timestamp
// ---------------------------------------------------------------------------

/**
 * fetched_at for the most recent non-null row of an indicator.
 * Port of `get_indicator_last_updated()`.
 */
export async function getIndicatorLastUpdated(
  db: D1Database,
  code: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT fetched_at FROM indicators
        WHERE code = ? AND value IS NOT NULL
        ORDER BY year DESC LIMIT 1`,
    )
    .bind(code)
    .first<{ fetched_at: string }>();
  return row?.fetched_at ?? null;
}

// ---------------------------------------------------------------------------
// time_series
// ---------------------------------------------------------------------------

/**
 * Insert or update a time-series point.
 * Port of `upsert_series()`.
 */
export async function upsertSeries(
  db: D1Database,
  seriesKey: string,
  dateStr: string,
  value: number,
): Promise<D1Result> {
  return db
    .prepare(
      `INSERT OR REPLACE INTO time_series (series_key, date, value, fetched_at)
       VALUES (?, ?, ?, ?)`,
    )
    .bind(seriesKey, dateStr, value, nowIso())
    .run();
}

/**
 * Most recent `limit` rows of a series, ordered by date ascending.
 * Port of `get_series()` — note the port keeps the original's two-step
 * ordering: `ORDER BY date DESC LIMIT ?` then reverse, so the returned array
 * ends ascending. A `date ASC LIMIT ?` query would return a *different* window
 * (the oldest rows), which would silently change every chart's x-axis.
 */
export async function getSeries(
  db: D1Database,
  seriesKey: string,
  limit = 100,
): Promise<SeriesRow[]> {
  const res = await db
    .prepare(
      `SELECT date, value, fetched_at FROM time_series
        WHERE series_key = ? AND value IS NOT NULL
        ORDER BY date DESC LIMIT ?`,
    )
    .bind(seriesKey, limit)
    .all<SeriesRow>();
  return (res.results ?? []).slice().reverse();
}

/**
 * Most recent value for a series.
 * Port of `get_latest_series()`.
 */
export async function getLatestSeries(
  db: D1Database,
  seriesKey: string,
): Promise<SeriesRow | null> {
  const res = await db
    .prepare(
      `SELECT date, value, fetched_at FROM time_series
        WHERE series_key = ? AND value IS NOT NULL
        ORDER BY date DESC LIMIT 1`,
    )
    .bind(seriesKey)
    .first<SeriesRow>();
  return res ?? null;
}

/**
 * fetched_at for the most recent non-null row of a series.
 * Port of `get_series_last_updated()`.
 */
export async function getSeriesLastUpdated(
  db: D1Database,
  seriesKey: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT fetched_at FROM time_series
        WHERE series_key = ? AND value IS NOT NULL
        ORDER BY date DESC LIMIT 1`,
    )
    .bind(seriesKey)
    .first<{ fetched_at: string }>();
  return row?.fetched_at ?? null;
}

// ---------------------------------------------------------------------------
// aggregates
// ---------------------------------------------------------------------------

/**
 * Total indicator rows stored. Used by /health to verify a deploy.
 * Port of `count_rows()` — a missing table returns 0 rather than throwing, so
 * a fresh database still answers /health.
 */
export async function countRows(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM indicators`)
      .first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Total time-series rows stored. No Flask counterpart — added so the seed
 * script and /health can report both table sizes.
 */
export async function countSeries(db: D1Database): Promise<number> {
  try {
    const row = await db
      .prepare(`SELECT COUNT(*) AS n FROM time_series`)
      .first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

/**
 * All indicator data for the dashboard.
 * Port of `get_all_data()` — same shape: `{ [code]: { name, data, latest } }`.
 */
export async function getAllData(
  db: D1Database,
): Promise<Record<string, AllDataEntry>> {
  const out: Record<string, AllDataEntry> = {};
  for (const [code, name] of Object.entries(INDICATOR_CODES)) {
    const [data, latest] = await Promise.all([
      getIndicatorData(db, code, 5),
      getLatest(db, code),
    ]);
    out[code] = { name, data, latest };
  }
  return out;
}

/** Delete every row from every table. Used by the seed script's clear step. */
export async function clearAll(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM indicators`),
    db.prepare(`DELETE FROM time_series`),
    db.prepare(`DELETE FROM metadata`),
  ]);
}
