/**
 * Per-visitor limits on the routes that call Supabase Auth.
 *
 * Supabase Auth's own limits are counted per IP address: 30 sign-ups and sign-ins and 30 verifications every five
 * minutes, per project. Our routes call Supabase from this Worker, so every visitor arrives at Supabase from a
 * Cloudflare address, and those buckets are shared by everyone at once: without a limit here, one visitor retrying a
 * password, or one script, could spend the project's whole budget and sign-ins would start failing for others.
 * (Supabase can count the real visitor instead, through its `Sb-Forwarded-For` header, but only for requests made with
 * a new-format secret key. This app's routes sign in as the visitor with the publishable key, so that is not open to
 * them; docs/operations.md records the trade and what the project's limits are set to.)
 *
 * Each address gets its own share, counted exactly by the same Durable Object as guest questions (guest-limiter.ts)
 * over Supabase's own five-minute window. The numbers are far above a person's use and far below the project's budget,
 * so one address can never exhaust it. There is deliberately no site-wide limit: it would let one attacker lock
 * everyone out of signing in.
 *
 * A deployment without the limiter (the Node test harness) allows these requests: unlike a guest question, which costs
 * a paid service, refusing to let anyone sign in is worse than the risk it would remove.
 */

export const AUTH_ATTEMPTS_PER_ADDRESS = 12;
export const AUTH_VERIFICATIONS_PER_ADDRESS = 12;
/** Supabase counts its auth limits over five minutes; ours count over the same window. */
export const AUTH_LIMIT_PERIOD_SECONDS = 300 as const;

/** The routes that reach Supabase Auth's IP-counted endpoints, and which of its two buckets each one spends. */
export const AUTH_LIMITED_ROUTES: Record<string, "attempt" | "verification"> = {
  "/api/auth/sign-in": "attempt",
  "/api/auth/sign-up": "attempt",
  "/api/auth/forgot": "attempt",
  "/api/auth/resend": "attempt",
  "/api/auth/confirm": "verification",
  "/api/auth/recovery": "verification",
};

export type AuthRateLimit = {
  limit(options: { key: string }): Promise<{ success: boolean; retryAfterSeconds?: number }>;
};

export type AuthLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Whether this address may make one more request of this kind. Without a limiter, every request is allowed. */
export async function authLimitAllowance(
  request: Request,
  kind: "attempt" | "verification",
  limits: { attempt?: AuthRateLimit; verification?: AuthRateLimit },
): Promise<AuthLimitDecision> {
  const limit = limits[kind];
  if (!limit) return { allowed: true };
  // Cloudflare sets cf-connecting-ip at its edge and overwrites a client's copy.
  const client = request.headers.get("cf-connecting-ip") ?? "unknown";
  const decision = await limit.limit({ key: `auth-${kind}:${client}` });
  return decision.success
    ? { allowed: true }
    : { allowed: false, retryAfterSeconds: decision.retryAfterSeconds ?? AUTH_LIMIT_PERIOD_SECONDS };
}

/**
 * What a refused request answers: the shape the auth routes answer with, so the panel says "Too many attempts from
 * this network" rather than a generic failure.
 */
export function authLimitResponse(decision: Exclude<AuthLimitDecision, { allowed: true }>): Response {
  return new Response(JSON.stringify({ error: "rate_limited" }), {
    status: 429,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      "retry-after": String(decision.retryAfterSeconds),
    },
  });
}
