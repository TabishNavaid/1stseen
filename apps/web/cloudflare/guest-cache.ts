/**
 * The edge cache for guest pages.
 *
 * Every signed-out visitor sees identical content on the landing page, the roles view, Just opened, the methodology page,
 * and role pages, so those documents are rendered once and served from the Cloudflare Cache API until what they show changes.
 *
 * - Only a whole-document GET with no Supabase session cookie is cached. A signed-in request, an RSC navigation, and
 *   any other method or path always render.
 * - The key is the canonical path plus the public data version (migration 202608140031). Any statement on a table a
 *   guest page reads advances that version, so a forecast regeneration or a collection run purges every guest page
 *   everywhere at once, with no purge API call. A five-minute TTL bounds anything the version does not track, such as
 *   the agent activity panel.
 * - The roles view's query is canonicalised: unknown parameters are dropped and known ones are put in one order, so a
 *   random query string cannot force a render. The landing page takes no query: any query on `/` is one path, except an
 *   old dashboard link, which the page redirects to the roles view and which is therefore rendered, never stored.
 * - A rendered page carries its CSP nonce in 37 places. The stored copy records the nonce it was rendered with, and a
 *   hit swaps in the request's fresh nonce, so a cached page never reuses a nonce across visitors.
 * - Only a 200 HTML response with no Set-Cookie is stored.
 *
 * Pure apart from the injected cache and render, so tests/guest-edge.test.mjs exercises it without workerd.
 */

// The explicit extension lets Node's test runner load this file directly; Vite resolves it either way.
import { DASHBOARD_PARAMS, DASHBOARD_PATH, dashboardHref, parseDashboardFilters } from "../lib/dashboard-query.ts";

export const CACHE_STATUS_HEADER = "x-firstseen-cache";
export const STORED_NONCE_HEADER = "x-firstseen-stored-nonce";
export const GUEST_PAGE_TTL_SECONDS = 300;
export const VERSION_MEMO_MS = 10_000;

const ROLE_PAGE = /^\/roles\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type GuestCache = {
  match(request: Request): Promise<Response | undefined>;
  put(request: Request, response: Response): Promise<void>;
};

/** Whether the request carries a Supabase session cookie, including a chunked one (`sb-<ref>-auth-token.0`). */
export function hasSessionCookie(request: Request): boolean {
  const header = request.headers.get("cookie");
  if (!header) return false;
  return header.split(";").some((part) => {
    const name = part.trim().split("=")[0] ?? "";
    return name.startsWith("sb-") && name.includes("-auth-token");
  });
}

/** The canonical cache path for a guest page request, or null when the request must be rendered. */
export function guestCachePath(request: Request): string | null {
  if (request.method !== "GET" || hasSessionCookie(request)) return null;
  const url = new URL(request.url);
  // An RSC navigation carries router state in its headers, and its payload is not a document.
  if (request.headers.has("rsc") || url.searchParams.has("_rsc")) return null;
  if (!(request.headers.get("accept") ?? "").includes("text/html")) return null;
  if (url.pathname === "/") {
    // A signed-out visit to the front page is the landing page, whatever else the query holds; an old dashboard link
    // redirects to the roles view, and a redirect is never stored.
    return [...url.searchParams.keys()].some((key) => DASHBOARD_PARAMS.includes(key)) ? null : "/";
  }
  if (url.pathname === DASHBOARD_PATH) {
    const params: Record<string, string | string[]> = {};
    for (const [key, value] of url.searchParams) {
      const existing = params[key];
      params[key] = existing === undefined ? value : ([] as string[]).concat(existing, value);
    }
    const filters = parseDashboardFilters(params);
    // A filter's values are a set, so they are de-duplicated and sorted as well; otherwise reordering them would miss.
    const canonical = Object.fromEntries(
      Object.entries(filters).map(([key, value]) => [key, Array.isArray(value) ? [...new Set(value)].sort() : value]),
    ) as typeof filters;
    // dashboardHref resets the page unless it is passed as a change, and page 2 must not be served page 1.
    return dashboardHref(canonical, { page: canonical.page });
  }
  // The methodology page reads the latest backtest and forecast counts, both of which advance the public data version.
  if (url.pathname === "/methodology") return url.pathname;
  // Just opened reads opening events, which advance the version; its parameters are one company and the page.
  if (url.pathname === "/opened") {
    const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
    const company = url.searchParams.get("company") ?? "";
    const query = new URLSearchParams();
    if (UUID.test(company)) query.set("company", company);
    if (Number.isFinite(page) && page > 1) query.set("page", String(Math.min(page, 1000)));
    const search = query.toString();
    return search ? `/opened?${search}` : "/opened";
  }
  return ROLE_PAGE.test(url.pathname) ? url.pathname : null;
}

