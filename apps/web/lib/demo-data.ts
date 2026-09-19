import { forecastRolesSchema } from "@firstseen/shared";
import { forecastBasis, type ForecastBasis } from "@/lib/forecast-basis";
import { noForecastExplanation } from "@/lib/forecast-gap";
import type { RoleView } from "@/lib/role-view";
export type { ForecastRole } from "@firstseen/shared";

// Product fixtures exercise the full UI without presenting synthetic dates as live intelligence.
export const forecastRoles = forecastRolesSchema.parse([
  {
    id: "northstar-swe-intern",
    company: "Northstar",
    companyMark: "N",
    role: "Software Engineering Intern",
    track: "Internship",
    location: "United States · Hybrid",
    window: "Sep 4 – Sep 22",
    daysUntil: 21,
    confidence: 71,
    readiness: 68,
    status: "warming",
    historicalCycles: ["Sep 12", "Sep 8", "Sep 19", "Sep 11"],
    signalSummary: "Campus page changed 3 days ago; recruiter activity is above baseline.",
    nextDeadline: "Resume lock · Aug 23",
    deadlines: [
      { label: "Build target list", date: "Aug 16", done: true },
      { label: "Resume lock", date: "Aug 23" },
      { label: "Warm introductions", date: "Aug 30" },
      { label: "Referral asks", date: "Sep 4" },
    ],
    confidenceFactors: [
      { label: "4 observed cycles", value: "+ strong", tone: "positive" },
      { label: "Median drift", value: "4.1 days", tone: "positive" },
      { label: "Signal freshness", value: "3 days", tone: "positive" },
      { label: "Window width", value: "18 days", tone: "neutral" },
    ],
    evidence: [
      { label: "Archived job posting", detail: "Role family and location matched", date: "Sep 11, 2025", kind: "archive" },
      { label: "Campus page change", detail: "Student programs copy updated", date: "Aug 11, 2026", kind: "signal" },
      { label: "Recruiter activity", detail: "2 relevant public posts detected", date: "Aug 10, 2026", kind: "signal" },
    ],
  },
  {
    id: "meridian-apm",
    company: "Meridian",
    companyMark: "M",
    role: "Associate Product Manager",
    track: "New grad",
    location: "New York · On-site",
    window: "Oct 2 – Oct 24",
    daysUntil: 49,
    confidence: 71,
    readiness: 45,
    status: "quiet",
    historicalCycles: ["Oct 8", "Oct 17", "Sep 29"],
    signalSummary: "No current trigger; historical seasonality remains consistent.",
    nextDeadline: "Portfolio proof · Sep 4",
    deadlines: [
      { label: "Positioning draft", date: "Aug 24" },
      { label: "Portfolio proof", date: "Sep 4" },
      { label: "Alumni outreach", date: "Sep 12" },
      { label: "Referral asks", date: "Sep 24" },
    ],
    confidenceFactors: [
      { label: "3 observed cycles", value: "+ useful", tone: "positive" },
      { label: "Median drift", value: "8.6 days", tone: "neutral" },
      { label: "Signal freshness", value: "none", tone: "warning" },
      { label: "Window width", value: "22 days", tone: "neutral" },
    ],
    evidence: [
      { label: "Archived job posting", detail: "Opening and closing dates captured", date: "Oct 17, 2025", kind: "archive" },
      { label: "Program handbook", detail: "Annual cohort language confirmed", date: "Mar 2, 2026", kind: "posting" },
    ],
  },
  {
    id: "atlas-data-science",
    company: "Atlas",
    companyMark: "A",
    role: "Data Science Intern",
    track: "Internship",
    location: "Remote · US",
    window: "Aug 28 – Sep 10",
    daysUntil: 14,
    confidence: 76,
    readiness: 84,
    status: "signal",
    historicalCycles: ["Aug 31", "Sep 4", "Aug 27"],
    signalSummary: "ATS taxonomy appeared this week; opening may be approaching.",
    nextDeadline: "Referral asks · Aug 20",
    deadlines: [
      { label: "Resume lock", date: "Aug 15", done: true },
      { label: "Project write-up", date: "Aug 18" },
      { label: "Referral asks", date: "Aug 20" },
      { label: "Application ready", date: "Aug 26" },
    ],
    confidenceFactors: [
      { label: "3 observed cycles", value: "+ useful", tone: "positive" },
      { label: "Median drift", value: "3.3 days", tone: "positive" },
      { label: "ATS taxonomy", value: "new", tone: "positive" },
      { label: "Window width", value: "13 days", tone: "positive" },
    ],
    evidence: [
      { label: "ATS taxonomy", detail: "Role category added without a posting", date: "Aug 12, 2026", kind: "signal" },
      { label: "Archived job posting", detail: "Role title normalized to this family", date: "Aug 27, 2025", kind: "archive" },
    ],
  },
]);

