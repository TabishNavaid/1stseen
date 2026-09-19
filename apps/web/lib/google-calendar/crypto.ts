import "server-only";

import { importTokenKey, openToken, sealToken } from "@/lib/oauth-token-crypto";
import { getGoogleCalendarConfig } from "./config";

const PROVIDER = "google-calendar";

function key() {
  return importTokenKey(getGoogleCalendarConfig().tokenEncryptionKey, "invalid_google_token_encryption_key");
}

export async function encryptToken(value: string, userId: string) {
  return sealToken(await key(), PROVIDER, userId, value);
}

export async function decryptToken(value: string, userId: string) {
  return openToken(await key(), PROVIDER, userId, value, "invalid_encrypted_token");
}
