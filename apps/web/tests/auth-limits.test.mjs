/**
 * Per-visitor limits on the routes that call Supabase Auth (cloudflare/auth-limits.ts).
 *
 * Supabase counts its auth limits per IP address, and every visitor reaches Supabase from this Worker, so one visitor
 * could otherwise spend the project's whole budget of sign-ins or verifications. These tests pin that each address is
 * counted on its own, that the two buckets are separate, that a refusal says how long to wait in the shape the sign-in
 * panel understands, and that a deployment without the limiter still lets people sign in.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTH_ATTEMPTS_PER_ADDRESS,
  AUTH_LIMITED_ROUTES,
  AUTH_LIMIT_PERIOD_SECONDS,
  AUTH_VERIFICATIONS_PER_ADDRESS,
  authLimitAllowance,
  authLimitResponse,
} from "../cloudflare/auth-limits.ts";
import { GuestQuestionLimiter, durableAuthLimits } from "../cloudflare/guest-limiter.ts";

function memoryNamespace(clock) {
  const stores = new Map();
  const objects = new Map();
  return {
    idFromName: (name) => name,
    get(name) {
      if (!objects.has(name)) {
        stores.set(name, stores.get(name) ?? new Map());
        const store = stores.get(name);
        objects.set(name, new GuestQuestionLimiter({
          storage: {
            async get(key) { return structuredClone(store.get(key)); },
            async put(key, value) { store.set(key, structuredClone(value)); },
          },
          blockConcurrencyWhile: (callback) => callback(),
        }, {}, clock));
      }
      return { fetch: (input, init) => objects.get(name).fetch(new Request(input, init)) };
    },
  };
}

const post = (path, ip) =>
  new Request(`https://1stseen.win${path}`, { method: "POST", headers: ip ? { "cf-connecting-ip": ip } : {} });

test("every route that reaches Supabase Auth's counted endpoints is named, in the right bucket", () => {
  assert.deepEqual(AUTH_LIMITED_ROUTES, {
    "/api/auth/sign-in": "attempt",
    "/api/auth/sign-up": "attempt",
    "/api/auth/forgot": "attempt",
    "/api/auth/resend": "attempt",
    "/api/auth/confirm": "verification",
    "/api/auth/recovery": "verification",
  });
  // Supabase allows 30 of each per address per five minutes; one visitor's share stays well inside that.
  assert.ok(AUTH_ATTEMPTS_PER_ADDRESS < 30 && AUTH_VERIFICATIONS_PER_ADDRESS < 30);
  assert.equal(AUTH_LIMIT_PERIOD_SECONDS, 300);
});

test("an address spends its own share, and the next address is unaffected", async () => {
  let now = 1_000_000;
  const limits = durableAuthLimits(memoryNamespace(() => now), AUTH_ATTEMPTS_PER_ADDRESS, AUTH_VERIFICATIONS_PER_ADDRESS, AUTH_LIMIT_PERIOD_SECONDS);
  const allowed = [];
  for (let i = 0; i < AUTH_ATTEMPTS_PER_ADDRESS + 1; i += 1) {
    allowed.push((await authLimitAllowance(post("/api/auth/sign-in", "203.0.113.5"), "attempt", limits)).allowed);
    now += 1_000;
  }
  assert.deepEqual(allowed.slice(0, AUTH_ATTEMPTS_PER_ADDRESS), Array(AUTH_ATTEMPTS_PER_ADDRESS).fill(true));
  assert.equal(allowed.at(-1), false, "the attempt past this address's share is refused");

  const other = await authLimitAllowance(post("/api/auth/sign-in", "198.51.100.9"), "attempt", limits);
  assert.equal(other.allowed, true, "another visitor is not refused for the first one's attempts");

  // The two buckets are separate, as they are at Supabase.
  const verify = await authLimitAllowance(post("/api/auth/confirm", "203.0.113.5"), "verification", limits);
  assert.equal(verify.allowed, true, "confirming a link is not spent by sign-in attempts");

  now += AUTH_LIMIT_PERIOD_SECONDS * 1000 + 1;
  assert.equal((await authLimitAllowance(post("/api/auth/sign-in", "203.0.113.5"), "attempt", limits)).allowed, true);
});

test("a refusal says to wait, in the shape the sign-in panel reads", async () => {
  let now = 5_000_000;
  const limits = durableAuthLimits(memoryNamespace(() => now), 1, 1, AUTH_LIMIT_PERIOD_SECONDS);
  await authLimitAllowance(post("/api/auth/sign-in", "203.0.113.7"), "attempt", limits);
  const refused = await authLimitAllowance(post("/api/auth/sign-in", "203.0.113.7"), "attempt", limits);
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterSeconds > 0 && refused.retryAfterSeconds <= AUTH_LIMIT_PERIOD_SECONDS);

  const response = authLimitResponse(refused);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), String(refused.retryAfterSeconds));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: "rate_limited" });
});

test("without a limiter, signing in still works: refusing everyone is worse than the risk", async () => {
  assert.deepEqual(await authLimitAllowance(post("/api/auth/sign-in", "203.0.113.5"), "attempt", {}), { allowed: true });
  // An address Cloudflare did not give is counted as one visitor, never allowed past the share.
  let now = 9_000_000;
  const limits = durableAuthLimits(memoryNamespace(() => now), 1, 1, AUTH_LIMIT_PERIOD_SECONDS);
  assert.equal((await authLimitAllowance(post("/api/auth/sign-in"), "attempt", limits)).allowed, true);
  assert.equal((await authLimitAllowance(post("/api/auth/sign-in"), "attempt", limits)).allowed, false);
});
