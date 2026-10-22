"""Inspect the rendered dashboard HTML: script tags, chart payload, numbers.

Read-only helper for the charts.ts verification. Usage:
  python3 scripts/inspect_page.py /tmp/page.html
"""
import json
import re
import sys

INLINE_SCRIPT_RE = re.compile(r"<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)", re.I)


def main(path: str) -> None:
    html = open(path, encoding="utf-8").read()
    print("html bytes:", len(html))
    print("inline <script> tags without nonce (must be 0):", len(INLINE_SCRIPT_RE.findall(html)))
    print("nonce attributes:", len(re.findall(r'<script nonce="([^"]+)"', html)))

    m = re.search(r"window\.__CHARTS__=(\{.*?\});</script>", html, re.S)
    if not m:
        print("chart payload: NOT FOUND")
        return
    charts = json.loads(m.group(1))
    print("chart payload ids:", len(charts))
    for key, spec in charts.items():
        if spec is None:
            print(f"  {key}: null (series empty)")
            continue
        data = spec.get("data", [])
        xs = [len(t.get("x", [])) for t in data]
        ys = [len(t.get("y", [])) for t in data]
        print(f"  {key}: traces={len(data)} x={xs} y={ys} annotations={len(spec['layout'].get('annotations', []))}")

    vals = re.findall(r'<div class="kpi-value[^"]*">([^<]*)</div>', html)
    print("kpi values:", vals)
    print("containers:", re.findall(r'id="(chart-[^"]+)"', html))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/page.html")
