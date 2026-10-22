/** Probe: what does buildMicroView produce right now, in isolation? */
import { build } from "esbuild";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const ROOT = "/home/choirulhaq/venvProject/indonesia-economic-dashboard/inthiseconomy-cloudflare";

const scratch = mkdtempSync(join(tmpdir(), "probe-"));
const copy = join(scratch, "s.sqlite");
copyFileSync(
  join(ROOT, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/835495cd993b39989a3bb0a40c7ec0f058d41a7629faf5f3150cf1afe53543ce.sqlite"),
  copy,
);
const con = new DatabaseSync(copy, { readOnly: true });
const params = (sql) => (sql.match(/\?/g) || []).length;
const db = {
  prepare(sql) {
    const stmt = con.prepare(sql);
    const all = (...p) => stmt.all(...p.slice(0, params(sql)).map((v) => (typeof v === "bigint" ? Number(v) : v)));
    const first = (...p) => {
      const r = stmt.get(...p.slice(0, params(sql)).map((v) => (typeof v === "bigint" ? Number(v) : v)));
      return r === undefined ? null : r;
    };
    return { bind: (...p) => ({ all: () => ({ results: all(...p) }), first: () => first(...p), run: () => undefined }), all: () => ({ results: all() }), first: () => first(), run: () => undefined };
  },
  batch: async () => [],
};

const out = join(scratch, "m.mjs");
await build({ entryPoints: [join(ROOT, "src/micro.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
const mod = await import(out);
const view = await mod.buildMicroView(db, { daerah: "jawa", province: "" });
const bw = view.charts["chart-bbm-vs-wage"];
console.log("bbm y last 2 :", bw.data[0].y.slice(-2));
console.log("annotations   :", bw.layout.annotations.map((a) => a.text).length);
console.log("metrics       :", JSON.stringify(view.metrics, null, 0));
con.close();
