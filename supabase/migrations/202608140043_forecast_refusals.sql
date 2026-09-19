-- A forecast stops being current when forecasting.py declines its role.
--
-- Regeneration re-forecasts a role when its evidence changes (202608140042). When the model now declines the role
-- (InsufficientEvidenceError: too little history and no comparable program to borrow timing from), the role kept its
-- last forecast, and every surface showed that window as current: on the rig a Neuralink program lost an opening to a
-- re-resolution, the model declined it, and the dashboard still showed its old window "3 cycles behind it". The agent,
-- which forecasts on demand, said there was not enough history. Forecasts are immutable versions, so the refusal is
-- recorded on the role instead: forecast_refused_at and the model's own reason. A forecast is current only when it is
-- newer than the role's last refusal, so a later forecast makes the role current again with nothing to clear.
--
-- forecast_role_states (every dashboard, onboarding, landing, and methodology count) and forecast_basis choose the
-- current forecast by that rule; the web app and the worker apply the same rule where they read forecasts directly
-- (apps/web/lib/forecast-gap.ts currentForecast, worker firstseen.forecast_currency).

alter table public.canonical_roles
  add column forecast_refused_at timestamptz,
  add column forecast_refusal_reason text,
  add constraint canonical_roles_forecast_refusal_reason_check
    check (forecast_refusal_reason is null or octet_length(forecast_refusal_reason) between 1 and 500);

comment on column public.canonical_roles.forecast_refused_at is
  'When forecast regeneration last found this role unforecastable. A forecast older than this is history, not current.';
comment on column public.canonical_roles.forecast_refusal_reason is
  'forecasting.py''s reason for that refusal, verbatim.';

-- Refusals made before this column existed are in regeneration's audit rows. A role whose latest regeneration outcome
-- was insufficient_evidence, and which has no forecast newer than that, is marked refused at that moment, with the
-- model's reason as recorded.
update public.canonical_roles r
set forecast_refused_at = latest.started_at,
    forecast_refusal_reason = coalesce(nullif(left(latest.reason, 500), ''), 'insufficient evidence')
from (
  select distinct on (c.input_redacted ->> 'role_id')
    (c.input_redacted ->> 'role_id')::uuid as role_id,
    c.started_at,
    c.output_redacted ->> 'result' as result,
    c.output_redacted ->> 'reason' as reason
  from public.agent_tool_calls c
  where c.tool_name in ('forecast.regenerate_changed_role', 'forecast.regenerate_after_withdrawal')
    and (c.input_redacted ->> 'role_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  order by c.input_redacted ->> 'role_id', c.started_at desc, c.id
) latest
where r.id = latest.role_id
  and latest.result = 'insufficient_evidence'
  and exists (select 1 from public.forecasts f where f.canonical_role_id = r.id and f.forecasted_at < latest.started_at)
  and not exists (select 1 from public.forecasts f where f.canonical_role_id = r.id and f.forecasted_at >= latest.started_at);

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
    -- The role's latest forecast, unless forecasting.py has since declined the role: then it has none.
    select distinct on (f.canonical_role_id)
      f.canonical_role_id, f.point_date, f.window_start, f.window_end,
      f.confidence, f.confidence_factors, f.history_count
    from public.forecasts f
    join public.canonical_roles fr on fr.id = f.canonical_role_id
    where fr.forecast_refused_at is null or f.forecasted_at > fr.forecast_refused_at
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
    and r.active
$$;

create or replace function public.forecast_basis(p_role_ids uuid[])
returns table (role_id uuid, forecast_id uuid, own_weight numeric, borrowed_weight numeric)
language plpgsql
stable
set search_path = ''
as $$
begin
  if coalesce(cardinality(p_role_ids), 0) > 1000 then
    raise exception 'forecast_basis takes at most 1000 role ids per call, got %', cardinality(p_role_ids);
  end if;
  return query
    with latest as (
      select distinct on (f.canonical_role_id) f.canonical_role_id, f.id
      from public.forecasts f
      join public.canonical_roles r on r.id = f.canonical_role_id
      where f.canonical_role_id = any(p_role_ids)
        and (r.forecast_refused_at is null or f.forecasted_at > r.forecast_refused_at)
      order by f.canonical_role_id, f.forecasted_at desc, f.id
    )
    select l.canonical_role_id, b.forecast_id, b.own_weight, b.borrowed_weight
    from latest l
    join public.forecast_basis_for_forecasts(array(select id from latest)) b on b.forecast_id = l.id;
end;
$$;
