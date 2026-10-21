# inthiseconomy-cloudflare

Port **Indonesia Economic Dashboard** dari Render (Flask + SQLite + APScheduler)
ke **Cloudflare Workers + D1 + KV**.

- **Sumber (arsip):** `../` — repo Flask `hafazahh/indonesia-economic-dashboard`
- **Task plan:** `task_plan.md`
- **Board kanban:** `indonesia-economic-dashboard`
- **Domain target:** `inthiseconomy.choirulhaq.com` (CNAME tetap, ganti route ke Worker)

## Kenapa pindah

Free tier Render punya kuota **750 instance-hours/bulan yang dibagi semua service
gratis di akun**. 3 service (`logic`, `crud`, `inthiseconomy`) jalan 24/7 → kuota
habis → ketiganya **503 "Service Suspended" bersamaan** (terverifikasi 2026-10-21).
Workers free = 100.000 request/hari tanpa batas jam bulanan.

## Struktur

```
inthiseconomy-cloudflare/
├── src/
│   ├── index.ts        # Hono app: /health, /healthz, /api/refresh, /api/data, / (fase 2+)
│   ├── db.ts           # D1 queries (port models.py) — 16 fungsi
│   ├── fetchers.ts     # World Bank, BI, BPS, frankfurter, Pertamina, IKK, emas
│   ├── render.ts       # HTML template (port templates/dashboard.html) — fase 2
│   ├── charts.ts       # Plotly JSON + client-side newPlot — fase 2
│   ├── headers.ts      # CSP nonce + security headers (jaga grade A+) — fase 5
│   └── env.d.ts        # generated: wrangler types
├── scripts/
│   └── seed.mjs        # D1 schema + initial fetch (--remote / --clear)
├── task_plan.md
├── findings.md
├── progress.md
└── wrangler.toml
```

## Cara jalan

```bash
npm install
npm run seed            # isi D1 lokal
npm run seed:remote     # isi D1 production
npm run dev             # wrangler dev --port 8788 (D1 + KV lokal)
npm run deploy          # wrangler deploy
```

Route yang ada di Fase 0–1: `/health`, `/healthz`, `/api/refresh` (fetch semua
sumber sekarang), `/api/data` (dump JSON untuk renderer fase 2).

## Sumber data — status Fase 1

| Sumber | Status |
|---|---|
| World Bank (7 indikator) | ✅ live |
| BI-Rate | ✅ live, 129 titik dari JSON blob |
| USD/IDR (frankfurter.app) | ✅ live |
| Emas (logam-mulia worker) | ✅ live |
| IKK (TradingEconomics) | ✅ live |
| Inflasi YoY BPS | ❌ butuh API key → fallback 21 titik |
| BBM (Pertamina) | ❌ halaman tanpa harga → fallback |
| Emas history | ⚠️ endpoint ±5 bulan → ditambah baseline |

Detail + angka terukur: `findings.md` bagian "Hasil Fase 0–1".

## Aturan khusus project ini

- **Jangan campur ke repo Flask.** Repo ini sendiri; folder induk sudah di-ignore
  di `.gitignore` repo Flask.
- **Custom domain via dashboard**, bukan `routes` di `wrangler.toml`.
- **Angka KPI harus identik** dengan versi Flask — port `test_kpi_units.py`
  (17 assertion) dan `test_insight_dynamic.py` (21 skenario).
- **Grade security A+ harus di-reverify** di domain baru.
- **CPU free tier 10 ms/invocation** — render HTML di-cache di KV, bukan dihitung
  ulang tiap request.
