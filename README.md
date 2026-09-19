# 1stSeen

1stSeen is an evidence-first recruiting intelligence product. It reconstructs recurring internship and new-grad hiring cycles, detects current signals, statistically forecasts the next opening window, and works backward into preparation deadlines.

- **Live:** _\<production URL — added at deploy\>_
- **Screenshots:** _\<production screenshots — added at deploy\>_

**Where accuracy stands.** Every opening date is a statistical prediction from public posting history, and its
accuracy is not yet validated: the leak-safe backtest run on 18 September 2026 (572 held-out openings) could score none, because
the corpus was collected this month and a past opening may be forecast only from facts 1stSeen had recorded before it.
The methodology page (`/methodology`) states the current position from the latest persisted run.

The repository is a deliberately small monorepo:

```text
apps/web/            The product: TypeScript on vinext (a Next.js-compatible framework) for Cloudflare Workers
worker/              Python collection, intelligence, forecasting, and the agent API (Cloud Run)
packages/shared/     Runtime-validated contracts used by the web boundary
supabase/            Postgres migrations and local configuration
scripts/             Verification, measurement, backup, health, and deploy scripts
docs/                Methodology, operations, deployment, audits, and the account and takedown contracts
.github/workflows/   CI, scheduled collection, backtest, backup, and health checks
```

## Non-negotiable product contract

LLMs may normalize and interpret sourced text. They never select forecast dates, interval bounds, or confidence scores. Those values come from the deterministic statistical model in `worker/src/firstseen/forecasting.py`.

Every historical event and signal points to an immutable raw observation. Every forecast input is listed in `forecast_evidence`, and the `forecast_provenance` view joins it back to a source URL, observation timestamp, content hash, and extraction method.

The Northstar, Meridian, and Atlas records are development fixtures on reserved `.example` domains. They render only
when `FIRSTSEEN_DEMO_MODE=true` and no database is configured, are labelled as fixtures when they do, and
`npm run verify:supabase` fails if any `.example` row reaches a database.

## Statistical forecast engine

The forecast engine uses uncertainty-weighted circular dates with hierarchical shrinkage. Direct role
history dominates when several cycles exist; roles with zero, one, or two cycles borrow bounded evidence
from sourced company and role-family seasonal priors. Sparse-history confidence caps prevent two dates from
looking certain. Recent recruiting signals and company recruiting scale can raise or lower confidence but
cannot move the expected date.

Outputs include the expected opening date, 80% prediction interval, conservatively calibrated probability,
factor decomposition, evidence/feature contributions, model version, and forecast timestamp. The complete
equations, shrinkage weights, interval floors, calibration caps, provenance contract, and limitations are
documented in [the forecasting methodology](docs/forecasting-methodology.md).

## Leakage-safe backtesting

Rolling historical evaluation reconstructs each forecast at a cutoff before the held-out opening. An
event or signal is eligible only when both its fact date and its system-availability timestamp are at or
before that cutoff; the entire held-out role/year cycle is excluded regardless of duplicate metadata. Results include date error,
interval coverage and width, confidence calibration, history-count slices, and source-quality slices.
Undefined metrics are emitted as JSON `null`, and the repository contains no manufactured benchmark row.

Run and persist an evaluation while printing dashboard-ready JSON:

```bash
.venv/bin/firstseen backtest --cutoff-days 60
.venv/bin/firstseen backtest --from-year 2022 --to-year 2025
```

The precise eligibility rules, metric definitions, and audit contract are in
[the backtesting methodology](docs/backtesting-methodology.md).

Forecast Replay at `/replay` runs this same path for one case, on demand. Only `exact` and `bounded` held-out
openings are offered: an archive capture date proves a role was visible by then, not that it opened then, so
scoring against it would manufacture an accuracy number. A corpus can legitimately produce zero evaluable
cases — every fact becomes available to 1stSeen at collection time, so a cutoff before that admits no
evidence — and the product says exactly that instead of showing a result.

## Live recruiting signals

