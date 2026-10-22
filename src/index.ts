/**
 * Worker entry point (Hono).
 *
 * Fase 2–3 routes: `/` (dashboard makro), `/micro` + `/micro-economy`
 * (alias), `/download/csv`, `/health`, `/healthz`, `/api/data`,
 * `/api/refresh`. Data comes from D1 only — a page never fabricates a number;
 * when a series is empty the page says so in words.
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
import { isSecureRequest, newNonce, securityHeaders } from "./headers";
import { buildDashboardView, renderDashboard } from "./render";
import { buildMicroView, renderMicro } from "./micro";
import { csvSafe } from "./csv";
// `applyNonce` is owned by `charts.ts` — the chart payload is what makes these
// pages depend on inline scripts, so the stamping rule lives next to the specs.
import { applyNonce } from "./charts";

export interface Env {
  DB: D1Database;
  CACHE_KV: KVNamespace;
  ENVIRONMENT: string;
  SITE_URL: string;
  /** Optional BPS web-API key. Without it BPS inflation falls back to published figures. */
  BPS_API_KEY?: string;
}

const app = new Hono<{ Bindings: Env; Variables: { csp_nonce: string } }>();

/**
 * Every response goes through this: a fresh nonce, the security header set, and
 * the nonce stamped onto every inline `<script>`. Port of the Flask
 * `before_request` / `after_request` pair, done as Hono middleware.
 */
app.use("*", async (c, next) => {
  const nonce = newNonce();
  c.set("csp_nonce", nonce);
  await next();

  const res = c.res;
  if (!res) return;
  const headers = securityHeaders(nonce, isSecureRequest(c.req.raw));
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) res.headers.set(name, value);
  }
  // HTML bodies only: stamping a JSON or CSV body is wasted work, and it would
  // corrupt a body that happens to contain "<script".
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) return;

  const html = await res.text();
  const stamped = applyNonce(html, c.get("csp_nonce"));
  c.res = new Response(stamped, {
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
  });
});

/**
 * Port of `/health`. Reports the row counts a deploy check needs. The Flask
 * version reported `scheduler_running` from APScheduler; the equivalent fact
 * here is that the cron trigger is wired.
 */
app.get("/health", async (c) => {
  await initDb(c.env.DB);
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    scheduler_running: "cron",
    rows_stored: await countRows(c.env.DB),
    series_stored: await countSeries(c.env.DB),
    last_updated: await getLastUpdated(c.env.DB),
    environment: c.env.ENVIRONMENT,
  });
});

/**
 * Port of `/healthz`. Render's default Health Check Path is /healthz, and a 404
 * there makes the platform treat the deploy as failed — so it must answer JSON
 * too, not just `/health`.
 */
app.get("/healthz", async (c) => {
  await initDb(c.env.DB);
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    rows_stored: await countRows(c.env.DB),
    series_stored: await countSeries(c.env.DB),
  });
});

/** Dashboard makro. Port of `dashboard()` + `templates/dashboard.html`. */
app.get("/", async (c) => {
  await initDb(c.env.DB);
  const view = await buildDashboardView(c.env.DB);
  return c.html(renderDashboard(view, c.get("csp_nonce")));
});

/** Micro economy page. Port of `micro_economy()` + `templates/micro.html`. */
app.get("/micro", async (c) => {
  await initDb(c.env.DB);
  const query = {
    daerah: c.req.query("daerah") ?? undefined,
    province: c.req.query("province") ?? undefined,
  };
  const view = await buildMicroView(c.env.DB, query);
  return c.html(renderMicro(view, c.get("csp_nonce")));
});

/** Alias — the Flask app serves both paths with the same handler. */
app.get("/micro-economy", async (c) => {
  await initDb(c.env.DB);
  const query = {
    daerah: c.req.query("daerah") ?? undefined,
    province: c.req.query("province") ?? undefined,
  };
  const view = await buildMicroView(c.env.DB, query);
  return c.html(renderMicro(view, c.get("csp_nonce")));
});

/** Port of `download_csv()` — spreadsheet-formula injection neutralised. */
app.get("/download/csv", async (c) => {
  await initDb(c.env.DB);
  const data = await getAllData(c.env.DB);
  const lines: string[] = ["Indicator,Code,Year,Value,Fetched At"];
  for (const [code, info] of Object.entries(data)) {
    for (const row of info.data) {
      lines.push(
        [
          csvSafe(info.name),
          csvSafe(code),
          String(row.year),
          String(row.value),
          csvSafe(row.fetched_at),
        ].join(","),
      );
    }
  }
  return new Response(lines.join("\n"), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": "attachment; filename=indonesia_economic_data.csv",
    },
  });
});

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

/** Data dump for the renderer (kept for parity with the Flask `/api/data`). */
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
