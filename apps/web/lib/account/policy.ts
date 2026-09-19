/**
 * The rules of account export and deletion that do not need a database: the confirmation phrase, what the
 * deletion route may answer and what each answer tells the user, the landing page's notes, and the check that an
 * export carries no credential. docs/account-data.md is the contract; the privacy policy is written against it.
 *
 * Pure, with no `server-only` import, so tests/account-policy.test.mjs reads it directly and the settings dialog uses
 * the same phrase and messages as the route.
 */

/** Typed into the deletion dialog, and checked again by the route. Case and surrounding spaces do not matter. */
export const DELETE_CONFIRMATION_PHRASE = "delete my account";

export function confirmationMatches(value: unknown): boolean {
  return typeof value === "string" && value.trim().replace(/\s+/g, " ").toLowerCase() === DELETE_CONFIRMATION_PHRASE;
}

/**
 * What account_deletions records about each Google connection (migration 202608140037). `unconfirmed`: Google did not
 * answer, and the token is offered again after the response; `not_revocable`: repeating the request cannot succeed.
 */
export type StoredRevocation = "not_connected" | "revoked" | "already_invalid" | "unconfirmed" | "not_revocable";

/** What happened to the events 1stSeen had put in the user's Google Calendar. `not_removed`: the user asked, Google failed. */
export type SyncedEventsOutcome = "none" | "kept" | "removed" | "not_removed";

/**
 * Every way a deletion can stop, and what is true afterwards. The route answers only these codes, never a message from
 * Google or Supabase. None of them is Google's: a deletion does not wait on Google (lib/account/deletion.ts).
 */
export type DeletionFailure =
  | "invalid_request"
  | "confirmation_mismatch"
  | "unauthorized"
  | "cross_origin"
  | "supabase_unavailable"
  | "account_deletion_unavailable"
  | "deletion_failed"
  | "sign_in_not_deleted";

export type DeletionFailureBody = { error: DeletionFailure; events_removed?: number; google_revoked?: boolean };

const FAILURE_MESSAGES: Record<DeletionFailure, string> = {
  invalid_request: "That request could not be read. Nothing was deleted.",
  confirmation_mismatch: `Type "${DELETE_CONFIRMATION_PHRASE}" exactly to confirm. Nothing was deleted.`,
  unauthorized: "Your session has ended. Sign in again to delete your account. Nothing was deleted.",
  cross_origin: "That request did not come from 1stSeen, so nothing was deleted.",
  supabase_unavailable: "Accounts are not configured on this deployment. Nothing was deleted.",
  account_deletion_unavailable: "Account deletion is not configured on this deployment. Nothing was deleted.",
  deletion_failed: "1stSeen could not delete your data, so your account was not deleted. Try again.",
  sign_in_not_deleted:
    "Your data was deleted, but your sign-in account was not. Try again to finish deleting it.",
};

/** The sentence the deletion dialog shows for a failed request, with what had already happened. */
export function deletionFailureMessage(body: Partial<DeletionFailureBody> | null, status: number): string {
  const code = body?.error && body.error in FAILURE_MESSAGES ? body.error : null;
  if (!code) return status === 401 ? FAILURE_MESSAGES.unauthorized : "1stSeen could not delete your account. Nothing was deleted. Try again.";
  const parts = [FAILURE_MESSAGES[code]];
  if (body?.events_removed) {
    parts.push(`The ${body.events_removed === 1 ? "event" : `${body.events_removed} events`} 1stSeen added to your Google Calendar ${body.events_removed === 1 ? "was" : "were"} already removed.`);
  }
  if (body?.google_revoked) {
    parts.push("1stSeen's access to your Google account was already revoked; connect Google again if you keep your account.");
  }
  return parts.join(" ");
}

export const ACCOUNT_DELETED_PATH = "/account/deleted";

export type DeletedPageNotes = { googleNotRevoked: boolean; eventsKept: boolean; eventsNotRemoved?: boolean };

/** Where a deleted account lands. The notes are plain flags, never an id. */
export function deletedPagePath({ googleNotRevoked, eventsKept, eventsNotRemoved = false }: DeletedPageNotes): string {
  const params = new URLSearchParams();
  if (googleNotRevoked) params.set("google", "not_revoked");
  if (eventsNotRemoved) params.set("events", "not_removed");
  else if (eventsKept) params.set("events", "kept");
  const query = params.toString();
  return query ? `${ACCOUNT_DELETED_PATH}?${query}` : ACCOUNT_DELETED_PATH;
}

export function deletedPageNotes(params: Record<string, string | string[] | undefined>): Required<DeletedPageNotes> {
  return {
    googleNotRevoked: params.google === "not_revoked",
    eventsKept: params.events === "kept",
    eventsNotRemoved: params.events === "not_removed",
  };
}

/** Google's page where a person removes an app's access to their account. */
export const GOOGLE_THIRD_PARTY_ACCESS_URL = "https://myaccount.google.com/connections";

export const EXPORT_FORMAT = "1stseen-account-export";
export const EXPORT_FORMAT_VERSION = 1;

/** Field names an export must never carry: credentials and their ciphertexts. `prompt_tokens` is a count, not a token. */
const FORBIDDEN_EXPORT_KEY = /(?:^|_)(?:access|refresh|id)_token$|^token$|ciphertext|secret|password|verifier/i;
/** The stored form of an encrypted OAuth token (lib/oauth-token-crypto.ts), under whatever name. */
const SEALED_TOKEN = /^v2\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{16,}$/;

/** The path of the first credential-shaped field or value in an export, or null when there is none. */
export function exportCredentialPath(value: unknown, path = "$"): string | null {
  if (typeof value === "string") return SEALED_TOKEN.test(value) ? path : null;
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = exportCredentialPath(item, `${path}[${index}]`);
      if (found) return found;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_EXPORT_KEY.test(key)) return `${path}.${key}`;
      const found = exportCredentialPath(item, `${path}.${key}`);
      if (found) return found;
    }
  }
  return null;
}
