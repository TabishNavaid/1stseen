alter type public.extraction_method add value if not exists 'structured_endpoint';
alter type public.extraction_method add value if not exists 'json_ld';
alter type public.extraction_method add value if not exists 'embedded_data';
alter type public.extraction_method add value if not exists 'static_html';
alter type public.extraction_method add value if not exists 'playwright';
alter type public.extraction_method add value if not exists 'llm';

alter table public.sources
  add column adapter text not null default 'generic' check (
    adapter in ('greenhouse', 'lever', 'ashby', 'smartrecruiters', 'generic', 'rss', 'sitemap')
  ),
  add column last_content_hash text check (last_content_hash is null or last_content_hash ~ '^[a-f0-9]{64}$');

alter table public.raw_job_observations
  add column external_job_id text,
  add column identity_key text,
  add column source_url text,
  add column apply_url text,
  add column raw_title text,
  add column company_name text,
  add column location text,
  add column employment_type text,
  add column published_at timestamptz,
  add column first_seen_at timestamptz,
  add column last_seen_at timestamptz,
  add column source_type text,
  add column source_reliability jsonb not null default '{}'::jsonb,
  add column evidence_excerpt text not null default '';

alter table public.raw_job_observations
  add constraint raw_job_observations_identity_key_format check (
    identity_key is null or identity_key ~ '^[a-f0-9]{64}$'
  ),
  add constraint raw_job_observations_seen_order check (
    first_seen_at is null or last_seen_at is null or first_seen_at <= last_seen_at
  ),
  add constraint raw_job_observations_bounded_evidence check (
    octet_length(raw_text) <= 65536 and octet_length(evidence_excerpt) <= 65536
  );

create unique index raw_job_observations_identity_idx
  on public.raw_job_observations (source_id, identity_key)
  where identity_key is not null;

create index raw_job_observations_apply_url_idx on public.raw_job_observations (apply_url);

create table public.source_fetches (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources(id) on delete cascade,
  fetched_at timestamptz not null default now(),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  extraction_route text not null check (
    extraction_route in ('structured_endpoint', 'json_ld', 'embedded_data', 'static_html', 'playwright', 'llm')
  ),
  byte_count integer not null check (byte_count >= 0),
  unchanged boolean not null default false,
  jobs_detected integer not null default 0 check (jobs_detected >= 0),
  error jsonb
);

create index source_fetches_source_time_idx on public.source_fetches (source_id, fetched_at desc);

alter table public.source_fetches enable row level security;
create policy "authenticated read source fetches" on public.source_fetches
  for select to authenticated using (true);
