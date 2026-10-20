-- The enrichment fingerprint holds each source's degraded verdict, not the text of its latest fetch status.
--
-- `fetches` existed because a degraded source demotes its archive captures: the resolver may then prove a role was
-- present but never that it was absent, so a degradation has to re-run enrichment. The column it hashed was the
-- status text, and `error ->> 'status'` takes three values -- null when the fetch was complete with no diagnostics,
-- 'complete' when it was complete and emitted one, and 'degraded' when it was not complete. Enrichment reads exactly
-- one thing from it: `status = 'degraded'` (IntelligenceRepository.degraded_among). The gap between null and
-- 'complete' is therefore invisible to every decision enrichment makes, and it moved the fingerprint anyway.
--
-- Measured on the real schema on 2026-10-20: a source fetched twice, same content, complete both times, with one
-- diagnostic on the second, moved `fetches` from abc131da33c12c38edffdf42e5f8a6b5 to
-- cdbfdd869fc1c08f2547b12673292da8 and the company's fingerprint from 774cf4b106551752ab3ccc38ab15011b to
-- 696d7e8e0104a9624abc37ac4a0f3de8, while the degraded verdict stayed 0. That invalidates the company's stored no-op
-- key, so the whole company is re-enriched because a sitemap hit its limit again. The hash covers every source of
-- the company, so one flaky source among a company's many defeats its skip on every run, however unchanged its
-- content is -- which is 0 of 80 companies skipped, at any commit, for as long as anything flaps.
--
-- Hashing the verdict keeps what the component is for. A source going degraded, or recovering, still moves it, and
-- `worker/tests/test_enrichment_fingerprint_parts.py` pins both halves: plumbing does not move it, degradation does.
--
-- This does change every company's fingerprint, so every stored no-op key is invalidated once and the next run
-- re-enriches all eighty. That is one pass, after which the skip can hold for the first time.
--
-- Only the parts function is redefined: company_enrichment_fingerprints selects from it (migration 202608140059),
-- so it follows without being restated.

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
      (select md5(coalesce(string_agg(l.source_id::text || ':' || coalesce(l.error ->> 'status' = 'degraded', false)::text, ','
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

revoke all on function public.company_enrichment_fingerprint_parts(uuid[]) from public, anon, authenticated;
grant execute on function public.company_enrichment_fingerprint_parts(uuid[]) to service_role;
