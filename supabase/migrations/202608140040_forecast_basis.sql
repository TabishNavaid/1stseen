-- A forecast's basis: how much of its window rests on the program's own openings.
--
-- forecasting.py records every contribution to a forecast in forecasts.feature_contributions, with the date weight it
-- gave it; the date weights sum to one. `role_history` is the program's own openings; `company_prior` and
-- `role_family_prior` are the comparable programs whose timing it borrows when its own history is short. The product
-- shows which of the two a window mainly rests on, as its own labelled class beside the evidence classes, wherever a
-- forecast appears (apps/web/lib/forecast-basis.ts).
--
-- Read from feature_contributions rather than forecast_evidence: those are the model's exact weights, while
-- forecast_evidence stores them rounded to four places per row and keeps a signal row's confidence effect in the same
-- column. Both give the same basis for every forecast on the rig, but one source keeps every surface on one number.
-- Summing here keeps the read to one row per forecast; feature_contributions runs to several kilobytes and is never
-- selected by a page.
--
-- Two ways in, both capped at 1000 ids so a result never meets PostgREST's row cap (a caller with more pages its ids):
--   forecast_basis_for_forecasts  by forecast id, for a surface that holds the forecast it shows
--   forecast_basis                by role, for its latest forecast by forecast_role_states' rule (forecasted_at, then id)

create or replace function public.forecast_basis_for_forecasts(p_forecast_ids uuid[])
returns table (forecast_id uuid, own_weight numeric, borrowed_weight numeric)
language plpgsql
stable
set search_path = ''
as $$
begin
  if coalesce(cardinality(p_forecast_ids), 0) > 1000 then
    raise exception 'forecast_basis_for_forecasts takes at most 1000 forecast ids per call, got %', cardinality(p_forecast_ids);
  end if;
  return query
    select
      f.id,
      coalesce(sum((c ->> 'date_weight')::numeric) filter (where c ->> 'kind' = 'role_history'), 0),
      coalesce(sum((c ->> 'date_weight')::numeric) filter (where c ->> 'kind' in ('company_prior', 'role_family_prior')), 0)
    from public.forecasts f
    left join lateral jsonb_array_elements(coalesce(f.feature_contributions, '[]'::jsonb)) as c
      on (c ->> 'influences_date')::boolean
    where f.id = any(p_forecast_ids)
    group by f.id;
end;
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
      where f.canonical_role_id = any(p_role_ids)
      order by f.canonical_role_id, f.forecasted_at desc, f.id
    )
    select l.canonical_role_id, b.forecast_id, b.own_weight, b.borrowed_weight
    from latest l
    join public.forecast_basis_for_forecasts(array(select id from latest)) b on b.forecast_id = l.id;
end;
$$;

do $$
declare
  fn text;
begin
  foreach fn in array array['public.forecast_basis_for_forecasts(uuid[])', 'public.forecast_basis(uuid[])'] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

comment on function public.forecast_basis_for_forecasts(uuid[]) is
  'Service-only. Own-history and comparable-program date weight of each forecast, from feature_contributions.';
comment on function public.forecast_basis(uuid[]) is
  'Service-only. The same for each role''s latest forecast, by forecast_role_states'' ordering.';
