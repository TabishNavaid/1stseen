-- Dashboard filtering, search, sort, and the per-company collapse.
--
-- The default view is every in-scope role (docs/role-scope.md). Roles with a forecast come first; roles without
-- enough history follow and are counted, never dropped, so no default hides a low-confidence or insufficient role.
-- Every filter is a predicate here, over one row per in-scope role, so the Worker reads one bounded page and a
-- fixed set of counts. The earlier dashboard functions, which listed forecastable roles only, are replaced.

-- ------------------------------------------------------------------ forecastable

-- A role is forecastable when its stored forecast rests on at least two recruiting cycles, counted the way
-- forecasting.py counts them (`history_count`). Counting raw opening events instead made four one-cycle forecasts
-- (Virtu 3, DV Trading 1) forecastable after the company expansion. Same signature and columns as
-- 202608140027; `cycle_count` is still the raw event count.
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
    l.canonical_role_id is not null and coalesce(l.history_count, 0) >= 2,
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

-- --------------------------------------------------------------------- facts

-- One row per in-scope role with everything a filter, a sort, or a card needs.
--   program_type   the scope classifier's early-career type
--   season         recruiting_season, 'unknown' when not stated
--   target_year    the latest program year a posting title states ("[2027] Software Engineer"), as
--                  cycles.derive_cycle_key reads it; null when no title states one
--   *_events       opening events by date precision
--   listed_now     a live (non-archive) posting for the role was present when its source was last fetched
--   search_text    company, canonical title, location, and every observed alias, lower-cased, so a program split
--                  by location or specialization is found by the words of either title
create or replace function public.dashboard_role_facts(p_now timestamptz, p_user_id uuid default null)
returns table (
  role_id uuid,
  company_id uuid,
  company_name text,
  canonical_title text,
  discipline text,
  program_type text,
  season text,
  target_year integer,
  location_scope text,
  level text,
  forecastable boolean,
  has_forecast boolean,
  point_date date,
  window_start date,
  window_end date,
  confidence numeric,
  confidence_factors jsonb,
  history_count integer,
  days_until integer,
  exact_events integer,
  bounded_events integer,
  observed_events integer,
  listed_now boolean,
  is_followed boolean,
  search_text text
)
language sql
stable
set search_path = ''
as $$
  select
    s.role_id,
    r.company_id,
    s.company_name,
    s.canonical_title,
    r.discipline::text,
    r.early_career_type::text,
    coalesce(nullif(r.recruiting_season, ''), 'unknown'),
    aliases.target_year,
    coalesce(nullif(r.location_scope, ''), 'unspecified'),
    s.level,
    s.forecastable,
    s.has_forecast,
    s.point_date,
    s.window_start,
    s.window_end,
    s.confidence,
    s.confidence_factors,
    s.history_count,
    s.days_until,
    coalesce(events.exact_events, 0),
    coalesce(events.bounded_events, 0),
    coalesce(events.observed_events, 0),
    listed.role_id is not null,
    s.role_id in (select f.role_id from public.followed_role_ids(p_user_id) f),
    lower(concat_ws(' ', s.company_name, s.canonical_title, r.location_scope, aliases.titles))
  from public.forecast_role_states(p_now) s
  join public.canonical_roles r on r.id = s.role_id
  left join lateral (
    select
      count(*) filter (where e.date_precision = 'exact')::integer as exact_events,
      count(*) filter (where e.date_precision = 'bounded')::integer as bounded_events,
      count(*) filter (where e.date_precision = 'observed_by')::integer as observed_events
    from public.historical_opening_events e
    where e.canonical_role_id = s.role_id
  ) events on true
  left join lateral (
    select
      max((regexp_match(a.alias_title, '(?:^|[^0-9])(20[2-9][0-9])(?:[^0-9]|$)'))[1]::integer) as target_year,
      string_agg(a.alias_title, ' ') as titles
    from public.role_aliases a
    where a.canonical_role_id = s.role_id
  ) aliases on true
  left join lateral (
    select m.canonical_role_id as role_id
    from public.observation_role_matches m
    join public.raw_job_observations o on o.id = m.observation_id
    join public.sources src on src.id = o.source_id
    where m.canonical_role_id = s.role_id
      and src.adapter <> 'wayback'
      and o.archive_capture_at is null
      and o.last_seen_at >= (
        select max(sf.fetched_at) - interval '10 minutes'
        from public.source_fetches sf
        where sf.source_id = o.source_id
      )
    limit 1
  ) listed on true
