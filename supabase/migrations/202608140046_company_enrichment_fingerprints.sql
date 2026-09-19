-- A fingerprint of everything enrichment reads for a company, so a company whose evidence has not changed is not
-- re-read and re-derived on every collection run.
--
-- Enrichment (worker/src/firstseen/enrichment.py and enrichment_session.py) resolves a company's new observations into
-- roles, reconstructs every role's opening history, and classifies scope, reading the company's observations, matches,
-- roles, aliases, opening events, archive captures, and scope reviews. Each current-jobs run did that for every company,
-- about 45 MB of Supabase egress over the corpus, though most companies had nothing new. The worker now keeps, per
-- company, the fingerprint of the last pass that changed nothing (collection_checkpoints, pipeline
-- `enrichment_fingerprints`), and skips a company whose inputs still have that fingerprint: a deterministic pass over
-- the same inputs changes nothing again. This function computes the fingerprint in the database, so only a 32-character
-- hash per company crosses the wire.
--
-- It covers what enrichment reads and nothing that changes without changing its result: source ids (not their fetch
-- times or page hashes), the latest fetch status of sources with archive captures (a degraded one demotes its
-- captures), every observation of the company's sources or matched to its roles except when it was last seen, every
-- match of those observations or roles, the company's roles except timestamps, forecast refusals, and embeddings
-- (written by forecasting, never read here), their aliases, opening events except when they became available, the
-- archive captures of the company's sources, and its roles' scope reviews. A column added to any of these later is
-- covered by default, which can only make a company re-run, never skip wrongly.

create or replace function public.company_enrichment_fingerprints(p_company_ids uuid[])
returns table (company_id uuid, fingerprint text)
language sql
stable
set search_path = ''
as $$
  select c.id,
         md5(jsonb_build_array(
           c.name, f.sources, f.fetches, f.observations, f.matches, f.roles, f.aliases, f.events, f.captures, f.reviews
         )::text)
  from public.companies c
  cross join lateral (
    with company_sources as (
      select s.id from public.sources s where s.company_id = c.id
    ),
    company_roles as (
      select r.id from public.canonical_roles r where r.company_id = c.id
    ),
    company_observations as (
      select o.id from public.raw_job_observations o where o.source_id in (select id from company_sources)
      union
      select m.observation_id from public.observation_role_matches m
      where m.canonical_role_id in (select id from company_roles)
    )
    select
      (select md5(coalesce(string_agg(s.id::text, ',' order by s.id), '')) from company_sources s) as sources,
      (select md5(coalesce(string_agg(l.source_id::text || ':' || coalesce(l.error ->> 'status', ''), ','
                                      order by l.source_id), ''))
         from public.latest_source_fetch_errors(array(
           select s.id from company_sources s
           where exists (select 1 from public.archive_captures a where a.source_id = s.id)
         )) l) as fetches,
      (select md5(coalesce(string_agg(md5(jsonb_build_array(
                o.id, o.source_id, o.external_job_id, o.identity_key, o.source_url, o.apply_url, o.raw_title,
                o.company_name, o.location, o.employment_type, o.published_at, o.first_seen_at, o.content_hash,
                o.source_type, o.source_reliability, o.extraction_method, md5(coalesce(o.evidence_excerpt, '')),
                o.raw_payload, o.archive_capture_at, o.archive_url, o.archive_original_url, o.archive_digest
              )::text), ',' order by o.id), ''))
         from public.raw_job_observations o where o.id in (select id from company_observations)) as observations,
      (select md5(coalesce(string_agg(md5(to_jsonb(m)::text), ',' order by m.observation_id, m.canonical_role_id), ''))
         from public.observation_role_matches m
         where m.observation_id in (select id from company_observations)
            or m.canonical_role_id in (select id from company_roles)) as matches,
      (select md5(coalesce(string_agg(md5((to_jsonb(r) - 'created_at' - 'updated_at' - 'scope_classified_at'
                - 'forecast_refused_at' - 'forecast_refusal_reason' - 'description_embedding')::text), ',' order by r.id), ''))
         from public.canonical_roles r where r.company_id = c.id) as roles,
      (select md5(coalesce(string_agg(md5((to_jsonb(a) - 'created_at' - 'updated_at')::text), ',' order by a.id), ''))
         from public.role_aliases a where a.canonical_role_id in (select id from company_roles)) as aliases,
      (select md5(coalesce(string_agg(md5((to_jsonb(e) - 'created_at' - 'available_at' - 'verified_at')::text), ','
                                      order by e.id), ''))
         from public.historical_opening_events e where e.canonical_role_id in (select id from company_roles)) as events,
      (select md5(coalesce(string_agg(md5((to_jsonb(a) - 'created_at')::text), ',' order by a.id), ''))
         from public.archive_captures a where a.source_id in (select id from company_sources)) as captures,
      (select md5(coalesce(string_agg(md5(to_jsonb(v)::text), ',' order by v.id), ''))
         from public.role_scope_reviews v where v.canonical_role_id in (select id from company_roles)) as reviews
  ) f
  where c.id = any(p_company_ids)
$$;

revoke all on function public.company_enrichment_fingerprints(uuid[]) from public, anon, authenticated;
grant execute on function public.company_enrichment_fingerprints(uuid[]) to service_role;
