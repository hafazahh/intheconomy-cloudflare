"""
Read the Flask archive SQLite DB (../economic_data.db) into a plain JSON
snapshot so the TypeScript renderer numbers can be diffed against them.

Source of truth for the comparison is the Flask DB, not memory. Run:
  python3 scripts/dump_flask_db.py > scripts/flask_db.json
"""
import json
import os
import sqlite3
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
DB = os.path.join(REPO, "..", "economic_data.db")


def main() -> int:
    if not os.path.exists(DB):
        print(f"missing: {DB}", file=sys.stderr)
        return 1
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    indicators = {}
    for row in cur.execute(
        "SELECT code, name, value, year, fetched_at FROM indicators "
        "WHERE value IS NOT NULL ORDER BY code, year DESC"
    ):
        entry = indicators.setdefault(
            row["code"], {"name": row["name"], "data": [], "latest": None}
        )
        entry["data"].append(
            {
                "code": row["code"],
                "name": row["name"],
                "value": row["value"],
                "year": row["year"],
                "fetched_at": row["fetched_at"],
            }
        )
    for entry in indicators.values():
        entry["latest"] = entry["data"][0] if entry["data"] else None

    series = {}
    for row in cur.execute(
        "SELECT series_key, date, value, fetched_at FROM time_series "
        "WHERE value IS NOT NULL ORDER BY series_key, date"
    ):
        series.setdefault(row["series_key"], []).append(
            {
                "date": row["date"],
                "value": row["value"],
                "fetched_at": row["fetched_at"],
            }
        )

    metadata = {k: v for k, v in cur.execute("SELECT key, value FROM metadata")}
    conn.close()

    json.dump(
        {"indicators": indicators, "series": series, "metadata": metadata},
        sys.stdout,
        ensure_ascii=False,
        indent=1,
        sort_keys=True,
    )
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
