import { hasSupabaseConfig } from "@/lib/config";
import { parseAuthFragment, publicLinkFailure } from "@/lib/auth/policy";
import { json, readJson, sameOrigin } from "@/lib/auth/route-helpers";
import { loadOnboardingState } from "@/lib/onboarding-data";
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

  let userId: string | undefined;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: link.tokenHash, type: "email" });
    if (error) return json({ error: publicLinkFailure(error.code) }, 400);
    userId = data.user?.id;
  } catch {
    return json({ error: "link_invalid" }, 400);
  }
  // A confirmed address is usually a new account, so it lands on the first run, which it can skip; an account that
  // has already finished or skipped onboarding goes straight to its roles.
  return json({ status: "confirmed", redirect: (await onboardingDone(userId)) ? "/roles" : "/welcome" });
}

async function onboardingDone(userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  try {
    const state = await loadOnboardingState(userId);
    return state.completedAt !== null || state.skippedAt !== null;
  } catch {
    // The account is confirmed and signed in either way; the first run lets it skip.
    return false;
  }
}