Company pages, recruiting feeds, and sitemaps are monitored for new supporting evidence. Deterministic
change detection emits normalized signals for career/program updates, recruiting posts, relevant sitemap
URLs, university recruiting changes, new ATS role families, and narrowly scoped Reddit recruiting-event
claims. Reddit uses approved OAuth API access only, is disabled without explicit credentials, stores no
author identity, and keeps community claims below official company/ATS authority. Deterministic text rules
handle clear claims; an optional structured model sees only likely relevant bounded text.

Signal type determines fixed strength, source trust determines reliability, and the statistical forecast
model applies recency. Signals have zero date weight. Material changes create a new immutable forecast row,
retain the prior row, and link both versions with the triggering signals and numeric deltas. See
[the recruiting signal methodology](docs/recruiting-signals.md).

```bash
.venv/bin/firstseen signals --company example.com
.venv/bin/firstseen signals --all
```

## Local setup

Requirements: Node 22+, Python 3.11+, and Docker only if running Supabase locally.

```bash
make setup
make supabase-start
make supabase-reset
npm run dev
```

## Recruiting Intelligence Agent

`RecruitingAgent` answers natural-language questions by orchestrating typed access to stored jobs, career
page observations, role history, archives, recruiting signals, the statistical forecast engine, forecast
provenance, and readiness planning. It skips irrelevant tools, escalates sparse history to archives, and
returns explicit limitations when the evidence is insufficient. It never scrapes directly or calculates
its own opening date or confidence.

The dependency-free ASGI endpoint streams safe observable events from `POST /v1/recruiting/query`, and also
serves `POST /v1/forecast-replay` and `POST /v1/readiness-plan`. Install `worker[api]` to run it with Uvicorn
locally. The web routes proxy it using the server-only `AGENT_API_BEARER_TOKEN`; until it is reachable,
Forecast Replay and the "Generate preparation plan" action report that the worker is not configured rather
than degrading to a fixture. See [the agent architecture](docs/recruiting-agent.md).

Tool selection stays deterministic. With `AGENT_INTENT_LLM_ENABLED=true`, a model may interpret a question the
keyword rules did not recognise into the typed tools it needs — it can only widen tool selection and returns a
closed vocabulary of booleans plus one question class. It cannot produce a date, an interval, a confidence
value, or any evidence, and every routing failure falls back to the deterministic parse.

It supports single-role forecasts plus indexed portfolio questions: openings expected in the next N days,
current watchlist preparation, forecast-change explanations, confidence explanations, networking and
referral deadlines, and companies with the earliest sourced historical cycles. Responses contain both a
human summary and typed structured results. Stale portfolio forecasts and missing watchlist identity are
reported explicitly.

Users can follow companies, canonical roles, role families, internships, and new-grad opportunities.
Explicit graduation, season, location, priority-company, and company-size preferences rank only that
followed set using an explainable fixed policy. See
[`docs/watchlists-and-personalization.md`](docs/watchlists-and-personalization.md).

`make setup` installs the JavaScript workspaces, creates `.venv`, installs the worker package and development checks, and creates `.env` from `.env.example` when missing.

## Signing in and user-owned state

Forecasts and evidence are readable without an account. A Supabase session (`/signin`, email and password)
unlocks the user-owned half of the product: the watchlist, deterministic readiness milestones, the recruiting
calendar, and email digests. Every one of those tables is protected by row-level security scoped to
`auth.uid()`, and the service-role key never reaches the browser.

Settings' "Your data" section downloads everything an account holds as one JSON file and deletes the account. Deleting
every row the account owns and its sign-in is guaranteed; revoking Google access is asked of Google first but cannot
be guaranteed, so nothing Google answers stops the deletion, and the user is told to remove access at
myaccount.google.com when Google does not confirm. What is exported, what is deleted and kept, and what happens when a
step fails are in [`docs/account-data.md`](docs/account-data.md).

Following a role writes one `watchlist_items` row through `/api/personalization`; there is no second
preference store. Follows drive the dashboard watchlist filter, the recruiting calendar, digest inputs, and
watchlist-scoped agent questions. Readiness milestones are produced by the versioned policy in
`readiness.py` — from the role page, from the agent, or in bulk:

