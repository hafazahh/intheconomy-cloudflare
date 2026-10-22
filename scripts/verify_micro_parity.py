"""Micro page end-to-end parity: Flask `app.py` + `templates/micro.html` vs the
live Worker page.

The Flask side is the reference: the real route is driven through Flask's test
client against `economic_data.db`, so `_compute_micro_metrics()`,
`generate_micro_insight()` and `micro.html` all run. The Worker side is a real
GET against a running `wrangler dev`.

What is compared (all of it is what a reader sees):

  * KPI cards — label, formatted value, date (live feeds → notes, not failures)
  * combined-metric cards — 4 values + their province labels
  * the assumption box lines
  * insight bullets (main_findings + additional_analysis) and the deficit alert
  * province + daerah dropdown options (values, labels, selection)
  * the five chart mount points, with the BBM-vs-upah historical indices and
    annotations compared exactly (they are pure history constants)
  * the CSV export shape

Usage:
  python3 scripts/verify_micro_parity.py [worker_base_url]
  # the Flask pages are rendered once by `scripts/flask_dump_pages.py` (needs
  # the project venv, which has plotly) and cached under /tmp.
"""
import json
import re
import subprocess
import sys
import urllib.request

from idnum import norm_text

WORKER = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788"
FLASK_VENV_PY = "/home/choirulhaq/venvProject/venv/bin/python3"
DUMPER = "/home/choirulhaq/.hermes/profiles/programmer/cache/scratch/flask_dump_pages.py"
FLASK_MICRO = "/tmp/flask_micro.html"

KPI_RE = re.compile(
    r'<div class="kpi-label">(?P<label>.*?)</div>\s*'
    r'<div class="kpi-value[^"]*">\s*(?P<value>.*?)\s*</div>\s*'
    r'<small class="text-muted">(?P<date>[^<]*)</small>',
    re.S,
)
METRIC_RE = re.compile(
    r'<div class="metric-value">(?P<value>.*?)</div>\s*'
    r'<div class="metric-label">(?P<label>.*?)</div>',
    re.S,
)
LI_RE = re.compile(r"<li>(?P<text>.*?)</li>", re.S)
ALERT_RE = re.compile(
    r'<div class="alert alert-(?P<kind>warning|success)[^"]*"[^>]*>(?P<body>.*?)</div>', re.S
)
SELECT_RE = re.compile(r'<select name="(?P<name>daerah|province)"[^>]*>(?P<body>.*?)</select>', re.S)
OPTION_RE = re.compile(r'<option value="(?P<value>[^"]*)"\s*(?P<sel>selected)?\s*>(?P<label>[^<]*)</option>')
CHART_JSON_RE = re.compile(r"window\.__CHARTS__=(\{.*?\});</script>", re.S)
# Plotly 4 renders `<div id="<uuid>" class="plotly-graph-div">` plus a
# `Plotly.newPlot("<uuid>", <data>, <layout>, <config>)` call — so the div ids are
# random UUIDs and can never be compared. The count and the payload can.
PLOTLY_DIV_RE = re.compile(r'<div id="[0-9a-f-]+" class="[^"]*plotly-graph-div')
PLOTLY_CALL_RE = re.compile(r'Plotly\.newPlot\(\s*"[0-9a-f-]+"\s*,\s*')
CONTAINER_RE = re.compile(r'<div class="chart-container"[^>]*id="([^"]+)"')
SECTION_TITLE_RE = re.compile(r'<h5 class="section-title">(?P<title>[^<]*)</h5>')


def norm(text):
    return norm_text(text)


def flask_figure(html, index):
    """Parse figure #`index` out of a Flask page.

    `fig.to_html()` emits `Plotly.newPlot("<uuid>", <data>, <layout>, <config>)`
    with each argument on its own JSON document, so `json.JSONDecoder.raw_decode`
    reads them one at a time. Returns `(data, layout)`.
    """
    starts = [m.end() for m in PLOTLY_CALL_RE.finditer(html)]
    if index >= len(starts):
        return None, None
    pos = starts[index]
    decoder = json.JSONDecoder()
    data, end = decoder.raw_decode(html[pos:])
    pos += end
    sep = re.match(r"\s*,\s*", html[pos:])
    if sep is None:
        return None, None
    pos += sep.end()
    layout, _ = decoder.raw_decode(html[pos:])
    return data, layout

