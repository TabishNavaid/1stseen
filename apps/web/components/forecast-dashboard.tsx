"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { DashboardFiltersForm } from "@/components/dashboard-filters";
import { EvidenceDrawer } from "@/components/evidence-drawer";
import { ForecastCard } from "@/components/forecast-card";
import { ForecastChange } from "@/components/forecast-change";
import { InsufficientRoleCard } from "@/components/insufficient-role-card";
import { SkipFirstRunButton } from "@/components/onboarding/skip-first-run-button";
import { CountUp } from "@/components/count-up";
import { Icon, type IconName } from "@/components/ui/icon";
import { EmptyState } from "@/components/ui/status";
import { openedRoles } from "@/lib/demo-data";
import {
  DASHBOARD_PAGE_SIZE,
  appliedFilterKeys,
  dashboardHref,
  defaultDashboardFilters,
  emptyDashboardSummary,
  emptyFilterOptions,
  filterName,
  perCompanyLimit,
  programTypeLabel,
  relaxSuggestion,
  type DashboardFilterOptions,
  type DashboardFilters,
  type DashboardListItem,
  type DashboardSummary,
} from "@/lib/dashboard-query";
import { dashboardTiles } from "@/lib/dashboard-tiles";
import { formatShortDay } from "@/lib/dates";
import { PLAN_OUTCOME_MESSAGES } from "@/lib/onboarding";
import type { RealForecastChange, RealOpening } from "@/lib/real-data";

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
  signedInAs?: string | null;
  /** A signed-in account that has not finished or skipped the first run and follows nothing. */
  firstRun?: boolean;
  /** Set when the first run lands here because no chosen role has a forecast to plan from. */
  welcome?: "none" | null;
  /** A guest's own first-run picks, offered back on the default view (rendered from their browser's storage). */
  picks?: ReactNode;
};

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * What this view shows and what it leaves out, in numbers. Every filtered view names each applied filter and how
 * many in-scope roles it excludes on its own; the per-company collapse and the product scope are stated too.
 */
