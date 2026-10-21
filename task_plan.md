# Task Plan — inthiseconomy-cloudflare (port Flask → Cloudflare Worker)

## Goal

Pindahkan **Indonesia Economic Dashboard** dari Render (free tier, sekarang
SUSPENDED) ke **Cloudflare Workers + D1**, pola yang sama dengan
`shop.choirulhaq.com` (Worker + D1 + assets).

**Alasan:** 3 service Render free (`logic`, `crud`, `inthiseconomy`) **semuanya
503 "Service Suspended" bersamaan** (terverifikasi 2026-10-21). Free tier Render
punya kuota **750 instance-hours/bulan yang dibagi semua service gratis** — 3+
service jalan 24/7 = kuota habis. Cloudflare Workers free = **100.000
request/hari tanpa batas jam bulanan**, jadi tidak kena masalah yang sama.

## Status: FASE 0–1 SELESAI (2026-10-21) — Fase 2 menunggu

---

## Jawaban singkat: BISA, tapi ini PORT, bukan copy

Shop dan dashboard **beda bentuk**:

| | shop.choirulhaq.com | inthiseconomy (sekarang) |
|---|---|---|
| Frontend | Astro, **prerender statis** | Flask + Jinja2, **render saat request** |
| Data | API di-build-time | Dibaca DB tiap request |
| Runtime | TypeScript (Worker) | **Python (Flask + gunicorn)** |

Jadi platform & mekanisme deploy-nya sama (Worker + D1 + `wrangler deploy`),
**tapi kodenya harus di-port dari Python ke TypeScript.** Tidak ada Python di
Workers — hanya JS/WASM. Tidak bisa copy-paste.

---

## Pemetaan port

| Sekarang (Python) | Nanti (Cloudflare) | Catatan |
|---|---|---|
| `app.py` — 6 route Flask | `src/index.ts` — Hono routes | `/`, `/micro`, `/micro-economy`, `/download/csv`, `/health`, `/healthz` |
| `templates/dashboard.html` (Jinja2) | `src/render.ts` — template string TS | render saat request |
| `economic_data.db` (SQLite) | **D1** | SQLite-compatible, `env.DB.prepare()` |
| `models.py` (241 baris) | `src/db.ts` | query port 1:1 |
| `data_fetcher.py`, `macro_fetcher.py`, `micro_fetcher.py` (516 baris) | `src/fetchers.ts` | `requests` → `fetch()` |
| `scheduler.py` (APScheduler 6 jam) | `[triggers] crons` di `wrangler.toml` | cron trigger bawaan Workers |
| `plotly.py` render server-side | `Plotly.newPlot()` client-side + JSON | chart tetap jalan |
| `app.py` nonce CSP + header | `src/headers.ts` | **grade A+ harus tetap** |
| `gunicorn app:app` | `wrangler deploy` | |
| `render.yaml` + `Procfile` | `wrangler.toml` | |

**Perkiraan: ±2000 baris TypeScript.** Setara build baru, bukan migrasi 1 hari.

---

## Risiko & batasan Workers (free)

| Batasan | Dampak | Mitigasi |
|---|---|---|
| **CPU 10 ms/invocation** (free) | render HTML + baca D1 harus muat | cache HTML di KV; render hanya saat data berubah |
| **50 subrequest/invocation** | hanya dipakai saat refresh data (cron), bukan per request | aman |
| **Tanpa persistent disk** | D1 tetap persisten (beda dgn Render free) | justru lebih baik dari sekarang |
| **Cron trigger hanya jalan kalau ada traffic**? | tidak — cron Workers jalan sendiri | aman |
| `requests`/socket/DB native | tidak ada | semua sudah diganti `fetch()`/D1 |
| Plotly inline script | butuh nonce CSP | port `apply_nonce` → TS |

---

## Fase

