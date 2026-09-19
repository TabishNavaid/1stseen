import { z } from "zod";

export const idSchema = z.string().uuid();
export const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const isoDateTimeSchema = z.string().datetime({ offset: true });
export const httpUrlSchema = z.string().url().refine(
  (value) => ["http:", "https:"].includes(new URL(value).protocol),
  "Only HTTP(S) URLs are allowed",
);

export const provenanceSchema = z.object({
  sourceId: idSchema,
  sourceUrl: httpUrlSchema,
  observationId: idSchema,
  observedAt: isoDateTimeSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  evidenceQuote: z.string().min(1),
  extractionMethod: z.enum(["http", "playwright", "api", "archive"]),
});
export type Provenance = z.infer<typeof provenanceSchema>;

export const canonicalRoleKeySchema = z.object({
  companyId: idSchema,
  canonicalTitle: z.string().min(2),
  track: z.enum(["internship", "new_grad", "apprenticeship", "other"]),
  locationScope: z.string().min(2),
  recurrenceKey: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
});
export type CanonicalRoleKey = z.infer<typeof canonicalRoleKeySchema>;

export const roleResolutionSchema = z.object({
  observationId: idSchema,
  canonicalRoleId: idSchema,
  observedAlias: z.string().min(1),
  decision: z.enum(["matched", "created"]),
  matchConfidence: z.number().min(0).max(1),
  featureScores: z.record(z.string(), z.number().min(0).max(1)),
  reasons: z.array(z.string().min(1)).min(1),
  usedEmbedding: z.boolean(),
  usedLlm: z.boolean(),
  resolverVersion: z.string().min(1),
});
export type RoleResolution = z.infer<typeof roleResolutionSchema>;

export const recruitingSignalSchema = z.object({
  id: idSchema,
  identityKey: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  companyId: idSchema,
  company: z.string().min(1),
  canonicalRoleId: idSchema.nullable(),
  signalType: z.enum([
    "career_page_changed",
    "internship_program_page_changed",
    "new_relevant_sitemap_url",
    "company_recruiting_blog_post",
    "university_recruiting_page_update",
    "new_ats_role_family_appearing",
    "community_recruiting_discussion",
  ]),
  observedAt: isoDateTimeSchema,
  claimedEventAt: isoDateTimeSchema.nullable(),
  sourcePublishedAt: isoDateTimeSchema.nullable(),
  communityEventType: z.enum([
    "applications_opened", "applications_closed", "applications_opening_soon",
  ]).nullable(),
  claimedDateText: z.string().max(200).nullable(),
  claimedDatePrecision: z.enum([
    "explicit", "relative_to_post", "relative_unresolved", "unknown",
  ]).nullable(),
  evidenceSemantics: z.literal("supporting_only"),
  sourceId: idSchema,
  sourceUrl: httpUrlSchema,
  sourceReliability: z.number().min(0).max(1),
  signalStrength: z.number().min(0).max(1),
  evidenceSnippet: z.string().min(1).max(8192),
  extractionMethod: z.enum([
    "structured_endpoint", "json_ld", "embedded_data", "static_html",
    "playwright", "llm", "archive",
  ]),
  observationId: idSchema,
});
export type RecruitingSignal = z.infer<typeof recruitingSignalSchema>;

export const recruitingAgentProgressSchema = z.object({
  type: z.enum([
    "run_started", "tool_started", "tool_completed", "evidence_assessed",
    "answer_completed", "run_failed",
  ]),
  run_id: idSchema,
  message: z.string().min(1),
  tool: z.enum([
    "discover_company", "get_current_jobs", "inspect_career_page", "get_role_history",
    "inspect_archives", "get_recruiting_signals", "resolve_role", "generate_forecast",
    "get_forecast_evidence", "create_readiness_plan",
    "answer_portfolio_question",
  ]).nullable(),
  data: z.record(z.string(), z.unknown()),
  timestamp: isoDateTimeSchema,
});
export type RecruitingAgentProgress = z.infer<typeof recruitingAgentProgressSchema>;

export const usefulQuestionResultSchema = z.object({
  question_class: z.enum([
    "upcoming_openings", "prepare_now", "forecast_change", "confidence_explanation",
    "watched_networking", "earliest_companies", "referral_ready",
  ]),
  as_of: isoDateSchema,
  summary: z.string().min(1),
  items: z.array(z.record(z.string(), z.unknown())),
  stale_role_count: z.number().int().min(0),
  limitations: z.array(z.string()),
});
export type UsefulQuestionResult = z.infer<typeof usefulQuestionResultSchema>;

