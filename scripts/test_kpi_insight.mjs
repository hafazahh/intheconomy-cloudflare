/**
 * Port of `test_insight_dynamic.py` (21 scenarios) and `test_kpi_units.py`
 * (17 assertions) against the TypeScript modules, driven from Node.
 *
 * The Python suites are the reference: this script re-runs their exact input
 * values through `src/kpi.ts` and asserts the same phrases appear. A green run
 * here means the ported logic produces the ported text — which is the regression
 * guard the card asks for before deploy.
 *
 * The TS side is loaded through esbuild (already a devDependency via wrangler),
 * so no separate build step is needed.
 */
import { build } from "esbuild";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(mkdtempSync(join(tmpdir(), "kpi-test-")), "kpi.mjs");

await build({
  entryPoints: ["src/kpi.ts"],
  bundle: true,
  format: "esm",
  platform: "neutral",
  outfile: out,
  logLevel: "silent",
});

const kpi = await import(out);
const { generateInsight, computeKpis, computeDashboardKpis, formatChange } = kpi;

let passed = 0;
let failed = 0;
const failures = [];

function check(label, cond, detail = "") {
  if (cond) {
    passed += 1;
    console.log(`[PASS] ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`[FAIL] ${label}${detail ? `: ${detail}` : ""}`);
  }
}

const GDP = "NY.GDP.MKTP.KD.ZG";
const INF = "FP.CPI.TOTL.ZG";
const TRD = "BN.GSR.GNFS.CD";

function make(pdb, inf, trd, year = 2025, pdbPrev, infPrev, trdPrev) {
  function latest(code, v, prevV) {
    const data = [{ value: v, year }];
    if (prevV !== undefined) data.push({ value: prevV, year: year - 1 });
    return { [code]: { name: code, data, latest: { value: v, year } } };
  }
  return {
    ...latest(GDP, pdb, pdbPrev),
    ...latest(INF, inf, infPrev),
    ...latest(TRD, trd, trdPrev),
  };
}

const scenarios = [
  ["Data sekarang (nyata 2025)", make(5.108, 1.913, 29649335679.15, 2025, 4.9, 2.5, 25000000000.0)],
  ["PDB naik (membaik)", make(5.5, 1.913, 29649335679.15, 2025, 4.9)],
  ["PDB turun tapi >=5%", make(5.1, 1.913, 29649335679.15, 2025, 5.5)],
  ["PDB 4.5-5% (melambat)", make(4.7, 1.913, 29649335679.15, 2025, 5.0)],
  ["PDB <4.5% (moderat)", make(3.2, 1.913, 29649335679.15, 2025, 4.0)],
  ["Inflasi <2% (bawah)", make(5.108, 1.5, 29649335679.15)],
  ["Inflasi 2-4% (dalam)", make(5.108, 3.0, 29649335679.15)],
  ["Inflasi >4% (atas)", make(5.108, 6.5, 29649335679.15)],
  ["Trade surplus besar", make(5.108, 1.913, 25000000000.0)],
  ["Trade surplus moderat", make(5.108, 1.913, 15000000000.0)],
  ["Trade surplus kecil", make(5.108, 1.913, 5000000000.0)],
  ["Trade defisit", make(5.108, 1.913, -12500000000.0)],
  ["Trade surplus melebar", make(5.108, 1.913, 30000000000.0, 2025, undefined, undefined, 20000000000.0)],
  ["Trade surplus menyempit", make(5.108, 1.913, 20000000000.0, 2025, undefined, undefined, 30000000000.0)],
  ["Trade defisit melebar", make(5.108, 1.913, -15000000000.0, 2025, undefined, undefined, -5000000000.0)],
  ["Trade defisit menyempit", make(5.108, 1.913, -5000000000.0, 2025, undefined, undefined, -15000000000.0)],
  ["Trade berubah dari defisit", make(5.108, 1.913, 5000000000.0, 2025, undefined, undefined, -5000000000.0)],
  ["Trade berubah dari surplus", make(5.108, 1.913, -5000000000.0, 2025, undefined, undefined, 5000000000.0)],
  ["Kombinasi: growth tinggi + inflasi rendah", make(5.5, 1.5, 29649335679.15)],
  ["Kombinasi: growth melambat + inflasi tinggi", make(4.0, 6.5, 29649335679.15)],
  ["Semua indikator memburuk", make(2.0, 8.0, -5000000000.0)],
];

console.log("=".repeat(78));
const texts = [];
for (const [name, data] of scenarios) {
  const insight = generateInsight(data);
  texts.push(insight);
  console.log(`\n### ${name}\n${insight}`);
}
console.log("\n" + "=".repeat(78));

const unique = new Set(texts).size;
check(`21 skenario menghasilkan 21 teks unik (dapat ${unique})`, unique === scenarios.length);

const checks = [
  ["PDB naik -> 'solid dan membaik'", texts[1].includes("solid dan membaik")],
  ["PDB turun >=5% -> 'masih solid meskipun melambat'", texts[2].includes("masih solid meskipun melambat")],
  ["PDB 4.5-5% -> 'melambat'", texts[3].includes("melambat")],
  ["PDB <4.5% -> 'moderat'", texts[4].includes("moderat")],
  ["Inflasi <2% -> 'di bawah target BI'", texts[5].includes("di bawah target BI")],
  ["Inflasi <2% -> 'akomodatif'", texts[5].includes("akomodatif")],
  ["Inflasi 2-4% -> 'dalam target BI'", texts[6].includes("dalam target BI")],
  ["Inflasi >4% -> 'di atas target BI'", texts[7].includes("di atas target BI")],
  ["Inflasi >4% -> 'menekan ruang'", texts[7].includes("menekan ruang")],
  ["Surplus besar -> 'surplus besar'", texts[8].includes("surplus besar")],
  ["Surplus moderat -> 'surplus moderat'", texts[9].includes("surplus moderat")],
  ["Surplus kecil -> 'surplus kecil'", texts[10].includes("surplus kecil")],
  ["Defisit -> 'defisit'", texts[11].includes("defisit")],
  ["Surplus melebar -> 'surplus melebar'", texts[12].includes("surplus melebar")],
  ["Surplus menyempit -> 'surplus menyempit'", texts[13].includes("surplus menyempit")],
  ["Defisit melebar -> 'defisit melebar'", texts[14].includes("defisit melebar")],
  ["Defisit menyempit -> 'defisit menyempit'", texts[15].includes("defisit menyempit")],
  ["Berubah dari defisit", texts[16].includes("berubah dari defisit")],
  ["Berubah dari surplus", texts[17].includes("berubah dari surplus")],
  ["Growth tinggi + inflasi rendah -> 'mendukung ekspansi'", texts[18].includes("mendukung ekspansi")],
  ["Growth melambat + inflasi tinggi -> 'kehati-hatian'", texts[19].includes("kehati-hatian")],
  ["Inflasi tinggi -> tidak klaim 'akomodatif'", !texts[7].includes("akomodatif")],
  ["PDB lemah -> tidak klaim 'ekspansi pasar domestik'", !texts[4].includes("ekspansi pasar domestik")],
  ["Angka tahun ikut tampil", texts[0].includes("(2025)")],
  ["Angka nilai ikut tampil", texts[0].includes("5.1%") && texts[0].includes("1.9%")],
];

console.log();
for (const [label, ok] of checks) check(label, ok);

// ---------- BPS inflation (bulanan) diprioritaskan ----------
console.log("\n" + "=".repeat(78));
console.log("TES BPS INFLASI (bulanan)");
console.log("=".repeat(78));

const bpsData = make(5.108, 1.913, 29649335679.15, 2025, 4.9, 2.5);
const insightWb = generateInsight(bpsData);
const insightBps = generateInsight(bpsData, { value: 3.28, date: "2026-09-01" });
console.log(`\nTanpa BPS: ${insightWb}\n\nDengan BPS: ${insightBps}`);

const bpsChecks = [
  ["BPS: teks berbeda dari World Bank", insightWb !== insightBps],
  ["BPS: memakai nilai 3.28%", insightBps.includes("3.28%")],
  ["BPS: memakai label BPS", insightBps.includes("BPS")],
  ["BPS: memakai bulan September 2026", insightBps.includes("September 2026")],
  ["BPS: status dalam target BI", insightBps.includes("dalam target BI")],
  ["WB: memakai nilai 1.9%", insightWb.includes("1.9%")],
  ["WB: memakai tahun 2025", insightWb.includes("2025")],
];
for (const [label, ok] of bpsChecks) check(label, ok);

const insightLow = generateInsight(bpsData, { value: 1.2, date: "2026-09-01" });
check("BPS <1.5%: status di bawah target", insightLow.includes("di bawah target BI"));
check("BPS <1.5%: akomodatif", insightLow.includes("akomodatif"));
const insightHigh = generateInsight(bpsData, { value: 5.5, date: "2026-09-01" });
check("BPS >3.5%: status di atas target", insightHigh.includes("di atas target BI"));
check("BPS >3.5%: menekan ruang", insightHigh.includes("menekan ruang"));

// ---------- test_kpi_units: 17 assertion ----------
console.log("\n" + "=".repeat(78));
console.log("TES UNIT KPI (test_kpi_units.py)");
console.log("=".repeat(78));

const tbNow = 29649335679.1509;
const tbPrev = 21353512597.294;
const kpiData = {
  [TRD]: { name: "Trade Balance", data: [{ value: tbNow, year: 2025 }, { value: tbPrev, year: 2024 }], latest: { value: tbNow, year: 2025 } },
  [INF]: { name: "Inflasi", data: [{ value: 1.91333443295079, year: 2025 }, { value: 2.18151273615188, year: 2024 }], latest: { value: 1.91333443295079, year: 2025 } },
  [GDP]: { name: "PDB Growth", data: [{ value: 5.10808904438025, year: 2025 }, { value: 5.03257477088519, year: 2024 }], latest: { value: 5.10808904438025, year: 2025 } },
};

const kpis = computeKpis(kpiData, () => null);
const byCode = Object.fromEntries(kpis.map((k) => [k.code, k]));

const tbChange = byCode[TRD]?.formatted_change ?? "";
check("Trade Balance TIDAK memakai satuan 'pp'", !tbChange.includes("pp"), `='${tbChange}'`);
check("Trade Balance perubahan dalam miliar USD", tbChange.includes("miliar USD"), `='${tbChange}'`);
const expected = `${(Math.abs(tbNow - tbPrev) / 1e9).toFixed(1)} miliar USD`;
check("Trade Balance nilai perubahan benar", tbChange === expected, `dapat='${tbChange}' harus='${expected}'`);
check("Inflasi World Bank TIDAK di computeKpis", !(INF in byCode));
check("PDB tetap pakai 'pp'", (byCode[GDP]?.formatted_change ?? "").includes("pp"), `='${byCode[GDP]?.formatted_change}'`);
for (const [code, kpi] of Object.entries(byCode)) {
  check(`Card ${code} punya comparison_label`, kpi.comparison_label === "vs tahun lalu", `='${kpi.comparison_label}'`);
}
check("Tidak ada angka mentah USD di label perubahan", !tbChange.includes("8295823081"), `='${tbChange}'`);

// Data kurang dari 2 baris
const oneRow = { [GDP]: { name: "PDB Growth", data: [{ value: 5.1, year: 2025 }], latest: { value: 5.1, year: 2025 } } };
const kOne = computeKpis(oneRow, () => null)[0];
check("Satu baris data -> 'Data tidak cukup'", kOne.formatted_change === "Data tidak cukup", `='${kOne.formatted_change}'`);
check("Satu baris data -> arrow kosong", kOne.change_arrow === "", `='${kOne.change_arrow}'`);

// formatChange langsung
check("formatChange(TRD) tanpa 'pp'", !formatChange(TRD, 1e9).includes("pp"));
check("formatChange(PDB) pakai 'pp'", formatChange(GDP, 0.1).includes("pp"));

// ---------- urutan kartu KPI ----------
// `dashboard()` inserts the BPS card at index 0 and THEN the World Bank card at
// index 0, so the World Bank annual card is the first one on the page. Getting
// this backwards puts the two inflation cards in the wrong order.
console.log("\n" + "=".repeat(78));
console.log("TES URUTAN KARTU KPI");
console.log("=".repeat(78));

const orderData = make(5.108, 1.913, 29649335679.15, 2025, 4.9, 2.5);
const ordered = computeDashboardKpis(
  orderData,
  { value: 3.28, date: "2026-09-01", fetched_at: "2026-10-21 13:08 UTC" },
  [
    { value: 3.28, date: "2026-09-01" },
    { value: 3.14, date: "2026-08-01" },
  ],
  () => "2026-10-21 13:08 UTC",
);
console.log("\nurutan:", ordered.map((k) => `${k.name}=${k.formatted_value}`).join(" | "));
check(
  "kartu pertama Inflasi Tahunan (World Bank)",
  ordered[0]?.code === INF,
  `dapat='${ordered[0]?.name}'`,
);
check(
  "kartu kedua Inflasi YoY (BPS)",
  ordered[1]?.code === "inflation_yoy",
  `dapat='${ordered[1]?.name}'`,
);
check(
  "urutannya WB, BPS, lalu indikator lain",
  ordered.map((k) => k.code).join(",") === `${INF},inflation_yoy,${GDP},${TRD}`,
  `dapat='${ordered.map((k) => k.code).join(",")}'`,
);
check("nilai WB tahunan 1.91%", ordered[0]?.formatted_value === "1.91%", `='${ordered[0]?.formatted_value}'`);
check("nilai BPS bulanan 3.28%", ordered[1]?.formatted_value === "3.28%", `='${ordered[1]?.formatted_value}'`);

// Tanpa BPS (series kosong) kartu WB tetap pertama.
const noBps = computeDashboardKpis(orderData, null, [], () => "t");
check(
  "tanpa BPS: kartu pertama tetap Inflasi Tahunan (World Bank)",
  noBps[0]?.code === INF,
  `dapat='${noBps[0]?.name}'`,
);

console.log("\n" + "=".repeat(78));
console.log(`TOTAL: ${passed}/${passed + failed} PASS`);
if (failures.length) {
  console.log("GAGAL:");
  for (const f of failures) console.log("  -", f);
  process.exit(1);
}
console.log("SEMUA TEST LULUS");
