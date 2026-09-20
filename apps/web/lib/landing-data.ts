import "server-only";

import { defaultDashboardFilters, filterRpcArgs, programTypeLabel, type DashboardFilters } from "@/lib/dashboard-query";
import { createPublicReader, type PublicReader } from "@/lib/public-read";
import type { ForecastBasis } from "@/lib/forecast-basis";
import { displayCompany, displayTitle } from "@/lib/display-names";
import { hasServiceRoleConfig, loadForecastBasis, loadJustOpened, loadRecordedTitles, type RealOpening } from "@/lib/real-data";
import { featuredOf, rhythmOf, type OpeningRhythm } from "@/lib/featured-program";
import { fetchAllIn } from "@/lib/supabase/paging";
import type { DatePrecision } from "@/lib/role-view";

/** One recorded opening of the preview role, with where it was seen. `windowStart` is a bounded date's earlier end. */
export type LandingOpening = { id: string; openedOn: string; windowStart: string | null; precision: DatePrecision; sourceUrl: string; archive: boolean };

export type LandingForecastWindow = {
  windowStart: string;
  windowEnd: string;
  expectedOpening: string;
  confidence: number;
  cycles: number;
  /** What the window mainly rests on (lib/forecast-basis), or null when it has no weighted evidence. */
  basis: ForecastBasis | null;
};

/**
 * The real role in the landing page's product preview. `forecast` is its current window, or null when the preview fell
 * back to a role's observed history because no forecast rests on two or more cycles yet.
 */
export type LandingPreview = {
  roleId: string;
  company: string;
  role: string;
  programType: string;
  openingsRecorded: number;
  openings: LandingOpening[];
  forecast: LandingForecastWindow | null;
};

/** A role in "Opening soon": a current forecast, soonest window first. */
export type OpeningSoonRole = {
  roleId: string;
  company: string;
  role: string;
  programType: string;
  forecast: LandingForecastWindow;
};

/** The line under the header: what the corpus holds right now. Null when collection has not run recently. */
export type LandingStatus = { updatedAt: string; programs: number; openingsThisMonth: number };

export type LandingData = {
  preview: LandingPreview | null;
  openingSoon: OpeningSoonRole[];
  /** The newest programs that opened in the last 45 days, and how many opened in all. */
  justOpened: { openings: RealOpening[]; total: number };
  status: LandingStatus | null;
};

/**
 * Older than this and the status line is not drawn at all. Collection runs twice a day, so two days without a write is
 * a stall, not a quiet patch; until then the line says how old it is and lets a reader judge.
 */
export const STATUS_STALE_HOURS = 48;

/** How many just-opened programs the landing strip shows. */
export const JUST_OPENED_STRIP = 8;

type PageRow = {
  role_id: string;
  company_name: string;
  canonical_title: string;
  program_type: string | null;
  forecastable: boolean;
  point_date: string | null;
  window_start: string | null;
  window_end: string | null;
  confidence: number | string | null;
  history_count: number | null;
  exact_events: number;
  bounded_events: number;
  observed_events: number;
};

const PRECISIONS: readonly string[] = ["exact", "bounded", "observed_by"];

/** How many past openings the preview card's chart draws, newest first. */
export const PREVIEW_OPENINGS = 8;

/**
 * How many current forecasts the featured rule weighs. They arrive best-evidenced first, so a program with more years
 * of openings than any of these is not reachable through this sort.
 */
export const FEATURED_CANDIDATES = 24;

/** "Opening soon" shows at most this many roles, one per company, and is hidden when none has a current window. */
export const OPENING_SOON_LIMIT = 6;

function pageArgs(filters: DashboardFilters, now: Date, sort: string, perCompany: number, limit: number) {
  return { p_now: now.toISOString(), p_user_id: null, ...filterRpcArgs(filters), p_sort: sort, p_per_company: perCompany, p_limit: limit, p_offset: 0 };
}

