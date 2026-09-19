-- Product read paths return in-scope roles only.
--
-- Same names, signatures, and results as 202608140023 and 202608140025, with one added condition:
-- canonical_roles.scope_status = 'in_scope'. Out-of-scope, ambiguous, and unclassified roles stay in
-- the database as evidence and never reach the dashboard, a watchlist, a digest, the calendar, or
-- Forecast Replay. `create or replace` keeps each function's existing grants (service role only).

-- A follow covers in-scope roles only; the digest, calendar, and watched-only dashboard read this.
create or replace function public.followed_role_ids(p_user_id uuid, p_alerts_only boolean default false)
returns table (role_id uuid)
language sql
stable
set search_path = ''
as $$
  select r.id
  from public.canonical_roles r
  where p_user_id is not null
    and r.scope_status = 'in_scope'
    and exists (
      select 1
      from public.watchlist_items w
      where w.user_id = p_user_id
        and (not p_alerts_only or w.alerts_enabled)
        and (
          (w.target_type = 'canonical_role' and w.canonical_role_id = r.id)
          or (w.target_type = 'company' and w.company_id = r.company_id)
          or (w.target_type = 'role_family' and w.role_family = r.role_family)
          or (w.target_type = 'track' and w.track = r.track)
        )
    )
$$;

-- One row per in-scope canonical role whose company exists. Every dashboard function reads roles
-- through this one, so the page, its counts, and the insufficient-evidence list share one scope.
create or replace function public.forecast_role_states(p_now timestamptz)
returns table (
  role_id uuid,
  company_name text,
  canonical_title text,
  level text,
  location_scope text,
  forecastable boolean,
  has_forecast boolean,
  cycle_count integer,
  point_date date,
  window_start date,
  window_end date,
  confidence numeric,
  confidence_factors jsonb,
  history_count integer,
  days_until integer
)
language sql
stable
set search_path = ''
as $$
  with latest as (
    select distinct on (f.canonical_role_id)
      f.canonical_role_id, f.point_date, f.window_start, f.window_end,
      f.confidence, f.confidence_factors, f.history_count
    from public.forecasts f
    order by f.canonical_role_id, f.forecasted_at desc, f.id
  ),
  cycles as (
    select e.canonical_role_id, count(*)::integer as n
    from public.historical_opening_events e
    group by e.canonical_role_id
  )
  select
    r.id,
    c.name,
    r.canonical_title,
    r.level,
    r.location_scope,
    -- The shared ForecastRole contract requires at least two historical cycles.
    l.canonical_role_id is not null and coalesce(cy.n, 0) >= 2,
    l.canonical_role_id is not null,
    coalesce(cy.n, 0),
    l.point_date,
    l.window_start,
    l.window_end,
    l.confidence,
    l.confidence_factors,
    l.history_count,
    case
      when l.point_date is null then null
      else greatest(
        0,
        round(
          extract(epoch from ((l.point_date::timestamp + interval '12 hours') - (p_now at time zone 'UTC')))
          / 86400
        )
      )::integer
    end
  from public.canonical_roles r
  join public.companies c on c.id = r.company_id
  left join latest l on l.canonical_role_id = r.id
  left join cycles cy on cy.canonical_role_id = r.id
  where r.scope_status = 'in_scope'
$$;

-- Every structurally evaluable replay target of an in-scope role, filtered; see 202608140025.
create or replace function public.replay_candidates(
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
    join public.canonical_roles r on r.id = t.canonical_role_id and r.scope_status = 'in_scope'
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

-- The replay page's honest totals, counted over in-scope roles; see 202608140025.
create or replace function public.replay_candidate_summary(
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
    join public.canonical_roles r on r.id = e.canonical_role_id and r.scope_status = 'in_scope'
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
