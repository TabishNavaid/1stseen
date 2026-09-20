-- The trim works a bounded number of rows at a time, because a call has eight seconds.
--
-- Migration 047 shortened all of it in one statement. PostgREST connects as `authenticator`, which carries
-- `statement_timeout=8s`, and three full-table updates over 24,000 observations, 13,000 roles and 17,000 events do not
-- finish in eight seconds: the first scheduled run to call it failed with 57014, "canceling statement due to statement
-- timeout", and changed nothing. The collection run itself was unaffected, because the step cannot fail it.
--
-- So the work is chunked and the caller loops. Each call shortens at most `p_limit` rows per column and reports how
-- many rows of each kind are still longer than `p_keep`, so the caller knows whether to call again; a run stops when
-- nothing remains or its budget is spent, and the next run continues. Every call is idempotent and order does not
-- matter: a row this call shortens is not a row the next call selects.
--
-- The rules of 047 are unchanged, and are the whole point of the function: in-scope and ambiguous roles keep
-- everything, and so does a posting nothing has resolved yet, because resolution reads its text.
--
-- 200 rows a column is measured, not guessed. On a copy of the rig corpus the whole trim converged in 47 calls with the
-- slowest call taking 1.4 s; at 500 it converged in 19 calls but one took 3.7 s, which is too near eight seconds on a
-- machine faster than a shared production instance. The caller loops within its own budget and the next run continues
-- whatever this one does not finish.

drop function if exists public.trim_out_of_scope_text(integer);

create or replace function public.trim_out_of_scope_text(p_keep integer default 300, p_limit integer default 200)
returns table (
  observations integer,
  roles integer,
  events integer,
  remaining_observations bigint,
  remaining_roles bigint,
  remaining_events bigint
)
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_observations integer;
  v_roles integer;
  v_events integer;
begin
  if p_keep is null or p_keep < 1 or p_keep > 8192 then
    raise exception 'p_keep must be between 1 and 8192, not %', p_keep;
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 5000 then
    raise exception 'p_limit must be between 1 and 5000, not %', p_limit;
  end if;

  with target as (
    select id
      from public.canonical_roles
     where scope_status = 'out_of_scope'
       and length(description_prototype) > p_keep
     limit p_limit
  )
  update public.canonical_roles r
     set description_prototype = left(r.description_prototype, p_keep)
    from target t
   where t.id = r.id;
  get diagnostics v_roles = row_count;

  with target as (
    select e.id
      from public.historical_opening_events e
      join public.canonical_roles r on r.id = e.canonical_role_id
     where r.scope_status = 'out_of_scope'
       and length(e.evidence_quote) > p_keep
     limit p_limit
  )
  update public.historical_opening_events e
     set evidence_quote = left(e.evidence_quote, p_keep)
    from target t
   where t.id = e.id;
  get diagnostics v_events = row_count;

  with target as (
    select o.id
      from public.raw_job_observations o
     where length(o.evidence_excerpt) > p_keep
       -- Resolved: an unresolved posting's text is what resolution reads.
       and exists (select 1 from public.observation_role_matches m where m.observation_id = o.id)
       and not exists (
         select 1
           from public.observation_role_matches m
           join public.canonical_roles r on r.id = m.canonical_role_id
          where m.observation_id = o.id
            and r.scope_status in ('in_scope', 'ambiguous')
       )
     limit p_limit
  )
  update public.raw_job_observations o
     set evidence_excerpt = left(o.evidence_excerpt, p_keep)
    from target t
   where t.id = o.id;
  get diagnostics v_observations = row_count;

  return query
    select
      v_observations,
      v_roles,
      v_events,
      (select count(*)
         from public.raw_job_observations o
        where length(o.evidence_excerpt) > p_keep
          and exists (select 1 from public.observation_role_matches m where m.observation_id = o.id)
          and not exists (
            select 1
              from public.observation_role_matches m
              join public.canonical_roles r on r.id = m.canonical_role_id
             where m.observation_id = o.id
               and r.scope_status in ('in_scope', 'ambiguous')
          )),
      (select count(*) from public.canonical_roles
        where scope_status = 'out_of_scope' and length(description_prototype) > p_keep),
      (select count(*) from public.historical_opening_events e
         join public.canonical_roles r on r.id = e.canonical_role_id
        where r.scope_status = 'out_of_scope' and length(e.evidence_quote) > p_keep);
end;
$$;

-- What the text costs, asked once before a trim and once after rather than on every call: three sums over whole
-- tables are too expensive to repeat sixty times, and the caller only needs the two ends.
create or replace function public.out_of_scope_text_bytes()
returns table (excerpt_bytes bigint, prototype_bytes bigint, quote_bytes bigint, database_bytes bigint)
language sql
stable
set search_path = ''
as $$
  select
    (select coalesce(sum(length(evidence_excerpt)), 0) from public.raw_job_observations),
    (select coalesce(sum(length(description_prototype)), 0) from public.canonical_roles),
    (select coalesce(sum(length(evidence_quote)), 0) from public.historical_opening_events),
    pg_database_size(current_database());
$$;

revoke all on function public.trim_out_of_scope_text(integer, integer) from public, anon, authenticated;
revoke all on function public.out_of_scope_text_bytes() from public, anon, authenticated;
grant execute on function public.trim_out_of_scope_text(integer, integer) to service_role;
grant execute on function public.out_of_scope_text_bytes() to service_role;