# Series the Worker re-fetches live at a different moment than the Flask archive.
# Matched as a prefix of the card label ("Pertalite" -> "Pertalite Okt 2026").
LIVE = ("Emas 1gr", "USD/IDR", "IKK", "BI-Rate")


def flask_page():
    if "--fresh" in sys.argv or not _exists(FLASK_MICRO):
        subprocess.run([FLASK_VENV_PY, DUMPER], check=True)
    with open(FLASK_MICRO, encoding="utf-8") as fh:
        return fh.read()


def _exists(path):
    import os

    return os.path.exists(path)


def worker_page(query=""):
    with urllib.request.urlopen(f"{WORKER}/micro{query}", timeout=30) as resp:
        return resp.read().decode("utf-8")


def kpi_cards(html):
    out = []
    for m in KPI_RE.finditer(html):
        out.append(
            (
                norm(re.sub(r"<[^>]+>", "", m.group("label"))),
                norm(m.group("value")),
                m.group("date").strip(),
            )
        )
    return out


def metrics(html):
    return [
        (norm(m.group("value")), norm(re.sub(r"<[^>]+>", "", m.group("label"))))
        for m in METRIC_RE.finditer(html)
    ]


def selects(html):
    out = {}
    for m in SELECT_RE.finditer(html):
        out[m.group("name")] = [
            (o.group("value"), norm(o.group("label")), bool(o.group("sel")))
            for o in OPTION_RE.finditer(m.group("body"))
        ]
    return out


def insight_items(html):
    """Bullets in the two insight boxes (the `<ul>` blocks after each heading)."""
    blocks = re.findall(r'<ul class="mb-0"[^>]*>(?P<body>.*?)</ul>', html, re.S)
    return [norm(re.sub(r"<[^>]+>", "", t)) for b in blocks for t in LI_RE.findall(b)]


def alert(html):
    m = ALERT_RE.search(html)
    if not m:
        return None
    return (m.group("kind"), norm(re.sub(r"<[^>]+>", "", m.group("body"))))


def assumption(html):
    box = re.search(r'<div class="assumption-box[^"]*">(.*?)</div>\s*</div>', html, re.S)
    if not box:
        return []
    return [
        norm(re.sub(r"<[^>]+>", "", t))
        for t in LI_RE.findall(box.group(1))
    ]


def payload_charts(html):
    """`window.__CHARTS__` from the Worker page, as a dict."""
    m = CHART_JSON_RE.search(html)
    return json.loads(m.group(1)) if m else {}


def bbm_vs_wage_worker(html):
    spec = payload_charts(html).get("chart-bbm-vs-wage")
    if not spec:
        return None
    layout = spec.get("layout") or {}
    return {
        "traces": [t["name"] for t in spec["data"]],
        "bbm_x": spec["data"][0]["x"],
        "bbm_y": spec["data"][0]["y"],
        "ump_x": spec["data"][1]["x"],
        "ump_y": spec["data"][1]["y"],
        "annotations": [a["text"] for a in layout.get("annotations", [])],
        "x_title": (layout.get("xaxis") or {}).get("title", {}).get("text"),
        "y_title": (layout.get("yaxis") or {}).get("title", {}).get("text"),
    }


def csv_shape():
    with urllib.request.urlopen(f"{WORKER}/download/csv", timeout=30) as resp:
        body = resp.read().decode("utf-8")
    lines = body.splitlines()
    rows = [line.split(",") for line in lines[1:] if line]
    return {
        "header": lines[0],
        "rows": len(rows),
        "cols_ok": all(len(r) == 5 for r in rows),
        "sample": rows[:2],
    }


def card_value(html, label_prefix):
    """Value of the first KPI card whose label starts with `label_prefix`."""
    for label, value, _date in kpi_cards(html):
        if label.startswith(label_prefix):
            return value
    return None