function windowOf(row: PageRow, basis: ForecastBasis | null): LandingForecastWindow | null {
  if (!row.forecastable || !row.window_start || !row.window_end || !row.point_date || row.confidence === null) return null;
  return {
    windowStart: row.window_start,
    windowEnd: row.window_end,
    expectedOpening: row.point_date,
    confidence: Number(row.confidence),
    cycles: Number(row.history_count ?? 0),
    basis,
  };
}

async function openingsOf(reader: PublicReader, roleId: string): Promise<LandingOpening[]> {
  // bounded: the 16 newest openings of one role, from which the card draws PREVIEW_OPENINGS with a source.
  const events = await reader
    .from("historical_opening_events", "id,opened_on,opening_window_start,date_precision,raw_job_observations(source_url,source_type)")
    .eq("canonical_role_id", roleId)
    .order("opened_on", { ascending: false })
    .order("id", { ascending: true })
    .limit(16);
  if (events.error) throw new Error("landing_read_failed");
  return (events.data ?? []).flatMap((event): LandingOpening[] => {
    const embedded = event.raw_job_observations as { source_url: string | null; source_type: string } | { source_url: string | null; source_type: string }[] | null;
    const observation = Array.isArray(embedded) ? embedded[0] : embedded;
    const precision = String(event.date_precision);
    if (!observation?.source_url || !PRECISIONS.includes(precision)) return [];
    return [{
      id: String(event.id),
      openedOn: String(event.opened_on),
      windowStart: event.opening_window_start ? String(event.opening_window_start) : null,
      precision: precision as DatePrecision,
      sourceUrl: observation.source_url,
      archive: observation.source_type === "wayback",
    }];
  }).slice(0, PREVIEW_OPENINGS);
}

/**
 * Each candidate role's rhythm, read from its own recorded openings (lib/featured-program.ts).
 *
 * The chart's whole claim is that a program comes back around the same time each year, so how many years its openings
 * cover and how closely they land decide which program shows that claim best.
 */
async function openingRhythms(reader: PublicReader, roleIds: string[]): Promise<Map<string, OpeningRhythm>> {
  if (roleIds.length === 0) return new Map();
  const rows = await fetchAllIn<Record<string, unknown>>(
    (ids) => reader.from("historical_opening_events", "id,canonical_role_id,opened_on").in("canonical_role_id", ids),
    [...new Set(roleIds)],
    "landing_opening_rhythms",
    "id",
  );
  const openings = new Map<string, string[]>();
  for (const row of rows) {
    const roleId = String(row.canonical_role_id);
    openings.set(roleId, [...(openings.get(roleId) ?? []), String(row.opened_on)]);
  }
  return new Map([...openings].map(([roleId, dates]) => [roleId, rhythmOf(dates)]));
}

/**
 * What the landing page shows, read through the public reader and nothing more.
 *
 * The preview role is chosen by a stated rule, never by hand (`lib/featured-program.ts`): among current forecasts,
 * the tightest rhythm over enough years to have one, then the soonest window. When no forecast qualifies at all, the
 * role with the most recorded dated openings, shown as its observed history and no window. "Opening soon" is every
 * current forecast, soonest window first, one role per company, up to six; a window that has already ended is not a
 * coming opening and is left out. "Just opened" is the start of the Just opened page's feed: newest first, no company
 * taking more than two of any six.
 */