export type ForecastChangeRecord = {
  roleId: string;
  previousWindow: string;
  currentWindow: string;
  confidenceDelta: number;
  changedAt: string;
  reason: string;
};

export const forecastChanges: ForecastChangeRecord[] = [
  {
    roleId: "atlas-data-science",
    previousWindow: "Sep 3 – Sep 16",
    currentWindow: "Aug 28 – Sep 10",
    confidenceDelta: 5,
    changedAt: "2 days ago",
    reason: "A new data-science role family appeared in the company ATS taxonomy.",
  },
  {
    roleId: "northstar-swe-intern",
    previousWindow: "Sep 7 – Sep 25",
    currentWindow: "Sep 4 – Sep 22",
    confidenceDelta: 2,
    changedAt: "3 days ago",
    reason: "The official campus page changed and remains consistent with four prior cycles.",
  },
];

export type OpenedRole = {
  id: string;
  company: string;
  role: string;
  location: string;
  openedAt: string;
  observedAt: string;
  source: "Official ATS" | "Company careers";
  applyUrl: string;
};

export const openedRoles: OpenedRole[] = [
  {
    id: "pioneer-product-intern",
    company: "Pioneer",
    role: "Product Management Intern",
    location: "San Francisco · Hybrid",
    openedAt: "Aug 13",
    observedAt: "First seen 19 hours ago",
    source: "Official ATS",
    applyUrl: "https://jobs.pioneer.example/product-intern",
  },
  {
    id: "lumen-analyst-new-grad",
    company: "Lumen",
    role: "Strategy Analyst, New Grad",
    location: "New York · On-site",
    openedAt: "Aug 12",
    observedAt: "First seen 2 days ago",
    source: "Company careers",
    applyUrl: "https://careers.lumen.example/analyst-new-grad",
  },
];

export const agentEvents = [
  { tool: "discover_company", label: "Identified recruiting system", detail: "Northstar · official ATS identity", time: "12 min ago", durationMs: 22, evidenceAdded: 0, sourceIds: [] },
  { tool: "resolve_role", label: "Resolved role aliases", detail: "1 canonical recurring program", time: "12 min ago", durationMs: 18, evidenceAdded: 0, sourceIds: [] },
  { tool: "get_current_jobs", label: "Checked current postings", detail: "0 matching live postings", time: "12 min ago", durationMs: 31, evidenceAdded: 0, sourceIds: [] },
  { tool: "get_role_history", label: "Retrieved historical cycles", detail: "4 source-backed cycles", time: "12 min ago", durationMs: 46, evidenceAdded: 4, sourceIds: ["northstar-ats", "northstar-archive"] },
  { tool: "inspect_archives", label: "Inspected archived evidence", detail: "2 relevant captures", time: "12 min ago", durationMs: 39, evidenceAdded: 2, sourceIds: ["northstar-archive"] },
  { tool: "get_recruiting_signals", label: "Collected recruiting signals", detail: "2 supporting signals", time: "11 min ago", durationMs: 28, evidenceAdded: 2, sourceIds: ["northstar-campus", "northstar-community"] },
  { tool: "generate_forecast", label: "Generated statistical forecast", detail: "Sep 4–22 · confidence score 71 of 100", time: "11 min ago", durationMs: 14, evidenceAdded: 0, sourceIds: [], modelProvider: null },
  { tool: "create_readiness_plan", label: "Calculated readiness timeline", detail: "5 explainable milestones", time: "11 min ago", durationMs: 9, evidenceAdded: 0, sourceIds: [] },
];


