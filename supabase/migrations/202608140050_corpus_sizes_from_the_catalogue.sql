-- What the corpus's text costs, read from the catalogue instead of scanned.
--
-- Migration 048 reported it with three `sum(length(...))` over whole tables. Those scan the text itself -- 110 MB of it
-- in raw_job_observations alone -- and on hosted they do not finish in the eight seconds PostgREST allows: the trim
-- step of the 16:05 UTC run on 2026-09-20 died with 57014 inside `out_of_scope_text_bytes` before shortening anything,
-- for the second run in a row. Measuring is not worth failing the work.
--
-- Sizes come from the catalogue instead, which is instant. A table's long text lives in its TOAST table, so the TOAST
-- size is what shortening the text moves, and heap, index and total are there beside it because they answer "is the
-- database filling up" directly. `pg_stats.avg_width` is not usable here: for a TOASTed column it reports the width of
-- the pointer, 37 bytes for a column holding 73.7 MB, so an estimate built on it would have been wrong by a factor of
-- two thousand.
--
-- This reports on the whole table rather than per column, which is the honest granularity for a catalogue read: a
-- table's TOAST holds every long column it has, not only the one a trim shortens. The exact figure the trim reports is
-- the count of rows it changed.

drop function if exists public.out_of_scope_text_bytes();

create or replace function public.corpus_text_sizes()
returns table (
  table_name text,
  heap_bytes bigint,
  toast_bytes bigint,
  index_bytes bigint,
  total_bytes bigint,
  database_bytes bigint
)
language sql
stable
set search_path = ''
as $$
  select c.relname::text,
         pg_relation_size(c.oid),
         coalesce(pg_total_relation_size(nullif(c.reltoastrelid, 0)), 0),
         pg_indexes_size(c.oid),
         pg_total_relation_size(c.oid),
         pg_database_size(current_database())
    from pg_class c
   where c.relnamespace = 'public'::regnamespace
     and c.relkind = 'r'
     and c.relname in (
       'raw_job_observations', 'canonical_roles', 'historical_opening_events', 'archive_captures', 'model_usage'
     )
   order by pg_total_relation_size(c.oid) desc;
$$;

revoke all on function public.corpus_text_sizes() from public, anon, authenticated;
grant execute on function public.corpus_text_sizes() to service_role;
