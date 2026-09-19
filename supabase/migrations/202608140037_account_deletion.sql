-- Account export and deletion. docs/account-data.md is the contract.
--
-- A signed-in user can download everything the account holds (GET /api/account/export) and delete the account
-- (POST /api/auth/delete-account). The route revokes Google tokens first, then calls delete_account_data, then deletes
-- the auth user with the Auth admin API, then calls finish_account_deletion.
--
-- Purely additive: one service-only table, three service-only functions, and four partial indexes. No existing table,
-- column, constraint, policy, or grant changes.
--
-- Why the rows are deleted here rather than left to the auth.users -> profiles cascade:
--
-- - agent_runs.initiated_by is ON DELETE SET NULL. A run holds the question the user typed and their id inside its
--   stored state and its tool calls' inputs, so the cascade would keep the question, detached but still personal, and
--   keep the id in JSON. Runs that are the user's are deleted, with their tool calls and model_usage rows.
-- - email_digest_items.readiness_milestone_id is ON DELETE RESTRICT, and RESTRICT is checked row by row during the
--   cascade. Deleting the auth user of anyone whose digest listed one of their own milestones fails with 23503 when the
--   milestone is reached before the item (measured on the rig). Deliveries and their items go first here.
-- - auth.flow_state.user_id has no foreign key, so Supabase Auth leaves PKCE state rows behind (383 on the rig), and
--   auth.audit_log_entries keeps the id and email of every deleted user in its JSON payload. finish_account_deletion
--   removes both once the auth user is gone.
--
-- One definition of which agent runs are the account's, used by both the export and the deletion.

create or replace function public.account_agent_run_ids(p_user_id uuid)
returns table (run_id uuid)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.id
    from public.agent_runs r
   where r.initiated_by = p_user_id
      or (r.metadata -> 'state' ->> 'actor_id') = p_user_id::text
  union
  select t.agent_run_id
    from public.agent_tool_calls t
   where (t.input_redacted ->> 'actor_id') = p_user_id::text
$$;

comment on function public.account_agent_run_ids(uuid) is
  'The recruiting-agent runs an account asked: started by it, or with its id as the actor in the stored state or a tool call input. Service role only.';

create index if not exists agent_runs_initiated_by_idx
  on public.agent_runs (initiated_by) where initiated_by is not null;
create index if not exists agent_runs_state_actor_idx
  on public.agent_runs ((metadata -> 'state' ->> 'actor_id')) where (metadata -> 'state' ->> 'actor_id') is not null;
create index if not exists agent_tool_calls_actor_idx
  on public.agent_tool_calls ((input_redacted ->> 'actor_id')) where (input_redacted ->> 'actor_id') is not null;
-- The agent_runs -> model_usage cascade looks rows up by run; without this each deleted run scans the table.
create index if not exists model_usage_agent_run_idx
  on public.model_usage (agent_run_id) where agent_run_id is not null;

-- Every row in public the account owns, except its profile, in one transaction. The profile goes with the auth user
-- (profiles.id references auth.users on delete cascade), so a failure between this call and the Auth admin call leaves
-- a signed-in account with a profile and nothing else, and repeating the request finishes it.
--
-- Returns the number of rows deleted per table: counts only, never an id.