def compare_pages(flask_html, worker_html, label, check, failures, notes, dump=False):
    """Compare one Flask page against one Worker page, line by line.

    Used for `/micro`, for the query-param variants, and for the fallback case —
    so the same rules (number normalisation, live-snapshot tolerance) apply to
    every page instead of only the default one.
    """
    f_kpi, w_kpi = kpi_cards(flask_html), kpi_cards(worker_html)
    if dump:
        print(f"[{label}] Flask :", f_kpi)
        print(f"[{label}] Worker:", w_kpi)
    check(f"[{label}] jumlah kartu KPI sama", len(f_kpi) == len(w_kpi), f"{len(f_kpi)} vs {len(w_kpi)}")
    check(f"[{label}] urutan + label kartu KPI identik", [k[0] for k in f_kpi] == [k[0] for k in w_kpi])
    for (fl, fv, _fd), (wl, wv, _wd) in zip(f_kpi, w_kpi):
        if fl != wl:
            continue
        if norm_text(fv) == norm_text(wv):
            continue
        if any(fl.startswith(k) for k in LIVE):
            notes.append(f"[{label}] kartu '{fl}': Flask={fv} Worker={wv} — snapshot live berbeda")
            continue
        failures.append(f"[{label}] kartu KPI '{fl}': Flask={fv} Worker={wv}")

    f_m, w_m = metrics(flask_html), metrics(worker_html)
    if dump:
        print(f"[{label}] metrik Flask :", f_m)
        print(f"[{label}] metrik Worker:", w_m)
    check(f"[{label}] jumlah kartu metrik sama", len(f_m) == len(w_m), f"{len(f_m)} vs {len(w_m)}")
    check(f"[{label}] label kartu metrik identik", [m[1] for m in f_m] == [m[1] for m in w_m])
    for (fv, fl), (wv, _wl) in zip(f_m, w_m):
        if norm_text(fv) != norm_text(wv):
            failures.append(f"[{label}] metrik '{fl}': Flask={fv} Worker={wv}")

    f_a, w_a = assumption(flask_html), assumption(worker_html)
    check(f"[{label}] baris asumsi identik", f_a == w_a)

    # IKK is a live series: when the two sides hold different snapshots, the one
    # insight bullet that quotes IKK is a freshness difference, not a port bug.
    ikk_differs = norm_text(card_value(flask_html, "IKK")) != norm_text(card_value(worker_html, "IKK"))
    f_i, w_i = insight_items(flask_html), insight_items(worker_html)
    if dump:
        print(f"[{label}] insight Flask :")
        for t in f_i:
            print("   -", t)
        print(f"[{label}] insight Worker:")
        for t in w_i:
            print("   -", t)
    check(f"[{label}] jumlah bullet insight sama", len(f_i) == len(w_i), f"{len(f_i)} vs {len(w_i)}")
    for i, (a, b) in enumerate(zip(f_i, w_i)):
        if norm_text(a) == norm_text(b):
            continue
        if ikk_differs and "IKK tetap" in a and "IKK tetap" in b:
            notes.append(f"[{label}] bullet IKK berbeda karena snapshot IKK — Flask: {a} | Worker: {b}")
            continue
        failures.append(f"[{label}] bullet insight #{i + 1}: Flask={a} | Worker={b}")

    f_alert, w_alert = alert(flask_html), alert(worker_html)
    check(f"[{label}] alert defisit/surplus identik", f_alert == w_alert,
          f"flask={f_alert} worker={w_alert}")

    f_s, w_s = selects(flask_html), selects(worker_html)
    for name in ("daerah", "province"):
        check(f"[{label}] opsi dropdown '{name}' identik", f_s.get(name) == w_s.get(name))