export const readinessPlanSchema = z.object({
  role_id: idSchema,
  based_on_forecast_id: idSchema.nullable(),
  policy_version: z.string().min(1),
  generated_on: isoDateSchema,
  expected_opening_date: isoDateSchema,
  interval_start: isoDateSchema,
  interval_end: isoDateSchema,
  context: z.object({
    company_size: z.enum(["startup", "small", "medium", "large", "enterprise", "unknown"]),
    recruiting_scale: z.number().min(0).max(1),
    role_competitiveness: z.number().min(0).max(1),
    role_family: z.string().min(1),
    portfolio_required: z.boolean().nullable(),
  }),
  total_adjustment_days: z.number().int(),
  milestones: z.array(z.object({
    kind: z.enum([
      "networking", "referral_contacts", "resume_ready", "portfolio_ready", "high_alert",
    ]),
    title: z.string().min(1),
    due_on: isoDateSchema,
    ideal_due_on: isoDateSchema,
    lead_days: z.number().int().nonnegative(),
    is_immediate: z.boolean(),
    rationale: z.string().min(1),
    adjustments: z.array(z.object({
      factor: z.enum([
        "company_size", "recruiting_scale", "role_competitiveness",
        "forecast_interval_width", "forecast_confidence",
      ]),
      days: z.number().int(),
      explanation: z.string().min(1),
    })).length(5),
  })).min(4).max(5),
});
export type ReadinessPlan = z.infer<typeof readinessPlanSchema>;

export const followTargetSchema = z.discriminatedUnion("target_type", [
  z.object({
    target_type: z.literal("company"),
    company_id: idSchema,
    alerts_enabled: z.boolean().default(true),
  }).strict(),
  z.object({
    target_type: z.literal("canonical_role"),
    canonical_role_id: idSchema,
    alerts_enabled: z.boolean().default(true),
  }).strict(),
  z.object({
    target_type: z.literal("role_family"),
    role_family: z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
    alerts_enabled: z.boolean().default(true),
  }).strict(),
  z.object({
    target_type: z.literal("track"),
    track: z.enum(["internship", "new_grad"]),
    alerts_enabled: z.boolean().default(true),
  }).strict(),
]);
export type FollowTarget = z.infer<typeof followTargetSchema>;

export const recruitingPreferencesSchema = z.object({
  target_role_families: z.array(
    z.string().regex(/^[a-z0-9]+(?:_[a-z0-9]+)*$/),
  ),
  graduation_year: z.number().int().min(2000).max(2100).nullable(),
  target_recruiting_season: z.enum([
    "spring", "summer", "fall", "winter", "year_round", "unknown",
  ]).nullable(),
  preferred_locations: z.array(z.string().trim().min(1).max(200)),
  priority_companies: z.array(z.object({
    company_id: idSchema,
    priority: z.number().int().min(1).max(5),
  })),
  company_size_preferences: z.array(z.enum([
    "startup", "small", "medium", "large", "enterprise", "unknown",
  ])),
});
export type RecruitingPreferences = z.infer<typeof recruitingPreferencesSchema>;

export const personalizedTimelineSchema = z.object({
  user_id: idSchema,
  as_of: isoDateSchema,
  ranking_version: z.literal("followed-timeline-ranking-v1"),
  items: z.array(z.object({
    role_id: idSchema,
    company_id: idSchema,
    company: z.string().min(1),
    role: z.string().min(1),
    role_family: z.string().min(1),
    track: z.enum(["internship", "new_grad", "apprenticeship", "other"]),
    recruiting_season: z.enum([
      "spring", "summer", "fall", "winter", "year_round", "unknown",
    ]),
    location_scope: z.string().min(1),
    company_size: z.enum(["startup", "small", "medium", "large", "enterprise", "unknown"]),
    forecast_id: idSchema,
    forecast_as_of: isoDateSchema,
    expected_opening_date: isoDateSchema,
    interval_start: isoDateSchema,
    interval_end: isoDateSchema,
    confidence: z.number().min(0).max(100),
    next_milestone: z.enum([
      "networking", "referral_contacts", "resume_ready", "portfolio_ready", "high_alert",
    ]).nullable(),
    next_milestone_due_on: isoDateSchema.nullable(),
    rank_score: z.number().int().nonnegative(),
    rank_reasons: z.array(z.string().min(1)).min(1),
    followed_by: z.array(z.string().min(1)).min(1),
  })),
  excluded_stale_forecast_count: z.number().int().nonnegative(),
  limitations: z.array(z.string()),
});
export type PersonalizedTimeline = z.infer<typeof personalizedTimelineSchema>;

