-- Regeneration re-forecasts a role when its evidence changes, and finds such roles from rows created after its cursor
-- (repository.changed_role_ids_since): new fetches, opening events, signals, and scope decisions. A row that changes,
-- moves, or goes creates nothing. An opening event re-dated by reconstruction (an upsert on its natural key), moved to
-- another program by a re-resolution (split_canonical_role, 202608140034), or erased (docs/takedown.md) left the roles on
-- both sides with a forecast built from evidence they no longer hold. On the rig a Neuralink program showed "3 cycles
-- behind it" beside the 2 openings it still had, because one had moved to another role after its forecast.
--
-- role_evidence_changes is the record of those roles: a trigger on the tables a forecast is built from writes the role
-- a row belonged to when the row is updated or deleted, and also the role it moved to. An update that changes nothing
-- (reconstruction re-upserting the same event) writes nothing, so a routine pass does not re-forecast every role.
-- Regeneration reads it as one more source of changed roles. Service-only, like every table the worker writes.

create table public.role_evidence_changes (
  id bigint generated always as identity primary key,
  canonical_role_id uuid not null,
  changed_at timestamptz not null default clock_timestamp(),
  change text not null check (change in ('updated', 'moved_out', 'moved_in', 'deleted', 'backfill')),
  relation text not null
);

create index role_evidence_changes_changed_at_idx on public.role_evidence_changes (changed_at);

alter table public.role_evidence_changes enable row level security;
revoke all on public.role_evidence_changes from public, anon, authenticated;
-- Automation-only: no policy, so RLS denies everyone but the service role, which bypasses it.

comment on table public.role_evidence_changes is
  'Roles whose forecast evidence was updated, moved, or deleted without a new row being created; read by forecast regeneration.';

create or replace function public.record_role_evidence_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.canonical_role_id is not null then
      insert into public.role_evidence_changes (canonical_role_id, change, relation)
      values (old.canonical_role_id, 'deleted', tg_table_name);
    end if;
    return null;
  end if;
  if old.canonical_role_id is distinct from new.canonical_role_id then
    if old.canonical_role_id is not null then
      insert into public.role_evidence_changes (canonical_role_id, change, relation)
      values (old.canonical_role_id, 'moved_out', tg_table_name);
    end if;
    if new.canonical_role_id is not null then
      insert into public.role_evidence_changes (canonical_role_id, change, relation)
      values (new.canonical_role_id, 'moved_in', tg_table_name);
    end if;
  elsif new.canonical_role_id is not null then
    insert into public.role_evidence_changes (canonical_role_id, change, relation)
    values (new.canonical_role_id, 'updated', tg_table_name);
  end if;
  return null;
end;
$$;

revoke all on function public.record_role_evidence_change() from public, anon, authenticated;

create trigger historical_opening_events_record_role_change
  after update on public.historical_opening_events
  for each row when (old.* is distinct from new.*)
  execute function public.record_role_evidence_change();
create trigger historical_opening_events_record_role_removal
  after delete on public.historical_opening_events
  for each row execute function public.record_role_evidence_change();

create trigger observation_role_matches_record_role_change
  after update on public.observation_role_matches
  for each row when (old.* is distinct from new.*)
  execute function public.record_role_evidence_change();
create trigger observation_role_matches_record_role_removal
  after delete on public.observation_role_matches
  for each row execute function public.record_role_evidence_change();

create trigger signals_record_role_change
  after update on public.signals
  for each row when (old.* is distinct from new.*)
  execute function public.record_role_evidence_change();
create trigger signals_record_role_removal
  after delete on public.signals
  for each row execute function public.record_role_evidence_change();

-- Re-resolutions already run moved evidence before this record existed. Their roles on both sides are marked now, so
-- the next regeneration re-forecasts them.
insert into public.role_evidence_changes (canonical_role_id, change, relation)
select distinct role_id, 'backfill', 'role_identity_migrations'
from public.role_identity_migrations m
cross join lateral (values (m.source_role_id), (m.target_role_id)) as roles(role_id)
where role_id is not null;
