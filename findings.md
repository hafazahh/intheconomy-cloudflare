# Findings — port inthiseconomy ke Cloudflare Worker

## Akar masalah Render

Free tier Render: kuota **750 instance-hours/bulan dibagi semua service gratis**.
Terverifikasi 2026-10-21 09:12 UTC — tiga service di akun ini **503 bersamaan**:

```
inthiseconomy  503  x-render-routing: suspend
crud           503  x-render-routing: suspend
logic          503  x-render-routing: suspend
vision         200  (Worker → Streamlit Cloud, bukan Render)
shop           200  (Worker + D1)
```

Bukan spin-down biasa (spin-down balik 200 setelah wake-up). Ini suspend permanen
sampai kuota reset / service dihidupkan manual dari dashboard.

**Konsekuensi:** setiap project Python yang masih di Render berisiko mati tiap
bulan. `crud` dan `logic` juga kena. Port ini sekaligus jadi template untuk
memindahkan yang lain.

## Bukti Cloudflare siap

- `wrangler whoami` lolos → token OAuth ada di `~/.config/.wrangler/config/default.toml`
- Worker `shop-worker` + `vision-proxy` sudah live di akun yang sama → tidak ada
  setup akun yang tersisa
- Free tier Workers: 100.000 request/hari, tanpa batas jam bulanan

## Port mapping (Python → TypeScript)

| Sumber | Tujuan | Baris |
|---|---|---|
| `app.py` (1289) route `/`, `/micro`, `/micro-economy`, `/download/csv`, `/health`, `/healthz` | `src/index.ts` Hono | ±400 |
| `models.py` (241) | `src/db.ts` | ±250 |
| `data_fetcher.py` (55) | `src/fetchers.ts` | ±60 |
| `macro_fetcher.py` (259) | `src/fetchers.ts` | ±300 |
| `micro_fetcher.py` (202) | `src/fetchers.ts` | ±230 |
| `scheduler.py` (63) | `[triggers] crons` di `wrangler.toml` | ±5 |
| `templates/dashboard.html` (Jinja2) | `src/render.ts` | ±400 |
| `app.py` chart builder + `apply_nonce` | `src/charts.ts` + `src/headers.ts` | ±150 |
| **Total** | | **±1800** |

## Keputusan desain

**1. Render di-cache di KV, bukan dihitung ulang tiap request.**
Free tier Workers: **10 ms CPU per invocation**. Render Jinja2 ±400 baris + baca
D1 + bangun JSON Plotly kemungkinan melebihi itu. Strategi: render hanya saat
data berubah (cron trigger), simpan HTML final di `CACHE_KV`, request biasa
balikin dari KV. Ini juga bikin cold start ~0.

**2. Data fetch hanya di cron, bukan per request.**
Sekarang APScheduler jalan tiap 6 jam. Di Workers, `[triggers] crons` menjalankan
`scheduled()` yang fetch semua sumber lalu render + tulis KV. Request baca KV
saja. Ini menghindari batas **50 subrequest/invocation** dan menghindari kegagalan
API eksternal mematikan halaman.

**3. Plotly client-side.**
`plotly.py` render server-side tidak ada di Workers. Ganti: bangun chart spec
JSON di `charts.ts`, kirim di HTML, gambar dengan `Plotly.newPlot()` dari CDN.
Inline script tetap dapat nonce CSP → grade A+ tetap mungkin.

**4. SQLite → D1 1:1.**
D1 SQL-compatible. `models.py` pakai WAL + `busy_timeout` (konsep SQLite lokal)
→ di D1 tidak relevan; ganti dengan prepared statement biasa.

**5. Sumber data eksternal tetap sama.**
World Bank, BI (bi.go.id), BPS (webapi.bps.go.id), frankfurter.app, Pertamina,
TradingEconomics, logam-mulia worker. Semua lewat `fetch()` dengan timeout.

## Hasil Fase 0–1 (terverifikasi 2026-10-21)

### Resource Cloudflare

| Resource | Nilai |
|---|---|
| D1 database | `inthiseconomy-db` — `5c49ae6d-3318-421a-bf55-f20d3b4e90b0` (region ENAM) |
| KV namespace | `CACHE_KV` — `f4e71de19c104525acebe9b09f85b94c` |
| wrangler | 4.151.3 |
| Account ID | `e8cf289185dd03f185eb78d19b528af0` |

