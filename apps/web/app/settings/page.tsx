import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { AccountDataControls } from "@/components/account/account-data-controls";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { FocusedShell } from "@/components/focused-shell";
import { Icon } from "@/components/ui/icon";
import { loadGoogleConnectionSummary } from "@/lib/account/data";
import { hasSupabaseConfig } from "@/lib/config";
import { SEASON_LABELS, TRACKS, programTypeSummary } from "@/lib/onboarding";
import { loadOnboardingState } from "@/lib/onboarding-data";
import { hasServiceRoleConfig } from "@/lib/real-data";
import { currentSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Settings",
  description: "Your account, what you are preparing for, and your watchlist.",
};

export const dynamic = "force-dynamic";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-3 sm:grid-cols-[180px_1fr] sm:gap-4">
      <dt className="text-caption font-semibold text-ink-subtle">{label}</dt>
      <dd className="m-0 text-sm text-ink">{children}</dd>
    </div>
  );
}

export default async function SettingsPage() {
  if (!hasSupabaseConfig() || !hasServiceRoleConfig()) {
    return (
      <FocusedShell>
        <h1 className="text-2xl font-semibold tracking-title">Settings</h1>
        <p className="mt-3 text-sm leading-6 text-ink-muted">Accounts are not configured on this deployment, so there is nothing to set.</p>
      </FocusedShell>
    );
  }
  const session = await currentSession();
  if (!session) redirect("/signin?return_to=%2Fsettings");
  const [state, google] = await Promise.all([loadOnboardingState(session.userId), loadGoogleConnectionSummary(session.userId)]);
  const { answers } = state;
  const answered = state.completedAt !== null;
  const tracks = TRACKS.filter((track) => answers.tracks.includes(track.value)).map((track) => track.label);

  return (
    <FocusedShell>
      <h1 className="text-2xl font-semibold tracking-title">Settings</h1>

      <section className="mt-8" aria-labelledby="preparing-title">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="preparing-title" className="text-base font-semibold">What you are preparing for</h2>
            <p className="mt-1 text-caption text-ink-subtle">
              {answered ? "Your first-run answers. Running the questions again proposes roles to add; nothing you watch is removed." : "You have not answered the first-run questions. They take under a minute and propose roles to watch."}
            </p>
          </div>
          <Link href="/welcome" className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover max-sm:h-touch">
            <Icon name="arrow-right" size={15} />{answered ? "Run the questions again" : "Answer the questions"}
          </Link>
        </div>
        {answered && (
          <dl className="panel mt-4 divide-y divide-line">
            <Row label="Kind of role">{tracks.length ? tracks.join(", ") : "Every discipline"}</Row>
            <Row label="Graduation">{answers.graduationYear === null ? "Not given: every program type" : `${answers.graduationYear}: ${programTypeSummary(answers.graduationYear, new Date())}`}</Row>
            <Row label="Season">{answers.season ? SEASON_LABELS[answers.season] : "Any season"}</Row>
            <Row label="Places">{answers.places.length ? answers.places.join(" or ") : "Anywhere"}</Row>
          </dl>
        )}
      </section>

      <section className="mt-10" aria-labelledby="watchlist-title">
        <h2 id="watchlist-title" className="text-base font-semibold">Watchlist</h2>
        <div className="panel mt-4 flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <p className="text-sm">{state.followedRoles === 1 ? "You watch 1 role." : `You watch ${state.followedRoles} roles.`}</p>
          <Link href={state.followedRoles ? "/?watched=1" : "/"} className="link-accent focus-ring inline-flex min-h-touch items-center text-sm">{state.followedRoles ? "Open your watchlist" : "Browse roles to watch"}</Link>
        </div>
        <p className="mt-2 text-caption text-ink-subtle">
          Google Calendar sync is on the <Link href="/calendar" className="link-accent focus-ring">recruiting calendar</Link>, and Gmail delivery is on{" "}
          <Link href="/digests" className="link-accent focus-ring">email digests</Link>.
        </p>
      </section>

      <section className="mt-10" aria-labelledby="account-title">
        <h2 id="account-title" className="text-base font-semibold">Account</h2>
        <div className="panel mt-4 flex flex-wrap items-center justify-between gap-3 px-4 py-3">
          <p className="min-w-0 truncate text-sm" title={session.email ?? undefined}>Signed in as {session.email ?? "your account"}</p>
          <SignOutButton className="inline-flex min-h-touch items-center text-sm font-semibold text-ink-muted hover:text-ink" />
        </div>
      </section>

      <section className="mt-10" aria-labelledby="data-title">
        <h2 id="data-title" className="text-base font-semibold">Your data</h2>
        <AccountDataControls {...google} />
      </section>
    </FocusedShell>
  );
}
