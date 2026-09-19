alter type public.source_kind add value if not exists 'campus_page';
alter type public.source_kind add value if not exists 'sitemap';
alter type public.source_kind add value if not exists 'feed';
alter type public.source_kind add value if not exists 'related_career_page';

alter table public.companies
  add column recruiting_url text,
  add column ats_provider text,
  add column ats_tenant text;

create table public.source_discovery_evidence (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  source_id uuid not null references public.sources(id) on delete cascade,
  method text not null check (method in (
    'input_domain',
    'dns',
    'redirect',
    'structured_metadata',
    'html_link',
    'known_ats_pattern',
    'robots_sitemap',
    'sitemap_probe',
    'feed_link',
    'llm_identity'
  )),
  evidence_url text not null,
  evidence_quote text not null check (
    length(evidence_quote) > 0 and octet_length(evidence_quote) <= 8192
  ),
  evidence_fingerprint text generated always as (
    encode(extensions.digest(method || E'\n' || evidence_url || E'\n' || evidence_quote, 'sha256'), 'hex')
  ) stored,
  metadata jsonb not null default '{}'::jsonb,
  discovered_at timestamptz not null default now(),
  unique (source_id, evidence_fingerprint)
);

create index source_discovery_evidence_company_idx
  on public.source_discovery_evidence (company_id, discovered_at desc);
create index source_discovery_evidence_source_idx
  on public.source_discovery_evidence (source_id, discovered_at desc);

alter table public.source_discovery_evidence enable row level security;
create policy "authenticated read source discovery evidence"
  on public.source_discovery_evidence for select to authenticated using (true);
