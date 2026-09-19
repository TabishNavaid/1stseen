alter table public.canonical_roles
  add column company_normalized text,
  add column normalized_title text,
  add column role_family text not null default 'other',
  add column level text not null default 'unknown' check (
    level in ('internship', 'new_grad', 'apprenticeship', 'full_time', 'unknown')
  ),
  add column recruiting_season text not null default 'unknown' check (
    recruiting_season in ('spring', 'summer', 'fall', 'winter', 'year_round', 'unknown')
  ),
  add column specialization text,
  add column feature_profile jsonb not null default '{}'::jsonb,
  add column description_prototype text not null default '' check (
    octet_length(description_prototype) <= 32768
  ),
  add column description_embedding vector(1536),
  add column resolver_version text not null default 'legacy';

update public.canonical_roles as role
set company_normalized = btrim(lower(regexp_replace(company.name, '[^a-zA-Z0-9]+', ' ', 'g'))),
    normalized_title = btrim(lower(regexp_replace(role.canonical_title, '[^a-zA-Z0-9]+', ' ', 'g'))),
    level = case role.track::text
      when 'internship' then 'internship'
      when 'new_grad' then 'new_grad'
      when 'apprenticeship' then 'apprenticeship'
      else 'unknown'
    end,
    feature_profile = jsonb_build_object('migration', 'legacy_backfill')
from public.companies as company
where company.id = role.company_id;

alter table public.canonical_roles
  alter column company_normalized set not null,
  alter column normalized_title set not null;

create table public.role_aliases (
  id uuid primary key default gen_random_uuid(),
  canonical_role_id uuid not null references public.canonical_roles(id) on delete cascade,
  alias_title text not null,
  normalized_alias text not null,
  first_observation_id uuid not null references public.raw_job_observations(id) on delete restrict,
  last_observation_id uuid not null references public.raw_job_observations(id) on delete restrict,
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  match_confidence numeric(5,4) not null check (match_confidence between 0 and 1),
  match_evidence jsonb not null,
  resolver_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (first_seen_at <= last_seen_at),
  unique (canonical_role_id, normalized_alias)
);

create table public.observation_role_matches (
  observation_id uuid primary key references public.raw_job_observations(id) on delete cascade,
  canonical_role_id uuid not null references public.canonical_roles(id) on delete restrict,
  decision text not null check (decision in ('matched', 'created')),
  match_confidence numeric(5,4) not null check (match_confidence between 0 and 1),
  feature_scores jsonb not null,
  reasons text[] not null,
  evidence jsonb not null,
  used_embedding boolean not null default false,
  used_llm boolean not null default false,
  resolver_version text not null,
  created_at timestamptz not null default now()
);

create index role_aliases_normalized_idx on public.role_aliases (normalized_alias);
create index observation_role_matches_role_idx
  on public.observation_role_matches (canonical_role_id, created_at desc);

create trigger role_aliases_set_updated_at before update on public.role_aliases
  for each row execute function public.set_updated_at();

alter table public.role_aliases enable row level security;
alter table public.observation_role_matches enable row level security;
create policy "authenticated read role aliases" on public.role_aliases
  for select to authenticated using (true);
create policy "authenticated read observation role matches" on public.observation_role_matches
  for select to authenticated using (true);
