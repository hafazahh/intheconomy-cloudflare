"""Micro parity + chart-data diffs, reporting NUMBER-level agreement.

Formatting differences are deliberate and reported, never hidden: the Flask
archive formats with Python `{:,.0f}` (comma thousands, dot decimals) while the
Worker uses Indonesian id-ID (dot thousands, comma decimals). This script
compares *numbers*, not strings, and reports the formatting rule as a note.

The BBM-vs-upah history series are constants in `app.py`; `micro.ts` deliberately
uses the live Pertalite price for the last point (matching the Flask route's
`bbm_history[-1]` assignment). The diff below shows exactly that one point.
"""
import json
import re
import sqlite3
import sys
import urllib.request

from idnum import canon, unfmt

WORKER = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8791"
FLASK = "/tmp/flask_micro.html"
D1 = (
    "/home/choirulhaq/venvProject/indonesia-economic-dashboard/inthiseconomy-cloudflare/"
    ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/"
    "835495cd993b39989a3bb0a40c7ec0f058d41a7629faf5f3150cf1afe53543ce.sqlite"
)

PASS = []
FAIL = []


def check(label, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    (PASS if ok else FAIL).append(label)


# --- number-level KPI + metric comparison ------------------------------------
def cards(html):
    kpi = []
    for m in re.finditer(
        r'<div class="kpi-label">(?P<l>.*?)</div>\s*<div class="kpi-value[^"]*">\s*(?P<v>.*?)\s*</div>\s*'
        r'<small class="text-muted">(?P<d>[^<]*)</small>',
        html, re.S,
    ):
        kpi.append((re.sub(r"<[^>]+>", "", m.group("l")).strip(), m.group("v").strip(), m.group("d").strip()))
    met = []
    for m in re.finditer(
        r'<div class="metric-value">(?P<v>.*?)</div>\s*<div class="metric-label">(?P<l>.*?)</div>',
        html, re.S,
    ):
        met.append((re.sub(r"<[^>]+>", "", m.group("l")).strip(), m.group("v").strip()))
    return kpi, met


flask = open(FLASK, encoding="utf-8").read()
worker = urllib.request.urlopen(f"{WORKER}/micro", timeout=30).read().decode("utf-8")

fk, fm = cards(flask)
wk, wm = cards(worker)
print("=" * 78)
print("KARTU KPI + METRIK (level angka)")
print("=" * 78)
check("jumlah kartu KPI sama", len(fk) == len(wk), f"{len(fk)} vs {len(wk)}")
check("urutan + label identik", [c[0] for c in fk] == [c[0] for c in wk])
check("jumlah kartu metrik sama", len(fm) == len(wm), f"{len(fm)} vs {len(wm)}")
check("label metrik identik", [c[0] for c in fm] == [c[0] for c in wm])

fmt_note = []
live = {"Emas 1gr", "USD/IDR", "IKK", "BI-Rate"}
for (fl, fv, _), (wl, wv, _) in zip(fk, wk):
    if fl != wl:
        continue
    if fv == wv:
        continue
    if fl in live:
        fmt_note.append(f"kartu '{fl}': Flask={fv} Worker={wv} (snapshot live berbeda)")
        continue
    if unfmt(fv) == unfmt(wv):
        fmt_note.append(f"kartu '{fl}': Flask={fv} Worker={wv} — beda format ribuan/desimal (id-ID)")
        continue
    FAIL.append(f"kartu KPI '{fl}': Flask={fv} Worker={wv}")
    print(f"[FAIL] kartu KPI '{fl}': Flask={fv} Worker={wv}")

for (fl, fv), (wl, wv) in zip(fm, wm):
    if fv == wv:
        continue
    if unfmt(fv) == unfmt(wv):
        fmt_note.append(f"metrik '{fl}': Flask={fv} Worker={wv} — beda format (id-ID)")
        continue
    FAIL.append(f"metrik '{fl}': Flask={fv} Worker={wv}")
    print(f"[FAIL] metrik '{fl}': Flask={fv} Worker={wv}")

# --- insight text, number-normalised ----------------------------------------
def norm_items(html):
    out = []
    for b in re.findall(r'<ul class="mb-0"[^>]*>(.*?)</ul>', html, re.S):
        for t in re.findall(r"<li>(.*?)</li>", b, re.S):
            txt = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", t)).strip()
            out.append(txt)
    return out


def canon(text):
    """Normalise id-ID vs en-US formatting so only real wording/value differences remain."""
    def repl(m):
        tok = m.group(0)
        try:
            return f"{unfmt(tok):.10g}"
        except ValueError:
            return tok

    return re.sub(r"-?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|-?\d+[.,]\d+", repl, text)


fi, wi = norm_items(flask), norm_items(worker)
print("\n" + "=" * 78)
print("INSIGHT")
print("=" * 78)
check("jumlah bullet insight sama", len(fi) == len(wi), f"{len(fi)} vs {len(wi)}")
check("teks insight identik (setelah normalisasi format angka)", [canon(t) for t in fi] == [canon(t) for t in wi])
for a, b in zip(fi, wi):
    if canon(a) != canon(b):
        print("  Flask :", a)
        print("  Worker:", b)

# --- dropdown: probe the Flask registry -------------------------------------
sys.path.insert(0, "/home/choirulhaq/venvProject/indonesia-economic-dashboard")
import types as _t  # noqa: E402

noop = _t.ModuleType("scheduler")
setattr(noop, "start_scheduler", lambda *a, **k: None)
setattr(noop, "stop_scheduler", lambda *a, **k: None)
setattr(noop, "scheduler_running", False)
sys.modules["scheduler"] = noop
bf = _t.ModuleType("backfill")
setattr(bf, "run", lambda *a, **k: None)
sys.modules["backfill"] = bf
import micro_fetcher  # noqa: E402

print("\n" + "=" * 78)
print("DROPDOWN (sumber: micro_fetcher.BBM_PER_DAERAH / UMP_PROVINSI)")
print("=" * 78)
print("daerah key di source:", list(micro_fetcher.BBM_PER_DAERAH.keys()))
print("jumlah provinsi di source:", len(micro_fetcher.UMP_PROVINSI))
fw = dict((m.group("n"), m.group("b")) for m in re.finditer(
    r'<select name="(?P<n>daerah|province)"[^>]*>(?P<b>.*?)</select>', flask, re.S))
print("Flask select blocks found:", list(fw))
ww = dict((m.group("n"), m.group("b")) for m in re.finditer(
    r'<select name="(?P<n>daerah|province)"[^>]*>(?P<b>.*?)</select>', worker, re.S))
check("Worker punya 2 select", sorted(ww) == ["daerah", "province"])
check("Worker opsi daerah == source keys", sorted(re.findall(r'<option value="([^"]*)"', ww["daerah"])) == sorted(micro_fetcher.BBM_PER_DAERAH.keys()))
check("Worker opsi provinsi == source keys", sorted(re.findall(r'<option value="([^"]*)"', ww["province"]))[1:] == sorted(micro_fetcher.UMP_PROVINSI.keys()))

# --- chart data diff ---------------------------------------------------------
print("\n" + "=" * 78)
print("CHART DATA (Worker payload vs D1)")
print("=" * 78)
payload = json.loads(re.search(r"window\.__CHARTS__=(\{.*?\});</script>", worker, re.S).group(1))
con = sqlite3.connect(f"file:{D1}?mode=ro", uri=True)
series = lambda key, limit: list(reversed(con.execute(
    "SELECT date, value FROM time_series WHERE series_key=? AND value IS NOT NULL ORDER BY date DESC LIMIT ?",
    (key, limit)).fetchall()))

# emas vs bbm
gold = series("gold_gram", 30)
pert = series("bbm_pertalite__jawa", 30)
spec = payload["chart-emas-bbm"]
check("chart-emas-bbm trace 1 x == D1 gold_gram dates", spec["data"][0]["x"] == [d for d, _ in gold])
check("chart-emas-bbm trace 1 y == gold indeks (base=100)", all(
    abs(a - b / gold[0][1] * 100) < 1e-9 for a, (_, b) in zip(spec["data"][0]["y"], gold)
))
check("chart-emas-bbm trace 2 x == D1 pertalite dates", spec["data"][1]["x"] == [d for d, _ in pert])
check("chart-emas-bbm trace 2 y == pertalite indeks (base=100)", all(
    abs(a - b / pert[0][1] * 100) < 1e-9 for a, (_, b) in zip(spec["data"][1]["y"], pert)
))

for cid, key, limit in [("chart-ikk", "ikk", 12), ("chart-bi-rate-micro", "bi_rate", 12), ("chart-usd-idr-micro", "usd_idr", 30)]:
    rows = series(key, limit)
    t = payload[cid]["data"][0]
    check(f"{cid} x == D1 {key} dates", t["x"] == [d for d, _ in rows])
    check(f"{cid} y == D1 {key} values", all(abs(a - b) < 1e-9 for a, (_, b) in zip(t["y"], rows)))

# bbm vs wage: compare against the Flask constants, accounting for the deliberate
# last-point substitution (Flask route uses BBM_PER_DAERAH[...]["Pertalite"])
bbm_hist = [("2014-01-01", 8500), ("2014-11-01", 10500), ("2015-01-01", 7500),
            ("2015-05-01", 8500), ("2016-01-01", 6500), ("2016-07-01", 7500),
            ("2017-01-01", 7000), ("2018-01-01", 7500), ("2019-01-01", 7500),
            ("2020-01-01", 7500), ("2021-01-01", 8000), ("2022-04-01", 9500),
            ("2022-09-01", 12000), ("2023-01-01", 10500), ("2024-01-01", 11000),
            ("2025-01-01", 13000), ("2026-01-01", 13000)]
ump_hist = [("2014-01-01", 2200), ("2015-01-01", 2500), ("2016-01-01", 2800),
            ("2017-01-01", 3000), ("2018-01-01", 3200), ("2019-01-01", 3400),
            ("2020-01-01", 3400), ("2021-01-01", 3400), ("2022-01-01", 3500),
            ("2023-01-01", 3600), ("2024-01-01", 3700), ("2025-01-01", 3750),
            ("2026-01-01", 3800)]
bw = payload["chart-bbm-vs-wage"]
check("bbm-vs-wage ump x == konstanta Flask", bw["data"][1]["x"] == [d for d, _ in ump_hist])
check("bbm-vs-wage ump y == indeks konstanta", all(
    abs(a - b / ump_hist[0][1] * 100) < 1e-9 for a, (_, b) in zip(bw["data"][1]["y"], ump_hist)))
exp_bbm = [v / bbm_hist[0][1] * 100 for _, v in bbm_hist]
got_bbm = bw["data"][0]["y"]
diffs = [(d, e, g) for d, e, (_, g) in zip([d for d, _ in bbm_hist], exp_bbm, bbm_hist) if abs(e - got_bbm[bbm_hist.index((_, g))]) > 1e-9]
print("  titik berbeda dari konstanta Flask:", diffs or "tidak ada")
check("bbm-vs-wage bbm y == konstanta Flask, kecuali titik terakhir (harga daerah live)",
      all(abs(a - b) < 1e-9 for a, (_, b) in zip(got_bbm[:-1], bbm_hist)) and abs(got_bbm[-1] - bbm_hist[-1][1] / bbm_hist[0][1] * 100) < 1e-9)
check("bbm-vs-wage anotasi == anotasi Flask", [
    a["text"] for a in bw["layout"]["annotations"]
] == [("↑" if bbm_hist[i][1] > bbm_hist[i - 1][1] else "↓") + " BBM"
      for i in range(1, len(bbm_hist))
      if bbm_hist[i - 1][1] > 0 and abs(bbm_hist[i][1] - bbm_hist[i - 1][1]) / bbm_hist[i - 1][1] > 0.10])
con.close()

print("\n" + "=" * 78)
print("CATATAN FORMAT (bukan kegagalan)")
print("=" * 78)
for n in fmt_note:
    print("  -", n)

print("\n" + "=" * 78)
if FAIL:
    print(f"GAGAL: {len(FAIL)}")
    for f in FAIL:
        print("  -", f)
    sys.exit(1)
print(f"LULUS: {len(PASS)} pemeriksaan")
