# Source collection reliability audit

Audited 2026-08-14. This review covers deterministic ATS, generic HTML, RSS/Atom, sitemap, Wayback,
browser fallback, transport, deduplication, and collection persistence paths.

## Implemented controls

- Shared HTTP collection enforces public HTTP(S) destinations and redirects, a bounded response read,
  configurable timeout, and per-origin courtesy pacing. Collection has no automatic retry loop.
- Structured endpoints treat invalid JSON, unsupported response shapes, wholly malformed entries, and
  truncated SmartRecruiters pages as degraded input rather than a successful empty response.
- RSS/Atom parsing uses the hardened XML boundary, validates the feed root, resolves relative links, and
  prefers Atom alternate HTML links over self/feed links.
- Sitemap traversal has configured count, depth, and page caps; detects cycles; deduplicates URLs; and
  isolates nested sitemap and child-page failures. Successful child evidence survives a partial run.
- Static HTML extraction rejects navigation labels and non-HTTP links and requires job-specific title or
  path evidence. Known tracking parameters are ignored only for observation identity, not source evidence.
- Access/verification interstitials explicitly degrade without invoking Playwright or a model. Playwright
  waits for DOM readiness under a configured timeout and has the same output-size ceiling as HTTP.
- Wayback collection isolates CDX target failures, skips malformed rows with diagnostics, caps capture work,
  records unavailable snapshots as incomplete evidence, and disables browser/model fallback for archives.
- A source hash advances only after complete collection. Degraded input therefore cannot become a cached
  empty source or incorrectly refresh every existing job's `last_seen_at`.
- Source fetch audit records contain a bounded diagnostic code, severity, URL, exception type, and counts;
  raw response bodies and exception messages are not stored. Duplicate observations are collapsed before
  persistence, while date evidence after first-seen or without a timezone is rejected with provenance.

## Deliberate limitations

- SmartRecruiters collection currently supports one official page of 100 postings. If the endpoint reports
  more, the partial evidence is retained and the source is marked degraded; it is never presented as complete.
- Browser extraction remains opt-in per source and is not used to defeat access controls. Persistent access
  challenges require a supported structured source or source-owner cooperation.
- There are no in-process retries. Scheduled collection performs later attempts, avoiding duplicate traffic
  and retry storms during provider incidents.
- Static HTML extraction is intentionally conservative. Unrecognized layouts yield zero deterministic jobs
  and may use an explicitly configured fallback only when recruiting evidence is present.

Regression fixtures cover malformed and truncated structured payloads, malformed XML, Atom link ordering,
navigation-heavy career HTML, tracking duplicates, cyclic and partially failing sitemaps, access challenges,
invalid Wayback rows, unavailable archive snapshots, future publication dates, and host pacing.
