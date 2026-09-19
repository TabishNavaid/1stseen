# GitHub Actions collection deployment

1stSeen uses separate, low-cost GitHub Actions workflows for current jobs, recruiting-page changes,
historical enrichment, changed-evidence forecast regeneration, and manual backtesting. The four collection
workflows share one concurrency group, so scheduled and manually dispatched runs queue instead of writing
the same database concurrently.

## Schedules and timeouts

GitHub schedules use UTC, run only from the default branch, and can start late when runners are busy.

| Workflow | Schedule (UTC) | Timeout | Purpose |
| --- | --- | --- | --- |
| `current-jobs.yml` | 00:17, 12:17 | 45 min | Current ATS, career-page, feed, and sitemap job observations, then enrichment |
| `career-page-signals.yml` | 01:37, 07:37, 13:37, 19:37 | 45 min | Material page, feed, sitemap, and optional Reddit signals |
| `forecast-regeneration.yml` | 02:52, 08:52, 14:52, 20:52 | 25 min | Only roles affected by changed persisted evidence, then readiness plans and the health report |
| `historical-enrichment.yml` | Sunday 04:07 | 90 min | Wayback captures and archived recruiting observations, then enrichment |
| `backtest.yml` | 3rd of the month 05:23, and by hand | 45 min | Leak-free rolling-origin evaluation (60-day cutoff when scheduled), then the scored-case history |
| `backup-corpus.yml` | Monday 05:41 | 30 min | Corpus backup, restore proof, 14-day artifact ([`operations.md`](operations.md)) |
| `ops-health.yml` | 03:29, 09:29, 15:29, 21:29 | 5 min | Web, agent API, database, schedule freshness, and Worker errors ([`operations.md`](operations.md)) |

Timeouts come from measured durations on the local validation corpus: 37 current sources plus enrichment
took 487 s (97 configured sources project to about 17 minutes), 6 Wayback sources took 1,663 s (8 project to
about 38 minutes), a preloaded regeneration pass over 3,451 roles took about 12 s, and a 4,574-target
backtest took 7.4 s. Signal collection has never run against a real corpus, so its 45 minutes is an
estimate to revisit after the first production run.

### Round trips to the hosted database

Those durations were measured against a local database, where a request costs about a millisecond. The hosted
project is a network round trip away: about 140 ms per PostgREST request from a laptop, and every request collection
made was per row. A posting cost an existence check and a write; a role decision cost a fresh read of every candidate
role and five more requests; history reconstruction cost four or more requests for every role of the company, whether
or not anything had changed. The hosted bootstrap ran at about 1.35 observations a second, and reconstruction alone
would have spent over an hour of every current-jobs run on the corpus's 8,500 roles.

Collection now reads each source's and each company's evidence once and writes in bulk
(`IntelligenceRepository.upsert_jobs`, `worker/src/firstseen/enrichment_session.py`, migration `202608140045`), so
its requests follow the number of sources and companies rather than observations. Model attempts are inserted
together before each source's or company's tool call is recorded.

Measured on a scratch copy of the rig corpus, enriching Databricks, Stripe, and Figma from nothing (2,747
observations): the per-row code sent 34,528 requests and the batched code 137, about 12,600 and 50 per 1,000
observations, and the two wrote identical roles, aliases, matches, opening events, and change records (12,065 rows).
The batched code's requests are a fixed 40 to 50 per company whatever its size. The per-row code also downloaded every
candidate role's description for every observation it resolved: 1,736 MB for Stripe and Figma alone, against 18 MB
for all three batched, which matters as much as the time on Supabase Free's 5 GB of monthly egress. At 140 ms a
request, the round trips alone were about 80 minutes against 20 seconds. Collecting Databricks' 17 current sources
and enriching the company (923 postings, 1,012 observations resolved) took 14,979 requests and 1,338 MB before and 183
requests and 7.5 MB after, with the same outcome for every posting. What remains is about 8 requests per source (its
page hash, its fetch record, its tool call) and about 45 per company, so a current-jobs pass over 296 sources and 58
companies makes about 5,000 requests, some 8 minutes of round trips from a runner. The first Actions run against the
hosted project (dispatched 2026-09-19: 303 sources, 8,115 postings, 55 companies enriched, 61 new observations
resolved) took 16 minutes end to end with 3,277 requests, well inside the 45-minute timeout. On the hosted project, a
steady-state pass over Figma (324 observations, 144 roles, nothing new to resolve) took 1,251 requests and 78 s before
and 26 requests and 4.7 s after.

