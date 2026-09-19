import "server-only";

import type { ForecastBasis } from "@/lib/forecast-basis";
import { answersFromPreferences, seedRpcArgs, type OnboardingAnswers } from "@/lib/onboarding";
import { createPublicReader } from "@/lib/public-read";
import { loadForecastBasis } from "@/lib/real-data";
import { createAdminClient } from "@/lib/supabase/admin";

/** How many roles the first run proposes. Two per company at most, so eight spans at least four companies. */
const SEED_LIST_SIZE = 8;

export type OnboardingState = {
  answers: OnboardingAnswers;
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
    completedAt: row?.onboarding_completed_at ?? null,
    skippedAt: row?.onboarding_skipped_at ?? null,
    followedRoles: follows.count ?? 0,
  };
}

export type SeedRole = {
  id: string;
  companyId: string;
  company: string;
  title: string;
  discipline: string;
  programType: string;
  season: string;
  location: string;
  currentForecast: boolean;
  windowStart: string | null;
  windowEnd: string | null;
  confidence: number | null;
  cycles: number | null;
  /** What a shown forecast's window mainly rests on (lib/forecast-basis). */
  basis: ForecastBasis | null;
  exactEvents: number;
  boundedEvents: number;
  observedEvents: number;
  listedNow: boolean;
  isFollowed: boolean;
  seasonMatched: boolean;
  locationMatched: boolean;
};

export type SeedResult = { roles: SeedRole[]; matchingRoles: number; matchingCurrentForecasts: number };

type SeedRow = {
  role_id: string;
  company_id: string;
  company_name: string;
  canonical_title: string;
  discipline: string;
  program_type: string;
  season: string;
  location_scope: string;
  current_forecast: boolean;
  window_start: string | null;
  window_end: string | null;
  confidence: number | string | null;
  history_count: number | null;
  exact_events: number;
  bounded_events: number;
  observed_events: number;
  listed_now: boolean;
  is_followed: boolean;
  season_matched: boolean;
  location_matched: boolean;
  matching_roles: number | string;
  matching_current_forecasts: number | string;
};

function toSeedRole(row: SeedRow): SeedRole {
  return {
    id: row.role_id,
    companyId: row.company_id,
    company: row.company_name,
    title: row.canonical_title,
    discipline: row.discipline,
    programType: row.program_type,
    season: row.season,
    location: row.location_scope,
    currentForecast: row.current_forecast,
    // A forecast the first run does not offer (its window has ended) is not passed on at all.
    windowStart: row.current_forecast ? row.window_start : null,
    windowEnd: row.current_forecast ? row.window_end : null,
    confidence: row.current_forecast && row.confidence !== null ? Number(row.confidence) : null,
    cycles: row.current_forecast ? row.history_count : null,
    basis: null,
    exactEvents: row.exact_events,
    boundedEvents: row.bounded_events,
    observedEvents: row.observed_events,
    listedNow: row.listed_now,
    isFollowed: row.is_followed,
    seasonMatched: row.season_matched,
    locationMatched: row.location_matched,
  };
}

/** The roles one set of answers proposes, with how many roles the answers fit in all. */
export async function loadSeedRoles(userId: string, answers: OnboardingAnswers, now: Date): Promise<SeedResult> {
  // bounded: p_limit SEED_LIST_SIZE rows; the totals come back on each row, not from the list's length.
  const { data, error } = await createAdminClient().rpc("onboarding_seed_roles", {
    p_now: now.toISOString(),
    p_user_id: userId,
    ...seedRpcArgs(answers, now),
    p_limit: SEED_LIST_SIZE,
  });
  if (error) throw new Error("onboarding_seed_roles_read_failed");
  const rows = (data ?? []) as SeedRow[];
  const roles = rows.map(toSeedRole);
  const basis = await loadForecastBasis(createPublicReader(), roles.filter((role) => role.currentForecast).map((role) => role.id));
  return {
    roles: roles.map((role) => (role.currentForecast ? { ...role, basis: basis.get(role.id) ?? null } : role)),
    matchingRoles: Number(rows[0]?.matching_roles ?? 0),
    matchingCurrentForecasts: Number(rows[0]?.matching_current_forecasts ?? 0),
  };
}
