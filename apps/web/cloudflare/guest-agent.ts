/**
 * Limits on the agent for signed-out visitors.
 *
 * A guest question passes two Workers Rate Limiting bindings before the route sees it: one keyed by the client address,
 * and one shared by every guest, which bounds what guests together can cost the agent service. Both windows are the
 * binding's 60 seconds. The bindings count per Cloudflare location and settle eventually, so a burst across locations
 * can briefly exceed a limit; they are a cost and abuse bound, not an exact quota.
 *
 * A deployment without the bindings refuses guest questions rather than running them unlimited. A refusal says which
 * limit was hit and what to do, rather than degrading the answer.
 */

export const GUEST_AGENT_HEADER = "x-firstseen-guest-agent";
export const GUEST_QUESTIONS_PER_ADDRESS = 5;
export const GUEST_QUESTIONS_OVERALL = 10;
// A const assertion, so the literal survives into the wrangler config, where a period must be 10 or 60.
export const GUEST_LIMIT_PERIOD_SECONDS = 60 as const;

type RateLimit = { limit(options: { key: string }): Promise<{ success: boolean }> };

export type GuestAgentLimits = {
  GUEST_AGENT_ADDRESS_LIMIT?: RateLimit;
  GUEST_AGENT_OVERALL_LIMIT?: RateLimit;
};

export type GuestAgentDecision = { allowed: true } | { allowed: false; reason: "address" | "overall" | "unavailable" };

export async function guestAgentAllowance(request: Request, limits: GuestAgentLimits): Promise<GuestAgentDecision> {
  const address = limits.GUEST_AGENT_ADDRESS_LIMIT;
  const overall = limits.GUEST_AGENT_OVERALL_LIMIT;
  if (!address || !overall) return { allowed: false, reason: "unavailable" };
  // Cloudflare sets cf-connecting-ip at its edge and overwrites a client's copy.
  const client = request.headers.get("cf-connecting-ip") ?? "unknown";
  if (!(await address.limit({ key: `address:${client}` })).success) return { allowed: false, reason: "address" };
  if (!(await overall.limit({ key: "all-guests" })).success) return { allowed: false, reason: "overall" };
  return { allowed: true };
}

export function guestLimitResponse(decision: Exclude<GuestAgentDecision, { allowed: true }>): Response {
  const headers = { "cache-control": "no-store", "content-type": "application/json" };
  if (decision.reason === "unavailable") {
    return new Response(
      JSON.stringify({
        error: "guest_agent_unavailable",
        message: "Questions without an account are not enabled on this deployment. Create an account to ask the agent.",
      }),
      { status: 503, headers },
    );
  }
  const message = decision.reason === "address"
    ? `Without an account, one address can ask ${GUEST_QUESTIONS_PER_ADDRESS} questions a minute, and this one has. Wait a minute, or create an account; signed-in questions are not limited this way.`
    : `Guests have asked the ${GUEST_QUESTIONS_OVERALL} questions allowed across the site this minute. Wait a minute, or create an account; signed-in questions are not limited this way.`;
  return new Response(
    JSON.stringify({
      error: "guest_rate_limited",
      scope: decision.reason,
      limit: decision.reason === "address" ? GUEST_QUESTIONS_PER_ADDRESS : GUEST_QUESTIONS_OVERALL,
      period_seconds: GUEST_LIMIT_PERIOD_SECONDS,
      retry_after_seconds: GUEST_LIMIT_PERIOD_SECONDS,
      message,
    }),
    { status: 429, headers: { ...headers, "retry-after": String(GUEST_LIMIT_PERIOD_SECONDS) } },
  );
}
