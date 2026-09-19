-- Writes and one lookup the collectors send once per batch instead of once per row.
--
-- The worker reached the database once or several times for every observation it collected or resolved: an existence
-- check and a write per posting, five requests per role decision, four per role in history reconstruction, and one per
-- scope decision and per source's latest fetch. From a runner a region away each request costs a round trip, so a full
-- pass measured about 1.35 observations a second against the hosted project. worker/src/firstseen/enrichment_session.py
-- now reads a company's evidence once and sends its decisions in bulk. Most of those writes are plain bulk inserts and
-- upserts through PostgREST; these three functions are the ones PostgREST cannot express as one request:
--
--   touch_job_observations   an unchanged posting keeps its title, text, and dates and records only that it was seen
--                            again (and its ATS categories), so it is an update of three columns, per row
--   save_role_scopes         a scope decision updates only the scope columns of a role that already exists
--   latest_source_fetch_errors  each source's newest fetch, which decides whether its archive evidence is degraded
--
-- Each takes the rows as JSON and types them by the table's own row type, so an enum column receives its enum. They
-- are service-only, like every function the worker calls.

create or replace function public.touch_job_observations(p_rows jsonb)
returns integer
language sql
set search_path = ''
as $$
  -- raw_payload is written only when the row carries one (a posting whose board files it under ATS categories).
  with touched as (
    update public.raw_job_observations r
    set last_seen_at = x.last_seen_at,
        observed_at = x.observed_at,
        raw_payload = coalesce(x.raw_payload, r.raw_payload)
    from jsonb_populate_recordset(null::public.raw_job_observations, p_rows) as x
    where r.id = x.id
    returning 1
  )
  select count(*)::integer from touched
$$;

create or replace function public.save_role_scopes(p_rows jsonb)
returns integer
language sql
set search_path = ''
as $$
  with saved as (
    update public.canonical_roles r
    set scope_status = x.scope_status,
        scope_reason = x.scope_reason,
        discipline = x.discipline,
        early_career_type = x.early_career_type,
        scope_evidence = x.scope_evidence,
        scope_method = x.scope_method,
        scope_classifier_version = x.scope_classifier_version,
        scope_classified_at = x.scope_classified_at
    from jsonb_populate_recordset(null::public.canonical_roles, p_rows) as x
    where r.id = x.id
    returning 1
  )
  select count(*)::integer from saved
$$;

create or replace function public.latest_source_fetch_errors(p_source_ids uuid[])
returns table (source_id uuid, error jsonb)
language sql
stable
set search_path = ''
as $$
  -- One row per source that has been fetched: its newest fetch, the id breaking a tie on fetched_at.
  select distinct on (f.source_id) f.source_id, f.error
  from public.source_fetches f
  where f.source_id = any(p_source_ids)
  order by f.source_id, f.fetched_at desc, f.id desc
$$;

revoke all on function public.touch_job_observations(jsonb) from public, anon, authenticated;
revoke all on function public.save_role_scopes(jsonb) from public, anon, authenticated;
revoke all on function public.latest_source_fetch_errors(uuid[]) from public, anon, authenticated;
grant execute on function public.touch_job_observations(jsonb) to service_role;
grant execute on function public.save_role_scopes(jsonb) to service_role;
grant execute on function public.latest_source_fetch_errors(uuid[]) to service_role;
