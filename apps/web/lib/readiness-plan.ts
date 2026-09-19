import "server-only";

export type ReadinessPlanResult = { status: number; payload: unknown };

export function readinessApiConfigured(): boolean {
  return Boolean(process.env.FIRSTSEEN_AGENT_API_URL && process.env.AGENT_API_BEARER_TOKEN);
}

/**
 * Ask the worker to materialise the deterministic work-back plan for one followed role.
 *
 * The readiness policy lives in `readiness.py` and is never reimplemented here. The caller passes the user id from
 * its own verified session; the worker refuses when that user does not follow the role, so the id can never write
 * into someone else's plan. Not configured is a 503 and configured but not answering is a 502, so the two stay
 * distinguishable.
 */
export async function requestReadinessPlan(userId: string, roleId: string): Promise<ReadinessPlanResult> {
  const apiUrl = process.env.FIRSTSEEN_AGENT_API_URL;
  const token = process.env.AGENT_API_BEARER_TOKEN;
  if (!apiUrl || !token) return { status: 503, payload: { error: "readiness_api_unavailable" } };
  let upstream: Response;
  try {
    upstream = await fetch(new URL("/v1/readiness-plan", apiUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ role_id: roleId, user_id: userId }),
      cache: "no-store",
    });
  } catch {
    return { status: 502, payload: { error: "readiness_api_unreachable" } };
  }
  const payload: unknown = await upstream.json().catch(() => ({ error: "readiness_plan_failed" }));
  return { status: upstream.status, payload };
}
