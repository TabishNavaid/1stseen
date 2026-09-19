# Operations

How 1stSeen is kept running once it is deployed: what reaches the owner when something breaks, what is checked
and how often, how the corpus is backed up and restored, what a signed-in session may write, and what each free tier
allows. Every number here was measured on the local rig on 18 September 2026 unless it says otherwise.

## What runs, and when

| Workflow | Schedule (UTC) | What it does | On failure |
| --- | --- | --- | --- |
| `current-jobs.yml` | 00:17, 06:17, 12:17, 18:17 | Current postings from every enabled source | ops-alert issue |
| `career-page-signals.yml` | 01:37, 07:37, 13:37, 19:37 | Career-page changes and recruiting signals | ops-alert issue |
| `forecast-regeneration.yml` | 02:52, 08:52, 14:52, 20:52 | Re-forecasts changed roles, writes plans, then `collection-health --alert` | ops-alert issue, and a separate "Collection health" issue for any warning |
| `historical-enrichment.yml` | Sunday 04:07 | Wayback history | ops-alert issue |
| `backup-corpus.yml` | Monday 05:41 | Dumps the corpus, proves it restores, keeps it 14 days | ops-alert issue |
| `backtest.yml` | 3rd of the month 05:23 | Leak-safe backtest, then the evaluable-case history | ops-alert issue |
| `ops-health.yml` | 03:29, 09:29, 15:29, 21:29 | Probes the web app, agent API, database, schedules, and Worker errors | "Production health" issue |

## How a failure reaches the owner

There is one channel: a GitHub issue labelled `ops-alert`, opened in this repository and **assigned to the repository
owner**. GitHub emails the assignee and, with GitHub Mobile installed, pushes a notification for the assignment. Nothing
depends on the owner watching a dashboard.

- **Every scheduled workflow** ends with `.github/actions/ops-alert`, run `if: always()` with the job's status. A failed,
  timed-out, or cancelled run opens the workflow's issue (`scripts/ops-alert.mjs`); the next successful run comments
  and closes it. It is a step in a job that is already running, so it costs no extra billed minutes.
- **Collection health** (`scripts/collection-health.mjs --alert`, after every regeneration) raises one "Collection
  health" issue while any warning stands: a collector with no completed pass in 12 hours, no source fetch in 24 hours,
  a source failing three times in a row, or a run that never finished. It closes when no warning remains.
- **Production health** (`scripts/ops-health.mjs --alert`, every six hours) raises one "Production health" issue while
  any check fails. It is the watchdog for the other workflows: it checks each one's last success against its interval.
- **One issue per problem.** Each problem has a stable key in a hidden marker. While it stays open the issue is edited
  silently, and a comment (which notifies) is added only when what is wrong changes or a day has passed. A collector
  failing four times a day produces one issue and at most one reminder a day.
- **Nothing secret reaches an issue.** Titles, bodies, and comments pass through `redact` (`scripts/lib/ops-issues.mjs`),
  which removes the value of every credential-like variable present and anything shaped like a JWT, API key, bearer
  token, or connection string. Callers pass only their own findings, never a response body.
- **An alert that cannot be delivered fails its step**, so the run shows red and GitHub's own failed-run email to the
  person who last changed the workflow is the fallback.

### One-time setup for the owner

1. GitHub, Settings, Notifications: keep **Participating, @mentions and custom** on for email (and GitHub Mobile, for
   a push). An assignment is participating.
2. Install GitHub Mobile and sign in, for pushes.
3. Nothing else: the workflows create the `ops-alert` label the first time they need it, with the repository's own
   `GITHUB_TOKEN`.

### What this cannot see, and the one external check to add

Every check above runs on GitHub's scheduler. If GitHub stops running schedules (it disables scheduled workflows in a
public repository after 60 days without activity, and a private repository over its minutes is blocked), the watchdog
stops with them. The independent check is a **Google Cloud Monitoring uptime check**, free at this volume, set up once in
the project that hosts the agent API:

- `GET https://<web origin>/api/health`, expecting 200 and `"status":"ok"`, every 15 minutes.
- `GET https://<agent API origin>/healthz`, expecting 200, every 15 minutes.
- An alerting policy on either check failing, notifying the owner's email.

That is outside this repository and has to be done in the Cloud console by the owner.

## Health checks

`scripts/ops-health.mjs` reports each check as ok, FAILING, or not configured (a check whose inputs are unset is
reported as such, never silently passed):

