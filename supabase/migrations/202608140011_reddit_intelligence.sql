-- Low-authority Reddit recruiting claims collected through approved OAuth API access.

alter table public.sources
  drop constraint if exists sources_adapter_check;

alter table public.sources
  add constraint sources_adapter_check check (adapter in (
    'greenhouse', 'lever', 'ashby', 'smartrecruiters', 'generic', 'rss', 'sitemap',
    'wayback', 'reddit'
  ));

alter table public.signals
  add column source_published_at timestamptz;

comment on column public.signals.source_published_at is
  'Timestamp published by the source platform, distinct from 1stSeen observed_at and any claimed event.';

comment on table public.signals is
  'Supporting recruiting evidence only. Community claims require corroborating official/ATS evidence and cannot independently confirm an opening event.';

comment on column public.signals.metadata is
  'Community rows include event classification, claimed-date text/precision, supporting-only semantics, and confirmation eligibility.';