```bash
.venv/bin/firstseen plan-readiness
```

The web app never renders development fixtures when Supabase is configured. Without credentials it shows an
explicit "Not configured" workspace; fixtures appear only when `FIRSTSEEN_DEMO_MODE=true` *and* no database is
configured.

Useful addresses on the local rig (`scripts/local-rig.sh up`, ports 5542x so it does not collide with another local
Supabase; details in [`docs/local-development.md`](docs/local-development.md)):

- Web: `http://localhost:3000`
- Supabase API: `http://127.0.0.1:55421`
- Postgres: `127.0.0.1:55422`
- Mailpit (every auth email): `http://127.0.0.1:55424`
- Agent API: `http://127.0.0.1:8000` (`scripts/local-rig.sh agent`)

## Verification

```bash
npm run check              # lint, types, shared + worker + web tests, build, ruff, mypy, dry run; no database needed
npm run test:integration   # against the local rig: guest boundary, grants, account export and deletion, role pages
npm run verify:supabase    # schema, RLS, grants, functions, migration history, and no fixture rows, for any project
npm run metrics:corpus     # corpus counts from the system of record
npm run measure:workerd    # per-request CPU under local workerd (see docs/operations.md for how to read it)
```

The gate includes guards that fail a change rather than trusting review: every PostgREST read is paged to exhaustion
or annotated with the cap that bounds it (`worker/tests/test_read_bounds.py`, `apps/web/tests/read-bounds.test.mjs`),
no two migrations share a number (`worker/tests/test_migration_numbering.py`), every table is either backed up or
excluded with a reason, and every scheduled workflow reports failures to the owner (`worker/tests/test_ops_workflows.py`).

## Scheduled collection

GitHub Actions separately schedules current-job collection, recruiting-page change detection, historical
enrichment, changed-evidence forecast regeneration, a monthly backtest, a weekly corpus backup with a restore proof,
and a six-hourly production health check; every failure opens an issue assigned to the owner
([`docs/operations.md`](docs/operations.md)). All collection jobs
share concurrency protection, persist source/run audit state, and publish bounded JSON summaries. Required
secrets, schedules, partial-failure semantics, and manual dispatch are documented in
[`docs/github-actions-collection.md`](docs/github-actions-collection.md).

## Policy pages, contact, and takedown

Every page's footer links the methodology page and five policy pages: `/terms`, `/privacy`, `/privacy/google` (the
Google API Services Limited Use disclosure), `/data-sources`, and `/contact`. The four policy pages are drafts for the
owner's review, marked while `LEGAL_PAGES_ARE_DRAFTS` in `apps/web/lib/legal.ts` is true. The one contact address is
`FIRSTSEEN_CONTACT_EMAIL`; unset, `/contact` says no address is configured and `/data-sources`, which carries the
takedown procedure, is not published (404, and unlinked) until an address that receives mail is set.

A company's request to stop collection or to be removed is handled with `firstseen sources disable|enable|show` and
`firstseen withdraw-company` (a dry run unless `--apply`), each recorded in `collection_takedowns`. Erasure is a
documented manual step. Collection can honour robots.txt before every request (`ROBOTS_TXT_ENFORCED`, off by default).
The procedure, timelines, and the measured cost of turning robots.txt on are in [`docs/takedown.md`](docs/takedown.md).

The reviewed trust boundaries, implemented fixes, and production residual controls are documented in
[`docs/security-audit.md`](docs/security-audit.md).
Alerts, health checks, the weekly corpus backup and its restore, grants, and the free-tier arithmetic are in
[`docs/operations.md`](docs/operations.md).
Source-collection failure modes, degradation semantics, and deliberately unsupported behavior are documented
in [`docs/scraping-reliability-audit.md`](docs/scraping-reliability-audit.md).
The ML methodology review, corrected leakage paths, and remaining calibration limitations are documented in
[`docs/forecasting-audit.md`](docs/forecasting-audit.md).

