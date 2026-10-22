"""Copy every macro time-series row under its correct series key.

The remote D1 was seeded by Fase 1 with `WB_SERIES` keyed by *constant name*
(`GINI_CODE`, `LIFE_EXP_CODE`, `EDU_EXP_CODE`, `LITERACY_CODE`), so those rows
are stored under names nothing reads. `app.py` reads `gini`, `life_exp`,
`edu_exp`, `literacy`. This copies the data — it does not invent it — then
deletes the wrongly-named keys, and prints before/after counts.

Idempotent: re-running finds no source rows for the old keys and stops.

Usage: `python3 scripts/fix_macro_series_keys.py [--local]`
       (default is the remote D1; `--local` fixes the `wrangler dev` database,
       which Fase 1 seeded with the same wrong keys.)
"""
import json
import subprocess
import sys

WRANGLER = "node_modules/.bin/wrangler"
DB = "inthiseconomy-db"

RENAME = {
    "GINI_CODE": "gini",
    "LIFE_EXP_CODE": "life_exp",
    "EDU_EXP_CODE": "edu_exp",
    "LITERACY_CODE": "literacy",
}


def run_sql(sql: str, local: bool = False):
    cmd = [WRANGLER, "d1", "execute", DB, "--json", "--command", sql]
    if local:
        cmd.append("--local")
    else:
        cmd.append("--remote")
    res = subprocess.run(cmd, capture_output=True, text=True, cwd=".")
    if res.returncode != 0:
        raise SystemExit(f"wrangler failed: {res.stdout[-800:]}{res.stderr[-800:]}")
    parsed = json.loads(res.stdout)
    # `wrangler d1 execute --json` returns a top-level array.
    if isinstance(parsed, list):
        parsed = parsed[0]
    if not parsed.get("success"):
        raise SystemExit(f"query not successful: {parsed}")
    return parsed.get("results", [])


def counts(local: bool = False):
    rows = run_sql(
        "SELECT series_key, COUNT(*) AS n FROM time_series GROUP BY series_key ORDER BY series_key",
        local,
    )
    return {r["series_key"]: r["n"] for r in rows}


def main():
    local = "--local" in sys.argv[1:]
    before = counts(local)
    print(f"BEFORE ({'local' if local else 'remote'}) — macro keys:", {k: before.get(k, 0) for k in list(RENAME) + list(RENAME.values())})

    total_moved = 0
    for old, new in RENAME.items():
        rows = run_sql(f"SELECT date, value FROM time_series WHERE series_key = '{old}'", local)
        if not rows:
            print(f"  {old}: no rows, skipping")
            continue
        # INSERT OR REPLACE so a re-run cannot duplicate or lose a row.
        values = ",".join(f"('{new}','{r['date']}',{r['value']},datetime('now'))" for r in rows)
        run_sql(
            "INSERT OR REPLACE INTO time_series (series_key, date, value, fetched_at) "
            f"VALUES {values}",
            local,
        )
        run_sql(f"DELETE FROM time_series WHERE series_key = '{old}'", local)
        total_moved += len(rows)
        print(f"  {old} -> {new}: {len(rows)} rows")

    after = counts(local)
    print(f"AFTER  ({'local' if local else 'remote'}) — macro keys:", {k: after.get(k, 0) for k in list(RENAME) + list(RENAME.values())})
    print(f"rows moved: {total_moved}")
    stale = [k for k in after if k.endswith("_CODE")]
    print("stale *_CODE keys remaining:", stale or "none")
    return 0


if __name__ == "__main__":
    sys.exit(main())
