import { cookies } from "next/headers";
import { z } from "zod";
import { deleteAccount } from "@/lib/account/deletion";
import { confirmationMatches, deletedPagePath } from "@/lib/account/policy";
import { authCookieOptions } from "@/lib/auth/policy";
import { json, readJson, sameOrigin } from "@/lib/auth/route-helpers";
import { hasSupabaseConfig } from "@/lib/config";
import { hasServiceRoleConfig } from "@/lib/real-data";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * Delete the signed-in account, irreversibly. docs/account-data.md is the contract, and lib/account/deletion.ts
 * holds the order of the steps and what a failure at each leaves behind.
 *
 * Here because deleting the auth user is a Supabase Auth call, and those live only in app/api/auth/*. Like the other
 * auth routes it takes only same-origin requests. The account is the session's user and nothing else: the body is a
 * closed schema, so a `user_id` in it is refused rather than ignored. The typed confirmation is checked here as well
 * as in the dialog.
 *
 * The uniform-response floors in lib/auth/policy.ts guard routes that take an address and could reveal whether it has
 * an account. This one takes no address and acts only on the caller's own session, so it has no floor; its answers are
 * fixed codes and never carry Google's or Supabase's own messages.
 */

const bodySchema = z
  .object({
    confirmation: z.string().max(200),
    remove_synced_events: z.boolean().optional(),
  })
  .strict();

/** Session cookies (`sb-*`) and the short-lived OAuth state cookies (`firstseen_*`), which carry the user id. */
async function clearAccountCookies() {
  const store = await cookies();
  const options = authCookieOptions(process.env.NEXT_PUBLIC_APP_URL);
  for (const { name } of store.getAll()) {
    if (name.startsWith("sb-") || name.startsWith("firstseen_")) store.set(name, "", { ...options, maxAge: 0 });
  }
}

export async function POST(request: Request) {
  if (!hasSupabaseConfig()) return json({ error: "supabase_unavailable" }, 503);
  if (!sameOrigin(request)) return json({ error: "cross_origin" }, 403);
  const parsed = bodySchema.safeParse(await readJson(request));
  if (!parsed.success) return json({ error: "invalid_request" }, 400);
  if (!confirmationMatches(parsed.data.confirmation)) return json({ error: "confirmation_mismatch" }, 400);

  let userId: string | null = null;
  try {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    userId = data.user?.id ?? null;
  } catch {
    userId = null;
  }
  if (!userId) return json({ error: "unauthorized" }, 401);
  if (!hasServiceRoleConfig()) return json({ error: "account_deletion_unavailable" }, 503);

  let result: Awaited<ReturnType<typeof deleteAccount>>;
  try {
    result = await deleteAccount({ userId, removeSyncedEvents: parsed.data.remove_synced_events ?? false });
  } catch {
    // deleteAccount lets an error escape only before it has deleted any row (lib/account/deletion.ts).
    return json({ error: "deletion_failed" }, 500);
  }
  if (!result.ok) {
    const { status, error, eventsRemoved, googleRevoked } = result;
    return json({ error, ...(eventsRemoved ? { events_removed: eventsRemoved } : {}), ...(googleRevoked ? { google_revoked: true } : {}) }, status);
  }
  await clearAccountCookies();
  return json({ status: "deleted", redirect: deletedPagePath(result), ...(result.googleNotRevoked ? { google_revocation: "not_confirmed" } : {}) });
}