What a run still reads is every company's evidence: its observations' text, its stored opening events, and its archive
captures, because reconstruction re-derives every role from them. On Figma that is about 2.5 KB per observation on the
wire, so about 45 MB per current-jobs run over the whole corpus. Four runs a day would be about 5.5 GB a month, more
than Supabase Free's 5 GB of egress before anything else is counted, so current jobs run twice a day (about 2.7 GB).

Most companies have nothing new in a given run, so enrichment now skips them exactly
(`worker/src/firstseen/enrichment_fingerprints.py`, migration `202608140046`). The database fingerprints everything
enrichment reads for a company; after a complete pass the fingerprint is taken again, and if it did not move, the pass
changed nothing and its key (with a hash of the worker's code and model configuration) is kept in
`collection_checkpoints` (pipeline `enrichment_fingerprints`). A later run skips a company whose key still matches:
enrichment has no dependence on the clock, so the same inputs would give the same no-op. A new or changed posting, a new
archive capture, a re-resolution, a scope review, a deploy, or a new model key makes the company enrich again, and
`firstseen enrich --force` enriches every company regardless. If the database lacks the fingerprint function, every
company is enriched, as before.

Proved on a scratch copy of the rig corpus with every derived row compared, timestamps included: a first pass, then a
forced second pass that changed nothing for any company (51,676 rows identical), then a third pass that skipped all 58
companies and left every row as it was, with 70 requests and 0.2 MB against 1,424 requests and 149 MB for the forced
pass. Getting there took one fix: when every title of a role is out of scope, the classifier reports the first title's
reason, and titles came in PostgREST's unordered embed order, so a role's stored reason could flip between two passes
over the same evidence. Titles are now read earliest-seen first; the first run after this rewrites such reasons once
(1,472 on the scratch copy, no status among them).

Signal collection had the same shape. Every signal that names no single role recomputes each in-scope role of its
company, and each recomputation re-read the whole evidence set (every role, observation, match, event, and signal,
about 2 MB on the wire at the bootstrap's size). It now reads roles and openings once per run and only the signals again
after each source that created some, since a signal pass adds nothing else a forecast reads. On a scratch copy of the
rig corpus, a pass over IMC's 24 sources that created 970 signals and recomputed 14 forecasts took 18,948 requests and
589 MB re-reading per role, and 2,499 requests and 29 MB now, writing identical signals, forecasts, forecast evidence,
and changes. Most of the request difference is the evidence each forecast cites: it was looked up one request per id,
and a forecast can cite over a thousand signals; it is now read a hundred ids at a time (forecast regeneration and the
agent write forecasts through the same code). The same pass exposed a failure that predates this: a sitemap gaining two
recruiting URLs for one role wrote two signals under the key `signals` allows once (role, observation, kind), the
database refused the second, and the source failed on every later run. The first signal now stands for the page.

Every `ingest`, `enrich`, `signals`, and `regenerate-forecasts` summary reports `database_requests`,
`database_mb_downloaded` (response bytes on the wire, which is what Supabase counts as egress), and `elapsed_seconds`;
`backtest` writes the same to its log. The workflow's step summary shows them, so a run drifting back toward per-row
requests or large downloads shows it in its own summary.

Every workflow also supports `workflow_dispatch`. Current jobs, signals, and historical enrichment accept an
optional company name, domain, or UUID for bounded development runs.

## Concurrency

All four collection workflows use `group: firstseen-collection` with `cancel-in-progress: false`.

- **Not keyed by ref.** The group used to be `firstseen-collection-${{ github.ref }}`, which put a run
  dispatched from a feature branch in a different group from the scheduled runs on `main`. Both write the
  same production database, so they could run at the same time.
- **What an overlap would have written.** `forecasts` has no uniqueness on role and input fingerprint, so two
  overlapping regenerations each insert the same new version. Concurrent ingestion of one source collides on
  the `raw_job_observations` identity index, and concurrent enrichment collides on
  `canonical_roles (company_id, recurrence_key)`. Those two fail one side's work as an audited error rather
  than duplicating rows.
- **Pending runs are replaced, not queued.** GitHub keeps one pending run per group and cancels an older
  pending run when a newer one queues. With four workflows in one group, a schedule that fires while two others
  are waiting silently drops a run. The schedules are therefore staggered so that each workflow's full timeout
  ends at least 15 minutes before the next scheduled start (the smallest gap is 30 minutes).
  `worker/tests/test_collection_workflows.py` enforces this, so a timeout or cron change that reintroduces
  overlap fails CI.
- **Local CLI runs are outside this group.** `scripts/bootstrap-companies.sh` or a manual `firstseen ingest`
  against production does not queue behind Actions. Disable the schedules, or wait for a quiet window, before
  running either against the hosted project.
- `backtest.yml` uses its own group, `firstseen-backtest`. It writes only `backtest_runs` and
  `backtest_cases`. In the collection group, a scheduled run arriving while it waited would cancel it.

## Collection bounds

Set at workflow level, from repository variables with literal fallbacks, so an unset variable cannot
silently restore the `config.py` defaults (a 2 MB response cap, which rejects real ATS boards):

| Variable | Fallback | Used by |
| --- | --- | --- |
| `MAX_SOURCE_BYTES` | `10000000` (the maximum `config.py` accepts) | all five workflows |
| `HTTP_MIN_HOST_INTERVAL_SECONDS` | `0.25` | current jobs, forecast regeneration, backtest |
| `COURTESY_HTTP_MIN_HOST_INTERVAL_SECONDS` | `1.5` | historical enrichment, career-page signals; exported to the worker as `HTTP_MIN_HOST_INTERVAL_SECONDS` |
| `ROBOTS_TXT_ENFORCED` | `false` | current jobs, historical enrichment, career-page signals: honour robots.txt before every request (`docs/takedown.md`). Set the same value on the Worker so `/data-sources` states it. |

Forecast regeneration and backtesting make no source requests; they carry the same bounds for parity. A
value outside the `config.py` limits makes `Settings` raise at import, so the run fails loudly.

A single source whose one response is legitimately larger than `MAX_SOURCE_BYTES` names its own limit in its options
(`sources.metadata.options.max_source_bytes`), bounded by `SOURCE_BYTES_CEILING` (64 MB) in
`worker/src/firstseen/adapters/base.py`; every other source keeps the global cap. Anduril's Greenhouse board is the one
such source today: 2,374 postings in one 42 MB response, and the board API has no paging, so its source carries
`max_source_bytes: 50000000`.

## Required repository secrets

**Settings → Secrets and variables → Actions → Repository secrets**:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Optional model extraction secrets are `LLM_API_KEY`, `GEMINI_API_KEY`, and `GROQ_API_KEY`. Optional approved
Reddit collection uses `REDDIT_CLIENT_ID` and `REDDIT_CLIENT_SECRET`. Never store a credential as a
repository variable or in a workflow file.

## Repository variables

All optional; the fallbacks above apply when unset.

- `MAX_SOURCE_BYTES`, `HTTP_MIN_HOST_INTERVAL_SECONDS`, `COURTESY_HTTP_MIN_HOST_INTERVAL_SECONDS`
- `ROBOTS_TXT_ENFORCED` (off until the owner accepts the coverage it costs; `docs/takedown.md` has the measurement)
- `LLM_DEFAULT_ROUTES`, `LLM_EXTRACT_ROUTES`, and `LLM_API_BASE`
- `REDDIT_API_ENABLED`, `REDDIT_USER_AGENT`, `REDDIT_COMMUNITIES`, `REDDIT_SEARCH_LIMIT`, and
  `REDDIT_LLM_EXTRACTION_ENABLED`

Apply every migration in `supabase/migrations`, currently through
`202608140025_replay_paging_filters.sql`, before enabling schedules.
The service-role key is required because collection, forecast versions, audit rows, and checkpoint cursors
are automation-owned records unavailable to authenticated browser clients.

## Enrichment inside collection

`current-jobs.yml` and `historical-enrichment.yml` both run `ingest`, which finishes by deriving
canonical-role matches and historical opening events from the evidence just persisted. Enrichment is
idempotent, so a re-run duplicates neither role matches nor opening events, and a company that fails
enrichment is audited without discarding the records other companies produced.
`forecast-regeneration.yml` then picks up the affected roles and writes readiness plans for the users
following them.

## Idempotency and partial failure

Current ingestion compares the retrieved document hash with `sources.last_content_hash`. Unchanged pages skip
normalization, advance existing job `last_seen_at`, and record an unchanged `source_fetches` row. Signal
ingestion compares normalized meaningful state in `signal_source_states`; it emits and versions a forecast
only when a new signal identity is persisted.

Forecast regeneration reads changed `source_fetches`, new historical events, and new signals after the last
clean `collection_checkpoints` cursor. It skips roles whose newly computed forecast input fingerprint matches
the latest stored version. The cursor advances only when every affected role succeeds. On a partial failure,
successful forecast versions remain committed, the old cursor remains, and the next run safely retries the
range; already-saved roles then skip by input fingerprint.

Every source and role is audited independently in `agent_tool_calls`. A partial run exits successfully so one
unavailable source does not discard other sources' work. A run fails only when all non-empty scoped sources
or roles fail. Each workflow publishes its bounded JSON summary as a short-lived artifact and step summary;
credentials, raw pages, prompts, and unrestricted evidence are never included.

## Cancellation and timeouts mid-run

A cancelled or timed-out job is killed without running `finish_agent_run`, so its `agent_runs` row stays
`running`. What survives:

| Workflow | Committed before the cut | Not done | Recovery |
| --- | --- | --- | --- |
| Current jobs / historical enrichment | Every source that finished, including its content hash | Later sources in the pass, and the whole enrichment step, which runs after collection | The next completed `ingest` (or `firstseen enrich --all`) enriches every unmatched observation, because enrichment reads the system of record rather than this run's results |
| Career-page signals | Signals from finished sources (unique on identity) | Forecast versioning for a source cut between signal insert and recompute | Regeneration picks up signals newer than its cursor |
| Forecast regeneration | Forecast versions already inserted | Remaining roles; the cursor does not advance | Next run retries the range; saved roles skip by fingerprint |
| Backtest | Nothing; the run is persisted only at the end | The whole run | Dispatch again |

The one failure mode this cannot recover from is a pass that always times out at the same point: sources are
processed in a fixed order, so the tail would never be collected and enrichment would never run. The
collection health report lists runs left `running`, which is how this shows up.

## Collection health

`forecast-regeneration.yml` ends with `node scripts/collection-health.mjs`, which runs even when regeneration
fails and appends to the job summary:

- rows added per table in the last 24 hours, next to each table's total
- each workflow's last successful Actions run (the job has `actions: read`) and each pipeline's last
  completed pass in `agent_runs`
- sources whose last 3 attempts all failed (`COLLECTION_HEALTH_FAILURE_STREAK` changes the threshold)
- runs still `running` three hours after starting

Problems are also raised as `::warning::` annotations. The step never fails the job for a warning; it exits
non-zero only when the database cannot be read. Run it locally with `npm run health:collection`.

## Cost and keep-alive

- **Actions minutes.** Public repositories run standard GitHub-hosted runners free. A private repository on
  GitHub Free has 2,000 minutes a month, and this schedule needs roughly 2,800: current jobs about
  1,200 (2 runs a day at about 20 minutes including setup), signals up to 1,400, regeneration about 360,
  historical about 170, plus CI. A private repository needs a lower cadence or a paid plan.
- **Supabase free-tier pausing.** A free project pauses after 7 days without activity. Collection writes to
  the database several times a day, well inside that window.
- **GitHub schedule disabling.** In a public repository GitHub disables scheduled workflows after 60 days
  with no repository activity. Collection itself makes no commits, so a repository left alone for two months
  stops collecting, and a week after that Supabase pauses. Re-enable from the Actions tab.
