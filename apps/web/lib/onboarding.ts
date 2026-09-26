/**
 * The first run: three questions, what each answer asks the dashboard's read path for, and the URL they travel in.
 *
 * Anyone can answer them, signed in or not. A guest's answers stay in the browser (lib/guest-onboarding.ts) and
 * personalize their view through the URL; they carry into an account when the guest signs up. Nothing here reads data:
 * the payoff is `dashboard_role_summary` and `dashboard_role_page` for the filters these answers make, through the public
 * reader, so a first run can never propose a role the dashboard would not list.
 *
 * Pure and shared by the pages, the API route, and the tests.
 */

// Relative with its extension, so Node's test runner loads this file directly; Vite resolves it either way.
import { dashboardHref, defaultDashboardFilters, type DashboardFilters, type Discipline, type ProgramType } from "./dashboard-query.ts";
import type { IconName } from "@/components/ui/icon-names";

export type LookingFor = "internship" | "new_grad" | "co_op";

/** Question one. "New grad" covers every full-time early-career program type, as the scope does (docs/role-scope.md). */
export const LOOKING_FOR: ReadonlyArray<{ value: LookingFor; label: string; hint: string; icon: IconName; types: readonly ProgramType[] }> = [
  { value: "internship", label: "Internship", hint: "A summer or term placement while you study", icon: "backpack", types: ["internship"] },
  { value: "new_grad", label: "New grad", hint: "Full-time roles and programs after you graduate", icon: "graduation-cap", types: ["new_grad", "graduate_program", "rotational", "apprenticeship"] },
  { value: "co_op", label: "Co-op", hint: "Paid work terms that alternate with school", icon: "repeat", types: ["co_op"] },
];

export const LOOKING_FOR_VALUES: readonly LookingFor[] = LOOKING_FOR.map((option) => option.value);

export type FieldValue = Discipline | "other_engineering";

/**
 * Question two: eleven fields that together cover the scope's seventeen disciplines exactly once (docs/role-scope.md).
 * Ten are one discipline each; "Other engineering" is the seven engineering disciplines outside computing.
 */
export const FIELDS: ReadonlyArray<{ value: FieldValue; label: string; name: string; icon: IconName; disciplines: readonly Discipline[] }> = [
  { value: "software_engineering", label: "SWE", name: "Software engineering", icon: "code-xml", disciplines: ["software_engineering"] },
  { value: "machine_learning", label: "ML/AI", name: "Machine learning and AI", icon: "brain-circuit", disciplines: ["machine_learning"] },
  { value: "data", label: "Data", name: "Data engineering and science", icon: "chart-column", disciplines: ["data"] },
  { value: "infrastructure", label: "Infra", name: "Infrastructure and SRE", icon: "server", disciplines: ["infrastructure"] },
  { value: "security", label: "Security", name: "Security", icon: "shield", disciplines: ["security"] },
  { value: "hardware", label: "Hardware", name: "Hardware and embedded", icon: "cpu", disciplines: ["hardware"] },
  { value: "robotics", label: "Robotics", name: "Robotics and controls", icon: "bot", disciplines: ["robotics"] },
  { value: "quantitative", label: "Quant", name: "Quant research, trading, and development", icon: "chart-line", disciplines: ["quantitative"] },
  { value: "product_management", label: "PM", name: "Product management", icon: "square-kanban", disciplines: ["product_management"] },
  { value: "design", label: "Design", name: "Design and UX research", icon: "palette", disciplines: ["design"] },
  {
    value: "other_engineering",
    label: "Other engineering",
    name: "Mechanical, aerospace, manufacturing, materials, chemical, civil, and biomedical engineering",
    icon: "wrench",
    disciplines: ["mechanical_engineering", "aerospace_engineering", "manufacturing_engineering", "materials_engineering", "chemical_engineering", "civil_engineering", "biomedical_engineering"],
  },
];

export const FIELD_VALUES: readonly FieldValue[] = FIELDS.map((field) => field.value);

/** The disciplines a set of fields covers, in scope order. */
export function disciplinesForFields(fields: readonly FieldValue[]): Discipline[] {
  return [...new Set(FIELDS.filter((field) => fields.includes(field.value)).flatMap((field) => field.disciplines))];
}

/** Question three: at most this many companies. */
export const MAX_COMPANIES = 10;
/** A first run follows at most this many roles. */
export const MAX_SEED_FOLLOWS = 12;
/** How many roles the payoff lists: the ones that are followed when the answers are saved. */
export const PAYOFF_ROLES = 6;
/** How many of the most-tracked companies step three suggests. */
export const POPULAR_COMPANIES = 6;

