-- The health report's reads stop growing with the corpus, the size tripwire cannot time out, and "which sources are
-- failing" becomes a question anything can ask.
--
-- Migration 054 replaced thirty-eight concurrent PostgREST counts with nineteen sequential exact ones, inside one
-- function. That ended the concurrency failure and introduced a slower one: an exact whole-table count is O(all rows),
-- so it had no headroom. Measured 806 ms on the rig in September and estimated 1.7 s on hosted; by 2026-10-03 the
-- function was answering HTTP 500 on every run, and it answered it for thirteen days, because the corpus had roughly
-- tripled (regeneration elapsed 247 s to 759 s, 15.07 MB to 26.45 MB per run, in-scope roles 684 to 822). An exact
-- count of a growing table will always eventually cross PostgREST's eight seconds. Accurate-until-it-dies is worse
-- than a labelled estimate.
--
-- `total` therefore comes from the catalogue. `reltuples` is an estimate and the report says so; where it is -1, the
-- table has never been analysed and this returns null rather than pretending the table is empty. The 24-hour `added`
-- figure stays exact: it is the number the report exists for, it is bounded by a timestamp index on every counted
-- table (migrations 052 and 053), and its cost does not grow with the table.
--
-- The signature and column names do not change. That is deliberate: applying this migration ends the outage on its
-- own, with the currently deployed `collection-health.mjs` unchanged, which matters because the code push that labels
-- the estimate is gated behind unrelated product work. The deployed reader does `Number(row.total)`, so a null total
-- reads as 0 for one release; it only suppresses the "no source fetches" warning, never invents one.
--
-- `database_size_bytes` is separate and takes no arguments, because the number that protects the project from the
-- storage ceiling must not be reachable by anything that can be slow. It is one catalogue read.
--
-- `source_failure_streaks` puts the definition of a consecutive-failure streak in one place. It had lived only inside
-- `collection-health.mjs`, so when that report died on 2026-10-03 nothing could answer "which sources are failing and
-- why" -- `sources show` lists a company's sources but not their streaks, and the alert names a company and an adapter
-- but no id. The semantics are the report's, unchanged: calls newest first, `running` ignored, the streak is the run
-- of `failed` before the first non-failure, and the error type is the newest failure's.

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
  with counted(table_name, added) as (
    select 'companies', count(*) filter (where created_at >= p_since) from public.companies
    union all select 'sources', count(*) filter (where created_at >= p_since) from public.sources
    union all select 'source_fetches', count(*) filter (where fetched_at >= p_since) from public.source_fetches
    union all select 'raw_job_observations', count(*) filter (where created_at >= p_since) from public.raw_job_observations
    union all select 'archive_captures', count(*) filter (where created_at >= p_since) from public.archive_captures
    union all select 'canonical_roles', count(*) filter (where created_at >= p_since) from public.canonical_roles
    union all select 'observation_role_matches', count(*) filter (where created_at >= p_since) from public.observation_role_matches
    union all select 'role_aliases', count(*) filter (where created_at >= p_since) from public.role_aliases
    union all select 'historical_opening_events', count(*) filter (where created_at >= p_since) from public.historical_opening_events
    union all select 'signals', count(*) filter (where created_at >= p_since) from public.signals
    union all select 'forecasts', count(*) filter (where created_at >= p_since) from public.forecasts
    union all select 'forecast_evidence', count(*) filter (where created_at >= p_since) from public.forecast_evidence
    union all select 'forecast_changes', count(*) filter (where created_at >= p_since) from public.forecast_changes
    union all select 'readiness_milestones', count(*) filter (where created_at >= p_since) from public.readiness_milestones
    union all select 'inference_decisions', count(*) filter (where decided_at >= p_since) from public.inference_decisions
    union all select 'model_usage', count(*) filter (where created_at >= p_since) from public.model_usage
    union all select 'agent_runs', count(*) filter (where started_at >= p_since) from public.agent_runs
    union all select 'agent_tool_calls', count(*) filter (where started_at >= p_since) from public.agent_tool_calls
    union all select 'backtest_runs', count(*) filter (where created_at >= p_since) from public.backtest_runs
  )
  select c.table_name,
         c.added,
         -- An estimate, and null rather than zero when the table has never been analysed.
         case when t.reltuples < 0 then null else t.reltuples::bigint end,
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
  'Every table the health report counts, in one request: rows added since p_since (exact, from a timestamp index) '
  'and the table''s catalogue row ESTIMATE, which is null when the table has never been analysed. The total is no '
  'longer an exact count: migration 054 made it one and it crossed PostgREST''s statement timeout as the corpus grew, '
  'taking the whole report down for thirteen days.';

create or replace function public.database_size_bytes()
returns bigint
language sql
stable
set search_path = ''
as $$
  select pg_database_size(current_database());
$$;

comment on function public.database_size_bytes() is
  'The database''s own size, as one catalogue read. Deliberately separate from any row counting: the storage ceiling '
  'is what nearly stopped this project, and the number that watches it must not be reachable by anything slow.';

create or replace function public.source_failure_streaks(
  p_company_id uuid default null,
  p_days integer default 14
)
returns table (
  source_id uuid,
  family text,
  consecutive_failures integer,
  last_error text,
  last_attempt timestamptz
)
language sql
stable
set search_path = ''
as $$
  with calls as (
    select c.input_redacted ->> 'source_id' as source_text,
           case when c.tool_name like 'source_adapter.%' then 'collection' else 'signals' end as family,
           c.status,
           c.error ->> 'type' as error_type,
           c.started_at,
           row_number() over (
             partition by c.input_redacted ->> 'source_id',
                          case when c.tool_name like 'source_adapter.%' then 'collection' else 'signals' end
             order by c.started_at desc, c.id desc
           ) as rn
      from public.agent_tool_calls c
     where c.started_at >= now() - make_interval(days => least(greatest(coalesce(p_days, 14), 1), 90))
       and (c.tool_name like 'source_adapter.%' or c.tool_name like 'recruiting_signal.%')
       and c.status <> 'running'
       and c.input_redacted ? 'source_id'
  ),
  -- The streak ends at the first attempt that did not fail; with none, every attempt in the window failed.
  boundary as (
    select source_text, family, min(rn) as first_success
      from calls where status <> 'failed' group by 1, 2
  )
  select s.id,
         c.family,
         count(*) filter (where c.rn < coalesce(b.first_success, 2147483647))::int,
         max(c.error_type) filter (where c.rn = 1),
         max(c.started_at) filter (where c.rn = 1)
    from calls c
    join public.sources s on s.id::text = c.source_text
    left join boundary b on b.source_text = c.source_text and b.family = c.family
   where p_company_id is null or s.company_id = p_company_id
   group by s.id, c.family
  having count(*) filter (where c.rn < coalesce(b.first_success, 2147483647)) > 0
   order by 3 desc, 1;
$$;

comment on function public.source_failure_streaks(uuid, integer) is
  'Consecutive failed collection or signal attempts per source, newest first, `running` ignored, over a window '
  'clamped to 90 days. One definition, so the health report and `firstseen sources show` cannot drift apart.';

revoke all on function public.counted_table_totals(timestamptz) from public, anon, authenticated;
revoke all on function public.database_size_bytes() from public, anon, authenticated;
revoke all on function public.source_failure_streaks(uuid, integer) from public, anon, authenticated;
grant execute on function public.counted_table_totals(timestamptz) to service_role;
grant execute on function public.database_size_bytes() to service_role;
grant execute on function public.source_failure_streaks(uuid, integer) to service_role;