$$;

-- ------------------------------------------------------------------- filters

-- The facts with one boolean per filter. An empty or null filter matches every role. A word search matches when
-- every word appears in search_text. The window, confidence, and cycles filters describe forecasts, so a role with
-- no forecast fails them; that is the user's choice, and the summary counts what it excluded.
create or replace function public.dashboard_filtered_roles(
  p_now timestamptz,
  p_user_id uuid default null,
  p_query text default null,
  p_disciplines text[] default null,
  p_companies uuid[] default null,
  p_types text[] default null,
  p_seasons text[] default null,
  p_years text[] default null,
  p_window_days integer default null,
  p_confidence text[] default null,
  p_min_cycles integer default null,
  p_precision text default null,
  p_locations text[] default null,
  p_listed_now boolean default false,
  p_watched_only boolean default false
)
returns table (
  role_id uuid,
  company_id uuid,
  company_name text,
  canonical_title text,
  discipline text,
  program_type text,
  season text,
  target_year integer,
  location_scope text,
  level text,
  forecastable boolean,
  has_forecast boolean,
  point_date date,
  window_start date,
  window_end date,
  confidence numeric,
  confidence_factors jsonb,
  history_count integer,
  days_until integer,
  exact_events integer,
  bounded_events integer,
  observed_events integer,
  listed_now boolean,
  is_followed boolean,
  search_text text,
  m_query boolean,
  m_discipline boolean,
  m_company boolean,
  m_type boolean,
  m_season boolean,
  m_year boolean,
  m_window boolean,
  m_confidence boolean,
  m_cycles boolean,
  m_precision boolean,
  m_location boolean,
  m_listed boolean,
  m_watched boolean
)
language sql
stable
set search_path = ''
as $$
  select
    f.role_id, f.company_id, f.company_name, f.canonical_title, f.discipline, f.program_type, f.season, f.target_year, f.location_scope, f.level, f.forecastable, f.has_forecast, f.point_date, f.window_start, f.window_end, f.confidence, f.confidence_factors, f.history_count, f.days_until, f.exact_events, f.bounded_events, f.observed_events, f.listed_now, f.is_followed, f.search_text,
    coalesce(btrim(p_query), '') = ''
      or not exists (
        select 1
        from unnest(regexp_split_to_array(lower(btrim(p_query)), '\s+')) as w(word)
        where strpos(f.search_text, w.word) = 0
      ),
    coalesce(cardinality(p_disciplines), 0) = 0 or f.discipline = any(p_disciplines),
    coalesce(cardinality(p_companies), 0) = 0 or f.company_id = any(p_companies),
    coalesce(cardinality(p_types), 0) = 0 or f.program_type = any(p_types),
    coalesce(cardinality(p_seasons), 0) = 0 or f.season = any(p_seasons),
    coalesce(cardinality(p_years), 0) = 0 or coalesce(f.target_year::text, 'unstated') = any(p_years),
    p_window_days is null or (f.forecastable and f.days_until <= p_window_days),
    coalesce(cardinality(p_confidence), 0) = 0
      or (case
        when not f.forecastable then 'none'
        when f.confidence >= 75 then 'strong'
        when f.confidence >= 60 then 'moderate'
        else 'limited'
      end) = any(p_confidence),
    p_min_cycles is null or (f.forecastable and f.history_count >= p_min_cycles),
    p_precision is null
      or case p_precision
        when 'exact' then f.exact_events > 0
        when 'exact_or_bounded' then f.exact_events + f.bounded_events > 0
        when 'observed_only' then f.observed_events > 0 and f.exact_events + f.bounded_events = 0
        when 'none' then f.exact_events + f.bounded_events + f.observed_events = 0
        else true
      end,
    coalesce(cardinality(p_locations), 0) = 0 or f.location_scope = any(p_locations),
    not coalesce(p_listed_now, false) or f.listed_now,
    not coalesce(p_watched_only, false) or f.is_followed
  from public.dashboard_role_facts(p_now, p_user_id) f
