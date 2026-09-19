"use client";

import { useSyncExternalStore } from "react";
import Link from "next/link";
import { Icon } from "@/components/ui/icon";
import { GUEST_ONBOARDING_KEY, hasGuestAnswers, parseGuestOnboarding } from "@/lib/guest-onboarding";
import { answersSummary, browseHref, welcomeHref } from "@/lib/onboarding";

function subscribe(onChange: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key === GUEST_ONBOARDING_KEY) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}

/** The stored record as a string, so the snapshot is stable between renders. Null on the server and without storage. */
function useStoredRecord(): string | null {
  return useSyncExternalStore(subscribe, () => {
    try {
      // A plain read: private windows and blocked storage throw here, and that is no record.
      return globalThis.localStorage?.getItem(GUEST_ONBOARDING_KEY) ?? null;
    } catch {
      return null;
    }
  }, () => null);
}

/**
 * For a guest who has been through the first run before: their picks, one tap away. Rendered on the client only, from
 * this browser's local storage, so a cached page stays the same for every visitor and nothing about a guest reaches
 * the server.
 */
export function ReturningGuestNote({ variant = "landing" }: { variant?: "landing" | "roles" }) {
  const record = parseGuestOnboarding(useStoredRecord());
  if (!hasGuestAnswers(record)) return null;
  const { answers } = record;
  if (variant === "roles") {
    return (
      <p className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-card border border-warm-line bg-warm-soft px-4 py-3 text-sm text-ink">
        <Icon name="sparkles" size={15} className="text-warm-ink" />
        <span>Showing every role. Your picks: <strong className="font-semibold">{answersSummary(answers)}</strong>.</span>
        <Link href={browseHref(answers)} className="link-accent focus-ring inline-flex min-h-touch items-center gap-1 sm:ml-auto">Show only my picks<Icon name="arrow-right" size={13} /></Link>
      </p>
    );
  }
  return (
    <p className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted">
      <Icon name="sparkles" size={15} className="text-warm-ink" />
      Welcome back.
      <Link href={welcomeHref(answers, "ready")} className="link-accent focus-ring inline-flex min-h-touch items-center gap-1">See the programs you picked<Icon name="arrow-right" size={13} /></Link>
    </p>
  );
}
