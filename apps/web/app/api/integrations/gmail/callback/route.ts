import { cookies } from "next/headers";
import { authenticatedUser } from "@/lib/supabase/authenticated";
import { createAdminClient } from "@/lib/supabase/admin";
import { getEmailDigestConfig, hasGmailConfig } from "@/lib/email-digests/config";
import { encryptEmailToken } from "@/lib/email-digests/crypto";

export const runtime = "nodejs";

function done(request: Request, result: string) { return Response.redirect(new URL(`/digests?gmail=${encodeURIComponent(result)}`, request.url)); }

export async function GET(request: Request) {
  const auth = await authenticatedUser();
  if ("response" in auth) return auth.response;
  if (!hasGmailConfig()) return done(request, "unavailable");
  const params = new URL(request.url).searchParams;
  const store = await cookies();
  const state = store.get("firstseen_gmail_oauth_state")?.value;
  const verifier = store.get("firstseen_gmail_oauth_verifier")?.value;
  const expectedUserId = store.get("firstseen_gmail_oauth_user")?.value;
  store.delete("firstseen_gmail_oauth_state");
  store.delete("firstseen_gmail_oauth_verifier");
  store.delete("firstseen_gmail_oauth_user");
  if (params.get("error")) return done(request, "cancelled");
  if (
    !state
    || !verifier
    || expectedUserId !== auth.userId
    || state !== params.get("state")
    || !params.get("code")
  ) return done(request, "invalid_state");
  const config = getEmailDigestConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, code: params.get("code")!, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: config.redirectUri }),
  });
  if (!response.ok) return done(request, "token_exchange_failed");
  const token = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!token.access_token) return done(request, "token_exchange_failed");
  const profile = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${token.access_token}` } });
  if (!profile.ok) return done(request, "identity_failed");
  const identity = await profile.json() as { email?: string };
  if (!identity.email) return done(request, "identity_failed");
  const admin = createAdminClient();
  // bounded: one row; gmail_connections is keyed by user_id.
  const existing = await admin.from("gmail_connections").select("refresh_token_ciphertext").eq("user_id", auth.userId).maybeSingle();
  if (existing.error) return done(request, "storage_failed");
  const refresh = token.refresh_token
    ? await encryptEmailToken(token.refresh_token, auth.userId)
    : existing.data?.refresh_token_ciphertext;
  if (!refresh) return done(request, "offline_access_required");
  const saved = await admin.from("gmail_connections").upsert({
    user_id: auth.userId,
    google_account_email: identity.email,
    access_token_ciphertext: await encryptEmailToken(token.access_token, auth.userId),
    refresh_token_ciphertext: refresh,
    token_expires_at: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
    scopes: token.scope?.split(" ").filter(Boolean) ?? [],
    connected_at: new Date().toISOString(),
    last_error_code: null,
    last_error_at: null,
  }, { onConflict: "user_id" });
  return saved.error ? done(request, "storage_failed") : done(request, "connected");
}
