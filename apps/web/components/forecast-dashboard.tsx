"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { AgentActivity, type AgentActivityView } from "@/components/agent-activity";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { DashboardFiltersForm } from "@/components/dashboard-filters";
import { EvidenceDrawer } from "@/components/evidence-drawer";
import { ForecastCard } from "@/components/forecast-card";
import { ForecastChange } from "@/components/forecast-change";
import { ForecastGuide } from "@/components/forecast-guide";
import { InsufficientRoleCard } from "@/components/insufficient-role-card";
import { SkipFirstRunButton } from "@/components/onboarding/skip-first-run-button";
import { RecruitingTimeline } from "@/components/recruiting-timeline";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { useOffCanvas } from "@/components/ui/off-canvas";
import { EmptyState } from "@/components/ui/status";
import { forecastChanges, forecastRoles as fixtureRoles, openedRoles } from "@/lib/demo-data";
import {
  DASHBOARD_PAGE_SIZE,
  appliedFilterKeys,
  dashboardHref,
  defaultDashboardFilters,
  emptyDashboardSummary,
  emptyFilterOptions,
  filterName,
  perCompanyLimit,
  relaxSuggestion,
  type DashboardFilterOptions,
  type DashboardFilters,
  type DashboardListItem,
  type DashboardSummary,
} from "@/lib/dashboard-query";
import { formatShortDay } from "@/lib/dates";
import { PLAN_OUTCOME_MESSAGES } from "@/lib/onboarding";
import type { RealForecastChange, RealOpening } from "@/lib/real-data";
import { cn } from "@/lib/utils";

const nav = [
  { label: "Intelligence", icon: "radar" as const, href: "/", active: true },
  { label: "Recruiting calendar", icon: "calendar-days" as const, href: "/calendar" },
  { label: "Forecast replay", icon: "calendar-clock" as const, href: "/replay" },
  { label: "Email digests", icon: "mail" as const, href: "/digests" },
];

export type DashboardMode = "real" | "demo" | "unconfigured";

export type ForecastDashboardProps = {
  mode?: DashboardMode;
  items?: DashboardListItem[];
  summary?: DashboardSummary;
  filters?: DashboardFilters;
  options?: DashboardFilterOptions;
  openings?: RealOpening[];
  /** Every exact opening in the window; `openings` is only its newest rows. */
  openingsTotal?: number;
  changes?: RealForecastChange[];
  agentActivity?: AgentActivityView | null;
  signedInAs?: string | null;
  /** A signed-in account that has not finished or skipped the first run and follows nothing. */
  firstRun?: boolean;
  /** Set when the first run lands here because no chosen role has a forecast to plan from. */
  welcome?: "none" | null;
  /** The signed-out landing section, rendered on the server and shown above everything else. */
  landing?: ReactNode;
};

