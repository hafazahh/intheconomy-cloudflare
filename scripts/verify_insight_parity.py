"""Prove the Worker's `generateInsight()` matches Flask's `generate_insight()`.

The Python test `test_insight_dynamic.py` asserts the 21 scenarios change their
own text; it does not prove the TypeScript port emits the *same* text. This
script closes that gap:

    python3 scripts/insight_py_dump.py oracle.json              # Flask oracle
    node scripts/insight_ts_run.mjs oracle.json actual.json      # Worker
    python3 scripts/verify_insight_parity.py oracle.json actual.json

Both sides are run on identical inputs. Any byte difference is a regression in
the port and fails the check.

`app.py` calls `bootstrap()` at import time, which starts APScheduler and can
hit the network, so the dump path stubs `scheduler` and `backfill` first.
`generate_insight()` is pure and touches neither.
"""
import json
import sys


def main(oracle_path: str, actual_path: str) -> int:
    with open(oracle_path, encoding="utf-8") as fh:
        oracle = json.load(fh)
    with open(actual_path, encoding="utf-8") as fh:
        actual = json.load(fh)

    failures = []
    checked = 0
    for want, got in zip(oracle, actual):
        checked += 1
        if want["name"] != got["name"]:
            failures.append(f"{want['name']}: name mismatch vs {got['name']}")
            continue
        if want["expected"] != got["actual"]:
            failures.append(want["name"])

    if len(oracle) != len(actual):
        failures.append(f"case count differs: oracle={len(oracle)} actual={len(actual)}")

    print(f"kasus dibandingkan : {checked}")
    print(f"identik           : {checked - len(failures)}")
    if failures:
        print()
        print("BERBEDA:")
        for name in failures:
            print(f"  - {name}")
        print()
        for want, got in zip(oracle, actual):
            if want["expected"] != got["actual"]:
                print(f"--- {want['name']}")
                print(f"  Flask : {want['expected']}")
                print(f"  Worker: {got['actual']}")
        return 1
    print()
    print("KESIMPULAN: generateInsight() TypeScript identik dengan generate_insight() Flask.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