export const ONBOARDING_STEPS = 4;

export type OnboardingAnswers = {
  lookingFor: LookingFor | null;
  fields: FieldValue[];
  companies: string[];
};

export const emptyAnswers: OnboardingAnswers = { lookingFor: null, fields: [], companies: [] };

type Params = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const all = (value: string | string[] | undefined) => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const first = (value: string | string[] | undefined) => all(value)[0];

/** Answers from anywhere untrusted (a URL, local storage, a request body): unknown values are dropped, never guessed. */
export function cleanAnswers(raw: { lookingFor?: unknown; fields?: unknown; companies?: unknown }): OnboardingAnswers {
  const lookingFor = LOOKING_FOR_VALUES.includes(raw.lookingFor as LookingFor) ? (raw.lookingFor as LookingFor) : null;
  const wanted = Array.isArray(raw.fields) ? (raw.fields as unknown[]) : [];
  const fields = FIELD_VALUES.filter((value) => wanted.includes(value));
  const companies = Array.isArray(raw.companies)
    ? [...new Set((raw.companies as unknown[]).filter((value): value is string => typeof value === "string" && UUID.test(value)).map((value) => value.toLowerCase()))].slice(0, MAX_COMPANIES)
    : [];
  return { lookingFor, fields, companies };
}

export function parseOnboardingAnswers(params: Params): OnboardingAnswers {
  return cleanAnswers({ lookingFor: first(params.for), fields: all(params.field), companies: all(params.company) });
}

export function hasAnyAnswer(answers: OnboardingAnswers): boolean {
  return answers.lookingFor !== null || answers.fields.length > 0 || answers.companies.length > 0;
}

/** The first run's URL for these answers; `step: "ready"` is the payoff, a server render of exactly these answers. */
export function welcomeHref(answers: OnboardingAnswers, step?: "ready"): string {
  const params = new URLSearchParams();
  if (step) params.set("step", step);
  if (answers.lookingFor) params.set("for", answers.lookingFor);
  for (const field of answers.fields) params.append("field", field);
  for (const company of answers.companies) params.append("company", company);
  const query = params.toString();
  return query ? `/welcome?${query}` : "/welcome";
}

/** The program types a "looking for" answer covers; none means every type. */
export function programTypesFor(lookingFor: LookingFor | null): ProgramType[] {
  return lookingFor ? [...(LOOKING_FOR.find((option) => option.value === lookingFor)?.types ?? [])] : [];
}

/**
 * The dashboard filters the answers make. Companies are not a filter: someone watching three companies still wants to
 * see every program that fits, so the payoff lists the watched companies' programs first instead of only theirs.
 */
export function answersToFilters(answers: OnboardingAnswers): DashboardFilters {
  return { ...defaultDashboardFilters, types: programTypesFor(answers.lookingFor), disciplines: disciplinesForFields(answers.fields) };
}

/** Where "keep browsing" goes: the roles page, filtered to the answers. */
export function browseHref(answers: OnboardingAnswers): string {
  return dashboardHref(answersToFilters(answers));
}

/**
 * The answers in a few plain words, for the payoff's subtitle: "Internship · SWE, ML/AI · Acme first". Company names
 * come from the caller, which has the list; without them the companies are counted.
 */
/** What a program type is called in a sentence. */
const PROGRAM_WORDS: Record<LookingFor, string> = { internship: "Internships", new_grad: "New-grad roles", co_op: "Co-ops" };

/** A field in running text, where its chip label is an abbreviation. */
const FIELD_WORDS: Partial<Record<FieldValue, string>> = {
  software_engineering: "software engineering",
  machine_learning: "AI/ML",
  infrastructure: "infrastructure",
  product_management: "product management",
};

function listWords(words: readonly string[]): string {
  return words.length <= 2 ? words.join(" and ") : `${words.slice(0, -1).join(", ")}, and ${words[words.length - 1]}`;
}

