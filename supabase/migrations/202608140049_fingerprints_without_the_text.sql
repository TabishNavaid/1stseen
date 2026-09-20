-- The enrichment fingerprint hashes what summarises each row, not the row's whole text.
--
-- Migration 046 hashed `to_jsonb(row)` of every observation, role, event and capture a company has, which serialises
-- and digests the posting text, description prototypes, opening quotes and archived page text: about 170 MB across the
-- corpus. Measured on hosted on 2026-09-20, one company (Notion: 1,622 observations, 588 roles, 1,560 events) took
-- 8,890 ms and all eighty took 89,564 ms. PostgREST connects as `authenticator` with `statement_timeout=8s` and the
-- worker asks ten companies a call, so every call timed out. The worker treats that as "no fingerprint", so **no
-- company was ever skipped**: a run that had 591 new observations across eighty companies re-derived all eighty,
-- which is most of why a run took 26 minutes and downloaded 58 MB.
--
-- What is hashed instead, column by column, is every column enrichment reads, except where a column is covered by a
-- digest the row already carries. Each exception is named below as `excluded:`, and
-- `worker/tests/test_enrichment_fingerprint.py` fails if a column enrichment reads is neither hashed here nor excluded
-- here, so a column added to one of these reads cannot quietly stop being covered.
--
-- excluded: raw_job_observations.evidence_excerpt -- content_hash digests the posting's text along with its title,
--   company, location, employment type, URLs, publication date and capture time (adapters/base.py, build_observation),
--   so it moves whenever any of them moves. This is the column the trim shortens, and a trim deliberately does not
--   make a company look changed: the derivations already stored from the longer text stand.
-- excluded: raw_job_observations.raw_payload -- enrichment reads one path out of it, `ats_categories`, for scope; that
--   path is hashed on its own and the rest of the payload is never read.
-- The columns content_hash is built from are not hashed again beside it. `build_observation` (adapters/base.py) digests
-- the title, company, location, employment type, source and apply URLs, publication date, posting text and archive
-- capture time into content_hash, so any change to one of them moves it:
-- excluded: raw_job_observations.raw_title -- one of the columns content_hash is built from.
-- excluded: raw_job_observations.company_name -- one of the columns content_hash is built from.
-- excluded: raw_job_observations.location -- one of the columns content_hash is built from.
-- excluded: raw_job_observations.employment_type -- one of the columns content_hash is built from.
-- excluded: raw_job_observations.source_url -- one of the columns content_hash is built from.
-- excluded: raw_job_observations.apply_url -- one of the columns content_hash is built from.
-- excluded: raw_job_observations.published_at -- one of the columns content_hash is built from.
-- excluded: raw_job_observations.archive_capture_at -- one of the columns content_hash is built from.
-- excluded: raw_job_observations.last_seen_at -- when a posting was last seen again is not an input to any decision,
--   and it changes on every run that sees it.
-- excluded: canonical_roles.description_prototype -- a role's prototype is written only by a resolution, which also
--   writes that observation's match and the role's alias, both hashed here.
-- excluded: historical_opening_events.evidence_quote -- a stored event keeps the quote it was created with
--   (IntelligenceRepository.event_payloads), so the quote cannot change without the event being new.
-- excluded: archive_captures.evidence_excerpt -- content_hash and meaningful_hash digest the archived page this text
--   comes from, and both are hashed here.
-- excluded: archive_captures.detected_titles -- read from the same archived page, digested by the same two hashes.
-- excluded: raw_job_observations.raw_text -- the fetched page or payload as retrieved, which content_hash digests and
--   enrichment never reads; hashing it was most of what made 046 time out.
-- excluded: raw_job_observations.embedding -- written by forecasting, never read here.
-- excluded: raw_job_observations.http_status -- the fetch's status, not an input to a decision.
-- excluded: raw_job_observations.observed_at -- when the posting was last observed, which moves on every run.
-- excluded: raw_job_observations.fetched_at -- when its source was fetched, which moves on every run.
-- excluded: raw_job_observations.created_at -- when the row was written, which cannot change.
-- excluded: observation_role_matches.feature_scores -- written by a resolution together with the decision columns
--   hashed here, and never read by enrichment.
-- excluded: observation_role_matches.reasons -- written by a resolution together with the decision columns hashed
--   here, and never read by enrichment.
-- excluded: observation_role_matches.evidence -- written by a resolution together with the decision columns hashed
--   here, and never read by enrichment.
-- excluded: observation_role_matches.created_at -- when the row was written, which cannot change.
-- excluded: canonical_roles.description_embedding -- written by forecasting, never read here.
-- excluded: canonical_roles.forecast_refused_at -- written by forecasting, never read here.
-- excluded: canonical_roles.forecast_refusal_reason -- written by forecasting, never read here.
-- excluded: canonical_roles.created_at -- when the row was written, which cannot change.
-- excluded: canonical_roles.updated_at -- a clock the row's own trigger moves, so it changes on a write that
--   changed nothing a decision reads.
-- excluded: canonical_roles.scope_classified_at -- when the role was last classified, which every pass moves even
--   when the verdict it wrote is the same one.
-- excluded: role_aliases.created_at -- when the row was written, which cannot change.
-- excluded: role_aliases.updated_at -- a clock the row's own trigger moves, not something a decision reads.
-- excluded: historical_opening_events.created_at -- when the row was written, which cannot change.
-- excluded: historical_opening_events.verified_at -- when the opening was last verified, which moves without the
--   opening itself changing.
-- excluded: historical_opening_events.available_at -- when the event became available to read, which 046 also left
--   out for the same reason: it moves without the opening changing.
-- excluded: archive_captures.created_at -- when the row was written, which cannot change.

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

revoke all on function public.company_enrichment_fingerprints(uuid[]) from public, anon, authenticated;
grant execute on function public.company_enrichment_fingerprints(uuid[]) to service_role;
