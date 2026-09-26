import type { ForecastBasis } from "@/lib/forecast-basis";

/**
 * One presentation contract for a canonical role, used by both the real
 * Supabase reader and the development fixture.
 *
 * Nothing in this shape is synthesised. Every optional field is null when the
 * underlying record does not exist, so the page can say "not yet observed"
 * instead of rendering a plausible-looking value.
 */

export type DatePrecision = "exact" | "bounded" | "observed_by";

export type RoleCycle = {
  id: string;
  openedOn: string;
  closedOn: string | null;
  windowStart: string | null;
  windowEnd: string;
  precision: DatePrecision;
  uncertaintyDays: number | null;
  uncertaintyReason: string;
  sourceUrl: string | null;
  sourceKind: "official" | "archive";
  observedAt: string;
  evidenceQuote: string;
};

export type RoleProvenanceItem = {
  observationId: string;
  sourceUrl: string;
  observedAt: string;
  contentHash: string;
  extractionMethod: string;
  contribution: string;
  weight: number;
  rationale: string;
  precision: DatePrecision | null;
  signalKind: string | null;
};

/**
 * One contribution class, counted over every row the forecast links, not over the page being shown.
 *
 * A forecast can link more than a hundred rows and nearly all of them are one population's prior
 * observations sharing one rationale, so the classes and their weights are the part that answers
 * "what contributed"; the rows underneath are the receipts.
 */
export type RoleProvenanceGroup = {
  contribution: string;
  rationale: string;
  rows: number;
  weight: number;
  /** False when this class's rows do not all carry the one rationale, so each row must state its own. */
  uniformRationale: boolean;
};

export const PROVENANCE_PAGE_SIZE = 8;

export type RoleSignal = {
  id: string;
  kind: string;
  observedAt: string;
  strength: number;
  reliability: number;
  evidenceQuote: string;
  sourceUrl: string;
  extractionMethod: string;
};

export type RoleForecastView = {
  forecastId: string;
  asOf: string;
  expectedOpening: string;
  windowStart: string;
  windowEnd: string;
  daysUntilWindow: number;
  confidence: number;
  method: string;
  modelVersion: string;
  /** Cycles the model actually used, after repost collapsing in `cycles.py`. */
  historyCount: number;
  inputFingerprint: string;
  forecastedAt: string;
  /** The last recompute that confirmed this forecast, changed or not: freshness is measured from here. */
  lastVerifiedAt: string;
  calibratedProbability: number;
  priorEffectiveSampleSize: number;
  confidenceFactors: { label: string; value: string; tone: "positive" | "neutral" | "warning" }[];
  /** What the window mainly rests on, from this forecast's date weights (lib/forecast-basis). */
  basis: ForecastBasis | null;
};

export type RoleForecastVersion = {
  forecastId: string;
  asOf: string;
  expectedOpening: string;
  windowStart: string;
  windowEnd: string;
  confidence: number;
  modelVersion: string;
  /** This version's own basis; an earlier version can rest on different evidence than the current one. */
  basis: ForecastBasis | null;
  /** What this revision changed, in a reader's words, or null when it changed nothing they would feel. */
  change: {
    notes: string[];
    changedAt: string;
  } | null;
};

export type RoleMilestone = {
  kind: string;
  dueOn: string;
  idealDueOn: string;
  leadDays: number;
  policyVersion: string;
  rationale: string;
  completed: boolean;
};

export type RoleCurrentPosting = {
  title: string;
  applyUrl: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
  lastSeenAt: string | null;
};

export type RoleView = {
  origin: "real" | "fixture";
  id: string;
  company: string;
  companyMark: string;
  companyId: string | null;
  companyDomain: string | null;
  careersUrl: string | null;
  role: string;
  track: string;
  level: string;
  roleFamily: string;
  recruitingSeason: string;
  locationScope: string;
  /** The place as a person reads it (lib/display-names), from the role's own postings when one matches; absent for a fixture. */
  place?: string;
  /** Present when the statistical engine produced a stored forecast. */
  forecast: RoleForecastView | null;
  /** Plain-language reason a forecast is absent. Null when a forecast exists. */
  insufficientEvidence: string | null;
  /**
   * Set when the model declined the role after its latest stored forecast: that forecast and every earlier one are
   * history, not a current window (migration 202608140043). The reason is forecasting.py's own.
   */
  forecastRefusal: { refusedAt: string; reason: string } | null;
  forecastVersions: RoleForecastVersion[];
  cycles: RoleCycle[];
  precisionCounts: { exact: number; bounded: number; observed_by: number };
  /** One page of individual contributions, `PROVENANCE_PAGE_SIZE` at a time. */
  provenance: RoleProvenanceItem[];
  /** Every contribution class the stored forecast links, with counts and weights over all of them. */
  provenanceGroups: RoleProvenanceGroup[];
  /** Total contributions linked to the stored forecast, and which page of them `provenance` holds. */
  provenanceTotal: number;
  provenancePage: number;
  signals: RoleSignal[];
  currentPostings: RoleCurrentPosting[];
  milestones: RoleMilestone[];
  /** Null when nobody is signed in; false when signed in and not following. */
  isFollowed: boolean | null;
  watchlistItemId: string | null;
  observationCount: number;
};
