import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { FocusedShell } from "@/components/focused-shell";
import { SeedReview } from "@/components/onboarding/seed-review";
import { WelcomeQuestions } from "@/components/onboarding/welcome-questions";
import { hasSupabaseConfig } from "@/lib/config";
import { graduationYears, hasAnyAnswer, parseOnboardingAnswers, programTypeSummary } from "@/lib/onboarding";
import { loadOnboardingState, loadSeedRoles } from "@/lib/onboarding-data";
import { hasServiceRoleConfig } from "@/lib/real-data";
import { currentSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Set up your watchlist",
  description: "Four questions choose a starting set of early-career technical roles to watch.",
};

// Answers and follows are per user, so nothing here is ever served from a shared cache.
export const dynamic = "force-dynamic";

/**
 * The first run. Step one asks four questions; step two, `?step=review` with the answers in the URL, proposes the
 * roles they fit. Signed out, it sends the visitor to sign in and back here.
 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  if (!hasSupabaseConfig() || !hasServiceRoleConfig()) {
    return (
      <FocusedShell>
        <h1 className="text-2xl font-semibold tracking-title">Set up your watchlist</h1>
        <p className="mt-3 text-sm leading-6 text-ink-muted">
          Accounts and live data are not configured on this deployment, so there is no watchlist to set up. Set SUPABASE_URL,
          SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_URL, and NEXT_PUBLIC_SUPABASE_ANON_KEY.
        </p>
      </FocusedShell>
    );
  }
  const session = await currentSession();
  if (!session) redirect("/signin?return_to=%2Fwelcome");

  const now = new Date();
  const fromUrl = parseOnboardingAnswers(params);
  if (params.step === "review") {
    const seeds = await loadSeedRoles(session.userId, fromUrl, now);
    return (
      <FocusedShell status="Step 2 of 2">
        <SeedReview answers={fromUrl} seeds={seeds} programTypes={programTypeSummary(fromUrl.graduationYear, now)} />
      </FocusedShell>
    );
  }
  const state = await loadOnboardingState(session.userId);
  // Returning from the review keeps what was just answered; otherwise a re-run starts from the stored answers.
  const answers = hasAnyAnswer(fromUrl) ? fromUrl : state.answers;
  return (
    <FocusedShell status="Step 1 of 2">
      <WelcomeQuestions answers={answers} years={graduationYears(now, answers.graduationYear)} rerun={state.completedAt !== null} />
    </FocusedShell>
  );
}
