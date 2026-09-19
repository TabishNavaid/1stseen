alter table public.sources drop constraint if exists sources_adapter_check;
alter table public.sources add constraint sources_adapter_check check (
  adapter in ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'generic', 'rss', 'sitemap', 'wayback')
);

alter table public.sources drop constraint if exists sources_company_id_url_key;
alter table public.sources add constraint sources_company_url_adapter_key
  unique (company_id, url, adapter);

alter table public.source_fetches drop constraint if exists source_fetches_extraction_route_check;
alter table public.source_fetches add constraint source_fetches_extraction_route_check check (
  extraction_route in (
    'structured_endpoint', 'json_ld', 'embedded_data', 'static_html', 'playwright', 'llm', 'archive'
  )
);

alter table public.raw_job_observations
  add column archive_capture_at timestamptz,
  add column archive_url text,
  add column archive_original_url text,
  add column archive_digest text;

create index raw_job_observations_archive_capture_idx
  on public.raw_job_observations (archive_capture_at)
  where archive_capture_at is not null;

create table public.archive_captures (
  id uuid primary key,
  source_id uuid not null references public.sources(id) on delete cascade,
  observation_id uuid not null unique references public.raw_job_observations(id) on delete restrict,
  original_url text not null,
  archive_url text not null,
  captured_at timestamptz not null,
  status_code integer not null check (status_code between 200 and 399),
  redirect_url text,
  archive_digest text,
  content_hash text check (content_hash is null or content_hash ~ '^[a-f0-9]{64}$'),
  meaningful_hash text check (meaningful_hash is null or meaningful_hash ~ '^[a-f0-9]{64}$'),
  change_kind text not null check (
    change_kind in ('first_observed', 'unchanged', 'meaningful_change', 'redirect', 'unavailable')
  ),
  completeness numeric(4,3) not null check (completeness between 0 and 1),
  is_partial boolean not null,
  detected_titles text[] not null default '{}',
  evidence_excerpt text not null check (octet_length(evidence_excerpt) <= 65536),
  created_at timestamptz not null default now(),
  unique (source_id, original_url, captured_at)
);

create index archive_captures_source_time_idx
  on public.archive_captures (source_id, captured_at);
create index archive_captures_original_time_idx
  on public.archive_captures (original_url, captured_at);

alter table public.historical_opening_events
  add column opening_window_start date,
  add column opening_window_end date,
  add column date_precision text not null default 'exact' check (
    date_precision in ('exact', 'bounded', 'observed_by')
  ),
  add column uncertainty_days integer check (uncertainty_days is null or uncertainty_days >= 0),
  add column uncertainty_reason text not null default 'Legacy exact opening date.',
  add column resolution_method text not null default 'legacy_exact_v1',
  add column provenance jsonb not null default '[]'::jsonb;

update public.historical_opening_events
set opening_window_start = opened_on,
    opening_window_end = opened_on,
    uncertainty_days = 0,
    provenance = jsonb_build_array(jsonb_build_object(
      'kind', 'legacy_observation',
      'observation_id', observation_id
    ));

alter table public.historical_opening_events
  alter column opening_window_end set not null,
  add constraint historical_opening_window_order check (
    opening_window_start is null or opening_window_start <= opened_on
  ),
  add constraint historical_opening_latest_order check (opened_on <= opening_window_end),
  add constraint historical_opening_precision_bounds check (
    (date_precision = 'exact' and opening_window_start = opened_on and opening_window_end = opened_on)
    or (date_precision = 'bounded' and opening_window_start is not null)
    or (date_precision = 'observed_by')
  ),
  add constraint historical_opening_provenance_nonempty check (jsonb_array_length(provenance) > 0);

alter table public.archive_captures enable row level security;
create policy "authenticated read archive captures" on public.archive_captures
  for select to authenticated using (true);

-- The uncertainty columns are inserted before `signal_kind`, and CREATE OR REPLACE
-- VIEW cannot reorder or rename existing view columns. Dropping first keeps this
-- migration applicable to a fresh database as well as an already-migrated one.
drop view if exists public.forecast_provenance;
create view public.forecast_provenance with (security_invoker = true) as
select
  f.id as forecast_id,
  f.canonical_role_id,
  fe.contribution,
  fe.weight,
  fe.rationale,
  o.id as observation_id,
  o.observed_at,
  o.content_hash,
  o.extraction_method,
  s.id as source_id,
  s.url as source_url,
  co.id as company_id,
  co.name as company_name,
  he.opened_on,
  he.opening_window_start,
  he.opening_window_end,
  he.date_precision,
  he.uncertainty_days,
  he.provenance as historical_provenance,
  sig.kind as signal_kind
from public.forecasts f
join public.forecast_evidence fe on fe.forecast_id = f.id
join public.raw_job_observations o on o.id = fe.observation_id
join public.sources s on s.id = o.source_id
join public.companies co on co.id = s.company_id
left join public.historical_opening_events he on he.id = fe.historical_opening_event_id
left join public.signals sig on sig.id = fe.signal_id;
