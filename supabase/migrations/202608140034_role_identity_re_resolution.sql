-- Role identity: splitting a canonical role that merged two programs, without losing anything.
--
-- `role_resolution` treated an `unknown` level as compatible with every level, so an unmarked
-- "Research Engineer" merged with "Research Intern". On the validation corpus that produced 52
-- alias_conflict merges across 18 companies, 31 of them an early-career program joined to
-- experienced postings — which hid the early-career program from the product entirely, because a
-- merged role is ambiguous and ambiguous roles are never surfaced or forecast.
--
-- A title-stated early-career type is now a hard identity incompatibility, so those roles have to be
-- re-keyed. Re-keying is not something a migration can compute — it needs the resolver — so this
-- migration supplies the transaction the worker performs one split inside, and the audit trail
-- a resolver version change must leave.
--
-- Nothing is deleted. A role that loses every observation is retired, not dropped: its forecasts,
-- backtest cases and digest items stay exactly where they were, because a historical prediction is
-- never mutated in place, and `active = false` is what keeps it out of every read path.

alter table public.canonical_roles
  add column superseded_by uuid references public.canonical_roles(id) on delete set null,
  add column superseded_at timestamptz;

comment on column public.canonical_roles.superseded_by is
  'The role that inherited this one''s evidence when a re-resolution split it. Its own forecasts stay.';

alter table public.canonical_roles
  add constraint canonical_roles_superseded_together check ((superseded_by is null) = (superseded_at is null)),
  add constraint canonical_roles_superseded_is_inactive check (superseded_at is null or active = false),
  add constraint canonical_roles_superseded_by_is_another_role check (superseded_by is null or superseded_by <> id);

create index canonical_roles_superseded_by_idx on public.canonical_roles (superseded_by)
  where superseded_by is not null;

-- One row per (source role, target role) a re-resolution produced: what moved, and why.
create table public.role_identity_migrations (
  id uuid primary key default gen_random_uuid(),
  ran_at timestamptz not null default now(),
  resolver_version_from text not null,
  resolver_version_to text not null,
  source_role_id uuid not null references public.canonical_roles(id) on delete cascade,
  target_role_id uuid not null references public.canonical_roles(id) on delete cascade,
  reason text not null,
  stated_types text[] not null default '{}',
  observations_moved integer not null default 0,
  aliases_moved integer not null default 0,
  opening_events_moved integer not null default 0,
  watchlist_items_moved integer not null default 0,
  readiness_milestones_moved integer not null default 0,
  source_retired boolean not null default false,
  constraint role_identity_migrations_reason_check check (octet_length(reason) between 1 and 500),
  constraint role_identity_migrations_versions_check check (
    octet_length(resolver_version_from) <= 80 and octet_length(resolver_version_to) <= 80
  ),
  constraint role_identity_migrations_moves_a_role check (source_role_id <> target_role_id)
);

comment on table public.role_identity_migrations is
  'Audit of every canonical-role re-key: which role split into which, what moved, and under which resolver versions.';

create index role_identity_migrations_source_idx on public.role_identity_migrations (source_role_id);
create index role_identity_migrations_target_idx on public.role_identity_migrations (target_role_id);
create index role_identity_migrations_ran_at_idx on public.role_identity_migrations (ran_at desc);

alter table public.role_identity_migrations enable row level security;
revoke all on public.role_identity_migrations from anon, authenticated;
-- Automation-only, like every other table the worker writes: no policy, so RLS denies everyone but
-- the service role, which bypasses it.

/*
  Move one program out of a merged canonical role, in one transaction.

  `p_observation_ids` are the observations whose titles state `p_stated_types`; they and everything
  derived from them move to a new canonical role that inherits the source's company, family, season,
  specialization and location scope. The new role is left unclassified on purpose, so
  `firstseen classify-roles` decides its scope from its own titles rather than inheriting a
  judgement made about a different program.

  What moves: the observations' role matches, the aliases those observations supplied, and their
  historical opening events. What moves only when the source is left with nothing: the watchlist
  follows and readiness milestones, which belong to the program, not to the row. What never moves:
  forecasts, forecast evidence, backtest cases and digest items, because they record what was
  predicted from the evidence as it stood, and rewriting them would be rewriting history.
*/
create function public.split_canonical_role(
  p_source_role_id uuid,
  p_canonical_title text,
  p_normalized_title text,
  p_level text,
  p_recurrence_key text,
  p_observation_ids uuid[],
  p_stated_types text[],
  p_reason text,
  p_resolver_version_from text,
  p_resolver_version_to text,
  p_source_canonical_title text default null,
  p_source_normalized_title text default null,
  p_source_level text default null
) returns uuid
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_source public.canonical_roles;
  v_target_id uuid;
  v_observations integer;
  v_aliases integer;
  v_events integer;
  v_watchlist integer := 0;
  v_milestones integer := 0;
  v_remaining integer;
  v_retired boolean := false;
