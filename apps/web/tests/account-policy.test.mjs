/**
 * Account export and deletion rules that need no database: the confirmation phrase, what a failed deletion tells
 * the user, the landing page's notes, and the check that an export carries no credential. Every token is made up.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DELETE_CONFIRMATION_PHRASE,
  confirmationMatches,
  deletedPageNotes,
  deletedPagePath,
  deletionFailureMessage,
  exportCredentialPath,
} from "../lib/account/policy.ts";
import { importTokenKey, sealToken } from "../lib/oauth-token-crypto.ts";

const SYNTHETIC_TOKEN = "synthetic-refresh-token-not-a-google-credential";

test("the confirmation phrase is exact apart from case and surrounding space", () => {
  assert.equal(DELETE_CONFIRMATION_PHRASE, "delete my account");
  for (const typed of ["delete my account", "  Delete My Account ", "DELETE  MY\tACCOUNT"]) assert.equal(confirmationMatches(typed), true, typed);
  for (const typed of ["", "delete", "delete my acount", "delete my account now", "yes", null, undefined, 1, ["delete my account"]]) {
    assert.equal(confirmationMatches(typed), false, String(typed));
  }
});

test("a failed deletion never says the account was deleted, and says what already happened", () => {
  for (const error of ["invalid_request", "confirmation_mismatch", "unauthorized", "cross_origin", "supabase_unavailable", "account_deletion_unavailable", "deletion_failed"]) {
    const message = deletionFailureMessage({ error }, 400);
    assert.doesNotMatch(message, /account (?:was|has been) deleted/i, error);
    assert.match(message, /nothing was deleted|stopped before deleting anything|was not deleted/i, error);
  }
  // The one failure after data is gone says exactly that, and that the sign-in remains.
  assert.match(deletionFailureMessage({ error: "sign_in_not_deleted" }, 500), /Your data was deleted, but your sign-in account was not/);
  const partial = deletionFailureMessage({ error: "deletion_failed", events_removed: 3, google_revoked: true }, 500);
  assert.match(partial, /The 3 events 1stSeen added to your Google Calendar were already removed\./);
  assert.match(partial, /access to your Google account was already revoked/);
  assert.match(deletionFailureMessage({ error: "deletion_failed", events_removed: 1 }, 500), /The event 1stSeen added to your Google Calendar was already removed\./);
  // Google cannot stop a deletion, so no failure is Google's (lib/account/deletion.ts).
  for (const error of ["google_unreachable", "calendar_events_not_removed"]) {
    assert.match(deletionFailureMessage({ error }, 503), /could not delete your account\. Nothing was deleted/, `${error} is no longer a known failure`);
  }
  // An answer the dialog does not know is not dressed up as a known outcome.
  assert.match(deletionFailureMessage({ error: "something_else" }, 502), /Nothing was deleted/);
  assert.match(deletionFailureMessage(null, 401), /session has ended/);
});

test("the deleted page's notes are plain flags that round-trip, and nothing else", () => {
  assert.equal(deletedPagePath({ googleNotRevoked: false, eventsKept: false }), "/account/deleted");
  assert.equal(deletedPagePath({ googleNotRevoked: true, eventsKept: true }), "/account/deleted?google=not_revoked&events=kept");
  assert.equal(deletedPagePath({ googleNotRevoked: false, eventsKept: false, eventsNotRemoved: true }), "/account/deleted?events=not_removed");
  for (const flags of [
    { googleNotRevoked: true, eventsKept: false, eventsNotRemoved: false },
    { googleNotRevoked: false, eventsKept: true, eventsNotRemoved: false },
    { googleNotRevoked: true, eventsKept: false, eventsNotRemoved: true },
  ]) {
    const query = new URL(deletedPagePath(flags), "https://firstseen.invalid").searchParams;
    assert.deepEqual(deletedPageNotes(Object.fromEntries(query)), flags);
  }
  assert.deepEqual(deletedPageNotes({ google: "revoked", events: ["kept"] }), { googleNotRevoked: false, eventsKept: false, eventsNotRemoved: false });
});

test("an export with a credential-shaped field or a sealed token anywhere is caught", async () => {
  const key = await importTokenKey(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url"), "invalid_key");
  const sealed = await sealToken(key, "gmail", "00000000-0000-4000-8000-00000000000a", SYNTHETIC_TOKEN);
  const clean = {
    tables: {
      gmail_connections: [{ connected: true, google_account_email: "person@firstseen-test.invalid", scopes: ["https://www.googleapis.com/auth/gmail.send"] }],
      model_usage: [{ prompt_tokens: 120, completion_tokens: 40 }],
      agent_runs: [{ question: "When does the v2 program open?", stored_state: { goal: "tokens and secrets of the trade" } }],
    },
  };
  assert.equal(exportCredentialPath(clean), null);
  assert.equal(exportCredentialPath({ tables: { gmail_connections: [{ refresh_token_ciphertext: sealed }] } }), "$.tables.gmail_connections[0].refresh_token_ciphertext");
  assert.equal(exportCredentialPath({ a: [{ access_token: "x" }] }), "$.a[0].access_token");
  assert.equal(exportCredentialPath({ a: { token: "x" } }), "$.a.token");
  assert.equal(exportCredentialPath({ a: { client_secret: "x" } }), "$.a.client_secret");
  assert.equal(exportCredentialPath({ a: { code_verifier: "x" } }), "$.a.code_verifier");
  // A sealed token copied under an innocent name is still caught by its shape.
  assert.equal(exportCredentialPath({ notes: [sealed] }), "$.notes[0]");
});
