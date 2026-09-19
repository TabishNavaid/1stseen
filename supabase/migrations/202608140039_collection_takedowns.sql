-- Stopping collection on request, and withdrawing a company from the product (docs/takedown.md).
--
-- `sources.enabled` has always been the switch every collector reads: `list_source_configs` selects enabled sources
-- only, and current, historical, signal, and enrichment runs all start from it. What was missing is a record of who
-- turned a source off, when, and why, and a way to remember that a whole company asked to be left alone, so that
-- re-running discovery or registering a board cannot quietly turn it back on.
--
-- `collection_takedowns` is that record: append-only, one row per action, and service-only like every table the worker
-- writes. `apply_collection_takedown` performs an action and writes its row in one transaction.
--
--   disable   One source, or with no source every source of a company. Collection stops; nothing else changes.
--   withdraw  Every source of a company, and every one of its canonical roles set `active = false`. That takes the
--             roles off every product read path (migration 202608140036) and out of every other role's priors
--             (`repository.load_backtest_dataset` reads active roles and their evidence only). Nothing is deleted:
--             raw observations, events, forecasts, and follows stay, unreachable from the product.
--   enable    One source; or, with no source, lift the company-wide holds recorded since the last company-wide enable.
--             That re-enables exactly the sources those holds turned off, except one disabled on its own since, and
--             reactivates exactly the roles a withdrawal deactivated, except one superseded since.
--   erase     Written only by the manual erasure step in docs/takedown.md, never by the function below: a verified
--             request to erase what was collected from a withdrawn company. `role_ids` are the roles it deleted.
--
-- A company is held while its latest company-wide action is `disable`, `withdraw`, or `erase`. While it is held,
-- discovery and board registration refuse to save its sources, and one of its sources cannot be enabled on its own.
--
-- The foreign keys restrict deletion on purpose: the record of a request outlives an erasure of what was collected,
-- because it is what stops the company from being collected again.

create table public.collection_takedowns (
  id uuid primary key default gen_random_uuid(),
  -- clock_timestamp, not now(): two actions in one transaction still have an order.
  recorded_at timestamptz not null default clock_timestamp(),
  company_id uuid not null references public.companies(id) on delete restrict,
  source_id uuid references public.sources(id) on delete restrict,
  action text not null,
  reason text not null,
  requested_by text not null,
  source_ids uuid[] not null default '{}',
  role_ids uuid[] not null default '{}',
  constraint collection_takedowns_action_check check (action in ('disable', 'enable', 'withdraw', 'erase')),
  constraint collection_takedowns_withdraw_is_company_wide check (action not in ('withdraw', 'erase') or source_id is null),
  constraint collection_takedowns_disable_keeps_roles check (action <> 'disable' or cardinality(role_ids) = 0),
  constraint collection_takedowns_reason_check check (octet_length(btrim(reason)) between 1 and 2000),
  constraint collection_takedowns_requested_by_check check (octet_length(btrim(requested_by)) between 1 and 200)
);

comment on table public.collection_takedowns is
  'Append-only record of every stop, resume, withdrawal, and erasure of collection: who, when, why, and exactly what changed.';
comment on column public.collection_takedowns.source_id is
  'The one source acted on, or null for the whole company.';
comment on column public.collection_takedowns.source_ids is
  'Sources whose enabled flag this action changed.';
comment on column public.collection_takedowns.role_ids is
  'Canonical roles whose active flag this action changed; for an erase, the roles it deleted.';

create index collection_takedowns_company_idx on public.collection_takedowns (company_id, recorded_at desc);
create index collection_takedowns_source_idx on public.collection_takedowns (source_id, recorded_at desc)
  where source_id is not null;

alter table public.collection_takedowns enable row level security;
revoke all on public.collection_takedowns from anon, authenticated;
-- Automation-only: no policy, so RLS denies everyone but the service role, which bypasses it.

create function public.apply_collection_takedown(
  p_company_id uuid,
  p_source_id uuid,
  p_action text,
  p_reason text,
  p_requested_by text
) returns public.collection_takedowns
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_since timestamptz;
  v_held boolean;
  v_sources uuid[] := '{}';
  v_roles uuid[] := '{}';
  v_row public.collection_takedowns;