$$;

-- ---------------------------------------------------------------------- page

-- One page of matching roles. Sorts: 'window' (soonest forecast first), 'confidence', 'evidence' (cycles behind the
-- forecast, then exact and bounded events), and 'company'. Forecastable roles come before roles without enough
-- history in every sort but 'company', where they come first within each company. A role without enough history is
-- never ordered by the date or confidence of a forecast the dashboard does not show; those follow by company and title.
--
-- `p_per_company` collapses: only a company's first N roles in sort order are listed, and every listed row carries
-- company_rank and company_total, so the card on the Nth row can offer "show all company_total roles". Zero or null
-- lists everything. The summary counts what was collapsed.
create or replace function public.dashboard_role_page(
  p_now timestamptz,
  p_user_id uuid default null,
  p_query text default null,
  p_disciplines text[] default null,
  p_companies uuid[] default null,
  p_types text[] default null,
  p_seasons text[] default null,
  p_years text[] default null,
  p_window_days integer default null,
  p_confidence text[] default null,
  p_min_cycles integer default null,
  p_precision text default null,
  p_locations text[] default null,
  p_listed_now boolean default false,
  p_watched_only boolean default false,
  p_sort text default 'window',
  p_per_company integer default 3,
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  role_id uuid,
  company_id uuid,
  company_name text,
  canonical_title text,
  discipline text,
  program_type text,
  season text,
  target_year integer,
  location_scope text,
  level text,
  forecastable boolean,
  has_forecast boolean,
  point_date date,
  window_start date,
  window_end date,
  confidence numeric,
  confidence_factors jsonb,
  history_count integer,
  days_until integer,
  exact_events integer,
  bounded_events integer,
  observed_events integer,
  listed_now boolean,
  is_followed boolean,
  company_rank integer,
  company_total integer,
  cycles jsonb
)
language sql
stable
set search_path = ''
as $$
  with matching as (
    select *
    from public.dashboard_filtered_roles(p_now, p_user_id, p_query, p_disciplines, p_companies, p_types, p_seasons, p_years, p_window_days, p_confidence, p_min_cycles, p_precision, p_locations, p_listed_now, p_watched_only) f
    where f.m_query and f.m_discipline and f.m_company and f.m_type and f.m_season and f.m_year and f.m_window and f.m_confidence and f.m_cycles and f.m_precision and f.m_location and f.m_listed and f.m_watched
  ),
  ranked as (
    select
      m.*,
      row_number() over (partition by m.company_id order by
    case when p_sort = 'company' then m.company_name end,
    not m.forecastable,
    case when p_sort = 'confidence' and m.forecastable then m.confidence end desc nulls last,
    case when p_sort = 'evidence' and m.forecastable then m.history_count end desc nulls last,
    case when p_sort = 'evidence' then m.exact_events + m.bounded_events end desc,
    case when m.forecastable then m.days_until end nulls last,
    m.company_name,
    m.canonical_title,
    m.role_id
      )::integer as company_rank,
      count(*) over (partition by m.company_id)::integer as company_total
    from matching m
  ),
  page as (
    select *
    from ranked r
    where coalesce(p_per_company, 0) <= 0 or r.company_rank <= p_per_company
    order by
    case when p_sort = 'company' then r.company_name end,
    not r.forecastable,
    case when p_sort = 'confidence' and r.forecastable then r.confidence end desc nulls last,
    case when p_sort = 'evidence' and r.forecastable then r.history_count end desc nulls last,
    case when p_sort = 'evidence' then r.exact_events + r.bounded_events end desc,
    case when r.forecastable then r.days_until end nulls last,
    r.company_name,
    r.canonical_title,
    r.role_id
    limit least(greatest(p_limit, 0), 100)
    offset greatest(p_offset, 0)
  )
  select
    p.role_id, p.company_id, p.company_name, p.canonical_title, p.discipline, p.program_type, p.season, p.target_year, p.location_scope, p.level, p.forecastable, p.has_forecast, p.point_date, p.window_start, p.window_end, p.confidence, p.confidence_factors, p.history_count, p.days_until, p.exact_events, p.bounded_events, p.observed_events, p.listed_now, p.is_followed,
    p.company_rank,
    p.company_total,
    case when p.forecastable then coalesce(cy.cycles, '[]'::jsonb) else '[]'::jsonb end
  from page p
  left join lateral (
    select jsonb_agg(
      jsonb_build_object('opened_on', e.opened_on, 'date_precision', e.date_precision, 'source_type', o.source_type)
      order by e.opened_on, e.id
    ) as cycles
    from public.historical_opening_events e
    left join public.raw_job_observations o on o.id = e.observation_id
    where e.canonical_role_id = p.role_id
  ) cy on true
  order by
    case when p_sort = 'company' then p.company_name end,
    not p.forecastable,
    case when p_sort = 'confidence' and p.forecastable then p.confidence end desc nulls last,
    case when p_sort = 'evidence' and p.forecastable then p.history_count end desc nulls last,
    case when p_sort = 'evidence' then p.exact_events + p.bounded_events end desc,
    case when p.forecastable then p.days_until end nulls last,
    p.company_name,
    p.canonical_title,
    p.role_id
