import "server-only";

import { importTokenKey, openToken, sealToken } from "@/lib/oauth-token-crypto";
import { getEmailDigestConfig } from "./config";

const PROVIDER = "gmail";

function key() {
  return importTokenKey(getEmailDigestConfig().tokenEncryptionKey, "invalid_email_token_encryption_key");
}

export async function encryptEmailToken(value: string, userId: string) {
  return sealToken(await key(), PROVIDER, userId, value);
}

export async function decryptEmailToken(value: string, userId: string) {
  return openToken(await key(), PROVIDER, userId, value, "invalid_encrypted_email_token");
}
