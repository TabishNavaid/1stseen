import "server-only";
import { changeNotes, isFelt } from "@/lib/forecast-change-notes";

import { addDays } from "@/lib/dates";
import { forecastIsCurrent } from "@/lib/forecast-gap";
import { createPublicReader } from "@/lib/public-read";
import { loadForecastBasisById, loadRecordedTitles } from "@/lib/real-data";
import { createAdminClient } from "@/lib/supabase/admin";
import { fetchAll, fetchAllIn } from "@/lib/supabase/paging";
import { getEmailDigestPublicUrl } from "./config";
import type { DigestSourceData } from "./digest";
import { displayCompany, displayTitle } from "@/lib/display-names";

type RoleRow = { id: string; company_id: string; canonical_title: string; forecast_refused_at: string | null; companies: { name: string } | Array<{ name: string }> | null };
type ForecastRow = { id: string; canonical_role_id: string; as_of: string; window_start: string; window_end: string; confidence: number; forecasted_at: string };

function companyName(role: RoleRow) {
  return Array.isArray(role.companies) ? role.companies[0]?.name ?? "Company" : role.companies?.name ?? "Company";
}

/**
 * The user-scoped evidence a digest is built from.
 *
 * Follow coverage is resolved in Postgres (`followed_role_ids` with the digest's
 * alerts-only rule) and every multi-row read is paged or batched. The previous
 * version read all active canonical roles in one unpaged request, which PostgREST
 * truncates at its row cap, so watched roles past the first 1,000 silently dropped
 * out of the digest.
 */