| # | Fase | Output | Status |
|---|------|--------|--------|
| 0 | Setup folder + `wrangler.toml` + D1 | D1 DB id, skeleton Hono | ✅ |
| 1 | Port data layer (`db.ts` + `fetchers.ts`) + `scripts/seed.mjs` | D1 keisi 176+ rows | ✅ |
| 2 | Port `render.ts` + route `/` (dashboard makro) | HTML identik + 7 chart | 🔲 |
| 3 | Port route `/micro` + `/micro-economy` | halaman micro lengkap | 🔲 |
| 4 | Port `/download/csv`, `/health`, `/healthz` | semua route 200 | 🔲 |
| 5 | Port security headers (nonce CSP) → cek grade A+ | `test_security_headers` 50/50 | 🔲 |
| 6 | Port test: `test_kpi_units`, `test_insight_dynamic`, `verify_acceptance` | semua PASS | 🔲 |
| 7 | `[triggers] crons` + `wrangler deploy` + custom domain | live di `inthiseconomy.choirulhaq.com` | 🔲 |
| 8 | Verifikasi browser nyata + acceptance 15/15 | bukti screenshot | 🔲 |

### Fase 0 — bukti

| Resource | Nilai |
|---|---|
| D1 | `inthiseconomy-db` → `5c49ae6d-3318-421a-bf55-f20d3b4e90b0` |
| KV | `CACHE_KV` → `f4e71de19c104525acebe9b09f85b94c` |
| `wrangler dev` | `Ready on http://localhost:8788`, semua route 200 |

### Fase 1 — bukti

```
seed.mjs --remote → indicators 176 · time_series 545 · series keys 29
tsc --noEmit       → exit 0
curl /health       → 200 {"indicators":176,"series":545,...}
curl /api/refresh  → 200 dalam 5,3 s (176/290/22 rows)
```

**16 fungsi `models.py` semua ter-port** (tabel di `progress.md`). Sumber gagal
(BPS butuh API key, Pertamina tanpa harga, gold history ±5 bulan) dicatat di
`findings.md` — tidak ada angka karangan.

---

## Alternatif (lebih murah effort, ada biaya)

**Render plan berbayar $7/bulan per service.** Nol porting. Tapi ada **3 service
Render** yang kena suspend (`logic`, `crud`, `inthiseconomy`) → **$21/bulan**
kaligus semua. Dan tetap tanpa disk persisten yang andal.

Worker = **$0/bulan**, tapi ±2000 baris port. Break-even jelas ke Worker kalau
anggaran nol.

---

## Aturan khusus

- **Branch/repo baru** — jangan campur ke repo Flask `hafazahh/indonesia-economic-dashboard`
  (repo itu tetap jadi arsip versi Render). Repo baru untuk versi Worker.
- **Domain `inthiseconomy.choirulhaq.com` tetap** — tinggal ganti CNAME/route
  dari Render ke Worker (via dashboard, sesuai pitfall di skill `cloudflare-worker-api`).
- **Custom domain WAJIB via dashboard**, bukan `routes` di `wrangler.toml`
  (pitfall sudah tertulis: `routes` tidak reliably mengaktifkan custom domain).
- **Grade security A+ harus di-reverify** di domain baru — jangan anggap ikut.
- **Angka KPI harus tetap sama** — port `test_kpi_units.py` (17 assertion) dan
  `test_insight_dynamic.py` (21 skenario) ke TS, jalankan sebelum deploy.

## Errors Encountered

| Error | Attempt | Resolution |
|---|---|---|
| `npm install 2>&1` blocked by Tirith single-query mode | 1 | run without the pipe |
| `wrangler types` failed: `src/env.d.ts` missing | 1 | `src/` existed; re-run succeeded |
| LSP: `D1Database` not exported from `@cloudflare/workers-types/experimental` | 1 | `env.d.ts` already declares the globals — drop the import |
| Local seed: Trade Balance timed out | 1 | retry engaged; 45 rows on the second run |
| Local seed: `indicators: undefined` | 1 | `wrangler d1 execute --json` returns a top-level array |
| Gold history returned 6 points | 1 | endpoint only serves ~5 months; added `GOLD_HISTORY_KNOWN` |
| `write_file` refused (stale copy) | 1 | re-read the file, then patch |