function ViewStatement({ filters, summary }: { filters: DashboardFilters; summary: DashboardSummary }) {
  const applied = appliedFilterKeys(filters);
  return (
    <div className="grid gap-1 text-caption leading-5 text-ink-muted">
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

/**
 * A count worth stating. A tile is drawn only when its number is not zero: an empty tile reads as a broken one. With an
 * href, the whole tile is the link to what it counts.
 */
function StatTile({ icon, label, value, detail, tone = "accent", href }: { icon: IconName; label: string; value: number; detail: ReactNode; tone?: "accent" | "warm"; href?: string }) {
  const body = (
    <>
      <p className="flex items-center gap-2 text-caption font-semibold text-ink-muted">
        <span className={`grid size-7 place-items-center rounded-full ${tone === "warm" ? "bg-warm-soft text-warm-ink" : "bg-accent-soft text-accent-ink"}`}><Icon name={icon} size={14} /></span>
        {label}
        {href && <Icon name="arrow-right" size={14} className="ml-auto text-accent-ink" />}
      </p>
      <div className="mt-3 flex items-baseline gap-2"><strong className="heading-display text-3xl tabular"><CountUp value={value} /></strong><span className="text-caption text-ink-subtle">{detail}</span></div>
    </>
  );
  return href
    ? <Link href={href} className="card lift focus-ring block p-5" data-stat-tile>{body}</Link>
    : <div className="card p-5" data-stat-tile>{body}</div>;
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
  signedInAs = null,
  firstRun = false,
  welcome = null,
  picks = null,
}: ForecastDashboardProps = {}) {
  // Real data never falls back to fixtures; an unconfigured deployment shows an
  // empty, clearly-labelled workspace instead of demo forecasts.
  const isDemo = mode === "demo";
  // The tile counts every exact opening of the last 45 days, the count the loader read, never a list's length.
  const confirmedOpenings = isDemo ? openedRoles.length : openingsTotal ?? openings.length;
  // One line per watched program whose window moved this week; the loader has already dropped the rest.
  const changeRecords = changes.map((change) => ({
    id: change.id,
    roleId: change.roleId,
    company: change.company,
    program: change.role,
    previousWindow: change.previousWindow,
    currentWindow: change.currentWindow,
    changedAt: formatShortDay(change.changedAt),
    notes: change.notes,
  }));
  const { watchedOnly } = filters;
  const forecasts = items.filter((item): item is DashboardListItem & { forecast: NonNullable<DashboardListItem["forecast"]> } => item.forecast !== null);
  const [selectedId, setSelectedId] = useState(forecasts[0]?.id ?? "");
  const [drawerOpen, setDrawerOpen] = useState(false);
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
  // Each tile only when its number is not zero; a guest follows nothing, so never sees the watched tile (lib/dashboard-tiles).
  const tiles = dashboardTiles({ openingWithin30Days: summary.openingWithin30Days, followedRoles: summary.followedRoles, confirmedOpenings, signedIn: signedInAs !== null }).map((tile) =>
    tile.key === "soon" ? <StatTile key="soon" icon="calendar-clock" label="Likely in 30 days" value={tile.value} detail={<>of {plural(summary.matchingForecastable, "forecast")} in this view</>} tone="warm" />
      : tile.key === "watched" ? <StatTile key="watched" icon="bell" label="Programs you watch" value={tile.value} detail={`${summary.followedForecastable} with a forecast`} />
        : <StatTile key="opened" icon="door-open" label="Just opened" value={tile.value} detail={tile.value === 1 ? "program opened in the last 45 days" : "programs opened in the last 45 days"} href="/opened" />,
  );
  // Only when a watched program's window actually moved this week: an empty panel beside the list reads as broken.
  const secondary = changeRecords.length > 0 ? (
    <section className="panel" aria-labelledby="changes-title">
      <div className="border-b border-line px-5 py-4"><h2 id="changes-title" className="text-sm font-semibold">What changed this week</h2></div>
      <div className="px-5">{changeRecords.map((change) => <ForecastChange key={change.id} change={change} />)}</div>
    </section>
  ) : null;
  return (
    <div className="flex-1 text-ink">
      <main id="dashboard-content" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-8 focus:outline-none md:px-6 md:py-10">
        {picks}
        <header className="flex flex-col gap-2">
          <h1 className="heading-display text-3xl leading-tight sm:text-4xl">{watchedOnly ? "Programs you watch" : "Explore programs"}</h1>
          <p className="max-w-2xl text-sm leading-6 text-ink-muted">
            {watchedOnly
              ? "The programs you saved, with their windows and prep plans."
              : "Every program 1stSeen follows, with the window it is likely to open in next. Open one to see what its window rests on."}
          </p>
        </header>

        {tiles.length > 0 && <section className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="At a glance">{tiles}</section>}

        {firstRun && mode === "real" && (
          <section className="card mt-8 flex flex-col gap-4 border-accent p-6 md:flex-row md:items-center md:justify-between" aria-labelledby="first-run-title">
            <div>
              <h2 id="first-run-title" className="heading-display text-xl">Start with a watchlist that fits</h2>
              <p className="mt-1.5 max-w-2xl text-sm leading-6 text-ink-muted">Three questions, and you get the programs that fit. Nothing is saved until you say so.</p>
            </div>
            <div className="flex shrink-0 flex-wrap items-start gap-2">
              <SkipFirstRunButton label="Not now" />
              <Link href="/welcome" className="focus-ring inline-flex h-11 items-center gap-2 rounded-chip bg-accent px-5 text-sm font-semibold text-ink-inverse hover:bg-accent-hover">Get started<Icon name="arrow-right" size={15} /></Link>
            </div>
          </section>
        )}

        {welcome === "none" && (
          <p role="status" className="mt-8 rounded-card border border-accent bg-accent-soft px-5 py-4 text-sm leading-6 text-ink">{PLAN_OUTCOME_MESSAGES.none}</p>
        )}

        {mode === "unconfigured" && (
          <section className="panel mt-8 p-6" aria-label="Evidence status">
            <h2 className="text-sm font-semibold">Live data is not configured</h2>
            <p className="mt-1.5 text-caption leading-5 text-ink-subtle">Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to read collected evidence. Development fixtures are never shown in production.</p>
          </section>
        )}

        <section id="roles" className="mt-8 scroll-mt-20" aria-labelledby="forecast-list-title">
          <h2 id="forecast-list-title" className="sr-only">Roles and forecasts</h2>
          <DashboardFiltersForm filters={filters} options={options} showWatched={signedInAs !== null || watchedOnly} />
          {mode !== "unconfigured" && (
            <details className="group mt-3">
              <summary className="focus-ring inline-flex min-h-touch cursor-pointer list-none items-center gap-1.5 rounded-chip px-2 text-caption font-semibold text-ink-muted hover:text-ink [&::-webkit-details-marker]:hidden">
                <Icon name="info" size={13} />
                {applied.length === 0 ? `${summary.inScopeRoles} roles, ${summary.forecastableRoles} with a forecast` : `${summary.matchingRoles} of ${summary.inScopeRoles} programs match`}
                <Icon name="chevron-down" size={12} className="transition-transform group-open:rotate-180" />
              </summary>
              <div className="mt-2 rounded-card border border-line bg-surface-sunken px-4 py-3"><ViewStatement filters={filters} summary={summary} /></div>
            </details>
          )}

          {items.length > 0 && (
            <ul className="mt-3 grid gap-3">
              {items.map((item) => (
                <li key={item.id} className="grid gap-2">
                  {item.forecast
                    ? <ForecastCard role={item.forecast} item={item} active={drawerOpen && item.id === (selected?.id ?? "")} onSelect={() => { setSelectedId(item.id); setDrawerOpen(true); }} />
                    : <InsufficientRoleCard item={item} />}
                  {cap > 0 && item.companyRank === cap && item.companyTotal > cap && (
                    <Link href={dashboardHref(filters, { companies: [item.companyId] })} className="focus-ring flex min-h-touch items-center justify-between rounded-card border border-dashed border-line-strong px-5 py-2.5 text-caption font-semibold text-accent-ink hover:bg-surface-hover">
                      Show all {item.companyTotal} roles at {item.company}
                      <Icon name="arrow-right" size={13} />
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          )}
          {items.length === 0 && mode !== "unconfigured" && emptyWatchlist && (
            <div className="card mt-4">
              <EmptyState
                doodle="plant"
                title="Your watchlist is empty"
                description={
                  signedInAs
                    ? "Answer three quick questions and 1stSeen suggests programs to watch, or use Save to my watchlist on any program page. Programs you save collect here with their windows and prep plans."
                    : "Sign in to keep a watchlist: the programs you are preparing for, with their windows and prep plans in one place."
                }
                action={
                  <div className="flex flex-wrap justify-center gap-4">
                    {signedInAs
                      ? <Link href="/welcome" className="link-accent focus-ring text-xs">Set up your watchlist</Link>
                      : <Link href="/signin?return_to=%2Froles%3Fwatched%3D1" className="link-accent focus-ring text-xs">Sign in</Link>}
                    <Link href={dashboardHref(filters, { watchedOnly: false })} className="link-accent focus-ring text-xs">Browse every program</Link>
                  </div>
                }
              />
            </div>
          )}
          {items.length === 0 && mode !== "unconfigured" && !emptyWatchlist && (
            <div className="card mt-4">
              <EmptyState
                doodle="readingSide"
                bird="confused"
                title={pastLastPage ? "This page is past the last listed program" : applied.length ? "No programs match these filters" : "No program has been collected yet"}
                description={
                  pastLastPage
                    ? undefined
                    : applied.length
                      ? `Each filter on its own excludes: ${applied.map((key) => `${filterName(key)} ${summary.exclusions[key].excluded}`).join(", ")}.`
                      : "Programs appear here once collection finds early-career technical postings."
                }
                action={
                  pastLastPage ? (
                    <Link href={dashboardHref(filters, { page: 1 })} className="link-accent focus-ring text-xs">Return to the first page</Link>
                  ) : relax ? (
                    <Link href={relax.href} className="link-accent focus-ring text-xs">Remove the {relax.name} filter to see {plural(relax.roles, "role")}</Link>
                  ) : undefined
                }
              />
            </div>
          )}
          {items.length > 0 && (
            <nav className="mt-4 flex flex-wrap items-center justify-between gap-2 px-1 text-caption text-ink-subtle" aria-label="Pages">
              <span>{`${pageStart + 1}–${pageStart + items.length} of ${summary.shownRoles} listed`}</span>
              <span className="flex items-center gap-2">
                {hasPreviousPage && <Link href={dashboardHref(filters, { page: filters.page - 1 })} className="focus-ring inline-flex min-h-touch items-center gap-1 rounded-chip border border-line-strong bg-surface px-4 font-semibold text-ink hover:bg-surface-hover"><Icon name="arrow-left" size={13} />Previous</Link>}
                {hasNextPage && <Link href={dashboardHref(filters, { page: filters.page + 1 })} className="focus-ring inline-flex min-h-touch items-center gap-1 rounded-chip border border-line-strong bg-surface px-4 font-semibold text-ink hover:bg-surface-hover">Next<Icon name="arrow-right" size={13} /></Link>}
              </span>
            </nav>
          )}
        </section>

        {secondary && <div className="mt-12 max-w-2xl">{secondary}</div>}

        {/* Development fixtures stay labelled as such; what is true of every forecast is said once, in the site footer. */}
        {isDemo && (
          <footer className="mt-8 flex flex-col gap-2 border-t border-line py-4 text-micro leading-4 text-ink-subtle sm:flex-row sm:items-center sm:justify-between">
            <p>Development fixture · reserved .example sources · not live recruiting advice</p>
            <p>Every displayed count is derived from the fixture records on this page.</p>
          </footer>
        )}
      </main>
      {/* The shared contract's track knows only Internship and New grad, so the role's own program type names it. */}
      {selected && <EvidenceDrawer role={selected} basis={selectedItem.basis} outlook={selectedItem.outlook} programType={selectedItem.programType ? programTypeLabel(selectedItem.programType) : undefined} open={drawerOpen} onClose={() => setDrawerOpen(false)} />}
    </div>
  );
}
