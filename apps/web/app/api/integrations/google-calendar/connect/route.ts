import { cookies } from "next/headers";
import { authenticatedUser } from "@/lib/google-calendar/auth";
import { getGoogleCalendarConfig, hasGoogleCalendarConfig } from "@/lib/google-calendar/config";

export const runtime = "nodejs";

function randomValue(bytes = 32) {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

async function challenge(verifier: string) {
  const value = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return Buffer.from(value).toString("base64url");
}

export async function GET() {
  const auth = await authenticatedUser();
  if ("response" in auth) return auth.response;
  if (!hasGoogleCalendarConfig()) {
    return Response.json({ error: "google_calendar_unavailable" }, { status: 503 });
  }
  const config = getGoogleCalendarConfig();
  const state = randomValue();
  const verifier = randomValue(48);
  const cookieStore = await cookies();
  const options = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600 };
  cookieStore.set("firstseen_google_oauth_state", state, options);
  cookieStore.set("firstseen_google_oauth_verifier", verifier, options);
  cookieStore.set("firstseen_google_oauth_user", auth.userId, options);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.events",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
    code_challenge: await challenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return Response.redirect(url);
}
