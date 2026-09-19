import { hasSupabaseConfig } from "@/lib/config";
import { passwordProblems, publicPasswordUpdateFailure } from "@/lib/auth/policy";
import { json, readJson, sameOrigin } from "@/lib/auth/route-helpers";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Set a new password for the signed-in (usually recovery) session, then end every other session. */
export async function POST(request: Request) {
  if (!hasSupabaseConfig()) return json({ error: "supabase_unavailable" }, 503);
  if (!sameOrigin(request)) return json({ error: "cross_origin" }, 403);
  const body = await readJson(request);
  const password = typeof body?.password === "string" ? body.password : "";
  const problems = passwordProblems(password);
  if (problems.length) return json({ error: "invalid_password", problems }, 400);

  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    if (!data.user) return json({ error: "reset_session_expired" }, 401);
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      const failure = publicPasswordUpdateFailure(error.code, error.status);
      return json({ error: failure }, failure === "reset_session_expired" ? 401 : 400);
    }
    // Anyone still holding an old session loses it once the password changes.
    await supabase.auth.signOut({ scope: "others" });
  } catch {
    return json({ error: "update_failed" }, 502);
  }
  return json({ status: "password_updated", redirect: "/" });
}
