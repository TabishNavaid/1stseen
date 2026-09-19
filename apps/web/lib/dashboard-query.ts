/**
 * Dashboard filters, sort, and paging live in the URL, so a filtered view is shareable, the back button
 * works, and a page is a server render of exactly the records it shows. Real mode applies them in Postgres
 * (`dashboard_role_page`, `dashboard_role_summary`); demo mode applies the same semantics to fixture roles.
 *
 * The default is every in-scope role (docs/role-scope.md). No default filter hides a low-confidence or
 * insufficient-evidence role, and every filtered view states what it excluded.
 *
 * Kept free of React and path aliases so it runs directly under `node --experimental-strip-types` in tests.
 */

import type { ForecastBasis } from "@/lib/forecast-basis";
import type { ForecastRole } from "@firstseen/shared";

export const DASHBOARD_PAGE_SIZE = 20;

/** Where the roles view lives. The site's front page is the landing page for guests. */
export const DASHBOARD_PATH = "/roles";

/** Every query parameter the roles view reads: its filters, sort, and page, and the first run's landing note. */
export const DASHBOARD_PARAMS: readonly string[] = [
  "q", "discipline", "company", "type", "season", "year", "window", "confidence", "cycles", "precision", "location", "listed",
  "watched", "sort", "page", "welcome",
];

/** At most this many roles per company before the next company appears, unless the view is one company's. */
export const ROLES_PER_COMPANY = 3;

export const DISCIPLINES = [
  ["software_engineering", "Software engineering"],
  ["machine_learning", "Machine learning"],
  ["infrastructure", "Infrastructure"],
  ["security", "Security"],
  ["hardware", "Hardware"],
  ["robotics", "Robotics"],
  ["data", "Data"],
  ["quantitative", "Quantitative"],
  ["product_management", "Product management"],
  ["design", "Design"],
  ["mechanical_engineering", "Mechanical engineering"],
  ["aerospace_engineering", "Aerospace engineering"],
  ["manufacturing_engineering", "Manufacturing and process"],
  ["materials_engineering", "Materials engineering"],
  ["chemical_engineering", "Chemical engineering"],
  ["civil_engineering", "Civil engineering"],
  ["biomedical_engineering", "Biomedical engineering"],
] as const;

export const PROGRAM_TYPES = [
  ["internship", "Internship"],
  ["co_op", "Co-op"],
  ["new_grad", "New grad"],
  ["rotational", "Rotational"],
  ["graduate_program", "Graduate program"],
  ["apprenticeship", "Apprenticeship"],
] as const;

export const SEASONS = [
  ["summer", "Summer"],
  ["fall", "Fall"],
  ["winter", "Winter"],
  ["spring", "Spring"],
  ["year_round", "Year-round"],
  ["unknown", "Season not stated"],
] as const;

export const WINDOWS = [30, 60, 90] as const;

export const CONFIDENCE_BANDS = [
  ["strong", "Strong (75 and up)"],
  ["moderate", "Moderate (60 to 74)"],
  ["limited", "Limited (below 60)"],
  ["none", "No forecast yet"],
] as const;

export const CYCLE_MINIMUMS = [2, 3] as const;

export const PRECISIONS = [
  ["exact", "Has an exact opening date"],
  ["exact_or_bounded", "Has an exact or bounded date"],
  ["observed_only", "Observed-by dates only"],
  ["none", "No opening recorded"],
] as const;

export const SORTS = [
  ["window", "Soonest window"],
  ["confidence", "Highest confidence"],
  ["evidence", "Strongest evidence"],
  ["company", "Company"],
] as const;

type Values<T extends readonly (readonly [string, string])[]> = T[number][0];
export type Discipline = Values<typeof DISCIPLINES>;
export type ProgramType = Values<typeof PROGRAM_TYPES>;
export type Season = Values<typeof SEASONS>;
export type ConfidenceBand = Values<typeof CONFIDENCE_BANDS>;
export type Precision = Values<typeof PRECISIONS>;
export type DashboardSort = Values<typeof SORTS>;
export type WindowDays = (typeof WINDOWS)[number];
export type CycleMinimum = (typeof CYCLE_MINIMUMS)[number];

export type DashboardFilters = {
  query: string;
  disciplines: Discipline[];
  companies: string[];
  types: ProgramType[];
  seasons: Season[];
  years: string[];
  windowDays: WindowDays | null;
  confidence: ConfidenceBand[];
  minCycles: CycleMinimum | null;
  precision: Precision | null;
  locations: string[];
  listedNow: boolean;
  watchedOnly: boolean;
  sort: DashboardSort;
  page: number;
};

