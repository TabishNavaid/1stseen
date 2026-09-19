-- Sparse-data hierarchical opening-window forecasts with explicit model output metadata.

alter table public.forecasts
  drop constraint if exists forecasts_history_count_check;

alter table public.forecasts
  add constraint forecasts_history_count_check check (history_count >= 0),
  add column calibrated_probability numeric(5,4),
  add column feature_contributions jsonb not null default '[]'::jsonb,
  add column prior_effective_sample_size numeric(8,2) not null default 0
    check (prior_effective_sample_size >= 0),
  add column prediction_interval_coverage numeric(4,3) not null default 0.800
    check (prediction_interval_coverage > 0 and prediction_interval_coverage < 1),
  add column forecasted_at timestamptz;

update public.forecasts
set
  calibrated_probability = confidence / 100.0,
  forecasted_at = created_at
where calibrated_probability is null or forecasted_at is null;

alter table public.forecasts
  alter column calibrated_probability set not null,
  alter column forecasted_at set not null,
  alter column forecasted_at set default now(),
  add constraint forecasts_calibrated_probability_check
    check (calibrated_probability between 0 and 1),
  add constraint forecasts_feature_contributions_array_check
    check (jsonb_typeof(feature_contributions) = 'array');

alter table public.forecast_evidence
  drop constraint if exists forecast_evidence_contribution_check;

alter table public.forecast_evidence
  add constraint forecast_evidence_contribution_check check (
    contribution in (
      'role_history',
      'company_prior',
      'role_family_prior',
      'signal',
      'quality',
      'recency',
      'company_scale'
    )
  );

comment on column public.forecasts.history_count is
  'Number of role-specific historical cycles; may be zero when sourced hierarchical priors are used.';
comment on column public.forecasts.calibrated_probability is
  'Conservatively calibrated probability associated with the forecast window and recurrence evidence.';
comment on column public.forecasts.feature_contributions is
  'Date weights and confidence-only effects for role history, priors, signals, and recruiting scale.';
