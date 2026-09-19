-- Explicit Gmail delivery and immutable deterministic digest delivery snapshots.

create table public.gmail_connections (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  google_account_email text not null,
  access_token_ciphertext text not null,
  refresh_token_ciphertext text not null,
  token_expires_at timestamptz not null,
  scopes text[] not null default '{}',
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_error_code text,
  last_error_at timestamptz,
  check (google_account_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  check (array_position(scopes, null) is null)
);

create table public.email_digest_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  channel text not null default 'gmail' check (channel = 'gmail'),
  digest_version text not null,
  period_start date not null,
  period_end date not null,
  as_of date not null,
  input_fingerprint text not null check (input_fingerprint ~ '^[a-f0-9]{64}$'),
  recipient_email text not null,
  subject text not null,
  structured_payload jsonb not null,
  rendered_html text not null check (octet_length(rendered_html) <= 262144),
  status text not null check (status in ('sending', 'sent', 'failed')),
  external_message_id text,
  attempted_at timestamptz not null default now(),
  sent_at timestamptz,
  failure_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_start <= as_of and as_of <= period_end),
  check ((status = 'sent') = (sent_at is not null and external_message_id is not null)),
  unique (user_id, channel, input_fingerprint)
);

create table public.email_digest_items (
  id uuid primary key default gen_random_uuid(),
  delivery_id uuid not null references public.email_digest_deliveries(id) on delete cascade,
  item_key text not null,
  kind text not null check (kind in (
    'opening_soon', 'forecast_changed', 'role_opened',
    'networking_deadline', 'referral_deadline', 'resume_deadline'
  )),
  canonical_role_id uuid not null references public.canonical_roles(id) on delete restrict,
  forecast_id uuid references public.forecasts(id) on delete restrict,
  forecast_change_id uuid references public.forecast_changes(id) on delete restrict,
  historical_opening_event_id uuid references public.historical_opening_events(id) on delete restrict,
  readiness_milestone_id uuid references public.readiness_milestones(id) on delete restrict,
  event_on date not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (delivery_id, item_key),
  check (
    forecast_id is not null or forecast_change_id is not null
    or historical_opening_event_id is not null or readiness_milestone_id is not null
  )
);

create index email_digest_deliveries_user_time_idx
  on public.email_digest_deliveries (user_id, attempted_at desc);
create index email_digest_items_delivery_kind_idx
  on public.email_digest_items (delivery_id, kind, event_on);

create trigger gmail_connections_set_updated_at before update on public.gmail_connections
for each row execute function public.set_updated_at();
create trigger email_digest_deliveries_set_updated_at before update on public.email_digest_deliveries
for each row execute function public.set_updated_at();

alter table public.gmail_connections enable row level security;
alter table public.email_digest_deliveries enable row level security;
alter table public.email_digest_items enable row level security;

revoke all on public.gmail_connections from anon, authenticated;
grant select on public.email_digest_deliveries, public.email_digest_items to authenticated;
revoke insert, update, delete on public.email_digest_deliveries, public.email_digest_items from authenticated;

create policy "users read their digest deliveries" on public.email_digest_deliveries
for select to authenticated using (auth.uid() = user_id);
create policy "users read their digest items" on public.email_digest_items
for select to authenticated using (
  exists (
    select 1 from public.email_digest_deliveries delivery
    where delivery.id = delivery_id and delivery.user_id = auth.uid()
  )
);

comment on table public.gmail_connections is
  'Service-role-only encrypted Gmail OAuth credentials for explicit user-authorized delivery.';
comment on table public.email_digest_deliveries is
  'Immutable deterministic digest snapshot and idempotent delivery state; one send per user/input fingerprint.';
comment on table public.email_digest_items is
  'Typed digest items linked to the recruiting records that supplied every event and date.';