export const FILTER_KEYS = [
  "query", "discipline", "company", "type", "season", "year", "window", "confidence", "cycles", "precision",
  "location", "listed", "watched",
] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];

export type Exclusion = { excluded: number; without: number };

/** Every count the dashboard states, computed from the same filters as its list. */
export type DashboardSummary = {
  inScopeRoles: number;
  outsideScopeRoles: number;
  forecastableRoles: number;
  insufficientRoles: number;
  matchingRoles: number;
  matchingForecastable: number;
  matchingInsufficient: number;
  shownRoles: number;
  collapsedRoles: number;
  collapsedCompanies: number;
  openingWithin30Days: number;
  followedRoles: number;
  followedForecastable: number;
  exclusions: Record<FilterKey, Exclusion>;
};

export type FilterOption = { value: string; label: string; roles: number };
export type DashboardFilterOptions = Record<"discipline" | "type" | "season" | "year" | "company" | "location", FilterOption[]>;

export const emptyFilterOptions: DashboardFilterOptions = { discipline: [], type: [], season: [], year: [], company: [], location: [] };

const noExclusions = Object.fromEntries(FILTER_KEYS.map((key) => [key, { excluded: 0, without: 0 }])) as Record<FilterKey, Exclusion>;

export const emptyDashboardSummary: DashboardSummary = {
  inScopeRoles: 0,
  outsideScopeRoles: 0,
  forecastableRoles: 0,
  insufficientRoles: 0,
  matchingRoles: 0,
  matchingForecastable: 0,
  matchingInsufficient: 0,
  shownRoles: 0,
  collapsedRoles: 0,
  collapsedCompanies: 0,
  openingWithin30Days: 0,
  followedRoles: 0,
  followedForecastable: 0,
  exclusions: noExclusions,
};

export const defaultDashboardFilters: DashboardFilters = {
  query: "",
  disciplines: [],
  companies: [],
  types: [],
  seasons: [],
  years: [],
  windowDays: null,
  confidence: [],
  minCycles: null,
  precision: null,
  locations: [],
  listedNow: false,
  watchedOnly: false,
  sort: "window",
  page: 1,
};

type SearchParams = Record<string, string | string[] | undefined>;

const MAX_VALUES = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function all(params: SearchParams, key: string): string[] {
  const value = params[key];
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return [...new Set(values.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean))].slice(0, MAX_VALUES);
}

function first(params: SearchParams, key: string): string | undefined {
  return all(params, key)[0];
}

function allowed<T extends string>(values: string[], table: readonly (readonly [T, string])[]): T[] {
  const known = new Set<string>(table.map(([value]) => value));
  return values.filter((value): value is T => known.has(value));
}

/** Unknown or malformed values are dropped, never guessed at. */
export function parseDashboardFilters(params: SearchParams): DashboardFilters {
  const windowDays = Number(first(params, "window"));
  const minCycles = Number(first(params, "cycles"));
  const page = Number.parseInt(first(params, "page") ?? "1", 10);
  const precision = allowed(all(params, "precision"), PRECISIONS)[0] ?? null;
  const sort = allowed(all(params, "sort"), SORTS)[0] ?? "window";
  return {
    query: (typeof params.q === "string" ? params.q : Array.isArray(params.q) ? params.q[0] ?? "" : "").slice(0, 200),
    disciplines: allowed(all(params, "discipline"), DISCIPLINES),
    companies: all(params, "company").filter((value) => UUID.test(value)).map((value) => value.toLowerCase()),
    types: allowed(all(params, "type"), PROGRAM_TYPES),
    seasons: allowed(all(params, "season"), SEASONS),
    years: all(params, "year").filter((value) => /^20[2-9]\d$/.test(value) || value === "unstated"),
    windowDays: (WINDOWS as readonly number[]).includes(windowDays) ? (windowDays as WindowDays) : null,
    confidence: allowed(all(params, "confidence"), CONFIDENCE_BANDS),
    minCycles: (CYCLE_MINIMUMS as readonly number[]).includes(minCycles) ? (minCycles as CycleMinimum) : null,
    precision,
    locations: all(params, "location").map((value) => value.slice(0, 120)),
    listedNow: first(params, "listed") === "1",
    watchedOnly: first(params, "watched") === "1",
    sort,
    page: Number.isFinite(page) ? Math.min(10_000, Math.max(1, page)) : 1,
  };
}

