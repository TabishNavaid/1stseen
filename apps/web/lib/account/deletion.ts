import "server-only";

import { after } from "next/server";
import type { StoredRevocation, SyncedEventsOutcome } from "@/lib/account/policy";
import { decryptEmailToken } from "@/lib/email-digests/crypto";
import { decryptToken } from "@/lib/google-calendar/crypto";
import { deleteSyncedGoogleEvents } from "@/lib/google-calendar/google-api";
import { revokeGoogleToken, type RevocationOutcome } from "@/lib/google-revocation";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Deleting an account. Called only by POST /api/auth/delete-account, with the id of the session's user.
 *
 * Deleting the user's data is 1stSeen's to guarantee; revoking access at Google is not, because only Google can do it.
 * So nothing Google does, or fails to do, can stop a deletion. The order, and what a failure at each step leaves:
 *
 * 1. If the user chose to, remove the events 1stSeen synced into their Google Calendar. If Google Calendar fails, the
 *    deletion goes on; the events may still be there, and the landing page says so and how to remove them.
 * 2. Ask Google once to revoke every stored token (Calendar and Gmail). Google confirms with 200, or with 400
 *    `invalid_token` when the token was already dead. Whatever else happens (no answer, a timeout, 408, 429, 5xx, any
 *    other answer, or a token that no longer decrypts), the deletion goes on and the connection is recorded as not
 *    confirmed. The landing page then tells the user plainly to remove 1stSeen at myaccount.google.com.
 * 3. Delete every row the account owns except its profile, in one transaction (delete_account_data). A failure rolls
 *    all of it back: the account is not deleted, and the user is told what had already happened at Google.
 * 4. Delete the auth user with the Auth admin API. Its profile goes by cascade. If this fails, the account can still
 *    sign in but holds nothing, the user is told so, and repeating the request finishes it (steps 1 to 3 find nothing).
 *    If the call errs but the user is in fact gone, it counts as deleted.
 * 5. Remove what Supabase Auth leaves behind for the id (its PKCE flow state and audit log entries) and record, without
 *    personal data, that a deletion happened and what Google said (finish_account_deletion). The account is already
 *    gone, so a failure here is logged without the id and the user is still told the truth: the account is deleted.
 * 6. After the response, a token Google did not answer about is offered to Google again a few times
 *    (REVOCATION_RETRY_DELAYS_MS), from memory only: its row is gone and it is never written anywhere. A retry that
 *    Google confirms upgrades the anonymous record (record_late_google_revocation). The user has already been told to
 *    check their Google Account, because a retry may not run to completion and only Google can confirm it.
 *
 * So the user is never told the account is deleted unless the auth user is gone, is never told access was revoked
 * unless Google said so, and no Google token is left in the database once the account is.
 */

export type AccountDeletionResult =
  | { ok: true; googleNotRevoked: boolean; eventsKept: boolean; eventsNotRemoved: boolean }
  | { ok: false; status: number; error: "deletion_failed" | "sign_in_not_deleted"; eventsRemoved?: number; googleRevoked?: boolean };

type Provider = "google_calendar" | "gmail";

type RevocationAttempt = { provider: Provider; outcome: RevocationOutcome | "undecryptable"; token: string | null };

/** Waits before each background retry of a revocation Google did not answer. Kept inside Workers' 30 s after a response. */
export const REVOCATION_RETRY_DELAYS_MS = [1_000, 4_000, 10_000] as const;
const REVOCATION_RETRY_TIMEOUT_MS = 5_000;

export function storedRevocation(outcome: RevocationAttempt["outcome"] | undefined): StoredRevocation {
  if (outcome === undefined) return "not_connected";
  if (outcome === "revoked" || outcome === "already_invalid") return outcome;
  // Google did not answer: it may yet, so the token is retried. Anything else cannot succeed by repeating it.
  return outcome === "unreachable" ? "unconfirmed" : "not_revocable";
}

/**
 * Delete the auth user, and report whether it is gone. An error from the delete is not taken at its word: when the user
 * no longer exists (a repeated request, or an answer lost after the delete) it is gone. Anything uncertain is "not gone",
 * so the user is never told a live account was deleted.
 */
