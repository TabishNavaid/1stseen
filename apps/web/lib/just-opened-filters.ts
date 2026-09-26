import { DASHBOARD_PARAMS, appliedFilterKeys, dashboardHref, defaultDashboardFilters, parseDashboardFilters, type DashboardFilters, type FilterKey } from "./dashboard-query.ts";

/**
 * Which of the shared filters Just opened honours.
 *
 * The feed is a list of programs that have already opened, so the facets that describe a forecast — the window it
 * falls in, its confidence, how many cycles are behind it, how exact its dates are, whether a posting is listed now,
 * whether it is watched — have nothing to say about it and are not offered. What is left describes the program
 * itself, and every one of those reads the same query-string key it reads on the main list, so a view carries over
 * between the two.
 */
export const JUST_OPENED_PATH = "/opened";

export const JUST_OPENED_FACETS = ["query", "discipline", "type", "season", "company", "location"] as const satisfies readonly FilterKey[];

const KEPT = new Set<string>(JUST_OPENED_FACETS);

/** The shared filters with everything the feed does not use put back to its default, so a stray key cannot filter it. */
export function justOpenedFilters(params: Record<string, string | string[] | undefined>): DashboardFilters {
  const parsed = parseDashboardFilters(params);
  return {
    ...defaultDashboardFilters,
    query: parsed.query,
    disciplines: parsed.disciplines,
    types: parsed.types,
    seasons: parsed.seasons,
    companies: parsed.companies,
    locations: parsed.locations,
    page: parsed.page,
  };
}

/** A link to the feed with these filters, `changes` applied. */
export function justOpenedHref(filters: DashboardFilters, changes: Partial<DashboardFilters> = {}): string {
  return dashboardHref(filters, changes, JUST_OPENED_PATH);
}

/** Which of the feed's own facets are in force, for the count beside the Filters button and the chips under it. */
export function justOpenedApplied(filters: DashboardFilters): FilterKey[] {
  return appliedFilterKeys(filters).filter((key) => KEPT.has(key));
}

/** Every query-string key the feed reads, so a test can prove it ignores the rest. */
export const JUST_OPENED_PARAMS: readonly string[] = DASHBOARD_PARAMS.filter((key) => KEPT.has(key) || key === "page");