create or replace function public.delete_account_data(p_user_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  counts jsonb := '{}'::jsonb;
  deleted integer;
  run_ids uuid[];
begin
  if p_user_id is null then
    raise exception 'delete_account_data needs an account id' using errcode = '22004';
  end if;

  -- Serialize two deletions of one account.
  perform 1 from public.profiles where id = p_user_id for update;

  select coalesce(array_agg(run_id), '{}'::uuid[]) into run_ids from public.account_agent_run_ids(p_user_id);

  delete from public.email_digest_items i
   using public.email_digest_deliveries d
   where i.delivery_id = d.id and d.user_id = p_user_id;
  get diagnostics deleted = row_count;
  counts := counts || jsonb_build_object('email_digest_items', deleted);

  delete from public.email_digest_deliveries where user_id = p_user_id;
  get diagnostics deleted = row_count;
  counts := counts || jsonb_build_object('email_digest_deliveries', deleted);

  delete from public.calendar_event_syncs where user_id = p_user_id;
  get diagnostics deleted = row_count;
  counts := counts || jsonb_build_object('calendar_event_syncs', deleted);

  delete from public.readiness_milestones where user_id = p_user_id;
  get diagnostics deleted = row_count;
  counts := counts || jsonb_build_object('readiness_milestones', deleted);

  delete from public.watchlist_items where user_id = p_user_id;
  get diagnostics deleted = row_count;
  counts := counts || jsonb_build_object('watchlist_items', deleted);

  delete from public.watchlists where user_id = p_user_id;
  get diagnostics deleted = row_count;
  counts := counts || jsonb_build_object('watchlists', deleted);

  delete from public.priority_companies where user_id = p_user_id;
  get diagnostics deleted = row_count;
  counts := counts || jsonb_build_object('priority_companies', deleted);

  delete from public.recruiting_preferences where user_id = p_user_id;
  get diagnostics deleted = row_count;
  counts := counts || jsonb_build_object('recruiting_preferences', deleted);

  delete from public.google_calendar_connections where user_id = p_user_id;
  get diagnostics deleted = row_count;
  counts := counts || jsonb_build_object('google_calendar_connections', deleted);

  delete from public.gmail_connections where user_id = p_user_id;
  get diagnostics deleted = row_count;
  counts := counts || jsonb_build_object('gmail_connections', deleted);

  delete from public.model_usage where agent_run_id = any(run_ids);
  get diagnostics deleted = row_count;
  counts := counts || jsonb_build_object('model_usage', deleted);

  delete from public.agent_tool_calls where agent_run_id = any(run_ids);
  get diagnostics deleted = row_count;
  counts := counts || jsonb_build_object('agent_tool_calls', deleted);

  delete from public.agent_runs where id = any(run_ids);
  get diagnostics deleted = row_count;
  counts := counts || jsonb_build_object('agent_runs', deleted);

  return counts;
end;
$$;

comment on function public.delete_account_data(uuid) is
  'Deletes every public row an account owns except its profile, in one transaction, and returns per-table counts. Service role only; called by /api/auth/delete-account after Google revocation and before the Auth admin deletion.';

-- That a deletion happened, with nothing that identifies whose: the day, per-table counts, what Google said about each
-- token, and what happened to synced calendar events. No account id, email, or timestamp finer than a day.

create table public.account_deletions (
  id uuid primary key default gen_random_uuid(),
  deleted_on date not null default current_date,
  rows_deleted jsonb not null check (
    jsonb_typeof(rows_deleted) = 'object'
    and not jsonb_path_exists(rows_deleted, '$.* ? (@.type() != "number")')
  ),
  google_calendar_revocation text not null check (
    google_calendar_revocation in ('not_connected', 'revoked', 'already_invalid', 'unconfirmed', 'not_revocable')
  ),
  gmail_revocation text not null check (
    gmail_revocation in ('not_connected', 'revoked', 'already_invalid', 'unconfirmed', 'not_revocable')
  ),
  synced_calendar_events text not null check (synced_calendar_events in ('none', 'kept', 'removed', 'not_removed'))
);

alter table public.account_deletions enable row level security;
revoke all on public.account_deletions from public, anon, authenticated;

comment on table public.account_deletions is
  'One row per completed account deletion, holding no personal data: the day, per-table counts, Google revocation outcomes, and the synced-event choice. Service role only.';

-- After the Auth admin API has deleted the auth user: remove what Supabase Auth leaves behind for that id, and record
-- the deletion. Refuses while the auth user or its profile still exists, so it can never erase a live account's
-- sign-in history. SECURITY DEFINER because service_role holds no privilege on the auth schema; it touches only the two
-- auth tables named below, by that one id.

create or replace function public.finish_account_deletion(
  p_user_id uuid,
  p_rows_deleted jsonb,
  p_google_calendar_revocation text,
  p_gmail_revocation text,
  p_synced_calendar_events text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  record_id uuid;
begin
  if p_user_id is null then
    raise exception 'finish_account_deletion needs an account id' using errcode = '22004';
  end if;
  if exists (select 1 from auth.users where id = p_user_id) or exists (select 1 from public.profiles where id = p_user_id) then
    raise exception 'the account still exists' using errcode = '55000';
  end if;

  delete from auth.flow_state where user_id = p_user_id;
  delete from auth.audit_log_entries
   where (payload ->> 'actor_id') = p_user_id::text
      or (payload -> 'traits' ->> 'user_id') = p_user_id::text;

  insert into public.account_deletions (rows_deleted, google_calendar_revocation, gmail_revocation, synced_calendar_events)
  values (coalesce(p_rows_deleted, '{}'::jsonb), p_google_calendar_revocation, p_gmail_revocation, p_synced_calendar_events)
  returning id into record_id;
  return record_id;
end;
$$;

comment on function public.finish_account_deletion(uuid, jsonb, text, text, text) is
  'Once an auth user is deleted: removes its auth.flow_state rows and its auth.audit_log_entries, and records the deletion in account_deletions without personal data. Service role only.';

-- A deletion never waits on Google: a token Google did not answer about is recorded 'unconfirmed' and offered to Google
-- again after the response, from memory (lib/account/deletion.ts). When Google then confirms, or refuses for good, the
-- anonymous record says so. Only an 'unconfirmed' value can change, so a confirmed outcome is never overwritten.

create or replace function public.record_late_google_revocation(p_deletion_id uuid, p_provider text, p_outcome text)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  changed integer;
begin
  if p_outcome not in ('revoked', 'already_invalid', 'not_revocable') then
    raise exception 'a late revocation outcome is revoked, already_invalid, or not_revocable, not %', p_outcome using errcode = '22023';
  end if;
  if p_provider = 'google_calendar' then
    update public.account_deletions set google_calendar_revocation = p_outcome
     where id = p_deletion_id and google_calendar_revocation = 'unconfirmed';
  elsif p_provider = 'gmail' then
    update public.account_deletions set gmail_revocation = p_outcome
     where id = p_deletion_id and gmail_revocation = 'unconfirmed';
  else
    raise exception 'unknown Google connection %', p_provider using errcode = '22023';
  end if;
  get diagnostics changed = row_count;
  return changed = 1;
end;
$$;

comment on function public.record_late_google_revocation(uuid, text, text) is
  'Records what Google said, after the response, about a token it did not answer about during a deletion. Only an unconfirmed outcome changes. Service role only.';

revoke all on function public.account_agent_run_ids(uuid) from public, anon, authenticated;
revoke all on function public.delete_account_data(uuid) from public, anon, authenticated;
revoke all on function public.finish_account_deletion(uuid, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.account_agent_run_ids(uuid) to service_role;
grant execute on function public.delete_account_data(uuid) to service_role;
grant execute on function public.finish_account_deletion(uuid, jsonb, text, text, text) to service_role;
revoke all on function public.record_late_google_revocation(uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_late_google_revocation(uuid, text, text) to service_role;
