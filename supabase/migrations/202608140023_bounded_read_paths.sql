-- Bounded, server-side read paths for the web surfaces.
--
-- The dashboard, Forecast Replay, calendar, and digest loaders used to read every
-- canonical role, forecast, and historical opening event into the Worker and derive
-- their views there. That is a full-table read per page view, and PostgREST's row cap
-- turns any unpaged read into silent truncation. These functions do the selection,
-- filtering, ordering, counting, and paging in Postgres and return only what a page
-- renders. They reproduce the previous in-Worker derivations exactly; comments name
-- the TypeScript each one replaces.
--
-- All functions are SECURITY INVOKER, callable only by service_role, and read no
-- user-owned table except through an explicit user id supplied by the server.

-- --------------------------------------------------------------------- indexes

-- Latest forecast per role, in the dashboard's order (forecasted_at desc, id).
create index forecasts_role_latest_idx
  on public.forecasts (canonical_role_id, forecasted_at desc, id);

-- Confirmed openings: exact source dates, newest first.
create index historical_openings_exact_recent_idx
  on public.historical_opening_events (opened_on desc)
  where date_precision = 'exact';

-- Replay targets: the most recent scoreable opening per role.
create index historical_openings_scoreable_role_idx
  on public.historical_opening_events (canonical_role_id, opened_on desc, id)
  where date_precision in ('exact', 'bounded');

-- ------------------------------------------------------------ follow coverage

-- Mirrors repository._follow_covers_role (worker/src/firstseen/repository.py): a role
-- is followed only through an explicit canonical-role, company, role-family, or track
-- follow. The watchlist_items check constraint guarantees the compared column is
-- non-null for its target type, so plain equality matches the Python comparison.
-- `p_alerts_only` is the digest's additional alerts_enabled filter.
create function public.followed_role_ids(p_user_id uuid, p_alerts_only boolean default false)
returns table (role_id uuid)
language sql
stable
set search_path = ''
as $$
  select r.id
  from public.canonical_roles r
  where p_user_id is not null
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

-- ------------------------------------------------------------------ dashboard

-- One row per canonical role whose company exists: its latest stored forecast (if
-- any), how many historical opening events it has, and whole days until the point
-- date as the dashboard computes them:
--   Math.max(0, Math.round((utcDate(point_date) - now) / 86_400_000))
-- where utcDate (apps/web/lib/dates.ts) anchors a bare date at 12:00 UTC. Postgres
-- rounds half away from zero and JavaScript rounds half up; they differ only for
-- negative halves, which the clamp to zero erases.
create function public.forecast_role_states(p_now timestamptz)
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
$$;

