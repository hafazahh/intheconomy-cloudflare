"""Read the rendered dashboard/micro HTML and print the human-visible numbers."""
import re
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "dash.html"
html = open(path, encoding="utf-8").read()

print(f"=== {path} ({len(html)} bytes) ===")

print("\n-- chart containers --")
for cid in sorted(set(re.findall(r'id="(chart-[a-z0-9-]*)"', html))):
    print("  ", cid)

print("\n-- script tags --")
for tag in re.findall(r"<script[^>]*>", html):
    print("  ", tag[:120])

print("\n-- KPI labels + values --")
for label, value in re.findall(r'<div class="kpi-label">(.*?)</div>\s*<div class="kpi-value[^"]*">(.*?)</div>', html, re.S):
    clean = re.sub(r"<[^>]+>", "", value).strip()
    print(f"   {re.sub('<[^>]+>', '', label).strip()[:40]:42s} {clean}")

print("\n-- insight --")
m = re.search(r"Insight:</strong>\s*(.*?)</div>", html, re.S)
if m:
    text = re.sub(r"<[^>]+>", "", m.group(1)).strip()
    print("  " + text[:1200])
else:
    print("   NONE")

print("\n-- snapshot --")
for s in re.findall(r'class="mb-2">(.*?)</p>', html, re.S):
    print("  " + re.sub(r"<[^>]+>", "", s).strip())

print("\n-- projections --")
print("  " + str(re.findall(r"<tr>\s*<td>(\d{4})</td>\s*<td>([\d.]+)</td>\s*<td>([\d.]+)</td>", html)))

print("\n-- micro insight (temuan utama / analisis tambahan) --")
for li in re.findall(r"<li>(.*?)</li>", html, re.S)[:12]:
    print("   *", re.sub(r"<[^>]+>", "", li).strip()[:200])

print("\n-- micro metric cards --")
for v, l in re.findall(r'<div class="metric-value">(.*?)</div>\s*<div class="metric-label">(.*?)</div>', html, re.S):
    print(f"   {v.strip():12s} {re.sub('<[^>]+>', '', l).strip()[:70]}")

print("\n-- empty JS assignments (const x = ;) --")
print("  ", re.findall(r"(?:const|let|var)\s+\w+\s*=\s*;", html) or "none")

print("\n-- data-unavailable alert --")
print("  ", "Data belum tersedia" in html)
