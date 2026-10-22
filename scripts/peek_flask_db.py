"""Show the Flask archive DB contents: series keys, counts, and latest values."""
import json
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "scripts/flask_db.json"
d = json.load(open(path, encoding="utf-8"))

print("indicators:")
for code, entry in d["indicators"].items():
    rows = entry["data"]
    latest = entry["latest"]
    print(f"  {code} ({entry['name']}) rows={len(rows)} latest={latest['value']} y={latest['year']}")

print("\nseries keys:")
for key, rows in sorted(d["series"].items()):
    print(f"  {key}: {len(rows)} rows, first={rows[0]['date']} last={rows[-1]['date']}")

print("\nmetadata:", d["metadata"])
