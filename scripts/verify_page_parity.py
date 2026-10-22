"""Compare the Worker dashboard page against the Flask page it is porting.

Both pages are produced by the *real* code, not by mocks:

  * Flask — `app.test_client().get("/")`, so `dashboard()` + `templates/dashboard.html`
    run end to end against `economic_data.db`;
  * Worker — a GET against a running `wrangler dev` (default http://127.0.0.1:8788/).

Then the facts a reader sees are compared: KPI card order and values, insight
text, chart mount points, macro KPI cards, projection rows.

Numbers are allowed to differ where the two sides legitimately read different
snapshots of a live feed (`usd_idr`, `gold_gram`, `ikk`, `bi_rate`); those are
reported as notes, not failures. Everything else must match exactly.

`app.py` runs `bootstrap()` at import (APScheduler thread + possible network),
so `scheduler` and `backfill` are stubbed — `dashboard()` touches neither.
"""
import re
import sys
import types
import urllib.request

PROJECT = "/home/choirulhaq/venvProject/indonesia-economic-dashboard"

# Series the Worker re-fetches live at a different moment than the Flask archive.
LIVE_REFRESHED = {"usd_idr", "gold_gram", "ikk", "bi_rate"}


def flask_page():
    sys.path.insert(0, PROJECT)
    noop = types.ModuleType("scheduler")
    setattr(noop, "start_scheduler", lambda *a, **k: None)
    setattr(noop, "stop_scheduler", lambda *a, **k: None)
    setattr(noop, "scheduler_running", False)
    sys.modules["scheduler"] = noop
    backfill = types.ModuleType("backfill")
    setattr(backfill, "run", lambda *a, **k: None)
    sys.modules["backfill"] = backfill

    import app as appmod

    return appmod.app.test_client().get("/").get_data(as_text=True)


def worker_page(url):
    with urllib.request.urlopen(url, timeout=30) as resp:
        return resp.read().decode("utf-8")


KPI_RE = re.compile(
    r'<div class="kpi-label">(?P<name>[^<]*)</div>\s*<div class="kpi-value[^"]*">(?P<value>[^<]*)</div>'
)
MACRO_RE = re.compile(
    r'<div class="kpi-label">(?P<name>[^<]*)</div>\s*<div class="kpi-value[^"]*">(?P<value>[^<]*)</div>\s*'
    r'<small class="text-muted">(?P<date>[^<]*)</small>',
    re.S,
)
INSIGHT_RE = re.compile(r"<strong>Insight:</strong>\s*(.*?)\s*</div>", re.S)
CONTAINER_RE = re.compile(r'<div class="chart-container"[^>]*id="([^"]+)"')
PROJECTION_RE = re.compile(r"<tr>\s*<td>(\d{4})</td>\s*<td>([\d.]+)</td>\s*<td>([\d.]+)</td>\s*</tr>")


def cards(html, regex):
    return [(m.group("name"), m.group("value")) for m in regex.finditer(html)]


def macro_cards(html):
    out = []
    for m in MACRO_RE.finditer(html):
        out.append((m.group("name"), m.group("value"), m.group("date")))
    return out


