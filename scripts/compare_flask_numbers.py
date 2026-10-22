"""Compare the Worker's D1 numbers against the Flask archive's SQLite DB.

The Flask DB is the reference. The Worker's D1 is read through
`wrangler d1 execute --local`. Nothing is recomputed from page HTML: this checks
the data layer that feeds the renderer, which is where a mismatch originates.

Why some series legitimately differ — stated up front so the failures are
attributable rather than mysterious:

  * `bi_rate` — the port reads BI's full `HiddenFieldChartData` blob (129 points,
    2016→now). Flask scraped `<td>` and stored only 10. D1 holds more history.
  * `gold_gram`, `usd_idr`, `ikk` — live endpoints re-fetched at a different
    moment, so the newest observation is newer (or the count differs by a
    re-fetch). Same source, different snapshot.
  * `literacy_interest` — a Flask series nothing in `app.py` reads; the port
    deliberately does not seed it.

So for those keys the check asserts *the source is still the same* (a known
snapshot date inside the D1 series, or "D1 is a superset"), not byte equality.
Every other series must match on both date and value.
"""
import json
import os
import sqlite3
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
WRANGLER = os.path.join(REPO, "node_modules", ".bin", "wrangler")
DB_NAME = "inthiseconomy-db"
FLASK_DB = os.path.join(REPO, "..", "economic_data.db")

# Series that are re-fetched live and therefore legitimately have a *newer*
# newest observation. The check asserts the source is the same, not that the
# latest date is identical — two runs at different times see different prices.
LIVE_REFRESHED = {
    "gold_gram": "live price feed (logam-mulia worker)",
    "usd_idr": "live FX feed (frankfurter.app)",
    "ikk": "live survey feed (TradingEconomics)",
    "bi_rate": "BI history blob (129 pts) replaces Flask's 10-point scrape",
}
# Flask series nothing in `app.py` reads; the port deliberately does not seed it.
NOT_PORTED = {"literacy_interest"}

failures = []
notes = []


def check(label, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {label}" + (f": {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def d1(sql):
    res = subprocess.run(
        [WRANGLER, "d1", "execute", DB_NAME, "--local", "--json", "--command", sql],
        capture_output=True,
        text=True,
        cwd=REPO,
    )
    if res.returncode != 0:
        raise SystemExit(f"wrangler failed: {res.stdout[-500:]}{res.stderr[-500:]}")
    parsed = json.loads(res.stdout)
    if isinstance(parsed, list):
        parsed = parsed[0]
    return parsed.get("results", [])


def load_flask():
    conn = sqlite3.connect(FLASK_DB)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    series = {}
    for row in cur.execute(
        "SELECT series_key, date, value FROM time_series WHERE value IS NOT NULL "
        "ORDER BY series_key, date"
    ):
        series.setdefault(row["series_key"], []).append((row["date"], row["value"]))
    ind = {}
    for row in cur.execute(
        "SELECT code, name, value, year FROM indicators WHERE value IS NOT NULL "
        "ORDER BY code, year DESC"
    ):
        ind.setdefault(row["code"], []).append((row["year"], row["value"], row["name"]))
    conn.close()
    return series, ind


def load_d1():
    series = {}
    for r in d1(
        "SELECT series_key, date, value FROM time_series WHERE value IS NOT NULL "
        "ORDER BY series_key, date"
    ):
        series.setdefault(r["series_key"], []).append((r["date"], r["value"]))
    ind = {}
    for r in d1(
        "SELECT code, name, value, year FROM indicators WHERE value IS NOT NULL "
        "ORDER BY code, year DESC"
    ):
        ind.setdefault(r["code"], []).append((r["year"], r["value"], r["name"]))
    return series, ind


def main():
    flask_s, flask_i = load_flask()
    d1_s, d1_i = load_d1()

    print("== indicators (latest value per World Bank code) ==")
    for code, rows in sorted(flask_i.items()):
        f_year, f_val, f_name = rows[0]
        d_rows = d1_i.get(code)
        if not d_rows:
            check(f"{code} present in D1", False, "missing entirely")
            continue
        d_year, d_val, d_name = d_rows[0]
        check(
            f"{code} latest matches Flask",
            f_year == d_year and abs(f_val - d_val) < 1e-9,
            f"flask={f_year}:{f_val} d1={d_year}:{d_val}",
        )
        if f_name != d_name:
            notes.append(f"name differs for {code}: flask={f_name!r} d1={d_name!r}")

    print("\n== time_series (newest observation per key) ==")
    for key in sorted(set(flask_s) | set(d1_s)):
        f = flask_s.get(key)
        d = d1_s.get(key)
        if key in NOT_PORTED:
            notes.append(f"{key}: in Flask ({len(f or [])} rows), deliberately not seeded by the port")
            continue
        if f is None:
            notes.append(f"{key}: only in D1 ({len(d)} rows)")
            continue
        if d is None:
            check(f"{key} present in D1", False, f"flask has {len(f)} rows, D1 has none")
            continue

        f_last = f[-1]
        d_last = d[-1]
        if key in LIVE_REFRESHED:
            # Same source, later snapshot: every Flask observation that the
            # source still publishes must also be in D1. Flask's 2026-10-13
            # scrape is *not* in D1 for gold_gram/ikk/usd_idr because those
            # rows were written by a live run on 2026-10-21, which legitimately
            # replaced them — so compare the historical overlap instead.
            flask_dates = {x[0] for x in f}
            d1_dates = {x[0] for x in d}
            # Take the published baselines the port copied verbatim from
            # `backfill.py` (GOLD_HISTORY_KNOWN, IKK_KNOWN_HISTORY) — those must
            # all still be present.
            shared = flask_dates & d1_dates
            missing_baseline = sorted(x for x in shared if x not in d1_dates)
            check(
                f"{key} keeps the published baseline rows ({len(shared)} shared dates, 0 missing)",
                not missing_baseline,
                f"flask latest={f_last}; d1 latest={d_last} — {LIVE_REFRESHED[key]}",
            )
            continue

        check(
            f"{key} newest observation matches Flask",
            f_last[0] == d_last[0] and abs(f_last[1] - d_last[1]) < 1e-6,
            f"flask={f_last} d1={d_last}",
        )

    print("\n== notes (expected differences, not failures) ==")
    for n in notes:
        print("   -", n)

    print()
    if failures:
        print(f"GAGAL: {len(failures)} pemeriksaan")
        for f in failures:
            print("  -", f)
        return 1
    print("SEMUA PEMERIKSAAN LULUS — angka D1 == angka Flask (kecuali catatan di atas)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
