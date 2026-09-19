import type { Metadata } from "next";
import { ForecastDashboard } from "@/components/forecast-dashboard";
import { LandingSection } from "@/components/landing-section";
import { appliedFilterKeys, fixtureDashboardView, parseDashboardFilters } from "@/lib/dashboard-query";
import { loadLandingFeature } from "@/lib/landing-data";
import { fixtureBasis, forecastRoles as fixtureRoles } from "@/lib/demo-data";
import { firstRunPending, parsePlanOutcome } from "@/lib/onboarding";
import { loadOnboardingState } from "@/lib/onboarding-data";
import { hasServiceRoleConfig, loadRealDashboard, loadRecentAgentActivity } from "@/lib/real-data";
import { currentSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Forecasts",
  description:
    "Evidence-backed forecasts for recurring internship and new-grad openings.",
};

// Real evidence changes as collection runs; never serve a cached snapshot as live.
export const dynamic = "force-dynamic";

/**
 * Development demo mode is an explicit opt-in.
 *
 * Fixtures are only rendered when `FIRSTSEEN_DEMO_MODE=true` is set and no real
 * database is configured. A deployment that simply lacks credentials shows an
 * unconfigured workspace, so fixture forecasts can never appear by default.
 */
function demoAllowed(): boolean {
  return process.env.FIRSTSEEN_DEMO_MODE === "true";
}

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Every filter, the sort, and the page are URL state, so every filtered view is a
  // server render of exactly the records it shows.
  const params = await searchParams;
  const filters = parseDashboardFilters(params);

  if (hasServiceRoleConfig()) {
    const session = await currentSession();
    // A signed-out visitor on the default view gets the landing section above the dashboard.
    const landingView = !session && appliedFilterKeys(filters).length === 0 && filters.page === 1;
    const [data, activity, onboarding, landing] = await Promise.all([
      loadRealDashboard(session?.userId ?? null, filters),
      loadRecentAgentActivity(),
      // The first-run offer is optional, so a failed read of it hides the offer rather than the dashboard.
      session ? loadOnboardingState(session.userId).catch(() => null) : Promise.resolve(null),
      // The landing section explains the product; if its reads fail, the dashboard still renders without it.
      landingView ? loadLandingFeature().catch(() => null) : Promise.resolve(null),
    ]);
    return (
      <ForecastDashboard
        mode={data.mode === "real" ? "real" : "unconfigured"}
        items={data.items}
        summary={data.summary}
        options={data.options}
        filters={filters}
        openings={data.recentOpenings}
        openingsTotal={data.recentOpeningsTotal}
        changes={data.recentChanges}
        agentActivity={activity}
        signedInAs={session?.email ?? null}
        firstRun={onboarding ? firstRunPending(onboarding) : false}
        welcome={session && parsePlanOutcome(params.welcome) === "none" ? "none" : null}
        landing={landing && data.mode === "real" ? (
          <LandingSection
            feature={landing}
            inScopeRoles={data.summary.inScopeRoles}
            forecastableRoles={data.summary.forecastableRoles}
            companies={data.options.company.length}
          />
        ) : null}
      />
    );
  }
  if (demoAllowed()) {
    const view = fixtureDashboardView(fixtureRoles, filters, fixtureBasis);
    return <ForecastDashboard mode="demo" items={view.items} summary={view.summary} options={view.options} filters={filters} />;
  }
  return <ForecastDashboard mode="unconfigured" filters={filters} />;
}
