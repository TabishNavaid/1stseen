alter table public.backtest_cases
  add column actual_interval_start date,
  add column actual_interval_end date,
  add column target_date_precision text;

update public.backtest_cases
set actual_interval_start = actual_opened_on,
    actual_interval_end = actual_opened_on,
    target_date_precision = 'exact'
where actual_interval_start is null;

alter table public.backtest_cases
  alter column actual_interval_start set not null,
  alter column actual_interval_end set not null,
  alter column target_date_precision set not null,
  add constraint backtest_cases_actual_interval_order
    check (actual_interval_start <= actual_opened_on and actual_opened_on <= actual_interval_end),
  add constraint backtest_cases_target_precision
    check (target_date_precision in ('exact', 'bounded'));

comment on column public.backtest_cases.actual_interval_start is
  'Earliest defensible held-out opening date used for interval-censored scoring.';
comment on column public.backtest_cases.actual_interval_end is
  'Latest defensible held-out opening date used for interval-censored scoring.';
comment on column public.backtest_cases.target_date_precision is
  'Precision of the held-out outcome. Observed-by targets are not quantitatively scored.';
