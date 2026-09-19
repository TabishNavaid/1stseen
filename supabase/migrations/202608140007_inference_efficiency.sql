-- Deterministic-first inference decisions and admin-ready efficiency metrics.

create table public.inference_decisions (
  id uuid primary key default gen_random_uuid(),
  agent_run_id uuid references public.agent_runs(id) on delete set null,
  source_id uuid not null references public.sources(id) on delete cascade,
  source_url text not null,
  action text not null check (action in ('not_required', 'escalated', 'suppressed')),
  reason text not null check (reason in (
    'content_unchanged',
    'structured_source_parsed',
    'schema_extraction_succeeded',
    'html_extraction_succeeded',
    'archive_extraction_succeeded',
    'model_not_enabled',
    'explicitly_no_open_jobs',
    'insufficient_recruiting_evidence',
    'ambiguous_recruiting_content'
  )),
  page_changed boolean not null,
  deterministic_route text not null,
  deterministic_job_count integer not null default 0 check (deterministic_job_count >= 0),
  llm_escalated boolean not null default false,
  model_extraction_succeeded boolean not null default false,
  model_fallback_used boolean not null default false,
  details jsonb not null default '{}'::jsonb,
  decided_at timestamptz not null default now(),
  check (action <> 'escalated' or llm_escalated),
  check (not model_extraction_succeeded or llm_escalated),
  check (not model_fallback_used or llm_escalated)
);

create index inference_decisions_run_time_idx
  on public.inference_decisions (agent_run_id, decided_at desc);
create index inference_decisions_source_time_idx
  on public.inference_decisions (source_id, decided_at desc);

alter table public.inference_decisions enable row level security;
revoke all on public.inference_decisions from anon, authenticated;

create view public.inference_run_metrics with (security_invoker = true) as
select
  agent_run_id,
  count(*)::integer as pages_processed,
  count(*) filter (where page_changed)::integer as pages_changed,
  count(*) filter (
    where action = 'not_required'
      and page_changed
      and deterministic_job_count > 0
  )::integer as deterministically_parsed,
  count(*) filter (where llm_escalated)::integer as llm_escalations,
  round(
    100.0 * count(*) filter (where llm_escalated) / nullif(count(*), 0),
    2
  ) as llm_escalation_percentage,
  count(*) filter (where model_extraction_succeeded)::integer
    as successful_model_extractions,
  coalesce(round(
    100.0 * count(*) filter (where model_fallback_used)
      / nullif(count(*) filter (where llm_escalated), 0),
    2
  ), 0) as fallback_frequency
from public.inference_decisions
group by agent_run_id;

revoke all on public.inference_run_metrics from anon, authenticated;

comment on table public.inference_decisions is
  'Records why deterministic extraction was sufficient or why model inference was escalated.';
comment on view public.inference_run_metrics is
  'Per-agent-run ingestion efficiency metrics; percentages use pages processed and LLM escalations.';

alter table public.observation_role_matches
  add column inference_decision jsonb not null default jsonb_build_object(
    'action', 'not_required',
    'reason', 'deterministic_match_confident',
    'llm_escalated', false,
    'deterministic_best_score', 0,
    'deterministic_margin', 1
  );

comment on column public.observation_role_matches.inference_decision is
  'Deterministic-first rationale for escalating or skipping structured role classification.';
