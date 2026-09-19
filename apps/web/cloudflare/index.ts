/** Cloudflare Worker entry point: security headers, the guest agent limits, and the guest page cache. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import {
  GUEST_AGENT_HEADER,
  GUEST_LIMIT_PERIOD_SECONDS,
  GUEST_QUESTIONS_OVERALL,
  GUEST_QUESTIONS_PER_ADDRESS,
  guestAgentAllowance,
  guestLimitResponse,
  type GuestAgentLimits,
} from "./guest-agent";
import { frontDoorRedirect } from "./front-door";
import { durableGuestLimits, type DurableObjectNamespaceLike } from "./guest-limiter";
import { guestCachePath, hasSessionCookie, memoizedVersion, serveGuestPage, type GuestCache } from "./guest-cache";
import { withPageStatus } from "./page-status";
import { contentSecurityPolicy, createNonce, withSecurityHeaders } from "./security-headers";

// Durable Object classes must be exported from the Worker's main module.
export { GuestQuestionLimiter } from "./guest-limiter";

interface Env extends GuestAgentLimits {
  ASSETS: Fetcher;
  /** Counts guest questions exactly (guest-limiter.ts). */
  GUEST_QUESTION_LIMITER?: DurableObjectNamespaceLike;
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** "off" renders every guest page, for measuring the uncached path and as an operational switch. */
  FIRSTSEEN_EDGE_CACHE?: string;
  /** This Worker version's id, which scopes the guest cache to one build (vite.config.ts). */
  CF_VERSION_METADATA?: { id?: string };
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

type Setting = "SUPABASE_URL" | "SUPABASE_SERVICE_ROLE_KEY" | "FIRSTSEEN_EDGE_CACHE";

function setting(env: Env, name: Setting): string | undefined {
  return env[name] ?? process.env[name];
}

let versionReader: (() => Promise<number | null>) | null = null;

/** The public data version, read at most every ten seconds per isolate. Null when it cannot be read: then pages render. */
function publicDataVersion(env: Env): Promise<number | null> {
  versionReader ??= memoizedVersion(async () => {
    const url = setting(env, "SUPABASE_URL");
    const key = setting(env, "SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return null;
    try {
      const response = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/rpc/public_data_version`, {
        method: "POST",
        headers: { apikey: key, authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok) return null;
      const value = Number(await response.json());
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  });
  return versionReader();
}

const ROLE_PAGE = /^\/roles\/([^/]+)\/?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a role page's id is a role in the product (in scope and active): true, false, or null when it cannot be told
 * (no database configured, as in demo mode, or the check failed), in which case the page's own answer stands.
 *
 * The page renders "Role not found" for any other id, but behind the root loading boundary the shell has already gone
 * out with 200 by then, so without this a missing role answered 200. One single-row read by primary key, run beside the
 * render so it adds no latency.
 */
async function roleIsListed(env: Env, roleId: string): Promise<boolean | null> {
  const url = setting(env, "SUPABASE_URL");
  const key = setting(env, "SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  if (!UUID.test(roleId)) return false;
  try {
    const response = await fetch(
      `${url.replace(/\/+$/, "")}/rest/v1/canonical_roles?select=id&id=eq.${roleId}&scope_status=eq.in_scope&active=eq.true&limit=1`,
      { headers: { apikey: key, authorization: `Bearer ${key}` } },
    );
    if (!response.ok) return null;
    return ((await response.json()) as unknown[]).length === 1;
  } catch {
    return null;
  }
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const nonce = createNonce();
    const policy = contentSecurityPolicy({
      nonce,
      // The browser connects only to this origin. Every Supabase Auth call runs in the
      // Worker's /api/auth routes, and the agent service is reached only through /api proxy
      // routes; listing either origin would publish it to every visitor for no purpose.
      connectOrigins: [],
      upgradeInsecureRequests: url.protocol === "https:",
    });

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const image = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
      return withSecurityHeaders(image, policy);
    }

    // A signed-in visit to the front page goes to the roles view before anything streams (front-door.ts).
    const signedInHome = frontDoorRedirect(request);
    if (signedInHome) {
      return withSecurityHeaders(new Response(null, { status: 307, headers: { location: signedInHome, "cache-control": "no-store" } }), policy);
    }

    // vinext takes the script nonce from the request's CSP header. Setting it here
    // overwrites anything the client sent, so a caller can never choose the nonce.
    const headers = new Headers(request.headers);
    headers.set("content-security-policy", policy);
    // Only this entry may tell the agent route that a signed-out question passed the guest limits.
    headers.delete(GUEST_AGENT_HEADER);
    if (request.method === "POST" && url.pathname === "/api/recruiting-agent" && !hasSessionCookie(request)) {
      const limits = env.GUEST_QUESTION_LIMITER
        ? durableGuestLimits(env.GUEST_QUESTION_LIMITER, GUEST_QUESTIONS_PER_ADDRESS, GUEST_QUESTIONS_OVERALL, GUEST_LIMIT_PERIOD_SECONDS)
        : env;
      const decision = await guestAgentAllowance(request, limits);
      if (!decision.allowed) return withSecurityHeaders(guestLimitResponse(decision), policy);
      headers.set(GUEST_AGENT_HEADER, "allowed");
    }
    const renderPage = () => handler.fetch(new Request(request, { headers }), env, ctx);
    // A document takes the status its page states: 404 for a not-found page, 500 for a failure (page-status.ts).
    const renderDocument = request.method === "GET" ? async () => withPageStatus(await renderPage()) : renderPage;
    const role = request.method === "GET" ? ROLE_PAGE.exec(url.pathname) : null;
    const render = role
      ? async () => {
          const [response, listed] = await Promise.all([renderDocument(), roleIsListed(env, decodeURIComponent(role[1]))]);
          if (listed !== false || response.status !== 200) return response;
          const notFound = new Headers(response.headers);
          notFound.set("cache-control", "no-store");
          return new Response(response.body, { status: 404, statusText: "Not Found", headers: notFound });
        }
      : renderDocument;

    // The Cache API exists only in workerd; the Node test harness always renders.
    const cache = (globalThis as { caches?: { default?: GuestCache } }).caches?.default;
    const path = cache && setting(env, "FIRSTSEEN_EDGE_CACHE") !== "off" ? guestCachePath(request) : null;
    if (cache && path) {
      const version = await publicDataVersion(env);
      if (version !== null) {
        const response = await serveGuestPage({
          request,
          path,
          version,
          build: env.CF_VERSION_METADATA?.id ?? "",
          nonce,
          cache,
          render,
          waitUntil: (promise) => ctx.waitUntil(promise),
        });
        return withSecurityHeaders(response, policy);
      }
    }
    return withSecurityHeaders(await render(), policy);
  },
};

export default worker;
