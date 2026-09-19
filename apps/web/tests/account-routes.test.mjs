/**
 * Account export and deletion routes against the built Worker, without a database.
 *
 * Every request here is refused before a row could be read or an account touched: cross-origin, malformed, wrongly
 * confirmed, or without a session. The signed-in paths (the export's contents, a refusal that changes nothing,
 * Google unreachable, and a deletion that leaves no row behind) run against the local rig in
 * tests/integration/account-deletion.test.mjs.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import "./support/retain-request-clones.mjs";

async function worker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

async function call(pathname, { method = "POST", body, headers = {} } = {}) {
  const { fetch } = await worker();
  return fetch(
    new Request(`http://localhost${pathname}`, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");
const code = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** The build inlines NEXT_PUBLIC_SUPABASE_*; without them both routes honestly answer 503. */
async function accountsConfigured() {
  const response = await call("/api/auth/delete-account", { body: {} });
  return response.status !== 503;
}

const DELETE = "/api/auth/delete-account";
const EXPORT = "/api/account/export";
const CONFIRMED = { confirmation: "delete my account" };

test("deletion refuses a cross-origin request before reading anything", async (t) => {
  if (!(await accountsConfigured())) return t.skip("build has no NEXT_PUBLIC_SUPABASE_* configuration; routes answer 503");
  for (const headers of [{ origin: "https://attacker.example" }, { "sec-fetch-site": "cross-site" }, { origin: "not a url" }]) {
    const response = await call(DELETE, { body: CONFIRMED, headers });
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.deepEqual(await response.json(), { error: "cross_origin" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("deletion refuses a missing, malformed, or wrong confirmation, and any owner in the body", async (t) => {
  if (!(await accountsConfigured())) return t.skip("build has no NEXT_PUBLIC_SUPABASE_* configuration; routes answer 503");
  const cases = [
    [undefined, "invalid_request"],
    ["{not json", "invalid_request"],
    [{}, "invalid_request"],
    [{ confirmation: 1 }, "invalid_request"],
    [{ confirmation: "delete my account", user_id: "00000000-0000-4000-8000-00000000000b" }, "invalid_request"],
    [{ confirmation: "delete my account", remove_synced_events: "yes" }, "invalid_request"],
    [{ confirmation: "" }, "confirmation_mismatch"],
    [{ confirmation: "delete" }, "confirmation_mismatch"],
    [{ confirmation: "delete my acount" }, "confirmation_mismatch"],
  ];
  for (const [body, error] of cases) {
    const response = await call(DELETE, { body });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.deepEqual(await response.json(), { error }, JSON.stringify(body));
  }
});

test("a confirmed deletion without a session is refused", async (t) => {
  if (!(await accountsConfigured())) return t.skip("build has no NEXT_PUBLIC_SUPABASE_* configuration; routes answer 503");
  for (const headers of [{}, { cookie: "sb-127-auth-token=%7B%22not%22%3A%22a%20session%22%7D" }, { origin: "http://localhost", "sec-fetch-site": "same-origin" }]) {
    const response = await call(DELETE, { body: { ...CONFIRMED, remove_synced_events: true }, headers });
    assert.equal(response.status, 401, JSON.stringify(headers));
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  }
  const get = await call(DELETE, { method: "GET" });
  assert.ok([404, 405].includes(get.status), `GET answered ${get.status}`);
});

test("the export needs a session, refuses a cross-site fetch, and takes no owner from the request", async (t) => {
  if (!(await accountsConfigured())) return t.skip("build has no NEXT_PUBLIC_SUPABASE_* configuration; routes answer 503");
  for (const path of [EXPORT, `${EXPORT}?user_id=00000000-0000-4000-8000-00000000000b`]) {
    const response = await call(path, { method: "GET" });
    assert.equal(response.status, 401, path);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const crossSite = await call(EXPORT, { method: "GET", headers: { "sec-fetch-site": "cross-site" } });
  assert.equal(crossSite.status, 403);
  assert.deepEqual(await crossSite.json(), { error: "cross_origin" });
});

test("both routes take the account from the Supabase session and never from the request", async () => {
  const deletion = code(await read("../app/api/auth/delete-account/route.ts"));
  assert.match(deletion, /if \(!sameOrigin\(request\)\) return json\(\{ error: "cross_origin" \}, 403\);/);
  assert.match(deletion, /\.strict\(\)/, "the body schema is closed, so a user_id in it is refused");
  assert.match(deletion, /if \(!confirmationMatches\(parsed\.data\.confirmation\)\)/);
  assert.match(deletion, /const \{ data \} = await supabase\.auth\.getUser\(\);\s*userId = data\.user\?\.id \?\? null;/);
  assert.match(deletion, /deleteAccount\(\{ userId, removeSyncedEvents:/);
  assert.doesNotMatch(deletion, /parsed\.data\.user_id|body\?\.user_id|searchParams/);

  const exporter = code(await read("../app/api/account/export/route.ts"));
  assert.match(exporter, /if \(!sameOrigin\(request\)\)/);
  assert.match(exporter, /user = \(await supabase\.auth\.getUser\(\)\)\.data\.user;/);
  assert.match(exporter, /buildAccountExport\(\{\s*id: user\.id,/);
  assert.match(exporter, /if \(exportCredentialPath\(payload\)\)/);
  assert.doesNotMatch(exporter, /searchParams|request\.json|user_id/);
});

test("the export selects named columns and never a credential", async () => {
  const data = code(await read("../lib/account/data.ts"));
  assert.doesNotMatch(data, /select\(\s*["'`]\*/, "no select *");
  assert.doesNotMatch(data, /ciphertext["',]/, "no ciphertext column is selected");
  assert.doesNotMatch(data, /token_expires_at|access_token|refresh_token/);
  // Every user-owned read is filtered to the session's id.
  assert.match(data, /\.eq\(owner, userId\)/);
  assert.match(data, /rpc\("account_agent_run_ids", \{ p_user_id: userId \}\)/);
});

test("Google revocation has one implementation, shared by both disconnects and account deletion", async () => {
  const revocation = await read("../lib/google-revocation.ts");
  assert.match(revocation, /export const GOOGLE_REVOKE_URL = "https:\/\/oauth2\.googleapis\.com\/revoke";/);
  for (const path of ["../app/api/integrations/google-calendar/route.ts", "../app/api/integrations/gmail/route.ts", "../lib/account/deletion.ts"]) {
    const source = await read(path);
    assert.match(source, /from "@\/lib\/google-revocation"/, path);
    assert.match(source, /revokeGoogleToken\(/, path);
    assert.doesNotMatch(source, /oauth2\.googleapis\.com\/revoke/, `${path} calls the endpoint itself`);
  }
  const deletion = code(await read("../lib/account/deletion.ts"));
  // Revocation is asked before any row is deleted, but nothing Google answers stops the deletion: deleting the data is
  // 1stSeen's to guarantee, revoking at Google is not. A token Google did not answer about is retried after the response.
  const body = deletion.slice(deletion.indexOf("export async function deleteAccount"));
  const revoke = body.indexOf("revokeGoogleToken(token)");
  const rows = body.indexOf('admin.rpc("delete_account_data"');
  const authUser = body.indexOf("authUserDeleted(admin, userId)");
  const finish = body.indexOf('admin.rpc("finish_account_deletion"');
  const retry = body.indexOf("after(retryRevocations(");
  assert.ok(revoke > 0 && revoke < rows && rows < authUser && authUser < finish && finish < retry, "ask Google, then rows, then the auth user, then the record, then retries");
  assert.doesNotMatch(deletion, /google_unreachable|calendar_events_not_removed/, "no Google outcome is a reason to keep the account");
  assert.doesNotMatch(body.slice(revoke, rows), /return \{ ok: false/, "nothing between asking Google and deleting the rows returns early");
});
