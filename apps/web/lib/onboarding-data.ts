import "server-only";

import { filterRpcArgs, programTypeLabel, disciplineLabel, type DashboardFilterOptions } from "@/lib/dashboard-query";
import {
  PAYOFF_ROLES,
  POPULAR_COMPANIES,
  answersFromPreferences,
  answersToFilters,
  legacyFromPreferences,
  type LegacyPreferences,
  type OnboardingAnswers,
} from "@/lib/onboarding";
import { displayCompany, displayPlace, displayTitle } from "@/lib/display-names";
import { createPublicReader } from "@/lib/public-read";
import { loadDashboardFilterOptions, loadRecordedTitles } from "@/lib/real-data";
import { createAdminClient } from "@/lib/supabase/admin";

export type OnboardingState = {
  answers: OnboardingAnswers;
  legacy: LegacyPreferences;
  completedAt: string | null;
  skippedAt: string | null;
  followedRoles: number;
};

/** One user's stored first-run answers and progress. Read with the service role, filtered to exactly that user id. */
export async function loadOnboardingState(userId: string): Promise<OnboardingState> {
  const admin = createAdminClient();
  const [preferences, follows] = await Promise.all([
    // bounded: one row; recruiting_preferences is keyed by user_id.
    admin
      .from("recruiting_preferences")
      .select("target_disciplines,graduation_year,target_recruiting_season,preferred_locations,onboarding_completed_at,onboarding_skipped_at")
      .eq("user_id", userId)
      .maybeSingle(),
    // bounded: head:true returns a count and no rows.
    admin.rpc("followed_role_ids", { p_user_id: userId }, { count: "exact", head: true }),
  ]);
  if (preferences.error) throw new Error("recruiting_preferences_read_failed");
  if (follows.error) throw new Error("followed_role_ids_read_failed");
  const row = preferences.data as ({ onboarding_completed_at: string | null; onboarding_skipped_at: string | null } & Parameters<typeof answersFromPreferences>[0]) | null;
  return {
    answers: answersFromPreferences(row),
    legacy: legacyFromPreferences(row),
    completedAt: row?.onboarding_completed_at ?? null,
    skippedAt: row?.onboarding_skipped_at ?? null,
    followedRoles: follows.count ?? 0,
  };
}

export type CompanyChoice = { id: string; name: string; roles: number };

/**
 * Step three's companies: every company with an in-scope role, and the few with the most, which it suggests. The rule
 * is stated where it is shown ("most programs tracked"), so the suggestion is never a hand-picked list.
 */
export async function loadCompanyChoices(options?: DashboardFilterOptions): Promise<{ all: CompanyChoice[]; popular: CompanyChoice[] }> {
  const facets = options ?? (await loadDashboardFilterOptions());
  // The facet labels are already display names (lib/real-data.ts), so "Imc" reads as IMC here too.
  const all = facets.company.map((option) => ({ id: option.value, name: option.label, roles: option.roles }));
  const popular = [...all].sort((a, b) => b.roles - a.roles || a.name.localeCompare(b.name)).slice(0, POPULAR_COMPANIES);
  return { all, popular };
}

/** A role the payoff lists, with its current window when it has one and the openings behind it when it does not. */
export type PayoffRole = {
  id: string;
  company: string;
  companyId: string;
  title: string;
  programType: string;
  discipline: string;
  /** The location split, when the role states one; it tells apart two programs with the same title. */
  location: string | null;
  atWatchedCompany: boolean;
  window: { expected: string; start: string; end: string; confidence: number } | null;
  openingsRecorded: number;
};

export type OnboardingPayoff = {
  /** Every in-scope role the answers fit, counted by the same function that counts the dashboard. */
  matchingRoles: number;
  matchingForecasts: number;
  roles: PayoffRole[];
};

type PageRow = {
  role_id: string;
  company_id: string;
  company_name: string;
  canonical_title: string;
  discipline: string | null;
  program_type: string | null;
  location_scope: string | null;
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

type SummaryRow = { matching_roles: number | string; matching_forecastable: number | string };

/**
 * The payoff for one set of answers, read through the public reader with no user, the way a guest's dashboard is.
 *
 * The count is `dashboard_role_summary` for the answers' filters, so "N programs" is exactly what the roles page shows
 * for them. The list is `dashboard_role_page` in its default order (forecasts first, soonest window first, then the
 * rest) at two roles per company, with the watched companies' matching roles first. Low-confidence forecasts and roles
 * without a forecast are not left out.
 */
export async function loadOnboardingPayoff(answers: OnboardingAnswers, now: Date = new Date()): Promise<OnboardingPayoff> {
  const reader = createPublicReader();
  const filters = answersToFilters(answers);
  const args = { p_now: now.toISOString(), p_user_id: null, ...filterRpcArgs(filters) };
  const page = (companies: string[] | null) => ({
    ...args,
    ...(companies ? { p_companies: companies } : {}),
    p_sort: "window",
    p_per_company: 2,
    p_limit: PAYOFF_ROLES,
    p_offset: 0,
  });
  const [summary, general, watched] = await Promise.all([
    // bounded: dashboard_role_summary returns one row of counts.
    reader.rpc("dashboard_role_summary", { ...args, p_per_company: 2 }).single(),
    // bounded: p_limit PAYOFF_ROLES rows.
    reader.rpc("dashboard_role_page", page(null)),
    // bounded: p_limit PAYOFF_ROLES rows, the watched companies' matching roles.
    answers.companies.length ? reader.rpc("dashboard_role_page", page(answers.companies)) : Promise.resolve({ data: [], error: null }),
  ]);
  if (summary.error || general.error || watched.error) throw new Error("onboarding_payoff_read_failed");

  const today = now.toISOString().slice(0, 10);
  const seen = new Set<string>();
  const rows = [...((watched.data ?? []) as PageRow[]), ...((general.data ?? []) as PageRow[])]
    .filter((row) => (seen.has(row.role_id) ? false : (seen.add(row.role_id), true)))
    .slice(0, PAYOFF_ROLES);
  const current = (row: PageRow) => row.forecastable && row.point_date !== null && row.window_start !== null && row.window_end !== null && row.window_end >= today && row.confidence !== null;
  const recorded = await loadRecordedTitles(reader, rows.map((row) => row.role_id));
  const watchedIds = new Set(answers.companies);
  const counts = summary.data as SummaryRow;

  return {
    matchingRoles: Number(counts.matching_roles),
    matchingForecasts: Number(counts.matching_forecastable),
    roles: rows.map((row) => ({
      id: row.role_id,
      company: displayCompany(row.company_name),
      companyId: row.company_id,
      title: displayTitle(row.canonical_title, recorded.get(row.role_id)),
      programType: programTypeLabel(row.program_type),
      discipline: disciplineLabel(row.discipline),
      location: row.location_scope && row.location_scope !== "unspecified" ? displayPlace(row.location_scope) : null,
      atWatchedCompany: watchedIds.has(row.company_id),
      window: current(row)
        ? { expected: row.point_date!, start: row.window_start!, end: row.window_end!, confidence: Number(row.confidence) }
        : null,
      openingsRecorded: Number(row.exact_events) + Number(row.bounded_events) + Number(row.observed_events),
    })),
  };
}
