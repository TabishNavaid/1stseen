import { hasSupabaseConfig } from "@/lib/config";
import { parseAuthFragment, publicLinkFailure } from "@/lib/auth/policy";
import { json, readJson, sameOrigin } from "@/lib/auth/route-helpers";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Verify an email confirmation token and sign the user in.
 *
 * POST only, with the token in the body: the email link carries it in the URL fragment, the
 * /auth/confirm page posts it here, and no URL that reaches a server or a log ever holds it.
 */
export async function POST(request: Request) {
  if (!hasSupabaseConfig()) return json({ error: "supabase_unavailable" }, 503);
  if (!sameOrigin(request)) return json({ error: "cross_origin" }, 403);
  const body = await readJson(request);
  const link = parseAuthFragment(
    new URLSearchParams({ token_hash: String(body?.token_hash ?? ""), type: String(body?.type ?? "") }).toString(),
    "email",
  );
  if (!link) return json({ error: "link_invalid" }, 400);

  try {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({ token_hash: link.tokenHash, type: "email" });
    if (error) return json({ error: publicLinkFailure(error.code) }, 400);
  } catch {
    return json({ error: "link_invalid" }, 400);
  }
  // A confirmed address is a new account, so it lands on the first run, which it can skip.
  return json({ status: "confirmed", redirect: "/welcome" });
}
