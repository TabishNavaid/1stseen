-- What guest mode needs from the database, and nothing more.
--
-- Guests reach no table directly. The Worker reads for them with the service role through an explicit allowlist
-- (apps/web/lib/public-read-policy.ts). Anon still holds no privilege on anything (migration 202608140024 stands), and
-- every object below is revoked from anon and authenticated explicitly, because this project's default privileges would
-- otherwise grant them.
--
-- 1. A public data version, so edge-cached guest pages can be invalidated when what they show changes: a statement on
--    any table a guest page reads advances a sequence, and the cache key carries its value. A sequence, not a counter
--    row, so concurrent collection transactions never wait on one another to bump it; a rolled-back statement still
--    advances it, which costs one needless cache miss and nothing else. Agent audit tables are left out on purpose:
--    every guest question writes one, and a guest must not be able to empty the cache by asking.
--
-- 2. The agent activity a guest may see: the latest recruiting-agent run that no user started and that stored its
--    state without an actor. A run with an initiating user or an actor id in its state is never returned, so no audit
--    row tied to a user reaches a guest (or another user's dashboard).

-- 0. Anon holds no privilege on anything in public. Migration 202608140024 revoked it on user-owned tables; the reference
--    tables and the provenance view kept Supabase's default grants (every privilege, TRUNCATE included, which RLS does
--    not govern). No policy ever let anon read them, the browser never queries Supabase, and guests are served by the
--    Worker's service-role reader, so revoking changes nothing that works. Default privileges stop granting anon on
--    tables, sequences, and functions this role creates later. authenticated is unchanged.

revoke all on
  public.archive_captures, public.canonical_roles, public.companies, public.forecast_evidence, public.forecasts,
  public.historical_opening_events, public.observation_role_matches, public.raw_job_observations, public.role_aliases,
  public.signals, public.source_discovery_evidence, public.source_fetches, public.sources, public.forecast_provenance
from anon;

alter default privileges for role postgres in schema public revoke all on tables from anon;
alter default privileges for role postgres in schema public revoke all on sequences from anon;
alter default privileges for role postgres in schema public revoke all on functions from anon;

create sequence public.public_data_version_seq;
revoke all on sequence public.public_data_version_seq from public, anon, authenticated;
grant select, usage on sequence public.public_data_version_seq to service_role;

create or replace function public.bump_public_data_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform nextval('public.public_data_version_seq');
  return null;
end;
$$;
revoke all on function public.bump_public_data_version() from public, anon, authenticated;

do $$
declare
  relation text;
begin
  foreach relation in array array[
    'companies', 'sources', 'source_fetches', 'canonical_roles', 'role_aliases', 'raw_job_observations',
    'observation_role_matches', 'historical_opening_events', 'forecasts', 'forecast_evidence', 'forecast_changes',
    'signals', 'backtest_runs', 'backtest_cases'
  ] loop
    execute format(
      'create trigger %I after insert or update or delete or truncate on public.%I '
      'for each statement execute function public.bump_public_data_version()',
      relation || '_bumps_public_data_version',
      relation
    );
  end loop;
end;
$$;

create or replace function public.public_data_version()
returns bigint
language sql
stable
set search_path = ''
as $$
  -- A sequence's last_value does not move on its first nextval, so it reads 0 until the first bump.
  select case when is_called then last_value else 0 end from public.public_data_version_seq
$$;
revoke all on function public.public_data_version() from public, anon, authenticated;
grant execute on function public.public_data_version() to service_role;

create or replace function public.public_agent_activity()
returns table (
  run_id uuid,
  status text,
  started_at timestamptz,
  finished_at timestamptz,
  calls jsonb
)
language sql
stable
set search_path = ''
as $$
  select
    r.id,
    r.status::text,
    r.started_at,
    r.finished_at,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'tool_name', c.tool_name,
            'status', c.status::text,
            'output_redacted', c.output_redacted,
            'started_at', c.started_at,
            'finished_at', c.finished_at
          )
          order by c.started_at
        )
        from (
          select *
          from public.agent_tool_calls t
          where t.agent_run_id = r.id
          order by t.started_at
          limit 20
        ) c
      ),
      '[]'::jsonb
    )
  from public.agent_runs r
  where r.agent_name = 'recruiting_agent'
    and r.initiated_by is null
    and r.metadata ? 'state'
    and coalesce(r.metadata -> 'state' -> 'actor_id', 'null'::jsonb) = 'null'::jsonb
  order by r.started_at desc
  limit 1
$$;
revoke all on function public.public_agent_activity() from public, anon, authenticated;
grant execute on function public.public_agent_activity() to service_role;

comment on function public.public_agent_activity() is
  'The latest recruiting-agent run started by no user and stored without an actor. Never an audit row tied to a user.';
comment on sequence public.public_data_version_seq is
  'Advanced by any statement on a table guest pages read; edge-cached guest pages are keyed by its value.';