## Data model

- `companies` and `canonical_roles` establish recurring role identity.
- `sources` and immutable `raw_job_observations` retain retrieved evidence.
- `historical_opening_events` and `signals` are extracted facts with mandatory observation links.
- `forecasts` retain method, version, input fingerprint, interval, and factorized confidence.
- `forecast_evidence` records exactly which observations contributed and why.
- `backtest_runs` and `backtest_cases` retain model versions, computed metrics, held-out targets, and the
  exact cutoff-safe evidence set used by each historical forecast.
- `signal_source_states` keeps bounded deterministic change state; `forecast_changes` links immutable
  before/after versions when supporting evidence triggers recomputation.
- `profiles`, `watchlist_items`, `recruiting_preferences`, `priority_companies`, and
  `readiness_milestones` hold user-owned state under RLS.
- `google_calendar_connections` holds server-only encrypted OAuth credentials; `calendar_event_syncs`
  persists explicit user selections and external event IDs for idempotent updates. Setup and disconnect
  semantics are documented in [`docs/google-calendar-integration.md`](docs/google-calendar-integration.md).
- `gmail_connections` stores separately consented, encrypted Gmail credentials. `email_digest_deliveries`
  and `email_digest_items` retain deterministic input fingerprints, delivery state, external message IDs,
  and links to every recruiting record included. See
  [`docs/email-intelligence-digests.md`](docs/email-intelligence-digests.md).
- The Application Readiness Planner works backward from every prediction interval into networking,
  referral-contact, resume, relevant portfolio/project, and high-alert dates. Its versioned policy adjusts
  lead time for company size, recruiting scale, role competitiveness, interval width, and confidence while
  retaining a plain-language explanation for every deadline. See
  [`docs/readiness-methodology.md`](docs/readiness-methodology.md).
- `agent_runs`, `agent_tool_calls`, and `model_usage` make automation behavior and cost auditable.
- `account_deletions` records that an account was deleted, with counts and Google revocation outcomes and no personal
  data. See [`docs/account-data.md`](docs/account-data.md).
- `source_discovery_evidence` explains how each careers page, ATS board, feed, or sitemap was found.
- `collection_takedowns` records every stop, resume, withdrawal, and erasure of collection: who, when, why, and which
  sources and roles changed ([`docs/takedown.md`](docs/takedown.md)).

## Company discovery

`IdentifyCompany` and `DiscoverRecruitingSources` turn a company domain or name into an official
identity plus ingestion-ready source configurations. Discovery follows verified DNS and redirects,
Organization metadata, careers and campus links, observed ATS URL patterns, robots directives,
sitemap probes, and RSS/Atom link metadata. The LLM is consulted only if those deterministic checks
cannot resolve a company name, and its proposed domain must still be fetched and matched to observed
identity metadata.

Every result carries a source category and bounded evidence. Repeated discovery uses stable IDs and
updates the same company/source records. To discover sources, persist their provenance, and optionally
ingest them immediately:

```bash
.venv/bin/firstseen discover --company example.com
.venv/bin/firstseen discover --company "Example Company" --ingest
```

The tool's `CompanyDiscoveryResult.source_configs()` output is the native input to the existing
source ingestion service; no hand-written ATS configuration is required.

## AI model routing

`ModelRouter` exposes four stable capabilities: `extract`, `classify`, `normalize`, and `reason`.
Each capability reads an ordered, comma-separated list of LiteLLM model routes from its matching
environment variable. Routes may use Gemini, Groq, or local Ollama, and model IDs remain configuration
rather than application code. Empty capability routes inherit `LLM_DEFAULT_ROUTES`, then the legacy
single `LLM_MODEL` setting. The checked-in default is local Ollama, so model cost can remain zero.

The router falls through only for rate limits, exhausted quota, temporary provider failures, timeouts,
or Pydantic-invalid structured output. It never retries the same rate-limited or quota-exhausted provider
during a request, and it does not hide permanent errors such as invalid credentials. LiteLLM's internal
retries are disabled so quota behavior remains explicit and auditable.