### Isi D1 setelah `seed.mjs --remote`

| Tabel | Rows |
|---|---|
| `indicators` | **176** (target ±176 → PAS) |
| `time_series` | **545** |
| `metadata` | 7 |
| series key | **29** |

Sebaran `indicators`: PDB Growth 65, Inflasi 66, Trade Balance 45 (sama dengan
`economic_data.db` versi Flask). `time_series` 545 > 449 versi Flask karena
`bi_rate` 129 titik (bukan 10) + `gold_gram` 16 titik (bukan 18, sumber berbeda).

### Hasil per sumber (probe langsung dari host ini)

| Sumber | Endpoint | Status | Catatan |
|---|---|---|---|
| World Bank | `api.worldbank.org/v2/country/IDN/indicator/*` | ✅ 7/7 indikator | latency tidak stabil — lihat di bawah |
| BI-Rate | `bi.go.id/id/statistik/indikator/bi-rate.aspx` | ✅ 129 titik | JSON blob `HiddenFieldChartData` |
| USD/IDR | `api.frankfurter.app/latest` | ✅ 17986 (2026-10-20) | tanpa API key |
| USD/IDR history | `api.frankfurter.app/2024-01-01..` | ✅ 34 poin bulanan | |
| Gini | World Bank `SI.POV.GINI` | ✅ 33 titik | |
| Life expectancy | World Bank `SP.DYN.LE00.IN` | ✅ 65 titik | |
| Education exp | World Bank `SE.XPD.TOTL.GD.ZS` | ✅ 28 titik | |
| Literacy | World Bank `SE.ADT.LITR.ZS` | ✅ 13 titik | |
| Emas | `logam-mulia-api.iamutaki.workers.dev` | ✅ Rp 2.481.000/gr (2026-10-21) | live |
| Emas history | `.../anekalogam/history` | ⚠️ ±5 bulan saja | lihat di bawah |
| IKK | `tradingeconomics.com/indonesia/consumer-confidence` | ✅ 118.1 (Sep 2026) | regex summary masih cocok |
| IKK history | hardcoded BI survey | ⚠️ 24 titik | port dari `backfill.IKK_KNOWN` |
| Inflasi YoY BPS | `webapi.bps.go.id/v1/api/list/...` | ❌ **butuh API key** | fallback 21 titik |
| BBM | `pertamina.com/id/harga-bbm` | ❌ **tanpa harga** | fallback 20 harga + 180 history |
| UMP | hardcoded 37 provinsi | ⚠️ statis | port dari `UMP_PROVINSI` |

### Sumber yang GAGAL dari sini — jujur, bukan dibuat-buat

**1. BPS (`webapi.bps.go.id`) — butuh API key.**
Tanpa key, semua endpoint balas HTTP **200** dengan body:

```json
{"status":"Error","message":"Parameter Key is Missing."}
```

Dengan `?key=test` balas `"Parameter Domain is Missing."`. Artinya key wajib.
**Port tidak menulis error object ke series** — jatuh ke `INFLATION_YOY_KNOWN`
(21 titik, Jan 2025–Sep 2026, port verbatim dari `macro_fetcher.py`). Untuk
mendapatkan data live, set `BPS_API_KEY` sebagai Worker var/secret lalu
`fetchers.fetchInflationYoy` memakainya otomatis.

**2. Pertamina (`pertamina.com/id/harga-bbm`) — tidak menyajikan harga.**
Halaman balas 200, 36 KB, tapi **tidak mengandung** `Pertalite`, `10.000`,
`10000`, `__NEXT_DATA__`, maupun `application/json`. Ini shell JS tanpa payload
harga. Tidak ada scrape yang mungkin. Port memakai `BBM_PER_DAERAH` (20 harga,
Oktober 2026) + `BBM_KNOWN` (180 titik history) — port verbatim dari
`micro_fetcher.py` / `backfill.py`.

**3. Gold history — endpoint hanya simpan ±5 bulan.**
Diukur 2026-10-21:
- `?page=1&length=500` → 500 item, sampai **2026-08-27**
- 76 halaman × 20 item → sampai **2026-05-06**
- `page=80` → **0 item**

Jadi backfill API tidak bisa menutup 2024–2025. Port menambahkan
`GOLD_HISTORY_KNOWN` (10 titik, port dari `backfill.GOLD_KNOWN`) sehingga series
`gold_gram` tetap mencakup 2024–2025. Total 16 titik bulanan.

