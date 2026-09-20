-- The trim finds the rows it still has to shorten through an index, instead of by reading every row's text.
--
-- trim_out_of_scope_text (migration 048) selects the rows to shorten, and reports how many are left, with
-- `length(<column>) > p_keep`. The three columns are TOASTed, so evaluating that predicate reads and decompresses the
-- text of every row the scan passes: all of it, on every call, for the three "remaining" counts. On hosted the first
-- call of the 20:32 UTC current-jobs run on 2026-09-20 failed with 57014 after migration 050 had removed the
-- measurement, so the function itself does not fit in the eight seconds PostgREST allows, and three runs had shortened
-- nothing. On a copy of the rig corpus (17,103 observations, 248 MB) one call spent 1,090 ms shortening its 600 rows
-- and 3,066 ms counting what was left, and one of the counts took 4,900 ms from a cold cache. `p_limit` bounds the
-- updates, not the counts, so a smaller chunk would not have helped.
--
-- Each index below holds only the rows whose text is still longer than the trim keeps, so the planner reaches them
-- without reading any text, and a row leaves its index when it is shortened. The observation and event indexes keep
-- the long rows the trim deliberately spares (in-scope, ambiguous, and unresolved), which is where they stop; the role
-- index names out-of-scope roles only, so it empties, and a role classified out of scope later enters it as it is
-- updated.
--
-- The indexes are tied to p_keep = 300. A partial index serves a query only when the query's predicate matches its
-- own, so the 300 below must equal trim_out_of_scope_text's default `p_keep`, OUT_OF_SCOPE_TEXT_KEPT in
-- worker/src/firstseen/repository.py, and therefore `firstseen trim-text --keep`'s default. A call with any other
-- value cannot use them and scans the text again. Change all of them together;
-- test_schema_contract.test_untrimmed_text_indexes_match_what_the_trim_keeps fails until they agree.
--
-- `create index` takes a share lock on its table for the build, which blocks writes to that table, not reads, until it
-- finishes. It cannot be `concurrently`, because a migration runs in a transaction. Apply it when no collection
-- workflow is running, or collection's own writes, which have eight seconds including any wait for a lock, may fail.

create index raw_job_observations_untrimmed_excerpt_idx
  on public.raw_job_observations (id)
  where length(evidence_excerpt) > 300;

create index canonical_roles_untrimmed_prototype_idx
  on public.canonical_roles (id)
  where scope_status = 'out_of_scope' and length(description_prototype) > 300;

create index historical_opening_events_untrimmed_quote_idx
  on public.historical_opening_events (canonical_role_id, id)
  where length(evidence_quote) > 300;