/**
 * The key a guest page is stored under: its canonical path, the public data version, and the Worker version that
 * rendered it. A deploy or a rollback therefore never serves a page rendered by another build, whose stylesheet and
 * script files that build no longer serves.
 */
export function guestCacheKey(origin: string, path: string, version: number, build = ""): Request {
  const scope = build ? `b${encodeURIComponent(build)}/` : "";
  return new Request(new URL(`/__guest-cache/${scope}v${version}${path}`, origin).toString(), { method: "GET" });
}

/** A version reader that asks at most once per `memoMs` per isolate. A failed read is not remembered. */
export function memoizedVersion(read: () => Promise<number | null>, memoMs = VERSION_MEMO_MS, clock = () => Date.now()) {
  let memo: { value: number; expires: number } | null = null;
  return async (): Promise<number | null> => {
    const now = clock();
    if (memo && memo.expires > now) return memo.value;
    const value = await read();
    memo = value === null ? null : { value, expires: now + memoMs };
    return value;
  };
}

function cacheable(response: Response): boolean {
  return (
    response.status === 200
    && response.headers.getSetCookie().length === 0
    && (response.headers.get("content-type") ?? "").includes("text/html")
  );
}

export async function serveGuestPage({
  request,
  path,
  version,
  build = "",
  nonce,
  cache,
  render,
  waitUntil,
}: {
  request: Request;
  path: string;
  version: number;
  /** The Worker version rendering this request (the version_metadata binding), so builds never share a stored page. */
  build?: string;
  /** The nonce in this request's Content-Security-Policy, which the response must carry. */
  nonce: string;
  cache: GuestCache;
  render: () => Promise<Response>;
  waitUntil: (promise: Promise<unknown>) => void;
}): Promise<Response> {
  const key = guestCacheKey(new URL(request.url).origin, path, version, build);
  const hit = await cache.match(key);
  const storedNonce = hit?.headers.get(STORED_NONCE_HEADER);
  if (hit && storedNonce) {
    const html = (await hit.text()).replaceAll(storedNonce, nonce);
    const headers = new Headers(hit.headers);
    headers.delete(STORED_NONCE_HEADER);
    headers.set("cache-control", "no-store, must-revalidate");
    headers.set(CACHE_STATUS_HEADER, "hit");
    return new Response(html, { status: 200, headers });
  }

  const rendered = await render();
  if (!cacheable(rendered)) {
    const headers = new Headers(rendered.headers);
    headers.set(CACHE_STATUS_HEADER, "bypass");
    return new Response(rendered.body, { status: rendered.status, statusText: rendered.statusText, headers });
  }
  const html = await rendered.text();
  const stored = new Headers(rendered.headers);
  stored.delete("vary");
  stored.delete("content-security-policy");
  stored.set("cache-control", `public, max-age=${GUEST_PAGE_TTL_SECONDS}`);
  stored.set(STORED_NONCE_HEADER, nonce);
  waitUntil(cache.put(key, new Response(html, { status: 200, headers: stored })));
  const headers = new Headers(rendered.headers);
  headers.set(CACHE_STATUS_HEADER, "miss");
  return new Response(html, { status: 200, headers });
}
