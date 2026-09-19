/**
 * Authentication policy shared by the auth routes, the session proxy, and the auth pages.
 *
 * Pure on purpose: no Supabase client and no `server-only` import, so the rules are
 * tested directly (tests/auth-policy.test.mjs).
 *
 * Account enumeration. Nothing the app returns for sign-up, resend, or a reset request may
 * depend on whether an address has an account: those routes validate input locally, wait
 * for Supabase, and answer one uniform 202 on a fixed duration floor. Sign-in failures share
 * one body and their own floor. (The calls are awaited, not deferred with `after()`: deferred
 * work overlapping later requests intermittently broke request handling under vinext.)
 * Supabase Auth's own public endpoint is outside this app's control;
 * docs/deployment.md lists the project settings that limit what it reveals.
 */

export const PASSWORD_MIN_LENGTH = 8;
/** bcrypt ignores bytes past 72, and Supabase Auth rejects longer passwords. */
export const PASSWORD_MAX_BYTES = 72;
export const EMAIL_MAX_LENGTH = 254;

/** Every sign-in failure takes at least this long, so an unknown address is not faster than a wrong password. */
export const SIGN_IN_FAILURE_FLOOR_MS = 800;
/** Failures past the floor are rounded up to this step, so a slow backend does not reintroduce a signal. */
export const SIGN_IN_FAILURE_STEP_MS = 400;
/**
 * Sign-up, resend, and reset requests take at least this long. Creating an account and
 * sending its email is the slowest honest path (about 0.7 s locally); an existing address
 * is refused in tens of milliseconds, so without the floor the difference would say which.
 */
export const EMAIL_REQUEST_FLOOR_MS = 1_500;
export const EMAIL_REQUEST_STEP_MS = 500;
/** The check-email panel lets a user resend once per this interval. */
export const RESEND_COOLDOWN_SECONDS = 60;

export type PasswordProblem = "too_short" | "too_long";

export function passwordProblems(password: string): PasswordProblem[] {
  const problems: PasswordProblem[] = [];
  if ([...password].length < PASSWORD_MIN_LENGTH) problems.push("too_short");
  if (new TextEncoder().encode(password).byteLength > PASSWORD_MAX_BYTES) problems.push("too_long");
  return problems;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Normalized address, or null when it is not a plausible email. Local, so it reveals nothing. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(email) ? email : null;
}

/**
 * Milliseconds still to wait so work that started at `startedAt` ends on `floorMs`, or on the
 * next `stepMs` boundary past it when the backend was slower than the floor.
 */
export function uniformDelay(startedAt: number, now: number, floorMs: number, stepMs: number): number {
  const elapsed = Math.max(0, now - startedAt);
  const target = elapsed <= floorMs ? floorMs : floorMs + Math.ceil((elapsed - floorMs) / stepMs) * stepMs;
  return target - elapsed;
}

/** The sign-in failure delay: `uniformDelay` with the sign-in floor and step. */
export function failureDelay(startedAt: number, now: number): number {
  return uniformDelay(startedAt, now, SIGN_IN_FAILURE_FLOOR_MS, SIGN_IN_FAILURE_STEP_MS);
}

export type SignInFailure = "invalid_credentials" | "email_not_confirmed" | "rate_limited" | "sign_in_failed";

/**
 * `email_not_confirmed` is only returned after Supabase has accepted the password, so it
 * reveals nothing to someone who does not already hold the credentials.
 */
export function publicSignInFailure(code: string | undefined, status: number | undefined): SignInFailure {
  if (code === "email_not_confirmed") return "email_not_confirmed";
  if (code === "over_request_rate_limit" || status === 429) return "rate_limited";
  if (code === "invalid_credentials" || code === "user_not_found" || code === "validation_failed" || status === 400) {
    return "invalid_credentials";
  }
  return "sign_in_failed";
}

/**
 * `link_invalid`: the link is malformed (rejected before Supabase is asked).
 * `link_unusable`: Supabase refused the token. It reports an expired, already used, and unknown
 * token with the same `otp_expired` code, so the app cannot honestly say which of the three.
 */
export type LinkFailure = "link_unusable" | "link_invalid";

export function publicLinkFailure(code: string | undefined): LinkFailure {
  return code === "validation_failed" ? "link_invalid" : "link_unusable";
}

export type PasswordUpdateFailure = "same_password" | "weak_password" | "reset_session_expired" | "update_failed";

export function publicPasswordUpdateFailure(code: string | undefined, status: number | undefined): PasswordUpdateFailure {
  if (code === "same_password") return "same_password";
  if (code === "weak_password") return "weak_password";
  if (code === "session_not_found" || code === "session_expired" || code === "refresh_token_not_found" || status === 401) {
    return "reset_session_expired";
  }
  return "update_failed";
}

export type AuthLinkType = "email" | "recovery";

/**
 * Email links carry their one-time token in the URL fragment, which browsers never send to a
 * server, so it cannot appear in a request log. The page reads it, clears it from history,
 * and posts it to the verification route. Only the expected link type is accepted.
 */
export function parseAuthFragment(hash: string, expected: AuthLinkType): { tokenHash: string; type: AuthLinkType } | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const tokenHash = params.get("token_hash");
  const type = params.get("type");
  const typeMatches = expected === "email" ? type === "email" || type === "signup" : type === "recovery";
  if (!tokenHash || !typeMatches || !/^[A-Za-z0-9_-]{16,256}$/.test(tokenHash)) return null;
  return { tokenHash, type: expected };
}

/**
 * What a page can say about a link it cannot verify itself: one Supabase already handled.
 *
 * With its default email templates, Supabase verifies the token on its own domain and redirects here with the result
 * instead of the token: a session in the fragment (`#access_token=…&type=signup`), a PKCE `?code=`, or an error
 * (`error_code=otp_expired`). Our templates send the token itself (`#token_hash=…`), which this app verifies. If the
 * hosted templates ever drift back to the defaults, a confirmation has still succeeded, and the page should say so
 * rather than call the link incomplete. The session in such a redirect is never used: it would have to leave the
 * fragment, and a confirmed account can simply sign in.
 */
export function supabaseHandledLink(hash: string, search: string): "verified" | "expired" | null {
  const fragment = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const query = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const errorCode = fragment.get("error_code") ?? query.get("error_code");
  if (errorCode || fragment.get("error") || query.get("error")) return "expired";
  if (fragment.get("access_token") || query.get("code")) return "verified";
  return null;
}

export type AuthCookieOptions = { httpOnly: true; sameSite: "lax"; secure: boolean; path: "/" };

/** Session cookies are never readable by page scripts; Secure whenever the app is served over HTTPS. */
export function authCookieOptions(appUrl: string | undefined): AuthCookieOptions {
  return { httpOnly: true, sameSite: "lax", secure: (appUrl ?? "").startsWith("https://"), path: "/" };
}

/** A same-origin path to land on after authenticating, never an auth page and never another origin. */
export function safeReturnTo(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  let url: URL;
  try {
    url = new URL(value, "https://firstseen.invalid");
  } catch {
    return "/";
  }
  if (url.origin !== "https://firstseen.invalid") return "/";
  if (url.pathname === "/signin" || url.pathname.startsWith("/auth/") || url.pathname.startsWith("/api/")) return "/";
  return `${url.pathname}${url.search}`;
}
