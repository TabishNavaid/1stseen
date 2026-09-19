import { hasSupabaseConfig } from "@/lib/config";
import { parseAuthFragment, publicLinkFailure } from "@/lib/auth/policy";
import { json, readJson, sameOrigin } from "@/lib/auth/route-helpers";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Verify a password reset token, starting the short recovery session that may set a new password. POST only. */
export async function POST(request: Request) {
  if (!hasSupabaseConfig()) return json({ error: "supabase_unavailable" }, 503);
  if (!sameOrigin(request)) return json({ error: "cross_origin" }, 403);
  const body = await readJson(request);
  const link = parseAuthFragment(
    new URLSearchParams({ token_hash: String(body?.token_hash ?? ""), type: String(body?.type ?? "") }).toString(),
    "recovery",
  );
  if (!link) return json({ error: "link_invalid" }, 400);

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ token_hash: link.tokenHash, type: "recovery" });
    if (error) return json({ error: publicLinkFailure(error.code) }, 400);
  } catch {
    return json({ error: "link_invalid" }, 400);
  }
  return json({ status: "recovery_session" });
}
