-- Observable RecruitingAgent state and audit guarantees.

alter table public.agent_runs
  add constraint agent_runs_no_private_reasoning check (
    not (metadata ? 'chain_of_thought')
    and not (metadata ? 'private_reasoning')
    and not (coalesce(metadata -> 'state', '{}'::jsonb) ? 'chain_of_thought')
    and not (coalesce(metadata -> 'state', '{}'::jsonb) ? 'private_reasoning')
  );

create index agent_runs_agent_started_idx
  on public.agent_runs (agent_name, started_at desc);

comment on column public.agent_runs.metadata is
  'Versioned observable agent state: resolved entities, known facts, unresolved questions, evidence, tool calls, tool-produced forecast/readiness output, and final answer. Never private chain-of-thought.';

comment on table public.agent_tool_calls is
  'Audited observable tool actions with redacted inputs and bounded result summaries.';
