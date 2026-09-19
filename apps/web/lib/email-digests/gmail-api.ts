import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { getEmailDigestConfig } from "./config";
import { decryptEmailToken, encryptEmailToken } from "./crypto";

type GmailConnection = {
  google_account_email: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  token_expires_at: string;
};

async function refresh(userId: string, connection: GmailConnection) {
  const config = getEmailDigestConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: await decryptEmailToken(connection.refresh_token_ciphertext, userId),
      grant_type: "refresh_token",
    }),
  });
  if (!response.ok) {
    const code = response.status === 400 ? "gmail_reauthorization_required" : "gmail_token_refresh_failed";
    await createAdminClient().from("gmail_connections").update({ last_error_code: code, last_error_at: new Date().toISOString() }).eq("user_id", userId);
    throw new Error(code);
  }
  const token = await response.json() as { access_token: string; expires_in?: number };
  await createAdminClient().from("gmail_connections").update({
    access_token_ciphertext: await encryptEmailToken(token.access_token, userId),
    token_expires_at: new Date(Date.now() + (token.expires_in ?? 3600) * 1000).toISOString(),
    last_error_code: null,
    last_error_at: null,
  }).eq("user_id", userId);
  return token.access_token;
}

export async function getGmailAccess(userId: string) {
  // bounded: one row; gmail_connections is keyed by user_id.
  const result = await createAdminClient().from("gmail_connections").select("google_account_email,access_token_ciphertext,refresh_token_ciphertext,token_expires_at").eq("user_id", userId).maybeSingle();
  if (result.error) throw new Error("gmail_connection_read_failed");
  if (!result.data) throw new Error("gmail_not_connected");
  const connection = result.data as GmailConnection;
  const accessToken = new Date(connection.token_expires_at).getTime() <= Date.now() + 60_000
    ? await refresh(userId, connection)
    : await decryptEmailToken(connection.access_token_ciphertext, userId);
  return { accessToken, email: connection.google_account_email };
}

export async function sendGmailMessage(accessToken: string, recipient: string, subject: string, html: string) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject).toString("base64")}?=`;
  const message = [
    `To: ${recipient}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
  ].join("\r\n");
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: Buffer.from(message).toString("base64url") }),
  });
  if (!response.ok) throw new Error(response.status === 401 ? "gmail_reauthorization_required" : "gmail_send_failed");
  const result = await response.json() as { id?: string };
  if (!result.id) throw new Error("gmail_send_missing_message_id");
  return result.id;
}
