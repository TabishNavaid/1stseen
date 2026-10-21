-- The newest observation is read by its own index, not by sorting the whole table.
--
-- The landing page's status line states when collection last wrote anything, which is one read:
-- `raw_job_observations` ordered by `observed_at desc, id` with a limit of 1 (`loadLandingData`). There was no index
-- for that ordering, so Postgres read every row and sorted it to return one. Measured on hosted on 2026-10-20:
-- **908 ms, a Seq Scan over 45,735 rows, 57% of all the time the landing page spends in the database.** The existing
-- indexes do not help it: `raw_job_observations_source_time_idx` is `(source_id, observed_at desc)`, so it orders
-- within one source and not across the table, and `raw_job_observations_created_idx` is on `created_at`, which is when
-- the row was written rather than when the posting was observed.
--
-- The cost grows with the corpus and nothing announces it: the read was a few milliseconds at a thousand observations
-- and will be two seconds at a hundred thousand. It is the shape worth looking for elsewhere, which
-- `apps/web/tests/read-bounds.test.mjs` cannot catch, because the read *is* bounded -- `limit(1)` is a hard cap, and
-- bounded output says nothing about the rows scanned to produce it.
--
-- `id` is in the index because it is the tiebreak the read orders on, so the index alone decides the row and the plan
-- needs no sort at all. Both columns are in the index, so it answers the query without touching the table.
create index raw_job_observations_observed_desc_idx
  on public.raw_job_observations (observed_at desc, id);

comment on index public.raw_job_observations_observed_desc_idx is
  'Serves the newest-observation read (observed_at desc, id) that the landing page status line makes, which was a '
  'Seq Scan over the whole table for one row.';