### Jebakan teknis yang terukur

**World Bank latency tidak stabil — timeout pendek membuang indikator.**
5 percobaan per indikator, dari host ini:

| Indikator | Latency (ms) |
|---|---|
| `NY.GDP.MKTP.KD.ZG` | 127, 37, 33, 37, 40 |
| `SI.POV.GINI` | 40, 35, 45, 37, 43 |
| `SE.XPD.TOTL.GD.ZS` | **129 220**, 42, 41, 35, 37 |

Satu permintaan bisa stall **129 detik** lalu berhasil. Implementasi Flask pakai
`timeout=30` + tanpa retry → indikator hilang diam-diam. Port memakai
`timeoutMs=45 000` + **2 retry** (`src/fetchers.ts` `fetchWithRetry`). Seed lokal
pertama kali masih kehilangan Trade Balance; setelah retry aktif, 45 rows masuk.

**BI-Rate: scrape `<td>` hanya dapat 10 baris; JSON blob dapat 129.**
`macro_fetcher._parse_bi_rate_html()` mencari pola `<td>23 September 2026</td>
<td>5.75 %</td>`. Pola itu **tidak cocok** dengan markup sekarang — BI memakai
`5,75 %` (koma) dan class `text-center`. Parser lama menghasilkan **0 baris** lalu
jatuh ke fallback 10 titik.

BI menaruh seluruh riwayat di hidden input:
`<input id="HiddenFieldChartData" value="[[1792540800000,5.75,&quot;5,75 %&quot;],…]">`
Port membaca itu lebih dulu → **129 titik, 2016-04-21 sampai 2026-10-21**.
Parser HTML lama dipertahankan sebagai fallback.

**IKK regex masih cocok.**
Pola `(declined|increased|rose|fell|dropped|climbed)\s+to\s+([\d.]+)\s+in\s+(\w+)\s+(\d{4})`
masih menemukan `118.1 / September / 2026` di ringkasan halaman TradingEconomics.

**`wrangler types` menulis runtime types, bukan `@cloudflare/workers-types`.**
`wrangler types` v4 sekarang meng-generate `src/env.d.ts` (626 KB) yang memuat
seluruh runtime types termasuk `D1Database`, `D1PreparedStatement`, `KVNamespace`.
Konsekuensi: `import type { D1Database } from "@cloudflare/workers-types"`
menghasilkan error LSP (duplikat global). Port mengandalkan global dari
`env.d.ts`. `wrangler types` juga menyarankan uninstall
`@cloudflare/workers-types` dan pasang `@types/node` (node compat aktif).

**`wrangler d1 execute --json` mengembalikan array top-level.**
Bukan `{"result":[…]}`. Parse harus `Array.isArray(parsed) ? parsed[0] : parsed`,
lalu `results[0]`. Salah di sini bikin count balik `undefined` tanpa error.

**`wrangler dev` port 8788 jalan bersih.**
Log: `Ready on http://localhost:8788`, lalu `/health` 200 (63 ms), `/healthz`
200, `/` 200, `/api/data` 200 (58 ms), `/api/refresh` 200 (5 326 ms).
Satu-satunya warning adalah bawaan: cron tidak jalan otomatis di dev.

## Jebakan yang sudah diketahui

- **`routes` di `wrangler.toml` tidak reliably mengaktifkan custom domain.**
  Custom domain WAJIB via dashboard (skill `cloudflare-worker-api`).
- **CPU 10 ms** — render di luar request path (lihat keputusan 1).
- **KV eventual consistency** — tulis lalu baca bisa balik versi lama. Untuk HTML
  dashboard ini tolerabel (data 6 jaman), tapi harus disadari.
- **Cron trigger + `wrangler dev`** — cron tidak jalan di local dev; uji manual
  (`curl http://localhost:8788/cdn-cgi/local/scheduled`).
- **`economic_data.db` tidak bisa dipindah langsung** — harus di-fetch ulang ke D1
  lewat `scripts/seed.mjs` (source of truth = API, bukan file SQLite).
- **D1 `INSERT OR REPLACE` menghapus lalu memasukkan baris.** Untuk tabel dengan
  `AUTOINCREMENT` kolom `id` berubah setiap upsert. Tidak ada query yang
  mengandalkan `id` stabil, tapi jangan asumsikan `id` persisten.
