import "server-only";

import type { CalendarEvent } from "@/lib/calendar-data";
import { createPublicReader, type PublicReader } from "@/lib/public-read";
import { basisPhrase, forecastBasis, type ForecastBasis } from "@/lib/forecast-basis";
import { forecastIsCurrent, noForecastExplanation, noForecastReason } from "@/lib/forecast-gap";
import { createAdminClient } from "@/lib/supabase/admin";
import { PROVENANCE_PAGE_SIZE } from "@/lib/role-view";
import type {
  DatePrecision,
  RoleCycle,
  RoleForecastVersion,
  RoleProvenanceGroup,
  RoleProvenanceItem,
  RoleView,
} from "@/lib/role-view";
import { formatDay, utcDate as isoDate } from "@/lib/dates";
import { displayCompany, displayPlace, displayTitle, tidyTitle, type RecordedTitle } from "@/lib/display-names";
import {
  DASHBOARD_PAGE_SIZE,
  FILTER_KEYS,
  emptyDashboardSummary,
  emptyFilterOptions,
  filterRpcArgs,
  perCompanyLimit,
  programTypeLabel,
  type DashboardFilterOptions,
  type DashboardFilters,
  type DashboardListItem,
  type DashboardSummary,
  type Exclusion,
  type FilterKey,
} from "@/lib/dashboard-query";
import { fetchAll, fetchAllIn } from "@/lib/supabase/paging";
import type { ForecastRole } from "@firstseen/shared";
import { factorLabel, factorTone } from "@/lib/presentation";
import { REPLAY_PAGE_SIZE, type ReplayFilters, type ReplayOutcome } from "@/lib/replay-query";

/**
 * Real Supabase-backed reads for the product surfaces.
 *
 * Every field below comes from a persisted record. Nothing is synthesised: a role
 * forecasting.py refused is listed without a window and says why (`lib/forecast-gap`),
 * and every stored forecast is rendered with the recruiting cycles behind it.
 */

export type DataMode = "real" | "demo" | "unconfigured";

export type RealDashboardData = {
  mode: DataMode;
  /** One page of in-scope roles, filtered, ordered, collapsed per company, and paged in Postgres. */
  items: DashboardListItem[];
  /** Every count and exclusion the dashboard states, from the same filters as the page. */
  summary: DashboardSummary;
  /** The values each filter offers, with in-scope role counts. */
  options: DashboardFilterOptions;
  /** Confirmed openings: exact source-supplied publication dates only. */
  recentOpenings: RealOpening[];
  /** Every exact opening in the same 45 days, of which recentOpenings is the newest dozen. */
  recentOpeningsTotal: number;
  /** Immutable before/after forecast revisions, newest first. */
  recentChanges: RealForecastChange[];
};

export type RealOpening = {
  id: string;
  roleId: string;
  company: string;
  role: string;
  /** Program type and place, in words (lib/dashboard-query, lib/display-names). */
  programType: string;
  place: string;
  openedOn: string;
  observedAt: string | null;
  applyUrl: string | null;
};

export type RealForecastChange = {
  id: string;
  roleId: string;
  company: string;
  role: string;
  previousWindow: string;
  currentWindow: string;
  confidenceDelta: number;
  changedAt: string;
  reasons: string[];
  /** The basis of the forecast it changed to (lib/forecast-basis). */
  basis: ForecastBasis | null;
};

