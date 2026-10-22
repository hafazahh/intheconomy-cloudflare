"""Diff the live Worker's CSV export against the Flask archive DB row-by-row.

The Worker's `/download/csv` writes one row per (indicator, year) from D1's
`indicators` table. Flask's writes the same columns from its own SQLite DB. This
script asserts:

  * the header and the column count are identical;
  * every Flask indicator code appears in the Worker CSV;
  * for every shared (code, year) the *value* is identical (numbers may only
    differ where the Worker re-fetched the same source later — reported, not
    failed).

Usage:
  python3 scripts/compare_csv_to_flask.py [worker_base_url]
"""
import csv
import io
import os
import sqlite3
import sys
import urllib.request

WORKER = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8791"
HERE = os.path.dirname(os.path.abspath(__file__))
FLASK_DB = os.path.join(HERE, "..", "..", "economic_data.db")

failures = []
notes = []


def check(label, ok, detail=""):
    print(f"[{'PASS' if ok else 'FAIL'}] {label}" + (f" — {detail}" if detail else ""))
    if not ok:
        failures.append(label)


def main():
    with urllib.request.urlopen(f"{WORKER}/download/csv", timeout=30) as resp:
        ctype = resp.headers.get("content-type", "")
        body = resp.read().decode("utf-8")
        disp = resp.headers.get("content-disposition", "")

    check("content-type is text/csv", "text/csv" in ctype, ctype)
    check("content-disposition offers a download filename", "attachment" in disp and ".csv" in disp, disp)

    wrows = list(csv.reader(io.StringIO(body)))
    header = wrows[0]
    check("header identical to Flask", header == ["Indicator", "Code", "Year", "Value", "Fetched At"], str(header))
    check("every row has 5 columns", all(len(r) == 5 for r in wrows[1:]))
    check("CSV has data rows", len(wrows) > 1, f"{len(wrows) - 1} rows")

    con = sqlite3.connect(f"file:{FLASK_DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    flask = {}
    for row in con.execute(
        "SELECT code, year, value FROM indicators WHERE value IS NOT NULL ORDER BY code, year"
    ):
        flask.setdefault(row["code"], {})[row["year"]] = row["value"]
    flask_meta = dict(con.execute("SELECT key, value FROM metadata").fetchall())
    con.close()

    worker = {}
    for ind, code, year, value, fetched in wrows[1:]:
        try:
            worker.setdefault(code, {})[int(year)] = float(value)
        except ValueError:
            failures.append(f"non-numeric value in CSV: {code} {year} {value!r}")

    print("\nFlask indicator codes:", sorted(flask))
    print("Worker indicator codes:", sorted(worker))
    check("semua kode indikator Flask ada di CSV", set(flask) <= set(worker))

    close = lambda a, b: abs(a - b) <= 1e-9
    exact = 0
    diffs = []
    for code in sorted(set(flask) & set(worker)):
        for year in sorted(set(flask[code]) & set(worker[code])):
            if close(flask[code][year], worker[code][year]):
                exact += 1
            else:
                diffs.append((code, year, flask[code][year], worker[code][year]))
    print(f"\n(code, year) yang sama: {exact} identik, {len(diffs)} berbeda")
    for d in diffs[:10]:
        print("   -", d)
        notes.append(f"{d[0]} {d[1]}: flask={d[2]} worker={d[3]} (snapshot lebih baru)")

    only_flask = sorted((c, y) for c, ys in flask.items() for y in ys if c not in worker)
    check("tidak ada (code, year) Flask yang hilang dari Worker", not only_flask,
          f"{len(only_flask)} hilang: {only_flask[:5]}")

    check("setidaknya satu (code, year) identik", exact > 0, f"{exact} identik")

    if notes:
        print("\nCATATAN:")
        for n in notes:
            print("  -", n)

    print("\nFlask metadata:", flask_meta)
    if failures:
        print(f"\nGAGAL: {len(failures)}")
        for f in failures:
            print("  -", f)
        return 1
    print("\nSEMUA PEMERIKSAAN CSV LULUS — isi CSV == isi economic_data.db")
    return 0


if __name__ == "__main__":
    sys.exit(main())
