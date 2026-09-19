import { z } from "zod";
import { forecastReplayResultSchema } from "@firstseen/shared";
import { agentCaller, unauthenticatedDevAllowed } from "@/lib/agent-auth";

const requestSchema = z.object({
  role_id: z.string().uuid(),
  target_year: z.number().int().min(1900).max(2200),
  forecast_cutoff: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export async function POST(request: Request) {
  // Requires a Supabase session. ALLOW_UNAUTHENTICATED_AGENT_DEV === "true" is the
  // only bypass and is refused in production.
  const user = await agentCaller();
  const allowUnauthenticatedDev = unauthenticatedDevAllowed();
  if (!user && !allowUnauthenticatedDev) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const apiUrl = process.env.FIRSTSEEN_AGENT_API_URL;
  const token = process.env.AGENT_API_BEARER_TOKEN;
  if (!apiUrl || !token) {
    return Response.json({ error: "replay_api_unavailable" }, { status: 503 });
  }
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid_replay_request" }, { status: 400 });
  }
  let upstream: Response;
  try {
    upstream = await fetch(new URL("/v1/forecast-replay", apiUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(parsed.data),
      cache: "no-store",
    });
  } catch {
    // Configured but not answering: an honest 502, distinct from the 503 for "not configured".
    return Response.json({ error: "replay_api_unreachable" }, { status: 502 });
  }
  const payload: unknown = await upstream.json().catch(() => ({ error: "invalid_replay_response" }));
  if (!upstream.ok) return Response.json(payload, { status: upstream.status });
  const validated = forecastReplayResultSchema.safeParse(payload);
  if (!validated.success) return Response.json({ error: "invalid_replay_response" }, { status: 502 });
  return Response.json(validated.data);
}
