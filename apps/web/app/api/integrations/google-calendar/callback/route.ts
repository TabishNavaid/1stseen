import { cookies } from "next/headers";
import { authenticatedUser } from "@/lib/google-calendar/auth";
import { getGoogleCalendarConfig, hasGoogleCalendarConfig } from "@/lib/google-calendar/config";
import { encryptToken } from "@/lib/google-calendar/crypto";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

function calendarRedirect(request: Request, result: string) {
  return Response.redirect(new URL(`/calendar?google=${encodeURIComponent(result)}`, request.url));
}

export async function GET(request: Request) {
  const auth = await authenticatedUser();
  if ("response" in auth) return auth.response;
  if (!hasGoogleCalendarConfig()) return calendarRedirect(request, "unavailable");
  const params = new URL(request.url).searchParams;
  const cookieStore = await cookies();
  const expectedState = cookieStore.get("firstseen_google_oauth_state")?.value;
  const verifier = cookieStore.get("firstseen_google_oauth_verifier")?.value;
  const expectedUserId = cookieStore.get("firstseen_google_oauth_user")?.value;
  cookieStore.delete("firstseen_google_oauth_state");
  cookieStore.delete("firstseen_google_oauth_verifier");
  cookieStore.delete("firstseen_google_oauth_user");
  if (params.get("error")) return calendarRedirect(request, "cancelled");
  if (
    !expectedState
    || !verifier
    || expectedUserId !== auth.userId
    || params.get("state") !== expectedState
    || !params.get("code")
  ) {
    return calendarRedirect(request, "invalid_state");
  }
  const config = getGoogleCalendarConfig();
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: params.get("code")!,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    }),
  });
  if (!tokenResponse.ok) return calendarRedirect(request, "token_exchange_failed");
  const token = await tokenResponse.json() as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string };
  if (!token.access_token) return calendarRedirect(request, "token_exchange_failed");
  const admin = createAdminClient();
  // bounded: one row; google_calendar_connections is keyed by user_id.
  const existing = await admin.from("google_calendar_connections").select("refresh_token_ciphertext").eq("user_id", auth.userId).maybeSingle();
  if (existing.error) return calendarRedirect(request, "storage_failed");
  const refreshTokenCiphertext = token.refresh_token
    ? await encryptToken(token.refresh_token, auth.userId)
    : existing.data?.refresh_token_ciphertext;
  if (!refreshTokenCiphertext) return calendarRedirect(request, "offline_access_required");
  let accountLabel: string | null = null;
  const calendar = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (calendar.ok) {
    const data = await calendar.json() as { summary?: string };
    accountLabel = data.summary ?? null;
  }
  const saved = await admin.from("google_calendar_connections").upsert({
    user_id: auth.userId,
    calendar_id: "primary",
    google_account_label: accountLabel,
    access_token_ciphertext: await encryptToken(token.access_token, auth.userId),
    refresh_token_ciphertext: refreshTokenCiphertext,
    token_expires_at: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
    scopes: token.scope?.split(" ").filter(Boolean) ?? ["https://www.googleapis.com/auth/calendar.events"],
    connected_at: new Date().toISOString(),
    last_error_code: null,
    last_error_at: null,
  }, { onConflict: "user_id" });
  return saved.error ? calendarRedirect(request, "storage_failed") : calendarRedirect(request, "connected");
}