Every attempt—failed or successful—is written to `model_usage` with provider, configured model,
capability, latency, available token/cost metadata, fallback reason, and optional agent/tool linkage.
Machine-readable tasks provide a Pydantic response model; invalid JSON or schema violations cause a safe
fallback rather than leaking malformed data downstream. Tests use a deterministic scripted provider and
make no network calls.

### Deterministic-first inference

Pages are never sent directly to a model. 1stSeen first checks the stored content hash, then tries the
official ATS or feed schema, `JobPosting` JSON-LD, embedded structured data, static HTML parsing, and
deterministic date parsing. A generic page can reach model extraction only when it changed, deterministic
routes found no jobs, model use is enabled for that source, and visible text still contains recruiting
evidence. Explicit “no openings” pages and pages without recruiting markers are recorded as suppressed
decisions and do not call a model.

Recurring-role resolution applies the same policy: persisted aliases and compatible canonical mappings,
normalized features, fuzzy similarity, and optional embeddings are evaluated before structured model
classification. The model is called only for the resolver's bounded ambiguity band. Each resolution stores
whether a model was skipped or escalated and why.

`inference_decisions` records page-level rationale. The `inference_run_metrics` view exposes pages
processed, pages changed, deterministically parsed pages, model escalations, escalation percentage,
successful model extractions, and provider-fallback frequency for a future admin/debug screen. Percentages
use all evaluated pages as the escalation denominator and escalations as the fallback denominator. Inspect
the same contract locally or in automation with:

```bash
.venv/bin/firstseen metrics
.venv/bin/firstseen metrics --run-id <agent-run-uuid>
```

Example routing shape (replace the model names with provider models available to your accounts):

```dotenv
LLM_EXTRACT_ROUTES=gemini/provider-model,groq/provider-model,ollama/local-model
LLM_REASON_ROUTES=groq/provider-model,ollama/local-model
```

## Scheduled ingestion

The six-hour GitHub Action installs only the worker package, reads enabled sources from Supabase, stores content-addressed observations, and records every adapter run as an agent tool call.

Supported adapters:

- Greenhouse public Job Board API
- Lever public Postings API
- Ashby public Job Board API
- SmartRecruiters public Postings API
- generic career pages
- RSS and Atom feeds
- XML sitemaps, with bounded, cycle-safe sitemap-index traversal
- Internet Archive Wayback CDX and archived HTML captures

Generic pages follow this order: official structured adapter when configured, `JobPosting` JSON-LD, embedded JSON, confident static links, optional Playwright rendering, then optional LLM extraction. Browser and model fallbacks must be enabled per source through `metadata.options.allow_browser` and `metadata.options.allow_llm`.

Configure a source by setting `sources.adapter` and, for ATS systems, `metadata.external_key` to the public board or company token. For example:

```sql
insert into public.sources (company_id, url, kind, adapter, trust_score, metadata)
values (
  '<company-uuid>',
  'https://boards.greenhouse.io/example',
  'ats',
  'greenhouse',
  0.95,
  '{"external_key":"example","options":{}}'
);
```

Run one configured company by exact name, domain, or UUID, or run every enabled source:

```bash
.venv/bin/python -m firstseen.cli ingest --company example.com
.venv/bin/python -m firstseen.cli ingest --all
# The installed console command is equivalent:
.venv/bin/firstseen ingest --all
```

`published_at` is populated only from an explicit source field such as Greenhouse `first_published`, `datePosted`, `publishedAt`, `releasedDate`, RSS `pubDate`, or Atom `published`. Greenhouse `updated_at`, Atom `updated`, and sitemap `lastmod` are never treated as publication dates. `first_seen_at` and `last_seen_at` remain 1stSeen observation timestamps.

Raw pages are not stored by default. The database retains normalized fields and a bounded evidence excerpt, while `source_fetches` records page hashes, byte counts, extraction routes, and unchanged runs. Playwright remains an optional dependency for demonstrated HTTP extraction failures.