export async function loadDigestSourceData(userId: string, asOf = new Date().toISOString().slice(0, 10)): Promise<DigestSourceData> {
  const admin = createAdminClient();
  const periodStart = addDays(asOf, -7);

  const followedIds = (
    await fetchAll<{ role_id: string }>(
      () => admin.rpc("followed_role_ids", { p_user_id: userId, p_alerts_only: true }),
      "digest_watchlist",
      "role_id",
    )
  ).map((row) => row.role_id);
  const roleRows = await fetchAllIn<RoleRow>(
    (ids) => admin.from("canonical_roles").select("id,company_id,canonical_title,forecast_refused_at,companies(name)").eq("active", true).in("id", ids),
    followedIds,
    "digest_watchlist",
    "id",
  );
  const roleById = new Map(roleRows.map((role) => [role.id, role]));
  const roleIds = [...roleById.keys()];
  if (!roleIds.length) return { asOf, periodStart, forecasts: [], changes: [], openings: [], milestones: [] };

  const [forecastRows, openingRows, milestoneRows, changeRows] = await Promise.all([
    fetchAllIn<ForecastRow>(
      (ids) => admin.from("forecasts").select("id,canonical_role_id,as_of,window_start,window_end,confidence,forecasted_at").in("canonical_role_id", ids).lte("as_of", asOf).order("as_of", { ascending: false }).order("forecasted_at", { ascending: false }),
      roleIds,
      "digest_evidence",
      "id",
    ),
    fetchAllIn<{ id: string; canonical_role_id: string; opened_on: string }>(
      (ids) => admin.from("historical_opening_events").select("id,canonical_role_id,opened_on").in("canonical_role_id", ids).eq("date_precision", "exact").gte("opened_on", periodStart).lte("opened_on", asOf),
      roleIds,
      "digest_evidence",
      "id",
    ),
    fetchAllIn<{ id: string; forecast_id: string; canonical_role_id: string; kind: string; due_on: string }>(
      (ids) => admin.from("readiness_milestones").select("id,forecast_id,canonical_role_id,kind,due_on").eq("user_id", userId).in("canonical_role_id", ids).is("completed_at", null).gte("due_on", asOf),
      roleIds,
      "digest_evidence",
      "id",
    ),
    fetchAll<{ id: string; before_forecast_id: string; after_forecast_id: string; interval_start_delta_days: number; interval_end_delta_days: number; created_at: string; material: boolean }>(
      () => admin.from("forecast_changes").select("id,before_forecast_id,after_forecast_id,interval_start_delta_days,interval_end_delta_days,created_at,material").eq("material", true).gte("created_at", `${periodStart}T00:00:00Z`).lte("created_at", `${asOf}T23:59:59Z`).order("created_at"),
      "digest_evidence",
      "id",
    ),
  ]);

  // Rows arrive newest first within each role, so the first row per role is its latest forecast; it is left out when the
  // model has declined the role since (migration 202608140043), and no older one stands in for it.
  const latestForecasts = new Map<string, ForecastRow>();
  const seenRoles = new Set<string>();
  for (const row of forecastRows) {
    if (seenRoles.has(row.canonical_role_id)) continue;
    seenRoles.add(row.canonical_role_id);
    if (forecastIsCurrent(row.forecasted_at, roleById.get(row.canonical_role_id)?.forecast_refused_at)) latestForecasts.set(row.canonical_role_id, row);
  }
  const changeForecastIds = [...new Set(changeRows.flatMap((change) => [change.before_forecast_id, change.after_forecast_id]))];
  const changedForecastRows = await fetchAllIn<{ id: string; canonical_role_id: string; confidence: number }>(
    (ids) => admin.from("forecasts").select("id,canonical_role_id,confidence").in("id", ids),
    changeForecastIds,
    "digest_change_lineage",
    "id",
  );
  const changedForecasts = new Map(changedForecastRows.map((forecast) => [forecast.id, forecast]));
  // Each forecast's basis, from its own date weights (lib/forecast-basis).
  const bases = await loadForecastBasisById(createPublicReader(), [...latestForecasts.values()].map((forecast) => forecast.id));
  const basisOf = (forecast: ForecastRow) => bases.get(forecast.id) ?? null;
  const origin = getEmailDigestPublicUrl();
  // Titles read the way they read everywhere else: as the company published them, without the place glued on.
  const recorded = await loadRecordedTitles(createPublicReader(), [...roleById.keys()]);
  const identity = (roleId: string) => {
    const role = roleById.get(roleId)!;
    return { roleId, company: displayCompany(companyName(role)), role: displayTitle(role.canonical_title, recorded.get(roleId)), href: `${origin}/roles/${roleId}` };
  };
  return {
    asOf,
    periodStart,
    forecasts: [...latestForecasts.values()].map((forecast) => ({ id: forecast.id, ...identity(forecast.canonical_role_id), windowStart: forecast.window_start, windowEnd: forecast.window_end, confidence: Number(forecast.confidence), basis: basisOf(forecast) })),
    changes: changeRows.flatMap((change) => {
      const after = changedForecasts.get(change.after_forecast_id);
      const before = changedForecasts.get(change.before_forecast_id);
      const roleId = after?.canonical_role_id;
      if (!roleId || !before || !roleById.has(roleId)) return [];
      // A digest is worth opening only for what the reader would feel; a score that moved behind an unchanged window
      // is not that (lib/forecast-change-notes.ts).
      const facts = {
        startDeltaDays: Number(change.interval_start_delta_days),
        endDeltaDays: Number(change.interval_end_delta_days),
        confidenceBefore: Number(before.confidence),
        confidenceAfter: Number(after.confidence),
      };
      if (!isFelt(facts)) return [];
      return [{ id: change.id, forecastId: change.after_forecast_id, ...identity(roleId), changedOn: change.created_at.slice(0, 10), notes: changeNotes(facts) }];
    }),
    openings: openingRows.map((opening) => ({ id: opening.id, ...identity(opening.canonical_role_id), openedOn: opening.opened_on })),
    milestones: milestoneRows.map((milestone) => ({ id: milestone.id, forecastId: milestone.forecast_id, ...identity(milestone.canonical_role_id), kind: milestone.kind, dueOn: milestone.due_on })),
  };
}
