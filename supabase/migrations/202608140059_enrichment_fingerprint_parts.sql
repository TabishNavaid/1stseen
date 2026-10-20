-- The enrichment fingerprint says which part of itself moved, so a run answers why a company was re-enriched.
--
-- company_enrichment_fingerprints (defined by migration 202608140046, rewritten column by column by 202608140049)
-- returns one hash per company. When it differs from the company's stored no-op key the worker re-enriches, which is
-- correct, but the run could not say what differed. On 2026-10-20 that cost a day: four completed collection runs
-- each reported companies_unchanged = 0 of 80, and nothing in the record distinguished "a new posting arrived" from
-- "a sitemap emitted a diagnostic again", so the two had to be argued about instead of read. This returns the same
-- combined fingerprint alongside the component hashes it is built from, and the worker stores the components beside
-- the key, so the next run names the component that moved and counts it.
--
-- The body below is 202608140049's, unchanged, with the component hashes also returned. The combined fingerprint is
-- built from exactly the values in `parts`, by the same expression in the same order, so it is the same string that
-- function already returns: every company's stored no-op key stays valid and no convergence is discarded by
-- deploying this. `worker/tests/test_enrichment_fingerprint.py` holds the column coverage this inherits.
--
-- `parts` holds hashes only, never the underlying text: the company name is md5'd like the rest, so the object is
-- uniform and a checkpoint never carries product data.

