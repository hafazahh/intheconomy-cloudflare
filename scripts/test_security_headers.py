"""Check the security header set on a running Worker against `test_security_headers.py`.

Covers the same assertions the Python suite makes, including the negative cases:
HSTS must be ABSENT over plain HTTP, the nonce must match the inline scripts and
must differ between responses, and `script-src` must carry no `'unsafe-inline'`.
"""
import re
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8788"

REQUIRED = [
    "Content-Security-Policy",
    "X-Content-Type-Options",
    "X-Frame-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Cross-Origin-Opener-Policy",
    "Cross-Origin-Resource-Policy",
]

passed = failed = 0


def fetch(path, headers=None):
    req = urllib.request.Request(BASE + path, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, dict(r.headers), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode("utf-8", "replace")


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {label}")
    else:
        failed += 1
        print(f"  FAIL  {label}  {detail}")


def nonce_of(csp):
    m = re.search(r"'nonce-([^']+)'", csp or "")
    return m.group(1) if m else None


def main():
    print("\n[1] Every security header present")
    status, headers, html = fetch("/")
    check("dashboard returns 200", status == 200, f"got {status}")
    for h in REQUIRED:
        check(f"{h} present", bool(headers.get(h)), "missing")

    print("\n[2] Header values")
    check("X-Content-Type-Options == nosniff", headers.get("X-Content-Type-Options") == "nosniff")
    check("X-Frame-Options == DENY", headers.get("X-Frame-Options") == "DENY")
    check(
        "Referrer-Policy set",
        headers.get("Referrer-Policy") == "strict-origin-when-cross-origin",
    )
    check("COOP == same-origin", headers.get("Cross-Origin-Opener-Policy") == "same-origin")
    check("CORP == same-origin", headers.get("Cross-Origin-Resource-Policy") == "same-origin")
    check(
        "Permissions-Policy denies camera",
        "camera=()" in (headers.get("Permissions-Policy") or ""),
    )

    print("\n[3] HSTS absent over plain HTTP")
    check(
        "HSTS ABSENT over http (would pin a scheme the host may not serve)",
        headers.get("Strict-Transport-Security") is None,
        f"got {headers.get('Strict-Transport-Security')}",
    )

    print("\n[4] CSP content")
    csp = headers.get("Content-Security-Policy") or ""
    check("CSP has NO script-src 'unsafe-inline'", "script-src 'unsafe-inline'" not in csp, csp[:160])
    check("CSP has NO script-src * wildcard", "script-src *" not in csp)
    check("CSP script-src carries a nonce", "'nonce-" in csp)
    check("CSP allows the Plotly CDN in script-src", "https://cdn.plot.ly" in csp)
    check("CSP allows jsDelivr for styles", "https://cdn.jsdelivr.net" in csp)
    check("CSP frame-ancestors 'none'", "frame-ancestors 'none'" in csp)
    check("CSP object-src 'none'", "object-src 'none'" in csp)
    check("CSP base-uri 'self'", "base-uri 'self'" in csp)
    check("CSP form-action 'self'", "form-action 'self'" in csp)

    print("\n[5] Nonce actually applied to every inline <script>")
    csp_nonce = nonce_of(csp)
    inline = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>", html, re.I)
    check("inline <script> blocks found", len(inline) > 0, "none found")
    missing = [t for t in inline if f'nonce="{csp_nonce}"' not in t]
    check(
        f"all {len(inline)} inline scripts carry the CSP nonce",
        not missing,
        f"missing on {len(missing)}: {missing[:2]}",
    )
    bare = [t for t in inline if not re.search(r"nonce=", t, re.I)]
    check("no bare <script> without nonce", not bare, f"{len(bare)} bare")

    print("\n[6] Nonce is fresh per response")
    _, h2, _ = fetch("/")
    n2 = nonce_of(h2.get("Content-Security-Policy"))
    check("nonce differs between responses", csp_nonce != n2, f"reused {csp_nonce}")
    check(
        "nonce is long enough (>=16 chars)",
        bool(csp_nonce) and len(csp_nonce) >= 16,
        f"len={len(csp_nonce or '')}",
    )

    print("\n[7] Headers also on non-HTML routes")
    for path in ("/healthz", "/health", "/download/csv"):
        s, hh, _ = fetch(path)
        check(f"{path} 200", s == 200, f"got {s}")
        check(f"{path} has nosniff", hh.get("X-Content-Type-Options") == "nosniff")
        check(f"{path} has CSP", bool(hh.get("Content-Security-Policy")))

    print("\n[8] Content still renders (headers must not break the page)")
    check("KPI value rendered", "kpi-value" in html)
    check("chart div present", "chart-main" in html)
    check(
        "no empty JS assignment (const x = ;)",
        not re.search(r"(?:const|let|var)\s+\w+\s*=\s*;", html),
    )
    check("no unrendered Jinja block tags", "{%" not in html)

    print(f"\n=== {passed}/{passed + failed} PASS ===")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
