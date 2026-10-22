/** Probe: is the new code actually in the bundle? Check the built source text. */
import { build } from "esbuild";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = "/home/choirulhaq/venvProject/indonesia-economic-dashboard/inthiseconomy-cloudflare";
const out = join(mkdtempSync(join(tmpdir(), "bundle-")), "w.mjs");
await build({
  entryPoints: [join(ROOT, "src/index.ts")],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: out,
  logLevel: "silent",
});
const text = readFileSync(out, "utf8");
console.log("bundle bytes:", text.length);
console.log("has publishedPertalite:", text.includes("publishedPertalite"));
console.log("has BBM_PER_DAERAH lookup:", text.includes("prices?.Pertalite") || text.includes('prices === null || prices === void 0 ? void 0 : prices.Pertalite'));
const i = text.indexOf("bbmHistory");
console.log("--- bbmHistory block ---");
console.log(text.slice(i - 900, i + 500));