/** The URL for these filters with `changes` applied. Any change other than the page returns to page 1. */
export function dashboardHref(filters: DashboardFilters, changes: Partial<DashboardFilters> = {}): string {
  const next = { ...filters, ...changes };
  if (!("page" in changes)) next.page = 1;
  const params = new URLSearchParams();
  if (next.query.trim()) params.set("q", next.query.trim());
  for (const value of next.disciplines) params.append("discipline", value);
  for (const value of next.companies) params.append("company", value);
  for (const value of next.types) params.append("type", value);
  for (const value of next.seasons) params.append("season", value);
  for (const value of next.years) params.append("year", value);
  if (next.windowDays) params.set("window", String(next.windowDays));
  for (const value of next.confidence) params.append("confidence", value);
  if (next.minCycles) params.set("cycles", String(next.minCycles));
  if (next.precision) params.set("precision", next.precision);
  for (const value of next.locations) params.append("location", value);
  if (next.listedNow) params.set("listed", "1");
  if (next.watchedOnly) params.set("watched", "1");
  if (next.sort !== "window") params.set("sort", next.sort);
  if (next.page > 1) params.set("page", String(next.page));
  const query = params.toString();
  return query ? `${DASHBOARD_PATH}?${query}` : DASHBOARD_PATH;
}

/** Zero lists every role: one company's view gathers everything for that employer. */
export function perCompanyLimit(filters: DashboardFilters): number {
  return filters.companies.length > 0 ? 0 : ROLES_PER_COMPANY;
}

/** The arguments every dashboard SQL function takes for these filters. */
export function filterRpcArgs(filters: DashboardFilters) {
  const list = <T,>(values: T[]) => (values.length ? values : null);
  return {
    p_query: filters.query.trim() || null,
    p_disciplines: list(filters.disciplines),
    p_companies: list(filters.companies),
    p_types: list(filters.types),
    p_seasons: list(filters.seasons),
    p_years: list(filters.years),
    p_window_days: filters.windowDays,
    p_confidence: list(filters.confidence),
    p_min_cycles: filters.minCycles,
    p_precision: filters.precision,
    p_locations: list(filters.locations),
    p_listed_now: filters.listedNow,
    p_watched_only: filters.watchedOnly,
  };
}

function labelFor(table: readonly (readonly [string, string])[], value: string): string {
  return table.find(([key]) => key === value)?.[1] ?? value;
}

function optionLabel(options: FilterOption[], value: string): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

export type ActiveFilter = { key: FilterKey; label: string; removeHref: string };

/** One entry per applied filter value, each with a link to the same view without it. */
export function activeFilters(filters: DashboardFilters, options: DashboardFilterOptions = emptyFilterOptions): ActiveFilter[] {
  const without = (changes: Partial<DashboardFilters>) => dashboardHref(filters, changes);
  const chips: ActiveFilter[] = [];
  if (filters.query.trim()) chips.push({ key: "query", label: `Search: ${filters.query.trim()}`, removeHref: without({ query: "" }) });
  for (const value of filters.disciplines) chips.push({ key: "discipline", label: labelFor(DISCIPLINES, value), removeHref: without({ disciplines: filters.disciplines.filter((item) => item !== value) }) });
  for (const value of filters.companies) chips.push({ key: "company", label: `Company: ${optionLabel(options.company, value)}`, removeHref: without({ companies: filters.companies.filter((item) => item !== value) }) });
  for (const value of filters.types) chips.push({ key: "type", label: labelFor(PROGRAM_TYPES, value), removeHref: without({ types: filters.types.filter((item) => item !== value) }) });
  for (const value of filters.seasons) chips.push({ key: "season", label: labelFor(SEASONS, value), removeHref: without({ seasons: filters.seasons.filter((item) => item !== value) }) });
  for (const value of filters.years) chips.push({ key: "year", label: value === "unstated" ? "Program year not stated" : `Program year ${value}`, removeHref: without({ years: filters.years.filter((item) => item !== value) }) });
  if (filters.windowDays) chips.push({ key: "window", label: `Forecast window within ${filters.windowDays} days`, removeHref: without({ windowDays: null }) });
  for (const value of filters.confidence) chips.push({ key: "confidence", label: `Confidence: ${labelFor(CONFIDENCE_BANDS, value)}`, removeHref: without({ confidence: filters.confidence.filter((item) => item !== value) }) });
  if (filters.minCycles) chips.push({ key: "cycles", label: `${filters.minCycles}+ cycles behind the forecast`, removeHref: without({ minCycles: null }) });
  if (filters.precision) chips.push({ key: "precision", label: labelFor(PRECISIONS, filters.precision), removeHref: without({ precision: null }) });
  for (const value of filters.locations) chips.push({ key: "location", label: `Location: ${optionLabel(options.location, value)}`, removeHref: without({ locations: filters.locations.filter((item) => item !== value) }) });
  if (filters.listedNow) chips.push({ key: "listed", label: "Posting listed now", removeHref: without({ listedNow: false }) });
  if (filters.watchedOnly) chips.push({ key: "watched", label: "Watched roles only", removeHref: without({ watchedOnly: false }) });
  return chips;
}

