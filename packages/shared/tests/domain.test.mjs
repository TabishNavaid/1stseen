import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalRoleKeySchema,
  forecastReplayResultSchema,
  forecastResultSchema,
  provenanceSchema,
  recruitingSignalSchema,
  recruitingAgentProgressSchema,
  readinessPlanSchema,
  followTargetSchema,
  recruitingPreferencesSchema,
  personalizedTimelineSchema,
  usefulQuestionResultSchema,
  roleResolutionSchema,
} from "../src/index.ts";

const evidence = {
  sourceId: "00000000-0000-4000-8000-000000000101",
  sourceUrl: "https://careers.example.test/students",
  observationId: "00000000-0000-4000-8000-000000000201",
  observedAt: "2026-08-14T08:00:00+00:00",
  contentHash: "a".repeat(64),
  evidenceQuote: "Applications open in September.",
  extractionMethod: "http",
};

test("provenance requires immutable evidence identity", () => {
  assert.equal(provenanceSchema.parse(evidence).contentHash.length, 64);
  assert.throws(() => provenanceSchema.parse({ ...evidence, sourceUrl: "not-a-url" }));
});

test("agent progress exposes observable actions without private reasoning", () => {
  const event = recruitingAgentProgressSchema.parse({
    type: "tool_completed",
    run_id: "00000000-0000-4000-8000-000000000901",
    message: "Checked 4 historical recruiting cycles.",
    tool: "get_role_history",
    data: {
      evidence_count: 4,
      source_count: 2,
      duration_ms: 31,
      execution_kind: "deterministic_tool",
      model_provider: null,
    },
    timestamp: "2026-08-14T10:00:00+00:00",
  });
  assert.equal(event.tool, "get_role_history");
  assert.equal(event.data.source_count, 2);
  assert.equal(event.data.model_provider, null);
  assert.equal("chain_of_thought" in event.data, false);
});

test("useful agent questions return structured results alongside summaries", () => {
  const result = usefulQuestionResultSchema.parse({
    question_class: "upcoming_openings",
    as_of: "2026-08-14",
    summary: "One internship forecast overlaps the next 30 days.",
    items: [{
      company: "Northstar Systems",
      role: "Software Engineering Intern",
      expected_opening_date: "2026-09-13",
      confidence: 70.8,
    }],
    stale_role_count: 0,
    limitations: [],
  });
  assert.equal(result.items.length, 1);
});

test("readiness plans expose dates and every deterministic adjustment", () => {
  const factors = [
    ["company_size", 9],
    ["recruiting_scale", 4],
    ["role_competitiveness", 7],
    ["forecast_interval_width", 3],
    ["forecast_confidence", 0],
  ].map(([factor, days]) => ({ factor, days, explanation: `${factor} policy adjustment.` }));
  const result = readinessPlanSchema.parse({
    role_id: "00000000-0000-4000-8000-000000000011",
    based_on_forecast_id: "00000000-0000-4000-8000-000000000501",
    policy_version: "readiness-workback-v1",
    generated_on: "2026-08-14",
    expected_opening_date: "2026-09-13",
    interval_start: "2026-09-04",
    interval_end: "2026-09-22",
    context: {
      company_size: "enterprise",
      recruiting_scale: 0.75,
      role_competitiveness: 0.9,
      role_family: "software_engineering",
      portfolio_required: true,
    },
    total_adjustment_days: 23,
    milestones: ["networking", "referral_contacts", "portfolio_ready", "resume_ready", "high_alert"]
      .map((kind) => ({
        kind,
        title: `Prepare ${kind}`,
        due_on: "2026-08-14",
        ideal_due_on: "2026-07-01",
        lead_days: 50,
        is_immediate: true,
        rationale: "The ideal date passed, so this is due now.",
        adjustments: factors,
      })),
  });
  assert.equal(result.milestones.length, 5);
  assert.equal(result.milestones[0].adjustments.length, 5);
});

test("watchlist targets are explicit and preferences cannot masquerade as follows", () => {
  assert.equal(followTargetSchema.parse({
    target_type: "track",
    track: "internship",
  }).alerts_enabled, true);
  assert.throws(() => followTargetSchema.parse({
    target_type: "track",
    track: "new_grad",
    company_id: "00000000-0000-4000-8000-000000000001",
  }));
  const preferences = recruitingPreferencesSchema.parse({
    target_role_families: ["software_engineering"],
    graduation_year: 2027,
    target_recruiting_season: "fall",
    preferred_locations: ["United States — Remote"],
    priority_companies: [{
      company_id: "00000000-0000-4000-8000-000000000001",
      priority: 5,
    }],
    company_size_preferences: ["enterprise"],
  });
  assert.equal(preferences.priority_companies[0].priority, 5);
});

test("personalized timelines retain follow and ranking explanations", () => {
  const timeline = personalizedTimelineSchema.parse({
    user_id: "00000000-0000-4000-8000-000000000001",
    as_of: "2026-08-14",
    ranking_version: "followed-timeline-ranking-v1",
    items: [{
      role_id: "00000000-0000-4000-8000-000000000011",
      company_id: "00000000-0000-4000-8000-000000000001",
      company: "Northstar Systems",
      role: "Software Engineering Intern",
      role_family: "software_engineering",
      track: "internship",
      recruiting_season: "fall",
      location_scope: "united_states_remote",
      company_size: "enterprise",
      forecast_id: "00000000-0000-4000-8000-000000000501",
      forecast_as_of: "2026-08-14",
      expected_opening_date: "2026-09-13",
      interval_start: "2026-09-04",
      interval_end: "2026-09-22",
      confidence: 70.8,
      next_milestone: "resume_ready",
      next_milestone_due_on: "2026-08-14",
      rank_score: 96,
      rank_reasons: ["Explicit canonical role follow (+40)."],
      followed_by: ["canonical_role:00000000-0000-4000-8000-000000000011"],
    }],
    excluded_stale_forecast_count: 0,
    limitations: [],
  });
  assert.equal(timeline.items[0].rank_score, 96);
});