| Check | How | Needs |
| --- | --- | --- |
| Web app | `GET $FIRSTSEEN_WEB_URL/api/health` returns 200 `{"service":"1stseen-web","status":"ok"}` | repository variable `FIRSTSEEN_WEB_URL` |
| Agent API | `GET $FIRSTSEEN_AGENT_API_URL/healthz` returns 200, allowing a cold start | repository variable `FIRSTSEEN_AGENT_API_URL` |
| Database | `HEAD $SUPABASE_URL/rest/v1/companies` with the service-role key returns 200 or 206 | the collection secrets |
| Schedules | each scheduled workflow's last successful run is younger than its interval plus its timeout | `actions: read` |
| Worker errors | Cloudflare GraphQL analytics for `firstseen-web` over 24 hours: errors, requests, CPU p50 and p99 | variable `CLOUDFLARE_ACCOUNT_ID`, secret `CLOUDFLARE_ANALYTICS_TOKEN` (Account Analytics: Read) |

The Worker check is also how production CPU is read (below).

## Backup and restore

Supabase Free keeps no backups. `scripts/backup-corpus.mjs` takes one every Monday from GitHub Actions and proves it
restores before keeping it.

### What is backed up

The collected evidence, which cannot be recollected: an opening event's availability is when 1stSeen learned of it, so a
re-derived corpus would start every backtest cutoff from the day of the restore, and a page that has changed or gone
cannot be read again. `CORPUS_TABLES` lists them in foreign-key order: companies, sources, the takedown record (without it a restored corpus
would collect again from a company that asked to be left alone), sources' discovery evidence,
fetch records, signal state, raw observations, archive captures, canonical roles, aliases, role matches, opening events,
signals, scope reviews, identity re-keys, forecasts with their evidence and changes, and backtest runs and cases.

Every other table is named in `NOT_BACKED_UP` with its reason: user-owned rows (follows, preferences, plans, calendar and
digest records, OAuth connections), operational audit logs that can hold a user's own questions, and the collection
cursor. `worker/tests/test_ops_workflows.py` fails on a table that a migration creates and neither list names.

### How

- `dump`: inside one exported `REPEATABLE READ` snapshot, `pg_dump --format=custom --data-only` of the corpus tables,
  and a manifest with each table's row count and content hash (the md5 of the sorted md5s of every row's text form,
  with output settings pinned), the migration level, and the archive's sha256. Counts, hashes, and archive describe
  exactly the same rows even while collection writes.
- `prove-restore`: creates a scratch database, applies the repository's migrations up to the manifest's level, runs
  `pg_restore --single-transaction --exit-on-error`, compares every table's count and hash with the manifest, and drops
  the scratch database whatever happened. The migrations run with the search_path hosted Supabase gives `db push`
  (`"$user", public`, without `extensions`), so a migration that would fail there fails here too. In the workflow the
  scratch server is a throwaway `pgvector/pgvector:pg17` service container: migration 001 creates `vector`, which
  `postgres:17-alpine` cannot install.
- The archive is encrypted (`gpg --symmetric`, AES-256) with the secret `BACKUP_ENCRYPTION_PASSPHRASE` and the plaintext
  deleted before anything is kept: the repository is public, and anyone signed in to GitHub can download its run
  artifacts. The encrypted archive and the readable manifest are kept as the run's artifact for 14 days: the last two
  weekly backups. The passphrase lives in the owner's password manager too; without it no backup can be restored.

Measured on the rebuilt rig with every branch merged (99,541 rows in 20 tables, migration 202608140043): the dump
took 8.3 s and hashing 3.2 s; the archive is 51.0 MiB; all 43 migrations built the scratch schema in 0.5 s, `pg_restore`
took 9.1 s, and every table's count and content hash matched. (That scratch database was on the rig's own Supabase
server, whose `postgres` role has `extensions` on its search_path and pgvector installed, so it could not catch a hosted
failure; the workflow's restore proof runs with hosted's search_path on its own pgvector server.)

### Restoring into a new project

1. Create the project and apply `supabase/migrations` up to the manifest's `migration_level`
   (`supabase db push`, or the SQL editor in order).
2. Download the latest `corpus-backup-*` artifact and decrypt it with the passphrase from the password manager
   (`gpg --decrypt --output corpus.dump corpus.dump.gpg`), then check the archive's sha256 against the manifest.
