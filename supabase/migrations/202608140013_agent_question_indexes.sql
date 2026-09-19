-- Indexed evidence paths used by portfolio and explanation questions.

create index forecasts_current_portfolio_idx
  on public.forecasts (as_of desc, forecasted_at desc, canonical_role_id);

create index forecast_changes_recent_idx
  on public.forecast_changes (created_at desc);

create index readiness_user_due_open_idx
  on public.readiness_milestones (user_id, due_on, canonical_role_id)
  where completed_at is null;

create index watchlists_role_user_idx
  on public.watchlists (canonical_role_id, user_id);

comment on index public.forecasts_current_portfolio_idx is
  'Supports current indexed upcoming-opening and watchlist work-back queries without network collection.';

comment on index public.forecast_changes_recent_idx is
  'Supports before/after forecast explanation queries over immutable change lineage.';
