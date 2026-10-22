"""Produce the Flask oracle for `verify_insight_parity.py`.

Runs the real `app.py` `generate_insight()` over the 21 scenarios from
`test_insight_dynamic.py` plus 5 BPS variants, and writes the inputs *and* the
expected text to JSON. `verify_insight_parity.py` then diffs that file against
the TypeScript output from `insight_ts_run.mjs`.

Usage:
    python3 scripts/insight_py_dump.py oracle.json

`app.py` calls `bootstrap()` at import time (APScheduler thread + possible
network), so `scheduler` and `backfill` are stubbed first. `generate_insight()`
and `dashboard()` touch neither, so the oracle is unaffected.
"""
import json
import os
import sys
import types

PROJECT = "/home/choirulhaq/venvProject/indonesia-economic-dashboard"
sys.path.insert(0, PROJECT)

noop = types.ModuleType("scheduler")
setattr(noop, "start_scheduler", lambda *a, **k: None)
setattr(noop, "stop_scheduler", lambda *a, **k: None)
setattr(noop, "scheduler_running", False)
sys.modules["scheduler"] = noop

backfill = types.ModuleType("backfill")
setattr(backfill, "run", lambda *a, **k: None)
sys.modules["backfill"] = backfill

import app as appmod  # noqa: E402

GDP = "NY.GDP.MKTP.KD.ZG"
INF = "FP.CPI.TOTL.ZG"
TRD = "BN.GSR.GNFS.CD"


def make(pdb, inf, trd, year=2025, pdb_prev=None, inf_prev=None, trd_prev=None):
    def latest(code, v, prev_v=None):
        data = [{"value": v, "year": year}]
        if prev_v is not None:
            data.append({"value": prev_v, "year": year - 1})
        return {code: {"name": code, "data": data, "latest": {"value": v, "year": year}}}

    d = {}
    d.update(latest(GDP, pdb, pdb_prev))
    d.update(latest(INF, inf, inf_prev))
    d.update(latest(TRD, trd, trd_prev))
    return d


# The exact 21 scenarios from `test_insight_dynamic.py`.
scenarios = [
    ("Data sekarang (nyata 2025)", make(5.108, 1.913, 29649335679.15, pdb_prev=4.9, inf_prev=2.5, trd_prev=25000000000.0)),
    ("PDB naik (membaik)", make(5.5, 1.913, 29649335679.15, pdb_prev=4.9)),
    ("PDB turun tapi >=5%", make(5.1, 1.913, 29649335679.15, pdb_prev=5.5)),
    ("PDB 4.5-5% (melambat)", make(4.7, 1.913, 29649335679.15, pdb_prev=5.0)),
    ("PDB <4.5% (moderat)", make(3.2, 1.913, 29649335679.15, pdb_prev=4.0)),
    ("Inflasi <2% (bawah)", make(5.108, 1.5, 29649335679.15)),
    ("Inflasi 2-4% (dalam)", make(5.108, 3.0, 29649335679.15)),
    ("Inflasi >4% (atas)", make(5.108, 6.5, 29649335679.15)),
    ("Trade surplus besar", make(5.108, 1.913, 25000000000.0)),
    ("Trade surplus moderat", make(5.108, 1.913, 15000000000.0)),
    ("Trade surplus kecil", make(5.108, 1.913, 5000000000.0)),
    ("Trade defisit", make(5.108, 1.913, -12500000000.0)),
    ("Trade surplus melebar", make(5.108, 1.913, 30000000000.0, trd_prev=20000000000.0)),
    ("Trade surplus menyempit", make(5.108, 1.913, 20000000000.0, trd_prev=30000000000.0)),
    ("Trade defisit melebar", make(5.108, 1.913, -15000000000.0, trd_prev=-5000000000.0)),
    ("Trade defisit menyempit", make(5.108, 1.913, -5000000000.0, trd_prev=-15000000000.0)),
    ("Trade berubah dari defisit", make(5.108, 1.913, 5000000000.0, trd_prev=-5000000000.0)),
    ("Trade berubah dari surplus", make(5.108, 1.913, -5000000000.0, trd_prev=5000000000.0)),
    ("Kombinasi: growth tinggi + inflasi rendah", make(5.5, 1.5, 29649335679.15)),
    ("Kombinasi: growth melambat + inflasi tinggi", make(4.0, 6.5, 29649335679.15)),
    ("Semua indikator memburuk", make(2.0, 8.0, -5000000000.0)),
]

bps_base = make(5.108, 1.913, 29649335679.15, pdb_prev=4.9, inf_prev=2.5)
bps_cases = [
    ("BPS 3.28 (dalam target)", {"value": 3.28, "date": "2026-09-01"}),
    ("BPS 1.20 (bawah target)", {"value": 1.20, "date": "2026-09-01"}),
    ("BPS 5.50 (atas target)", {"value": 5.50, "date": "2026-09-01"}),
    ("BPS 2.00 (batas bawah)", {"value": 2.00, "date": "2026-09-01"}),
    ("BPS 4.00 (batas atas)", {"value": 4.00, "date": "2026-09-01"}),
]


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else "insight_oracle.json"
    out = []
    for name, data in scenarios:
        out.append({"name": name, "data": data, "bps": None, "expected": appmod.generate_insight(data)})
    for name, bps in bps_cases:
        out.append(
            {
                "name": name,
                "data": bps_base,
                "bps": bps,
                "expected": appmod.generate_insight(bps_base, bps_inflation=bps),
            }
        )
    with open(target, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, indent=1)
    print(f"wrote {target}: {len(out)} cases")
    return 0


if __name__ == "__main__":
    sys.exit(main())
