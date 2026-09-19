import "server-only";

import { defaultDashboardFilters, filterRpcArgs } from "@/lib/dashboard-query";
import { createPublicReader } from "@/lib/public-read";
import type { ForecastBasis } from "@/lib/forecast-basis";
import { hasServiceRoleConfig, loadForecastBasisById } from "@/lib/real-data";
import type { DatePrecision } from "@/lib/role-view";

export type LandingSource = { id: string; openedOn: string; precision: DatePrecision; sourceUrl: string; archive: boolean };

export type LandingForecast = {
  roleId: string;
  company: string;
  role: string;
  windowStart: string;
  windowEnd: string;
  expectedOpening: string;
  confidence: number;
  cycles: number;
  modelVersion: string | null;
  forecastedAt: string | null;
  precisionCounts: Record<DatePrecision, number>;
  sources: LandingSource[];
  /** What the window mainly rests on (lib/forecast-basis), or null when it has no weighted evidence. */
  basis: ForecastBasis | null;
};

export type LandingFeature = {
  /** The highest-confidence forecast resting on two or more cycles, or null when none does. */
  forecast: LandingForecast | null;
};

type PageRow = {
  role_id: string;
  company_name: string;
  canonical_title: string;
  forecastable: boolean;
  point_date: string;
  window_start: string;
  window_end: string;
  confidence: number | string;
  history_count: number;
  exact_events: number;
  bounded_events: number;
  observed_events: number;
};

const PRECISIONS: readonly string[] = ["exact", "bounded", "observed_by"];

/**
 * What the signed-out landing section shows: one real forecast, read through the public reader and nothing more. The
 * accuracy position lives on the methodology page. The featured role is chosen by a stated rule (the highest confidence score among
 * in-scope forecasts resting on two or more recruiting cycles), never by hand. The dashboard's page function already
 * returns its window, confidence, cycles, and evidence counts, so the only other reads are the model that produced the
 * forecast and where its openings were seen.
 */
export async function loadLandingFeature(now: Date = new Date()): Promise<LandingFeature | null> {
  if (!hasServiceRoleConfig()) return null;
  const reader = createPublicReader();
  // bounded: p_limit 1, the single featured role.
  const top = await reader.rpc("dashboard_role_page", {
    p_now: now.toISOString(),
    p_user_id: null,
    ...filterRpcArgs(defaultDashboardFilters),
    // The featured forecast rests on two or more of the program's own cycles, as it did before every stored forecast
    // was listed (migration 202608140035): the front door shows a forecast with history behind it, by a stated rule.
    p_min_cycles: 2,
    p_sort: "confidence",
    p_per_company: 3,
    p_limit: 1,
    p_offset: 0,
  });
  if (top.error) throw new Error("landing_read_failed");

  const row = ((top.data ?? []) as PageRow[])[0];
  if (!row?.forecastable) return { forecast: null };

  const [model, events] = await Promise.all([
    // bounded: limit(1).maybeSingle(), the role's latest forecast.
    reader
      .from("forecasts", "id,model_version,forecasted_at")
      .eq("canonical_role_id", row.role_id)
      .order("as_of", { ascending: false })
      .order("forecasted_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(1)
      .maybeSingle(),
    // bounded: the 12 newest openings, from which the section links three sources; the counts come from the page row.
    reader
      .from("historical_opening_events", "id,opened_on,date_precision,raw_job_observations(source_url,source_type)")
      .eq("canonical_role_id", row.role_id)
      .order("opened_on", { ascending: false })
      .order("id", { ascending: true })
      .limit(12),
  ]);
  if (model.error || events.error) throw new Error("landing_read_failed");
  const modelId = model.data ? String(model.data.id) : null;
  const basis = modelId ? await loadForecastBasisById(reader, [modelId]) : new Map<string, ForecastBasis>();

  const sources = (events.data ?? []).flatMap((event): LandingSource[] => {
    const embedded = event.raw_job_observations as { source_url: string | null; source_type: string } | { source_url: string | null; source_type: string }[] | null;
    const observation = Array.isArray(embedded) ? embedded[0] : embedded;
    const precision = String(event.date_precision);
    if (!observation?.source_url || !PRECISIONS.includes(precision)) return [];
    return [{
      id: String(event.id),
      openedOn: String(event.opened_on),
      precision: precision as DatePrecision,
      sourceUrl: observation.source_url,
      archive: observation.source_type === "wayback",
    }];
  });

  return {
    forecast: {
      roleId: row.role_id,
      company: row.company_name,
      role: row.canonical_title,
      windowStart: row.window_start,
      windowEnd: row.window_end,
      expectedOpening: row.point_date,
      confidence: Number(row.confidence),
      cycles: Number(row.history_count),
      modelVersion: model.data ? String(model.data.model_version) : null,
      forecastedAt: model.data ? String(model.data.forecasted_at) : null,
      precisionCounts: { exact: Number(row.exact_events), bounded: Number(row.bounded_events), observed_by: Number(row.observed_events) },
      sources: sources.slice(0, 3),
      basis: modelId ? basis.get(modelId) ?? null : null,
    },
  };
}
