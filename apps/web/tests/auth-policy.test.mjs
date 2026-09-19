import assert from "node:assert/strict";
import test from "node:test";

import {
  EMAIL_REQUEST_FLOOR_MS,
  EMAIL_REQUEST_STEP_MS,
  SIGN_IN_FAILURE_FLOOR_MS,
  SIGN_IN_FAILURE_STEP_MS,
  authCookieOptions,
  failureDelay,
  normalizeEmail,
  parseAuthFragment,
  passwordProblems,
  publicLinkFailure,
  publicPasswordUpdateFailure,
  publicSignInFailure,
  safeReturnTo,
  uniformDelay,
  supabaseHandledLink,
} from "../lib/auth/policy.ts";

test("passwords need 8 characters and at most 72 bytes", () => {
  assert.deepEqual(passwordProblems("short"), ["too_short"]);
  assert.deepEqual(passwordProblems("12345678"), []);
  assert.deepEqual(passwordProblems("a".repeat(72)), []);
  assert.deepEqual(passwordProblems("a".repeat(73)), ["too_long"]);
  // Multi-byte characters count once toward the minimum and by bytes toward the maximum.
  assert.deepEqual(passwordProblems("ééééééé"), ["too_short"]);
  assert.deepEqual(passwordProblems("é".repeat(37)), ["too_long"]);
});

test("emails are normalized locally and implausible ones are rejected", () => {
  assert.equal(normalizeEmail("  Person@Example.COM "), "person@example.com");
  assert.equal(normalizeEmail("no-at-sign"), null);
  assert.equal(normalizeEmail("a@b"), null);
  assert.equal(normalizeEmail(`${"a".repeat(250)}@b.io`), null);
  assert.equal(normalizeEmail(42), null);
});

test("sign-in failures end on the floor, or on a step past it, whatever the backend took", () => {
  for (const elapsed of [0, 20, 117, 799, 800]) {
    assert.equal(elapsed + failureDelay(1_000, 1_000 + elapsed), SIGN_IN_FAILURE_FLOOR_MS, `elapsed ${elapsed}`);
  }
  assert.equal(900 + failureDelay(0, 900), SIGN_IN_FAILURE_FLOOR_MS + SIGN_IN_FAILURE_STEP_MS);
  assert.equal(1_300 + failureDelay(0, 1_300), SIGN_IN_FAILURE_FLOOR_MS + 2 * SIGN_IN_FAILURE_STEP_MS);
  assert.equal(failureDelay(5_000, 1_000), SIGN_IN_FAILURE_FLOOR_MS, "a clock going backwards never shortens the wait");
});

test("email requests end on their floor, whether Supabase refused an existing address in 66 ms or created one in 706 ms", () => {
  for (const elapsed of [0, 66, 706, 1_500]) {
    assert.equal(elapsed + uniformDelay(0, elapsed, EMAIL_REQUEST_FLOOR_MS, EMAIL_REQUEST_STEP_MS), EMAIL_REQUEST_FLOOR_MS, `elapsed ${elapsed}`);
  }
  assert.equal(1_600 + uniformDelay(0, 1_600, EMAIL_REQUEST_FLOOR_MS, EMAIL_REQUEST_STEP_MS), EMAIL_REQUEST_FLOOR_MS + EMAIL_REQUEST_STEP_MS);
});

test("Supabase errors map to public outcomes that never distinguish an unknown address", () => {
  // A wrong password and an unknown address are the same public failure.
  assert.equal(publicSignInFailure("invalid_credentials", 400), "invalid_credentials");
  assert.equal(publicSignInFailure("user_not_found", 400), "invalid_credentials");
  assert.equal(publicSignInFailure(undefined, 400), "invalid_credentials");
  assert.equal(publicSignInFailure("email_not_confirmed", 400), "email_not_confirmed");
  assert.equal(publicSignInFailure("over_request_rate_limit", 429), "rate_limited");
  assert.equal(publicSignInFailure(undefined, 500), "sign_in_failed");

  // Supabase uses otp_expired for expired, already used, and unknown tokens alike.
  assert.equal(publicLinkFailure("otp_expired"), "link_unusable");
  assert.equal(publicLinkFailure(undefined), "link_unusable");
  assert.equal(publicLinkFailure("validation_failed"), "link_invalid");

  assert.equal(publicPasswordUpdateFailure("same_password", 422), "same_password");
  assert.equal(publicPasswordUpdateFailure("weak_password", 422), "weak_password");
  assert.equal(publicPasswordUpdateFailure("session_not_found", 403), "reset_session_expired");
  assert.equal(publicPasswordUpdateFailure(undefined, 401), "reset_session_expired");
  assert.equal(publicPasswordUpdateFailure(undefined, 500), "update_failed");
});

test("email link tokens are read from the fragment, and only for the expected link type", () => {
  const token = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8";
  assert.deepEqual(parseAuthFragment(`#token_hash=${token}&type=email`, "email"), { tokenHash: token, type: "email" });
  assert.deepEqual(parseAuthFragment(`#token_hash=${token}&type=signup`, "email"), { tokenHash: token, type: "email" });
  assert.deepEqual(parseAuthFragment(`token_hash=${token}&type=recovery`, "recovery"), { tokenHash: token, type: "recovery" });
  assert.equal(parseAuthFragment(`#token_hash=${token}&type=recovery`, "email"), null, "a recovery link cannot confirm");
  assert.equal(parseAuthFragment(`#token_hash=${token}&type=email`, "recovery"), null, "a confirmation link cannot reset");
  assert.equal(parseAuthFragment("#type=email", "email"), null);
  assert.equal(parseAuthFragment("#token_hash=<script>&type=email", "email"), null);
  assert.equal(parseAuthFragment("", "email"), null);
});

test("a link Supabase verified itself (its default template) is told apart from a broken one", () => {
  // The redirect after Supabase's own /verify: a session in the fragment, or a PKCE code in the query.
  assert.equal(supabaseHandledLink("#access_token=x&expires_in=3600&refresh_token=y&token_type=bearer&type=signup", ""), "verified");
  assert.equal(supabaseHandledLink("", "?code=0b8c"), "verified");
  // An expired or reused default link comes back as an error.
  assert.equal(supabaseHandledLink("#error=access_denied&error_code=otp_expired&error_description=x", ""), "expired");
  assert.equal(supabaseHandledLink("", "?error=access_denied&error_code=otp_expired"), "expired");
  // Nothing recognisable: the page keeps calling the link incomplete.
  assert.equal(supabaseHandledLink("", ""), null);
  assert.equal(supabaseHandledLink("#type=email", ""), null);
});

test("session cookies are HttpOnly and SameSite=Lax, and Secure over HTTPS", () => {
  assert.deepEqual(authCookieOptions("https://1stseen.win"), { httpOnly: true, sameSite: "lax", secure: true, path: "/" });
  assert.deepEqual(authCookieOptions("http://localhost:3000"), { httpOnly: true, sameSite: "lax", secure: false, path: "/" });
  assert.equal(authCookieOptions(undefined).httpOnly, true);
});

test("return paths stay on this origin and never loop back into authentication", () => {
  assert.equal(safeReturnTo("/roles/abc?tab=evidence"), "/roles/abc?tab=evidence");
  assert.equal(safeReturnTo("/"), "/");
  for (const hostile of ["//evil.example", "https://evil.example", "/\\evil.example", "javascript:alert(1)", "/signin", "/auth/confirm", "/api/auth/sign-in", "", null, 7]) {
    assert.equal(safeReturnTo(hostile), "/", String(hostile));
  }
});
