/**
 * A guest's first-run answers, kept in the browser's local storage until they sign up.
 *
 * Nothing about a guest is stored on the server. The answers live under one key on the guest's own device, personalize
 * what they browse through the URL, and carry into an account on sign-up: a guest who chose "Save to my watchlist" is marked
 * `pendingSave`, and the first signed-in visit to /welcome posts the answers to /api/onboarding and clears the mark.
 * A different device, or cleared storage, simply has no answers, and the first run starts again.
 *
 * Pure apart from the `Storage` passed in, so tests exercise it with an in-memory one.
 */

// Relative with its extension, so Node's test runner loads this file directly; Vite resolves it either way.
import { MAX_SEED_FOLLOWS, cleanAnswers, hasAnyAnswer, type OnboardingAnswers } from "./onboarding.ts";

export const GUEST_ONBOARDING_KEY = "firstseen:onboarding";

export type GuestOnboarding = {
  version: 1;
  answers: OnboardingAnswers;
  /** When the guest reached the payoff, or null while they are still answering. */
  completedAt: string | null;
  /** Set when the guest chose "Save to my watchlist": the next signed-in first run saves the answers. */
  pendingSave: boolean;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Local storage when it can be used; private windows and blocked storage throw on access, and that is no storage. */
export function browserStorage(): StorageLike | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return null;
    const probe = `${GUEST_ONBOARDING_KEY}:probe`;
    storage.setItem(probe, "1");
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

/** A stored record, or null when there is none or it is not one this version wrote. Values are re-validated. */
export function parseGuestOnboarding(raw: string | null): GuestOnboarding | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1) return null;
  const record = value as { answers?: Record<string, unknown>; completedAt?: unknown; pendingSave?: unknown };
  const answers = cleanAnswers(record.answers ?? {});
  const completedAt = typeof record.completedAt === "string" && !Number.isNaN(Date.parse(record.completedAt)) ? record.completedAt : null;
  return { version: 1, answers, completedAt, pendingSave: record.pendingSave === true && completedAt !== null };
}

export function readGuestOnboarding(storage: StorageLike | null): GuestOnboarding | null {
  if (!storage) return null;
  try {
    return parseGuestOnboarding(storage.getItem(GUEST_ONBOARDING_KEY));
  } catch {
    return null;
  }
}

/** Writes the record; a storage that refuses (full, blocked) leaves the guest exactly where they were. */
export function writeGuestOnboarding(storage: StorageLike | null, record: GuestOnboarding): boolean {
  if (!storage) return false;
  try {
    storage.setItem(GUEST_ONBOARDING_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function clearGuestOnboarding(storage: StorageLike | null): void {
  try {
    storage?.removeItem(GUEST_ONBOARDING_KEY);
  } catch {
    // Nothing to clear.
  }
}

/** The record for answers still being given. */
export function answering(answers: OnboardingAnswers, previous: GuestOnboarding | null): GuestOnboarding {
  return { version: 1, answers, completedAt: previous?.completedAt ?? null, pendingSave: false };
}

/** The record once the payoff is shown, and whether the guest asked to save it into an account. */
export function reachedPayoff(answers: OnboardingAnswers, now: Date, pendingSave = false): GuestOnboarding {
  return { version: 1, answers, completedAt: now.toISOString(), pendingSave };
}

/** Whether a signed-in first run should save stored guest answers into the account without asking again. */
export function shouldCarryOver(record: GuestOnboarding | null): record is GuestOnboarding {
  return record !== null && record.pendingSave && record.completedAt !== null;
}

/** Whether a guest has answers worth offering back to them ("pick up where you left off"). */
export function hasGuestAnswers(record: GuestOnboarding | null): record is GuestOnboarding {
  return record !== null && record.completedAt !== null && hasAnyAnswer(record.answers);
}

/** The body /api/onboarding takes to save a first run: the answers, the listed roles to follow, and the companies. */
export function completeRequest(answers: OnboardingAnswers, roleIds: readonly string[]) {
  return {
    action: "complete" as const,
    answers: { looking_for: answers.lookingFor, fields: answers.fields, companies: answers.companies },
    role_ids: [...new Set(roleIds)].slice(0, MAX_SEED_FOLLOWS),
  };
}