def main():
    flask = flask_page()
    worker = worker_page()
    failures, notes = [], []

    def check(label, ok, detail=""):
        print(f"[{'PASS' if ok else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
        if not ok:
            failures.append(label)

    print("=" * 78)
    print("HALAMAN /micro — KPI, METRIK, ASUMSI, INSIGHT, DROPDOWN")
    print("=" * 78)
    compare_pages(flask, worker, "micro", check, failures, notes, dump=True)

    print("\n" + "=" * 78)
    print("CHART MOUNT POINTS + BBM vs UPAH")
    print("=" * 78)
    f_divs = PLOTLY_DIV_RE.findall(flask)
    w_ids = CONTAINER_RE.findall(worker)
    print("Flask  (plotly divs):", len(f_divs))
    print("Worker (container ids):", w_ids)
    check("5 container chart di kedua halaman", len(f_divs) == 5 and len(w_ids) == 5,
          f"flask={len(f_divs)} worker={len(w_ids)}")
    check(
        "judul section chart identik",
        SECTION_TITLE_RE.findall(flask) == SECTION_TITLE_RE.findall(worker),
    )

    w_b = bbm_vs_wage_worker(worker)
    close = lambda a, b: abs(a - b) <= 1e-9
    check("chart-bbm-vs-wage ada di payload Worker", w_b is not None)
    check("nama trace identik", w_b and w_b["traces"] == ["Indeks Harga BBM", "Indeks Upah Minimum"])

    # The BBM-vs-upah figure is the 2nd figure in `templates/micro.html`, so
    # Flask's *rendered* Plotly call is the oracle for it: same indices, same
    # annotations, same axis titles. `app.py` replaces the last BBM point with
    # the published per-region Pertalite price, so this comparison is what proves
    # the substitution landed.
    f_data, f_layout = flask_figure(flask, 1)
    check("chart BBM vs upah Flask ter-parse dari halaman", f_data is not None)
    if f_data:
        check(
            "sumbu x BBM identik dengan chart Flask",
            w_b and w_b["bbm_x"] == f_data[0]["x"],
        )
        check(
            "indeks BBM identik dengan chart Flask",
            w_b and len(w_b["bbm_y"]) == len(f_data[0]["y"])
            and all(close(a, b) for a, b in zip(w_b["bbm_y"], f_data[0]["y"])),
        )
        check(
            "sumbu x upah identik dengan chart Flask",
            w_b and w_b["ump_x"] == f_data[1]["x"],
        )
        check(
            "indeks upah identik dengan chart Flask",
            w_b and len(w_b["ump_y"]) == len(f_data[1]["y"])
            and all(close(a, b) for a, b in zip(w_b["ump_y"], f_data[1]["y"])),
        )
        check(
            "anotasi BBM identik dengan chart Flask",
            w_b and w_b["annotations"] == [a["text"] for a in f_layout.get("annotations", [])],
            f"flask={[a['text'] for a in f_layout.get('annotations', [])]} "
            f"worker={w_b and w_b['annotations']}",
        )
        check(
            "judul sumbu identik dengan chart Flask",
            w_b
            and w_b["x_title"] == (f_layout.get("xaxis") or {}).get("title", {}).get("text")
            and w_b["y_title"] == (f_layout.get("yaxis") or {}).get("title", {}).get("text"),
            f"flask={f_layout.get('xaxis')} | {f_layout.get('yaxis')}",
        )

    # The other four figures read live series, so only their shape can be
    # compared: same traces, same axis titles, and at least one shared date.
    for cid, f_idx in [
        ("chart-emas-bbm", 0),
        ("chart-ikk", 2),
        ("chart-bi-rate-micro", 3),
        ("chart-usd-idr-micro", 4),
    ]:
        f_data, f_layout = flask_figure(flask, f_idx)
        spec = payload_charts(worker).get(cid)
        if f_data is None or spec is None:
            continue
        check(
            f"{cid}: nama trace identik",
            [t["name"] for t in spec["data"]] == [t["name"] for t in f_data],
        )
        check(
            f"{cid}: judul sumbu identik",
            (spec["layout"].get("xaxis") or {}).get("title", {}).get("text")
            == (f_layout.get("xaxis") or {}).get("title", {}).get("text")
            and (spec["layout"].get("yaxis") or {}).get("title", {}).get("text")
            == (f_layout.get("yaxis") or {}).get("title", {}).get("text"),
        )
        for t_spec, t_flask in zip(spec["data"], f_data):
            shared = set(t_spec["x"]) & set(t_flask["x"])
            if not shared:
                failures.append(f"{cid}: tidak ada tanggal yang sama dengan Flask")
            else:
                print(f"   - {cid}: {len(shared)} tanggal sama dengan Flask "
                      f"(snapshot live; worker {len(t_spec['x'])} titik, flask {len(t_flask['x'])})")

    print("\n" + "=" * 78)
    print("CSV")
    print("=" * 78)
    c = csv_shape()
    print(c)
    check("header CSV benar", c["header"] == "Indicator,Code,Year,Value,Fetched At", c["header"])
    check("semua baris 5 kolom", c["cols_ok"])
    check("CSV punya baris data", c["rows"] > 0, f"{c['rows']} rows")

    print("\n" + "=" * 78)
    print("ALIAS /micro-economy + QUERY PARAM")
    print("=" * 78)
    alias = urllib.request.urlopen(f"{WORKER}/micro-economy", timeout=30).read().decode("utf-8")
    check("/micro-economy balas 200 text/html", alias.strip().startswith("<!DOCTYPE html>"))
    check(
        "/micro-economy memuat halaman yang sama dengan /micro",
        SECTION_TITLE_RE.findall(alias) == SECTION_TITLE_RE.findall(worker)
        and kpi_cards(alias) == kpi_cards(worker),
    )
    check(
        "/micro-economy memuat 5 chart spec sendiri",
        len(payload_charts(alias)) == 5,
        f"{len(payload_charts(alias))} spec",
    )

    # The dropdown must actually drive the numbers. Both query-param pages are
    # compared against the *Flask* route with the same query string, so the
    # expectations come from the ported source, not from a hand-written guess.
    for label, query, flask_path in [
        ("picked", "?province=DKI%20Jakarta&daerah=indonesia_timur", "/tmp/flask_micro_picked.html"),
        ("bad", "?province=Narnia&daerah=Narnia", "/tmp/flask_micro_bad.html"),
    ]:
        if not _exists(flask_path):
            subprocess.run([FLASK_VENV_PY, DUMPER], check=True)
        with open(flask_path, encoding="utf-8") as fh:
            flask_q = fh.read()
        worker_q = urllib.request.urlopen(f"{WORKER}/micro{query}", timeout=30).read().decode("utf-8")
        compare_pages(flask_q, worker_q, label, check, failures, notes)

    print("\n" + "=" * 78)
    print("STRUKTUR HALAMAN")
    print("=" * 78)
    for t in [
        "Micro Economy",
        "Perbandingan Emas vs BBM, IKK, dan Metrik Gabungan",
        "Pilih Wilayah (BBM)",
        "Pilih Provinsi (UMP)",
        "Perbandingan Emas vs BBM (Indeks)",
        "Indeks Harga BBM vs Indeks Upah Minimum",
        "Indeks Keyakinan Konsumen (IKK)",
        "BI-Rate",
        "Kurs USD/IDR",
        "Metrik Gabungan",
        "Insight (dynamic, per daerah)",
        "Temuan utama",
        "Analisis tambahan",
        "Asumsi Perhitungan:",
        "Sumber Data:",
    ]:
        check(f"teks '{t[:45]}' ada", t in worker)
    for attr in ['href="/"', 'action="/micro"', 'href="/download/csv"']:
        check(f"link/attr {attr} ada", attr in worker)
    check(
        "tidak ada inline <script> tanpa nonce",
        len(re.findall(r"<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)", worker, re.I)) == 0,
    )
    check("nonce dipasang pada script inline", worker.count('<script nonce="') >= 2)

    if notes:
        print("\nCATATAN (snapshot live, bukan kegagalan):")
        for n in notes:
            print("  -", n)

    print("\n" + "=" * 78)
    if failures:
        print(f"GAGAL: {len(failures)}")
        for f in failures:
            print("  -", f)
        return 1
    print("SEMUA BANDINGAN HALAMAN MICRO LULUS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
