-- Provider-independent model routing and per-attempt audit metadata.

alter table public.model_usage
  alter column agent_run_id drop not null,
  add column capability text not null default 'reason'
    check (capability in ('extract', 'classify', 'normalize', 'reason')),
  add column success boolean not null default true,
  add column failure_kind text
    check (failure_kind in (
      'rate_limit',
      'quota_exhausted',
      'temporary_provider',
      'timeout',
      'invalid_structured_output',
      'permanent_provider'
    )),
  add column fallback_reason text;

alter table public.model_usage
  add constraint model_usage_failure_consistency check (
    (success and failure_kind is null)
    or (not success and failure_kind is not null)
  );

create index model_usage_capability_created_idx
  on public.model_usage (capability, created_at desc);

comment on table public.model_usage is
  'One row per provider attempt, including failed attempts that trigger an allowed fallback.';
