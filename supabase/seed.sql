-- Local-only fixtures. Reserved .example domains prevent these records from being mistaken for live evidence.
-- Gmail connections and email deliveries are intentionally not seeded: both require a real auth user,
-- explicit OAuth consent, and an explicit send action. The web preview uses labeled fixture records.
-- Scheduled collection checkpoints are also intentionally empty so the first deployed run evaluates all
-- persisted changed-source evidence and establishes its own successful cursor.
insert into public.companies (id, name, domain, careers_url, is_fixture, metadata) values
  ('00000000-0000-4000-8000-000000000001', 'Northstar Systems', 'northstar.example', 'https://careers.northstar.example/students', true, '{"fixture":true,"company_size":"enterprise","recruiting_scale":0.75}'),
  ('00000000-0000-4000-8000-000000000002', 'Meridian Labs', 'meridian.example', 'https://jobs.meridian.example/early-career', true, '{"fixture":true,"company_size":"large","recruiting_scale":0.65}'),
  ('00000000-0000-4000-8000-000000000003', 'Atlas Analytics', 'atlas.example', 'https://atlas.example/careers', true, '{"fixture":true,"company_size":"small","recruiting_scale":0.30}')
on conflict (id) do nothing;

insert into public.sources (
  id, company_id, url, kind, adapter, trust_score, enabled, metadata
) values (
  '00000000-0000-4000-8000-000000000701',
  '00000000-0000-4000-8000-000000000001',
  'https://careers.northstar.example/students',
  'archive',
  'wayback',
  0.850,
  false,
  '{"fixture":true,"options":{"include_subpaths":true,"from":2022,"to":2025}}'
)
on conflict (id) do nothing;

insert into public.canonical_roles (
  id, company_id, canonical_title, track, location_scope, recurrence_key,
  company_normalized, normalized_title, role_family, level, recruiting_season,
  feature_profile, description_prototype, resolver_version
) values
  ('00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000001', 'Software Engineering Intern', 'internship', 'united_states', 'software_engineering_intern_us', 'northstar systems', 'software engineer intern', 'software_engineering', 'internship', 'fall', '{"fixture":true,"normalized_title":"software engineer intern","level":"internship","role_family":"software_engineering","specialization":null,"recruiting_season":"fall","location_scope":"united_states","role_competitiveness":0.90,"portfolio_required":true,"description_fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}', 'Annual student software engineering program with mentored production projects.', 'hybrid-role-resolver-v1'),
  ('00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000002', 'Associate Product Manager', 'new_grad', 'new york', 'associate_product_manager_ny', 'meridian labs', 'associate product manager', 'product_management', 'new_grad', 'unknown', '{"fixture":true,"normalized_title":"associate product manager","level":"new_grad","role_family":"product_management","specialization":null,"recruiting_season":"unknown","location_scope":"new york","description_fingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}', 'Annual associate product manager program for new graduates.', 'hybrid-role-resolver-v1'),
  ('00000000-0000-4000-8000-000000000013', '00000000-0000-4000-8000-000000000003', 'Data Science Intern', 'internship', 'remote', 'data_science_intern_us_remote', 'atlas analytics', 'data science intern', 'data_science', 'internship', 'summer', '{"fixture":true,"normalized_title":"data science intern","level":"internship","role_family":"data_science","specialization":null,"recruiting_season":"summer","location_scope":"remote","description_fingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}', 'Annual remote data science internship using statistical modeling and experimentation.', 'hybrid-role-resolver-v1')
on conflict (id) do nothing;

insert into public.sources (id, company_id, url, kind, adapter, trust_score, metadata) values
  ('00000000-0000-4000-8000-000000000101', '00000000-0000-4000-8000-000000000001', 'https://careers.northstar.example/students', 'program_page', 'generic', 0.950, '{"fixture":true,"options":{"allow_browser":false,"allow_llm":false}}'),
  ('00000000-0000-4000-8000-000000000102', '00000000-0000-4000-8000-000000000002', 'https://jobs.meridian.example/early-career', 'ats', 'generic', 0.900, '{"fixture":true,"options":{"allow_browser":false,"allow_llm":false}}'),
  ('00000000-0000-4000-8000-000000000103', '00000000-0000-4000-8000-000000000003', 'https://atlas.example/careers', 'careers_page', 'generic', 0.950, '{"fixture":true,"options":{"allow_browser":false,"allow_llm":false}}')
