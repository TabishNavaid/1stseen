import { hasSupabaseConfig } from "@/lib/config";
import { failureDelay, normalizeEmail, publicSignInFailure, safeReturnTo } from "@/lib/auth/policy";
import { json, readJson, sameOrigin, sleep } from "@/lib/auth/route-helpers";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Email and password sign-in. Sets the HttpOnly session cookies on success.
 *
 * Every failure shares one body per outcome and ends on the same duration floor, so an
 * unknown address answers exactly like a wrong password.
 */
export async function POST(request: Request) {
  if (!hasSupabaseConfig()) return json({ error: "supabase_unavailable" }, 503);
  if (!sameOrigin(request)) return json({ error: "cross_origin" }, 403);
  const startedAt = Date.now();
  const body = await readJson(request);
  const email = normalizeEmail(body?.email);
  const password = typeof body?.password === "string" ? body.password : "";

  const fail = async (error: string, status: number) => {
    await sleep(failureDelay(startedAt, Date.now()));
    return json({ error }, status);
  };
  if (!email || !password) return fail("invalid_credentials", 400);

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      const failure = publicSignInFailure(error.code, error.status);
      return fail(failure, failure === "rate_limited" ? 429 : failure === "sign_in_failed" ? 502 : 400);
    }
  } catch {
    return fail("sign_in_failed", 502);
  }
  return json({ status: "signed_in", redirect: safeReturnTo(body?.return_to) });
}
