"""Dump series key counts from the local (miniflare) D1 state DB.

Read-only helper used to confirm which series a chart will have data for.
"""
import sqlite3
import sys

DB = (
    "/home/choirulhaq/venvProject/indonesia-economic-dashboard/inthiseconomy-cloudflare/"
    ".wrangler/state/v3/d1/miniflare-D1DatabaseObject/"
    "835495cd993b39989a3bb0a40c7ec0f058d41a7629faf5f3150cf1afe53543ce.sqlite"
)

con = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
rows = con.execute(
    "SELECT series_key, COUNT(*) FROM time_series GROUP BY series_key ORDER BY series_key"
).fetchall()
for key, n in rows:
    print(f"{key:45s} {n}")
print("total keys:", len(rows))
print("indicators:", con.execute("SELECT COUNT(*) FROM indicators").fetchone()[0])
con.close()