function toTimelineRoles(openings: RealOpening[]) {
  return openings.map((opening) => ({
    id: opening.id,
    company: opening.company,
    role: opening.role,
    location: "",
    openedAt: formatShortDay(opening.openedOn),
    observedAt: opening.observedAt
      ? `First observed ${formatShortDay(opening.observedAt)}`
      : "Source-supplied publication date",
    source: "Official ATS" as const,
    applyUrl: opening.applyUrl ?? `/roles/${opening.roleId}`,
  }));
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * What this view shows and what it leaves out, in numbers. Every filtered view names each applied filter and how
 * many in-scope roles it excludes on its own; the per-company collapse and the product scope are stated too.
 */
function ViewStatement({ filters, summary }: { filters: DashboardFilters; summary: DashboardSummary }) {
  const applied = appliedFilterKeys(filters);
  return (
    <div className="grid gap-1 border-b border-line bg-surface-sunken px-4 py-3 text-caption text-ink-muted md:px-5">
      {applied.length === 0 ? (
        <p>
          All <strong className="text-ink">{summary.inScopeRoles}</strong> in-scope roles: {summary.forecastableRoles} with a forecast, listed first, and{" "}
          {summary.insufficientRoles} without enough history to forecast yet, listed after them.
        </p>
      ) : (
        <p>
          <strong className="text-ink">{summary.matchingRoles}</strong> of {summary.inScopeRoles} in-scope roles match: {summary.matchingForecastable} with a
          forecast and {summary.matchingInsufficient} without enough history.
        </p>
      )}
      {applied.length > 0 && (
        <p>
          Excluded by each filter on its own:{" "}
          {applied.map((key) => `${filterName(key)} ${summary.exclusions[key].excluded}`).join(", ")}.
        </p>
      )}
      {summary.collapsedRoles > 0 && (
        <p>
          {plural(summary.collapsedRoles, "more role")} at {plural(summary.collapsedCompanies, "company", "companies")} are folded under
          {" "}&ldquo;Show all&rdquo; so no company fills the list; they are counted above.
        </p>
      )}
      {summary.outsideScopeRoles > 0 && (
        <p className="text-ink-subtle">
          {summary.outsideScopeRoles} collected roles outside the early-career technical scope, or not yet placed in it, are never listed.
        </p>
      )}
    </div>
  );
}

export function ForecastDashboard({
  mode = "demo",
  items = [],
  summary = emptyDashboardSummary,
  filters = defaultDashboardFilters,
  options = emptyFilterOptions,
  openings = [],
  openingsTotal,
  changes = [],
  agentActivity = null,
  signedInAs = null,
  firstRun = false,
  welcome = null,
  landing = null,
}: ForecastDashboardProps = {}) {
  // Real data never falls back to fixtures; an unconfigured deployment shows an
  // empty, clearly-labelled workspace instead of demo forecasts.
  const isDemo = mode === "demo";
  const timelineRoles = isDemo ? openedRoles : toTimelineRoles(openings);
  // The card counts every opening; the timeline lists the newest few and says so. Never the list's length as a total.
  const confirmedOpenings = isDemo ? timelineRoles.length : openingsTotal ?? timelineRoles.length;
  const changeRecords = isDemo
    ? forecastChanges.map((change) => ({
        id: change.roleId,
        roleId: change.roleId,
        role: fixtureRoles.find((role) => role.id === change.roleId)?.role ?? "Watched role",
        previousWindow: change.previousWindow,
        currentWindow: change.currentWindow,
        confidenceDelta: change.confidenceDelta,
        changedAt: change.changedAt,
        reason: change.reason,
      }))
    : changes.map((change) => ({
        id: change.id,
        roleId: change.roleId,
        role: `${change.company} · ${change.role}`,
        previousWindow: change.previousWindow,
        currentWindow: change.currentWindow,
        confidenceDelta: change.confidenceDelta,
        changedAt: formatShortDay(change.changedAt),
        reason: change.reasons[0] ?? "Recorded forecast revision.",
        basis: change.basis,
      }));
  const { watchedOnly } = filters;
  const forecasts = items.filter((item): item is DashboardListItem & { forecast: NonNullable<DashboardListItem["forecast"]> } => item.forecast !== null);
  const [selectedId, setSelectedId] = useState(forecasts[0]?.id ?? "");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const navRef = useOffCanvas<HTMLElement>(navOpen, () => setNavOpen(false), "(width < 64rem)");
  // The loader has already filtered, ordered, collapsed, and paged the list and computed every
  // count from the same filters, so this component only renders what it was given.
  const selectedItem = forecasts.find((item) => item.id === selectedId) ?? forecasts[0];
  const selected = selectedItem?.forecast;
  const cap = perCompanyLimit(filters);
  const pageStart = (filters.page - 1) * DASHBOARD_PAGE_SIZE;
  const hasPreviousPage = filters.page > 1;
  const hasNextPage = pageStart + items.length < summary.shownRoles;
  const pastLastPage = items.length === 0 && summary.shownRoles > 0;
  const relax = relaxSuggestion(filters, summary);
  const applied = appliedFilterKeys(filters);
  const emptyWatchlist = watchedOnly && summary.followedRoles === 0;

  return (
    <div className="flex-1 text-ink">
      <a href="#dashboard-content" className="sr-only z-[60] rounded-control bg-surface px-3 py-2 text-xs font-semibold text-ink focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:outline-2 focus:outline-focus">Skip to content</a>
      <div className="flex min-h-screen">
        <aside ref={navRef} className={cn("fixed inset-y-0 left-0 z-50 flex w-[216px] flex-col border-r border-line bg-nav px-3 py-4 text-nav-ink lg:visible lg:sticky lg:top-0 lg:translate-x-0", navOpen ? "translate-x-0 transition-transform" : "invisible -translate-x-full transition-[transform,visibility]")} aria-label="Workspace">
          <div className="flex h-10 items-center justify-between px-2"><div className="flex items-center gap-2.5"><div className="grid h-7 w-7 place-items-center rounded-sm border border-nav-line bg-accent-soft text-xs font-black text-accent-ink" aria-hidden="true">1</div><span className="text-base font-semibold tracking-[-0.04em]">1stSeen</span></div><button type="button" onClick={() => setNavOpen(false)} className="-mr-2 grid size-touch place-items-center rounded-control text-nav-muted hover:bg-nav-hover hover:text-ink-inverse focus-visible:outline-2 focus-visible:outline-nav-accent lg:hidden" aria-label="Close navigation"><Icon name="x" size={17} /></button></div>
          <p className="mt-5 px-2 label-caps text-nav-subtle">Recruiting workspace</p>
          <nav className="mt-2 space-y-1" aria-label="Primary navigation">
            {nav.map(({ label, icon, active, href }) => (
              <Link key={label} href={href} aria-current={active && !watchedOnly ? "page" : undefined} className={cn("flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-nav-accent max-lg:h-touch", active && !watchedOnly ? "bg-nav-active text-white" : "text-nav-muted hover:bg-nav-hover hover:text-white")}>
                <Icon name={icon} size={15} /><span className="flex-1 text-left">{label}</span>
              </Link>
            ))}
            <Link
              href={dashboardHref(filters, { watchedOnly: !watchedOnly })}
              aria-current={watchedOnly ? "page" : undefined}
              className={cn("flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-xs font-medium focus-visible:outline-2 focus-visible:outline-nav-accent max-lg:h-touch", watchedOnly ? "bg-nav-active text-white" : "text-nav-muted hover:bg-nav-hover hover:text-white")}
            >
              <Icon name="briefcase-business" size={15} /><span className="flex-1 text-left">Watchlist</span>
              <span className="text-micro tabular text-nav-subtle">{summary.followedRoles}</span>
            </Link>
          </nav>
          <div className="mt-auto border-t border-nav-line pt-4">
            {signedInAs
              ? <div className="mt-3 px-2 py-1"><p className="truncate text-micro text-nav-subtle" title={signedInAs}>Signed in as {signedInAs}</p><div className="mt-1.5 flex items-center gap-4"><Link href="/settings" className="inline-flex items-center text-caption text-nav-ink hover:text-white focus-visible:outline-2 focus-visible:outline-nav-accent max-lg:min-h-touch">Settings</Link><SignOutButton className="inline-flex items-center text-caption text-nav-ink hover:text-white focus-visible:outline-2 focus-visible:outline-nav-accent max-lg:min-h-touch" /></div></div>
              : <Link href="/signin" className="mt-3 flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs text-nav-muted hover:bg-nav-hover"><Icon name="log-in" size={14} />Sign in</Link>}
          </div>
        </aside>
        {navOpen && <div className="fixed inset-0 z-40 bg-scrim lg:hidden" onClick={() => setNavOpen(false)} aria-hidden="true" />}

        <main id="dashboard-content" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none">
          <header className="sticky top-0 z-30 flex h-14 items-center border-b border-line bg-canvas/95 px-4 backdrop-blur md:px-6"><button type="button" onClick={() => setNavOpen(true)} className="-ml-2 mr-1 grid size-touch place-items-center rounded-control text-ink-muted hover:bg-surface-hover hover:text-ink focus-ring lg:hidden" aria-label="Open navigation" aria-expanded={navOpen}><Icon name="menu" size={19} /></button><div>{landing ? <p className="text-sm font-semibold tracking-[-0.01em]">Recruiting intelligence</p> : <h1 className="text-sm font-semibold tracking-[-0.01em]">Recruiting intelligence</h1>}<p className="hidden text-micro text-ink-subtle sm:block">Forecasts, evidence, and preparation timing in one view</p></div><div className="ml-auto flex items-center gap-2">{mode === "real" ? (
              <Badge className="hidden border-success-line bg-success-surface text-accent-ink sm:inline-flex">Real data</Badge>
            ) : mode === "unconfigured" ? (
              <Badge className="hidden border-danger-line bg-danger-surface text-danger-ink sm:inline-flex">Not configured</Badge>
            ) : (
              <Badge className="hidden border-warning-line bg-warning-surface text-warning-ink sm:inline-flex">Development fixture</Badge>
            )}<ForecastGuide />{!signedInAs && <Link href="/signin" className="focus-ring inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-xs font-semibold text-ink-muted hover:bg-surface-hover hover:text-ink max-sm:h-touch"><Icon name="target" size={13} /><span className="sm:hidden">Sign in</span><span className="hidden sm:inline">Sign in to watch roles</span></Link>}</div></header>

          <div className="mx-auto max-w-[1560px] p-4 md:p-6">
            {landing}
            <section className="mb-6 grid border border-line bg-surface sm:grid-cols-3" aria-label="Portfolio summary">
              <div className="border-b border-line p-4 sm:border-b-0 sm:border-r"><p className="flex items-center gap-2 label-caps text-ink-subtle"><Icon name="calendar-clock" size={13} />Likely in 30 days</p><div className="mt-2 flex items-baseline gap-2"><strong className="text-2xl font-semibold tabular">{summary.openingWithin30Days}</strong><span className="text-micro text-ink-subtle">of {plural(summary.matchingForecastable, "forecast")} in this view</span></div></div>
              <div className="border-b border-line p-4 sm:border-b-0 sm:border-r"><p className="flex items-center gap-2 label-caps text-ink-subtle"><Icon name="bell" size={13} />Watched roles</p><div className="mt-2 flex items-baseline gap-2"><strong className="text-2xl font-semibold tabular">{summary.followedRoles}</strong><span className="text-micro text-ink-subtle">{signedInAs ? `${summary.followedForecastable} with a forecast` : "sign in to follow roles"}</span></div></div>
              <div className="p-4"><p className="flex items-center gap-2 label-caps text-ink-subtle"><Icon name="radar" size={13} />Confirmed openings</p><div className="mt-2 flex items-baseline gap-2"><strong className="text-2xl font-semibold tabular">{confirmedOpenings}</strong><span className="text-micro text-accent-ink">{mode === "real" ? "exact source dates in the last 45 days" : "verified in fixture sources"}</span></div></div>
            </section>

            {firstRun && mode === "real" && (
              <section className="mb-6 flex flex-col gap-4 border border-accent bg-surface p-5 md:flex-row md:items-center md:justify-between" aria-labelledby="first-run-title">
                <div>
                  <h2 id="first-run-title" className="text-sm font-semibold">Start with a watchlist that fits</h2>
                  <p className="mt-1.5 max-w-2xl text-caption leading-5 text-ink-muted">Answer four questions and 1stSeen proposes early-career roles to watch, then builds a preparation plan from the soonest forecast among them. You review the list before anything is saved.</p>
                </div>
                <div className="flex shrink-0 flex-wrap items-start gap-2">
                  <SkipFirstRunButton label="Not now" />
                  <Link href="/welcome" className="focus-ring inline-flex h-10 items-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-white hover:bg-accent-hover max-sm:h-touch">Answer four questions<Icon name="arrow-right" size={15} /></Link>
                </div>
              </section>
            )}

            {welcome === "none" && (
              <p role="status" className="mb-6 border-l-2 border-accent bg-surface px-4 py-3 text-sm leading-6 text-ink">{PLAN_OUTCOME_MESSAGES.none}</p>
            )}

            {mode === "unconfigured" && (
              <section className="mb-6 border border-line bg-surface p-5" aria-label="Evidence status">
                <h2 className="text-sm font-semibold">Live data is not configured</h2>
                <p className="mt-1.5 text-caption leading-5 text-ink-subtle">Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to read collected evidence. Development fixtures are never shown in production.</p>
              </section>
            )}

            <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.42fr)_minmax(390px,.78fr)]">
              <div className="space-y-5">
                <section id="roles" className="scroll-mt-16 border border-line bg-surface" aria-labelledby="forecast-list-title">
                  <div className="border-b border-line p-4 md:p-5">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between"><div><p className="label-caps text-accent-ink">{watchedOnly ? "Your watchlist" : "Early-career technical roles"}</p><h2 id="forecast-list-title" className="mt-1 text-lg font-semibold tracking-title">Roles and forecasts</h2><p className="mt-1 text-caption text-ink-subtle">Filter to what you are preparing for. Select a forecast to inspect its inputs and work-back plan.</p></div><span className="text-micro tabular text-ink-subtle">{isDemo ? "As of Aug 14, 2026" : "Live as of this request"}</span></div>
                    <div className="mt-4"><DashboardFiltersForm filters={filters} options={options} /></div>
                  </div>
                  {mode !== "unconfigured" && <ViewStatement filters={filters} summary={summary} />}
                  <div>
                    {items.map((item) => (
                      <div key={item.id}>
                        {item.forecast
                          ? <ForecastCard role={item.forecast} item={item} active={item.id === (selected?.id ?? "")} onSelect={() => { setSelectedId(item.id); setDrawerOpen(true); }} />
                          : <InsufficientRoleCard item={item} />}
                        {cap > 0 && item.companyRank === cap && item.companyTotal > cap && (
                          <Link href={dashboardHref(filters, { companies: [item.companyId] })} className="focus-ring flex min-h-touch items-center justify-between border-b border-line bg-surface-sunken px-4 py-2.5 text-caption font-semibold text-accent-ink hover:bg-surface-hover md:px-5">
                            Show all {item.companyTotal} roles at {item.company}
                            <Icon name="arrow-right" size={13} />
                          </Link>
                        )}
                      </div>
                    ))}
                    {items.length === 0 && mode !== "unconfigured" && emptyWatchlist && (
                      <EmptyState
                        icon="bell"
                        title="Your watchlist is empty"
                        description={
                          signedInAs
                            ? "Answer four questions and 1stSeen proposes roles to watch, or use Watch role on any role page. Watched roles collect here with their forecasts and preparation plans."
                            : "Sign in to keep a watchlist: the roles you are preparing for, with their forecasts and preparation plans in one place."
                        }
                        action={
                          <div className="flex flex-wrap justify-center gap-4">
                            {signedInAs
                              ? <Link href="/welcome" className="link-accent focus-ring text-xs">Set up your watchlist</Link>
                              : <Link href="/signin?return_to=%2F%3Fwatched%3D1" className="link-accent focus-ring text-xs">Sign in</Link>}
                            <Link href={dashboardHref(filters, { watchedOnly: false })} className="link-accent focus-ring text-xs">Browse every role</Link>
                          </div>
                        }
                      />
                    )}
                    {items.length === 0 && mode !== "unconfigured" && !emptyWatchlist && (
                      <EmptyState
                        icon="search"
                        title={pastLastPage ? "This page is past the last listed role" : applied.length ? "No roles match these filters" : "No in-scope role has been collected yet"}
                        description={
                          pastLastPage
                            ? undefined
                            : applied.length
                              ? `Each filter on its own excludes: ${applied.map((key) => `${filterName(key)} ${summary.exclusions[key].excluded}`).join(", ")}.`
                              : "Roles appear here once collection finds early-career technical postings."
                        }
                        action={
                          pastLastPage ? (
                            <Link href={dashboardHref(filters, { page: 1 })} className="link-accent focus-ring text-xs">Return to the first page</Link>
                          ) : relax ? (
                            <Link href={relax.href} className="link-accent focus-ring text-xs">Remove the {relax.name} filter to see {plural(relax.roles, "role")}</Link>
                          ) : undefined
                        }
                      />
                    )}
                  </div>
                  <div className="flex items-center justify-between border-t border-line px-4 py-3 text-micro text-ink-subtle">
                    <span>{items.length === 0 ? "0 listed" : `${pageStart + 1}–${pageStart + items.length} of ${summary.shownRoles} listed`}</span>
                    <span className="flex items-center gap-3">
                      {hasPreviousPage && <Link href={dashboardHref(filters, { page: filters.page - 1 })} className="focus-ring inline-flex min-h-touch items-center px-1 font-semibold text-accent-ink hover:underline">Previous</Link>}
                      {hasNextPage && <Link href={dashboardHref(filters, { page: filters.page + 1 })} className="focus-ring inline-flex min-h-touch items-center px-1 font-semibold text-accent-ink hover:underline">Next</Link>}
                    </span>
                  </div>
                </section>

                <RecruitingTimeline roles={timelineRoles} total={confirmedOpenings} />
              </div>

              <div className="space-y-5 xl:sticky xl:top-[78px]">
                {selected && <EvidenceDrawer role={selected} basis={selectedItem.basis} open={drawerOpen} onClose={() => setDrawerOpen(false)} />}
                <section className="border border-line bg-surface" aria-labelledby="changes-title"><div className="border-b border-line px-4 py-3"><p className="label-caps text-warning-ink">Since last run</p><h2 id="changes-title" className="mt-1 text-sm font-semibold">Forecast changes</h2></div><div className="px-4">{changeRecords.length === 0 ? <p className="py-5 text-caption text-ink-subtle">No material forecast revision has been recorded yet.</p> : changeRecords.map((change) => <ForecastChange key={change.id} change={change} roleName={change.role} />)}</div></section>
                <AgentActivity mode={mode} activity={agentActivity} />
              </div>
            </div>

            {/* Development fixtures stay labelled as such; what is true of every forecast is said once, in the site footer. */}
            {isDemo && (
              <footer className="mt-6 flex flex-col gap-2 border-t border-line py-4 text-micro leading-4 text-ink-subtle sm:flex-row sm:items-center sm:justify-between">
                <p>Development fixture · reserved .example sources · not live recruiting advice</p>
                <p>Every displayed count is derived from the fixture records on this page.</p>
              </footer>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
