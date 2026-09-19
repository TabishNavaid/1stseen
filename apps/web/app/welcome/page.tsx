import type { Metadata } from "next";
import { FocusedShell } from "@/components/focused-shell";
import { OnboardingFlow } from "@/components/onboarding/onboarding-flow";
import { emptyAnswers, hasAnyAnswer, parseOnboardingAnswers } from "@/lib/onboarding";
import { loadCompanyChoices, loadOnboardingPayoff, loadOnboardingState } from "@/lib/onboarding-data";
import { hasServiceRoleConfig } from "@/lib/real-data";
import { currentSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Get started",
  description: "Three quick questions, then the early-career programs worth watching for you.",
};

// Answers are per visitor and a signed-in visit reads its own preferences, so nothing here is served from a shared cache.
export const dynamic = "force-dynamic";

/**
 * The first run, open to everyone. Steps one to three are answered in the browser; `?step=ready` with the answers in
 * the URL is the payoff, rendered here from the same read path as the roles page. A guest keeps their answers in the
 * browser and is asked for an account only at the payoff; a signed-in visitor saves straight to their watchlist.
 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  if (!hasServiceRoleConfig()) {
    return (
      <FocusedShell>
        <h1 className="heading-display text-3xl">Get started</h1>
        <p className="mt-3 text-sm leading-6 text-ink-muted">
          Live data is not configured on this deployment, so there are no programs to suggest yet. Set SUPABASE_URL and
          SUPABASE_SERVICE_ROLE_KEY to read collected evidence.
        </p>
      </FocusedShell>
    );
  }

  const session = await currentSession();
  const fromUrl = parseOnboardingAnswers(params);
  const ready = params.step === "ready";
  const now = new Date();
  const [choices, payoff, state] = await Promise.all([
    loadCompanyChoices(),
    ready ? loadOnboardingPayoff(fromUrl, now) : Promise.resolve(null),
    session ? loadOnboardingState(session.userId) : Promise.resolve(null),
  ]);
  // Answers in the URL win; otherwise a signed-in re-run starts from what the account stored.
  const inUrl = hasAnyAnswer(fromUrl) || ready;
  const answers = inUrl ? fromUrl : state?.answers ?? emptyAnswers;

  return (
    <OnboardingFlow
      initialAnswers={answers}
      answersInUrl={inUrl}
      companies={choices.all}
      popular={choices.popular}
      payoff={payoff}
      signedIn={session !== null}
      autoSave={params.save === "1"}
      rerun={state?.completedAt != null}
    />
  );
}
