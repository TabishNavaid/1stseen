/**
 * Encryption for stored OAuth tokens (Google Calendar and Gmail).
 *
 * AES-256-GCM with a fresh 96-bit IV per token. The associated data is
 * `1stseen:<provider>:<userId>`, so a ciphertext only decrypts for the provider and
 * user it was written for: a Gmail token copied into a Calendar row, or one user's row
 * copied onto another's, fails authentication instead of yielding a usable token.
 *
 * Stored format: `v2.<iv base64url>.<ciphertext and tag base64url>`.
 *
 * Deliberately free of `server-only` and configuration imports so it can be tested
 * directly. The provider wrappers (`lib/google-calendar/crypto.ts`,
 * `lib/email-digests/crypto.ts`) read the key from server configuration and are the
 * only callers.
 */

export type OAuthTokenProvider = "google-calendar" | "gmail";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function tokenAssociatedData(provider: OAuthTokenProvider, userId: string): Uint8Array<ArrayBuffer> {
  return encoder.encode(`1stseen:${provider}:${userId}`);
}

/** Import a 32-byte base64url key, failing with the caller's own error code otherwise. */
export async function importTokenKey(base64UrlKey: string, invalidKeyCode: string): Promise<CryptoKey> {
  const raw = Buffer.from(base64UrlKey, "base64url");
  if (raw.byteLength !== 32) throw new Error(invalidKeyCode);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function sealToken(
  key: CryptoKey,
  provider: OAuthTokenProvider,
  userId: string,
  value: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: tokenAssociatedData(provider, userId) },
    key,
    encoder.encode(value),
  );
  return `v2.${Buffer.from(iv).toString("base64url")}.${Buffer.from(encrypted).toString("base64url")}`;
}

export async function openToken(
  key: CryptoKey,
  provider: OAuthTokenProvider,
  userId: string,
  sealed: string,
  invalidTokenCode: string,
): Promise<string> {
  const [version, iv, ciphertext] = sealed.split(".");
  if (version !== "v2" || !iv || !ciphertext) throw new Error(invalidTokenCode);
  const clear = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: new Uint8Array(Buffer.from(iv, "base64url")),
      additionalData: tokenAssociatedData(provider, userId),
    },
    key,
    new Uint8Array(Buffer.from(ciphertext, "base64url")),
  );
  return decoder.decode(clear);
}
