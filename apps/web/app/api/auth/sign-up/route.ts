import { hasSupabaseConfig } from "@/lib/config";
import { EMAIL_REQUEST_FLOOR_MS, EMAIL_REQUEST_STEP_MS, normalizeEmail, passwordProblems, uniformDelay } from "@/lib/auth/policy";
import { appOrigin, detachedAuthClient, json, logBackgroundFailure, readJson, sameOrigin, sleep } from "@/lib/auth/route-helpers";

export const runtime = "nodejs";

/**
 * Create an account. The answer is the same 202 whether the address is new, already
 * registered, or waiting for confirmation, and it always arrives on the same duration floor,
 * so neither the body nor the timing says which. Only the submitted input itself (a malformed
 * address or a password outside the policy) is rejected early, because that reveals nothing
 * about anyone else.
 */
export async function POST(request: Request) {
  if (!hasSupabaseConfig()) return json({ error: "supabase_unavailable" }, 503);
  if (!sameOrigin(request)) return json({ error: "cross_origin" }, 403);
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!email) return json({ error: "invalid_email" }, 400);
  const problems = passwordProblems(password);
  if (problems.length) return json({ error: "invalid_password", problems }, 400);

  const startedAt = Date.now();
  try {
    const { error } = await detachedAuthClient().auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${appOrigin(request)}/auth/confirm` },
    });
    if (error && error.code !== "user_already_exists" && error.code !== "over_email_send_rate_limit") {
      logBackgroundFailure("sign-up", error);
    }
  } catch (error) {
    logBackgroundFailure("sign-up", error);
  }
  await sleep(uniformDelay(startedAt, Date.now(), EMAIL_REQUEST_FLOOR_MS, EMAIL_REQUEST_STEP_MS));
  return json({ status: "check_email" }, 202);
}
