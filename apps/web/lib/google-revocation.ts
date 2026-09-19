/**
 * Revoking a Google OAuth token: the one call the Google Calendar and Gmail disconnects and account deletion share.
 *
 * Google's revoke endpoint answers 200 when it revoked the token, and 400 with `invalid_token` when the token was
 * already expired or revoked. Either way nobody can use it again. A failed request, a timeout, 408, 429, or a 5xx is
 * "unreachable": Google did not say, and trying later may work. Any other answer is "refused": Google answered and
 * did not confirm, and repeating the same request will not change that.
 *
 * Revoking a refresh token revokes the whole grant, including its access tokens, so one call per connection is
 * enough.
 *
 * Pure: the fetch is injected, so tests/google-revocation.test.mjs never contacts Google.
 */

export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_REVOKE_TIMEOUT_MS = 10_000;

export type RevocationOutcome = "revoked" | "already_invalid" | "unreachable" | "refused";

export async function revokeGoogleToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = GOOGLE_REVOKE_TIMEOUT_MS,
): Promise<RevocationOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return "unreachable";
  }
  if (response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return "revoked";
  }
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    await response.body?.cancel().catch(() => undefined);
    return "unreachable";
  }
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return response.status === 400 && body?.error === "invalid_token" ? "already_invalid" : "refused";
}

/** Whether Google has confirmed that the token can no longer be used. */
export function revocationConfirmed(outcome: RevocationOutcome): boolean {
  return outcome === "revoked" || outcome === "already_invalid";
}