const FILTER_NAMES: Record<FilterKey, string> = {
  query: "search",
  discipline: "discipline",
  company: "company",
  type: "program type",
  season: "season",
  year: "program year",
  window: "forecast window",
  confidence: "confidence",
  cycles: "evidence cycles",
  precision: "date precision",
  location: "location",
  listed: "listed now",
  watched: "watched only",
};

export function filterName(key: FilterKey): string {
  return FILTER_NAMES[key];
}

/** The applied filter keys, in the order the summary states them. */
export function appliedFilterKeys(filters: DashboardFilters): FilterKey[] {
  const applied: Record<FilterKey, boolean> = {
    query: Boolean(filters.query.trim()),
    discipline: filters.disciplines.length > 0,
    company: filters.companies.length > 0,
    type: filters.types.length > 0,
    season: filters.seasons.length > 0,
    year: filters.years.length > 0,
    window: filters.windowDays !== null,
    confidence: filters.confidence.length > 0,
    cycles: filters.minCycles !== null,
    precision: filters.precision !== null,
    location: filters.locations.length > 0,
    listed: filters.listedNow,
    watched: filters.watchedOnly,
  };
  return FILTER_KEYS.filter((key) => applied[key]);
}

const CLEARED: Record<FilterKey, Partial<DashboardFilters>> = {
  query: { query: "" },
  discipline: { disciplines: [] },
  company: { companies: [] },
  type: { types: [] },
  season: { seasons: [] },
  year: { years: [] },
  window: { windowDays: null },
  confidence: { confidence: [] },
  cycles: { minCycles: null },
  precision: { precision: null },
  location: { locations: [] },
  listed: { listedNow: false },
  watched: { watchedOnly: false },
};

export type RelaxSuggestion = { key: FilterKey; name: string; roles: number; href: string };

/**
 * The single filter whose removal would add the most roles, for an empty or narrow view. Null when no applied
 * filter would add any.
 */
export function relaxSuggestion(filters: DashboardFilters, summary: DashboardSummary): RelaxSuggestion | null {
  let best: RelaxSuggestion | null = null;
  for (const key of appliedFilterKeys(filters)) {
    const roles = summary.exclusions[key]?.without ?? 0;
    if (roles > summary.matchingRoles && (!best || roles > best.roles)) {
      best = { key, name: FILTER_NAMES[key], roles, href: dashboardHref(filters, CLEARED[key]) };
    }
  }
  return best;
}

export function confidenceBand(confidence: number): Exclude<ConfidenceBand, "none"> {
  return confidence >= 75 ? "strong" : confidence >= 60 ? "moderate" : "limited";
}

export function disciplineLabel(value: string | null): string {
  return value ? labelFor(DISCIPLINES, value) : "Discipline not classified";
}

export function programTypeLabel(value: string | null): string {
  return value ? labelFor(PROGRAM_TYPES, value) : "Program type not classified";
}

/** What the dashboard knows about one in-scope role, as `dashboard_role_facts` returns it. */
export type DashboardRoleFacts = {
  id: string;
  companyId: string;
  company: string;
  role: string;
  discipline: string | null;
  programType: string | null;
  season: string;
  targetYear: number | null;
  location: string;
  listedNow: boolean;
  followed: boolean;
  forecastable: boolean;
  confidence: number | null;
  daysUntil: number | null;
  historyCount: number | null;
  exactEvents: number;
  boundedEvents: number;
  observedEvents: number;
  /** Company, title, location, and every observed alias. */
  searchText: string;
};

