"""Drive the local Chromium over CDP: load a page, wait for Plotly, report charts.

Usage:
  python3 scripts/verify_browser_charts.py http://127.0.0.1:8788/
  python3 scripts/verify_browser_charts.py http://127.0.0.1:8788/micro

Reports, per chart id: whether the container exists, how many traces Plotly
actually attached, and whether the rendered SVG has any visible geometry. A div
with no traces is a chart that silently did not render.
"""
import json
import sys
import time
import urllib.request

CDP = "http://127.0.0.1:9222"


def ws_url():
    tabs = json.load(urllib.request.urlopen(f"{CDP}/json/list"))
    pages = [t for t in tabs if t.get("type") == "page"]
    if not pages:
        raise SystemExit("no page target; open one first")
    return pages[0]["webSocketDebuggerUrl"], pages[0]["id"]


def send(ws, msg_id, method, params=None):
    ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
    while True:
        data = json.loads(ws.recv())
        if data.get("id") == msg_id:
            return data


def main():
    url = sys.argv[1]
    from ws import WS

    ws_url_str, _ = ws_url()
    ws = WS(ws_url_str)

    send(ws, 1, "Runtime.enable")
    send(ws, 2, "Page.enable")
    send(ws, 3, "Page.navigate", {"url": url})

    # Wait for Plotly to be present and for every chart div to have traces.
    deadline = time.time() + 60
    report = None
    while time.time() < deadline:
        res = send(
            ws,
            100,
            "Runtime.evaluate",
            {
                "expression": """(() => {
                  const specs = window.__CHARTS__ || {};
                  const ids = Object.keys(specs);
                  const rows = ids.map((id) => {
                    const el = document.getElementById(id);
                    let traces = 0, svgPaths = 0, error = null;
                    if (el) {
                      if (el.data) traces = el.data.length;
                      svgPaths = el.querySelectorAll('.scatterlayer .trace path').length
                               + el.querySelectorAll('.barlayer .point').length;
                      error = el.getAttribute('_chartdaq') || null;
                    }
                    return {id, div: !!el, traces, svgPaths};
                  });
                  return JSON.stringify({
                    url: location.href,
                    plotly: typeof Plotly !== 'undefined',
                    version: (typeof Plotly !== 'undefined') ? Plotly.version : null,
                    chartIds: ids.length,
                    rows,
                    kpiCards: document.querySelectorAll('.kpi-card').length,
                    kpiValues: Array.from(document.querySelectorAll('.kpi-value'))
                                   .map(e => e.textContent.trim()),
                    insightLen: (document.querySelector('.insight-box')||{textContent:''})
                                  .textContent.trim().length,
                    bodyLen: document.body.innerHTML.length,
                    svgTotal: document.querySelectorAll('.plotly-notifier, .svg-container').length,
                  });
                })()""",
                "returnByValue": True,
            },
        )
        value = res.get("result", {}).get("result", {}).get("value")
        if value:
            report = json.loads(value)
            if report["plotly"] and all(r["traces"] > 0 for r in report["rows"]) and report["rows"]:
                break
        time.sleep(1.0)

    print(json.dumps(report, indent=2, ensure_ascii=False))

    # Assert: every chart id has a div and at least one trace.
    failures = []
    if not report:
        failures.append("no report (page never loaded)")
    else:
        if not report["plotly"]:
            failures.append("Plotly not loaded from CDN")
        for row in report["rows"]:
            if not row["div"]:
                failures.append(f"{row['id']}: container missing")
            if row["traces"] == 0:
                failures.append(f"{row['id']}: 0 traces (silent empty chart)")
        if report["chartIds"] == 0:
            failures.append("no chart ids emitted at all")
        if report["kpiCards"] == 0:
            failures.append("no KPI cards")

    # Collect any CSP violation / console error.
    res = send(
        ws,
        101,
        "Runtime.evaluate",
        {"expression": "JSON.stringify(window.__cspViolations || [])", "returnByValue": True},
    )
    print("\ncsp violations:", res.get("result", {}).get("result", {}).get("value"))
    print("\nRESULT:", "PASS" if not failures else "FAIL")
    for f in failures:
        print("  -", f)
    ws.close()
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
