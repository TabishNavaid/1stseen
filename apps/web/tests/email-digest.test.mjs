import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildEmailDigest, renderDigestHtml } from "../lib/email-digests/digest.ts";
import { digestFixtureSource } from "../lib/email-digests/fixture.ts";

test("digest is deterministic and covers recruiting intelligence categories", async () => {
  const first = await buildEmailDigest(digestFixtureSource);
  const second = await buildEmailDigest(digestFixtureSource);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(new Set(first.items.map((item) => item.kind)), new Set([
    "opening_soon", "forecast_changed", "role_opened",
    "networking_deadline", "referral_deadline", "resume_deadline",
  ]));
  assert.ok(first.items.every((item) => item.forecastId || item.forecastChangeId || item.historicalOpeningEventId || item.readinessMilestoneId));
});

test("digest filters distant forecasts and deadlines without model inference", async () => {
  const digest = await buildEmailDigest({
    ...digestFixtureSource,
    forecasts: [{ ...digestFixtureSource.forecasts[0], windowStart: "2027-01-01", windowEnd: "2027-01-15" }],
    changes: [], openings: [],
    milestones: [{ ...digestFixtureSource.milestones[0], dueOn: "2026-10-01" }],
  });
  assert.equal(digest.items.length, 0);
  assert.match(digest.subject, /No new actions/);
});

test("rendered email preserves forecast caveat and escapes record text", async () => {
  const digest = await buildEmailDigest({
    ...digestFixtureSource,
    forecasts: [{ ...digestFixtureSource.forecasts[0], company: "<Northstar>" }],
    changes: [], openings: [], milestones: [],
  });
  const html = renderDigestHtml(digest);
  assert.match(html, /statistical predictions, not confirmed company dates/i);
  assert.match(html, /&lt;Northstar&gt;/);
  assert.doesNotMatch(html, /<Northstar>/);
});

test("send route gates delivery and blocks duplicate fingerprints", async () => {
  const source = await readFile(new URL("../app/api/digests/send/route.ts", import.meta.url), "utf8");
  assert.match(source, /sendEnabled/);
  assert.match(source, /digest_already_delivered/);
  assert.match(source, /digest_delivery_in_progress/);
  assert.match(source, /input_fingerprint/);
  assert.match(source, /status: "sending"/);
});
