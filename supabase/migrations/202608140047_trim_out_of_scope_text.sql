-- Keep only the first characters of the text held against roles nobody can apply to.
--
-- Half the corpus is the text of postings that are not early-career technical roles: on hosted on 2026-09-20, of 228
-- MB, out-of-scope roles carried 45.8 MB of posting excerpts, 25.5 MB of role description prototypes, and 32.2 MB of
-- opening-event quotes, against 1.9, 1.2 and 1.5 MB for the in-scope ones. That text is what the database fills up
-- with, and it is also most of what a guest question downloads.
--
-- This shortens it to its first `p_keep` characters, which leaves a citation and a weak matching prototype:
--
--   * a role's description prototype, when the role is out of scope;
--   * an opening event's quote, when its role is out of scope;
--   * a posting's excerpt, when the posting is resolved and no role it is matched to is in scope or ambiguous.
--
-- In-scope and ambiguous roles keep everything: an ambiguous role is waiting on a person's judgement, and that person
-- needs the text. A posting with no match at all keeps everything too, because it has not been resolved yet and
-- resolution reads its text.
--
-- What this costs, and it cannot be undone from the database: a role that later becomes in scope -- a better title, a
-- classifier improvement, a scope review -- has only the first `p_keep` characters of its earlier postings, so its
-- history quotes and its matching prototype stay shortened. The text can only come back by collecting the posting
-- again, and a posting that is gone from the board cannot be.
--
-- The work happens in the database. Reading this text out to shorten it and writing it back would download every byte
-- of the 103 MB it removes, which is what the change exists to avoid.

-- The function reports what it changed and what it cost, because the run that calls it is the only record: the rows it
-- shortened, the bytes each column held before and after, and the database's own size on both sides. The size will not
-- fall here -- an UPDATE leaves the old row version behind until the table is vacuumed -- and seeing that in the log is
-- the point (docs/operations.md, "Trimming out-of-scope text").

create or replace function public.trim_out_of_scope_text(p_keep integer default 300)
returns table (
  observations integer,
  roles integer,
  events integer,
  excerpt_bytes_before bigint,
  excerpt_bytes_after bigint,
  prototype_bytes_before bigint,
  prototype_bytes_after bigint,
  quote_bytes_before bigint,
  quote_bytes_after bigint,
  database_bytes_before bigint,
  database_bytes_after bigint
)
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_observations integer;
  v_roles integer;
  v_events integer;
  v_excerpt_before bigint;
  v_prototype_before bigint;
  v_quote_before bigint;
  v_database_before bigint;
begin
  if p_keep is null or p_keep < 1 or p_keep > 8192 then
    raise exception 'p_keep must be between 1 and 8192, not %', p_keep;
  end if;

  select coalesce(sum(length(evidence_excerpt)), 0) into v_excerpt_before from public.raw_job_observations;
  select coalesce(sum(length(description_prototype)), 0) into v_prototype_before from public.canonical_roles;
  select coalesce(sum(length(evidence_quote)), 0) into v_quote_before from public.historical_opening_events;
  v_database_before := pg_database_size(current_database());

  update public.canonical_roles
     set description_prototype = left(description_prototype, p_keep)
   where scope_status = 'out_of_scope'
     and length(description_prototype) > p_keep;
  get diagnostics v_roles = row_count;

  update public.historical_opening_events e
     set evidence_quote = left(e.evidence_quote, p_keep)
    from public.canonical_roles r
   where r.id = e.canonical_role_id
     and r.scope_status = 'out_of_scope'
     and length(e.evidence_quote) > p_keep;
  get diagnostics v_events = row_count;

  update public.raw_job_observations o
     set evidence_excerpt = left(o.evidence_excerpt, p_keep)
   where length(o.evidence_excerpt) > p_keep
     -- Resolved: an unresolved posting's text is what resolution reads.
     and exists (select 1 from public.observation_role_matches m where m.observation_id = o.id)
     and not exists (
       select 1
         from public.observation_role_matches m
         join public.canonical_roles r on r.id = m.canonical_role_id
        where m.observation_id = o.id
          and r.scope_status in ('in_scope', 'ambiguous')
     );
  get diagnostics v_observations = row_count;

  return query
    select
      v_observations,
      v_roles,
      v_events,
      v_excerpt_before,
      (select coalesce(sum(length(evidence_excerpt)), 0) from public.raw_job_observations),
      v_prototype_before,
      (select coalesce(sum(length(description_prototype)), 0) from public.canonical_roles),
      v_quote_before,
      (select coalesce(sum(length(evidence_quote)), 0) from public.historical_opening_events),
      v_database_before,
      pg_database_size(current_database());
end;
$$;

revoke all on function public.trim_out_of_scope_text(integer) from public, anon, authenticated;
grant execute on function public.trim_out_of_scope_text(integer) to service_role;
