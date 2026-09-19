-- Durable cursors for scheduled collection follow-up work. Service role only.

create table public.collection_checkpoints (
  pipeline text primary key check (pipeline ~ '^[a-z0-9]+(_[a-z0-9]+)*$'),
  cursor_at timestamptz not null,
  last_run_id uuid references public.agent_runs(id) on delete set null,
  last_status public.run_status not null,
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.collection_checkpoints enable row level security;
revoke all on public.collection_checkpoints from anon, authenticated;

comment on table public.collection_checkpoints is
  'Service-only scheduled-pipeline cursors. A cursor advances only after a fully successful pass; idempotent outputs make retries safe.';
