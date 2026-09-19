/**
 * Guest mode's read boundary: the only relations, columns, and functions a signed-out render may read.
 *
 * Guests reach the database only through the Worker, which reads with the service role through `lib/public-read.ts`,
 * and that reader refuses anything this file does not list. RLS and grants are untouched: anon holds no privilege on
 * any table (migration 202608140024), and nothing here changes that.
 *
 * Every relation below is non-user data: companies, roles and their recorded titles, observations and opening events, forecasts with their
 * provenance and changes, signals, and backtest run totals and metrics. No column that holds raw scraped content (`raw_text`,
 * `raw_payload`, `metadata`) is listed. Pure, so the tests read it directly.
 */

export const PUBLIC_TABLE_COLUMNS = {
  companies: ["id", "name", "domain", "careers_url"],
  canonical_roles: [
    "id", "company_id", "canonical_title", "track", "level", "location_scope", "role_family", "recruiting_season",
    "scope_status", "discipline", "early_career_type", "forecast_refused_at", "forecast_refusal_reason",
  ],
  historical_opening_events: [
    "id", "canonical_role_id", "opened_on", "closed_on", "opening_window_start", "opening_window_end", "date_precision",
    "uncertainty_days", "uncertainty_reason", "evidence_quote",
  ],
  raw_job_observations: [
    "id", "raw_title", "apply_url", "source_url", "published_at", "last_seen_at", "source_type", "observed_at",
    "archive_capture_at", "location",
  ],
  observation_role_matches: ["observation_id", "canonical_role_id", "evidence_kind"],
  // A role's titles as companies published them, read only to show a title with its accents and punctuation.
  role_aliases: ["id", "canonical_role_id", "alias_title", "last_seen_at"],
  forecasts: [
    "id", "canonical_role_id", "as_of", "point_date", "window_start", "window_end", "confidence", "confidence_factors",
    "method", "model_version", "history_count", "input_fingerprint", "forecasted_at", "calibrated_probability",
    "prior_effective_sample_size",
  ],
  forecast_provenance: [
    "forecast_id", "observation_id", "source_url", "observed_at", "content_hash", "extraction_method", "contribution",
    "weight", "rationale", "date_precision", "signal_kind", "evidence_id",
  ],
  forecast_changes: [
    "id", "before_forecast_id", "after_forecast_id", "confidence_delta", "point_date_delta_days", "material", "reasons",
    "created_at",
  ],
  signals: [
    "id", "canonical_role_id", "kind", "observed_at", "strength", "reliability", "evidence_quote", "source_url",
    "extraction_method",
  ],
  backtest_runs: [
    "id", "status", "started_at", "finished_at", "target_count", "completed_cases", "skipped_cases", "aggregate_metrics",
  ],
} as const satisfies Record<string, readonly string[]>;

export type PublicTable = keyof typeof PUBLIC_TABLE_COLUMNS;

/**
 * Functions a guest render may call. Each reads only non-user data when its user argument is null, and the reader
 * refuses any user argument that is not null. `public_agent_activity` returns only a run no user started.
 */
export const PUBLIC_FUNCTIONS = [
  "dashboard_role_page",
  "dashboard_role_summary",
  "dashboard_filter_options",
  "replay_candidate_page",
  "replay_candidate_summary",
  "replay_candidate_companies",
  "replay_backtest_reasons",
  "public_agent_activity",
  "forecast_history_depth",
  "forecast_basis",
  "forecast_basis_for_forecasts",
] as const;

export type PublicFunction = (typeof PUBLIC_FUNCTIONS)[number];

/** What a guest must never reach. The tests assert none of these is readable through the reader or in a guest render. */
export const NEVER_PUBLIC_RELATIONS = [
  "profiles",
  "watchlists",
  "watchlist_items",
  "recruiting_preferences",
  "priority_companies",
  "readiness_milestones",
  "calendar_event_syncs",
  "email_digest_deliveries",
  "email_digest_items",
  "gmail_connections",
  "google_calendar_connections",
  "agent_runs",
  "agent_tool_calls",
  "model_usage",
  "inference_decisions",
  "collection_checkpoints",
  "account_deletions",
] as const;

export class PublicReadRefused extends Error {
  constructor(message: string) {
    super(`public read refused: ${message}`);
    this.name = "PublicReadRefused";
  }
}

/** Splits a PostgREST select on the commas that are not inside an embedded resource's parentheses. */
function topLevelParts(select: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const character of select) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (depth < 0) throw new PublicReadRefused(`unbalanced select "${select}"`);
    if (character === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else {
      current += character;
    }
  }
  if (depth !== 0) throw new PublicReadRefused(`unbalanced select "${select}"`);
  parts.push(current.trim());
  return parts;
}

const EMBEDDED = /^(?:[a-z_][a-z0-9_]*:)?([a-z_][a-z0-9_]*)(?:!(?:inner|left|[a-z_][a-z0-9_]*))?\(([\s\S]*)\)$/;
const COLUMN = /^(?:[a-z_][a-z0-9_]*:)?([a-z_][a-z0-9_]*)$/;

/** Throws unless every column, at every level of embedding, is listed for its relation. `*` is never allowed. */
export function assertPublicSelect(table: string, select: string): void {
  const allowed: readonly string[] | undefined = (PUBLIC_TABLE_COLUMNS as Record<string, readonly string[]>)[table];
  if (!allowed) throw new PublicReadRefused(`"${table}" is not a public relation`);
  const parts = topLevelParts(select);
  if (parts.some((part) => part === "")) throw new PublicReadRefused(`empty column in "${select}" on ${table}`);
  for (const part of parts) {
    const embedded = part.match(EMBEDDED);
    if (embedded) {
      assertPublicSelect(embedded[1], embedded[2]);
      continue;
    }
    const column = part.match(COLUMN)?.[1];
    if (!column || !allowed.includes(column)) throw new PublicReadRefused(`"${part}" is not a public column of ${table}`);
  }
}

/** Throws unless the function is listed and every argument naming a user is null or absent. */
export function assertPublicRpc(fn: string, args: Record<string, unknown> | undefined): void {
  if (!(PUBLIC_FUNCTIONS as readonly string[]).includes(fn)) throw new PublicReadRefused(`"${fn}" is not a public function`);
  for (const [name, value] of Object.entries(args ?? {})) {
    if (/user/i.test(name) && value !== null && value !== undefined) {
      throw new PublicReadRefused(`${fn} was given a user argument (${name})`);
    }
  }
}
