import { cookies } from "next/headers";
import { authenticatedUser } from "@/lib/supabase/authenticated";
import { getEmailDigestConfig, hasGmailConfig } from "@/lib/email-digests/config";

export const runtime = "nodejs";

function randomValue(bytes = 32) { return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url"); }
async function challenge(verifier: string) { return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).toString("base64url"); }

export async function GET() {
  const auth = await authenticatedUser();
  if ("response" in auth) return auth.response;
  if (!hasGmailConfig()) return Response.json({ error: "gmail_unavailable" }, { status: 503 });
  const config = getEmailDigestConfig();
  const state = randomValue();
  const verifier = randomValue(48);
  const store = await cookies();
  const options = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600 };
  store.set("firstseen_gmail_oauth_state", state, options);
  store.set("firstseen_gmail_oauth_verifier", verifier, options);
  store.set("firstseen_gmail_oauth_user", auth.userId, options);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid email https://www.googleapis.com/auth/gmail.send",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: "consent",
    state,
    code_challenge: await challenge(verifier),
    code_challenge_method: "S256",
  }).toString();
  return Response.redirect(url);
}
