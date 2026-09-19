/**
 * The one Google revocation call (lib/google-revocation.ts), shared by the Google Calendar and Gmail disconnects and by
 * account deletion, against a stub fetch. Nothing here contacts Google: the token is a made-up string.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { GOOGLE_REVOKE_URL, revocationConfirmed, revokeGoogleToken } from "../lib/google-revocation.ts";

const SYNTHETIC_TOKEN = "synthetic-refresh-token-not-a-google-credential";

function stubFetch(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: String(init?.body ?? ""), contentType: init?.headers?.["Content-Type"] });
    return respond(init);
  };
  return { calls, fetchImpl };
}

test("revocation posts the token to Google's endpoint and reads Google's answer", async () => {
  const cases = [
    [() => new Response("", { status: 200 }), "revoked"],
    [() => Response.json({ error: "invalid_token", error_description: "Token expired or revoked" }, { status: 400 }), "already_invalid"],
    [() => Response.json({ error: "invalid_request" }, { status: 400 }), "refused"],
    [() => new Response("forbidden", { status: 403 }), "refused"],
    [() => new Response("", { status: 408 }), "unreachable"],
    [() => new Response("", { status: 429 }), "unreachable"],
    [() => new Response("", { status: 503 }), "unreachable"],
    [() => { throw new TypeError("fetch failed"); }, "unreachable"],
  ];
  for (const [respond, expected] of cases) {
    const { calls, fetchImpl } = stubFetch(respond);
    assert.equal(await revokeGoogleToken(SYNTHETIC_TOKEN, fetchImpl), expected);
    assert.equal(calls.length, 1, "one request per token, never a retry");
    assert.equal(calls[0].url, GOOGLE_REVOKE_URL);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].contentType, "application/x-www-form-urlencoded");
    assert.equal(new URLSearchParams(calls[0].body).get("token"), SYNTHETIC_TOKEN);
  }
  assert.equal(revocationConfirmed("revoked"), true);
  assert.equal(revocationConfirmed("already_invalid"), true);
  assert.equal(revocationConfirmed("unreachable"), false);
  assert.equal(revocationConfirmed("refused"), false);
});

test("a revocation Google does not answer in time is unreachable, not confirmed", async () => {
  const { fetchImpl } = stubFetch((init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  }));
  // AbortSignal.timeout's timer does not hold Node's event loop open; this one does, until the answer is in.
  const keepAlive = setTimeout(() => {}, 5_000);
  const started = performance.now();
  try {
    assert.equal(await revokeGoogleToken(SYNTHETIC_TOKEN, fetchImpl, 50), "unreachable");
  } finally {
    clearTimeout(keepAlive);
  }
  assert.ok(performance.now() - started < 2_000);
});