$$;

-- ------------------------------------------------------------------- summary

-- Every count the dashboard states, from the same filters as the page:
--   in_scope_roles / outside_scope_roles   the product scope, and how many collected roles fall outside it
--   matching_*                             what the filters kept, forecastable and not
--   shown_roles / collapsed_*              what the per-company collapse listed and folded
--   exclusions                             per filter: roles it excludes on its own, and roles that would match
--                                          without it (the empty state offers the filter whose removal adds most)
create or replace function public.dashboard_role_summary(
  p_now timestamptz,
  p_user_id uuid default null,
  p_query text default null,
  p_disciplines text[] default null,
  p_companies uuid[] default null,
  p_types text[] default null,
  p_seasons text[] default null,
  p_years text[] default null,
  p_window_days integer default null,
  p_confidence text[] default null,
  p_min_cycles integer default null,
  p_precision text default null,
  p_locations text[] default null,
  p_listed_now boolean default false,
  p_watched_only boolean default false,
  p_per_company integer default 3
)
returns table (
  in_scope_roles bigint,
  outside_scope_roles bigint,
  forecastable_roles bigint,
  insufficient_roles bigint,
  matching_roles bigint,
  matching_forecastable bigint,
  matching_insufficient bigint,
  shown_roles bigint,
  collapsed_roles bigint,
  collapsed_companies bigint,
  opening_within_30_days bigint,
  followed_roles bigint,
  followed_forecastable bigint,
  exclusions jsonb
)
language sql
stable
set search_path = ''
as $$
  with rows as materialized (
    select f.*, f.m_query and f.m_discipline and f.m_company and f.m_type and f.m_season and f.m_year and f.m_window and f.m_confidence and f.m_cycles and f.m_precision and f.m_location and f.m_listed and f.m_watched as matches
    from public.dashboard_filtered_roles(p_now, p_user_id, p_query, p_disciplines, p_companies, p_types, p_seasons, p_years, p_window_days, p_confidence, p_min_cycles, p_precision, p_locations, p_listed_now, p_watched_only) f
  ),
  per_company as (
    select r.company_id, count(*) as n
    from rows r
    where r.matches
    group by r.company_id
  )
  select
    (select count(*) from rows),
    (select count(*) from public.canonical_roles c where c.active and c.scope_status is distinct from 'in_scope'),
    (select count(*) from rows where forecastable),
    (select count(*) from rows where not forecastable),
    (select count(*) from rows where matches),
    (select count(*) from rows where matches and forecastable),
    (select count(*) from rows where matches and not forecastable),
    (select coalesce(sum(case when coalesce(p_per_company, 0) <= 0 then n else least(n, p_per_company) end), 0) from per_company)::bigint,
    (select coalesce(sum(case when coalesce(p_per_company, 0) <= 0 then 0 else greatest(n - p_per_company, 0) end), 0) from per_company)::bigint,
    (select count(*) from per_company where coalesce(p_per_company, 0) > 0 and n > p_per_company),
    (select count(*) from rows where matches and forecastable and days_until <= 30),
    (select count(*) from rows where is_followed),
    (select count(*) from rows where is_followed and forecastable),
    (select jsonb_build_object(
        'query', jsonb_build_object('excluded', count(*) filter (where not f.m_query), 'without', count(*) filter (where f.m_discipline and f.m_company and f.m_type and f.m_season and f.m_year and f.m_window and f.m_confidence and f.m_cycles and f.m_precision and f.m_location and f.m_listed and f.m_watched)),
        'discipline', jsonb_build_object('excluded', count(*) filter (where not f.m_discipline), 'without', count(*) filter (where f.m_query and f.m_company and f.m_type and f.m_season and f.m_year and f.m_window and f.m_confidence and f.m_cycles and f.m_precision and f.m_location and f.m_listed and f.m_watched)),
        'company', jsonb_build_object('excluded', count(*) filter (where not f.m_company), 'without', count(*) filter (where f.m_query and f.m_discipline and f.m_type and f.m_season and f.m_year and f.m_window and f.m_confidence and f.m_cycles and f.m_precision and f.m_location and f.m_listed and f.m_watched)),
        'type', jsonb_build_object('excluded', count(*) filter (where not f.m_type), 'without', count(*) filter (where f.m_query and f.m_discipline and f.m_company and f.m_season and f.m_year and f.m_window and f.m_confidence and f.m_cycles and f.m_precision and f.m_location and f.m_listed and f.m_watched)),
        'season', jsonb_build_object('excluded', count(*) filter (where not f.m_season), 'without', count(*) filter (where f.m_query and f.m_discipline and f.m_company and f.m_type and f.m_year and f.m_window and f.m_confidence and f.m_cycles and f.m_precision and f.m_location and f.m_listed and f.m_watched)),
        'year', jsonb_build_object('excluded', count(*) filter (where not f.m_year), 'without', count(*) filter (where f.m_query and f.m_discipline and f.m_company and f.m_type and f.m_season and f.m_window and f.m_confidence and f.m_cycles and f.m_precision and f.m_location and f.m_listed and f.m_watched)),
        'window', jsonb_build_object('excluded', count(*) filter (where not f.m_window), 'without', count(*) filter (where f.m_query and f.m_discipline and f.m_company and f.m_type and f.m_season and f.m_year and f.m_confidence and f.m_cycles and f.m_precision and f.m_location and f.m_listed and f.m_watched)),
        'confidence', jsonb_build_object('excluded', count(*) filter (where not f.m_confidence), 'without', count(*) filter (where f.m_query and f.m_discipline and f.m_company and f.m_type and f.m_season and f.m_year and f.m_window and f.m_cycles and f.m_precision and f.m_location and f.m_listed and f.m_watched)),
        'cycles', jsonb_build_object('excluded', count(*) filter (where not f.m_cycles), 'without', count(*) filter (where f.m_query and f.m_discipline and f.m_company and f.m_type and f.m_season and f.m_year and f.m_window and f.m_confidence and f.m_precision and f.m_location and f.m_listed and f.m_watched)),
        'precision', jsonb_build_object('excluded', count(*) filter (where not f.m_precision), 'without', count(*) filter (where f.m_query and f.m_discipline and f.m_company and f.m_type and f.m_season and f.m_year and f.m_window and f.m_confidence and f.m_cycles and f.m_location and f.m_listed and f.m_watched)),
        'location', jsonb_build_object('excluded', count(*) filter (where not f.m_location), 'without', count(*) filter (where f.m_query and f.m_discipline and f.m_company and f.m_type and f.m_season and f.m_year and f.m_window and f.m_confidence and f.m_cycles and f.m_precision and f.m_listed and f.m_watched)),
        'listed', jsonb_build_object('excluded', count(*) filter (where not f.m_listed), 'without', count(*) filter (where f.m_query and f.m_discipline and f.m_company and f.m_type and f.m_season and f.m_year and f.m_window and f.m_confidence and f.m_cycles and f.m_precision and f.m_location and f.m_watched)),
        'watched', jsonb_build_object('excluded', count(*) filter (where not f.m_watched), 'without', count(*) filter (where f.m_query and f.m_discipline and f.m_company and f.m_type and f.m_season and f.m_year and f.m_window and f.m_confidence and f.m_cycles and f.m_precision and f.m_location and f.m_listed))
      )
      from rows f)
