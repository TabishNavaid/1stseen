/**
 * The first run: four questions, the answers' meaning, and the URL they travel in.
 *
 * Pure and shared by the pages, the API route, and the tests. The seeding itself is `onboarding_seed_roles`
 * (migration 202608140030), so this file only decides what each answer asks that function for.
 */

export const TRACK_VALUES = ["software", "machine_learning", "data", "quantitative", "hardware", "engineering", "product"] as const;
export type TrackValue = (typeof TRACK_VALUES)[number];

/** The track question: seven plain choices that together cover the seventeen disciplines of docs/role-scope.md exactly once. */
export const TRACKS: ReadonlyArray<{ value: TrackValue; label: string; includes: string; disciplines: readonly string[] }> = [
  { value: "software", label: "Software engineering", includes: "Backend, frontend, mobile, infrastructure, and security", disciplines: ["software_engineering", "infrastructure", "security"] },
  { value: "machine_learning", label: "Machine learning and AI", includes: "ML engineering, applied science, and research", disciplines: ["machine_learning"] },
  { value: "data", label: "Data", includes: "Data engineering, data science, and analytics", disciplines: ["data"] },
  { value: "quantitative", label: "Quantitative", includes: "Quant research, trading, and development", disciplines: ["quantitative"] },
  { value: "hardware", label: "Hardware and robotics", includes: "Electrical, embedded, FPGA, controls, and autonomy", disciplines: ["hardware", "robotics"] },
  {
    value: "engineering",
    label: "Mechanical, aerospace, and other engineering",
    includes: "Mechanical, aerospace, manufacturing and process, materials, chemical, civil, and biomedical",
    disciplines: ["mechanical_engineering", "aerospace_engineering", "manufacturing_engineering", "materials_engineering", "chemical_engineering", "civil_engineering", "biomedical_engineering"],
  },
  { value: "product", label: "Product and design", includes: "Product and program management, UX and product design", disciplines: ["product_management", "design"] },
];

export const SEASON_VALUES = ["summer", "fall", "winter", "spring"] as const;
export type OnboardingSeason = (typeof SEASON_VALUES)[number];
export const SEASON_LABELS: Record<OnboardingSeason, string> = { summer: "Summer", fall: "Fall", winter: "Winter", spring: "Spring" };

export const MAX_PLACES = 3;
export const MAX_PLACE_LENGTH = 80;
export const MAX_SEED_FOLLOWS = 12;

export type OnboardingAnswers = {
  tracks: TrackValue[];
  graduationYear: number | null;
  season: OnboardingSeason | null;
  places: string[];
};

export const emptyAnswers: OnboardingAnswers = { tracks: [], graduationYear: null, season: null, places: [] };

type Params = Record<string, string | string[] | undefined>;

const all = (value: string | string[] | undefined) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const first = (value: string | string[] | undefined) => all(value)[0];

/** The graduation years offered: last year through five years out, plus a stored answer outside that range. */
export function graduationYears(today: Date, stored: number | null = null): number[] {
  const year = today.getUTCFullYear();
  const years = Array.from({ length: 7 }, (_, index) => year - 1 + index);
  return stored !== null && !years.includes(stored) ? [...years, stored].sort((a, b) => a - b) : years;
}

/**
 * Which early-career types a graduation year points at, as `personalization.py` ranks them: two or more years out is
 * internships and co-ops; next year is those and graduate programs, since final-year students recruit for both; this
 * year or earlier is graduate programs. No answer means every type.
 */
export function programTypesFor(graduationYear: number | null, today: Date): string[] {
  if (graduationYear === null) return [];
  const year = today.getUTCFullYear();
  const internships = ["internship", "co_op"];
  // Apprenticeships are full-time early-career roles, offered alongside graduate programs.
  const graduate = ["new_grad", "graduate_program", "rotational", "apprenticeship"];
  if (graduationYear >= year + 2) return internships;
  if (graduationYear === year + 1) return [...internships, ...graduate];
  return graduate;
}

export function programTypeSummary(graduationYear: number | null, today: Date): string {
  const types = programTypesFor(graduationYear, today);
  if (types.length === 0) return "every program type";
  if (!types.includes("new_grad")) return "internships and co-ops";
  if (!types.includes("internship")) return "new-grad, graduate, rotational, and apprenticeship programs";
  return "internships, co-ops, and new-grad programs";
}

export function disciplinesFor(tracks: readonly TrackValue[]): string[] {
  return [...new Set(TRACKS.filter((track) => tracks.includes(track.value)).flatMap((track) => track.disciplines))];
}

/** The tracks a stored discipline list came from: a track counts only when every one of its disciplines is present. */
export function tracksFromDisciplines(disciplines: readonly string[]): TrackValue[] {
  return TRACKS.filter((track) => track.disciplines.every((discipline) => disciplines.includes(discipline))).map((track) => track.value);
}

