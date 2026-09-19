alter table public.historical_opening_events
  add column available_at timestamptz not null default now();
alter table public.signals
  add column available_at timestamptz not null default now();

comment on column public.historical_opening_events.available_at is
  'First instant this resolved fact was available to 1stSeen; distinct from the historical opening date.';
comment on column public.signals.available_at is
  'First instant this normalized signal was available to 1stSeen; used for leakage-safe evaluation.';

create table public.backtest_runs (
  id uuid primary key default gen_random_uuid(),
  output_schema_version text not null,
  model_version text not null,
  model_versions text[] not null check (cardinality(model_versions) > 0),
  status public.run_status not null,
  dataset_fingerprint text not null check (dataset_fingerprint ~ '^[a-f0-9]{64}$'),
  cutoff_days integer not null check (cutoff_days > 0),
  from_year integer check (from_year between 1900 and 2200),
  to_year integer check (to_year between 1900 and 2200),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  target_count integer not null check (target_count >= 0),
  completed_cases integer not null check (completed_cases >= 0),
  skipped_cases integer not null check (skipped_cases >= 0),
  aggregate_metrics jsonb not null,
  calibration_metrics jsonb not null,
  created_at timestamptz not null default now(),
  check (finished_at >= started_at),
  check (from_year is null or to_year is null or from_year <= to_year),
  check (completed_cases + skipped_cases = target_count),
  check (jsonb_typeof(aggregate_metrics) = 'object'),
  check (jsonb_typeof(calibration_metrics) = 'object')
);

create table public.backtest_cases (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.backtest_runs(id) on delete cascade,
  canonical_role_id uuid not null references public.canonical_roles(id) on delete restrict,
  target_event_id uuid not null references public.historical_opening_events(id) on delete restrict,
  target_year integer not null check (target_year between 1900 and 2200),
  forecast_cutoff date not null,
  actual_opened_on date not null,
  expected_opening_date date not null,
  interval_start date not null,
  interval_end date not null,
  confidence numeric(5,2) not null check (confidence between 0 and 100),
  absolute_error_days integer not null check (absolute_error_days >= 0),
  inside_interval boolean not null,
  interval_width_days integer not null check (interval_width_days >= 0),
  history_observations integer not null check (history_observations >= 0),
  target_source_quality numeric(4,3) not null check (target_source_quality between 0 and 1),
  source_quality_bucket text not null check (source_quality_bucket in ('low', 'medium', 'high')),
  company_prior_observations integer not null check (company_prior_observations >= 0),
  role_family_prior_observations integer not null check (role_family_prior_observations >= 0),
  model_version text not null,
  input_fingerprint text not null check (input_fingerprint ~ '^[a-f0-9]{64}$'),
  input_event_ids uuid[] not null,
  input_signal_ids uuid[] not null,
  latest_input_available_at timestamptz not null,
  latest_input_available_on date not null,
  created_at timestamptz not null default now(),
  check (forecast_cutoff < actual_opened_on),
  check (interval_start <= expected_opening_date and expected_opening_date <= interval_end),
  check (latest_input_available_on <= forecast_cutoff),
  check (not target_event_id = any(input_event_ids)),
  unique (run_id, target_event_id)
);

create index backtest_runs_model_created_idx
  on public.backtest_runs (model_version, created_at desc);
create index backtest_cases_run_idx on public.backtest_cases (run_id);
create index backtest_cases_role_year_idx
  on public.backtest_cases (canonical_role_id, target_year);

alter table public.backtest_runs enable row level security;
alter table public.backtest_cases enable row level security;

comment on table public.backtest_runs is
  'Immutable rolling-origin evaluations. No rows are seeded; every metric is computed from stored evidence.';
comment on column public.backtest_cases.latest_input_available_at is
  'Leakage audit boundary: the latest instant at which any forecast input became available.';
comment on column public.backtest_cases.target_source_quality is
  'Quality of the held-out actual event, used for source-quality performance slices.';