on conflict (id) do nothing;

insert into public.agent_runs (
  id, agent_name, purpose, status, input_fingerprint, started_at, finished_at, metadata
) values (
  '00000000-0000-4000-8000-000000000801',
  'source_ingestion',
  'Fixture deterministic-first ingestion efficiency run',
  'succeeded',
  repeat('8', 64),
  '2026-08-14T08:00:00Z',
  '2026-08-14T08:01:00Z',
  '{"fixture":true}'
)
on conflict (id) do nothing;

insert into public.inference_decisions (
  id, agent_run_id, source_id, source_url, action, reason, page_changed,
  deterministic_route, deterministic_job_count, llm_escalated,
  model_extraction_succeeded, model_fallback_used, details, decided_at
) values
  ('00000000-0000-4000-8000-000000000811', '00000000-0000-4000-8000-000000000801', '00000000-0000-4000-8000-000000000101', 'https://careers.northstar.example/students', 'not_required', 'schema_extraction_succeeded', true, 'json_ld', 3, false, false, false, '{"fixture":true}', '2026-08-14T08:00:10Z'),
  ('00000000-0000-4000-8000-000000000812', '00000000-0000-4000-8000-000000000801', '00000000-0000-4000-8000-000000000102', 'https://jobs.meridian.example/early-career', 'not_required', 'structured_source_parsed', true, 'structured_endpoint', 5, false, false, false, '{"fixture":true}', '2026-08-14T08:00:20Z'),
  ('00000000-0000-4000-8000-000000000813', '00000000-0000-4000-8000-000000000801', '00000000-0000-4000-8000-000000000103', 'https://atlas.example/careers', 'suppressed', 'explicitly_no_open_jobs', true, 'static_html', 0, false, false, false, '{"fixture":true}', '2026-08-14T08:00:30Z'),
  ('00000000-0000-4000-8000-000000000814', '00000000-0000-4000-8000-000000000801', '00000000-0000-4000-8000-000000000103', 'https://atlas.example/careers/programs', 'escalated', 'ambiguous_recruiting_content', true, 'static_html', 0, true, true, true, '{"fixture":true,"fallback":"local_ollama"}', '2026-08-14T08:00:40Z'),
  ('00000000-0000-4000-8000-000000000815', '00000000-0000-4000-8000-000000000801', '00000000-0000-4000-8000-000000000101', 'https://careers.northstar.example/students', 'not_required', 'content_unchanged', false, 'json_ld', 0, false, false, false, '{"fixture":true}', '2026-08-14T08:00:50Z')
on conflict (id) do nothing;

insert into public.source_discovery_evidence (
  company_id, source_id, method, evidence_url, evidence_quote, metadata
) values
  ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000101', 'html_link', 'https://northstar.example', 'Students and careers', '{"fixture":true}'),
  ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000102', 'html_link', 'https://meridian.example', 'Early-career jobs', '{"fixture":true}'),
  ('00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000103', 'html_link', 'https://atlas.example', 'Careers', '{"fixture":true}')
on conflict (source_id, evidence_fingerprint) do nothing;

insert into public.raw_job_observations (id, source_id, observed_at, content_hash, extraction_method, http_status, raw_text, raw_payload) values
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000101', '2022-09-12T14:00:00Z', repeat('1', 64), 'archive', 200, 'Software Engineering Internship — applications opened September 12, 2022.', '{"fixture":true}'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000101', '2023-09-08T14:00:00Z', repeat('2', 64), 'archive', 200, 'Software Engineering Internship — applications opened September 8, 2023.', '{"fixture":true}'),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000101', '2024-09-19T14:00:00Z', repeat('3', 64), 'archive', 200, 'Software Engineering Internship — applications opened September 19, 2024.', '{"fixture":true}'),
  ('00000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-000000000101', '2025-09-11T14:00:00Z', repeat('4', 64), 'archive', 200, 'Software Engineering Internship — applications opened September 11, 2025.', '{"fixture":true}'),
  ('00000000-0000-4000-8000-000000000205', '00000000-0000-4000-8000-000000000101', '2026-08-11T14:00:00Z', repeat('5', 64), 'http', 200, 'Student programs page updated with fall recruiting preparation content.', '{"fixture":true,"changed":true}')
on conflict (id) do nothing;

