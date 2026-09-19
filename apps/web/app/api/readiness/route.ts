import { z } from "zod";
import { readinessApiConfigured, requestReadinessPlan } from "@/lib/readiness-plan";
import { authenticatedUser } from "@/lib/supabase/authenticated";

export const runtime = "nodejs";

const requestSchema = z.object({ role_id: z.string().uuid() }).strict();

/**
 * Generate the deterministic work-back plan for a followed role.
 *
 * This route only proves the caller's identity and forwards it (lib/readiness-plan.ts); the worker refuses if the
 * user does not actually follow the role, so the user id can never be used to write into someone else's plan.
 */
export async function POST(request: Request) {
  const auth = await authenticatedUser();
  if ("response" in auth) return auth.response;
  if (!readinessApiConfigured()) {
    return Response.json({ error: "readiness_api_unavailable" }, { status: 503 });
  }
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "invalid_readiness_request" }, { status: 400 });
  }
  const result = await requestReadinessPlan(auth.userId, parsed.data.role_id);
  return Response.json(result.payload, { status: result.status });
}