export async function loadLandingData(now: Date = new Date()): Promise<LandingData | null> {
  if (!hasServiceRoleConfig()) return null;
  const reader = createPublicReader();
  const today = now.toISOString().slice(0, 10);
  const withForecast: DashboardFilters = { ...defaultDashboardFilters, confidence: ["strong", "moderate", "limited"] };

  const [candidates, byEvidence, soonest, justOpened, summary, latest] = await Promise.all([
    // bounded: p_limit FEATURED_CANDIDATES, the current forecasts the featured rule chooses one of.
    reader.rpc("dashboard_role_page", pageArgs(withForecast, now, "evidence", 3, FEATURED_CANDIDATES)),
    // bounded: p_limit 1, the role with the most dated openings, for when no forecast qualifies.
    reader.rpc("dashboard_role_page", pageArgs({ ...defaultDashboardFilters, precision: "exact_or_bounded" }, now, "evidence", 3, 1)),
    // bounded: p_limit 12, from which at most OPENING_SOON_LIMIT current windows are shown.
    reader.rpc("dashboard_role_page", pageArgs(withForecast, now, "window", 1, 12)),
    // The first JUST_OPENED_STRIP of the Just opened feed, in its order (no company takes more than two of six).
    loadJustOpened(reader, { limit: JUST_OPENED_STRIP }),
    // bounded: one row of totals, for the programs the status line states.
    reader.rpc("dashboard_role_summary", { p_now: now.toISOString(), p_user_id: null, ...filterRpcArgs(defaultDashboardFilters), p_per_company: 0 }),
    // bounded: limit 1, the newest observation, which is when collection last wrote anything.
    reader.from("raw_job_observations", "id,observed_at").order("observed_at", { ascending: false }).order("id", { ascending: true }).limit(1),
  ]);
  if (candidates.error || byEvidence.error || soonest.error) throw new Error("landing_read_failed");

  const current = ((candidates.data ?? []) as PageRow[]).filter((row) => row.forecastable && (row.window_end ?? "") >= today);
  const featuredRow = featuredOf(current, await openingRhythms(reader, current.map((row) => row.role_id)));
  const fallbackRow = ((byEvidence.data ?? []) as PageRow[])[0];
  const previewRow = featuredRow ?? fallbackRow ?? null;
  const soonRows = ((soonest.data ?? []) as PageRow[]).filter((row) => row.forecastable && (row.window_end ?? "") >= today).slice(0, OPENING_SOON_LIMIT);

  const basisIds = [...new Set([...(featuredRow ? [featuredRow.role_id] : []), ...soonRows.map((row) => row.role_id)])];
  const [basis, openings, recorded] = await Promise.all([
    basisIds.length ? loadForecastBasis(reader, basisIds) : Promise.resolve(new Map<string, ForecastBasis>()),
    previewRow ? openingsOf(reader, previewRow.role_id) : Promise.resolve([]),
    loadRecordedTitles(reader, [...(previewRow ? [previewRow.role_id] : []), ...soonRows.map((row) => row.role_id)]),
  ]);

  const preview: LandingPreview | null = previewRow
    ? {
        roleId: previewRow.role_id,
        company: displayCompany(previewRow.company_name),
        role: displayTitle(previewRow.canonical_title, recorded.get(previewRow.role_id)),
        programType: programTypeLabel(previewRow.program_type),
        openingsRecorded: Number(previewRow.exact_events) + Number(previewRow.bounded_events) + Number(previewRow.observed_events),
        openings,
        forecast: featuredRow ? windowOf(featuredRow, basis.get(featuredRow.role_id) ?? null) : null,
      }
    : null;

  const openingSoon = soonRows.flatMap((row): OpeningSoonRole[] => {
    const forecast = windowOf(row, basis.get(row.role_id) ?? null);
    return forecast
      ? [{ roleId: row.role_id, company: displayCompany(row.company_name), role: displayTitle(row.canonical_title, recorded.get(row.role_id)), programType: programTypeLabel(row.program_type), forecast }]
      : [];
  });

  // The status line states only what these reads returned; anything missing or stale leaves the line out.
  const updatedAt = latest.error ? null : (latest.data?.[0]?.observed_at as string | undefined) ?? null;
  const programs = summary.error ? 0 : Number((summary.data as { in_scope_roles?: number | string }[] | null)?.[0]?.in_scope_roles ?? 0);
  const status: LandingStatus | null =
    updatedAt && programs > 0 && now.getTime() - Date.parse(updatedAt) < STATUS_STALE_HOURS * 3_600_000
      ? { updatedAt, programs, openingsThisMonth: justOpened.thisMonth }
      : null;
  return { preview, openingSoon, justOpened: { openings: justOpened.openings, total: justOpened.total }, status };
}
