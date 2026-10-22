/**
 * Security headers + CSP nonce — TypeScript port of `apply_security_headers()`,
 * `build_csp()`, `issue_csp_nonce()` and `apply_nonce()` from `app.py`.
 *
 * The Flask version attaches a fresh `secrets.token_urlsafe(16)` nonce per
 * response, stamps every inline `<script>` with it, and lets the browser run
 * those scripts while `script-src` carries no `'unsafe-inline'`. That combination
 * is what separates grade A from A+ on securityheaders.com, so the port keeps it
 * exactly: a reused nonce is as good as `'unsafe-inline'`.
 */

export const HSTS_VALUE = "max-age=31536000; includeSubDomains";

/**
 * Third-party origins this dashboard genuinely loads: Plotly's runtime from the
 * plot.ly CDN, Bootstrap's stylesheet from jsDelivr. Nothing else is allowed.
 */
export const PLOTLY_CDN = "https://cdn.plot.ly";
export const BOOTSTRAP_CDN = "https://cdn.jsdelivr.net";

export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "autoplay=()",
  "camera=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "payment=()",
  "usb=()",
].join(", ");

/**
 * 128-bit nonce, base64url — the same entropy as Python `secrets.token_urlsafe(16)`.
 * `crypto.getRandomValues` is available in Workers; `crypto.randomUUID` is not
 * guaranteed and carries a fixed version/variant prefix.
 */
export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// `applyNonce` is owned by `charts.ts` — the chart payload is what makes these
// pages depend on inline scripts, so the stamping rule lives next to it. Re-exported
// here so every security concern still reads from one module.
export { applyNonce, hasUnstampedScripts } from "./charts";

/**
 * CSP for this response, allowing inline scripts only via this nonce.
 * Port of `build_csp()` — identical directive order and values.
 */
export function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' ${PLOTLY_CDN}`,
    `style-src 'self' 'unsafe-inline' ${BOOTSTRAP_CDN}`,
    `font-src 'self' data: ${BOOTSTRAP_CDN}`,
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
  ].join("; ");
}

/**
 * Stamp every inline `<script>` in a rendered fragment with the CSP nonce.
 *
 * Without this the charts are blocked in every real browser while curl still
 * sees a 200 — the failure is invisible outside a browser. Port of
 * `apply_nonce()`; the regex is identical, so it also skips scripts that
 * already carry a nonce or a `src` attribute.
 *
 * The implementation lives in `charts.ts` (re-exported above) so the policy and
 * the stamping share one regex — two copies would drift.
 */

export interface SecurityHeaders {
  "Content-Security-Policy": string;
  "X-Content-Type-Options": string;
  "X-Frame-Options": string;
  "Referrer-Policy": string;
  "Permissions-Policy": string;
  "Cross-Origin-Opener-Policy": string;
  "Cross-Origin-Resource-Policy": string;
  "Strict-Transport-Security"?: string;
}

/**
 * The full header set for one response. Port of `apply_security_headers()`.
 *
 * `secure` replaces Flask's `request.is_secure` (ProxyFix): on Render the TLS
 * terminates at the proxy, so a Worker reads the terminating protocol from
 * `X-Forwarded-Proto`, trusting exactly one hop. HSTS is withheld over plain
 * HTTP — sending it there can pin a browser to a scheme the host does not serve.
 */
export function securityHeaders(nonce: string, secure: boolean): SecurityHeaders {
  const headers: SecurityHeaders = {
    "Content-Security-Policy": buildCsp(nonce),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  if (secure) headers["Strict-Transport-Security"] = HSTS_VALUE;
  return headers;
}

/**
 * Port of `ProxyFix(x_for=1, x_proto=1, x_host=1)` — trust exactly one proxy
 * hop, so `X-Forwarded-Proto: https,http` (a client-controlled comma list) does
 * not read as HTTPS.
 */
export function isSecureRequest(request: Request): boolean {
  const proto = request.headers.get("x-forwarded-proto");
  return proto !== null && proto.split(",").length === 1 && proto.trim() === "https";
}