$$;

-- ------------------------------------------------------------------- options

-- The values each filter offers, with in-scope role counts, read from the role and alias tables directly.
create or replace function public.dashboard_filter_options()
returns table (facet text, value text, label text, roles bigint)
language sql
stable
set search_path = ''
as $$
  with roles as (
    select
      r.id,
      r.company_id,
      c.name as company_name,
      r.discipline::text as discipline,
      r.early_career_type::text as program_type,
      coalesce(nullif(r.recruiting_season, ''), 'unknown') as season,
      coalesce(nullif(r.location_scope, ''), 'unspecified') as location_scope,
      (
        select max((regexp_match(a.alias_title, '(?:^|[^0-9])(20[2-9][0-9])(?:[^0-9]|$)'))[1]::integer)
        from public.role_aliases a
        where a.canonical_role_id = r.id
      ) as target_year
    from public.canonical_roles r
    join public.companies c on c.id = r.company_id
    where r.scope_status = 'in_scope'
  )
  select 'discipline', discipline, discipline, count(*) from roles group by discipline
  union all
  select 'type', program_type, program_type, count(*) from roles group by program_type
  union all
  select 'season', season, season, count(*) from roles group by season
  union all
  select 'year', coalesce(target_year::text, 'unstated'), coalesce(target_year::text, 'unstated'), count(*) from roles group by target_year
  union all
  select 'company', company_id::text, company_name, count(*) from roles group by company_id, company_name
  union all
  select 'location', location_scope, location_scope, count(*) from roles group by location_scope
