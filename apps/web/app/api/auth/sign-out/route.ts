import { hasSupabaseConfig } from "@/lib/config";
import { json, sameOrigin } from "@/lib/auth/route-helpers";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** End this browser's session and clear its cookies. */
export async function POST(request: Request) {
  if (!hasSupabaseConfig()) return json({ error: "supabase_unavailable" }, 503);
  if (!sameOrigin(request)) return json({ error: "cross_origin" }, 403);
  try {
    const supabase = await createClient();
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // The cookies are cleared by signOut before it contacts Supabase; a failed revocation
    // still leaves this browser signed out.
  }
  return json({ status: "signed_out", redirect: "/" });
}
