-- The health report's table counts in one request, and the per-day growth they imply.
--
-- `collection-health.mjs` counted nineteen tables with `count=exact` twice each -- once filtered to the last 24 hours,
-- once unfiltered -- as thirty-eight PostgREST requests fired together inside one `Promise.all`, alongside five other
-- read chains. That is what failed: the regeneration workflow's last step died with `read of raw_job_observations
-- failed with HTTP 500` on 2026-09-23, -24 and -25, three nights running, and with it went the 4.8 GB database
-- tripwire and every other signal the report carries. Nobody knew for three days, because the check that would have
-- said so was the thing that was down.
--
-- Migration 052 indexed one table's timestamp and 053 indexed the other twelve, which made the *filtered* half of each
-- pair cheap. The unfiltered half is a whole-table count and no index helps it: measured on the rig, the planner picks
-- a sequential scan (42 ms, 2,332 buffers) and an index-only scan is not available because the visibility map is not
-- all-visible, so forcing the index is slower (84 ms). Indexing was never going to finish this, and a night that
-- passed would have been luck.
--
-- So the counts move into one function and one request. Each table is scanned exactly once for both numbers --
-- `count(*) filter (...)` and `count(*)` share the scan -- which is nineteen scans in place of thirty-eight, on one
-- connection, in a fixed order, with no concurrency to lose to. Measured on the rig: 806 ms for the whole set, about
-- 1.7 s at hosted's 2.15x, against PostgREST's eight seconds.
--
-- The totals stay exact rather than becoming `reltuples`. The catalogue estimate is not usable here: on the rig
-- `forecasts` reports 59 against a real 577, and `signals` reports -1 because it has never been analysed. A health
-- report that quietly understates a table by a factor of ten is worse than a slower one, and AGENTS.md requires an
-- estimate to be labelled as one -- which a number this wrong could not honestly be.
--
-- `counted_table_daily_rows` is the same evidence grouped by day, so per-day growth can be derived from what the
-- database already knows instead of waiting a day per data point: rows added per table per day, times that table's
-- current bytes per row, summed. Its range is clamped to 90 days so the scan stays bounded.

create or replace function public.counted_table_totals(p_since timestamptz)
returns table (
  table_name text,
  added bigint,
  total bigint,
  heap_bytes bigint,
  toast_bytes bigint,
  index_bytes bigint,
  total_bytes bigint,
  database_bytes bigint
)
language sql
stable
set search_path = ''
as $$
  with counted(table_name, added, total) as (
    select 'companies', count(*) filter (where created_at >= p_since), count(*) from public.companies
    union all select 'sources', count(*) filter (where created_at >= p_since), count(*) from public.sources
    union all select 'source_fetches', count(*) filter (where fetched_at >= p_since), count(*) from public.source_fetches
    union all select 'raw_job_observations', count(*) filter (where created_at >= p_since), count(*) from public.raw_job_observations
    union all select 'archive_captures', count(*) filter (where created_at >= p_since), count(*) from public.archive_captures
    union all select 'canonical_roles', count(*) filter (where created_at >= p_since), count(*) from public.canonical_roles
    union all select 'observation_role_matches', count(*) filter (where created_at >= p_since), count(*) from public.observation_role_matches
    union all select 'role_aliases', count(*) filter (where created_at >= p_since), count(*) from public.role_aliases
    union all select 'historical_opening_events', count(*) filter (where created_at >= p_since), count(*) from public.historical_opening_events
    union all select 'signals', count(*) filter (where created_at >= p_since), count(*) from public.signals
    union all select 'forecasts', count(*) filter (where created_at >= p_since), count(*) from public.forecasts
    union all select 'forecast_evidence', count(*) filter (where created_at >= p_since), count(*) from public.forecast_evidence
    union all select 'forecast_changes', count(*) filter (where created_at >= p_since), count(*) from public.forecast_changes
    union all select 'readiness_milestones', count(*) filter (where created_at >= p_since), count(*) from public.readiness_milestones
    union all select 'inference_decisions', count(*) filter (where decided_at >= p_since), count(*) from public.inference_decisions
    union all select 'model_usage', count(*) filter (where created_at >= p_since), count(*) from public.model_usage
    union all select 'agent_runs', count(*) filter (where started_at >= p_since), count(*) from public.agent_runs
    union all select 'agent_tool_calls', count(*) filter (where started_at >= p_since), count(*) from public.agent_tool_calls
    union all select 'backtest_runs', count(*) filter (where created_at >= p_since), count(*) from public.backtest_runs
  )
  select c.table_name,
         c.added,
         c.total,
         pg_relation_size(t.oid),
         coalesce(pg_total_relation_size(nullif(t.reltoastrelid, 0)), 0),
         pg_indexes_size(t.oid),
         pg_total_relation_size(t.oid),
         pg_database_size(current_database())
    from counted c
    join pg_class t on t.relname = c.table_name and t.relnamespace = 'public'::regnamespace
   order by pg_total_relation_size(t.oid) desc;
$$;

comment on function public.counted_table_totals(timestamptz) is
  'Every table the health report counts, in one request: rows added since p_since and the exact total, each table '
  'scanned once for both, plus its catalogue sizes and the database size. Replaces thirty-eight concurrent PostgREST '
  'counts that crossed the statement timeout under load.';

create or replace function public.counted_table_daily_rows(p_days integer default 14)
returns table (table_name text, day date, rows bigint)
language sql
stable
set search_path = ''
as $$
  with bounds as (select current_date - least(greatest(coalesce(p_days, 14), 1), 90) as from_day)
  select 'companies', created_at::date, count(*) from public.companies, bounds where created_at >= bounds.from_day group by 2
  union all select 'sources', created_at::date, count(*) from public.sources, bounds where created_at >= bounds.from_day group by 2
  union all select 'source_fetches', fetched_at::date, count(*) from public.source_fetches, bounds where fetched_at >= bounds.from_day group by 2
  union all select 'raw_job_observations', created_at::date, count(*) from public.raw_job_observations, bounds where created_at >= bounds.from_day group by 2
  union all select 'archive_captures', created_at::date, count(*) from public.archive_captures, bounds where created_at >= bounds.from_day group by 2
  union all select 'canonical_roles', created_at::date, count(*) from public.canonical_roles, bounds where created_at >= bounds.from_day group by 2
  union all select 'observation_role_matches', created_at::date, count(*) from public.observation_role_matches, bounds where created_at >= bounds.from_day group by 2
  union all select 'role_aliases', created_at::date, count(*) from public.role_aliases, bounds where created_at >= bounds.from_day group by 2
  union all select 'historical_opening_events', created_at::date, count(*) from public.historical_opening_events, bounds where created_at >= bounds.from_day group by 2
  union all select 'signals', created_at::date, count(*) from public.signals, bounds where created_at >= bounds.from_day group by 2
  union all select 'forecasts', created_at::date, count(*) from public.forecasts, bounds where created_at >= bounds.from_day group by 2
  union all select 'forecast_evidence', created_at::date, count(*) from public.forecast_evidence, bounds where created_at >= bounds.from_day group by 2
  union all select 'forecast_changes', created_at::date, count(*) from public.forecast_changes, bounds where created_at >= bounds.from_day group by 2
  union all select 'readiness_milestones', created_at::date, count(*) from public.readiness_milestones, bounds where created_at >= bounds.from_day group by 2
  union all select 'inference_decisions', decided_at::date, count(*) from public.inference_decisions, bounds where decided_at >= bounds.from_day group by 2
  union all select 'model_usage', created_at::date, count(*) from public.model_usage, bounds where created_at >= bounds.from_day group by 2
  union all select 'agent_runs', started_at::date, count(*) from public.agent_runs, bounds where started_at >= bounds.from_day group by 2
  union all select 'agent_tool_calls', started_at::date, count(*) from public.agent_tool_calls, bounds where started_at >= bounds.from_day group by 2
  union all select 'backtest_runs', created_at::date, count(*) from public.backtest_runs, bounds where created_at >= bounds.from_day group by 2;
$$;

comment on function public.counted_table_daily_rows(integer) is
  'Rows added per counted table per day over a bounded recent window, so per-day database growth can be derived from '
  'history instead of sampling the size once a day. Clamped to 90 days.';

revoke all on function public.counted_table_totals(timestamptz) from public, anon, authenticated;
revoke all on function public.counted_table_daily_rows(integer) from public, anon, authenticated;
grant execute on function public.counted_table_totals(timestamptz) to service_role;
grant execute on function public.counted_table_daily_rows(integer) to service_role;
