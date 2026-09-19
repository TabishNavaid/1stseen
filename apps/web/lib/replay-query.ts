/**
 * Forecast Replay filters live in the URL, as the dashboard's do (lib/dashboard-query.ts):
 * a filtered or paged candidate list is a server render of exactly the rows it shows,
 * filtered and paged in Postgres by `replay_candidate_page` and `replay_candidate_summary`.
 */

export const REPLAY_PAGE_SIZE = 20;

/** `observed_by` is never a candidate, so it is not a filter value: it is reported as an excluded count. */
export type ReplayPrecisionFilter = "all" | "exact" | "bounded";

/**
 * How the latest persisted `firstseen backtest` run treated a candidate's held-out event:
 * scored, skipped (with BacktestRunner's reason), a different posting of the same role and
 * year was held out instead, or the role and year were not in that run.
 */
export type ReplayOutcome = "scored" | "skipped" | "other_event" | "not_in_run";
export type ReplayOutcomeFilter = "all" | ReplayOutcome;

export type ReplayFilters = {
  company: string;
  query: string;
  precision: ReplayPrecisionFilter;
  outcome: ReplayOutcomeFilter;
  page: number;
};

export const defaultReplayFilters: ReplayFilters = { company: "", query: "", precision: "all", outcome: "all", page: 1 };

export const REPLAY_OUTCOMES: readonly ReplayOutcome[] = ["scored", "skipped", "other_event", "not_in_run"];

export const replayOutcomeLabel: Record<ReplayOutcome, string> = {
  scored: "Scored in the latest backtest",
  skipped: "Skipped in the latest backtest",
  other_event: "Latest backtest held out another posting of this role that year",
  not_in_run: "Not in the latest backtest run",
};

type SearchParams = Record<string, string | string[] | undefined>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export function parseReplayFilters(params: SearchParams): ReplayFilters {
  const precision = first(params.precision);
  const outcome = first(params.outcome);
  const page = Number.parseInt(first(params.page) ?? "1", 10);
  return {
    company: (first(params.company) ?? "").slice(0, 200),
    query: (first(params.q) ?? "").slice(0, 200),
    precision: precision === "exact" || precision === "bounded" ? precision : "all",
    outcome: REPLAY_OUTCOMES.includes(outcome as ReplayOutcome) ? (outcome as ReplayOutcome) : "all",
    page: Number.isFinite(page) ? Math.min(10_000, Math.max(1, page)) : 1,
  };
}

export function replayHref(filters: ReplayFilters, changes: Partial<ReplayFilters> = {}): string {
  const next = { ...filters, ...changes };
  const params = new URLSearchParams();
  if (next.company) params.set("company", next.company);
  if (next.query.trim()) params.set("q", next.query.trim());
  if (next.precision !== "all") params.set("precision", next.precision);
  if (next.outcome !== "all") params.set("outcome", next.outcome);
  if (next.page > 1) params.set("page", String(next.page));
  const query = params.toString();
  return query ? `/replay?${query}` : "/replay";
}