insert into public.raw_job_observations (
  id, source_id, observed_at, fetched_at, content_hash, extraction_method, http_status,
  raw_text, raw_payload, identity_key, source_url, apply_url, raw_title, company_name,
  first_seen_at, last_seen_at, source_type, source_reliability, evidence_excerpt,
  archive_capture_at, archive_url, archive_original_url, archive_digest
) values
  ('00000000-0000-4000-8000-000000000601', '00000000-0000-4000-8000-000000000701', '2026-08-14T10:00:00Z', '2026-08-14T10:00:00Z', repeat('6', 64), 'archive', 200, 'Software Engineering Internship — applications opened September 12, 2022.', '{"fixture":true}', repeat('a', 64), 'https://careers.northstar.example/students', 'https://careers.northstar.example/students', 'Archived recruiting page: careers.northstar.example', 'Northstar Systems', '2026-08-14T10:00:00Z', '2026-08-14T10:00:00Z', 'wayback', '{"archive_semantics":"content_existed_by_capture_time"}', 'Software Engineering Internship — applications opened September 12, 2022.', '2022-09-12T14:00:00Z', 'https://web.archive.org/web/20220912140000id_/https://careers.northstar.example/students', 'https://careers.northstar.example/students', 'FIXTURE-2022'),
  ('00000000-0000-4000-8000-000000000602', '00000000-0000-4000-8000-000000000701', '2026-08-14T10:00:00Z', '2026-08-14T10:00:00Z', repeat('7', 64), 'archive', 200, 'Software Engineering Internship — applications opened September 8, 2023.', '{"fixture":true}', repeat('b', 64), 'https://careers.northstar.example/students', 'https://careers.northstar.example/students', 'Archived recruiting page: careers.northstar.example', 'Northstar Systems', '2026-08-14T10:00:00Z', '2026-08-14T10:00:00Z', 'wayback', '{"archive_semantics":"content_existed_by_capture_time"}', 'Software Engineering Internship — applications opened September 8, 2023.', '2023-09-08T14:00:00Z', 'https://web.archive.org/web/20230908140000id_/https://careers.northstar.example/students', 'https://careers.northstar.example/students', 'FIXTURE-2023'),
  ('00000000-0000-4000-8000-000000000603', '00000000-0000-4000-8000-000000000701', '2026-08-14T10:00:00Z', '2026-08-14T10:00:00Z', repeat('8', 64), 'archive', 200, 'Software Engineering Internship — applications opened September 19, 2024.', '{"fixture":true}', repeat('c', 64), 'https://careers.northstar.example/students', 'https://careers.northstar.example/students', 'Archived recruiting page: careers.northstar.example', 'Northstar Systems', '2026-08-14T10:00:00Z', '2026-08-14T10:00:00Z', 'wayback', '{"archive_semantics":"content_existed_by_capture_time"}', 'Software Engineering Internship — applications opened September 19, 2024.', '2024-09-19T14:00:00Z', 'https://web.archive.org/web/20240919140000id_/https://careers.northstar.example/students', 'https://careers.northstar.example/students', 'FIXTURE-2024')
on conflict (id) do nothing;

insert into public.archive_captures (
  id, source_id, observation_id, original_url, archive_url, captured_at, status_code,
  archive_digest, content_hash, meaningful_hash, change_kind, completeness, is_partial,
  detected_titles, evidence_excerpt
) values
  ('00000000-0000-4000-8000-000000000711', '00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000601', 'https://careers.northstar.example/students', 'https://web.archive.org/web/20220912140000id_/https://careers.northstar.example/students', '2022-09-12T14:00:00Z', 200, 'FIXTURE-2022', repeat('6', 64), repeat('d', 64), 'first_observed', 0.900, false, array['Software Engineering Internship'], 'Software Engineering Internship — applications opened September 12, 2022.'),
  ('00000000-0000-4000-8000-000000000712', '00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000602', 'https://careers.northstar.example/students', 'https://web.archive.org/web/20230908140000id_/https://careers.northstar.example/students', '2023-09-08T14:00:00Z', 200, 'FIXTURE-2023', repeat('7', 64), repeat('e', 64), 'meaningful_change', 0.900, false, array['Software Engineering Internship'], 'Software Engineering Internship — applications opened September 8, 2023.'),
  ('00000000-0000-4000-8000-000000000713', '00000000-0000-4000-8000-000000000701', '00000000-0000-4000-8000-000000000603', 'https://careers.northstar.example/students', 'https://web.archive.org/web/20240919140000id_/https://careers.northstar.example/students', '2024-09-19T14:00:00Z', 200, 'FIXTURE-2024', repeat('8', 64), repeat('f', 64), 'meaningful_change', 0.900, false, array['Software Engineering Internship'], 'Software Engineering Internship — applications opened September 19, 2024.')
