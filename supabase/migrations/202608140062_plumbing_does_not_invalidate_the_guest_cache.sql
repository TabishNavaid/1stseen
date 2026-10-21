-- Collection's own bookkeeping stops invalidating every cached guest page.
--
-- `public_data_version` (migration 202608140031) is in the guest cache key, so every bump orphans every stored guest
-- page at every colo. Fourteen relations bumped it, after every statement. Three of them are not guest-readable at
-- all -- they are absent from `PUBLIC_TABLE_COLUMNS` in `apps/web/lib/public-read-policy.ts`, so no guest page can
-- read a row of them, and no guest page can therefore be stale because one changed:
--
--   * `sources`           -- collection updates `last_fetched_at` on every source it fetches, and
--                            `last_content_hash` when the content moved.
--   * `source_fetches`    -- one row inserted per source per run, the fetch log.
--   * `backtest_cases`    -- a backtest run's per-case detail; `/methodology` and `/replay` read the run and the
--                            `replay_*` functions, never the cases table.
--
-- `IntelligenceRepository.record_fetch` runs for every source on every run, unchanged ones included: one insert into
-- `source_fetches` and one update of `sources`. The last current-jobs run collected 370 sources, so those two
-- relations alone bumped the version **740 times in one run** -- 740 global cache invalidations -- against the 1 to 36
-- observations created and 3 to 9 changed in the same run, which are the writes a guest can actually see. A
-- collection run takes about 42 minutes, so the version moved roughly every 3.4 seconds throughout, and an 8 to 9
-- second landing render was paid by whoever arrived first after each one.
--
-- This is the same mistake as the enrichment fingerprint's `fetches` component (migration 202608140060): plumbing
-- counted as content. The rule either way is that the version tracks what a guest can read, and nothing else.
--
-- What still bumps it, correctly: companies, canonical_roles, role_aliases, raw_job_observations,
-- observation_role_matches, historical_opening_events, forecasts, forecast_evidence (read as the
-- `forecast_provenance` view), forecast_changes, signals, backtest_runs.
--
-- A relation added to the guest read policy later needs its trigger back. `apps/web/tests/integration/guest-cache-version.test.mjs`
-- fails when a guest-readable relation does not bump the version, and when one that is not guest-readable does.

drop trigger if exists sources_bumps_public_data_version on public.sources;
drop trigger if exists source_fetches_bumps_public_data_version on public.source_fetches;
drop trigger if exists backtest_cases_bumps_public_data_version on public.backtest_cases;
