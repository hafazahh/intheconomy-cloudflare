/** Probe: is the compiled micro.ts running the new code? */
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const ROOT = "/home/choirulhaq/venvProject/indonesia-economic-dashboard/inthiseconomy-cloudflare";
const out = join(mkdtempSync(join(tmpdir(), "b-")), "m.mjs");
await build({ entryPoints: [join(ROOT, "src/micro.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
const t = readFileSync(out, "utf8");
const i = t.indexOf("publishedPertalite");
console.log("index:", i);
console.log(t.slice(i - 700, i + 400));
