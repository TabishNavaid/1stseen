import type { Metadata } from "next";
import Link from "next/link";
import { FocusedShell } from "@/components/focused-shell";
import { Icon } from "@/components/ui/icon";
import { GOOGLE_THIRD_PARTY_ACCESS_URL, deletedPageNotes } from "@/lib/account/policy";
import { sitePage } from "@/lib/site-links";

export const metadata: Metadata = {
  title: "Account deleted",
  robots: { index: false, follow: false },
};

/**
 * Where a deleted account lands. It reads no session and no data: it is reached only after
 * /api/auth/delete-account has deleted the auth user, and its two notes are plain flags in the address.
 */
export default async function AccountDeletedPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { googleNotRevoked, eventsKept, eventsNotRemoved } = deletedPageNotes(await searchParams);
  return (
    <FocusedShell width="narrow">
      <p className="label-caps text-accent-ink">Account</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-title">Your account has been deleted</h1>
      <p className="mt-3 text-sm leading-6 text-ink-muted">
        Your 1stSeen account and everything it held are gone: your answers, watchlist, readiness plans, calendar and digest
        records, Google connections, and the questions you asked the agent. You have been signed out, and this cannot be
        undone.
      </p>
      {googleNotRevoked && (
        <div className="mt-5 flex gap-2 border border-warning-line bg-warning-surface p-3 text-xs leading-5 text-warning-ink">
          <Icon name="circle-alert" size={15} className="mt-0.5 shrink-0" />
          <p>
            <strong className="font-semibold">Remove 1stSeen&apos;s access in your Google Account.</strong> Your data is deleted, but
            Google did not confirm that the access you gave 1stSeen is revoked, so 1stSeen may still be listed there. Go to{" "}
            <a href={GOOGLE_THIRD_PARTY_ACCESS_URL} className="font-semibold underline underline-offset-2 focus-ring" rel="noreferrer">
              myaccount.google.com/connections
            </a>
            , choose 1stSeen, and delete its connection. 1stSeen no longer stores the token and will ask Google again for a
            short while, but only Google can confirm the access is gone.
          </p>
        </div>
      )}
      {eventsNotRemoved && (
        <p className="mt-4 text-xs leading-5 text-ink-muted">
          Google Calendar did not let 1stSeen remove every event it added, so some may still be in your calendar as ordinary
          events. Delete them in Google Calendar if you no longer want them.
        </p>
      )}
      {eventsKept && (
        <p className="mt-4 text-xs leading-5 text-ink-muted">
          Events 1stSeen added to your Google Calendar are still there, as ordinary events. Delete them in Google Calendar if
          you no longer want them.
        </p>
      )}
      <div className="mt-8 flex flex-wrap items-center gap-4">
        <Link href="/" className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover max-sm:h-touch">
          <Icon name="arrow-right" size={15} />Browse forecasts without an account
        </Link>
        <Link href={sitePage("privacy").href} className="link-accent focus-ring inline-flex min-h-touch items-center text-sm">How 1stSeen handles data</Link>
      </div>
    </FocusedShell>
  );
}
