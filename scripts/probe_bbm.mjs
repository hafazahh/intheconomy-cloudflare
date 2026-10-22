/** Probe: what is BBM_PER_DAERAH at runtime in the bundle? */
import { build } from "esbuild";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = "/home/choirulhaq/venvProject/indonesia-economic-dashboard/inthiseconomy-cloudflare";
const out = join(mkdtempSync(join(tmpdir(), "b-")), "f.mjs");
await build({ entryPoints: [join(ROOT, "src/fetchers.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
const mod = await import(out);
console.log("exports:", Object.keys(mod).filter((k) => /BBM|UMP/.test(k)));
console.log("BBM_PER_DAERAH:", JSON.stringify(mod.BBM_PER_DAERAH, null, 1));
console.log("UMP count:", Object.keys(mod.UMP_PROVINSI).length);
