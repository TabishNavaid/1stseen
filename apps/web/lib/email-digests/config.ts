import "server-only";

import { z } from "zod";

const schema = z.object({
  clientId: z.string().min(10),
  clientSecret: z.string().min(10),
  redirectUri: z.string().url(),
  tokenEncryptionKey: z.string().min(43),
  sendEnabled: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  publicAppUrl: z.string().url(),
});

export function hasGmailConfig() {
  return Boolean(process.env.GMAIL_OAUTH_CLIENT_ID && process.env.GMAIL_OAUTH_CLIENT_SECRET && process.env.GMAIL_OAUTH_REDIRECT_URI && process.env.EMAIL_TOKEN_ENCRYPTION_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getEmailDigestConfig() {
  return schema.parse({
    clientId: process.env.GMAIL_OAUTH_CLIENT_ID,
    clientSecret: process.env.GMAIL_OAUTH_CLIENT_SECRET,
    redirectUri: process.env.GMAIL_OAUTH_REDIRECT_URI,
    tokenEncryptionKey: process.env.EMAIL_TOKEN_ENCRYPTION_KEY,
    sendEnabled: process.env.EMAIL_DIGEST_SEND_ENABLED ?? "false",
    publicAppUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
  });
}

export function getEmailDigestPublicUrl() {
  return z.string().url().parse(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000");
}
