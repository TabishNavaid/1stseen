import "server-only";

import { createServerClient } from "@supabase/ssr";
import { getPublicConfig } from "@/lib/config";

const NO_STORE = { "cache-control": "no-store" } as const;

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A small JSON object body, or null. Auth requests are tiny; anything larger is refused unread. */
export async function readJson(request: Request, maxBytes = 4_096): Promise<Record<string, unknown> | null> {
  if (Number(request.headers.get("content-length") ?? "0") > maxBytes) return null;
  const text = await request.text().catch(() => "");
  if (!text || text.length > maxBytes) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Auth routes accept only same-origin browser requests. Session cookies are SameSite=Lax,
 * which already blocks cross-site POSTs carrying them; this also stops a hostile page from
 * signing a visitor into an attacker's account.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("sec-fetch-site") !== "cross-site";
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

/** The origin email links must return to. Supabase Auth refuses any redirect not on its allowlist. */
export function appOrigin(request: Request): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  return configured && /^https?:\/\/[^/]+$/.test(configured) ? configured : new URL(request.url).origin;
}

/**
 * A Supabase Auth client bound to no cookies, for sign-up, resend, and reset requests. None
 * of them signs anyone in, so none needs a session.
 */
export function detachedAuthClient() {
  const config = getPublicConfig();
  return createServerClient(config.supabaseUrl, config.supabaseAnonKey, {
    cookies: { getAll: () => [], setAll: () => {} },
  });
}

/** Auth calls whose outcome the user is never told about log only the error code and status, never an address. */
export function logBackgroundFailure(action: string, error: { code?: string; status?: number } | unknown) {
  const details = error && typeof error === "object" ? (error as { code?: string; status?: number }) : {};
  console.error(`[auth] ${action} failed`, details.code ?? "unknown", details.status ?? "");
}
