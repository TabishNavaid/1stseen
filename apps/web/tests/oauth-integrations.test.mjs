/**
 * UNIT TESTS WITH SYNTHETIC TOKENS AND KEYS.
 *
 * These exercise the real token-encryption and calendar-event-identity code that the
 * Google Calendar and Gmail integrations ship. They never contact Google, and they are
 * not evidence that either OAuth integration works end to end: that needs a real OAuth
 * client and is covered by docs/oauth-manual-test-plan.md. Every token below is a
 * made-up string.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { importTokenKey, openToken, sealToken, tokenAssociatedData } from "../lib/oauth-token-crypto.ts";
import { deterministicGoogleEventId, mapSelectedEvent, sourceKindFor, syncSelectedEvent } from "../lib/google-calendar/events.ts";

const SYNTHETIC_REFRESH_TOKEN = "synthetic-refresh-token-not-a-google-credential";
const USER_A = "00000000-0000-4000-8000-00000000000a";
const USER_B = "00000000-0000-4000-8000-00000000000b";

const randomKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

test("a sealed token round-trips for the provider and user it was written for", async () => {
  const key = await importTokenKey(randomKey(), "invalid_key");
  const sealed = await sealToken(key, "google-calendar", USER_A, SYNTHETIC_REFRESH_TOKEN);
  assert.match(sealed, /^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
  assert.ok(!sealed.includes(SYNTHETIC_REFRESH_TOKEN));
  assert.equal(await openToken(key, "google-calendar", USER_A, sealed, "invalid_token"), SYNTHETIC_REFRESH_TOKEN);
});

test("a token sealed for one user cannot be opened for another", async () => {
  const key = await importTokenKey(randomKey(), "invalid_key");
  const sealed = await sealToken(key, "gmail", USER_A, SYNTHETIC_REFRESH_TOKEN);
  await assert.rejects(openToken(key, "gmail", USER_B, sealed, "invalid_token"));
});

test("a token sealed for one provider cannot be opened as the other, even for the same user and key", async () => {
  const key = await importTokenKey(randomKey(), "invalid_key");
  const calendar = await sealToken(key, "google-calendar", USER_A, SYNTHETIC_REFRESH_TOKEN);
  await assert.rejects(openToken(key, "gmail", USER_A, calendar, "invalid_token"));
  const gmail = await sealToken(key, "gmail", USER_A, SYNTHETIC_REFRESH_TOKEN);
  await assert.rejects(openToken(key, "google-calendar", USER_A, gmail, "invalid_token"));
});

test("tampering, a different key, or a legacy format all fail closed", async () => {
  const key = await importTokenKey(randomKey(), "invalid_key");
  const other = await importTokenKey(randomKey(), "invalid_key");
  const sealed = await sealToken(key, "google-calendar", USER_A, SYNTHETIC_REFRESH_TOKEN);

  const [version, iv, body] = sealed.split(".");
  const bytes = Buffer.from(body, "base64url");
  bytes[0] ^= 0x01;
  await assert.rejects(openToken(key, "google-calendar", USER_A, `${version}.${iv}.${bytes.toString("base64url")}`, "invalid_token"));
  await assert.rejects(openToken(other, "google-calendar", USER_A, sealed, "invalid_token"));
  await assert.rejects(openToken(key, "google-calendar", USER_A, `v1.${iv}.${body}`, "invalid_token"), /invalid_token/);
  await assert.rejects(openToken(key, "google-calendar", USER_A, "not-a-sealed-token", "invalid_token"), /invalid_token/);
});

test("every seal uses a fresh IV, so equal tokens never produce equal ciphertexts", async () => {
  const key = await importTokenKey(randomKey(), "invalid_key");
  const first = await sealToken(key, "gmail", USER_A, SYNTHETIC_REFRESH_TOKEN);
  const second = await sealToken(key, "gmail", USER_A, SYNTHETIC_REFRESH_TOKEN);
  assert.notEqual(first, second);
});

test("a key that is not exactly 32 bytes is refused with the caller's error code", async () => {
  await assert.rejects(importTokenKey(Buffer.alloc(16).toString("base64url"), "invalid_google_token_encryption_key"), /invalid_google_token_encryption_key/);
  await assert.rejects(importTokenKey("", "invalid_email_token_encryption_key"), /invalid_email_token_encryption_key/);
});

test("tokens written by the pre-refactor wrappers still decrypt", async () => {
  // The previous implementation, inlined: AES-GCM, 12-byte IV, AAD `1stseen:<provider>:<user>`, `v2.` framing.
  const rawKey = randomKey();
  const legacyKey = await crypto.subtle.importKey("raw", Buffer.from(rawKey, "base64url"), "AES-GCM", false, ["encrypt"]);
  for (const provider of ["google-calendar", "gmail"]) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(`1stseen:${provider}:${USER_A}`) },
      legacyKey,
      new TextEncoder().encode(SYNTHETIC_REFRESH_TOKEN),
    );
    const legacy = `v2.${Buffer.from(iv).toString("base64url")}.${Buffer.from(encrypted).toString("base64url")}`;
    const key = await importTokenKey(rawKey, "invalid_key");
    assert.equal(await openToken(key, provider, USER_A, legacy, "invalid_token"), SYNTHETIC_REFRESH_TOKEN);
  }
  assert.deepEqual([...tokenAssociatedData("gmail", USER_A)], [...new TextEncoder().encode(`1stseen:gmail:${USER_A}`)]);
});

test("both provider wrappers bind their own provider name and keep their error codes", async () => {
  const calendar = await readFile(new URL("../lib/google-calendar/crypto.ts", import.meta.url), "utf8");
  const gmail = await readFile(new URL("../lib/email-digests/crypto.ts", import.meta.url), "utf8");
  assert.match(calendar, /const PROVIDER = "google-calendar";/);
  assert.match(calendar, /sealToken\(await key\(\), PROVIDER, userId, value\)/);
  assert.match(calendar, /invalid_google_token_encryption_key/);
  assert.match(gmail, /const PROVIDER = "gmail";/);
  assert.match(gmail, /sealToken\(await key\(\), PROVIDER, userId, value\)/);
  assert.match(gmail, /invalid_email_token_encryption_key/);
});

test("Google event ids are deterministic per user, source kind, and source key, and valid for Google", async () => {
  const id = await deterministicGoogleEventId(USER_A, "readiness_milestone", "role-1:networking");
  assert.equal(id, await deterministicGoogleEventId(USER_A, "readiness_milestone", "role-1:networking"));
  assert.notEqual(id, await deterministicGoogleEventId(USER_B, "readiness_milestone", "role-1:networking"));
  assert.notEqual(id, await deterministicGoogleEventId(USER_A, "forecast_window", "role-1:networking"));
  assert.notEqual(id, await deterministicGoogleEventId(USER_A, "readiness_milestone", "role-2:networking"));
  // Google Calendar event ids: base32hex characters (0-9, a-v), 5 to 1024 long.
  assert.match(id, /^[0-9a-v]{5,1024}$/);
});

test("two users syncing the same selection never share an external event", async () => {
  const selection = {
    sourceKey: "synthetic-role:networking",
    eventType: "networking",
    date: "2026-10-01",
    company: "Synthetic Co",
    role: "Synthetic Intern",
    label: "Start networking",
    detail: "Synthetic milestone for a unit test.",
    roleUrl: "https://firstseen.invalid/roles/synthetic-role",
  };
  const inserted = [];
  const operationsFor = () => {
    const mappings = new Map();
    return {
      find: async (key, kind) => mappings.get(`${kind}:${key}`) ?? null,
      insert: async (event) => { inserted.push(event.id); },
      update: async () => { throw new Error("no update expected"); },
      save: async (mapping) => { mappings.set(`${mapping.sourceKind}:${mapping.sourceKey}`, mapping); },
    };
  };
  const first = await syncSelectedEvent(selection, USER_A, operationsFor());
  const second = await syncSelectedEvent(selection, USER_B, operationsFor());
  assert.notEqual(first.googleEventId, second.googleEventId);
  assert.equal(new Set(inserted).size, 2);
  assert.equal(sourceKindFor("networking"), "readiness_milestone");
  const event = await mapSelectedEvent(selection, USER_A);
  assert.equal(event.extendedProperties.private.firstseenSemantics, "readiness");
});