/** One listed role. `forecast` is set for every role with a stored forecast; a role without one is shown without a window. */
export type DashboardListItem = Omit<DashboardRoleFacts, "searchText" | "confidence" | "daysUntil"> & {
  companyRank: number;
  companyTotal: number;
  forecast: ForecastRole | null;
  /** The plain-language date: the expected opening and its window, when the forecast carries them. */
  outlook: { expected: string; start: string; end: string } | null;
  /** forecasting.py's score, 0 to 100, for the confidence word; null without a forecast. */
  confidence: number | null;
  /** Whether the window rests mainly on the program's own openings or on comparable programs (`lib/forecast-basis`). */
  basis: ForecastBasis | null;
};

/** The predicates of `dashboard_filtered_roles`, one per filter, for demo mode and tests. */
export function filterMatches(role: DashboardRoleFacts, filters: DashboardFilters): Record<FilterKey, boolean> {
  const words = filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const text = role.searchText.toLowerCase();
  const band = role.forecastable && role.confidence !== null ? confidenceBand(role.confidence) : "none";
  const dated = role.exactEvents + role.boundedEvents;
  const precision: Record<Precision, boolean> = {
    exact: role.exactEvents > 0,
    exact_or_bounded: dated > 0,
    observed_only: role.observedEvents > 0 && dated === 0,
    none: dated + role.observedEvents === 0,
  };
  const within = <T,>(values: T[], value: T) => values.length === 0 || values.includes(value);
  return {
    query: words.every((word) => text.includes(word)),
    discipline: filters.disciplines.length === 0 || (role.discipline !== null && (filters.disciplines as string[]).includes(role.discipline)),
    company: within(filters.companies, role.companyId),
    type: filters.types.length === 0 || (role.programType !== null && (filters.types as string[]).includes(role.programType)),
    season: filters.seasons.length === 0 || (filters.seasons as string[]).includes(role.season),
    year: within(filters.years, role.targetYear === null ? "unstated" : String(role.targetYear)),
    window: filters.windowDays === null || (role.forecastable && role.daysUntil !== null && role.daysUntil <= filters.windowDays),
    confidence: within<string>(filters.confidence, band),
    cycles: filters.minCycles === null || (role.forecastable && (role.historyCount ?? 0) >= filters.minCycles),
    precision: filters.precision === null || precision[filters.precision],
    location: within(filters.locations, role.location),
    listed: !filters.listedNow || role.listedNow,
    watched: !filters.watchedOnly || role.followed,
  };
}

/** The sort of `dashboard_role_page`. */
export function compareRoles(sort: DashboardSort, a: DashboardRoleFacts, b: DashboardRoleFacts): number {
  const nullsLast = (x: number | null, y: number | null, descending = false) =>
    x === null ? (y === null ? 0 : 1) : y === null ? -1 : descending ? y - x : x - y;
  const text = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  return (
    (sort === "company" ? text(a.company, b.company) : 0)
    || Number(!a.forecastable) - Number(!b.forecastable)
    || (sort === "confidence" ? nullsLast(a.forecastable ? a.confidence : null, b.forecastable ? b.confidence : null, true) : 0)
    || (sort === "evidence" ? nullsLast(a.forecastable ? a.historyCount : null, b.forecastable ? b.historyCount : null, true) : 0)
    || (sort === "evidence" ? (b.exactEvents + b.boundedEvents) - (a.exactEvents + a.boundedEvents) : 0)
    || nullsLast(a.forecastable ? a.daysUntil : null, b.forecastable ? b.daysUntil : null)
    || text(a.company, b.company)
    || text(a.role, b.role)
    || text(a.id, b.id)
  );
}

/**
 * The page, counts, and exclusions for a set of role facts, with the same semantics as the SQL read path. Demo
 * mode runs it over fixture roles; tests run it to pin the semantics.
 */
