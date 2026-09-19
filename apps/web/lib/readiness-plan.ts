import "server-only";
import { PLAN_UNAVAILABLE_MESSAGE, isAgentVerdict } from "@/lib/agent-availability";

export type ReadinessPlanResult = { status: number; payload: unknown };

export function readinessApiConfigured(): boolean {
  return Boolean(process.env.FIRSTSEEN_AGENT_API_URL && process.env.AGENT_API_BEARER_TOKEN);
}

/**
 * Ask the worker to materialise the deterministic work-back plan for one followed role.
 *
 * The readiness policy lives in `readiness.py` and is never reimplemented here. The caller passes the user id from
 * its own verified session; the worker refuses when that user does not follow the role, so the id can never write
 * into someone else's plan. Not configured is a 503 with `readiness_api_unavailable`. A service that does not answer, or
 * answers with anything but its own verdict (a paused service, whose front end may answer with an error page), is a 503
 * with the sentence the plan button shows; its own verdicts (`role_not_followed`) are passed on as they are.
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
    return { status: 503, payload: { error: "readiness_api_unreachable", message: PLAN_UNAVAILABLE_MESSAGE } };
  }
  const payload: unknown = await upstream.json().catch(() => null);
  if (upstream.ok) return { status: upstream.status, payload: payload ?? { error: "readiness_plan_failed" } };
  if (isAgentVerdict(upstream.status, payload)) return { status: upstream.status, payload };
  return {
    status: 503,
    payload: { error: "readiness_api_failed", upstream_status: upstream.status, message: PLAN_UNAVAILABLE_MESSAGE },
  };
}
