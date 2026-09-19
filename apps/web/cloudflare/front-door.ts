/**
 * The front page for someone with a session.
 *
 * `/` is the landing page for a first-time visitor and the roles view for a signed-in user. The page itself can only
 * redirect after the root loading boundary has sent its shell with 200, so the Worker entry answers a signed-in
 * document request for `/` with a redirect before anything renders. It goes by the session cookie alone, with no auth
 * call: a stale cookie lands on the roles view, which a guest can use too, and the page's own check still applies.
 *
 * Pure, so tests/guest-edge.test.mjs exercises it without workerd.
 */

// The explicit extension lets Node's test runner load this file directly; Vite resolves it either way.
import { DASHBOARD_PARAMS, DASHBOARD_PATH } from "../lib/dashboard-query.ts";
import { hasSessionCookie } from "./guest-cache.ts";

/** Where a signed-in GET of the front page goes, or null to render it. */
export function frontDoorRedirect(request: Request): string | null {
  if (request.method !== "GET" || !hasSessionCookie(request)) return null;
  const url = new URL(request.url);
  // A client-side navigation carries router state and follows the page's own redirect.
  if (url.pathname !== "/" || request.headers.has("rsc") || url.searchParams.has("_rsc")) return null;
  const query = new URLSearchParams();
  for (const [key, value] of url.searchParams) if (DASHBOARD_PARAMS.includes(key)) query.append(key, value);
  return query.size ? `${DASHBOARD_PATH}?${query}` : DASHBOARD_PATH;
}