test("canonical roles require a stable recurrence key", () => {
  const parsed = canonicalRoleKeySchema.parse({
    companyId: "00000000-0000-4000-8000-000000000001",
    canonicalTitle: "Software Engineering Intern",
    track: "internship",
    locationScope: "United States",
    recurrenceKey: "software_engineering_intern_us",
  });
  assert.equal(parsed.track, "internship");
});

test("role resolution confidence is bounded and evidence-backed", () => {
  const resolution = {
    observationId: "00000000-0000-4000-8000-000000000201",
    canonicalRoleId: "00000000-0000-4000-8000-000000000011",
    observedAlias: "SWE Intern",
    decision: "matched",
    matchConfidence: 0.94,
    featureScores: { title: 0.96, level_compatible: 1 },
    reasons: ["Same company, level, family, and verified alias."],
    usedEmbedding: false,
    usedLlm: false,
    resolverVersion: "hybrid-role-resolver-v1",
  };
  assert.equal(roleResolutionSchema.parse(resolution).decision, "matched");
  assert.throws(() => roleResolutionSchema.parse({ ...resolution, matchConfidence: 1.1 }));
});

test("forecasts require provenance while allowing sparse role history with priors", () => {
  const base = {
    roleId: "00000000-0000-4000-8000-000000000011",
    asOf: "2026-08-14",
    pointDate: "2026-09-12",
    windowStart: "2026-09-05",
    windowEnd: "2026-09-19",
    confidence: 82,
    calibratedProbability: 0.82,
    confidenceFactors: { sample_strength: 0.74 },
    featureContributions: [{
      name: "company internship season",
      kind: "company_prior",
      dateWeight: 1,
      confidenceEffect: 0.4,
      influencesDate: true,
      rationale: "Sparse-data seasonal prior.",
    }],
    method: "circular_mean",
    modelVersion: "v1",
    forecastedAt: "2026-08-14T08:00:00+00:00",
    historyCount: 0,
    priorEffectiveSampleSize: 4,
    predictionIntervalCoverage: 0.8,
    inputFingerprint: "b".repeat(64),
  };
  assert.throws(() => forecastResultSchema.parse({ ...base, evidence: [] }));
  assert.equal(forecastResultSchema.parse({ ...base, evidence: [evidence] }).historyCount, 0);
});

test("forecast replay rejects held-out and post-cutoff evidence", () => {
  const replay = {
    schema_version: "forecast-replay-v2",
    role_id: "00000000-0000-4000-8000-000000000011",
    target_event_id: "00000000-0000-4000-8000-000000000099",
    target_year: 2024,
    forecast_cutoff: "2024-07-01",
    forecasted_at: "2024-07-02T00:00:00+00:00",
    evidence: [{
      id: "00000000-0000-4000-8000-000000000022",
      kind: "role_history",
      evidence_on: "2023-09-12",
      available_at: "2023-09-12T12:00:00+00:00",
      source_quality: 0.9,
      uncertainty_days: 0,
    }],
    expected_opening_date: "2024-09-10",
    interval_start: "2024-09-01",
    interval_end: "2024-09-20",
    confidence: 71.9,
    actual_opened_on: "2024-09-11",
    actual_interval_start: "2024-09-11",
    actual_interval_end: "2024-09-11",
    target_date_precision: "exact",
    absolute_error_days: 1,
    inside_interval: true,
    model_version: "hierarchical-circular-shrinkage-v2",
    input_fingerprint: "f".repeat(64),
  };
  assert.equal(forecastReplayResultSchema.parse(replay).evidence.length, 1);
  assert.throws(() => forecastReplayResultSchema.parse({ ...replay, evidence: [{ ...replay.evidence[0], id: replay.target_event_id }] }));
  assert.throws(() => forecastReplayResultSchema.parse({ ...replay, evidence: [{ ...replay.evidence[0], available_at: "2024-07-02T00:00:00+00:00" }] }));
});

test("recruiting signals keep claimed and observed timestamps semantically distinct", () => {
  const signal = {
    id: "00000000-0000-4000-8000-000000000401",
    identityKey: "c".repeat(64),
    contentHash: "d".repeat(64),
    companyId: "00000000-0000-4000-8000-000000000001",
    company: "Fixture Robotics",
    canonicalRoleId: null,
    signalType: "company_recruiting_blog_post",
    observedAt: "2026-08-14T08:00:00+00:00",
    claimedEventAt: null,
    sourcePublishedAt: null,
    communityEventType: null,
    claimedDateText: null,
    claimedDatePrecision: null,
    evidenceSemantics: "supporting_only",
    sourceId: "00000000-0000-4000-8000-000000000101",
    sourceUrl: "https://fixture.example/recruiting",
    sourceReliability: 0.85,
    signalStrength: 0.62,
    evidenceSnippet: "University recruiting applications are opening soon.",
    extractionMethod: "structured_endpoint",
    observationId: "00000000-0000-4000-8000-000000000201",
  };
  assert.equal(recruitingSignalSchema.parse(signal).claimedEventAt, null);
  assert.throws(() => recruitingSignalSchema.parse({ ...signal, signalStrength: 1.2 }));
});