on conflict (id) do nothing;

insert into public.historical_opening_events (
  id, canonical_role_id, observation_id, opened_on, evidence_quote, source_quality,
  extraction_version, opening_window_start, opening_window_end, date_precision,
  uncertainty_days, uncertainty_reason, resolution_method, provenance, available_at
) values
  ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000201', '2022-09-12', 'applications opened September 12, 2022', 0.900, 'fixture-v2', '2022-09-12', '2022-09-12', 'exact', 0, 'Archived page explicitly states the opening date.', 'source_explicit_date_v1', '[{"kind":"raw_observation","observation_id":"00000000-0000-4000-8000-000000000201","fixture":true}]', '2022-09-12T14:00:00Z'),
  ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000202', '2023-09-08', 'applications opened September 8, 2023', 0.950, 'fixture-v2', '2023-09-08', '2023-09-08', 'exact', 0, 'Archived page explicitly states the opening date.', 'source_explicit_date_v1', '[{"kind":"raw_observation","observation_id":"00000000-0000-4000-8000-000000000202","fixture":true}]', '2023-09-08T14:00:00Z'),
  ('00000000-0000-4000-8000-000000000303', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000203', '2024-09-19', 'applications opened September 19, 2024', 0.950, 'fixture-v2', '2024-09-19', '2024-09-19', 'exact', 0, 'Archived page explicitly states the opening date.', 'source_explicit_date_v1', '[{"kind":"raw_observation","observation_id":"00000000-0000-4000-8000-000000000203","fixture":true}]', '2024-09-19T14:00:00Z'),
  ('00000000-0000-4000-8000-000000000304', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000204', '2025-09-11', 'applications opened September 11, 2025', 1.000, 'fixture-v2', '2025-09-11', '2025-09-11', 'exact', 0, 'Archived page explicitly states the opening date.', 'source_explicit_date_v1', '[{"kind":"raw_observation","observation_id":"00000000-0000-4000-8000-000000000204","fixture":true}]', '2025-09-11T14:00:00Z')
on conflict (id) do nothing;

insert into public.role_aliases (
  canonical_role_id, alias_title, normalized_alias, first_observation_id, last_observation_id,
  first_seen_at, last_seen_at, match_confidence, match_evidence, resolver_version
) values (
  '00000000-0000-4000-8000-000000000011',
  'Software Engineering Internship',
  'software engineer intern',
  '00000000-0000-4000-8000-000000000201',
  '00000000-0000-4000-8000-000000000204',
  '2022-09-12T14:00:00Z',
  '2025-09-11T14:00:00Z',
  1.0000,
  '[{"kind":"fixture_explicit_alias","value":true,"detail":"Same sourced annual program across four years"}]',
  'hybrid-role-resolver-v1'
)
on conflict (canonical_role_id, normalized_alias) do nothing;

insert into public.observation_role_matches (
  observation_id, canonical_role_id, decision, match_confidence, feature_scores,
  reasons, evidence, resolver_version, created_at
) values
  ('00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000011', 'matched', 1.0000, '{"alias_exact":1,"level_compatible":1,"family_compatible":1}', array['Same normalized company, level, family, and verified alias.'], '[{"kind":"fixture_alias","value":true,"detail":"2022 annual observation"}]', 'hybrid-role-resolver-v1', '2022-09-12T14:00:00Z'),
  ('00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000011', 'matched', 1.0000, '{"alias_exact":1,"level_compatible":1,"family_compatible":1}', array['Same normalized company, level, family, and verified alias.'], '[{"kind":"fixture_alias","value":true,"detail":"2023 annual observation"}]', 'hybrid-role-resolver-v1', '2023-09-08T14:00:00Z'),
  ('00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000011', 'matched', 1.0000, '{"alias_exact":1,"level_compatible":1,"family_compatible":1}', array['Same normalized company, level, family, and verified alias.'], '[{"kind":"fixture_alias","value":true,"detail":"2024 annual observation"}]', 'hybrid-role-resolver-v1', '2024-09-19T14:00:00Z'),
  ('00000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-000000000011', 'matched', 1.0000, '{"alias_exact":1,"level_compatible":1,"family_compatible":1}', array['Same normalized company, level, family, and verified alias.'], '[{"kind":"fixture_alias","value":true,"detail":"2025 annual observation"}]', 'hybrid-role-resolver-v1', '2025-09-11T14:00:00Z')
on conflict (observation_id, canonical_role_id) do nothing;

insert into public.signals (
  id, company_id, canonical_role_id, observation_id, source_id, kind, observed_at,
  available_at, source_url, strength, reliability, evidence_quote, extraction_method,
  identity_key, content_hash, metadata
) values
  ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000205', '00000000-0000-4000-8000-000000000101', 'internship_program_page_changed', '2026-08-11T14:00:00Z', '2026-08-11T14:00:00Z', 'https://careers.northstar.example/students', 0.700, 0.800, 'Student programs page updated with fall recruiting preparation content.', 'static_html', repeat('9', 64), repeat('5', 64), '{"fixture":true,"normalized_schema":"recruiting-signal-v1"}')
on conflict (id) do nothing;

insert into public.forecasts (
  id, canonical_role_id, as_of, point_date, window_start, window_end, confidence,
  calibrated_probability, confidence_factors, feature_contributions, method,
  model_version, forecasted_at, history_count, prior_effective_sample_size,
  prediction_interval_coverage, input_fingerprint
) values
  (
    '00000000-0000-4000-8000-000000000501',
    '00000000-0000-4000-8000-000000000011',
    '2026-08-14',
    '2026-09-13',
    '2026-09-04',
    '2026-09-22',
    70.80,
    0.7080,
    '{"role_history_strength":0.7364,"prior_support":0.0,"cycle_consistency":0.8412,"source_quality":0.95,"evidence_recency":0.6304,"event_uncertainty_precision":1.0,"interval_precision":0.8187,"company_recruiting_scale":0.75,"current_signal_support":0.4078,"signal_contradiction":0.0,"signal_conflict":0.0}',
    '[{"name":"role openings 2022-2025","kind":"role_history","date_weight":1.0,"confidence_effect":0.8753,"influences_date":true,"rationale":"Four sourced role cycles weighted by quality and recency."},{"name":"internship_program_page_changed","kind":"signal","date_weight":0,"confidence_effect":0.5239,"influences_date":false,"rationale":"Recent reliable signal supports recurrence confidence but cannot move the date."},{"name":"company recruiting scale","kind":"context","date_weight":0,"confidence_effect":0.06,"influences_date":false,"rationale":"Recruiting scale affects repeatability confidence, not the expected date."}]',
    'uncertainty_weighted_hierarchical_circular_model',
    'hierarchical-circular-shrinkage-v2',
    '2026-08-14T00:00:00Z',
    4,
    0,
    0.800,
    repeat('a', 64)
  )
on conflict (id) do nothing;

insert into public.forecast_evidence (id, forecast_id, observation_id, historical_opening_event_id, signal_id, contribution, weight, rationale) values
  ('00000000-0000-4000-8000-000000000521', '00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000201', '00000000-0000-4000-8000-000000000301', null, 'role_history', 0.1851, 'Oldest observed role cycle; quality- and recency-weighted.'),
  ('00000000-0000-4000-8000-000000000522', '00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000202', '00000000-0000-4000-8000-000000000302', null, 'role_history', 0.2268, 'Observed role opening used in the circular temporal estimate.'),
  ('00000000-0000-4000-8000-000000000523', '00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000203', '00000000-0000-4000-8000-000000000303', null, 'role_history', 0.2650, 'Observed role opening used in the circular temporal estimate.'),
  ('00000000-0000-4000-8000-000000000524', '00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000204', '00000000-0000-4000-8000-000000000304', null, 'role_history', 0.3232, 'Most recent verified role opening received the highest date weight.'),
  ('00000000-0000-4000-8000-000000000525', '00000000-0000-4000-8000-000000000501', '00000000-0000-4000-8000-000000000205', null, '00000000-0000-4000-8000-000000000401', 'signal', 0.1900, 'Recent program-page change supports confidence but does not move the date.')
-- Migration 202608140010 intentionally dropped the (forecast_id, observation_id,
-- contribution) uniqueness so one observation can contribute more than once across
-- forecast versions, leaving no inferable conflict target for those columns. Explicit
-- primary keys keep a repeated seed idempotent without reinstating that constraint.
on conflict (id) do nothing;
