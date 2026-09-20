# Operations

How 1stSeen is kept running once it is deployed: what reaches the owner when something breaks, what is checked
and how often, how the corpus is backed up and restored, what a signed-in session may write, and what each free tier
allows. Every number here was measured on the local rig on 18 September 2026 unless it says otherwise.

## What runs, and when

| Workflow | Schedule (UTC) | What it does | On failure |
| --- | --- | --- | --- |
| `current-jobs.yml` | 00:17, 12:17 | Current postings from every enabled source | ops-alert issue |
| `career-page-signals.yml` | 01:37, 13:37 | Career-page changes and recruiting signals | ops-alert issue |
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
  health" issue while any warning stands: a collector with no completed pass in twice its interval (24 hours for
  current jobs, 12 for signals and regeneration), no source fetch in 24 hours,
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
- `GET https://<agent API origin>/health`, expecting 200, every 15 minutes.
- An alerting policy on either check failing, notifying the owner's email.

That is outside this repository and has to be done in the Cloud console by the owner.

## Health checks

`scripts/ops-health.mjs` reports each check as ok, FAILING, or not configured (a check whose inputs are unset is
reported as such, never silently passed):

| Check | How | Needs |
| --- | --- | --- |
| Web app | `GET $FIRSTSEEN_WEB_URL/api/health` returns 200 `{"service":"1stseen-web","status":"ok"}` | repository variable `FIRSTSEEN_WEB_URL` |
| Agent API | `GET $FIRSTSEEN_AGENT_API_URL/health` returns 200, allowing a cold start | repository variable `FIRSTSEEN_AGENT_API_URL` |
| Database | `HEAD $SUPABASE_URL/rest/v1/companies` with the service-role key returns 200 or 206 | the collection secrets |
| Schedules | each scheduled workflow's last successful run is younger than its interval plus its timeout | `actions: read` |
| Worker errors | Cloudflare GraphQL analytics for `firstseen-web` over 24 hours: errors, requests, CPU p50 and p99 | variable `CLOUDFLARE_ACCOUNT_ID`, secret `CLOUDFLARE_ANALYTICS_TOKEN` (Account Analytics: Read) |

The Worker check is also how production CPU is read (below).

## Rolling back the web app

The web app is one Cloudflare Worker, `firstseen-web`. Every deploy is a version, and a rollback puts an earlier version
back at 100% of traffic in seconds, with no rebuild. Run these from the repository root, logged in to Cloudflare
(`npx wrangler login`).

List the versions, newest last, with the one serving marked (100%):

```bash
npx wrangler deployments list --name firstseen-web
```

Roll back to one of them:

```bash
npx wrangler rollback <version-id> --name firstseen-web --message "<why>" -y
```

Roll forward the same way, with the newer version's id. Then confirm the version serving and the app's health:

```bash
curl -s https://1stseen.win/api/health
```

Versions worth knowing (19 September 2026):

| Version | Commit | What it is |
| --- | --- | --- |
| `73c7424a-7f01-4a55-bd18-67ce221e4abd` | `a16146b` | Current: the not-found and error pages, and buttons at their own text size |
| `890c6646-b71d-4ddb-b4e4-ba3087a3a452` | `b65458e` | The first not-found and error pages, before their redesign |
| `88e2eff0-dac1-40b0-ac98-87ce1f883435` | `3053c1c` | The redesign with the landing page as the link preview image |
| `c48139f4-b68e-4549-a268-e0b0ceea0381` | `9219cf6` | The redesign, before the link preview image |
| `2bed8d50-1e99-48c9-8278-79d4cfb7faa6` | | The last version before the redesign (deployed 16:39 UTC): the dashboard at `/` |

To tell them apart on the live site: before the redesign, `/` has no "Know when internships open"; from `88e2eff0` on,
the pages name `og-image.png`; and from `73c7424a` on, a missing page draws a character:

```bash
curl -s -H "Accept: text/html" https://1stseen.win/this-page-does-not-exist | grep -o "illustrations/[a-z-]*\.svg"
```

- **What a rollback restores:** the earlier build, including the `NEXT_PUBLIC_*` values baked into it, and its runtime
  vars. Check `npx wrangler secret list --name firstseen-web` afterwards (deployment.md §7).
