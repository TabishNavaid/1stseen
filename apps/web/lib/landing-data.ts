import "server-only";

import { defaultDashboardFilters, filterRpcArgs, programTypeLabel, type DashboardFilters } from "@/lib/dashboard-query";
import { createPublicReader, type PublicReader } from "@/lib/public-read";
import type { ForecastBasis } from "@/lib/forecast-basis";
import { displayCompany, displayTitle } from "@/lib/display-names";
import { hasServiceRoleConfig, loadForecastBasis, loadJustOpened, loadRecordedTitles, type RealOpening } from "@/lib/real-data";
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

export type LandingData = {
  preview: LandingPreview | null;
  openingSoon: OpeningSoonRole[];
  /** The newest programs that opened in the last 45 days, and how many opened in all. */
  justOpened: { openings: RealOpening[]; total: number };
};

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

/** How many openings the preview card lists, newest first. */
export const PREVIEW_OPENINGS = 3;

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
  // bounded: the 12 newest openings of one role, from which the card lists PREVIEW_OPENINGS with a source.
  const events = await reader
    .from("historical_opening_events", "id,opened_on,opening_window_start,date_precision,raw_job_observations(source_url,source_type)")
    .eq("canonical_role_id", roleId)
    .order("opened_on", { ascending: false })
    .order("id", { ascending: true })
    .limit(12);
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
 * What the landing page shows, read through the public reader and nothing more.
 *
 * The preview role is chosen by a stated rule, never by hand: the highest confidence score among current forecasts
 * resting on two or more of the program's own cycles; when there is none, the role with the most recorded dated
 * openings, shown as its observed history with no window. "Opening soon" is every current forecast, soonest window
 * first, one role per company, up to six; a window that has already ended is not a coming opening and is left out.
 * "Just opened" is the newest exact openings of the last 45 days, the same read as the Just opened page, one per company.
 */
export async function loadLandingData(now: Date = new Date()): Promise<LandingData | null> {
  if (!hasServiceRoleConfig()) return null;
  const reader = createPublicReader();
  const today = now.toISOString().slice(0, 10);
  const withForecast: DashboardFilters = { ...defaultDashboardFilters, confidence: ["strong", "moderate", "limited"] };

  const [featured, byEvidence, soonest, justOpened] = await Promise.all([
    // bounded: p_limit 1, the single featured forecast.
    reader.rpc("dashboard_role_page", pageArgs({ ...defaultDashboardFilters, minCycles: 2 }, now, "confidence", 3, 1)),
    // bounded: p_limit 1, the role with the most dated openings, for when no forecast qualifies.
    reader.rpc("dashboard_role_page", pageArgs({ ...defaultDashboardFilters, precision: "exact_or_bounded" }, now, "evidence", 3, 1)),
    // bounded: p_limit 12, from which at most OPENING_SOON_LIMIT current windows are shown.
    reader.rpc("dashboard_role_page", pageArgs(withForecast, now, "window", 1, 12)),
    // bounded: the newest 60, from which the strip keeps the first opening of each company, up to JUST_OPENED_STRIP.
    loadJustOpened(reader, { limit: 60 }),
  ]);
  if (featured.error || byEvidence.error || soonest.error) throw new Error("landing_read_failed");

  const featuredRow = ((featured.data ?? []) as PageRow[]).find((row) => row.forecastable && (row.window_end ?? "") >= today);
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

  // One program per company, so a company that posts a batch on one day does not fill the strip.
  const companies = new Set<string>();
  const strip = justOpened.openings.filter((opening) => (companies.has(opening.company) ? false : (companies.add(opening.company), true))).slice(0, JUST_OPENED_STRIP);
  return { preview, openingSoon, justOpened: { openings: strip, total: justOpened.total } };
}
