# Security review

Review date: 2026-08-14

This review covered Supabase RLS and grants, authenticated web routes, service-role usage, OAuth storage,
external URLs, HTTP and browser collection, HTML/XML parsing, agent authorization, model prompts, audit
logs, and GitHub Actions secret handling.

## Fixed findings

### Server-side request forgery

All ordinary collection now enforces a public-web URL policy before the first request, after the final
response, and on every redirect. Only HTTP and HTTPS on ports 80 and 443 are accepted. Credentials in URLs,
localhost names, private DNS answers, loopback, link-local, reserved, multicast, and other non-global IP
ranges are rejected. A hostname with mixed public and private answers is rejected rather than choosing the
public answer.

The optional Playwright fallback applies the same policy to the navigation and every browser subrequest.
This is defense in depth against configured sources, redirects, sitemaps, feeds, and page-controlled links.
DNS rebinding between validation and connection remains a platform-level residual risk; production egress
should also deny private network ranges.

### Prompt injection from collected evidence

Every model path that receives webpage HTML, job descriptions, feed/community text, or normalized evidence
now labels it as untrusted data in the system message and transports it as a JSON data field. The model is
explicitly prohibited from following embedded instructions, calling tools, changing task rules, or exposing
secrets. Deterministic extraction remains first. Evidence quotes required by model-backed normalization are
checked against the source text, and model output remains schema-validated and non-authoritative.

The RecruitingAgent itself still operates over typed stored tools and does not execute webpage text or let a
model calculate forecast values.

### OAuth isolation

Google Calendar and Gmail tokens use AES-256-GCM with a random nonce and user/provider-specific authenticated
data. Moving ciphertext to another user or provider now fails authentication. OAuth state and PKCE verifier
cookies are HTTP-only, short-lived, SameSite=Lax, Secure in production, consumed once, and bound to the user
who initiated the connection.

The new `v2` ciphertext format intentionally rejects earlier unbound `v1` values. Existing development
connections must reconnect after deployment; tokens are never migrated in plaintext.

### Authorization and database integrity

Agent and replay routes now default closed even outside production. A deliberately unauthenticated local demo
requires `ALLOW_UNAUTHENTICATED_AGENT_DEV=true`, which configuration rejects in production. The internal agent
API still requires its constant-time-checked bearer token in production.

Migration `202608140019_security_hardening.sql` restricts profile updates to display name and timezone, makes
readiness dates and forecast links service-write-only, permits users to update only their own completion
timestamp, and revokes direct execution of database trigger helpers. OAuth credential and automation tables
remain unavailable to browser roles; user-owned rows retain `auth.uid()` RLS boundaries.

### Parser and link safety

Feed and sitemap XML rejects DTD and entity declarations before parsing, preventing entity-expansion attacks.
Source documents remain byte-bounded, and oversized declared or streamed responses fail closed. Shared
external-link contracts accept only HTTP(S), blocking `javascript:`, `file:`, and other active schemes.

## Existing controls verified

- The Supabase service-role key is used only by server/worker modules and GitHub Actions secrets; it is never
  exposed through `NEXT_PUBLIC_*`.
- OAuth client secrets and token encryption keys are server-only configuration.
- User-owned watchlists, preferences, priorities, calendar mappings, and digest records are owner-scoped.
- Model and agent audit records are service-only and store redacted summaries rather than raw prompts or secrets.
- HTML is parsed as data and React renders evidence as escaped text; no application use of raw HTML injection
  was found.
- GitHub Actions grants only `contents: read`, sources credentials from secrets, and uploads bounded structured
  summaries rather than raw pages or environment state.

## Deployment requirements

Apply migrations through `202608140021_signal_type_and_service_only_hardening.sql`, which also revokes
browser-role privileges on `backtest_runs`, `backtest_cases`, `signal_source_states`, and
`forecast_changes`. `202608140020_forecasting_audit.sql` is required for persisted backtest cases.
Use a new random 32-byte base64url encryption
key for each integration key setting, keep `ALLOW_UNAUTHENTICATED_AGENT_DEV=false`, and require private-network
egress denial for the worker in production as an additional DNS-rebinding control. Rotate the shared agent API
bearer token if it has ever appeared in logs or an untrusted environment.
