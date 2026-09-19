# Recruiting signal methodology

Recruiting signals are supporting evidence that a recurring program may be becoming active. They are not
job openings, publication dates, or permission to invent a forecast. Every signal links to a bounded raw
observation and retains its source URL, observed time, optional source-claimed time, extraction route,
reliability, fixed strength, and evidence snippet.

## Normalized types and fixed strength

| Signal type | Strength |
| --- | ---: |
| Career page changed | 0.45 |
| Internship/program page changed | 0.68 |
| New relevant sitemap URL | 0.52 |
| Company recruiting blog post | 0.62 |
| University recruiting page update | 0.66 |
| New ATS role family appearing | 0.75 |
| Community recruiting discussion | 0.30 |

Strength is determined by the signal type, not an LLM. Reliability is the configured source trust score;
community evidence is capped at `0.45`. The forecasting model combines strength, reliability, and recency
through its explicit signal features. Signals have zero date weight, so they cannot move the historical
temporal center or manufacture an opening date.

## Deterministic collection

Company pages are reduced to visible text with scripts, styles, SVG noise, and control characters removed,
bounded to 65,536 UTF-8 bytes at a line boundary; the state row stores exactly that text. The first fetch
establishes a baseline. The meaningful hash covers the set of visible lines, so a page that only reorders its
content has not changed. A later fetch creates a signal only when it adds recruiting-related lines, and the
evidence snippet quotes those lines. Removed or reordered material never creates a signal: it is not
evidence that a program is becoming active.

RSS and Atom feeds use stable entry IDs or URLs. Only newly observed, recruiting-related entries emit a
blog signal. `pubDate` and Atom `published` may populate `claimed_event_at`; Atom `updated` never does. XML
sitemaps retain a bounded set of relevant URLs and emit only newly appearing recruiting URLs. Sitemap
`lastmod` is not a publication or claimed-event timestamp. Initial feed and sitemap fetches are baselines
unless a source explicitly enables `emit_initial_signals`.

ATS family detection compares normalized prior and current role-family sets.

## Reddit evidence

`RedditSignalAdapter` implements the `SocialRecruitingSignalAdapter` boundary using Reddit's approved
OAuth Data API. Live collection is disabled by default, requires application credentials and a descriptive
user agent, and searches only an explicit configured community allowlist. It does
not use public `.json` scraping, Playwright, author profiles, comments, or retry-based quota workarounds.

The adapter searches for the configured company plus recruiting terms, filters posts deterministically,
and recognizes explicit claims that applications opened, closed, or will open soon. A structured model is
optional and receives only bounded, likely relevant text when deterministic event classification is
ambiguous. Its evidence quote must be an exact post substring. The model cannot choose a date, strength,
reliability, confidence, or materiality.

Reddit's post timestamp is stored as `source_published_at`, separately from 1stSeen's `observed_at` and the
post's optional `claimed_event_at`. An explicit ISO date can populate the claim timestamp. “Just opened”
is represented as relative to the post time; “next month” remains unresolved text and is never converted
into a fabricated day. Community evidence is always `supporting_only`, has strength `0.30`, and reliability
at most `0.45`. A Reddit claim alone is never eligible to confirm a historical opening event; confirmation
requires appropriately linked official company or ATS evidence.

Before enabling live collection, register/request Data API access for the project's use case, configure the
OAuth application and user agent, review retention/deletion obligations, and keep the community allowlist
narrow. The implementation follows Reddit's current [Data API access guidance](https://support.reddithelp.com/hc/en-us/articles/14945211791892-Developer-Platform-Accessing-Reddit-Data),
[Data API Wiki](https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki), and
[Data API Terms](https://redditinc.com/policies/data-api-terms). Devvit authentication is not used because
this worker is an external scheduled evidence pipeline rather than an app installed in a subreddit.

## Role scope and deduplication

Deterministic alias matching assigns a canonical role only when a unique, substantive title match exists.
Ambiguous signals remain company-scoped and may update active roles at that company without pretending the
source named a specific program. A stable identity hash over source, type, URL, claimed time, and normalized
evidence prevents repeated collection from creating duplicate signals.

Only normalized visible text, feed entry keys, and sitemap URLs are retained as change state. Raw HTML is
not stored by default.

## Forecast versioning and material change

A newly persisted signal triggers deterministic forecast recomputation for affected roles. The new
forecast is inserted with `supersedes_forecast_id` and the triggering signal IDs; the previous row is never
updated. `forecast_changes` links the before and after versions.

A recomputation whose input fingerprint equals the latest stored version's writes no version and no change
row, so re-running collection cannot duplicate forecasts. A company-scoped signal also reaches roles that
cannot be forecast yet; those raise `InsufficientEvidenceError`, are skipped, and are counted as
`insufficient_evidence_roles` in the run summary instead of failing the source.

Materiality uses fixed rules:

- absolute confidence change of at least 1 percentage point;
- expected-date change of at least 3 days; or
- either prediction-interval boundary changing by at least 3 days.

Signal-only model inputs should affect the first rule, not the dates. The date rules also protect the same
versioning boundary when other sourced evidence is recomputed alongside a signal. Every change record
stores the numeric deltas and threshold reasons.

Run signal collection for one company or all configured sources. Reddit sources are skipped with an
audited reason while `REDDIT_API_ENABLED=false`:

```bash
.venv/bin/firstseen signals --company fixture.example
.venv/bin/firstseen signals --all
```
