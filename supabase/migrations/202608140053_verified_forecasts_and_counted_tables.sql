-- When a forecast was last recomputed, and an index for every table the health report counts.
--
-- `as_of` is part of a forecast's input fingerprint (forecasting.py), and regeneration passes the run's own date, so
-- every role's fingerprint changed at midnight and the first regeneration of each day stored a new version of every
-- role it looked at. Measured on 2026-09-24: 66,560 forecast_evidence rows in 24 hours against 658 in-scope roles,
-- 101 rows per role per day, and 17.6 MB of the database's ~25 MB daily growth. Nothing had been learned; the clock
-- had moved.
--
-- Regeneration now stores a new version only when what a reader can see has changed, at the precision they see it
-- (`displayed_forecast_identity`). A recompute that comes out the same is not nothing, though: it is corroboration,
-- and the product should be able to say "checked today, unchanged since August 12" rather than showing a date that
-- moves every night. So the check is recorded on the row that already exists, and freshness is measured from it:
-- `agent_questions.py` excluded a role whose latest forecast row was more than seven days old, which after this change
-- would have called a forecast confirmed this morning stale.
--
-- **There is deliberately no backfill.** Setting `last_verified_at = forecasted_at` on every existing row would
-- rewrite the whole table: about 3,350 forecasts at 10 KB each is 33 MB of new row versions and 33 MB left dead until
-- a vacuum, which is the pattern that took this database to 485 MB. Readers coalesce instead -- a row written before
-- this column existed is as fresh as its `forecasted_at`, which is exactly what a backfill would have written -- and
-- rows gain a real value as regeneration verifies them. `real-data.ts` already falls back the same way.
--
-- **The indexes are not CONCURRENTLY, and cannot be.** A migration file is applied as one statement string, both by
-- `supabase db push` and by the weekly restore proof (`backup-corpus.mjs` passes the whole file to one query), so
-- Postgres runs it in an implicit transaction and `CREATE INDEX CONCURRENTLY` would fail there -- breaking the backup's
-- restore proof, not just the push. Plain builds are affordable at this size: measured on the rig, the six
-- largest took 12 to 95 ms and the rest are on tables of a few thousand rows, about 400 ms for the file. What matters
-- is that one transaction holds a SHARE lock on all thirteen tables until it commits, so the window is the whole file:
-- roughly 2 to 6.5 s on hosted, during which a write to any of those tables waits. A collector's write has
-- eight seconds including lock waits, so **apply this while no collection workflow is running**. Collection runs twice
-- a day for about 25 minutes; the window is wide.
--
-- The thirteen indexes together measure 2.4 MB on the rig, about 5 MB at hosted's row counts.

alter table public.forecasts add column last_verified_at timestamptz;

comment on column public.forecasts.last_verified_at is
  'When this forecast was last recomputed and found unchanged, or first written. Freshness is measured from here, '
  'never from created_at or as_of: an identical recompute corroborates a forecast rather than ageing it. Null on a row '
  'written before this column existed; readers coalesce to forecasted_at rather than pay a full-table backfill.';

-- Reading the latest verification for a role, and the staleness sweep, both want the newest first.
create index forecasts_role_verified_idx on public.forecasts (canonical_role_id, last_verified_at desc);

-- The health report counts the rows each table gained in 24 hours as `count=exact` over a timestamp column.
-- Unindexed, each of those is a sequential scan, and each crosses PostgREST's eight-second timeout as the table grows:
-- forecast_evidence did on 2026-09-21 (migration 052) and raw_job_observations on 2026-09-24, both surfacing as the
-- regeneration workflow failing, because the health report is that workflow's last step. 052 indexed one table and
-- said the rest were on the same path more slowly; they are, so the rest are indexed here rather than one alert at a
-- time. Each names the column `collection-health` actually filters on, which is not always created_at.
create index raw_job_observations_created_idx on public.raw_job_observations (created_at);
create index observation_role_matches_created_idx on public.observation_role_matches (created_at);
create index canonical_roles_created_idx on public.canonical_roles (created_at);
create index historical_opening_events_created_idx on public.historical_opening_events (created_at);
create index role_aliases_created_idx on public.role_aliases (created_at);
create index forecasts_created_idx on public.forecasts (created_at);
create index forecast_changes_created_idx on public.forecast_changes (created_at);
create index signals_created_idx on public.signals (created_at);
create index archive_captures_created_idx on public.archive_captures (created_at);
create index model_usage_created_idx on public.model_usage (created_at);
create index inference_decisions_created_idx on public.inference_decisions (decided_at);
create index agent_tool_calls_created_idx on public.agent_tool_calls (started_at);
create index source_fetches_created_idx on public.source_fetches (fetched_at);
