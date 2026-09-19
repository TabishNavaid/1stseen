-- Hosted Supabase installs pgcrypto in `extensions` before any migration, and `db push` runs with a search_path that
-- does not include that schema, so every call into an extension is schema-qualified (`extensions.digest`). The schema
-- is named here so a database without pgcrypto puts it in the same place. `vector` lives in public on every database
-- this project has run on, and its type is used unqualified.
create extension if not exists pgcrypto with schema extensions;
create extension if not exists vector with schema public;

create type public.role_track as enum ('internship', 'new_grad', 'apprenticeship', 'other');
create type public.source_kind as enum ('careers_page', 'ats', 'archive', 'recruiter_post', 'program_page');
create type public.extraction_method as enum ('http', 'playwright', 'api', 'archive');
create type public.run_status as enum ('running', 'succeeded', 'partial', 'failed');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  timezone text not null default 'UTC',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  domain text not null unique,
  careers_url text,
  is_fixture boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.canonical_roles (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  canonical_title text not null,
  track public.role_track not null,
  location_scope text not null,
  recurrence_key text not null check (recurrence_key ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, recurrence_key)
);

create table public.sources (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  url text not null,
  kind public.source_kind not null,
  trust_score numeric(4,3) not null default 0.700 check (trust_score between 0 and 1),
  enabled boolean not null default true,
  robots_checked_at timestamptz,
  last_fetched_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (company_id, url)
);

create table public.raw_job_observations (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null references public.sources(id) on delete restrict,
  observed_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  extraction_method public.extraction_method not null,
  http_status integer check (http_status between 100 and 599),
  raw_text text not null check (length(raw_text) > 0),
  raw_payload jsonb not null default '{}'::jsonb,
  embedding vector(1536),
  created_at timestamptz not null default now(),
  unique (source_id, content_hash)
);

create index raw_job_observations_source_time_idx on public.raw_job_observations (source_id, observed_at desc);
create index raw_job_observations_embedding_idx on public.raw_job_observations using hnsw (embedding vector_cosine_ops);

create table public.historical_opening_events (
  id uuid primary key default gen_random_uuid(),
  canonical_role_id uuid not null references public.canonical_roles(id) on delete cascade,
  observation_id uuid not null references public.raw_job_observations(id) on delete restrict,
  opened_on date not null,
  closed_on date,
  evidence_quote text not null check (length(evidence_quote) > 0),
  source_quality numeric(4,3) not null check (source_quality between 0 and 1),
  extraction_version text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  check (closed_on is null or closed_on >= opened_on),
  unique (canonical_role_id, opened_on, observation_id)
);

create index historical_openings_role_date_idx on public.historical_opening_events (canonical_role_id, opened_on desc);

create table public.signals (
  id uuid primary key default gen_random_uuid(),
  canonical_role_id uuid not null references public.canonical_roles(id) on delete cascade,
  observation_id uuid not null references public.raw_job_observations(id) on delete restrict,
  kind text not null,
  observed_at timestamptz not null,
  strength numeric(4,3) not null check (strength between 0 and 1),
  reliability numeric(4,3) not null check (reliability between 0 and 1),
  evidence_quote text not null check (length(evidence_quote) > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (canonical_role_id, observation_id, kind)
);

create index signals_role_observed_idx on public.signals (canonical_role_id, observed_at desc);

create table public.forecasts (
  id uuid primary key default gen_random_uuid(),
  canonical_role_id uuid not null references public.canonical_roles(id) on delete cascade,
  as_of date not null,
  point_date date not null,
  window_start date not null,
  window_end date not null,
  confidence numeric(5,2) not null check (confidence between 0 and 100),
  confidence_factors jsonb not null,
  method text not null,
  model_version text not null,
  history_count integer not null check (history_count >= 2),
  input_fingerprint text not null check (input_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default now(),
  check (window_start <= point_date and point_date <= window_end),
  unique (canonical_role_id, as_of, model_version, input_fingerprint)
);

create index forecasts_role_as_of_idx on public.forecasts (canonical_role_id, as_of desc);

create table public.forecast_evidence (
  id uuid primary key default gen_random_uuid(),
  forecast_id uuid not null references public.forecasts(id) on delete cascade,
  observation_id uuid not null references public.raw_job_observations(id) on delete restrict,
  historical_opening_event_id uuid references public.historical_opening_events(id) on delete restrict,
  signal_id uuid references public.signals(id) on delete restrict,
  contribution text not null check (contribution in ('history', 'signal', 'quality', 'recency')),
  weight numeric(5,4) not null check (weight between 0 and 1),
  rationale text not null check (length(rationale) > 0),
  created_at timestamptz not null default now(),
  check (historical_opening_event_id is not null or signal_id is not null),
  unique (forecast_id, observation_id, contribution)
);

create index forecast_evidence_forecast_idx on public.forecast_evidence (forecast_id);

create table public.watchlists (
  user_id uuid not null references public.profiles(id) on delete cascade,
  canonical_role_id uuid not null references public.canonical_roles(id) on delete cascade,
  alerts_enabled boolean not null default true,
  alert_lead_days integer[] not null default array[45, 30, 14, 7],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, canonical_role_id)
);

create table public.readiness_milestones (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  canonical_role_id uuid not null references public.canonical_roles(id) on delete cascade,
  forecast_id uuid not null references public.forecasts(id) on delete cascade,
  kind text not null check (kind in ('resume_lock', 'portfolio', 'networking', 'referral', 'application_ready')),
  due_on date not null,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, forecast_id, kind)
);

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  parent_run_id uuid references public.agent_runs(id) on delete set null,
  initiated_by uuid references public.profiles(id) on delete set null,
  agent_name text not null,
  purpose text not null,
  status public.run_status not null default 'running',
  input_fingerprint text not null check (input_fingerprint ~ '^[a-f0-9]{64}$'),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error jsonb,
  metadata jsonb not null default '{}'::jsonb,
  check (finished_at is null or finished_at >= started_at)
);