async function authUserDeleted(admin: ReturnType<typeof createAdminClient>, userId: string): Promise<boolean> {
  try {
    const removed = await admin.auth.admin.deleteUser(userId);
    if (!removed.error) return true;
    const check = await admin.auth.admin.getUserById(userId);
    return check.error ? check.error.status === 404 : !check.data.user;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Offer each unconfirmed token to Google again, after the response. The tokens live only in this closure. When Google
 * confirms, the anonymous deletion record says so; nothing identifies whose deletion it was.
 */
async function retryRevocations(pending: { provider: Provider; token: string }[], deletionId: string | null): Promise<void> {
  const admin = createAdminClient();
  let remaining = pending;
  for (const delay of REVOCATION_RETRY_DELAYS_MS) {
    if (!remaining.length) return;
    await sleep(delay);
    const outcomes = await Promise.all(
      remaining.map(async (item) => ({ ...item, outcome: await revokeGoogleToken(item.token, fetch, REVOCATION_RETRY_TIMEOUT_MS) })),
    );
    for (const { provider, outcome } of outcomes) {
      if (outcome === "unreachable" || !deletionId) continue;
      // bounded: a write that returns one boolean.
      const recorded = await admin.rpc("record_late_google_revocation", { p_deletion_id: deletionId, p_provider: provider, p_outcome: storedRevocation(outcome) });
      if (recorded.error) console.error("[account] a late Google revocation could not be recorded", recorded.error.code ?? "unknown");
    }
    remaining = outcomes.filter((item) => item.outcome === "unreachable").map(({ provider, token }) => ({ provider, token }));
  }
}

export async function deleteAccount({ userId, removeSyncedEvents }: { userId: string; removeSyncedEvents: boolean }): Promise<AccountDeletionResult> {
  const admin = createAdminClient();
  const [calendar, gmail, activeEvents, anyEvents] = await Promise.all([
    // bounded: one row; google_calendar_connections is keyed by user_id.
    admin.from("google_calendar_connections").select("refresh_token_ciphertext").eq("user_id", userId).maybeSingle(),
    // bounded: one row; gmail_connections is keyed by user_id.
    admin.from("gmail_connections").select("refresh_token_ciphertext").eq("user_id", userId).maybeSingle(),
    // bounded: head:true returns a count and no rows.
    admin.from("calendar_event_syncs").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("provider", "google").eq("status", "active"),
    // bounded: head:true returns a count and no rows.
    admin.from("calendar_event_syncs").select("id", { count: "exact", head: true }).eq("user_id", userId),
  ]);
  if (calendar.error || gmail.error || activeEvents.error || anyEvents.error) return { ok: false, status: 500, error: "deletion_failed" };

  // 1. Synced calendar events, only when the user asked and there is a connection to remove them with. A failure is
  // reported, never a reason to keep the account.
  let eventsRemoved = 0;
  let eventsNotRemoved = false;
  let syncedEvents: SyncedEventsOutcome = (anyEvents.count ?? 0) > 0 ? "kept" : "none";
  if (removeSyncedEvents && calendar.data && (activeEvents.count ?? 0) > 0) {
    try {
      eventsRemoved = await deleteSyncedGoogleEvents(userId);
      // Events a previous disconnect detached have no connection left to remove them with, so they stay.
      syncedEvents = (anyEvents.count ?? 0) > eventsRemoved ? "kept" : "removed";
    } catch {
      eventsNotRemoved = true;
      syncedEvents = "not_removed";
    }
  }

  // 2. One revocation request per stored token. None of its outcomes stops the deletion.
  const connections: Array<{ provider: Provider; ciphertext: string; decrypt: (value: string, user: string) => Promise<string> }> = [];
  if (calendar.data) connections.push({ provider: "google_calendar", ciphertext: calendar.data.refresh_token_ciphertext, decrypt: decryptToken });
  if (gmail.data) connections.push({ provider: "gmail", ciphertext: gmail.data.refresh_token_ciphertext, decrypt: decryptEmailToken });
  const attempts: RevocationAttempt[] = await Promise.all(
    connections.map(async ({ provider, ciphertext, decrypt }) => {
      let token: string;
      try {
        token = await decrypt(ciphertext, userId);
      } catch {
        return { provider, outcome: "undecryptable" as const, token: null };
      }
      return { provider, outcome: await revokeGoogleToken(token), token };
    }),
  );
  const googleRevoked = attempts.some((attempt) => attempt.outcome === "revoked");
  const outcomeOf = (provider: Provider) => storedRevocation(attempts.find((attempt) => attempt.provider === provider)?.outcome);

  // 3. Every row the account owns, but its profile, in one transaction.
  // bounded: a write that returns one object of per-table counts.
  const deleted = await admin.rpc("delete_account_data", { p_user_id: userId });
  if (deleted.error) return { ok: false, status: 500, error: "deletion_failed", eventsRemoved, googleRevoked };

  // 4. The auth user, and with it the profile. From here on nothing may throw past this function: the data is gone, so
  // an unexpected error must not reach the route's "nothing was deleted" answer.
  if (!(await authUserDeleted(admin, userId))) return { ok: false, status: 500, error: "sign_in_not_deleted" };

  // 5. Supabase Auth's leftovers for this id, and the anonymous record.
  let deletionId: string | null = null;
  try {
    // bounded: a write that returns the new record's id.
    const finished = await admin.rpc("finish_account_deletion", {
      p_user_id: userId,
      p_rows_deleted: deleted.data ?? {},
      p_google_calendar_revocation: outcomeOf("google_calendar"),
      p_gmail_revocation: outcomeOf("gmail"),
      p_synced_calendar_events: syncedEvents,
    });
    if (finished.error) console.error("[account] deleted, but finishing the deletion failed", finished.error.code ?? "unknown");
    else deletionId = typeof finished.data === "string" ? finished.data : null;
  } catch {
    console.error("[account] deleted, but finishing the deletion failed", "exception");
  }

  // 6. Google did not answer about these; offer them again after the response, from memory only.
  const pending = attempts.flatMap((attempt) => (attempt.outcome === "unreachable" && attempt.token ? [{ provider: attempt.provider, token: attempt.token }] : []));
  if (pending.length) {
    try {
      after(retryRevocations(pending, deletionId).catch(() => console.error("[account] background Google revocation failed")));
    } catch {
      // No request scope to run after (a caller outside a route): the user has been told to revoke it themselves.
    }
  }

  return {
    ok: true,
    googleNotRevoked: attempts.some((attempt) => !["revoked", "already_invalid"].includes(storedRevocation(attempt.outcome))),
    eventsKept: syncedEvents === "kept",
    eventsNotRemoved,
  };
}
