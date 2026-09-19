/**
 * Security headers for every response the Worker renders.
 *
 * The Content-Security-Policy carries a fresh nonce per request. vinext reads the
 * script nonce from the *request's* `content-security-policy` header
 * (`vinext/dist/server/csp.js`, called from `app-rsc-handler.js`) and stamps it on
 * every inline script, external script, and style tag it renders. That is what lets
 * `script-src` forbid inline script outright instead of allowing `'unsafe-inline'`.
 *
 * Files under `dist/client` are served by Cloudflare's asset layer without running
 * this Worker, so they only get the headers in `dist/client/_headers`.
 */

const NONCE_BYTES = 18;

export function createNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  // base64url without padding: nothing vinext rejects, nothing to escape in an attribute.
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The origin of an absolute http(s) URL, or null. Paths and queries never enter the policy. */
export function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

export type PolicyOptions = {
  nonce: string;
  /** Origins the page may reach with fetch, in addition to its own. */
  connectOrigins: readonly (string | null)[];
  /** Only over HTTPS: on plain-HTTP local development it would break every asset. */
  upgradeInsecureRequests: boolean;
};

export function contentSecurityPolicy({ nonce, connectOrigins, upgradeInsecureRequests }: PolicyOptions): string {
  const connect = [...new Set(connectOrigins.filter((origin): origin is string => Boolean(origin)))];
  const directives = [
    "default-src 'self'",
    // Same-origin chunks plus the nonced inline bootstrap: no 'unsafe-inline', no
    // 'unsafe-eval', no third-party script host. 'strict-dynamic' is left out on
    // purpose. vinext nonces only some <link rel="modulepreload"> tags, and under
    // 'strict-dynamic' browsers ignore 'self', so those preloads would be blocked.
    `script-src 'self' 'nonce-${nonce}'`,
    // React renders `style={...}` props as attributes, which a nonce cannot cover.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    // next/font is self-hosted under /_next/static/_vinext_fonts.
    "font-src 'self'",
    ["connect-src 'self'", ...connect].join(" "),
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'none'",
    "object-src 'none'",
  ];
  if (upgradeInsecureRequests) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/** Headers that do not depend on the request. */
export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  // One year. No `preload`: joining browser preload lists is a separate decision
  // that cannot be quickly undone.
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  // The legacy counterpart of frame-ancestors 'none'.
  "x-frame-options": "DENY",
};

export function withSecurityHeaders(response: Response, policy: string): Response {
  // A rendered or fetched response can carry immutable headers, so copy it first.
  const secured = new Response(response.body, response);
  for (const [name, value] of Object.entries(STATIC_SECURITY_HEADERS)) secured.headers.set(name, value);
  secured.headers.set("content-security-policy", policy);
  return secured;
}
