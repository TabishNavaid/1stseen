-- The first-run questions, and the watchlist they seed.
--
-- recruiting_preferences gains the disciplines a user chose (the ten in docs/role-scope.md, not role families, which
-- are an older and different vocabulary) and when they finished or skipped the first run, so a skip is remembered
-- rather than asked again. The columns stay user-owned under the table's existing RLS policies and grants; nothing here
-- grants anon anything.
--
-- onboarding_seed_roles proposes the in-scope roles those answers fit. It reads dashboard_role_facts, so a seeded
-- watchlist can never hold a role the dashboard would not list, and it is service-role only like every bounded read path.

alter table public.recruiting_preferences
  add column target_disciplines public.role_discipline[] not null default '{}',
  add column onboarding_completed_at timestamptz,
  add column onboarding_skipped_at timestamptz,
  add constraint recruiting_preferences_target_disciplines_present
    check (array_position(target_disciplines, null) is null);

comment on column public.recruiting_preferences.target_disciplines is
  'Disciplines chosen in the first run (docs/role-scope.md). They seed follows and never widen the product scope.';
comment on column public.recruiting_preferences.onboarding_completed_at is
  'When the user last finished the first-run questions; running them again from settings updates it.';
comment on column public.recruiting_preferences.onboarding_skipped_at is
  'When the user skipped the first run. A skipped first run is not offered again unprompted.';

-- Proposed follows for one set of first-run answers.
--
-- Every filter is optional: an empty discipline or type list, a null season, or no places matches every role. A role
-- that states a different season, or a location that matches none of the places given, is not what was asked for and
-- is left out. A role that states no season (218 of 341 on the rig) or no location (242) may still be, so it stays,
-- ranked after the roles that match.
--
-- Roles with a current forecast (two or more cycles and a window that has not ended) come first, because a readiness
-- plan can only be worked back from one. Then a matched place, a matched season, and for current forecasts only,
-- confidence and cycles, so a role is never ordered by a forecast the product does not show. Low-confidence forecasts
-- are not left out. At most two roles per company, so one company cannot fill a starting watchlist; matching_roles
-- counts every role the answers fit, before that cap and the limit.
--
-- Places match as whole words after lower-casing and replacing punctuation with spaces, in either direction: "New York"
-- matches "new york ny", and "Toronto, Canada" matches "canada".
create or replace function public.onboarding_seed_roles(
  p_now timestamptz,
  p_user_id uuid default null,
  p_disciplines text[] default null,
  p_types text[] default null,
  p_season text default null,
  p_locations text[] default null,
  p_limit integer default 8
)
returns table (
  role_id uuid,
  company_id uuid,
  company_name text,
  canonical_title text,
  discipline text,
  program_type text,
  season text,
  location_scope text,
  current_forecast boolean,
  point_date date,
  window_start date,
  window_end date,
  confidence numeric,
  history_count integer,
  exact_events integer,
  bounded_events integer,
  observed_events integer,
  listed_now boolean,
  is_followed boolean,
  season_matched boolean,
  location_matched boolean,
  matching_roles bigint,
  matching_current_forecasts bigint
)
language sql
stable
set search_path = ''
as $$
  with places as (
    select coalesce(array_agg(normalized.place), '{}'::text[]) as list
    from (
      select btrim(regexp_replace(lower(value), '[^a-z0-9]+', ' ', 'g')) as place
      from unnest(coalesce(p_locations, '{}'::text[])) as value
    ) normalized
    where normalized.place <> ''
  ),
  candidates as (
    select
      f.role_id,
      f.company_id,
      f.company_name,
      f.canonical_title,
      f.discipline,
      f.program_type,
      f.season,
      f.location_scope,
      f.forecastable and f.window_end >= (p_now at time zone 'UTC')::date as current_forecast,
      f.point_date,
      f.window_start,
      f.window_end,
      f.confidence,
      f.history_count,
      f.exact_events,
      f.bounded_events,
      f.observed_events,
      f.listed_now,
      f.is_followed,
      p_season is not null and f.season = p_season as season_matched,
      f.location_scope <> 'unspecified' and exists (
        select 1
        from unnest((select list from places)) as wanted(place)
        where strpos(loc.padded, ' ' || wanted.place || ' ') > 0
          or strpos(' ' || wanted.place || ' ', loc.padded) > 0
      ) as location_matched
    from public.dashboard_role_facts(p_now, p_user_id) f
    cross join lateral (
      select ' ' || btrim(regexp_replace(lower(f.location_scope), '[^a-z0-9]+', ' ', 'g')) || ' ' as padded
    ) loc
    where (coalesce(cardinality(p_disciplines), 0) = 0 or f.discipline = any (p_disciplines))
      and (coalesce(cardinality(p_types), 0) = 0 or f.program_type = any (p_types))
      and (p_season is null or f.season in (p_season, 'unknown', 'year_round'))
  ),
  eligible as (
    select c.*
    from candidates c
    where cardinality((select list from places)) = 0
      or c.location_scope = 'unspecified'
      or c.location_matched
  ),
  ranked as (
    select
      e.*,
      row_number() over (
        partition by e.company_id
        order by
          e.current_forecast desc,
          e.location_matched desc,
          e.season_matched desc,
          case when e.current_forecast then e.confidence end desc nulls last,
          case when e.current_forecast then e.history_count end desc nulls last,
          e.exact_events + e.bounded_events desc,
          e.listed_now desc,
          e.canonical_title,
          e.role_id
      ) as company_rank,
      count(*) over () as matching_roles,
      count(*) filter (where e.current_forecast) over () as matching_current_forecasts
    from eligible e
  )
  select
    r.role_id, r.company_id, r.company_name, r.canonical_title, r.discipline, r.program_type, r.season, r.location_scope,
    r.current_forecast, r.point_date, r.window_start, r.window_end, r.confidence, r.history_count, r.exact_events,
    r.bounded_events, r.observed_events, r.listed_now, r.is_followed, r.season_matched, r.location_matched,
    r.matching_roles, r.matching_current_forecasts
  from ranked r
  where r.company_rank <= 2
  order by
    r.current_forecast desc,
    r.location_matched desc,
    r.season_matched desc,
    case when r.current_forecast then r.confidence end desc nulls last,
    case when r.current_forecast then r.history_count end desc nulls last,
    r.exact_events + r.bounded_events desc,
    r.listed_now desc,
    r.company_name,
    r.canonical_title,
    r.role_id
  limit least(greatest(coalesce(p_limit, 8), 1), 20)
$$;

revoke all on function public.onboarding_seed_roles(timestamptz, uuid, text[], text[], text, text[], integer)
  from public, anon, authenticated;
grant execute on function public.onboarding_seed_roles(timestamptz, uuid, text[], text[], text, text[], integer)
  to service_role;
