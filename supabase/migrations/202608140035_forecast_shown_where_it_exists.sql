-- A window is shown wherever forecasting.py produced one.
--
-- 202608140029 made a role forecastable on the dashboard only when its stored forecast rested on two or more recruiting
-- cycles, and listed every other stored forecast as "a role without enough history". No other surface did that: the
-- role page, the recruiting calendar, the readiness planner, the digest and the agent all use the latest stored forecast
-- whatever its history. So the dashboard said "a forecast needs two cycles" about 120 roles whose own pages showed one.
--
-- The forecasting contract is the other way round. forecasting.py forecasts a role with fewer than three cycles of its
-- own only by borrowing the timing of comparable programs (same level and recruiting season), under wider interval
-- floors and lower confidence caps, and refuses with InsufficientEvidenceError when there is nothing to borrow. What it
-- refuses is what has no forecast; what it produced is shown, with its cycle count beside it. The dashboard's "2 or more
-- cycles" filter still narrows to deeper histories for anyone who wants that.
--
-- Same signature and columns as 202608140029, so every dependent function keeps working. `forecastable` and
-- `has_forecast` now agree; both stay because callers name both.

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
    l.canonical_role_id is not null,
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

-- How deep the history behind today's forecasts is, for the methodology page: one row per bucket of the program's own
-- recruiting cycles behind its latest forecast (0, 1, 2, 3 meaning three or more), and one row with a null bucket for
-- in-scope roles with no forecast. Counted over the same rows the dashboard lists.
create or replace function public.forecast_history_depth(p_now timestamptz)
returns table (history_count integer, roles bigint)
language sql
stable
set search_path = ''
as $$
  select
    case when s.has_forecast then least(coalesce(s.history_count, 0), 3) end,
    count(*)
  from public.forecast_role_states(p_now) s
  group by 1
$$;

revoke all on function public.forecast_role_states(timestamptz) from public, anon, authenticated;
grant execute on function public.forecast_role_states(timestamptz) to service_role;
revoke all on function public.forecast_history_depth(timestamptz) from public, anon, authenticated;
grant execute on function public.forecast_history_depth(timestamptz) to service_role;

comment on function public.forecast_history_depth(timestamptz) is
  'Service-only. In-scope roles by the recruiting cycles behind their latest forecast (3 = three or more; null = no forecast).';