export function buildDashboardView(
  roles: DashboardRoleFacts[],
  filters: DashboardFilters,
  forecastFor: (role: DashboardRoleFacts) => ForecastRole | null,
): { items: DashboardListItem[]; summary: DashboardSummary } {
  const cap = perCompanyLimit(filters);
  const flagged = roles.map((role) => {
    const matches = filterMatches(role, filters);
    return { role, matches, all: FILTER_KEYS.every((key) => matches[key]) };
  });
  const matching = flagged.filter((item) => item.all).map((item) => item.role).sort((a, b) => compareRoles(filters.sort, a, b));
  const totals = new Map<string, number>();
  for (const role of matching) totals.set(role.companyId, (totals.get(role.companyId) ?? 0) + 1);
  const seen = new Map<string, number>();
  const shown = matching.flatMap((role) => {
    const rank = (seen.get(role.companyId) ?? 0) + 1;
    seen.set(role.companyId, rank);
    return cap > 0 && rank > cap ? [] : [{ role, rank }];
  });
  const offset = (filters.page - 1) * DASHBOARD_PAGE_SIZE;
  const items = shown.slice(offset, offset + DASHBOARD_PAGE_SIZE).map(({ role, rank }) => {
    const { searchText: _searchText, confidence, daysUntil: _daysUntil, ...facts } = role;
    void _searchText;
    void _daysUntil;
    // Fixtures carry a window but no expected date, so they have no "likely around" date to show.
    return { ...facts, companyRank: rank, companyTotal: totals.get(role.companyId) ?? 0, forecast: role.forecastable ? forecastFor(role) : null, outlook: null, confidence: role.forecastable ? confidence : null, basis: null };
  });
  const exclusions = Object.fromEntries(
    FILTER_KEYS.map((key) => [
      key,
      {
        excluded: flagged.filter((item) => !item.matches[key]).length,
        without: flagged.filter((item) => FILTER_KEYS.every((other) => other === key || item.matches[other])).length,
      },
    ]),
  ) as Record<FilterKey, Exclusion>;
  const collapsed = cap > 0 ? [...totals.values()].filter((count) => count > cap) : [];
  return {
    items,
    summary: {
      inScopeRoles: roles.length,
      outsideScopeRoles: 0,
      forecastableRoles: roles.filter((role) => role.forecastable).length,
      insufficientRoles: roles.filter((role) => !role.forecastable).length,
      matchingRoles: matching.length,
      matchingForecastable: matching.filter((role) => role.forecastable).length,
      matchingInsufficient: matching.filter((role) => !role.forecastable).length,
      shownRoles: shown.length,
      collapsedRoles: collapsed.reduce((sum, count) => sum + count - cap, 0),
      collapsedCompanies: collapsed.length,
      openingWithin30Days: matching.filter((role) => role.forecastable && (role.daysUntil ?? Infinity) <= 30).length,
      followedRoles: roles.filter((role) => role.followed).length,
      followedForecastable: roles.filter((role) => role.followed && role.forecastable).length,
      exclusions,
    },
  };
}

/**
 * Demo mode only: fixture roles through the same view semantics. Fixtures carry no discipline, program year,
 * follows, or date precision, so filters on those match nothing, which is what the fixtures can honestly say.
 */
export function fixtureDashboardView(roles: ForecastRole[], filters: DashboardFilters, basisFor: (roleId: string) => ForecastBasis | null = () => null) {
  const facts: DashboardRoleFacts[] = roles.map((role) => ({
    id: role.id,
    companyId: `fixture-${role.company.toLowerCase()}`,
    company: role.company,
    role: role.role,
    discipline: null,
    programType: role.track === "New grad" ? "new_grad" : "internship",
    season: "unknown",
    targetYear: null,
    location: role.location,
    listedNow: false,
    followed: false,
    // Every fixture role is a stored forecast, and a stored forecast is shown whatever its history (migration 202608140035).
    forecastable: true,
    confidence: role.confidence,
    daysUntil: role.daysUntil,
    historyCount: role.historicalCycles.length,
    exactEvents: 0,
    boundedEvents: 0,
    observedEvents: 0,
    searchText: `${role.company} ${role.role} ${role.location}`,
  }));
  const byId = new Map(roles.map((role) => [role.id, role]));
  const built = buildDashboardView(facts, filters, (role) => byId.get(role.id) ?? null);
  const view = { ...built, items: built.items.map((item) => ({ ...item, basis: item.forecast ? basisFor(item.id) : null })) };
  const count = (values: string[]) => [...new Set(values)].map((value) => ({ value, label: value, roles: values.filter((item) => item === value).length }));
  const options: DashboardFilterOptions = {
    discipline: [],
    type: count(facts.map((role) => role.programType ?? "")),
    season: count(facts.map((role) => role.season)),
    year: count(facts.map(() => "unstated")),
    company: [],
    location: count(facts.map((role) => role.location)),
  };
  return { ...view, options };
}