export function hasServiceRoleConfig(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function initials(company: string): string {
  const parts = company.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase().slice(0, 2);
}



/** A PostgREST to-one embed arrives as an object, or as a one-element array through some joins. */
function embeddedOne<T>(value: T | T[] | null | undefined): T | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

type DashboardPageRow = {
  role_id: string;
  company_id: string;
  company_name: string;
  canonical_title: string;
  discipline: string | null;
  program_type: string | null;
  season: string;
  target_year: number | null;
  location_scope: string;
  level: string;
  forecastable: boolean;
  point_date: string | null;
  window_start: string;
  window_end: string;
  confidence: number | string;
  confidence_factors: Record<string, number> | null;
  history_count: number | null;
  days_until: number;
  exact_events: number;
  bounded_events: number;
  observed_events: number;
  listed_now: boolean;
  is_followed: boolean;
  company_rank: number;
  company_total: number;
  cycles: { opened_on: string; date_precision: string; source_type: string | null }[] | null;
};

type SummaryCount =
  | "in_scope_roles" | "outside_scope_roles" | "forecastable_roles" | "insufficient_roles" | "matching_roles"
  | "matching_forecastable" | "matching_insufficient" | "shown_roles" | "collapsed_roles" | "collapsed_companies"
  | "opening_within_30_days" | "followed_roles" | "followed_forecastable";

type SummaryRow = Record<SummaryCount, number | string> & {
  exclusions: Partial<Record<FilterKey, Partial<Exclusion>>> | null;
};

type FilterOptionRow = { facet: string; value: string; label: string; roles: number | string };

function toForecastRole(row: DashboardPageRow, names: { company: string; role: string }): ForecastRole {
  const cycles = row.cycles ?? [];
  const factors = (row.confidence_factors ?? {}) as Record<string, number>;
  return {
    id: row.role_id,
    company: names.company,
    companyMark: initials(names.company),
    role: names.role,
    track: row.program_type === "new_grad" || row.program_type === "graduate_program" ? "New grad" : "Internship",
    location: row.location_scope || "unspecified",
    window: `${formatDay(row.window_start)} – ${formatDay(row.window_end)}`,
    daysUntil: row.days_until,
    confidence: Number(row.confidence),
    // Readiness is only real once planner milestones exist for a signed-in user.
    readiness: 0,
    status: "quiet",
    // Dates only: what each date's evidence class means is the role page's History section, not a label on a list.
    historicalCycles: cycles.map((item) => formatDay(item.opened_on)),
    signalSummary: `${cycles.length} opening event${cycles.length === 1 ? "" : "s"} on record; the forecast uses ${row.history_count} recruiting cycle${row.history_count === 1 ? "" : "s"}.`,
    nextDeadline: "Sign in to generate a readiness plan",
    deadlines: [],
    confidenceFactors: Object.entries(factors)
      .slice(0, 6)
      .map(([key, value]) => ({
        label: factorLabel(key),
        value: Number(value).toFixed(2),
        tone: factorTone(key, Number(value)),
      })),
    evidence: cycles.slice(0, 6).map((item) => ({
      // Plain words that keep the classes apart: a date the board published, a range, or a date it was seen open by.
      label: item.date_precision === "observed_by" ? "Seen open by" : item.date_precision === "bounded" ? "Opened by" : "Opened",
      detail: item.source_type === "wayback" ? "Seen in an archived copy of the careers page." : "Published on the company's job board.",
      date: formatDay(item.opened_on),
      // Archive captures and live postings are different evidence classes.
      kind: item.source_type === "wayback" ? ("archive" as const) : ("posting" as const),
    })),
  } satisfies ForecastRole;
}

function toListItem(row: DashboardPageRow, recorded: ReadonlyMap<string, RecordedTitle[]> = new Map()): DashboardListItem {
  const names = { company: displayCompany(row.company_name), role: displayTitle(row.canonical_title, recorded.get(row.role_id)) };
  return {
    id: row.role_id,
    companyId: row.company_id,
    company: names.company,
    role: names.role,
    discipline: row.discipline,
    programType: row.program_type,
    season: row.season,
    targetYear: row.target_year,
    location: row.location_scope,
    listedNow: row.listed_now,
    followed: row.is_followed,
    forecastable: row.forecastable,
    historyCount: row.history_count,
    exactEvents: row.exact_events,
    boundedEvents: row.bounded_events,
    observedEvents: row.observed_events,
    companyRank: row.company_rank,
    companyTotal: row.company_total,
    // Every stored forecast is shown with the cycles behind it (migration 202608140035); only a role forecasting.py
    // refused has no window.
    forecast: row.forecastable ? toForecastRole(row, names) : null,
    // The plain-language date: "Likely around" the expected opening, with its window underneath.
    outlook: row.forecastable && row.point_date ? { expected: row.point_date, start: row.window_start, end: row.window_end } : null,
    confidence: row.forecastable ? Number(row.confidence) : null,
    basis: null,
  };
}

/**
 * Each role's titles as companies published them (role_aliases), for showing a title with its accents and punctuation
 * (lib/display-names.ts). Every alias of the listed roles, paged to exhaustion.
 */
export async function loadRecordedTitles(reader: PublicReader, roleIds: string[]): Promise<Map<string, RecordedTitle[]>> {
  const titles = new Map<string, RecordedTitle[]>();
  if (roleIds.length === 0) return titles;
  const rows = await fetchAllIn<Record<string, unknown>>(
    (ids) => reader.from("role_aliases", "id,canonical_role_id,alias_title,last_seen_at").in("canonical_role_id", ids),
    [...new Set(roleIds)],
    "role_aliases",
    "id",
  );
  for (const row of rows) {
    const roleId = String(row.canonical_role_id);
    titles.set(roleId, [...(titles.get(roleId) ?? []), { title: String(row.alias_title), lastSeenAt: String(row.last_seen_at) }]);
  }
  return titles;
}

/**
 * Each role's forecast basis, from its latest forecast's date weights (`forecast_basis`, migration 202608140040), for a
 * surface that lists roles without their forecast ids. The function takes at most 1000 ids, so a longer list is read in
 * chunks and nothing is truncated.
 */
export async function loadForecastBasis(reader: PublicReader, roleIds: string[]): Promise<Map<string, ForecastBasis & { forecastId: string }>> {
  const basis = new Map<string, ForecastBasis & { forecastId: string }>();
  for (let start = 0; start < roleIds.length; start += FORECAST_BASIS_CHUNK) {
    const chunk = roleIds.slice(start, start + FORECAST_BASIS_CHUNK);
    // bounded: one row per role id, and a chunk holds FORECAST_BASIS_CHUNK (500) ids; the function refuses over 1000.
    const { data, error } = await reader.rpc("forecast_basis", { p_role_ids: chunk });
    if (error) throw new Error("forecast_basis_read_failed");
    for (const row of (data ?? []) as { role_id: string; forecast_id: string; own_weight: number | string; borrowed_weight: number | string }[]) {
      const value = forecastBasis(Number(row.own_weight), Number(row.borrowed_weight));
      if (value) basis.set(row.role_id, { ...value, forecastId: row.forecast_id });
    }
  }
  return basis;
}

/** Each forecast's basis by forecast id (`forecast_basis_for_forecasts`), for a surface that holds the forecast it shows. */
export async function loadForecastBasisById(reader: PublicReader, forecastIds: string[]): Promise<Map<string, ForecastBasis>> {
  const basis = new Map<string, ForecastBasis>();
  const unique = [...new Set(forecastIds)];
  for (let start = 0; start < unique.length; start += FORECAST_BASIS_CHUNK) {
    // bounded: one row per forecast id, and a chunk holds FORECAST_BASIS_CHUNK (500) ids; the function refuses over 1000.
    const { data, error } = await reader.rpc("forecast_basis_for_forecasts", { p_forecast_ids: unique.slice(start, start + FORECAST_BASIS_CHUNK) });
    if (error) throw new Error("forecast_basis_read_failed");
    for (const row of (data ?? []) as { forecast_id: string; own_weight: number | string; borrowed_weight: number | string }[]) {
      const value = forecastBasis(Number(row.own_weight), Number(row.borrowed_weight));
      if (value) basis.set(row.forecast_id, value);
    }
  }
  return basis;
}

const FORECAST_BASIS_CHUNK = 500;

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function toSummary(row: SummaryRow): DashboardSummary {
  const count = (key: SummaryCount) => Number(row[key] ?? 0);
  return {
    inScopeRoles: count("in_scope_roles"),
    outsideScopeRoles: count("outside_scope_roles"),
    forecastableRoles: count("forecastable_roles"),
    insufficientRoles: count("insufficient_roles"),
    matchingRoles: count("matching_roles"),
    matchingForecastable: count("matching_forecastable"),
    matchingInsufficient: count("matching_insufficient"),
    shownRoles: count("shown_roles"),
    collapsedRoles: count("collapsed_roles"),
    collapsedCompanies: count("collapsed_companies"),
    openingWithin30Days: count("opening_within_30_days"),
    followedRoles: count("followed_roles"),
    followedForecastable: count("followed_forecastable"),
    exclusions: Object.fromEntries(
      FILTER_KEYS.map((key) => {
        const item = row.exclusions?.[key];
        return [key, { excluded: Number(item?.excluded ?? 0), without: Number(item?.without ?? 0) }];
      }),
    ) as Record<FilterKey, Exclusion>,
  };
}

function toOptions(rows: FilterOptionRow[]): DashboardFilterOptions {
  const options: DashboardFilterOptions = { discipline: [], type: [], season: [], year: [], company: [], location: [] };
  for (const row of rows) {
    if (row.facet in options) {
      options[row.facet as keyof DashboardFilterOptions].push({ value: row.value, label: row.facet === "company" ? displayCompany(row.label) : row.label, roles: Number(row.roles) });
    }
  }
  options.company.sort((a, b) => a.label.localeCompare(b.label));
  options.location.sort((a, b) => b.roles - a.roles || a.label.localeCompare(b.label));
  options.year.sort((a, b) => b.value.localeCompare(a.value));
  return options;
}

/** The dashboard's filter facets alone (the first run's company search reads them), paged like a table. */
export async function loadDashboardFilterOptions(reader: PublicReader = createPublicReader()): Promise<DashboardFilterOptions> {
  // One row per facet value; the company and location facets grow with the corpus.
  const rows = await fetchAll<FilterOptionRow>(() => reader.rpc("dashboard_filter_options"), "dashboard_filter_options", ["facet", "value"]);
  return toOptions(rows);
}

/**
 * Load one page of the dashboard. Returns `unconfigured` rather than fixtures when the service-role credentials are
 * absent, so a deployment can never silently present development data as live intelligence.
 *
 * Filtering, search, ordering, the per-company collapse, counting, and paging run in Postgres (migration
 * 202608140029_dashboard_filters). The Worker receives one page of rows, a fixed set of counts, and the filter options.
 */
export async function loadRealDashboard(
  userId: string | null,
  filters: DashboardFilters,
  now: Date = new Date(),
): Promise<RealDashboardData> {
  if (!hasServiceRoleConfig()) {
    return { mode: "unconfigured", items: [], summary: emptyDashboardSummary, options: emptyFilterOptions, recentOpenings: [], recentOpeningsTotal: 0, recentChanges: [] };
  }

  // A guest render reads only through the public reader, with no user. A signed-in render's user id only marks the
  // roles it follows, so it calls the same two functions with the service role and that id; nothing else differs.
  const reader = createPublicReader();
  const member = userId ? createAdminClient() : null;
  const args = { p_now: now.toISOString(), p_user_id: userId, ...filterRpcArgs(filters) };
  const perCompany = perCompanyLimit(filters);
  const pageArgs = {
    ...args,
    p_sort: filters.sort,
    p_per_company: perCompany,
    p_limit: DASHBOARD_PAGE_SIZE,
    p_offset: (filters.page - 1) * DASHBOARD_PAGE_SIZE,
  };
  const summaryArgs = { ...args, p_per_company: perCompany };
  const [page, summary, options, recent, recentChanges] = await Promise.all([
    // bounded: dashboard_role_page returns at most p_limit rows, one page of DASHBOARD_PAGE_SIZE.
    member ? member.rpc("dashboard_role_page", pageArgs) : reader.rpc("dashboard_role_page", pageArgs),
    // bounded: dashboard_role_summary returns one row of counts.
    (member ? member.rpc("dashboard_role_summary", summaryArgs) : reader.rpc("dashboard_role_summary", summaryArgs)).single(),
    // One row per facet value; the company and location facets grow with the corpus, so it is paged like a table.
    fetchAll<FilterOptionRow>(() => reader.rpc("dashboard_filter_options"), "dashboard_filter_options", ["facet", "value"])
      .then((data) => ({ data, error: null })),
    loadRecentOpenings(reader),
    loadRecentChanges(reader),
  ]);
  if (page.error || summary.error || options.error) {
    throw new Error("dashboard_read_failed");
  }
  const rows = (page.data ?? []) as DashboardPageRow[];
  const [basis, recorded] = await Promise.all([
    loadForecastBasis(reader, rows.filter((row) => row.forecastable).map((row) => row.role_id)),
    loadRecordedTitles(reader, rows.map((row) => row.role_id)),
  ]);
  const items = rows.map((row) => toListItem(row, recorded));

  return {
    mode: "real",
    items: items.map((item) => ({ ...item, basis: basis.get(item.id) ?? null })),
    summary: toSummary(summary.data as SummaryRow),
    options: toOptions((options.data ?? []) as FilterOptionRow[]),
    recentOpenings: recent.openings,
    recentOpeningsTotal: recent.total,
    recentChanges,
  };
}

type EmbeddedRoleIdentity = {
  canonical_title: string;
  companies: { name: string } | { name: string }[] | null;
};

function roleIdentity(value: unknown): { role: string; company: string } | null {
  const role = embeddedOne(value as EmbeddedRoleIdentity | EmbeddedRoleIdentity[] | null);
  const company = role ? embeddedOne(role.companies) : null;
  return role && company ? { role: tidyTitle(role.canonical_title), company: displayCompany(company.name) } : null;
}

function daysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/**
 * Confirmed openings only.
 *
 * `exact` is the single precision class backed by a source-supplied publication
 * timestamp, so it is the only one that may be presented as a real opening date.
 * Archive `observed_by` evidence proves visibility, never an opening event.
 */
/** How many openings the Just opened page lists at a time, and how far back it looks. */
export const JUST_OPENED_PAGE_SIZE = 30;
export const JUST_OPENED_DAYS = 45;

/**
 * Programs that opened in the last 45 days, newest first: only exact openings, the job board's own publication dates, so
 * "opened" is never an inference. One page of them with the total over all of them, both read from the same filtered set.
 */
export async function loadJustOpened(
  reader: PublicReader = createPublicReader(),
  { limit = JUST_OPENED_PAGE_SIZE, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<{ openings: RealOpening[]; total: number }> {
  const since = daysAgo(JUST_OPENED_DAYS);
  // Out-of-scope roles stay as evidence; no product surface lists them, nor a retired or
  // withdrawn one (migration 202608140036). The list and its total read the same filtered set.
  const exactOpenings = <Query extends { eq: (column: string, value: unknown) => Query; gte: (column: string, value: string) => Query }>(query: Query) =>
    query
      .eq("canonical_roles.scope_status", "in_scope")
      .eq("canonical_roles.active", true)
      .eq("date_precision", "exact")
      .gte("opened_on", since);
  const [result, counted] = await Promise.all([
    // bounded: one page of at most `limit` (JUST_OPENED_PAGE_SIZE), beside the total counted below.
    exactOpenings(reader.from("historical_opening_events", "id,canonical_role_id,opened_on,raw_job_observations(apply_url,source_url,observed_at),canonical_roles!inner(canonical_title,early_career_type,location_scope,scope_status,companies(name))"))
      .order("opened_on", { ascending: false })
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1),
    exactOpenings(reader.count("historical_opening_events", "id,canonical_roles!inner(scope_status)")),
  ]);
  if (result.error || counted.error || counted.count == null) throw new Error("recent_openings_read_failed");
  const rows = result.data ?? [];
  const recorded = await loadRecordedTitles(reader, rows.map((row) => String(row.canonical_role_id)));
  const openings = rows.flatMap((row) => {
    const role = embeddedOne(row.canonical_roles as EmbeddedRoleIdentity | EmbeddedRoleIdentity[] | null) as (EmbeddedRoleIdentity & { early_career_type?: string | null; location_scope?: string | null }) | null;
    const company = role ? embeddedOne(role.companies) : null;
    if (!role || !company) return [];
    const observation = embeddedOne(row.raw_job_observations as Record<string, unknown> | Record<string, unknown>[] | null);
    return [{
      id: row.id as string,
      roleId: row.canonical_role_id as string,
      company: displayCompany(company.name),
      role: displayTitle(role.canonical_title, recorded.get(String(row.canonical_role_id))),
      programType: programTypeLabel(role.early_career_type ?? null),
      place: displayPlace(role.location_scope),
      openedOn: row.opened_on as string,
      observedAt: (observation?.observed_at as string | null) ?? null,
      applyUrl: (observation?.apply_url as string | null) ?? (observation?.source_url as string | null) ?? null,
    }];
  });
  return { openings, total: counted.count };
}

async function loadRecentOpenings(reader: PublicReader): Promise<{ openings: RealOpening[]; total: number }> {
  // The roles view states only the total; it links to Just opened for the list.
  return loadJustOpened(reader, { limit: 1 });
}

/** Material forecast revisions, read from the immutable before/after lineage. */
async function loadRecentChanges(reader: PublicReader): Promise<RealForecastChange[]> {
  // bounded: the 8 newest material revisions, listed as recent changes with no total stated.
  const changes = await reader
    .from("forecast_changes", "id,before_forecast_id,after_forecast_id,confidence_delta,reasons,created_at,material")
    .eq("material", true)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(8);
  const rows = changes.data ?? [];
  if (!rows.length) return [];
  const ids = rows.flatMap((row) => [row.before_forecast_id as string, row.after_forecast_id as string]);
  // bounded: at most 16 rows, the before and after forecasts of the 8 changes above, by primary key.
  const forecasts = await reader
    .from("forecasts", "id,canonical_role_id,window_start,window_end,canonical_roles!inner(canonical_title,scope_status,companies(name))")
    .eq("canonical_roles.scope_status", "in_scope")
    .eq("canonical_roles.active", true)
    .in("id", ids);
  const byId = new Map((forecasts.data ?? []).map((row) => [row.id as string, row]));
  const bases = await loadForecastBasisById(reader, rows.map((row) => row.after_forecast_id as string));
  return rows.flatMap((row) => {
    const before = byId.get(row.before_forecast_id as string);
    const after = byId.get(row.after_forecast_id as string);
    if (!before || !after) return [];
    const identity = roleIdentity(after.canonical_roles);
    if (!identity) return [];
    return [{
      id: row.id as string,
      roleId: after.canonical_role_id as string,
      company: identity.company,
      role: identity.role,
      previousWindow: `${formatDay(before.window_start as string)} – ${formatDay(before.window_end as string)}`,
      currentWindow: `${formatDay(after.window_start as string)} – ${formatDay(after.window_end as string)}`,
      confidenceDelta: Number(row.confidence_delta),
      changedAt: row.created_at as string,
      reasons: (row.reasons as string[]) ?? [],
      basis: bases.get(row.after_forecast_id as string) ?? null,
    }];
  });
}

const precisionOrder: DatePrecision[] = ["exact", "bounded", "observed_by"];

function isPrecision(value: unknown): value is DatePrecision {
  return typeof value === "string" && (precisionOrder as string[]).includes(value);
}

/** A role's company and title, when it is in the product: in scope and active. Null for any other id. */
/** A role id is a UUID; anything else names no role, and is not sent to the database (where it would be an error). */
const ROLE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function loadRealRoleIdentity(roleId: string): Promise<{ company: string; role: string } | null> {
  if (!hasServiceRoleConfig() || !ROLE_ID.test(roleId)) return null;
  // bounded: one row, the role by its primary key.
  const { data, error } = await createPublicReader()
    .from("canonical_roles", "id,canonical_title,companies(name)")
    .eq("id", roleId)
    .eq("scope_status", "in_scope")
    .eq("active", true)
    .maybeSingle();
  // A failed read is not a missing role: it propagates, and the page shows that the data could not be loaded.
  if (error) throw new Error("role_read_failed");
  if (!data) return null;
  const company = embeddedOne(data.companies as { name: string } | { name: string }[] | null);
  return company ? { company: displayCompany(company.name), role: tidyTitle(String(data.canonical_title)) } : null;
}

/**
 * The complete real detail record for one canonical role.
 *
 * Returns `null` only when the role id does not exist in this deployment. A role
 * that exists but cannot be forecast returns a view with `forecast: null` and a
 * populated `insufficientEvidence` explanation — never a fabricated window.
 */
export async function loadRealRoleView(
  roleId: string,
  userId?: string | null,
  provenancePage = 1,
): Promise<RoleView | null> {
  if (!hasServiceRoleConfig() || !ROLE_ID.test(roleId)) return null;
  const reader = createPublicReader();
  // User-owned rows (this user's milestones and follow) are read only when there is a session.
  const member = userId ? createAdminClient() : null;
  // bounded: one row, the role by its primary key.
  const roleResult = await reader
    .from("canonical_roles", "id,company_id,canonical_title,track,level,location_scope,role_family,recruiting_season,forecast_refused_at,forecast_refusal_reason,companies(id,name,domain,careers_url)")
    .eq("id", roleId)
    // A role outside the product's scope has no page, exactly like a role that does not exist, and neither has a retired
    // or withdrawn one (migration 202608140036).
    .eq("scope_status", "in_scope")
    .eq("active", true)
    .maybeSingle();
  // A read that failed is not a role that does not exist: with the database down, the page said "404: This page could
  // not be found" for a role that exists. The error propagates to the page's error view instead.
  if (roleResult.error) throw new Error("role_read_failed");
  if (!roleResult.data) return null;
  const role = roleResult.data as Record<string, unknown>;
  const companyRaw = role.companies as
    | { id: string; name: string; domain: string; careers_url: string | null }
    | Array<{ id: string; name: string; domain: string; careers_url: string | null }>
    | null;
  const company = Array.isArray(companyRaw) ? companyRaw[0] : companyRaw;
  if (!company) return null;

  // Every cycle and every linked observation: the page counts both ("Linked observations", the cycle list), so a capped
  // read would show a capped count as the total.
  // Read beside the evidence; awaited where the title is built, and never left as an unhandled rejection meanwhile.
  const recordedTitles = loadRecordedTitles(reader, [roleId]);
  recordedTitles.catch(() => undefined);
  const [forecastsResult, eventsResult, signalsResult, matchesResult] = await Promise.all([
    fetchAll(
      () =>
        reader
          .from("forecasts", "id,as_of,point_date,window_start,window_end,confidence,confidence_factors,method,model_version,history_count,input_fingerprint,forecasted_at,calibrated_probability,prior_effective_sample_size")
          .eq("canonical_role_id", roleId)
          .order("as_of", { ascending: false })
          .order("forecasted_at", { ascending: false }),
      "role_forecasts",
      "id",
    ).then((data) => ({ data, error: null })),
    fetchAll(
      () =>
        reader
          .from("historical_opening_events", "id,opened_on,closed_on,opening_window_start,opening_window_end,date_precision,uncertainty_days,uncertainty_reason,evidence_quote,raw_job_observations(id,source_type,source_url,observed_at,archive_capture_at)")
          .eq("canonical_role_id", roleId)
          .order("opened_on", { ascending: false }),
      "role_opening_events",
      "id",
    ).then((data) => ({ data, error: null })),
    // bounded: the 12 newest signals; the section lists current signals and states no count.
    reader
      .from("signals", "id,kind,observed_at,strength,reliability,evidence_quote,source_url,extraction_method")
      .eq("canonical_role_id", roleId)
      .order("observed_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(12),
    fetchAll(
      () =>
        reader
          .from("observation_role_matches", "observation_id,evidence_kind,raw_job_observations(id,raw_title,apply_url,source_url,published_at,last_seen_at,source_type)")
          .eq("canonical_role_id", roleId)
          .eq("evidence_kind", "observation_resolution"),
      "role_observation_matches",
      "observation_id",
    ).then((data) => ({ data, error: null })),
  ]);

  // Any read that fails fails the page: an empty signals list would otherwise say no signal was ever recorded.
  if (signalsResult.error) throw new Error("role_signals_read_failed");
  const forecasts = forecastsResult.data ?? [];
  // The newest stored forecast, unless the model has declined the role since: then it has no current forecast, and
  // the stored versions are history (migration 202608140043).
  const refusedAt = (role.forecast_refused_at as string | null) ?? null;
  const latest = forecasts[0] && forecastIsCurrent(forecasts[0].forecasted_at as string, refusedAt) ? forecasts[0] : undefined;
  const forecastRefusal = forecasts[0] && !latest && refusedAt
    ? { refusedAt, reason: String(role.forecast_refusal_reason ?? "The model could not forecast this role from its current evidence.") }
    : null;

  const [provenanceResult, changesResult, milestoneResult, watchResult, versionBasis] = await Promise.all([
    // Every row, not a silent first page: a `.limit(60)` here showed 60 of this role's 114
    // contributions under the heading "exactly what contributed to this forecast", and said nothing
    // about the other 54. `fetchAll` is the same paging every other unbounded read uses.
    latest
      ? fetchAll(
          () =>
            reader
              .from("forecast_provenance", "observation_id,source_url,observed_at,content_hash,extraction_method,contribution,weight,rationale,date_precision,signal_kind")
              .eq("forecast_id", latest.id)
              .order("weight", { ascending: false }),
          "forecast_provenance",
          "evidence_id",
        ).then((data) => ({ data, error: null }))
      : Promise.resolve({ data: [], error: null }),
    forecasts.length
      ? fetchAllIn(
          (ids) => reader
            .from("forecast_changes", "id,after_forecast_id,confidence_delta,point_date_delta_days,material,reasons,created_at")
            .in("after_forecast_id", ids),
          forecasts.map((item) => item.id as string),
          "role_forecast_changes",
          "id",
        ).then((data) => ({ data, error: null }))
      : Promise.resolve({ data: [], error: null }),
    member && userId
      ? fetchAll(
          () => member
            .from("readiness_milestones")
            .select("id,kind,due_on,ideal_due_on,lead_days,policy_version,rationale,completed_at")
            .eq("user_id", userId)
            .eq("canonical_role_id", roleId)
            .order("due_on", { ascending: true }),
          "role_milestones",
          "id",
        ).then((data) => ({ data, error: null }))
      : Promise.resolve({ data: [], error: null }),
    member && userId
      // bounded: at most one row; watchlist_items_role_key is unique on (user_id, canonical_role_id) for a role follow.
      ? member
          .from("watchlist_items")
          .select("id")
          .eq("user_id", userId)
          .eq("target_type", "canonical_role")
          .eq("canonical_role_id", roleId)
          .maybeSingle()
      : Promise.resolve({ data: null, error: null }),
    // Each shown version's basis, by its own forecast id (lib/forecast-basis): the current one and up to seven before it.
    loadForecastBasisById(reader, forecasts.slice(0, 8).map((row) => row.id as string)),
  ]);

  if (watchResult.error) throw new Error("role_follow_read_failed");
  const cycles: RoleCycle[] = (eventsResult.data ?? []).map((row) => {
    const observation = (Array.isArray(row.raw_job_observations)
      ? row.raw_job_observations[0]
      : row.raw_job_observations) as Record<string, unknown> | null;
    const sourceType = String(observation?.source_type ?? "unknown");
    return {
      id: row.id as string,
      openedOn: row.opened_on as string,
      closedOn: (row.closed_on as string | null) ?? null,
      windowStart: (row.opening_window_start as string | null) ?? null,
      windowEnd: row.opening_window_end as string,
      precision: isPrecision(row.date_precision) ? row.date_precision : "observed_by",
      uncertaintyDays: row.uncertainty_days === null ? null : Number(row.uncertainty_days),
      uncertaintyReason: String(row.uncertainty_reason ?? ""),
      sourceUrl: (observation?.source_url as string | null) ?? null,
      sourceKind: sourceType === "wayback" ? "archive" : "official",
      observedAt: String(observation?.observed_at ?? ""),
      evidenceQuote: String(row.evidence_quote ?? "").slice(0, 400),
    };
  });

  const precisionCounts = { exact: 0, bounded: 0, observed_by: 0 };
  for (const cycle of cycles) precisionCounts[cycle.precision] += 1;

  const changeByForecast = new Map(
    (changesResult.data ?? []).map((row) => [row.after_forecast_id as string, row]),
  );

  const forecastVersions: RoleForecastVersion[] = forecasts.slice(0, 8).map((row) => {
    const change = changeByForecast.get(row.id as string);
    return {
      forecastId: row.id as string,
      asOf: row.as_of as string,
      expectedOpening: row.point_date as string,
      windowStart: row.window_start as string,
      windowEnd: row.window_end as string,
      confidence: Number(row.confidence),
      modelVersion: row.model_version as string,
      basis: versionBasis.get(row.id as string) ?? null,
      change: change
        ? {
            confidenceDelta: Number(change.confidence_delta),
            pointDateDeltaDays: Number(change.point_date_delta_days),
            material: Boolean(change.material),
            reasons: (change.reasons as string[]) ?? [],
            changedAt: change.created_at as string,
          }
        : null,
    };
  });

  const allProvenance: RoleProvenanceItem[] = (provenanceResult.data ?? []).map((row) => ({
    observationId: row.observation_id as string,
    sourceUrl: row.source_url as string,
    observedAt: row.observed_at as string,
    contentHash: row.content_hash as string,
    extractionMethod: row.extraction_method as string,
    contribution: row.contribution as string,
    weight: Number(row.weight),
    rationale: row.rationale as string,
    precision: isPrecision(row.date_precision) ? row.date_precision : null,
    signalKind: (row.signal_kind as string | null) ?? null,
  }));

  // The classes and their weights are computed over every row; the page below is only which
  // receipts are on screen. All 18,554 rows on the rig carry their class's one rationale, so it is
  // stated on the class — and a class whose rows disagree is marked, so those rows state their own.
  const grouped = new Map<string, RoleProvenanceGroup>();
  for (const item of allProvenance) {
    const group = grouped.get(item.contribution)
      ?? { contribution: item.contribution, rationale: item.rationale, rows: 0, weight: 0, uniformRationale: true };
    group.rows += 1;
    group.weight += item.weight;
    if (item.rationale !== group.rationale) group.uniformRationale = false;
    grouped.set(item.contribution, group);
  }
  const provenanceGroups = [...grouped.values()].sort((a, b) => b.weight - a.weight || a.contribution.localeCompare(b.contribution));
  const pages = Math.max(1, Math.ceil(allProvenance.length / PROVENANCE_PAGE_SIZE));
  const page = Math.min(Math.max(1, Math.trunc(provenancePage) || 1), pages);
  const provenance = allProvenance.slice((page - 1) * PROVENANCE_PAGE_SIZE, page * PROVENANCE_PAGE_SIZE);

  const postings = (matchesResult.data ?? [])
    .map((row) => {
      const observation = (Array.isArray(row.raw_job_observations)
        ? row.raw_job_observations[0]
        : row.raw_job_observations) as Record<string, unknown> | null;
      return observation;
    })
    .filter((observation): observation is Record<string, unknown> =>
      Boolean(observation) && observation!.source_type !== "wayback")
    .sort((a, b) => String(b.last_seen_at ?? "").localeCompare(String(a.last_seen_at ?? "")))
    .slice(0, 4)
    .map((observation) => ({
      title: String(observation.raw_title ?? "Observed posting"),
      applyUrl: (observation.apply_url as string | null) ?? null,
      sourceUrl: (observation.source_url as string | null) ?? null,
      publishedAt: (observation.published_at as string | null) ?? null,
      lastSeenAt: (observation.last_seen_at as string | null) ?? null,
    }));

  const today = new Date();
  const factors = (latest?.confidence_factors ?? {}) as Record<string, number>;
  const modelReady = latest ? Number(latest.history_count) : 0;

  return {
    origin: "real",
    id: roleId,
    company: displayCompany(company.name),
    companyMark: initials(displayCompany(company.name)),
    companyId: company.id,
    companyDomain: company.domain,
    careersUrl: company.careers_url,
    role: displayTitle(String(role.canonical_title), (await recordedTitles).get(roleId)),
    track: String(role.track),
    level: String(role.level ?? "unknown"),
    roleFamily: String(role.role_family ?? "unknown"),
    recruitingSeason: String(role.recruiting_season ?? "unknown"),
    locationScope: String(role.location_scope ?? "unspecified"),
    forecast: latest
      ? {
          forecastId: latest.id as string,
          asOf: latest.as_of as string,
          expectedOpening: latest.point_date as string,
          windowStart: latest.window_start as string,
          windowEnd: latest.window_end as string,
          daysUntilWindow: Math.round(
            (isoDate(latest.window_start as string).getTime() - today.getTime()) / 86_400_000,
          ),
          confidence: Number(latest.confidence),
          method: latest.method as string,
          modelVersion: latest.model_version as string,
          historyCount: modelReady,
          inputFingerprint: latest.input_fingerprint as string,
          forecastedAt: latest.forecasted_at as string,
          calibratedProbability: Number(latest.calibrated_probability),
          priorEffectiveSampleSize: Number(latest.prior_effective_sample_size),
          confidenceFactors: Object.entries(factors).map(([key, value]) => ({
            label: factorLabel(key),
            value: Number(value).toFixed(2),
            tone: factorTone(key, Number(value)),
          })),
          basis: versionBasis.get(latest.id as string) ?? null,
        }
      : null,
    insufficientEvidence: latest ? null : noForecastExplanation(cycles.length, precisionCounts.exact),
    forecastRefusal,
    forecastVersions,
    cycles,
    precisionCounts,
    provenance,
    provenanceGroups,
    provenanceTotal: allProvenance.length,
    provenancePage: page,
    signals: (signalsResult.data ?? []).map((row) => ({
      id: row.id as string,
      kind: row.kind as string,
      observedAt: row.observed_at as string,
      strength: Number(row.strength),
      reliability: Number(row.reliability),
      evidenceQuote: String(row.evidence_quote ?? "").slice(0, 400),
      sourceUrl: row.source_url as string,
      extractionMethod: String(row.extraction_method ?? "unknown"),
    })),
    currentPostings: postings,
    milestones: (milestoneResult.data ?? []).map((row) => ({
      kind: row.kind as string,
      dueOn: row.due_on as string,
      idealDueOn: row.ideal_due_on as string,
      leadDays: Number(row.lead_days),
      policyVersion: row.policy_version as string,
      rationale: row.rationale as string,
      completed: Boolean(row.completed_at),
    })),
    isFollowed: userId ? Boolean(watchResult.data) : null,
    watchlistItemId: (watchResult.data as { id?: string } | null)?.id ?? null,
    observationCount: (matchesResult.data ?? []).length,
  };
}

export type RealCalendarData = {
  mode: "real" | "signed_out" | "unconfigured";
  events: CalendarEvent[];
  /**
   * Watched roles that cannot produce a dated calendar entry. The calendar shows
   * their real current status instead of inventing an opening date.
   */
  unforecastable: {
    roleId: string;
    company: string;
    role: string;
    reason: string;
    lastObservedOn: string | null;
    cycleCount: number;
  }[];
  watchedRoleCount: number;
};

/**
 * The recruiting calendar for one signed-in user.
 *
 * Three semantic classes are kept strictly separate:
 *   - CONFIRMED OPENING  — an `exact` historical opening event
 *   - PREDICTED OPENING  — a stored forecast interval boundary
 *   - PREPARATION MILESTONE — a persisted `readiness_milestones` row
 * Nothing is generated client-side, and a watched role without a forecast
 * produces no dated entry at all.
 */
export async function loadRealCalendar(userId: string | null): Promise<RealCalendarData> {
  if (!hasServiceRoleConfig()) {
    return { mode: "unconfigured", events: [], unforecastable: [], watchedRoleCount: 0 };
  }
  if (!userId) return { mode: "signed_out", events: [], unforecastable: [], watchedRoleCount: 0 };

  const admin = createAdminClient();
  // Non-user data (roles, forecasts, openings) goes through the public reader; milestones stay user-filtered below.
  const reader = createPublicReader();
  // Follow coverage is resolved in Postgres (followed_role_ids) and paged, so a company
  // or track follow covering more roles than the PostgREST row cap is read completely.
  const watchedIds = (
    await fetchAll<{ role_id: string }>(
      () => admin.rpc("followed_role_ids", { p_user_id: userId }),
      "followed_role_ids",
      "role_id",
    )
  ).map((row) => row.role_id);
  if (watchedIds.length === 0) {
    return { mode: "real", events: [], unforecastable: [], watchedRoleCount: 0 };
  }
  const roleRows = await fetchAllIn<Record<string, unknown>>(
    (ids) => reader
      .from("canonical_roles", "id,company_id,canonical_title,track,role_family,location_scope,forecast_refused_at,companies(name)")
      .in("id", ids),
    watchedIds,
    "canonical_roles",
    "id",
  );
  const roleById = new Map(roleRows.map((row) => [row.id as string, row]));

  const [forecastRows, milestoneRows, openingRows] = await Promise.all([
    fetchAllIn<Record<string, unknown>>(
      (ids) => reader
        .from("forecasts", "id,canonical_role_id,as_of,point_date,window_start,window_end,confidence,forecasted_at")
        .in("canonical_role_id", ids)
        .order("as_of", { ascending: false })
        .order("forecasted_at", { ascending: false }),
      watchedIds,
      "forecasts",
      "id",
    ),
    fetchAllIn<Record<string, unknown>>(
      (ids) => admin
        .from("readiness_milestones")
        .select("id,canonical_role_id,kind,due_on,ideal_due_on,rationale,completed_at,policy_version")
        .eq("user_id", userId)
        .in("canonical_role_id", ids)
        .order("due_on", { ascending: true }),
      watchedIds,
      "readiness_milestones",
      "id",
    ),
    fetchAllIn<Record<string, unknown>>(
      (ids) => reader
        .from("historical_opening_events", "id,canonical_role_id,opened_on,closed_on,date_precision")
        .in("canonical_role_id", ids)
        .eq("date_precision", "exact")
        .gte("opened_on", daysAgo(365))
        .order("opened_on", { ascending: false }),
      watchedIds,
      "historical_opening_events",
      "id",
    ),
  ]);

  // Newest first per role; a role the model declined after its newest forecast has none (migration 202608140043).
  const latestForecast = new Map<string, Record<string, unknown>>();
  const seenForecastRole = new Set<string>();
  for (const row of forecastRows) {
    const key = row.canonical_role_id as string;
    if (seenForecastRole.has(key)) continue;
    seenForecastRole.add(key);
    if (forecastIsCurrent(row.forecasted_at as string, (roleById.get(key)?.forecast_refused_at as string | null) ?? null)) {
      latestForecast.set(key, row);
    }
  }

  const identify = (roleId: string) => {
    const role = roleById.get(roleId);
    const company = role ? embeddedOne(role.companies as { name: string } | { name: string }[] | null) : null;
    return {
      roleId,
      role: role?.canonical_title ? tidyTitle(role.canonical_title as string) : "Watched role",
      company: company?.name ? displayCompany(company.name as string) : "Company",
      roleFamily: (role?.role_family as string) ?? "unknown",
      href: `/roles/${roleId}`,
    };
  };

  const events: CalendarEvent[] = [];

  const bases = await loadForecastBasisById(reader, [...latestForecast.values()].map((forecast) => forecast.id as string));
  for (const [roleId, forecast] of latestForecast) {
    const identity = identify(roleId);
    const confidence = Math.round(Number(forecast.confidence));
    const basis = bases.get(forecast.id as string);
    const basisSentence = basis ? ` ${capitalize(basisPhrase(basis))}.` : "";
    events.push({
      id: `predicted-start-${forecast.id}`,
      date: forecast.window_start as string,
      ...identity,
      type: "predicted_start",
      label: "Predicted window starts",
      semantics: "predicted",
      detail: `Start of the 80% prediction interval. Expected opening ${formatDay(forecast.point_date as string)}.${basisSentence}`,
      confidence,
      basis,
    });
    events.push({
      id: `predicted-end-${forecast.id}`,
      date: forecast.window_end as string,
      ...identity,
      type: "predicted_end",
      label: "Predicted window ends",
      semantics: "predicted",
      detail: `End of the 80% prediction interval.${basisSentence}`,
      confidence,
      basis,
    });
  }

  for (const row of milestoneRows) {
    const identity = identify(row.canonical_role_id as string);
    const kind = row.kind as string;
    events.push({
      id: `milestone-${row.id}`,
      date: row.due_on as string,
      ...identity,
      type: kind === "referral_contacts" ? "referrals" : (kind as CalendarEvent["type"]),
      label: readinessLabels[kind] ?? kind,
      semantics: "readiness",
      detail: row.rationale as string,
      completed: Boolean(row.completed_at),
    });
  }

  for (const row of openingRows) {
    const identity = identify(row.canonical_role_id as string);
    events.push({
      id: `opening-${row.id}`,
      date: row.opened_on as string,
      ...identity,
      type: "confirmed_opening",
      label: "Applications opened",
      semantics: "confirmed",
      detail: "Confirmed from a source-supplied publication date on an observed posting.",
    });
    if (row.closed_on) {
      events.push({
        id: `closing-${row.id}`,
        date: row.closed_on as string,
        ...identity,
        type: "confirmed_closing",
        label: "Applications closed",
        semantics: "confirmed",
        detail: "Recorded when the posting was no longer present on a complete source capture.",
      });
    }
  }

  const cycleRows = await fetchAllIn<Record<string, unknown>>(
    (ids) => reader
      .from("historical_opening_events", "id,canonical_role_id,opened_on")
      .in("canonical_role_id", ids),
    watchedIds,
    "historical_opening_events",
    "id",
  );
  const cyclesByRole = new Map<string, string[]>();
  for (const row of cycleRows) {
    const key = row.canonical_role_id as string;
    cyclesByRole.set(key, [...(cyclesByRole.get(key) ?? []), row.opened_on as string]);
  }

  const unforecastable = watchedIds
    .filter((roleId) => !latestForecast.has(roleId))
    .map((roleId) => {
      const identity = identify(roleId);
      const cycles = (cyclesByRole.get(roleId) ?? []).sort();
      return {
        roleId,
        company: identity.company,
        role: identity.role,
        cycleCount: cycles.length,
        lastObservedOn: cycles.length ? cycles[cycles.length - 1] : null,
        reason: noForecastReason(cycles.length),
      };
    });

  return {
    mode: "real",
    events: events.sort((left, right) => left.date.localeCompare(right.date)),
    unforecastable,
    watchedRoleCount: watchedIds.length,
  };
}

const readinessLabels: Record<string, string> = {
  networking: "Start networking",
  referral_contacts: "Identify referral contacts",
  resume_ready: "Resume-ready deadline",
  portfolio_ready: "Portfolio-ready deadline",
  high_alert: "High-alert monitoring",
};

export type ReplayCandidate = {
  key: string;
  roleId: string;
  targetEventId: string;
  company: string;
  role: string;
  targetYear: number;
  openedOn: string;
  precision: "exact" | "bounded";
  /** How the latest persisted backtest run treated this held-out event; null when no run exists. */
  latestOutcome: ReplayOutcome | null;
  /** BacktestRunner's own words, present only when this exact event was skipped. */
  skipReason: string | null;
  /** Default cutoff: 60 days before the held-out opening, matching the CLI default. */
  suggestedCutoff: string;
};

export type ReplaySummary = {
  /** Roles with two or more recorded opening events: postings, not recruiting cycles (a repost is not a cycle). */
  rolesWithHistory: number;
  /** Of those, roles whose every opening is `observed_by`: never candidates. */
  observedByOnly: number;
  /** Structurally evaluable targets, unfiltered, and by precision class. */
  candidates: number;
  exactCandidates: number;
  boundedCandidates: number;
  /** Targets matching the current filters. */
  matching: number;
};

export type ReplayBacktestReasons = {
  runId: string;
  finishedAt: string;
  cutoffDays: number;
  targetCount: number;
  completedCases: number;
  skippedCases: number;
  /** Skip reasons as BacktestRunner persisted them, most frequent first. */
  reasons: { reason: string; targets: number }[];
};

/**
 * The latest persisted `firstseen backtest` run and the distribution of its skip reasons, exactly as BacktestRunner
 * wrote them (`replay_backtest_reasons`), or null when no run has been persisted. Forecast Replay and the methodology
 * page both read it, so they cannot disagree about which run is the latest.
 */
export async function loadLatestBacktest(reader: PublicReader): Promise<ReplayBacktestReasons | null> {
  // bounded: one row per skip reason of the latest run, and BacktestRunner skips for one of three fixed reasons.
  const { data, error } = await reader.rpc("replay_backtest_reasons");
  if (error) throw new Error("backtest_read_failed");
  const rows = (data ?? []) as {
    run_id: string;
    finished_at: string;
    cutoff_days: number;
    target_count: number;
    completed_cases: number;
    skipped_cases: number;
    reason: string | null;
    targets: number | string;
  }[];
  const run = rows[0];
  if (!run) return null;
  return {
    runId: run.run_id,
    finishedAt: run.finished_at,
    cutoffDays: Number(run.cutoff_days),
    targetCount: Number(run.target_count),
    completedCases: Number(run.completed_cases),
    skippedCases: Number(run.skipped_cases),
    reasons: rows
      .filter((row) => row.reason !== null)
      .map((row) => ({ reason: row.reason as string, targets: Number(row.targets) })),
  };
}

export type ReplayCandidateData = {
  mode: "real" | "unconfigured";
  filters: ReplayFilters;
  candidates: ReplayCandidate[];
  summary: ReplaySummary;
  companies: { name: string; candidates: number }[];
  /** The latest persisted `firstseen backtest` run, or null when none has been persisted. */
  backtest: ReplayBacktestReasons | null;
  apiConfigured: boolean;
};

const emptyReplaySummary: ReplaySummary = {
  rolesWithHistory: 0,
  observedByOnly: 0,
  candidates: 0,
  exactCandidates: 0,
  boundedCandidates: 0,
  matching: 0,
};

/**
 * Replay targets that are *structurally* evaluable, one filtered page at a time.
 *
 * Only `exact` and `bounded` held-out openings have a defensible actual interval; an
 * `observed_by` capture date is not opening-season ground truth and is excluded for the
 * same reason `BacktestRunner` skips it. Whether a structurally eligible case can be
 * scored at a cutoff is decided only by the worker: the per-candidate outcome and the
 * reason distribution shown here are read from the latest persisted backtest run, and a
 * replay refused at run time is reported verbatim, never worked around.
 */
export async function loadReplayCandidates(filters: ReplayFilters): Promise<ReplayCandidateData> {
  const apiConfigured = Boolean(
    process.env.FIRSTSEEN_AGENT_API_URL && process.env.AGENT_API_BEARER_TOKEN,
  );
  if (!hasServiceRoleConfig()) {
    return { mode: "unconfigured", filters, candidates: [], summary: emptyReplaySummary, companies: [], backtest: null, apiConfigured };
  }
  const reader = createPublicReader();
  const args = {
    p_company: filters.company || null,
    p_query: filters.query.trim() || null,
    p_precision: filters.precision === "all" ? null : filters.precision,
    p_outcome: filters.outcome === "all" ? null : filters.outcome,
  };
  // Selection, filtering, paging, and every count run in Postgres
  // (supabase/migrations/202608140025_replay_paging_filters.sql).
  const [page, summary, companies, backtest] = await Promise.all([
    // bounded: replay_candidate_page returns at most p_limit rows, one page of REPLAY_PAGE_SIZE.
    reader.rpc("replay_candidate_page", {
      ...args,
      p_limit: REPLAY_PAGE_SIZE,
      p_offset: (filters.page - 1) * REPLAY_PAGE_SIZE,
    }),
    // bounded: replay_candidate_summary returns one row of counts.
    reader.rpc("replay_candidate_summary", args).single(),
    // Every company with a candidate: the company filter lists them all (the function's `limit 500` was dropped in
    // migration 202608140041).
    fetchAll<Record<string, unknown>>(() => reader.rpc("replay_candidate_companies"), "replay_candidate_companies", "company_name")
      .then((data) => ({ data, error: null })),
    loadLatestBacktest(reader),
  ]);
  if (page.error || summary.error || companies.error) {
    throw new Error("replay_candidates_read_failed");
  }

  const totals = summary.data as {
    roles_with_history: number | string;
    observed_by_only: number | string;
    candidates: number | string;
    exact_candidates: number | string;
    bounded_candidates: number | string;
    matching: number | string;
  };
  const rows = (page.data ?? []) as {
    role_id: string;
    company_name: string;
    canonical_title: string;
    target_event_id: string;
    opened_on: string;
    date_precision: string;
    latest_outcome: string | null;
    skip_reason: string | null;
  }[];
  const candidates: ReplayCandidate[] = rows.map((row) => {
    const cutoff = new Date(`${row.opened_on}T00:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - 60);
    return {
      key: `${row.role_id}-${row.target_event_id}`,
      roleId: row.role_id,
      targetEventId: row.target_event_id,
      company: displayCompany(row.company_name),
      role: tidyTitle(row.canonical_title),
      targetYear: Number(row.opened_on.slice(0, 4)),
      openedOn: row.opened_on,
      precision: row.date_precision as "exact" | "bounded",
      latestOutcome: (row.latest_outcome as ReplayOutcome | null) ?? null,
      skipReason: row.latest_outcome === "skipped" ? row.skip_reason : null,
      suggestedCutoff: cutoff.toISOString().slice(0, 10),
    };
  });


  return {
    mode: "real",
    filters,
    candidates,
    summary: {
      rolesWithHistory: Number(totals.roles_with_history),
      observedByOnly: Number(totals.observed_by_only),
      candidates: Number(totals.candidates),
      exactCandidates: Number(totals.exact_candidates),
      boundedCandidates: Number(totals.bounded_candidates),
      matching: Number(totals.matching),
    },
    companies: ((companies.data ?? []) as { company_name: string; candidates: number | string }[]).map((row) => ({
      name: displayCompany(row.company_name),
      candidates: Number(row.candidates),
    })),
    backtest,
    apiConfigured,
  };
}