begin
  if array_length(p_observation_ids, 1) is null then
    raise exception 'split_canonical_role needs at least one observation to move'
      using errcode = 'P0001';
  end if;

  select * into v_source from public.canonical_roles where id = p_source_role_id for update;
  if not found then
    raise exception 'unknown canonical role %', p_source_role_id using errcode = 'P0002';
  end if;

  -- Every observation named must currently belong to the source, or the caller is working from a
  -- stale read and the split would move another role's evidence.
  select count(*) into v_observations
  from public.observation_role_matches m
  where m.canonical_role_id = p_source_role_id and m.observation_id = any (p_observation_ids);
  if v_observations <> array_length(p_observation_ids, 1) then
    raise exception 'only % of % observations still belong to role %',
      v_observations, array_length(p_observation_ids, 1), p_source_role_id
      using errcode = 'P0002';
  end if;

  insert into public.canonical_roles (
    company_id, canonical_title, track, location_scope, recurrence_key, company_normalized,
    normalized_title, role_family, level, recruiting_season, specialization, feature_profile,
    description_prototype, resolver_version
  )
  values (
    -- The track follows the level, the same mapping `save_role_resolution` uses: a new-grad program
    -- split out of an internship role is a new-grad program, and its page says so.
    v_source.company_id, p_canonical_title,
    (case p_level
       when 'internship' then 'internship'
       when 'new_grad' then 'new_grad'
       when 'apprenticeship' then 'apprenticeship'
       else 'other'
     end)::public.role_track,
    v_source.location_scope, p_recurrence_key,
    v_source.company_normalized, p_normalized_title, v_source.role_family, p_level,
    v_source.recruiting_season, v_source.specialization,
    jsonb_set(v_source.feature_profile, '{split_from}', to_jsonb(p_source_role_id::text), true),
    v_source.description_prototype, p_resolver_version_to
  )
  returning id into v_target_id;

  update public.observation_role_matches
     set canonical_role_id = v_target_id, resolver_version = p_resolver_version_to
   where canonical_role_id = p_source_role_id and observation_id = any (p_observation_ids);

  -- An alias belongs to the program whose observation supplied it.
  with moved as (
    update public.role_aliases a
       set canonical_role_id = v_target_id
     where a.canonical_role_id = p_source_role_id
       and a.first_observation_id = any (p_observation_ids)
    returning 1
  )
  select count(*) into v_aliases from moved;

  with moved as (
    update public.historical_opening_events e
       set canonical_role_id = v_target_id
     where e.canonical_role_id = p_source_role_id
       and e.observation_id = any (p_observation_ids)
    returning 1
  )
  select count(*) into v_events from moved;

  select count(*) into v_remaining
  from public.observation_role_matches m
  where m.canonical_role_id = p_source_role_id;

  if v_remaining = 0 then
    with moved as (
      update public.watchlist_items w set canonical_role_id = v_target_id
       where w.canonical_role_id = p_source_role_id returning 1
    )
    select count(*) into v_watchlist from moved;
    with moved as (
      update public.readiness_milestones r set canonical_role_id = v_target_id
       where r.canonical_role_id = p_source_role_id returning 1
    )
    select count(*) into v_milestones from moved;
    update public.canonical_roles
       set active = false, superseded_by = v_target_id, superseded_at = now(), updated_at = now()
     where id = p_source_role_id;
    v_retired := true;
  else
    -- The role that keeps the id may now be named for the program that left it: "Research Engineer,
    -- Self-Driving" holding only interns. Renaming it is normalisation of a derived name, never a
    -- change to an observation, whose raw title stays exactly as the source supplied it.
    update public.canonical_roles
       set canonical_title = coalesce(p_source_canonical_title, canonical_title),
           normalized_title = coalesce(p_source_normalized_title, normalized_title),
           level = coalesce(p_source_level, level),
           track = coalesce(
             (case p_source_level
                when 'internship' then 'internship'
                when 'new_grad' then 'new_grad'
                when 'apprenticeship' then 'apprenticeship'
                when 'full_time' then 'other'
                when 'unknown' then 'other'
              end)::public.role_track,
             track
           ),
           updated_at = now()
     where id = p_source_role_id;
  end if;

  insert into public.role_identity_migrations (
    resolver_version_from, resolver_version_to, source_role_id, target_role_id, reason, stated_types,
    observations_moved, aliases_moved, opening_events_moved, watchlist_items_moved,
    readiness_milestones_moved, source_retired
  )
  values (
    p_resolver_version_from, p_resolver_version_to, p_source_role_id, v_target_id, p_reason,
    p_stated_types, v_observations, v_aliases, v_events, v_watchlist, v_milestones, v_retired
  );

  return v_target_id;
end;
$$;

revoke all on function public.split_canonical_role(
  uuid, text, text, text, text, uuid[], text[], text, text, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.split_canonical_role(
  uuid, text, text, text, text, uuid[], text[], text, text, text, text, text, text
) to service_role;
