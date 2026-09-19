/**
 * The redirect Worker (infra/redirect-worker): every secondary hostname answers 301 to the same path and query on the
 * primary origin, and never serves the app itself.
 */
import assert from "node:assert/strict";
import test from "node:test";
import worker, { PRIMARY_ORIGIN, redirectTarget } from "../../../infra/redirect-worker/worker.mjs";

test("a secondary hostname redirects permanently to the same path and query on the primary origin", async () => {
  for (const [from, to] of [
    ["https://www.1stseen.win/", `${PRIMARY_ORIGIN}/`],
    ["https://www.1stseen.win/roles/abc?page=2&sort=soonest", `${PRIMARY_ORIGIN}/roles/abc?page=2&sort=soonest`],
    ["https://firstseen.tabishnavaid.dev/auth/confirm#token_hash=x", `${PRIMARY_ORIGIN}/auth/confirm`],
    ["http://firstseen.tabishnavaid.dev/methodology", `${PRIMARY_ORIGIN}/methodology`],
  ]) {
    assert.equal(redirectTarget(from), to);
    const response = await worker.fetch(new Request(from, { method: "POST" }));
    assert.equal(response.status, 301);
    assert.equal(response.headers.get("location"), to);
  }
});

test("the primary origin is https and bare", () => {
  assert.match(PRIMARY_ORIGIN, /^https:\/\/[^/]+$/);
});