export const forecastResultSchema = z.object({
  roleId: idSchema,
  asOf: isoDateSchema,
  pointDate: isoDateSchema,
  windowStart: isoDateSchema,
  windowEnd: isoDateSchema,
  confidence: z.number().min(0).max(100),
  calibratedProbability: z.number().min(0).max(1),
  confidenceFactors: z.record(z.string(), z.number().min(0).max(1)),
  featureContributions: z.array(z.object({
    name: z.string().min(1),
    kind: z.enum(["role_history", "company_prior", "role_family_prior", "signal", "context"]),
    dateWeight: z.number().min(0).max(1),
    confidenceEffect: z.number().min(-1).max(1),
    influencesDate: z.boolean(),
    rationale: z.string().min(1),
    evidenceId: z.string().nullable().optional(),
    evidenceIds: z.array(z.string()).optional(),
    evidenceDate: isoDateSchema.nullable().optional(),
  })).min(1),
  method: z.string().min(1),
  modelVersion: z.string().min(1),
  forecastedAt: isoDateTimeSchema,
  historyCount: z.number().int().min(0),
  priorEffectiveSampleSize: z.number().nonnegative(),
  predictionIntervalCoverage: z.number().gt(0).lt(1),
  inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: z.array(provenanceSchema).min(1),
});
export type ForecastResult = z.infer<typeof forecastResultSchema>;

export const forecastReplayResultSchema = z.object({
  schema_version: z.literal("forecast-replay-v2"),
  role_id: idSchema,
  target_event_id: idSchema,
  target_year: z.number().int().min(1900).max(2200),
  forecast_cutoff: isoDateSchema,
  forecasted_at: isoDateTimeSchema,
  evidence: z.array(z.object({
    id: idSchema,
    kind: z.enum(["role_history", "company_prior", "role_family_prior", "signal"]),
    evidence_on: isoDateSchema,
    available_at: isoDateTimeSchema,
    source_quality: z.number().min(0).max(1),
    uncertainty_days: z.number().nonnegative().nullable(),
  })),
  expected_opening_date: isoDateSchema,
  interval_start: isoDateSchema,
  interval_end: isoDateSchema,
  confidence: z.number().min(0).max(100),
  actual_opened_on: isoDateSchema,
  actual_interval_start: isoDateSchema,
  actual_interval_end: isoDateSchema,
  target_date_precision: z.enum(["exact", "bounded"]),
  absolute_error_days: z.number().int().nonnegative(),
  inside_interval: z.boolean(),
  model_version: z.string().min(1),
  input_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  // The replayed forecast's date weight from the program's own openings and from comparable programs (its basis).
  own_history_weight: z.number().min(0).optional(),
  borrowed_weight: z.number().min(0).optional(),
}).superRefine((value, context) => {
  if (value.forecast_cutoff >= value.actual_opened_on) {
    context.addIssue({ code: "custom", message: "replay cutoff must precede actual opening" });
  }
  if (value.actual_interval_start > value.actual_opened_on || value.actual_opened_on > value.actual_interval_end) {
    context.addIssue({ code: "custom", message: "actual opening must lie inside its uncertainty interval" });
  }
  if (value.evidence.some((item) => item.id === value.target_event_id)) {
    context.addIssue({ code: "custom", message: "held-out target cannot be replay evidence" });
  }
  if (value.evidence.some((item) => item.evidence_on > value.forecast_cutoff || item.available_at.slice(0, 10) > value.forecast_cutoff)) {
    context.addIssue({ code: "custom", message: "replay evidence must be cutoff-safe" });
  }
});
export type ForecastReplayResult = z.infer<typeof forecastReplayResultSchema>;

export const forecastRoleSchema = z.object({
  id: z.string().min(1),
  company: z.string().min(1),
  companyMark: z.string().min(1).max(2),
  role: z.string().min(2),
  track: z.enum(["Internship", "New grad"]),
  location: z.string().min(2),
  window: z.string().min(3),
  daysUntil: z.number().int().nonnegative(),
  confidence: z.number().min(0).max(100),
  readiness: z.number().min(0).max(100),
  status: z.enum(["warming", "quiet", "signal"]),
  // Every opening behind the window. A sparse role's forecast may rest on one cycle, or none, plus comparable programs'
  // timing (docs/forecasting-methodology.md), so this is not a minimum; history_count says how many cycles there are.
  historicalCycles: z.array(z.string()),
  signalSummary: z.string().min(1),
  nextDeadline: z.string().min(1),
  deadlines: z.array(z.object({ label: z.string(), date: z.string(), done: z.boolean().optional() })),
  confidenceFactors: z.array(z.object({
    label: z.string(),
    value: z.string(),
    tone: z.enum(["positive", "neutral", "warning"]),
  })),
  evidence: z.array(z.object({
    label: z.string(),
    detail: z.string(),
    date: z.string(),
    kind: z.enum(["posting", "signal", "archive"]),
  })),
});
export const forecastRolesSchema = z.array(forecastRoleSchema);
export type ForecastRole = z.infer<typeof forecastRoleSchema>;
