import { z } from "zod";
import { GUEST_AGENT_HEADER } from "@/cloudflare/guest-agent";
import { agentCaller } from "@/lib/agent-auth";
import { QUESTIONS_UNAVAILABLE_MESSAGE } from "@/lib/agent-availability";

const requestSchema = z.object({
  question: z.string().trim().min(3).max(2000),
  context_company: z.string().trim().min(1).max(300).optional(),
  context_role: z.string().trim().min(1).max(500).optional(),
  // The role page's own role, so a title shared by two programs still resolves to the one being viewed.
  context_role_id: z.string().uuid().optional(),
});

export async function POST(request: Request) {
  // A member is a Supabase session. A guest is a signed-out request that the Worker entry (cloudflare/index.ts) has
  // passed through the guest rate limits; only the entry sets this header, and it deletes any copy a client sends.
  const user = await agentCaller();
  const guest = !user && request.headers.get(GUEST_AGENT_HEADER) === "allowed";
  if (!user && !guest) {
    // A request carrying a session cookie that no longer verifies skips the guest limits, so it must sign in again.
    return Response.json({ error: "sign_in_required" }, { status: 401 });
  }
  const apiUrl = process.env.FIRSTSEEN_AGENT_API_URL;
  const token = process.env.AGENT_API_BEARER_TOKEN;
  if (!apiUrl || !token) {
    return Response.json({ error: "agent_api_unavailable" }, { status: 503 });
  }
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid_question" }, { status: 400 });
  }
  let upstream: Response;
  try {
    upstream = await fetch(new URL("/v1/recruiting/query", apiUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({
        ...parsed.data,
        // A session user id is a real profiles.id and scopes watchlist answers. A guest question carries no user at all,
        // and the agent service then answers without user-scoped tools or a readiness plan.
        ...(user && z.string().uuid().safeParse(user.userId).success
          ? { user_id: user.userId }
          : { audience: "guest" }),
      }),
      cache: "no-store",
    });
  } catch {
    // Configured but not answering. A paused service (the Cloud Run spend cap) looks like this or like the failure below;
    // either way the question cannot be asked now, through no fault of the visitor's, and the panel says so in words.
    return Response.json({ error: "agent_api_unreachable", message: QUESTIONS_UNAVAILABLE_MESSAGE }, { status: 503 });
  }
  if (!upstream.ok || !upstream.body) {
    return Response.json(
      { error: "agent_api_failed", upstream_status: upstream.status, message: QUESTIONS_UNAVAILABLE_MESSAGE },
      { status: 503 },
    );
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