Collection uses configured HTTP and browser timeouts, bounded response sizes, and a per-origin courtesy
interval (`HTTP_MIN_HOST_INTERVAL_SECONDS`, default 0.25 seconds). It does not automatically retry or try
to bypass access challenges. Sitemap and archive child failures are isolated so valid evidence is retained;
the run is marked degraded with bounded diagnostics. Degraded responses do not advance the source content
hash, so a temporary malformed response cannot become a cached empty result. Adapter caps are clamped to
supported ranges, duplicates are collapsed before persistence, and future or timezone-naive publication
timestamps are retained only as rejection diagnostics—not accepted as publication evidence.

## Evidence enrichment

Collection persists immutable observations and archive captures. Those records only become
forecastable after recurring-role identity and opening history are derived from them, so every
ingestion run finishes with an enrichment stage over the persisted evidence:

```text
discovery → ingestion → raw observations / archive captures
          → canonical role resolution → observation_role_matches
          → historical reconstruction → historical_opening_events
          → changed-role detection → forecast versioning → readiness planning
```

`EvidenceEnrichmentService` reads the system of record rather than an in-memory collection result,
so a scheduled run, a re-run, and a backfill behave identically. Both stages are idempotent:
role resolution skips observations that already carry a persisted match, and reconstruction upserts
on the `(canonical_role_id, opened_on, observation_id)` natural key.

Archived career-page anchors are capture provenance, not job postings, so they never become canonical
roles. When reconstruction attributes a capture to a role, the capture's observation is linked to that
role at a conservative fixed confidence that reduces its downstream forecast weight.

If a source's most recent collection was degraded, its captures are treated as partial for absence
reasoning. They can still show a role was present, but they can never act as the complete earlier
capture that would manufacture a `bounded` opening window from an incomplete archive pass.

Enrichment runs automatically inside `ingest`. Re-derive from already-collected evidence with:

```bash
.venv/bin/firstseen enrich --company example.com
.venv/bin/firstseen enrich --all
```

## Historical reconstruction

Wayback sources query CDX for a careers URL or configured historical job URLs, retain unique captures,
follow observed URL changes, compare meaningful visible content, and normalize any archived jobs through
the existing deterministic page extractor. Script, style, analytics, and archive-toolbar noise do not
count as recruiting changes.

Capture time is stored as `archive_capture_at`: it proves only that content existed by that time.
`HistoricalOpeningResolver` combines captures, current observations, explicit publication dates, recurring
role aliases, and prior first-seen evidence. Each resulting historical opening is labeled as:

- `exact` when a source explicitly supplies the opening/publication date;
- `bounded` when a recent complete capture proves absence and a later capture proves presence; or
- `observed_by` when the archive has a missing, partial, redirected, or overly distant earlier period.

Every event retains its lower/upper bounds, uncertainty duration when calculable, reasoning, and full
provenance. Changed URLs are merged by recurring-role identity rather than treated as unrelated openings.

## Recurring-role identity

`RoleResolver` decides whether newly observed jobs belong to an existing annual program. It first requires
the same normalized company and compatible employment level, role family, specialization, recruiting
season, and location scope. It then scores normalized titles, stored aliases, description overlap, fuzzy
similarity, and other structured features. Similar titles cannot override a hard incompatibility.

Embeddings are requested only for borderline description matches. A structured LLM classification is
requested only when the deterministic score or candidate margin remains ambiguous; it contributes a
bounded evidence term and never sets match confidence. Verified program renames become persistent aliases.

`role_aliases` retains first/last supporting observations, while `observation_role_matches` stores the
resolver version, match score, feature breakdown, reasons, evidence, and whether expensive fallbacks were
used. The observation ID is unique, so ordinary ingestion does not repeat completed role-resolution work.

The offline evaluation fixture contains 20 obvious matches, difficult aliases, location/season variants,
renamed programs, and false friends. Its test reports every failed case with expected and actual role IDs.

Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and any optional provider credentials in repository
secrets. Local Ollama requires no cloud API key.