create or replace function public.company_enrichment_fingerprint_parts(p_company_ids uuid[])
returns table (company_id uuid, fingerprint text, parts jsonb)
language sql
stable
set search_path = ''
as $$
  select c.id,
         md5(jsonb_build_array(
           c.name, f.sources, f.fetches, f.observations, f.matches, f.roles, f.aliases, f.events, f.captures, f.reviews
         )::text),
         jsonb_build_object(
           'name', md5(c.name),
           'sources', f.sources,
           'fetches', f.fetches,
           'observations', f.observations,
           'matches', f.matches,
           'roles', f.roles,
           'aliases', f.aliases,
           'events', f.events,
           'captures', f.captures,
           'reviews', f.reviews
         )
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
         from (
           select distinct on (t.source_id) t.source_id, t.error
             from public.source_fetches t
            where t.source_id in (select id from company_sources)
            order by t.source_id, t.fetched_at desc, t.id desc
         ) l) as fetches,
      (select md5(coalesce(string_agg(
                 o.id::text || '|' || coalesce(o.source_id::text, '') || '|' || coalesce(o.identity_key::text, '')
                 || '|' || coalesce(o.content_hash::text, '') || '|' || coalesce(o.external_job_id::text, '')
                 || '|' || coalesce(o.first_seen_at::text, '') || '|' || coalesce(o.source_type::text, '')
                 || '|' || coalesce(o.extraction_method::text, '') || '|' || coalesce(o.source_reliability::text, '')
                 || '|' || coalesce(o.archive_url::text, '') || '|' || coalesce(o.archive_original_url::text, '')
                 || '|' || coalesce(o.archive_digest::text, '')
                 || '|' || coalesce(o.raw_payload -> 'ats_categories' #>> '{}', ''),
                 ',' order by o.id), ''))
         from public.raw_job_observations o
        where o.id in (select id from company_observations)) as observations,
      (select md5(coalesce(string_agg(
                 m.observation_id::text || '|' || m.canonical_role_id::text || '|' || m.is_primary::text
                 || '|' || coalesce(m.decision::text, '') || '|' || coalesce(m.match_confidence::text, '')
                 || '|' || coalesce(m.evidence_kind::text, '') || '|' || coalesce(m.resolver_version::text, '')
                 || '|' || coalesce(m.used_embedding::text, '') || '|' || coalesce(m.used_llm::text, '')
                 || '|' || coalesce(m.inference_decision::text, ''),
                 ',' order by m.observation_id, m.canonical_role_id), ''))
         from public.observation_role_matches m
        where m.observation_id in (select id from company_observations)
           or m.canonical_role_id in (select id from company_roles)) as matches,
      (select md5(coalesce(string_agg(
                 r.id::text || '|' || coalesce(r.company_normalized::text, '') || '|' || coalesce(r.canonical_title::text, '')
                 || '|' || coalesce(r.recurrence_key::text, '') || '|' || coalesce(r.normalized_title::text, '')
                 || '|' || coalesce(r.role_family::text, '') || '|' || coalesce(r.level::text, '')
                 || '|' || coalesce(r.recruiting_season::text, '') || '|' || coalesce(r.specialization::text, '')
                 || '|' || coalesce(r.feature_profile::text, '') || '|' || r.active::text
                 || '|' || coalesce(r.scope_status::text, '') || '|' || coalesce(r.scope_reason::text, '')
                 || '|' || coalesce(r.discipline::text, '') || '|' || coalesce(r.early_career_type::text, '')
                 || '|' || coalesce(r.scope_method::text, '') || '|' || coalesce(r.scope_classifier_version::text, '')
                 || '|' || coalesce(r.scope_evidence::text, '') || '|' || coalesce(r.track::text, '')
                 || '|' || coalesce(r.location_scope::text, '') || '|' || coalesce(r.resolver_version::text, '')
                 || '|' || coalesce(r.superseded_by::text, '') || '|' || coalesce(r.superseded_at::text, ''),
                 ',' order by r.id), ''))
         from public.canonical_roles r where r.company_id = c.id) as roles,
      (select md5(coalesce(string_agg(
                 a.id::text || '|' || a.canonical_role_id::text || '|' || coalesce(a.alias_title::text, '')
                 || '|' || coalesce(a.normalized_alias::text, '') || '|' || coalesce(a.first_observation_id::text, '')
                 || '|' || coalesce(a.last_observation_id::text, '') || '|' || coalesce(a.first_seen_at::text, '')
                 || '|' || coalesce(a.last_seen_at::text, '') || '|' || coalesce(a.match_confidence::text, '')
                 || '|' || coalesce(a.match_evidence::text, '') || '|' || coalesce(a.resolver_version::text, ''),
                 ',' order by a.id), ''))
         from public.role_aliases a
        where a.canonical_role_id in (select id from company_roles)) as aliases,
      (select md5(coalesce(string_agg(
                 e.id::text || '|' || e.canonical_role_id::text || '|' || coalesce(e.observation_id::text, '')
                 || '|' || coalesce(e.opened_on::text, '') || '|' || coalesce(e.closed_on::text, '')
                 || '|' || coalesce(e.source_quality::text, '') || '|' || coalesce(e.opening_window_start::text, '')
                 || '|' || coalesce(e.opening_window_end::text, '') || '|' || coalesce(e.date_precision::text, '')
                 || '|' || coalesce(e.uncertainty_days::text, '') || '|' || coalesce(e.uncertainty_reason::text, '')
                 || '|' || coalesce(e.resolution_method::text, '') || '|' || coalesce(e.extraction_version::text, '')
                 || '|' || coalesce(e.provenance::text, ''),
                 ',' order by e.id), ''))
         from public.historical_opening_events e
        where e.canonical_role_id in (select id from company_roles)) as events,
      (select md5(coalesce(string_agg(
                 p.id::text || '|' || p.source_id::text || '|' || p.observation_id::text
                 || '|' || coalesce(p.original_url::text, '') || '|' || coalesce(p.archive_url::text, '')
                 || '|' || coalesce(p.captured_at::text, '') || '|' || coalesce(p.status_code::text, '')
                 || '|' || coalesce(p.redirect_url::text, '') || '|' || coalesce(p.archive_digest::text, '')
                 || '|' || coalesce(p.content_hash::text, '') || '|' || coalesce(p.meaningful_hash::text, '')
                 || '|' || coalesce(p.change_kind::text, '') || '|' || coalesce(p.completeness::text, '')
                 || '|' || p.is_partial::text,
                 ',' order by p.id), ''))
         from public.archive_captures p
        where p.source_id in (select id from company_sources)) as captures,
      (select md5(coalesce(string_agg(md5(to_jsonb(v)::text), ',' order by v.id), ''))
         from public.role_scope_reviews v
        where v.canonical_role_id in (select id from company_roles)) as reviews
  ) f
  where c.id = any(p_company_ids);
$$;

-- One definition of the components, not two. company_enrichment_fingerprints (migrations 202608140046 and
-- 202608140049) now selects from the function above instead of repeating its body, so the combined fingerprint
-- and the component hashes cannot drift apart: a column added to one is added to both. The fingerprint it
-- returns is unchanged, so every company's stored no-op key stays valid.
create or replace function public.company_enrichment_fingerprints(p_company_ids uuid[])
returns table (company_id uuid, fingerprint text)
language sql
stable
set search_path = ''
as $$
  select p.company_id, p.fingerprint from public.company_enrichment_fingerprint_parts(p_company_ids) p;
$$;

comment on function public.company_enrichment_fingerprint_parts(uuid[]) is
  'The enrichment input fingerprint and the component hashes it is built from, so a run can name which component moved.';

revoke all on function public.company_enrichment_fingerprint_parts(uuid[]) from public, anon, authenticated;
grant execute on function public.company_enrichment_fingerprint_parts(uuid[]) to service_role;
revoke all on function public.company_enrichment_fingerprints(uuid[]) from public, anon, authenticated;
grant execute on function public.company_enrichment_fingerprints(uuid[]) to service_role;