-- The dashboard's search and track filter:
--   (track === "All" || role.track === track)
--   && `${company} ${role}`.toLowerCase().includes(query.trim().toLowerCase())
-- where the displayed track is "New grad" exactly when level = 'new_grad'.
create function public.dashboard_role_matches(
  p_level text,
  p_company text,
  p_title text,
  p_track text,
  p_query text
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select (p_track is null or (p_level = 'new_grad') = (p_track = 'new_grad'))
    and (
      coalesce(btrim(p_query, E' \t\r\n'), '') = ''
      or strpos(lower(p_company || ' ' || p_title), lower(btrim(p_query, E' \t\r\n'))) > 0
    )
$$;

-- One page of forecast cards, soonest first, with each role's full cycle list.
-- Order is days_until then role id, which is the order the in-Worker stable sort
-- produced over roles read in id order.
create function public.dashboard_forecast_page(
  p_now timestamptz,
  p_user_id uuid default null,
  p_track text default null,
  p_query text default null,
  p_watched_only boolean default false,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  role_id uuid,
  company_name text,
  canonical_title text,
  level text,
  location_scope text,
  point_date date,
  window_start date,
  window_end date,
  confidence numeric,
  confidence_factors jsonb,
  history_count integer,
  days_until integer,
  cycles jsonb
)
language sql
stable
set search_path = ''
as $$
  with page as (
    select s.*
    from public.forecast_role_states(p_now) s
    where s.forecastable
      and public.dashboard_role_matches(s.level, s.company_name, s.canonical_title, p_track, p_query)
      and (
        not p_watched_only
        or s.role_id in (select f.role_id from public.followed_role_ids(p_user_id) f)
      )
    order by s.days_until, s.role_id
    limit least(greatest(p_limit, 0), 100)
    offset greatest(p_offset, 0)
  )
  select
    p.role_id, p.company_name, p.canonical_title, p.level, p.location_scope,
    p.point_date, p.window_start, p.window_end, p.confidence, p.confidence_factors,
    p.history_count, p.days_until,
    coalesce(cy.cycles, '[]'::jsonb)
  from page p
  left join lateral (
    -- Every cycle, oldest first; ties keep event id order, as the old sort did.
    select jsonb_agg(
      jsonb_build_object(
        'opened_on', e.opened_on,
        'date_precision', e.date_precision,
        'source_type', o.source_type
      )
      order by e.opened_on, e.id
    ) as cycles
    from public.historical_opening_events e
    left join public.raw_job_observations o on o.id = e.observation_id
    where e.canonical_role_id = p.role_id
  ) cy on true
  order by p.days_until, p.role_id
$$;

-- Every count the dashboard shows, from the same filters as the page.
--   scope = watchedOnly ? filtered : all forecastable roles  (component behaviour)
create function public.dashboard_summary(
  p_now timestamptz,
  p_user_id uuid default null,
  p_track text default null,
  p_query text default null,
  p_watched_only boolean default false
)
returns table (
  forecast_roles bigint,
  matching_roles bigint,
  scope_roles bigint,
  scope_opening_within_30_days bigint,
  followed_roles bigint,
  followed_forecast_roles bigint,
  insufficient_roles bigint
)
language sql
stable
set search_path = ''
as $$
  with followed as (
    select f.role_id from public.followed_role_ids(p_user_id) f
  ),
  states as (
    select s.*, s.role_id in (select role_id from followed) as is_followed
    from public.forecast_role_states(p_now) s
  ),
  matching as (
    select *
    from states s
    where s.forecastable
      and public.dashboard_role_matches(s.level, s.company_name, s.canonical_title, p_track, p_query)
      and (not p_watched_only or s.is_followed)
  )
  select
    (select count(*) from states where forecastable),
    (select count(*) from matching),
    case when p_watched_only
      then (select count(*) from matching)
      else (select count(*) from states where forecastable)
    end,
    case when p_watched_only
      then (select count(*) from matching where days_until <= 30)
      else (select count(*) from states where forecastable and days_until <= 30)
    end,
    (select count(*) from followed),
    (select count(*) from states where forecastable and is_followed),
    (select count(*) from states where not forecastable)
$$;

-- Roles with too little evidence to forecast, in role id order. The dashboard shows
-- the first few with an honest reason; `p_followed_only` restricts to the user's follows.
create function public.dashboard_insufficient_roles(
  p_now timestamptz,
  p_user_id uuid default null,
  p_followed_only boolean default false,
  p_limit integer default 8
)
returns table (
  role_id uuid,
  company_name text,
  canonical_title text,
  has_forecast boolean,
  cycle_count integer
)
language sql
stable
set search_path = ''
as $$
  select s.role_id, s.company_name, s.canonical_title, s.has_forecast, s.cycle_count
  from public.forecast_role_states(p_now) s
  where not s.forecastable
    and (
      not p_followed_only
      or s.role_id in (select f.role_id from public.followed_role_ids(p_user_id) f)
    )
  order by s.role_id
  limit least(greatest(p_limit, 0), 100)
$$;

-- ------------------------------------------------------------ Forecast Replay

-- Structurally evaluable replay targets: roles with at least two opening events whose
-- most recent `exact` or `bounded` opening becomes the held-out target. `observed_by`
-- targets have no defensible actual interval and are never candidates, matching
-- BacktestRunner. Ties on the target date keep event id order, as the old sort did;
-- candidates with the same target date are ordered by role id.
create function public.replay_candidate_page(
  p_limit integer default 60,
  p_offset integer default 0
)
returns table (
  role_id uuid,
  company_name text,
  canonical_title text,
  opened_on date,
  date_precision text
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
      e.canonical_role_id, e.opened_on, e.date_precision
    from public.historical_opening_events e
    join history h on h.canonical_role_id = e.canonical_role_id
    where e.date_precision in ('exact', 'bounded')
    order by e.canonical_role_id, e.opened_on desc, e.id
  )
  select t.canonical_role_id, c.name, r.canonical_title, t.opened_on, t.date_precision
  from targets t
  join public.canonical_roles r on r.id = t.canonical_role_id
  join public.companies c on c.id = r.company_id
  order by t.opened_on desc, t.canonical_role_id
  limit least(greatest(p_limit, 0), 100)
  offset greatest(p_offset, 0)
$$;

-- The replay page's honest totals:
--   roles_with_history  roles with at least two opening events
--   observed_by_only    of those, roles (with a company) that have no scoreable opening
--   candidates          of those, roles (with a company) that have one
create function public.replay_candidate_summary()
returns table (
  roles_with_history bigint,
  observed_by_only bigint,
  candidates bigint
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
  )
  select
    (select count(*) from history),
    (select count(*) from known where scoreable = 0),
    (select count(*) from known where scoreable > 0)
$$;

-- --------------------------------------------------------------------- access

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.followed_role_ids(uuid, boolean)',
    'public.forecast_role_states(timestamptz)',
    'public.dashboard_role_matches(text, text, text, text, text)',
    'public.dashboard_forecast_page(timestamptz, uuid, text, text, boolean, integer, integer)',
    'public.dashboard_summary(timestamptz, uuid, text, text, boolean)',
    'public.dashboard_insufficient_roles(timestamptz, uuid, boolean, integer)',
    'public.replay_candidate_page(integer, integer)',
    'public.replay_candidate_summary()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

comment on function public.followed_role_ids(uuid, boolean) is
  'Service-only. Canonical roles covered by a user''s explicit follows; mirrors repository._follow_covers_role.';
comment on function public.dashboard_forecast_page(timestamptz, uuid, text, text, boolean, integer, integer) is
  'Service-only. One bounded page of dashboard forecast cards; replaces the in-Worker full-table derivation.';
comment on function public.replay_candidate_page(integer, integer) is
  'Service-only. Structurally evaluable Forecast Replay targets (exact/bounded held-out openings only).';
