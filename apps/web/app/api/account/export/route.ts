import type { User } from "@supabase/supabase-js";
import { buildAccountExport, type AccountExport } from "@/lib/account/data";
import { exportCredentialPath } from "@/lib/account/policy";
import { json, sameOrigin } from "@/lib/auth/route-helpers";
import { hasSupabaseConfig } from "@/lib/config";
import { hasServiceRoleConfig } from "@/lib/real-data";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Download everything the signed-in account holds, as one JSON file. docs/account-data.md lists what it contains.
 *
 * The account is the session's user and nothing else; the request carries no parameters. A cross-site request is
 * refused like the auth routes refuse one, so another site cannot make a visitor's browser fetch the file. The export is
 * checked for anything credential-shaped before it is sent, and never sent when the check finds one.
 */
export async function GET(request: Request) {
  if (!hasSupabaseConfig()) return json({ error: "supabase_unavailable" }, 503);
  if (!sameOrigin(request)) return json({ error: "cross_origin" }, 403);

  let user: User | null = null;
  try {
    const supabase = await createClient();
    user = (await supabase.auth.getUser()).data.user;
  } catch {
    user = null;
  }
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!hasServiceRoleConfig()) return json({ error: "account_export_unavailable" }, 503);

  let payload: AccountExport;
  try {
    payload = await buildAccountExport({
      id: user.id,
      email: user.email ?? null,
      created_at: user.created_at ?? null,
      email_confirmed_at: user.email_confirmed_at ?? null,
      last_sign_in_at: user.last_sign_in_at ?? null,
    });
  } catch {
    return json({ error: "account_export_failed" }, 500);
  }
  if (exportCredentialPath(payload)) {
    console.error("[account] an export was withheld because it contained a credential-shaped field");
    return json({ error: "account_export_failed" }, 500);
  }

  const day = payload.exported_at.slice(0, 10);
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="1stseen-account-${day}.json"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