// Development fixture detail records, shaped exactly like the real reader output so
// the role page has one code path. Reserved `.example` sources only.
export const fixtureRoleViews: Record<string, RoleView> = {
  "northstar-swe-intern": {
    origin: "fixture",
    id: "northstar-swe-intern",
    company: "Northstar",
    companyMark: "N",
    companyId: null,
    companyDomain: "northstar.example",
    careersUrl: "https://careers.northstar.example/students",
    role: "Software Engineering Intern",
    track: "internship",
    level: "internship",
    roleFamily: "software_engineering",
    recruitingSeason: "fall",
    locationScope: "United States · Hybrid",
    forecast: {
      forecastId: "fixture-forecast-northstar",
      asOf: "2026-08-14",
      expectedOpening: "2026-09-12",
      windowStart: "2026-09-04",
      windowEnd: "2026-09-22",
      daysUntilWindow: 21,
      confidence: 71,
      method: "hierarchical_circular_shrinkage",
      modelVersion: "hierarchical-circular-shrinkage-v2",
      historyCount: 4,
      inputFingerprint: "f01de529a38345d05364a7518f04e193c78839db25b2bb3003cfed957009a6e5",
      forecastedAt: "2026-08-14T09:18:00Z",
      calibratedProbability: 0.71,
      priorEffectiveSampleSize: 2.5,
      confidenceFactors: [
        { label: "history depth", value: "0.80", tone: "positive" },
        { label: "date precision", value: "0.45", tone: "neutral" },
        { label: "signal freshness", value: "0.72", tone: "positive" },
        { label: "interval width", value: "0.55", tone: "neutral" },
      ],
      // Development fixture weights: 74% the program's own openings, as its provenance groups below.
      basis: forecastBasis(0.74, 0.26),
    },
    insufficientEvidence: null,
    forecastRefusal: null,
    forecastVersions: [
      { forecastId: "fixture-forecast-northstar", asOf: "2026-08-14", expectedOpening: "2026-09-12", windowStart: "2026-09-04", windowEnd: "2026-09-22", confidence: 71, modelVersion: "hierarchical-circular-shrinkage-v2", basis: forecastBasis(0.74, 0.26), change: { confidenceDelta: 2, pointDateDeltaDays: -2, material: true, reasons: ["The official campus page changed and remains consistent with four prior cycles."], changedAt: "2026-08-14T09:18:00Z" } },
      { forecastId: "fixture-forecast-northstar-prev", asOf: "2026-08-11", expectedOpening: "2026-09-14", windowStart: "2026-09-07", windowEnd: "2026-09-25", confidence: 69, modelVersion: "hierarchical-circular-shrinkage-v2", basis: forecastBasis(0.61, 0.39), change: null },
    ],
    cycles: [
      { id: "fixture-cycle-2025", openedOn: "2025-09-11", closedOn: null, windowStart: "2025-09-11", windowEnd: "2025-09-11", precision: "exact", uncertaintyDays: 0, uncertaintyReason: "The structured job record supplied this publication date.", sourceUrl: "https://jobs.northstar.example/swe-intern", sourceKind: "official", observedAt: "2025-09-11T08:00:00Z", evidenceQuote: "first_published: 2025-09-11" },
      { id: "fixture-cycle-2024", openedOn: "2024-09-08", closedOn: null, windowStart: null, windowEnd: "2024-09-08", precision: "observed_by", uncertaintyDays: null, uncertaintyReason: "1stSeen first detected the matching posting on this date; it may have opened earlier.", sourceUrl: "https://jobs.northstar.example/swe-intern", sourceKind: "official", observedAt: "2024-09-08T08:00:00Z", evidenceQuote: "Software Engineering Intern" },
      { id: "fixture-cycle-2023", openedOn: "2023-09-12", closedOn: null, windowStart: null, windowEnd: "2023-09-12", precision: "observed_by", uncertaintyDays: null, uncertaintyReason: "An archive capture proves the content existed by this time; capture time is not a publication date.", sourceUrl: "https://careers.northstar.example/students", sourceKind: "archive", observedAt: "2023-09-12T04:00:00Z", evidenceQuote: "Software Engineering Intern — applications open" },
      { id: "fixture-cycle-2022", openedOn: "2022-09-22", closedOn: null, windowStart: "2022-09-15", windowEnd: "2022-09-22", precision: "bounded", uncertaintyDays: 7, uncertaintyReason: "A complete capture without the role was followed by a matching capture.", sourceUrl: "https://careers.northstar.example/students", sourceKind: "archive", observedAt: "2022-09-22T04:00:00Z", evidenceQuote: "Software Engineering Intern — applications open" },
    ],
    precisionCounts: { exact: 1, bounded: 1, observed_by: 2 },
    provenance: [
      { observationId: "fixture-obs-1", sourceUrl: "https://jobs.northstar.example/swe-intern", observedAt: "2025-09-11T08:00:00Z", contentHash: "a".repeat(64), extractionMethod: "api", contribution: "role_history", weight: 0.56, rationale: "Exact source-supplied publication date for the 2025 cycle.", precision: "exact", signalKind: null },
      { observationId: "fixture-obs-4", sourceUrl: "https://jobs.lumen.example/engineering-intern", observedAt: "2025-09-02T08:00:00Z", contentHash: "d".repeat(64), extractionMethod: "api", contribution: "role_family_prior", weight: 0.26, rationale: "A similar internship program's timing, borrowed while this program's own history is short.", precision: "exact", signalKind: null },
      { observationId: "fixture-obs-2", sourceUrl: "https://careers.northstar.example/students", observedAt: "2023-09-12T04:00:00Z", contentHash: "b".repeat(64), extractionMethod: "archive", contribution: "role_history", weight: 0.18, rationale: "Archive capture proves presence only, so it carries less date weight.", precision: "observed_by", signalKind: null },
      { observationId: "fixture-obs-3", sourceUrl: "https://careers.northstar.example/students", observedAt: "2026-08-11T06:42:00Z", contentHash: "c".repeat(64), extractionMethod: "http", contribution: "signal", weight: 0, rationale: "Recent official campus page change raises confidence only.", precision: null, signalKind: "internship_program_page_changed" },
    ],
    // Development fixture weights, as forecast_evidence holds them: 74% the program's own openings, 26% borrowed.
    provenanceGroups: [
      { contribution: "role_history", rationale: "An exact publication date for the 2025 cycle, and an archive capture that proves presence only.", rows: 2, weight: 0.74, uniformRationale: false },
      { contribution: "role_family_prior", rationale: "A similar internship program's timing, borrowed while this program's own history is short.", rows: 1, weight: 0.26, uniformRationale: true },
      { contribution: "signal", rationale: "Recent official campus page change raises confidence only.", rows: 1, weight: 0, uniformRationale: true },
    ],
    provenanceTotal: 4,
    provenancePage: 1,
    signals: [
      { id: "fixture-signal-1", kind: "internship_program_page_changed", observedAt: "2026-08-11T06:42:00Z", strength: 0.5, reliability: 0.9, evidenceQuote: "Student opportunities content and application preparation language changed.", sourceUrl: "https://careers.northstar.example/students", extractionMethod: "static_html" },
      { id: "fixture-signal-2", kind: "community_recruiting_discussion", observedAt: "2026-08-10T18:05:00Z", strength: 0.3, reliability: 0.42, evidenceQuote: "Two public posts referenced fall university recruiting preparation.", sourceUrl: "https://community.northstar.example/thread", extractionMethod: "llm" },
    ],
    currentPostings: [],
    milestones: [],
    isFollowed: null,
    watchlistItemId: null,
    observationCount: 9,
  },
  "meridian-apm": {
    origin: "fixture",
    id: "meridian-apm",
    company: "Meridian",
    companyMark: "M",
    companyId: null,
    companyDomain: "meridian.example",
    careersUrl: "https://careers.meridian.example/apm",
    role: "Associate Product Manager",
    track: "new_grad",
    level: "new_grad",
    roleFamily: "product",
    recruitingSeason: "fall",
    locationScope: "New York · On-site",
    forecast: null,
    insufficientEvidence: noForecastExplanation(1, 0),
    forecastRefusal: null,
    forecastVersions: [],
    cycles: [
      { id: "fixture-meridian-2025", openedOn: "2025-10-17", closedOn: null, windowStart: null, windowEnd: "2025-10-17", precision: "observed_by", uncertaintyDays: null, uncertaintyReason: "An archive capture proves the content existed by this time.", sourceUrl: "https://careers.meridian.example/apm", sourceKind: "archive", observedAt: "2025-10-17T04:00:00Z", evidenceQuote: "Associate Product Manager, University Grad" },
    ],
    precisionCounts: { exact: 0, bounded: 0, observed_by: 1 },
    provenance: [],
    provenanceGroups: [],
    provenanceTotal: 0,
    provenancePage: 1,
    signals: [],
    currentPostings: [],
    milestones: [],
    isFollowed: null,
    watchlistItemId: null,
    observationCount: 2,
  },
};

/**
 * Development fixture: the share of each fixture forecast's weight from its own openings and from comparable programs,
 * as forecast_evidence would hold it, so the fixture gate renders both forecast bases (`lib/forecast-basis`).
 */
const fixtureWeights: Record<string, [own: number, borrowed: number]> = {
  "northstar-swe-intern": [0.74, 0.26],
  "meridian-apm": [0.31, 0.69],
  "atlas-data-science": [0.42, 0.58],
};

export function fixtureBasis(roleId: string): ForecastBasis | null {
  const weights = fixtureWeights[roleId];
  return weights ? forecastBasis(weights[0], weights[1]) : null;
}