create table public.agent_tool_calls (
  id uuid primary key default gen_random_uuid(),
  agent_run_id uuid not null references public.agent_runs(id) on delete cascade,
  tool_name text not null,
  status public.run_status not null default 'running',
  input_redacted jsonb not null default '{}'::jsonb,
  output_redacted jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  error jsonb,
  check (finished_at is null or finished_at >= started_at)
);

create index agent_tool_calls_run_idx on public.agent_tool_calls (agent_run_id, started_at);

create table public.model_usage (
  id uuid primary key default gen_random_uuid(),
  agent_run_id uuid not null references public.agent_runs(id) on delete cascade,
  tool_call_id uuid references public.agent_tool_calls(id) on delete set null,
  provider text not null,
  model text not null,
  prompt_tokens integer not null check (prompt_tokens >= 0),
  completion_tokens integer not null check (completion_tokens >= 0),
  estimated_cost_usd numeric(12,6) not null default 0 check (estimated_cost_usd >= 0),
  latency_ms integer not null check (latency_ms >= 0),
  created_at timestamptz not null default now()
);

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
  sig.kind as signal_kind
from public.forecasts f
join public.forecast_evidence fe on fe.forecast_id = f.id
join public.raw_job_observations o on o.id = fe.observation_id
join public.sources s on s.id = o.source_id
join public.companies co on co.id = s.company_id
left join public.historical_opening_events he on he.id = fe.historical_opening_event_id
left join public.signals sig on sig.id = fe.signal_id;

create or replace function public.set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create or replace function public.create_profile_for_new_user() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)));
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users for each row execute function public.create_profile_for_new_user();
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
create trigger companies_set_updated_at before update on public.companies for each row execute function public.set_updated_at();
create trigger canonical_roles_set_updated_at before update on public.canonical_roles for each row execute function public.set_updated_at();
create trigger sources_set_updated_at before update on public.sources for each row execute function public.set_updated_at();
create trigger watchlists_set_updated_at before update on public.watchlists for each row execute function public.set_updated_at();
create trigger readiness_set_updated_at before update on public.readiness_milestones for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.companies enable row level security;
alter table public.canonical_roles enable row level security;
alter table public.sources enable row level security;
alter table public.raw_job_observations enable row level security;
alter table public.historical_opening_events enable row level security;
alter table public.signals enable row level security;
alter table public.forecasts enable row level security;
alter table public.forecast_evidence enable row level security;
alter table public.watchlists enable row level security;
alter table public.readiness_milestones enable row level security;
alter table public.agent_runs enable row level security;
alter table public.agent_tool_calls enable row level security;
alter table public.model_usage enable row level security;

create policy "users read their profile" on public.profiles for select to authenticated using (auth.uid() = id);
create policy "users update their profile" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);
create policy "authenticated read companies" on public.companies for select to authenticated using (true);
create policy "authenticated read canonical roles" on public.canonical_roles for select to authenticated using (true);
create policy "authenticated read sources" on public.sources for select to authenticated using (true);
create policy "authenticated read observations" on public.raw_job_observations for select to authenticated using (true);
create policy "authenticated read historical openings" on public.historical_opening_events for select to authenticated using (true);
create policy "authenticated read signals" on public.signals for select to authenticated using (true);
create policy "authenticated read forecasts" on public.forecasts for select to authenticated using (true);
create policy "authenticated read forecast evidence" on public.forecast_evidence for select to authenticated using (true);
create policy "users manage watchlists" on public.watchlists for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "users manage readiness" on public.readiness_milestones for all to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);

revoke all on public.agent_runs, public.agent_tool_calls, public.model_usage from anon, authenticated;
