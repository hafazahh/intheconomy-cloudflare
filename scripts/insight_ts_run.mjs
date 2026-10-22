/**
 * TypeScript side of the insight cross-check.
 *
 * Reads the JSON oracle produced by `insight_py_dump.py` (the Flask
 * `generate_insight()` output), runs the Worker's `generateInsight()` on the
 * same inputs, and writes the results next to the oracle for a byte diff.
 *
 * The data shape matches `AllDataEntry` in `src/db.ts` exactly, so the Worker
 * function is exercised with the same values the Python function saw.
 */
import { build } from "esbuild";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const oraclePath = process.argv[2];
const outPath = process.argv[3];
if (!oraclePath || !outPath) {
  console.error("usage: node insight_ts_run.mjs <oracle.json> <out.json>");
  process.exit(2);
}

const out = join(mkdtempSync(join(tmpdir(), "insight-ts-")), "kpi.mjs");
await build({
  entryPoints: ["src/kpi.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: out,
  logLevel: "silent",
});
const { generateInsight } = await import(out);

const cases = JSON.parse(readFileSync(oraclePath, "utf8"));
const results = cases.map((c) => ({
  name: c.name,
  actual: generateInsight(c.data, c.bps),
}));
writeFileSync(outPath, JSON.stringify(results, null, 1), "utf8");
console.log("wrote", outPath, results.length, "cases");
