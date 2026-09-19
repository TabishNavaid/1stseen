import type { Metadata } from "next";
import { ForecastDashboard } from "@/components/forecast-dashboard";
import { ReturningGuestNote } from "@/components/onboarding/returning-guest-note";
import { SiteHeader } from "@/components/site-header";
import { Badge } from "@/components/ui/badge";
import { appliedFilterKeys, fixtureDashboardView, parseDashboardFilters } from "@/lib/dashboard-query";
import { fixtureBasis, forecastRoles as fixtureRoles } from "@/lib/demo-data";
import { firstRunPending, parsePlanOutcome } from "@/lib/onboarding";
import { loadOnboardingState } from "@/lib/onboarding-data";
import { hasServiceRoleConfig, loadRealDashboard } from "@/lib/real-data";
import { currentSession } from "@/lib/session";

export const metadata: Metadata = {
  title: "Forecasts",
  description: "Evidence-backed forecasts for recurring internship and new-grad openings.",
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

const fixtureBadge = <Badge className="border-warning-line bg-warning-surface text-warning-ink">Development fixture</Badge>;

/** Every role in the product: what guests browse and where a signed-in user's watchlist lives. */
export default async function RolesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Every filter, the sort, and the page are URL state, so every filtered view is a server render of exactly the
  // records it shows.
  const params = await searchParams;
  const filters = parseDashboardFilters(params);
  const active = filters.watchedOnly ? "watchlist" : "explore";

  if (hasServiceRoleConfig()) {
    const session = await currentSession();
    const [data, onboarding] = await Promise.all([
      loadRealDashboard(session?.userId ?? null, filters),
      // The first-run offer is optional, so a failed read of it hides the offer rather than the dashboard.
      session ? loadOnboardingState(session.userId).catch(() => null) : Promise.resolve(null),
    ]);
    const defaultView = appliedFilterKeys(filters).length === 0 && filters.page === 1;
    return (
      <>
        <SiteHeader active={active} contentId="dashboard-content" />
        <ForecastDashboard
          mode={data.mode === "real" ? "real" : "unconfigured"}
          items={data.items}
          summary={data.summary}
          options={data.options}
          filters={filters}
          openings={data.recentOpenings}
          openingsTotal={data.recentOpeningsTotal}
          changes={data.recentChanges}
          signedInAs={session?.email ?? null}
          firstRun={onboarding ? firstRunPending(onboarding) : false}
          welcome={session && parsePlanOutcome(params.welcome) === "none" ? "none" : null}
          picks={!session && defaultView ? <ReturningGuestNote variant="roles" /> : null}
        />
      </>
    );
  }
  if (demoAllowed()) {
    const view = fixtureDashboardView(fixtureRoles, filters, fixtureBasis);
    return (
      <>
        <SiteHeader active={active} contentId="dashboard-content" status={fixtureBadge} />
        <ForecastDashboard mode="demo" items={view.items} summary={view.summary} options={view.options} filters={filters} />
      </>
    );
  }
  return (
    <>
      <SiteHeader active={active} contentId="dashboard-content" status={<Badge className="border-danger-line bg-danger-surface text-danger-ink">Not configured</Badge>} />
      <ForecastDashboard mode="unconfigured" filters={filters} />
    </>
  );
}