$$;

-- --------------------------------------------------------------- replaced

drop function if exists public.dashboard_forecast_page(timestamptz, uuid, text, text, boolean, integer, integer);
drop function if exists public.dashboard_summary(timestamptz, uuid, text, text, boolean);
drop function if exists public.dashboard_insufficient_roles(timestamptz, uuid, boolean, integer);
drop function if exists public.dashboard_role_matches(text, text, text, text, text);

-- --------------------------------------------------------------------- access

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.forecast_role_states(timestamptz)',
    'public.dashboard_role_facts(timestamptz, uuid)',
    'public.dashboard_filtered_roles(timestamptz, uuid, text, text[], uuid[], text[], text[], text[], integer, text[], integer, text, text[], boolean, boolean)',
    'public.dashboard_role_page(timestamptz, uuid, text, text[], uuid[], text[], text[], text[], integer, text[], integer, text, text[], boolean, boolean, text, integer, integer, integer)',
    'public.dashboard_role_summary(timestamptz, uuid, text, text[], uuid[], text[], text[], text[], integer, text[], integer, text, text[], boolean, boolean, integer)',
    'public.dashboard_filter_options()'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end
$$;

comment on function public.dashboard_role_page(timestamptz, uuid, text, text[], uuid[], text[], text[], text[], integer, text[], integer, text, text[], boolean, boolean, text, integer, integer, integer) is
  'Service-only. One page of in-scope roles matching the dashboard filters, collapsed per company.';
comment on function public.dashboard_role_summary(timestamptz, uuid, text, text[], uuid[], text[], text[], text[], integer, text[], integer, text, text[], boolean, boolean, integer) is
  'Service-only. The dashboard''s counts and per-filter exclusions for the same filters as dashboard_role_page.';
