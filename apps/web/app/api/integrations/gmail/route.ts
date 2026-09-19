import { authenticatedUser } from "@/lib/supabase/authenticated";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptEmailToken } from "@/lib/email-digests/crypto";
import { getEmailDigestConfig, hasGmailConfig } from "@/lib/email-digests/config";
import { revokeGoogleToken } from "@/lib/google-revocation";

export const runtime = "nodejs";

export async function GET() {
  if (!hasGmailConfig()) return Response.json({ configured: false, connected: false, send_enabled: false });
  const auth = await authenticatedUser();
  if ("response" in auth) return auth.response;
  // bounded: one row; gmail_connections is keyed by user_id.
  const result = await createAdminClient().from("gmail_connections").select("google_account_email,connected_at,last_error_code").eq("user_id", auth.userId).maybeSingle();
  if (result.error) return Response.json({ error: "gmail_status_failed" }, { status: 500 });
  return Response.json({ configured: true, connected: Boolean(result.data), send_enabled: getEmailDigestConfig().sendEnabled, account_email: result.data?.google_account_email ?? null, connection_error: result.data?.last_error_code ?? null });
}

export async function DELETE() {
  const auth = await authenticatedUser();
  if ("response" in auth) return auth.response;
  if (!hasGmailConfig()) return new Response(null, { status: 204 });
  const admin = createAdminClient();
  // bounded: one row; gmail_connections is keyed by user_id.
  const connection = await admin.from("gmail_connections").select("refresh_token_ciphertext").eq("user_id", auth.userId).maybeSingle();
  if (connection.error) return Response.json({ error: "gmail_connection_read_failed" }, { status: 500 });
  if (connection.data) {
    try {
      await revokeGoogleToken(await decryptEmailToken(connection.data.refresh_token_ciphertext, auth.userId));
    } catch { /* Local credential deletion remains authoritative if revocation is temporarily unavailable. */ }
  }
  const deleted = await admin.from("gmail_connections").delete().eq("user_id", auth.userId);
  return deleted.error ? Response.json({ error: "gmail_disconnect_failed" }, { status: 500 }) : new Response(null, { status: 204 });
}
