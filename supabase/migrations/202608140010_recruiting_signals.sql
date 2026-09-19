-- Normalized supporting signals and immutable forecast recomputation lineage.

alter table public.signals
  alter column canonical_role_id drop not null,
  add column company_id uuid references public.companies(id) on delete cascade,
  add column source_id uuid references public.sources(id) on delete restrict,
  add column source_url text,
  add column claimed_event_at timestamptz,
  add column extraction_method text,
  add column identity_key text,
  add column content_hash text;

update public.signals as signal
set company_id = role.company_id,
    source_id = observation.source_id,
    source_url = coalesce(observation.source_url, source.url),
    extraction_method = case observation.extraction_method::text
      when 'http' then 'static_html'
      when 'api' then 'structured_endpoint'
      else observation.extraction_method::text
    end,
    identity_key = encode(extensions.digest(
      signal.canonical_role_id::text || '|' || signal.kind || '|' || signal.observation_id::text,
      'sha256'
    ), 'hex'),
    content_hash = observation.content_hash
from public.canonical_roles as role,
     public.raw_job_observations as observation,
     public.sources as source
where role.id = signal.canonical_role_id
  and observation.id = signal.observation_id
  and source.id = observation.source_id;

alter table public.signals
  alter column company_id set not null,
  alter column source_id set not null,
  alter column source_url set not null,
  alter column extraction_method set not null,
  alter column identity_key set not null,
  alter column content_hash set not null,
  add constraint signals_kind_normalized_check check (kind in (
    'career_page_changed',
    'internship_program_page_changed',
    'new_relevant_sitemap_url',
    'company_recruiting_blog_post',
    'university_recruiting_page_update',
    'new_ats_role_family_appearing',
    'community_recruiting_discussion',
    'program_page_change'
  )),
  add constraint signals_identity_key_format check (identity_key ~ '^[a-f0-9]{64}$'),
  add constraint signals_content_hash_format check (content_hash ~ '^[a-f0-9]{64}$'),
  add constraint signals_extraction_method_check check (extraction_method in (
    'structured_endpoint', 'json_ld', 'embedded_data', 'static_html',
    'playwright', 'llm', 'archive'
  )),
  add constraint signals_evidence_bounded check (octet_length(evidence_quote) <= 8192);

create unique index signals_identity_idx on public.signals (identity_key);
create index signals_company_observed_idx on public.signals (company_id, observed_at desc);
create index signals_source_observed_idx on public.signals (source_id, observed_at desc);

create table public.signal_source_states (
  source_id uuid primary key references public.sources(id) on delete cascade,
  meaningful_hash text not null check (meaningful_hash ~ '^[a-f0-9]{64}$'),
  normalized_text text not null check (octet_length(normalized_text) <= 65536),
  item_keys text[] not null default '{}',
  urls text[] not null default '{}',
  observed_at timestamptz not null,
  updated_at timestamptz not null default now()
);

alter table public.forecasts
  add column supersedes_forecast_id uuid references public.forecasts(id) on delete set null,
  add column trigger_signal_ids uuid[] not null default '{}',
  add column recomputation_reason text;

alter table public.forecast_evidence
  drop constraint if exists forecast_evidence_forecast_id_observation_id_contribution_key;

create table public.forecast_changes (
  id uuid primary key default gen_random_uuid(),
  before_forecast_id uuid not null references public.forecasts(id) on delete restrict,
  after_forecast_id uuid not null unique references public.forecasts(id) on delete restrict,
  trigger_signal_ids uuid[] not null check (cardinality(trigger_signal_ids) > 0),
  material boolean not null,
  confidence_delta numeric(6,2) not null,
  point_date_delta_days integer not null,
  interval_start_delta_days integer not null,
  interval_end_delta_days integer not null,
  reasons text[] not null,
  created_at timestamptz not null default now(),
  check (before_forecast_id <> after_forecast_id),
  check (material = (cardinality(reasons) > 0))
);

create index forecast_changes_before_idx on public.forecast_changes (before_forecast_id);

alter table public.signal_source_states enable row level security;
alter table public.forecast_changes enable row level security;

comment on table public.signals is
  'Supporting recruiting evidence. A signal is not an authoritative job opening.';
comment on column public.signals.claimed_event_at is
  'Optional source-claimed event time. Never substituted with observed_at.';
comment on table public.signal_source_states is
  'Bounded deterministic state for change detection; raw HTML is not stored.';
comment on table public.forecast_changes is
  'Immutable before/after forecast lineage triggered by normalized signals.';