/** The answers as a sentence: "Internships in software engineering and data, with Stripe first". */
export function answersSummary(answers: OnboardingAnswers, companyName: (id: string) => string | undefined = () => undefined): string {
  const program = answers.lookingFor ? PROGRAM_WORDS[answers.lookingFor] : "Every program";
  const fields = FIELDS.filter((field) => answers.fields.includes(field.value)).map((field) => FIELD_WORDS[field.value] ?? field.label.toLowerCase());
  const where = !fields.length ? "in every field" : fields.length > 3 ? `in ${fields.length} fields` : `in ${listWords(fields)}`;
  const names = answers.companies.map(companyName).filter((name): name is string => Boolean(name));
  const companies = !answers.companies.length
    ? ""
    : names.length === answers.companies.length && names.length <= 2
      ? `, with ${names.join(" and ")} first`
      : `, with your ${answers.companies.length} ${answers.companies.length === 1 ? "company" : "companies"} first`;
  return `${program} ${where}${companies}`;
}

export type StoredPreferences = {
  target_disciplines?: readonly string[] | null;
  graduation_year?: number | null;
  target_recruiting_season?: string | null;
  preferred_locations?: readonly string[] | null;
};

/**
 * What a stored account says about the fields: a field is chosen when every discipline it covers is stored. The program
 * type has no column; the roles followed carry it.
 */
export function answersFromPreferences(row: StoredPreferences | null): OnboardingAnswers {
  const stored = row?.target_disciplines ?? [];
  return cleanAnswers({ fields: FIELDS.filter((field) => field.disciplines.every((discipline) => stored.includes(discipline))).map((field) => field.value) });
}

export const SEASON_LABELS: Record<string, string> = { summer: "Summer", fall: "Fall", winter: "Winter", spring: "Spring", year_round: "Year-round" };

/** Answers an earlier version of the first run asked and this one does not, still shown in settings while stored. */
export type LegacyPreferences = { graduationYear: number | null; season: string | null; places: string[] };

export function legacyFromPreferences(row: StoredPreferences | null): LegacyPreferences {
  return {
    graduationYear: row?.graduation_year ?? null,
    season: row?.target_recruiting_season && row.target_recruiting_season !== "unknown" ? row.target_recruiting_season : null,
    places: [...(row?.preferred_locations ?? [])],
  };
}

export const PLAN_OUTCOMES = ["ready", "not_configured", "unreachable", "refused", "none"] as const;
export type PlanOutcome = (typeof PLAN_OUTCOMES)[number];

/**
 * What happened when the first run asked for a readiness plan (lib/readiness-plan.ts).
 *
 * The status alone is not enough. `requestReadinessPlan` answers 503 in three situations — there is no planner
 * configured, there is one and it did not answer, and there is one and it answered with something that was not its
 * own verdict — and only the first of those is "not configured on this deployment". Reading the status alone told
 * every reader whose planner was merely down that the product does not do preparation plans, which is both untrue
 * and the one message that tells them not to try again.
 */
export function planOutcome(status: number, error?: string | null): Exclude<PlanOutcome, "none"> {
  if (status >= 200 && status < 300) return "ready";
  if (status === 503) return error === "readiness_api_unavailable" ? "not_configured" : "unreachable";
  if (status === 502) return "unreachable";
  return "refused";
}

/** The error code in a readiness-plan reply, when it carries one. */
export function planError(payload: unknown): string | null {
  return typeof payload === "object" && payload !== null && typeof (payload as { error?: unknown }).error === "string"
    ? (payload as { error: string }).error
    : null;
}

export function parsePlanOutcome(value: string | string[] | undefined): PlanOutcome | null {
  const outcome = first(value);
  return PLAN_OUTCOMES.includes(outcome as PlanOutcome) ? (outcome as PlanOutcome) : null;
}

/** The line shown where the first run lands, for each outcome. Each says what happened and what to do next. */
export const PLAN_OUTCOME_MESSAGES: Record<PlanOutcome, string> = {
  ready: "Your watchlist is set. This is the soonest forecast among the roles you picked, and its preparation plan is below.",
  not_configured: "Your watchlist is set. Preparation plans are not configured on this deployment, so this role's forecast is shown without one.",
  unreachable: "Your watchlist is set. The preparation planner did not answer, so use Build my prep plan below to try again.",
  refused: "Your watchlist is set. A preparation plan could not be built for this role; its forecast and evidence are below.",
  none: "Your watchlist is set. None of the roles you picked has enough history for a forecast yet, so there is no preparation date to work back from; each one lists the evidence that exists.",
};

/** The first run is offered unprompted only to an account that has neither finished nor skipped it and follows nothing. */
export function firstRunPending(state: { completedAt: string | null; skippedAt: string | null; followedRoles: number }): boolean {
  return state.completedAt === null && state.skippedAt === null && state.followedRoles === 0;
}