3. `pg_restore --data-only --no-owner --no-privileges --single-transaction --exit-on-error --dbname=<new> corpus.dump`,
   with the connection in `PG*` variables rather than on the command line.
4. `SUPABASE_DB_URL=<new> node scripts/backup-corpus.mjs verify <dir>`: every table must match.
5. Apply any later migrations, point the Worker, the agent API, and the workflows at the new project, and run
   `npm run verify:supabase` against it.

The workflow needs one extra secret, `SUPABASE_DB_URL`: the project's **session pooler** URL (GitHub's runners have no
IPv6 route to the direct connection). It also needs the variable `SUPABASE_DB_CA_CERT_PEM`, the text of Supabase's root
certificate (Project Settings > Database > SSL Configuration > Download certificate, `prod-ca-2021.crt`): the pooler's
certificate chains to Supabase's own CA, so the dump verifies against it (`PGSSLMODE=verify-full`). It is a public
certificate, so a variable rather than a secret: `gh variable set SUPABASE_DB_CA_CERT_PEM < <path to the file>`. The client tools run from a `postgres:17-alpine` container
(`BACKUP_PG_TOOLS`), because `pg_dump` must be at least the server's major version.

## What a signed-in session may write

Supabase grants `authenticated` every privilege on every table created in `public`; row level security was the only
thing between a signed-in user's own access token and a write to `companies` or `forecasts`, and `TRUNCATE` is not
governed by RLS at all. Migration 202608140038 revokes every write from `authenticated` and grants back only what the
personalization and onboarding routes perform through a user-scoped client:

| Table | Writes |
| --- | --- |
| `watchlist_items` | INSERT, DELETE, UPDATE (`alerts_enabled`) |
| `recruiting_preferences` | INSERT, UPDATE |
| `priority_companies` | INSERT, DELETE |

Default privileges stop granting a write on the next table, so a new user-owned table grants what its route performs,
explicitly. `npm run verify:supabase` fails on any regrant, table or column, or default privilege
(`scripts/lib/grant-contract.mjs`), and `apps/web/tests/integration/authenticated-grants.test.mjs` proves it inside a
rolled-back transaction: the routes' writes succeed as `authenticated` with a user's claims, every other write is refused
with `insufficient_privilege`, and RLS still refuses another user's rows.

## Quotas

What each service's free tier allows, what 1stSeen uses, and where it would run out. Prices are list prices as of
September 2026; check the providers' pages before relying on them.

### Supabase (Free)

| Limit | Free tier | 1stSeen |
| --- | --- | --- |
| Database size | 500 MB, then read-only | 243 MB on the rebuilt rig (229 MB in `public`). `raw_job_observations` is the largest table at 89 MB; with everything derived from them the corpus costs about 14 KB per observation (240 MB / 17,103). |
| Egress | 5 GB uncached a month | A signed-in dashboard render reads 45 KiB in 13 requests; guest pages are served from the edge cache until the data changes. About 110,000 signed-in dashboard renders a month fit, before collection's own traffic. |
| Monthly active users | 50,000 | Not a constraint. |
| Pausing | After a week without activity | Collection writes four times a day, so the project never idles. |
| Backups | None | The weekly workflow above. |

**When the database fills.** 500 MB less 243 MB leaves about 257 MB, which is about 18,000 more observations at today's
mix. No steady-state rate has been measured: the rig was bootstrapped between 14 and 17 September and collected again
on 18 September, when one current pass added 558 observations (7.8 MB with what derives from them) after a gap of one
to four days. If that were one day's growth the database would fill in about 33 days; if it were four days', in about
four months. **This is the free tier's nearest limit.** Once production has run for two weeks, the rows
`collection-health` reports added in 24 hours times 14 KB gives the daily growth, and 257 MB divided by it gives the
days left. Supabase Pro (8 GB) is the step after.

### Cloudflare Workers

| Limit | Free | Paid ($5 a month) |
| --- | --- | --- |
| Requests | 100,000 a day | 10 million a month included, then $0.30 per million |
| CPU per invocation | 10 ms | 30 s by default |
| CPU a month | n/a | 30 million CPU-ms included, then $0.02 per million |

#### Worker CPU

