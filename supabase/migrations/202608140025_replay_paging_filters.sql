-- Forecast Replay: paging, filtering, and the backtest's own skip reasons.
--
-- Replaces the two unfiltered replay functions from 202608140023. What counts as a
-- candidate is unchanged: a role with at least two opening events whose most recent
-- `exact` or `bounded` opening is the held-out target. `observed_by` targets have no
-- defensible actual interval and are never candidates, matching BacktestRunner.
--
-- Eligibility beyond that structural test depends on what was known by a cutoff, and
-- only BacktestRunner decides it. So the per-candidate outcome and the reason
-- distribution are read from the latest persisted `firstseen backtest` run
-- (`backtest_cases` for scored targets, `calibration_metrics.skipped_targets` for
-- skipped ones, each with the runner's own reason). Nothing here restates an
-- eligibility rule in SQL.
--
-- Outcomes are matched on the target event itself, never on (role, year) alone. A role
-- can have two backtest targets in one calendar year (on the August validation corpus a
-- Notion role had an observed_by capture in April and an exact posting in August, each
-- skipped for a different reason), and the backtest keeps one representative posting
-- per cycle, which need not be the event this page holds out. When the latest run
-- evaluated a different event for the same role and year, the candidate is labelled
-- `other_event` and carries no reason: SQL does not restate cycle identity to guess.

drop function public.replay_candidate_page(integer, integer);
drop function public.replay_candidate_summary();

-- Every target the most recent backtest run evaluated, scored or skipped.
create function public.replay_latest_backtest_outcomes()
returns table (
  target_event_id uuid,
  role_id uuid,
  target_year integer,
  outcome text,
  reason text
)
language sql
stable
set search_path = ''
as $$
  with latest as (
    select b.id, b.calibration_metrics
    from public.backtest_runs b
    order by b.finished_at desc, b.created_at desc, b.id
    limit 1
  ),
  scored as (
    select distinct c.target_event_id, c.canonical_role_id as role_id, c.target_year
    from latest l
    join public.backtest_cases c on c.run_id = l.id
  ),
  skipped as (
    select
      (item->>'target_event_id')::uuid as target_event_id,
      (item->>'role_id')::uuid as role_id,
      (item->>'target_year')::integer as target_year,
      min(item->>'reason') as reason
    from latest l
    cross join lateral jsonb_array_elements(
      coalesce(l.calibration_metrics->'skipped_targets', '[]'::jsonb)
    ) as item
    group by 1, 2, 3
  )
  select s.target_event_id, s.role_id, s.target_year, 'scored', null::text
  from scored s
  union all
  select k.target_event_id, k.role_id, k.target_year, 'skipped', k.reason
  from skipped k
  where not exists (select 1 from scored s where s.target_event_id = k.target_event_id)
$$;

-- Every structurally evaluable target, filtered. `latest_outcome` is null when no
-- backtest has ever been persisted; otherwise `scored` or `skipped` (this exact event
-- was evaluated), `other_event` (a different event of the same role and year was), or
-- `not_in_run` (the latest run did not evaluate this role and year at all).
create function public.replay_candidates(
  p_company text,
  p_query text,
  p_precision text,
  p_outcome text
)
returns table (
  role_id uuid,
  company_name text,
  canonical_title text,
  target_event_id uuid,
  opened_on date,
  date_precision text,
  latest_outcome text,
  skip_reason text
)
language sql
stable
set search_path = ''
as $$
  with history as (
    select e.canonical_role_id
    from public.historical_opening_events e
    group by e.canonical_role_id
    having count(*) >= 2
  ),
  targets as (
    select distinct on (e.canonical_role_id)
      e.canonical_role_id, e.id, e.opened_on, e.date_precision
    from public.historical_opening_events e
    join history h on h.canonical_role_id = e.canonical_role_id
    where e.date_precision in ('exact', 'bounded')
    order by e.canonical_role_id, e.opened_on desc, e.id
  ),
  run as (
    select exists (select 1 from public.backtest_runs) as present
  ),
  outcomes as materialized (
    select * from public.replay_latest_backtest_outcomes()
  ),
  labelled as (
    select
      t.canonical_role_id,
      c.name as company_name,
      r.canonical_title,
      t.id as target_event_id,
      t.opened_on,
      t.date_precision,
      case
        when not (select present from run) then null
        when o.outcome is not null then o.outcome
        when exists (
          select 1
          from outcomes other
          where other.role_id = t.canonical_role_id
            and other.target_year = extract(year from t.opened_on)::integer
        ) then 'other_event'
        else 'not_in_run'
      end as latest_outcome,
      o.reason as skip_reason
    from targets t
    join public.canonical_roles r on r.id = t.canonical_role_id
    join public.companies c on c.id = r.company_id
    left join outcomes o on o.target_event_id = t.id
  )
  select *
  from labelled l
  where (nullif(p_company, '') is null or l.company_name = p_company)
    -- strpos, not ILIKE: a search for "50%" or "c_o" is literal text, never a pattern.
    and (
      nullif(btrim(p_query), '') is null
      or strpos(lower(l.canonical_title || ' ' || l.company_name), lower(btrim(p_query))) > 0
    )
    and (nullif(p_precision, '') is null or l.date_precision = p_precision)
    and (nullif(p_outcome, '') is null or l.latest_outcome = p_outcome)
$$;

-- One bounded page, most recent target first; ties by role id, as before.
create function public.replay_candidate_page(
  p_company text,
  p_query text,
  p_precision text,
  p_outcome text,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  role_id uuid,
  company_name text,
  canonical_title text,
  target_event_id uuid,
  opened_on date,
  date_precision text,
  latest_outcome text,
  skip_reason text
)
language sql
stable
set search_path = ''
as $$
  select c.*
  from public.replay_candidates(p_company, p_query, p_precision, p_outcome) c
  order by c.opened_on desc, c.role_id
  limit least(greatest(p_limit, 0), 100)
  offset greatest(p_offset, 0)
$$;

-- The replay page's honest totals:
--   roles_with_history  roles with at least two opening events
--   observed_by_only    of those, roles (with a company) that have no scoreable opening
--   candidates          structurally evaluable targets, unfiltered
--   exact_candidates / bounded_candidates   the same, by precision class
--   matching            targets matching the given filters
create function public.replay_candidate_summary(
  p_company text,
  p_query text,
  p_precision text,
  p_outcome text
)
returns table (
  roles_with_history bigint,
  observed_by_only bigint,
  candidates bigint,
  exact_candidates bigint,
  bounded_candidates bigint,
  matching bigint
)
language sql
stable
set search_path = ''
as $$
  with history as (
    select
      e.canonical_role_id,
      count(*) filter (where e.date_precision in ('exact', 'bounded')) as scoreable
    from public.historical_opening_events e
    group by e.canonical_role_id
    having count(*) >= 2
  ),
  known as (
    select h.*
    from history h
    join public.canonical_roles r on r.id = h.canonical_role_id
    join public.companies c on c.id = r.company_id
  ),
  everything as (
    select date_precision from public.replay_candidates(null, null, null, null)
  )
  select
    (select count(*) from history),
    (select count(*) from known where scoreable = 0),
    (select count(*) from everything),
    (select count(*) from everything where date_precision = 'exact'),
    (select count(*) from everything where date_precision = 'bounded'),
    (select count(*) from public.replay_candidates(p_company, p_query, p_precision, p_outcome))
$$;

-- Companies that have at least one candidate, for the company filter.
create function public.replay_candidate_companies()
returns table (
  company_name text,
  candidates bigint
)
language sql
stable
set search_path = ''
as $$
  select c.company_name, count(*)
  from public.replay_candidates(null, null, null, null) c
  group by c.company_name
  order by c.company_name
  limit 500
$$;

-- The latest persisted backtest run and how many of its targets were skipped for each
-- reason, in BacktestRunner's words. No rows when no run exists; one row with a null
-- reason when the run skipped nothing.
create function public.replay_backtest_reasons()
returns table (
  run_id uuid,
  finished_at timestamptz,
  cutoff_days integer,
  target_count integer,
  completed_cases integer,
  skipped_cases integer,
  reason text,
  targets bigint
)
language sql
stable
set search_path = ''
as $$
  with latest as (
    select b.*
    from public.backtest_runs b
    order by b.finished_at desc, b.created_at desc, b.id
    limit 1
  ),
  reasons as (
    select item->>'reason' as reason, count(*) as targets
    from latest l
    cross join lateral jsonb_array_elements(
      coalesce(l.calibration_metrics->'skipped_targets', '[]'::jsonb)
    ) as item
    group by 1
  )
  select l.id, l.finished_at, l.cutoff_days, l.target_count, l.completed_cases, l.skipped_cases,
         r.reason, coalesce(r.targets, 0)
  from latest l
  left join reasons r on true
  order by r.targets desc nulls last, r.reason
$$;

-- --------------------------------------------------------------------- access

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.replay_latest_backtest_outcomes()',
    'public.replay_candidates(text, text, text, text)',
    'public.replay_candidate_page(text, text, text, text, integer, integer)',
    'public.replay_candidate_summary(text, text, text, text)',
    'public.replay_candidate_companies()',
    'public.replay_backtest_reasons()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

comment on function public.replay_candidate_page(text, text, text, text, integer, integer) is
  'Service-only. One filtered page of structurally evaluable Forecast Replay targets (exact/bounded only).';
comment on function public.replay_backtest_reasons() is
  'Service-only. Skip-reason distribution of the latest persisted backtest run, as BacktestRunner wrote it.';
