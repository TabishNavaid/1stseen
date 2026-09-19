/**
 * The guest question limiter (cloudflare/guest-limiter.ts): an exact sliding window per key, counted in a Durable Object,
 * and the two guest limits built from it. The Workers Rate Limiting bindings it replaced refused almost nothing on the
 * production edge at 5 and 10 a minute; these tests pin the exact behaviour the Durable Object gives instead.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { GUEST_LIMIT_PERIOD_SECONDS, GUEST_QUESTIONS_OVERALL, GUEST_QUESTIONS_PER_ADDRESS, guestAgentAllowance } from "../cloudflare/guest-agent.ts";
import { GuestQuestionLimiter, durableGuestLimits, durableLimit, takeFromWindow } from "../cloudflare/guest-limiter.ts";

const MINUTE = 60_000;

function memoryState(store = new Map()) {
  return {
    store,
    storage: {
      async get(key) { return structuredClone(store.get(key)); },
      async put(key, value) { store.set(key, structuredClone(value)); },
    },
    blockConcurrencyWhile: (callback) => callback(),
  };
}

/** A namespace whose objects live in memory, one per name, sharing a clock; `stores` survive an object being rebuilt. */
function memoryNamespace(clock) {
  const objects = new Map();
  const stores = new Map();
  return {
    objects,
    idFromName: (name) => name,
    get(name) {
      if (!objects.has(name)) {
        stores.set(name, stores.get(name) ?? new Map());
        objects.set(name, new GuestQuestionLimiter(memoryState(stores.get(name)), {}, clock));
      }
      const object = objects.get(name);
      return { fetch: (input, init) => object.fetch(new Request(input, init)) };
    },
    evictAll() { objects.clear(); },
  };
}

const take = (limiter, limit = 5) =>
  limiter.fetch(new Request(`https://limiter/take?limit=${limit}&period_ms=${MINUTE}`, { method: "POST" })).then((r) => r.json());

test("the window allows the limit, refuses the next, and lets one in again when the oldest leaves the window", () => {
  let hits = [];
  const allowed = [];
  for (let second = 0; second < 5; second += 1) {
    const decision = takeFromWindow(hits, second * 1000, 5, MINUTE);
    allowed.push(decision.allowed);
    hits = decision.hits;
  }
  assert.deepEqual(allowed, [true, true, true, true, true]);
  const sixth = takeFromWindow(hits, 5_000, 5, MINUTE);
  assert.equal(sixth.allowed, false);
  assert.equal(sixth.retryAfterSeconds, 55, "the first question, asked at 0 s, leaves the window at 60 s");
  assert.equal(sixth.hits.length, 5, "a refused question is not recorded");
  assert.equal(takeFromWindow(hits, 59_999, 5, MINUTE).allowed, false, "a sliding window, not a fixed minute");
  assert.equal(takeFromWindow(hits, 60_001, 5, MINUTE).allowed, true);
});

test("one limiter object refuses the sixth question in a minute, keeps its count across a restart, and recovers", async () => {
  let now = 1_000_000;
  const state = memoryState();
  const limiter = new GuestQuestionLimiter(state, {}, () => now);
  const answers = [];
  for (let i = 0; i < 6; i += 1) {
    answers.push((await take(limiter)).allowed);
    now += 1_000;
  }
  assert.deepEqual(answers, [true, true, true, true, true, false]);

  const restarted = new GuestQuestionLimiter(memoryState(state.store), {}, () => now);
  const afterRestart = await take(restarted);
  assert.equal(afterRestart.allowed, false, "the count lives in storage, not only in memory");
  assert.ok(afterRestart.retry_after_seconds >= 1 && afterRestart.retry_after_seconds <= 60);

  now += MINUTE;
  assert.equal((await take(restarted)).allowed, true);
});

test("questions arriving together cannot share the last place", async () => {
  const limiter = new GuestQuestionLimiter(memoryState(), {}, () => 5_000_000);
  const answers = await Promise.all(Array.from({ length: 12 }, () => take(limiter)));
  assert.equal(answers.filter((answer) => answer.allowed).length, 5);
});

test("a limiter asked without a valid limit refuses the request, and an adapter treats any failure as a refusal", async () => {
  const limiter = new GuestQuestionLimiter(memoryState(), {});
  const response = await limiter.fetch(new Request("https://limiter/take?limit=0&period_ms=60000", { method: "POST" }));
  assert.equal(response.status, 400);

  const broken = { idFromName: (name) => name, get: () => ({ fetch: async () => new Response("error", { status: 500 }) }) };
  assert.deepEqual(await durableLimit(broken, 5, 60).limit({ key: "address:203.0.113.1" }), { success: false });
});

test("built from the Durable Object, the sixth question from one address and the eleventh from all guests are refused", async () => {
  let now = 9_000_000;
  const namespace = memoryNamespace(() => now);
  const limits = durableGuestLimits(namespace, GUEST_QUESTIONS_PER_ADDRESS, GUEST_QUESTIONS_OVERALL, GUEST_LIMIT_PERIOD_SECONDS);
  const ask = (ip) =>
    guestAgentAllowance(new Request("https://1stseen.test/api/recruiting-agent", { method: "POST", headers: { "cf-connecting-ip": ip } }), limits);

  const one = [];
  for (let i = 0; i < GUEST_QUESTIONS_PER_ADDRESS + 1; i += 1) one.push(await ask("198.51.100.7"));
  assert.deepEqual(one.slice(0, GUEST_QUESTIONS_PER_ADDRESS), Array(GUEST_QUESTIONS_PER_ADDRESS).fill({ allowed: true }));
  assert.deepEqual(one.at(-1), { allowed: false, reason: "address" });
  assert.ok(namespace.objects.has("address:198.51.100.7") && namespace.objects.has("all-guests"));

  // Five have been allowed site-wide; five more distinct addresses fill the shared limit, and the next is refused.
  for (let i = 1; i <= GUEST_QUESTIONS_OVERALL - GUEST_QUESTIONS_PER_ADDRESS; i += 1) {
    assert.deepEqual(await ask(`203.0.113.${i}`), { allowed: true });
  }
  assert.deepEqual(await ask("203.0.113.200"), { allowed: false, reason: "overall" });

  // Objects can be evicted between questions; the counts are in storage.
  namespace.evictAll();
  assert.deepEqual(await ask("198.51.100.7"), { allowed: false, reason: "address" });
  now += GUEST_LIMIT_PERIOD_SECONDS * 1000 + 1;
  assert.deepEqual(await ask("198.51.100.7"), { allowed: true });
});

test("the built Worker exports the limiter and its deploy config binds it, with no Rate Limiting bindings left", async () => {
  const config = JSON.parse(readFileSync(new URL("../dist/server/wrangler.json", import.meta.url), "utf8"));
  assert.deepEqual(config.durable_objects?.bindings, [{ name: "GUEST_QUESTION_LIMITER", class_name: "GuestQuestionLimiter" }]);
  assert.ok(config.migrations?.some((migration) => migration.new_sqlite_classes?.includes("GuestQuestionLimiter")));
  assert.equal(config.ratelimits?.length ?? 0, 0);
  const worker = await import(new URL(`../dist/server/index.js?limiter=${Date.now()}`, import.meta.url).href);
  assert.equal(typeof worker.GuestQuestionLimiter, "function");
});