Local measurements (`npm run measure:workerd`, workerd's V8 sampling profiler):

| Page | How it is served | Busy time per request |
| --- | --- | ---: |
| `/` for a guest | edge cache hit, no database call | 7.3 ms |
| `/signin`, `/calendar`, `/digests` for a guest | no database call | 6.6 to 7.5 ms |
| `/replay` | rendered, 5 database calls | 32.4 ms |
| `/` rendered (signed in, or the cache off) | 13 database calls | 41.8 ms |
| A role page rendered | database calls | 35.2 ms |
| `/methodology` rendered | database calls | 18.7 ms |

**`/replay`'s 30 ms is mostly waiting, not computing.** `/replay` used to stand out at 32.4 ms for 73.5 KiB of HTML,
against about 7 ms for the other guest pages. Profiled, 12 ms of it sits in supabase-js's `processResponse` and 8 ms of
that in `Response.text()`, yet the five responses total 8 KiB. With a delaying proxy in front of PostgREST (same page,
same bytes, only the latency changed), the profiler's busy time went from 38 ms to 63 ms to 145 ms as 0, 50, and 150 ms
were added, and the whole workerd process's CPU from 23.5 to 35 to 50 ms. Local workerd does not report the wait for a
subrequest's body as idle, so every page that renders with database calls is overstated by its database latency.
`/replay` is the only guest page measured that is not edge-cached, which is why it alone showed it. How much of its
30 ms is real work cannot be separated from the wait locally, so 30 ms is an upper bound, not an estimate. Cloudflare
bills CPU without I/O wait.

So the local numbers are upper bounds for rendered pages, and the pages that make no database call (6.6 to 7.5 ms) sit
close to the Free plan's 10 ms. **Deploy on Workers Paid.** (Measured on the merged tree on 18 September.) Production CPU is Cloudflare's own measure: the Worker
check above reports p50 and p99 every six hours once `CLOUDFLARE_ANALYTICS_TOKEN` is set.

### Google Cloud Run (the agent API)

| Limit | Free each month | 1stSeen |
| --- | --- | --- |
| Requests | 2 million | Capped by the agent API's per-token limit: 60 a minute on one instance. |
| vCPU-seconds | 180,000 | A question took about 1 s on the rig; the service runs with 1 vCPU, 512 MiB, `--max-instances=1`, `--concurrency=40`. |
| GiB-seconds | 360,000 | 0.5 GiB per busy instance-second. |

Billing is for the time an instance is handling at least one request. 180,000 vCPU-seconds is about 180,000 one-second
questions a month, roughly 6,000 a day or 4 a minute sustained. Guests share 10 questions a minute (counted per
Cloudflare location, so a burst across locations can briefly pass it); sustained, that is about 432,000 one-second
questions a month, roughly $6 past the free tier. Every question, a guest's or a member's, also passes the agent API's
per-token limit of 60 a minute, and one instance runs them, so the worst case is that instance busy all month: about
2.6 million vCPU-seconds, roughly $58 in CPU and $2 in memory at list prices. `--max-instances=1` is the ceiling on that,
and the billing account's $5 budget alert reports long before it.

**Raising `--max-instances` is a deliberate decision, not tuning.** It is 1 from launch (18 September 2026) until a week
of real bills has been watched. Each instance adds its own per-token allowance and about $60 a month to the worst case.
One instance runs one investigation at a time (`docs/deployment.md`, "Concurrency and the blocking stream"), so the sign
that a second is needed is questions queueing, seen as agent latency, not a lower bill.

### GitHub Actions

| Limit | Public repository | Private repository, Free |
| --- | --- | --- |
| Minutes | Unmetered on standard runners | 2,000 a month |
| Artifact and package storage | Unmetered | 500 MB |

The collection schedule needs about 4,000 minutes a month (docs/github-actions-collection.md). Operations adds about 150: the
health check four times a day at about a minute each (120), the weekly backup at about 6 minutes (26), and the monthly
backtest at about 3. Storage: two weekly backups at about 51 MiB each, plus JSON summaries kept 14 to 30 days, stay
under 120 MB. A private repository needs a paid plan or a lower collection cadence; a public one runs as is.

## Backtest history

`backtest.yml` now also runs monthly, and `scripts/backtest-history.mjs` lists every persisted run oldest first with its
targets, scored cases, and skip reasons in the runner's own words. On the rig the latest run had 503 targets and scored
none: 398 because no temporal evidence was available by the cutoff (the corpus was collected this week, so at a cutoff
60 days before any past opening, nothing had been observed yet) and 105 because the held-out opening is observed-by only.
The methodology page states that position. The monthly run is how the scored count is watched leaving zero as
collection accumulates evidence that predates the openings it will be tested on.
