-- Google Calendar connections are explicit, user-owned integrations. OAuth credentials
-- remain service-role only; authenticated clients can read only non-secret sync mappings.

create table public.google_calendar_connections (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  calendar_id text not null default 'primary',
  google_account_label text,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text not null,
  token_expires_at timestamptz not null,
  scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_error_code text,
  last_error_at timestamptz,
  check (array_position(scopes, null) is null)
);

comment on table public.google_calendar_connections is
  'Service-role-only encrypted Google OAuth credentials. Never expose this table through a client query.';

create table public.calendar_event_syncs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null default 'google' check (provider = 'google'),
  source_kind text not null check (
    source_kind in ('readiness_milestone', 'forecast_window', 'confirmed_opening', 'confirmed_closing')
  ),
  source_key text not null,
  canonical_role_id uuid references public.canonical_roles(id) on delete set null,
  readiness_milestone_id uuid references public.readiness_milestones(id) on delete set null,
  forecast_id uuid references public.forecasts(id) on delete set null,
  google_calendar_id text not null,
  google_event_id text not null,
  event_fingerprint text not null check (event_fingerprint ~ '^[a-f0-9]{64}$'),
  status text not null default 'active' check (status in ('active', 'detached', 'error')),
  last_synced_at timestamptz not null default now(),
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider, source_kind, source_key),
  unique (user_id, provider, google_calendar_id, google_event_id)
);

create index calendar_event_syncs_user_status_idx
  on public.calendar_event_syncs (user_id, status, last_synced_at desc);

create trigger google_calendar_connections_set_updated_at
before update on public.google_calendar_connections
for each row execute function public.set_updated_at();

create trigger calendar_event_syncs_set_updated_at
before update on public.calendar_event_syncs
for each row execute function public.set_updated_at();

alter table public.google_calendar_connections enable row level security;
alter table public.calendar_event_syncs enable row level security;

-- There are deliberately no authenticated policies on the credential table.
revoke all on public.google_calendar_connections from anon, authenticated;

grant select on public.calendar_event_syncs to authenticated;
revoke insert, update, delete on public.calendar_event_syncs from authenticated;

create policy "users read their calendar sync mappings"
on public.calendar_event_syncs for select to authenticated
using (auth.uid() = user_id);

comment on table public.calendar_event_syncs is
  'Explicit user-selected event mappings. The unique source key and persisted Google event ID prevent duplicate creation.';
