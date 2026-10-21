/**
 * Worker entry point (Hono).
 *
 * Fase 0–1 scope: the D1 schema, the data layer and the fetchers exist and are
 * exercised by `scripts/seed.mjs`. HTTP routes for the dashboard are fase 2–4;
 * the handlers below are the ones this fase needs — `/health`, `/healthz` and
 * `/api/refresh` — so `wrangler dev` has something real to serve.
 */

import { Hono } from "hono";
import {
  countRows,
  countSeries,
  getAllData,
  getLastUpdated,
  getSeriesMetadata,
  initDb,
  nowUtcLabel,
  setSeriesMetadata,
} from "./db";
import { fetchAllIndicators, fetchAllMacro, fetchAllMicro } from "./fetchers";

export interface Env {
  DB: D1Database;
  CACHE_KV: KVNamespace;
  ENVIRONMENT: string;
  SITE_URL: string;
  /** Optional BPS web-API key. Without it BPS inflation falls back to published figures. */
  BPS_API_KEY?: string;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/health", async (c) => {
  await initDb(c.env.DB);
  const indicators = await countRows(c.env.DB);
  const series = await countSeries(c.env.DB);
  const lastUpdated = await getLastUpdated(c.env.DB);
  return c.json({
    status: "ok",
    indicators,
    series,
    last_updated: lastUpdated,
    environment: c.env.ENVIRONMENT,
  });
});

app.get("/healthz", (c) => c.text("ok"));

/** Force a fetch pass now. Used by the cron trigger and by manual refresh. */
app.post("/api/refresh", async (c) => {
  const bpsKey = c.req.header("x-bps-key") || c.env.BPS_API_KEY;
  return c.json(await refreshAll(c.env, bpsKey));
});

/** GET variant so the endpoint can be triggered from a browser or a curl. */
app.get("/api/refresh", async (c) => {
  const bpsKey = c.req.query("bps_key") || c.env.BPS_API_KEY;
  return c.json(await refreshAll(c.env, bpsKey));
});

/** Data dump for the fase 2 renderer. */
app.get("/api/data", async (c) => {
  await initDb(c.env.DB);
  const data = await getAllData(c.env.DB);
  return c.json({
    indicators: data,
    last_updated: await getLastUpdated(c.env.DB),
    macro_last_updated: await getSeriesMetadata(c.env.DB, "macro_last_updated"),
    micro_last_updated: await getSeriesMetadata(c.env.DB, "micro_last_updated"),
  });
});

/** Fallback — replaced by the dashboard HTML in fase 2. */
app.get("/", (c) =>
  c.text(
    "inthiseconomy-worker: data layer ready.\n" +
      "Routes this fase: /health, /healthz, /api/refresh, /api/data\n" +
      "Dashboard HTML arrives in fase 2.",
    200,
    { "content-type": "text/plain; charset=utf-8" },
  ),
);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, ctx);
  },
  /** Cron trigger: every 6 hours per wrangler.toml. */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refreshAll(env, env.BPS_API_KEY));
  },
};

/** Shared refresh body for the HTTP routes and the cron trigger. */
export async function refreshAll(env: Env, bpsKey?: string): Promise<{
  indicators: number;
  macro: number;
  micro: number;
  rows: number;
  series_rows: number;
  macro_failures: string[];
  micro_failures: string[];
}> {
  await initDb(env.DB);
  const indicators = await fetchAllIndicators(env.DB);
  const macro = await fetchAllMacro(env.DB, { bpsApiKey: bpsKey });
  const micro = await fetchAllMicro(env.DB);
  const rows = await countRows(env.DB);
  const series = await countSeries(env.DB);
  await setSeriesMetadata(env.DB, "refresh_last_run", nowUtcLabel());
  return {
    indicators: indicators.total,
    macro: macro.total,
    micro: micro.total,
    rows,
    series_rows: series,
    macro_failures: macro.failures,
    micro_failures: micro.failures,
  };
}