/** Places typed as "New York, NY or London; Toronto": a comma stays inside a place, "or" and semicolons separate them. */
export function parsePlaces(text: string | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const places: string[] = [];
  for (const raw of text.split(/;|\n|\s+or\s+/i)) {
    const place = raw.replace(/\s+/g, " ").trim();
    const key = place.toLowerCase();
    if (!place || place.length > MAX_PLACE_LENGTH || !/[a-z0-9]/i.test(place) || seen.has(key)) continue;
    seen.add(key);
    places.push(place);
    if (places.length === MAX_PLACES) break;
  }
  return places;
}

export const placesText = (places: readonly string[]) => places.join(" or ");

export function parseOnboardingAnswers(params: Params): OnboardingAnswers {
  const tracks = TRACK_VALUES.filter((value) => all(params.track).includes(value));
  const grad = Number(first(params.grad));
  const season = first(params.season);
  return {
    tracks,
    // The range recruiting_preferences accepts, so a stored year outside the offered list survives a round trip.
    graduationYear: Number.isInteger(grad) && grad >= 2000 && grad <= 2100 ? grad : null,
    season: SEASON_VALUES.includes(season as OnboardingSeason) ? (season as OnboardingSeason) : null,
    places: parsePlaces(first(params.place)),
  };
}

export function welcomeHref(answers: OnboardingAnswers, step?: "review"): string {
  const params = new URLSearchParams();
  if (step) params.set("step", step);
  for (const track of answers.tracks) params.append("track", track);
  if (answers.graduationYear !== null) params.set("grad", String(answers.graduationYear));
  if (answers.season) params.set("season", answers.season);
  if (answers.places.length) params.set("place", placesText(answers.places));
  const query = params.toString();
  return query ? `/welcome?${query}` : "/welcome";
}

export type StoredPreferences = {
  target_disciplines?: readonly string[] | null;
  graduation_year?: number | null;
  target_recruiting_season?: string | null;
  preferred_locations?: readonly string[] | null;
};

export function answersFromPreferences(row: StoredPreferences | null): OnboardingAnswers {
  if (!row) return emptyAnswers;
  const season = row.target_recruiting_season;
  return {
    tracks: tracksFromDisciplines(row.target_disciplines ?? []),
    graduationYear: row.graduation_year ?? null,
    season: SEASON_VALUES.includes(season as OnboardingSeason) ? (season as OnboardingSeason) : null,
    places: (row.preferred_locations ?? []).slice(0, MAX_PLACES),
  };
}

/** Arguments for `onboarding_seed_roles`; an unanswered question passes null, which matches every role. */
export function seedRpcArgs(answers: OnboardingAnswers, today: Date) {
  const disciplines = disciplinesFor(answers.tracks);
  const types = programTypesFor(answers.graduationYear, today);
  return {
    p_disciplines: disciplines.length ? disciplines : null,
    p_types: types.length ? types : null,
    p_season: answers.season,
    p_locations: answers.places.length ? answers.places : null,
  };
}

export function hasAnyAnswer(answers: OnboardingAnswers): boolean {
  return answers.tracks.length > 0 || answers.graduationYear !== null || answers.season !== null || answers.places.length > 0;
}

export const PLAN_OUTCOMES = ["ready", "not_configured", "unreachable", "refused", "none"] as const;
export type PlanOutcome = (typeof PLAN_OUTCOMES)[number];

/** What happened when the first run asked for a readiness plan, from the worker's HTTP status (lib/readiness-plan.ts). */
export function planOutcome(status: number): Exclude<PlanOutcome, "none"> {
  if (status >= 200 && status < 300) return "ready";
  if (status === 503) return "not_configured";
  if (status === 502) return "unreachable";
  return "refused";
}

export function parsePlanOutcome(value: string | string[] | undefined): PlanOutcome | null {
  const outcome = first(value);
  return PLAN_OUTCOMES.includes(outcome as PlanOutcome) ? (outcome as PlanOutcome) : null;
}

/** The line shown where the first run lands, for each outcome. Each says what happened and what to do next. */
export const PLAN_OUTCOME_MESSAGES: Record<PlanOutcome, string> = {
  ready: "Your watchlist is set. This is the soonest forecast among the roles you picked, and its preparation plan is below.",
  not_configured: "Your watchlist is set. Preparation plans are not configured on this deployment, so this role's forecast is shown without one.",
  unreachable: "Your watchlist is set. The preparation planner did not answer, so use Generate preparation plan below to try again.",
  refused: "Your watchlist is set. A preparation plan could not be built for this role; its forecast and evidence are below.",
  none: "Your watchlist is set. None of the roles you picked has enough history for a forecast yet, so there is no preparation date to work back from; each one lists the evidence that exists.",
};

/** The first run is offered unprompted only to an account that has neither finished nor skipped it and follows nothing. */
export function firstRunPending(state: { completedAt: string | null; skippedAt: string | null; followedRoles: number }): boolean {
  return state.completedAt === null && state.skippedAt === null && state.followedRoles === 0;
}