begin
  if p_action is null or p_action not in ('disable', 'enable', 'withdraw') then
    raise exception 'unknown takedown action %', p_action using errcode = '22023';
  end if;
  if p_action = 'withdraw' and p_source_id is not null then
    raise exception 'a withdrawal covers the whole company, not one source' using errcode = '22023';
  end if;

  -- One takedown at a time per company, so a hold and its lifting cannot interleave.
  perform 1 from public.companies where id = p_company_id for update;
  if not found then
    raise exception 'unknown company %', p_company_id using errcode = 'P0002';
  end if;
  if p_source_id is not null then
    perform 1 from public.sources where id = p_source_id and company_id = p_company_id;
    if not found then
      raise exception 'source % is not a source of company %', p_source_id, p_company_id using errcode = 'P0002';
    end if;
  end if;

  select coalesce(max(t.recorded_at), '-infinity'::timestamptz) into v_since
  from public.collection_takedowns t
  where t.company_id = p_company_id and t.source_id is null and t.action = 'enable';
  v_held := exists (
    select 1 from public.collection_takedowns t
    where t.company_id = p_company_id and t.source_id is null
      and t.action in ('disable', 'withdraw', 'erase') and t.recorded_at > v_since
  );

  if p_action in ('disable', 'withdraw') then
    with changed as (
      update public.sources s set enabled = false
      where s.company_id = p_company_id and (p_source_id is null or s.id = p_source_id) and s.enabled
      returning s.id
    )
    select coalesce(array_agg(changed.id order by changed.id), '{}') into v_sources from changed;

    if p_action = 'withdraw' then
      with changed as (
        update public.canonical_roles r set active = false
        where r.company_id = p_company_id and r.active
        returning r.id
      )
      select coalesce(array_agg(changed.id order by changed.id), '{}') into v_roles from changed;
    end if;

  elsif p_source_id is not null then
    if v_held then
      raise exception 'company % is held or withdrawn; lift the company-wide hold before enabling one of its sources',
        p_company_id using errcode = 'P0001';
    end if;
    with changed as (
      update public.sources s set enabled = true
      where s.id = p_source_id and not s.enabled
      returning s.id
    )
    select coalesce(array_agg(changed.id), '{}') into v_sources from changed;

  else
    if not v_held then
      raise exception 'company % has no company-wide hold to lift; enable its sources one at a time', p_company_id
        using errcode = 'P0001';
    end if;
    with holds as (
      select t.source_ids, t.role_ids, t.action
      from public.collection_takedowns t
      where t.company_id = p_company_id and t.source_id is null
        and t.action in ('disable', 'withdraw', 'erase') and t.recorded_at > v_since
    ),
    kept_off as (
      -- A source disabled on its own stays off when its company's hold is lifted.
      select latest.source_id
      from (
        select distinct on (t.source_id) t.source_id, t.action
        from public.collection_takedowns t
        where t.company_id = p_company_id and t.source_id is not null
        order by t.source_id, t.recorded_at desc, t.id desc
      ) latest
      where latest.action = 'disable'
    ),
    changed as (
      update public.sources s set enabled = true
      where s.id in (select unnest(h.source_ids) from holds h)
        and s.id not in (select k.source_id from kept_off k)
        and not s.enabled
      returning s.id
    )
    select coalesce(array_agg(changed.id order by changed.id), '{}') into v_sources from changed;

    with holds as (
      select t.role_ids
      from public.collection_takedowns t
      where t.company_id = p_company_id and t.source_id is null
        and t.action = 'withdraw' and t.recorded_at > v_since
    ),
    changed as (
      update public.canonical_roles r set active = true
      where r.id in (select unnest(h.role_ids) from holds h)
        and not r.active
        and r.superseded_at is null
      returning r.id
    )
    select coalesce(array_agg(changed.id order by changed.id), '{}') into v_roles from changed;
  end if;

  insert into public.collection_takedowns (company_id, source_id, action, reason, requested_by, source_ids, role_ids)
  values (p_company_id, p_source_id, p_action, btrim(p_reason), btrim(p_requested_by), v_sources, v_roles)
  returning * into v_row;
  return v_row;
end;
$$;

comment on function public.apply_collection_takedown(uuid, uuid, text, text, text) is
  'Disable, enable, or withdraw collection for a source or a company, and record it, in one transaction (docs/takedown.md).';

revoke all on function public.apply_collection_takedown(uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.apply_collection_takedown(uuid, uuid, text, text, text) to service_role;