- **What it does not:** the database. None of the versions above differs in schema, so any of them runs on today's
  database. Before rolling back across a migration, check that the older code still reads the newer schema.
- **Cached guest pages:** from `c48139f4` on, a guest page stored at the edge is keyed by the Worker version that
  rendered it (`CF_VERSION_METADATA`, `docs/guest-access.md`), so after a rollback or roll forward no version serves a
  page whose stylesheet and scripts belong to another. `2bed8d50` predates that key, but the pages it could find are
  only its own.

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
| Database size | 500 MB, then read-only | **331 MB on hosted** (2026-09-20: 79 companies, 24,447 observations, 542 in-scope roles). `raw_job_observations` is the largest table; with everything derived from a posting the corpus costs about **12.6 KB per posting**, of which roughly half is the text of postings nobody can apply to. |
| Egress | 5 GB uncached a month | About **1.7-1.9 GB a month** from the schedules, measured per run against hosted on 2026-09-20 (see the table below). A signed-in dashboard render reads 45 KiB in 13 requests and guest pages are served from the edge cache until the data changes, so the rest is roughly 40,000 signed-in renders. Check **Organization → Usage → Egress** after the first week. |
| Monthly active users | 50,000 | Not a constraint. |
| Pausing | After a week without activity | Collection writes several times a day, so the project never idles. |
| Backups | None | The weekly workflow above. |

### What each schedule downloads

Measured from each workflow's own summary (`database_mb_downloaded` is response bytes on the wire, which is what
Supabase counts as egress), with the corpus at 79 companies:

| Workflow | Per run | Runs a month | A month |
| --- | --- | --- | --- |
| `career-page-signals.yml` | 6.71 MB over 254 sources, about 8.7 MB over 397 | 60 | ~520 MB |
| `current-jobs.yml` | 2.50 MB read floor (24,057 stored postings x 104 B) plus each changed company's evidence | 60 | ~360-600 MB |
| `forecast-regeneration.yml` | 3.76 MB | 120 | ~450 MB |
| `backup-corpus.yml` | 63.8 MB (the whole corpus, dumped) | 4 | ~256 MB |
| `historical-enrichment.yml` | 2.55 MB per company in the slice | 4 | ~60 MB |
| `ops-health.yml` | one PostgREST read | 60 | ~6 MB |
| `backtest.yml` | 632 targets read once | 1 | ~1 MB |

Signals were the largest item at four runs a day (about 1 GB a month), so they run twice; a page's material change
is still caught within twelve hours. A company's first collection costs far more than its steady state: batch 1's
24 companies cost 72 MB in one run, against a 2.50 MB floor afterwards, so a new batch's first pass is dispatched
per company outside the scheduled window rather than inside it.

**When the database fills.** 500 MB less 331 MB leaves about 169 MB, which is about 13,000 more postings at
12.6 KB each. Steady-state growth is not yet known: every posting in the corpus was written by the bootstrap and by
batch 1's first pass, so the first honest daily figure comes from a day of scheduled runs on an unchanged company
list. **This is the free tier's nearest limit after egress.** `collection-health` reports the rows added in 24 hours;
times 12.6 KB that is the daily growth, and 169 MB divided by it is the days left. Two changes buy room before Pro
(8 GB) is needed: keeping only the first 300 characters of the text on out-of-scope postings, roles, and events, which
frees about 93 MB and halves the cost of every future posting, and not storing what a giant board's non-early-career
postings say at all.

**Auth rate limits, and why they are raised.** Supabase Auth counts its limits per IP address: by default 30 sign-ups
and sign-ins, and 30 verifications of an emailed link, every five minutes. The app's `/api/auth/*` routes call Supabase
from the Worker, so every visitor reaches Supabase from a Cloudflare address and those buckets are shared by everyone
at once. Supabase can count the real visitor instead, through its `Sb-Forwarded-For` header, but only for requests made
with a new-format secret key; these routes act as the visitor with the publishable key, so that is not open to them
without putting a full-access key on the sign-in path. Two things stand in for it:

