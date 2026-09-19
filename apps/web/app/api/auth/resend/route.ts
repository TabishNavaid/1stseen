import { hasSupabaseConfig } from "@/lib/config";
import { EMAIL_REQUEST_FLOOR_MS, EMAIL_REQUEST_STEP_MS, normalizeEmail, uniformDelay } from "@/lib/auth/policy";
import { appOrigin, detachedAuthClient, json, logBackgroundFailure, readJson, sameOrigin, sleep } from "@/lib/auth/route-helpers";

export const runtime = "nodejs";

/** Send the confirmation email again. Same uniform 202 on the same floor as sign-up, for the same reason. */
export async function POST(request: Request) {
  if (!hasSupabaseConfig()) return json({ error: "supabase_unavailable" }, 503);
  if (!sameOrigin(request)) return json({ error: "cross_origin" }, 403);
  const email = normalizeEmail((await readJson(request))?.email);
  if (!email) return json({ error: "invalid_email" }, 400);

  const startedAt = Date.now();
  try {
    const { error } = await detachedAuthClient().auth.resend({
      type: "signup",
      email,
      options: { emailRedirectTo: `${appOrigin(request)}/auth/confirm` },
    });
    if (error && error.code !== "over_email_send_rate_limit") logBackgroundFailure("resend", error);
  } catch (error) {
    logBackgroundFailure("resend", error);
  }
  await sleep(uniformDelay(startedAt, Date.now(), EMAIL_REQUEST_FLOOR_MS, EMAIL_REQUEST_STEP_MS));
  return json({ status: "check_email" }, 202);
}
