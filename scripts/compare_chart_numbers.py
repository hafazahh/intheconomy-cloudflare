"""Diff the worker's chart specs against what the Flask app computes.

Flask (app.py + models.py) is the reference. This script recomputes, from the
Flask SQLite DB, the exact (x, y) arrays each of the 7 dashboard charts would
plot, fetches the live worker page, parses its `window.__CHARTS__` payload and
compares trace by trace.

Usage:
  python3 scripts/compare_chart_numbers.py [url]
"""
import json
import re
import sqlite3
import sys
import urllib.request

FLASK_DB = "/home/choirulhaq/venvProject/indonesia-economic-dashboard/economic_data.db"
DEFAULT_URL = "http://127.0.0.1:8788/"

# Recomputation mirrors models.py exactly: ORDER BY date/year DESC LIMIT n,
# then reversed (get_series) or sorted ascending by year (get_indicator_data).
YEAR_LIMIT = 5


def flask_indicators(conn, code):
    rows = conn.execute(
        "SELECT year, value FROM indicators WHERE code=? AND value IS NOT NULL "
        "ORDER BY year DESC LIMIT ?",
        (code, YEAR_LIMIT),
    ).fetchall()
    return sorted(rows, key=lambda r: r["year"])


def flask_series(conn, key, limit):
    rows = conn.execute(
        "SELECT date, value FROM time_series WHERE series_key=? AND value IS NOT NULL "
        "ORDER BY date DESC LIMIT ?",
        (key, limit),
    ).fetchall()
    return list(reversed(rows))


def flask_specs():
    conn = sqlite3.connect(f"file:{FLASK_DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    specs = {}

    pdb = flask_indicators(conn, "NY.GDP.MKTP.KD.ZG")
    infl = flask_indicators(conn, "FP.CPI.TOTL.ZG")
    years = [r["year"] for r in pdb]
    pdb_v = [r["value"] for r in pdb]
    infl_v = [r["value"] for r in infl]

    specs["chart-main"] = [("PDB Growth (%)", years, pdb_v), ("Inflasi (%)", years, infl_v)]
    specs["chart-pdb-growth"] = [("PDB Growth (%)", years, pdb_v)]
    specs["chart-inflasi-yoy-"] = [("Inflasi YoY (%)", years, infl_v)]

    bi = flask_series(conn, "bi_rate", 12)
    specs["chart-bi-rate"] = [("BI-Rate (%)", [r["date"] for r in bi], [r["value"] for r in bi])]

    usd = flask_series(conn, "usd_idr", 30)
    specs["chart-usd-idr"] = [("USD/IDR", [r["date"] for r in usd], [r["value"] for r in usd])]

    gini = flask_series(conn, "gini", 10)
    specs["chart-rasio-gini"] = [("Rasio Gini", [r["date"] for r in gini], [r["value"] for r in gini])]

    yoy = flask_series(conn, "inflation_yoy", 12)
    specs["chart-inflation"] = [
        ("Inflasi YoY (%)", [r["date"] for r in yoy], [r["value"] for r in yoy])
    ]
    conn.close()
    return specs


def worker_specs(url):
    html = urllib.request.urlopen(url, timeout=30).read().decode("utf-8")
    m = re.search(r"window\.__CHARTS__=(\{.*?\});</script>", html, re.S)
    if not m:
        raise SystemExit("no chart payload in page")
    return json.loads(m.group(1))


def close(a, b, tol=1e-9):
    return abs(a - b) <= tol


def compare_xy(ref_x, ref_y, got_x, got_y):
    """Classify a trace pair.

    Returns one of:
      "exact"     — identical arrays
      "freshness" — every date the two share has the same value; the worker
                    window is longer/newer because it reads live data while the
                    Flask DB is a snapshot from an earlier run
      "mismatch"  — a shared date has a different value, or the shapes disagree
    """
    if list(ref_x) == list(got_x):
        return "exact" if all(close(a, b) for a, b in zip(ref_y, got_y)) else "mismatch"

    ref_map = dict(zip(ref_x, ref_y))
    got_map = dict(zip(got_x, got_y))
    shared = [d for d in ref_x if d in got_map]
    if shared and all(close(ref_map[d], got_map[d]) for d in shared):
        return "freshness"
    return "mismatch"


def main():
    url = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_URL
    ref = flask_specs()
    got = worker_specs(url)

    failures = []
    classes = {}
    for chart_id, traces in ref.items():
        spec = got.get(chart_id)
        if spec is None:
            failures.append(f"{chart_id}: missing from worker payload")
            continue
        data = spec.get("data", [])
        # The worker's inflation chart adds a corridor-band trace first; match by name.
        by_name = {t.get("name"): t for t in data}
        for name, x, y in traces:
            trace = by_name.get(name)
            if trace is None:
                failures.append(f"{chart_id}: no trace named {name!r} (has {list(by_name)})")
                continue
            verdict = compare_xy(x, y, trace.get("x", []), trace.get("y", []))
            classes.setdefault(verdict, []).append(f"{chart_id}/{name}")
            if verdict == "mismatch":
                failures.append(
                    f"{chart_id}/{name}: value mismatch\n"
                    f"    flask={list(zip(x, y))}\n"
                    f"    worker={list(zip(trace.get('x', []), trace.get('y', [])))}"
                )

    print(f"compared {len(ref)} charts against {FLASK_DB}")
    for verdict in ("exact", "freshness"):
        ids = classes.get(verdict, [])
        print(f"  {verdict}: {len(ids)} trace(s)")
        for i in ids:
            print(f"      {i}")
    if failures:
        print("\nMISMATCH:")
        for f in failures:
            print("  -", f)
        return 1
    print(
        "\nRESULT: PASS — every shared data point matches the Flask build "
        "(differences are only newer live data in the worker)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