- **Each visitor's share is counted in the Worker** (`apps/web/cloudflare/auth-limits.ts`): 12 sign-in, sign-up,
  password-reset, or resend requests, and 12 link verifications, per address per five minutes, counted exactly by the
  same Durable Object as guest questions. A refused request answers 429 with `Retry-After`, and the panel says
  "Too many attempts from this network." There is no site-wide limit: it would let one attacker lock everyone out.
- **The project's own limits are raised** so that ordinary traffic cannot reach them (Authentication → Rate Limits):
  sign-ups and sign-ins **150 per 5 minutes**, verifications **150 per 5 minutes**, token refreshes left at 150, and
  email sending set to whatever the SMTP sender allows per hour. With one visitor bounded at 12, the project's budget
  covers a dozen visitors all retrying at once, and hundreds behaving normally.

If sign-ins ever approach that ceiling, the next step is `Sb-Forwarded-For`: create new-format API keys, enable **IP
Address Forwarding** in the same settings page, and have the auth routes call Supabase with the secret key and the
visitor's address. Supabase then counts each visitor, and the Worker's limits become a second line rather than the only
one.

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
questions a month, roughly 6,000 a day or 4 a minute sustained. Guests share 10 questions a minute, counted exactly by one
Durable Object (`docs/guest-access.md`); sustained, that is about 432,000 one-second
questions a month, roughly $6 past the free tier. Every question, a guest's or a member's, also passes the agent API's
per-token limit of 60 a minute, and one instance runs them. Without a cap the worst case would be that instance busy all
month: about 2.6 million vCPU-seconds, roughly $58 in CPU and $2 in memory at list prices.

**The worst case is $5 a month.** The billing account has two budgets on this project, both kept:

| Budget | Scope | What it does |
| --- | --- | --- |
| "1stSeen monthly (5 USD)" | the whole project | Alerts only, at 50%, 90%, and 100% of actual spend and 100% of forecast spend, by email to the billing admins and hello@1stseen.win. |
| "firstseen" | Cloud Run (`run.googleapis.com`) | 50%, 80%, and 100% alerts, with spend cap enforcement at $5 (a preview feature). |

When Cloud Run's spend for the month reaches $5, the cap stops the agent API until the next month or until the owner lifts
it. The cap was set and confirmed in the Billing console (Billing, Budgets & alerts). The Budget API, v1 and v1beta1,
does not list preview spend caps (on 19 September 2026 it returned only the first budget), so no script here can check
that the cap is still in place: look in the console.

**What stops, and what a visitor sees.** Only questions to the agent, a member's preparation plan, and a Forecast Replay
run need the agent API. A question gets a 503 from `/api/recruiting-agent` carrying one sentence, which the question panel
shows in place of an answer: "Asking questions is temporarily unavailable. Forecasts, role pages, and their evidence still
work. Please try again later." (`apps/web/lib/agent-availability.ts`). It is the same whether the paused service does not
answer or Google's front end answers with an error page, and it is never an error page itself. A member's preparation
plan and Replay run say the same of their own feature ("Generating a preparation plan is temporarily unavailable. ...",
"Running a replay is temporarily unavailable. ..."), while the service's own verdicts (a role the member does not follow,
a replay that cannot be scored leak-free) still reach them as they are. Every page, the dashboard, role pages, evidence, and collection keep working: they read
Supabase directly or run on GitHub Actions. The production health check reports the agent API as failing while it is
paused, which opens one "Production health" issue.

**Raising `--max-instances` is a deliberate decision, not tuning.** It is 1 from launch (18 September 2026) until a week
of real bills has been watched. Each instance adds its own per-token allowance and, without the spend cap, about $60 a month to the worst case.
One instance runs one investigation at a time (`docs/deployment.md`, "Concurrency and the blocking stream"), so the sign
that a second is needed is questions queueing, seen as agent latency, not a lower bill.

### GitHub Actions

| Limit | Public repository | Private repository, Free |
| --- | --- | --- |
| Minutes | Unmetered on standard runners | 2,000 a month |
| Artifact and package storage | Unmetered | 500 MB |

The collection schedule needs about 2,800 minutes a month (docs/github-actions-collection.md). Operations adds about 150: the
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