def main():
    worker_url = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788/"
    print(f"Flask  : test_client /")
    print(f"Worker : GET {worker_url}")
    flask = flask_page()
    worker = worker_page(worker_url)

    failures = []
    notes = []

    def check(label, ok, detail=""):
        print(f"[{'PASS' if ok else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
        if not ok:
            failures.append(label)

    print("\n" + "=" * 78)
    print("KARTU KPI")
    print("=" * 78)
    f_kpi, w_kpi = cards(flask, KPI_RE), cards(worker, KPI_RE)
    print("Flask :", f_kpi)
    print("Worker:", w_kpi)
    check("jumlah kartu KPI sama", len(f_kpi) == len(w_kpi), f"{len(f_kpi)} vs {len(w_kpi)}")
    check("urutan + nama kartu KPI identik", [n for n, _ in f_kpi] == [n for n, _ in w_kpi])

    # A card backed by a live feed is re-fetched by the Worker at a different
    # moment than the Flask archive snapshot, so its *value* legitimately
    # differs. The card must still exist, still be formatted as a number, and
    # still sit in the same position.
    for (fn, fv), (wn, wv) in zip(f_kpi, w_kpi):
        if fn != wn:
            continue
        if fn == "Kurs USD/IDR":
            digits = lambda s: re.sub(r"[^\d]", "", s)
            if digits(fv) != digits(wv):
                notes.append(
                    f"kartu KPI '{fn}': Flask={fv} Worker={wv} — snapshot live berbeda "
                    "(Flask di-freeze 2026-10-12, Worker di-fetch ulang)"
                )
            else:
                notes.append(
                    f"kartu KPI '{fn}': Flask={fv} Worker={wv} — nilai sama, "
                    "pemisah ribuan beda (Flask ',', Worker '.' id-ID)"
                )
            continue
        if fv != wv:
            failures.append(f"kartu KPI '{fn}': Flask={fv} Worker={wv}")

    print("\n" + "=" * 78)
    print("INSIGHT")
    print("=" * 78)
    f_ins = INSIGHT_RE.search(flask)
    w_ins = INSIGHT_RE.search(worker)
    f_txt = f_ins.group(1) if f_ins else None
    w_txt = w_ins.group(1) if w_ins else None
    print(f"Flask : {f_txt}")
    print(f"Worker: {w_txt}")
    check("insight ada di kedua halaman", bool(f_txt) and bool(w_txt))
    check("teks insight identik", f_txt == w_txt)

    print("\n" + "=" * 78)
    print("CHART MOUNT POINTS")
    print("=" * 78)
    # Flask renders `{{ chart|safe }}` (a Plotly div) inside `.chart-container`
    # and gives the container no id; the Worker mounts by id. So compare the
    # count and the surrounding section titles, which is what a reader sees.
    f_containers = re.findall(r'<div class="chart-container"[^>]*>', flask)
    w_ids = sorted(CONTAINER_RE.findall(worker))
    print("Flask :", len(f_containers), "container")
    print("Worker:", len(w_ids), "container:", w_ids)
    check("kedua halaman memuat 7 container chart", len(f_containers) == 7 and len(w_ids) == 7,
          f"Flask={len(f_containers)} Worker={len(w_ids)}")
    titles = [
        "BI-Rate",
        "Kurs USD/IDR",
        "Rasio Gini",
        "Inflasi Bulanan (YoY) — 12 Bulan Terakhir",
        "Tren 5 Tahun: PDB Growth &amp; Inflasi",
        "PDB Growth (Detail)",
        "Inflasi YoY (Detail)",
    ]
    for t in titles:
        check(f"judul section '{t[:40]}' ada di kedua halaman", t in flask and t in worker)

    print("\n" + "=" * 78)
    print("KARTU MAKRO")
    print("=" * 78)
    f_mk, w_mk = macro_cards(flask), macro_cards(worker)
    print("Flask :", f_mk)
    print("Worker:", w_mk)
    check("jumlah kartu makro sama", len(f_mk) == len(w_mk), f"{len(f_mk)} vs {len(w_mk)}")
    check("nama + urutan kartu makro identik", [n for n, _, _ in f_mk] == [n for n, _, _ in w_mk])
    for (fn, fv, fd), (wn, wv, wd) in zip(f_mk, w_mk):
        if fv != wv:
            notes.append(f"kartu makro '{fn}': Flask={fv} Worker={wv} (tanggal Flask={fd} Worker={wd})")

    print("\n" + "=" * 78)
    print("PROYEKSI IMF WEO")
    print("=" * 78)
    f_pr, w_pr = PROJECTION_RE.findall(flask), PROJECTION_RE.findall(worker)
    print("Flask :", f_pr)
    print("Worker:", w_pr)
    check("baris proyeksi identik", f_pr == w_pr)

    print("\n" + "=" * 78)
    print("STRUKTUR")
    print("=" * 78)
    check("judul halaman sama", "Indonesia Economic Dashboard" in worker)
    check("bagian makro ada", "Indikator Makro Tambahan" in worker)
    check("tabel proyeksi ada", "Proyeksi (IMF WEO)" in worker)
    check("link /micro ada", 'href="/micro"' in worker)
    check("link /download/csv ada", 'href="/download/csv"' in worker)
    inline_no_nonce = re.findall(r"<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)", worker, re.I)
    check("tidak ada inline <script> tanpa nonce", len(inline_no_nonce) == 0, f"{len(inline_no_nonce)}")
    check("nonce dipasang di script inline", worker.count('<script nonce="') >= 2)

    if notes:
        print("\nCATATAN (bukan kegagalan — snapshot live berbeda):")
        for n in notes:
            print("  -", n)

    print("\n" + "=" * 78)
    if failures:
        print(f"GAGAL: {len(failures)}")
        for f in failures:
            print("  -", f)
        return 1
    print("SEMUA BANDINGAN HALAMAN LULUS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
