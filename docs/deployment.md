# Deployment

Three services, two secrets, one public ingress. This document is the operational
reference for the Python agent API on Cloud Run (sections 1-6) and the web app on
Cloudflare Workers (section 7); `docs/hosted-supabase-setup.md` covers the database.

---

## 1. Architecture

```
                    browser
                       │
                       │ HTTPS, Supabase session cookie
                       ▼
        ┌──────────────────────────────┐
        │  Cloudflare Workers          │   vinext build of apps/web
        │  1stSeen web app             │
        │                              │   secrets: SUPABASE_SERVICE_ROLE_KEY
        │  /api/recruiting-agent       │            AGENT_API_BEARER_TOKEN
        │  /api/forecast-replay        │   var:     FIRSTSEEN_AGENT_API_URL
        │  /api/readiness              │   (section 8 lists every value)
        └───────┬──────────────┬───────┘
                │              │
   service-role │              │ Authorization: Bearer <AGENT_API_BEARER_TOKEN>
      PostgREST │              │ (server-to-server only; never reaches a browser)
                │              ▼
                │   ┌──────────────────────────────┐
                │   │  Cloud Run                   │  worker/Dockerfile
                │   │  firstseen-agent             │  uvicorn firstseen.agent_api:app
                │   │                              │
                │   │  GET  /health       no auth  │  SA: firstseen-agent@
                │   │  POST /v1/recruiting/query   │  secrets mounted from
                │   │  POST /v1/forecast-replay    │  Secret Manager
                │   │  POST /v1/readiness-plan     │
                │   └──────────────┬───────────────┘
                │                  │ service-role PostgREST
                ▼                  ▼
        ┌──────────────────────────────┐
        │  Supabase (hosted Postgres)  │  system of record
        │  RLS on all 33 tables        │
        └──────────────────────────────┘
```

The web app and the agent service reach Supabase independently with the same
service-role key. The agent service is never called by a browser: only the three
Worker routes call it, and they never forward the bearer token to the client.

### Why the ingress is public

Cloud Run IAM would require the caller to present a Google OIDC ID token. The
caller is a Cloudflare Worker with no Google identity and no metadata server, so
it could only mint one from a downloaded GCP service account key stored in
Cloudflare — trading a single-purpose bearer token for a long-lived Google
credential exchangeable for access tokens, held in a second vendor's store.

So `--allow-unauthenticated` is set and **the application is the auth boundary**:

| Control | Mechanism |
|---|---|
| Token is mandatory | `FIRSTSEEN_ENV=production` makes `Settings` refuse to construct without `AGENT_API_BEARER_TOKEN`. The container exits at import rather than serving open. |
| Dev bypass impossible | `ALLOW_UNAUTHENTICATED_AGENT_DEV=true` with `FIRSTSEEN_ENV=production` also refuses to construct. |
| Constant-time compare | `hmac.compare_digest`, before any body read, agent construction, or database connection. |
| Only one open route | `/health`: no input, no configuration, no database. Not `/healthz`: Cloud Run's front end reserves paths ending in "z" and answers them with its own 404. |
| Cost ceiling | Per-token rate limit, `--max-instances=1`, and a $5 monthly spend cap on Cloud Run (`docs/operations.md`). |
| No error disclosure | Every unexpected exception becomes a fixed `{"error":"internal_error"}`. |

Covered by `worker/tests/test_agent_api_surface.py`.

---

## 2. Runtime contract

| Route | Method | Auth | Notes |
|---|---|---|---|
| `/health` | GET, HEAD | **none** | `{"status":"ok","version":"<package version>"}`. Startup and liveness probe. |
| `/v1/recruiting/query` | POST | bearer | SSE. `text/event-stream`, `x-accel-buffering: no`. |
| `/v1/forecast-replay` | POST | bearer | Result, or `422` with the runner's own eligibility reason. |
| `/v1/readiness-plan` | POST | bearer | `403` unless the user already follows the role. |

Anything else is `404`; a non-POST on a `/v1/*` route is `405`. Request bodies are
capped at 16 KiB.

**All configuration is read once, at import.** `get_settings()` is
`lru_cache`d and there are no `os.environ` reads anywhere in `worker/src`. A
changed environment variable or a rotated secret therefore requires a **new
revision** — not a restart of the same one.

### Concurrency and the blocking stream

`RecruitingAgent.stream()` is a **synchronous generator** iterated directly on the
event loop in `agent_api.__call__`. While an investigation runs, that instance
serves nothing else — including `/health`.

Measured locally: a real investigation against a 3,451-role corpus took ~2.7 s end
to end, and idle RSS is ~43 MiB of the 512 MiB limit.

Consequences to keep in mind:

- `--concurrency=40` is the configured value, but it does not buy 40 parallel
  investigations on one instance; it buys 40 queued connections. Sustained load
  queues behind the running generator.
- The startup probe uses `failureThreshold=10` at `periodSeconds=5` so a busy
  instance is not killed by a probe that lost a race with a long investigation.
- The real fix, if this ever becomes a bottleneck, is to run the generator in a
  worker thread (`asyncio.to_thread` over the iterator) rather than to add
  processes — two copies of the dependency graph do not fit 512 MiB comfortably.
  Deliberately not done here: it changes the streaming path, and nothing in the
  current traffic profile needs it.

### Rate limit

`AGENT_API_RATE_LIMIT_PER_MINUTE` (default 60) is a sliding one-minute window per
token, counted **in-process, after authentication succeeds**. Tokens are keyed by
SHA-256 digest and idle keys are evicted, so the map cannot grow without bound.

With `--max-instances=1` the effective ceiling is the configured limit. Each
instance counts independently, so raising max-instances multiplies it. This is a cost guard against a leaked
token, not a distributed quota; a shared counter would need Redis, and no new
infrastructure is added without a measured requirement.

---

## 3. Secret inventory

Two secrets. Neither is ever in the image, in the service definition, or in a
plaintext environment variable on the service.

| Secret | Lives in | Reaches the service as | Also held by |
|---|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | GCP Secret Manager (`SUPABASE_SERVICE_ROLE_KEY`) | `--set-secrets`, mounted at runtime | Cloudflare Worker secret; local `.env` (gitignored) |
| `AGENT_API_BEARER_TOKEN` | GCP Secret Manager (`AGENT_API_BEARER_TOKEN`) | `--set-secrets`, mounted at runtime | Cloudflare Worker secret; local `.env` (gitignored) |

Non-secret configuration set as plain environment variables: `SUPABASE_URL`,
`FIRSTSEEN_ENV=production`, `ALLOW_UNAUTHENTICATED_AGENT_DEV=false`,
`AGENT_INTENT_LLM_ENABLED=false`.

Generate the bearer token — 32 random bytes, base64url, no padding:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

The runtime service account `firstseen-agent@<project>.iam.gserviceaccount.com`
holds **`roles/secretmanager.secretAccessor` on those two secrets and nothing
else** — granted per secret, because the project-level grant would read every
secret in the project.

Verify no value is in the deployed definition:

```bash
gcloud run services describe firstseen-agent --region us-west1 --format=export | grep -i -A3 secret
```

You should see `secretKeyRef` entries naming the secrets, never a value.

---

## 4. Rotation

Both secrets are rotated the same way: add a new version, deploy a new revision,
then disable the old version once traffic has moved. Cloud Run resolves
`:latest` **at revision creation**, so adding a version alone changes nothing.

### `AGENT_API_BEARER_TOKEN`

Two consumers must agree, so rotate in this order to avoid an outage:

```bash
NEW=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')
printf '%s' "$NEW" | gcloud secrets versions add AGENT_API_BEARER_TOKEN --data-file=-
```

1. Set the new value on the Cloudflare Worker **and** deploy the Cloud Run
   revision. Between these two steps the two sides disagree and `/v1/*` returns
   401, so do them back to back:
   ```bash
   npx wrangler secret put AGENT_API_BEARER_TOKEN
   ```
   ```bash
   scripts/deploy-agent.sh
   ```
2. Confirm, then retire the old version:
   ```bash
   gcloud secrets versions disable <OLD_VERSION> --secret=AGENT_API_BEARER_TOKEN
   ```

There is no zero-downtime path with a single shared token. If a brief 401 window
is unacceptable, deploy the new revision with `--no-traffic`, verify it with a
direct revision URL, then shift traffic.

### `SUPABASE_SERVICE_ROLE_KEY`

Rotated in the Supabase dashboard (Project Settings → API → roll the key), which
invalidates the old key immediately. Update **all three** holders:

```bash
printf '%s' "<new key>" | gcloud secrets versions add SUPABASE_SERVICE_ROLE_KEY --data-file=-
```

```bash
scripts/deploy-agent.sh
```

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

Then update the local `.env`. Anything still holding the old key fails closed —
PostgREST rejects it — so the failure mode is loud, not silent.

Rotate immediately if a key appears in a log, a screenshot, a commit, or a
support ticket. `scripts/deploy-web.sh` refuses to deploy a build whose output contains
either value, and the repository is scanned for secrets (gitleaks) before it is pushed.

---

## 5. Rollback

List revisions, newest first:

```bash
gcloud run revisions list --service firstseen-agent --region us-west1
```

Shift all traffic to a known-good revision:

```bash
gcloud run services update-traffic firstseen-agent --region us-west1 --to-revisions firstseen-agent-00007-abc=100
```

Return to the newest revision:

```bash
gcloud run services update-traffic firstseen-agent --region us-west1 --to-latest
```

A traffic shift takes effect in seconds and needs no rebuild, because the old
revision still exists with its own image and its own resolved secret versions.

Note what rollback does **not** undo: a rolled-back revision still resolves the
secret versions it was created with. If you rolled back because a rotation broke
something, the old revision holds the old token — which is usually what you want,
but it means the Cloudflare Worker must hold that same old value.

Partial rollout, to verify before committing:

```bash
gcloud run services update-traffic firstseen-agent --region us-west1 --to-revisions LATEST=10,firstseen-agent-00007-abc=90
```

---

## 6. Free-tier limits

Cloud Run's perpetual free tier, per month, per billing account:

| Resource | Free allowance | What happens past it |
|---|---|---|
| Requests | 2,000,000 | Billed ~$0.40 per additional million |
| vCPU-seconds | 180,000 | Billed per vCPU-second; only while a request is in flight |
| Memory (GiB-seconds) | 360,000 | Billed per GiB-second |
| Outbound data | 1 GiB (North America) | Billed at network egress rates |

At `--cpu=1 --memory=512Mi`, 180,000 vCPU-seconds is **50 hours of
request-processing time** per month, and the 512 MiB allocation consumes
GiB-seconds at half the CPU rate, so CPU is the binding limit. A ~2.7 s
investigation costs ~2.7 vCPU-seconds, giving roughly **65,000 investigations per
month** before CPU billing starts — far above the request ceiling in practice.

What keeps it near zero:

- **`--min-instances=0`.** Nothing is billed while idle. The cost of this is a
  cold start on the first request after a quiet period; the image loads
  dependencies lazily and idles at ~43 MiB.
- **`--max-instances=1`** is the hard cost ceiling. One instance cannot bill more
  than one concurrent vCPU no matter what arrives. Past that, Cloud Run queues
  and then returns **429** — a throttle, not a charge. Raising it is a deliberate
  decision (`docs/operations.md`, "Google Cloud Run").
- **A $5 monthly spend cap on Cloud Run** (Billing console, a preview feature)
  stops the service when the month's Cloud Run spend reaches it, until the next
  month or until the owner lifts it. Questions then say they are temporarily
  unavailable; everything else keeps working (`docs/operations.md`).
- **`--timeout=300`** bounds the worst single request at 5 vCPU-minutes.

Other services:

- **Artifact Registry** — 0.5 GB free. Each image is ~606 MB, so **two tagged
  images exceed the free tier**. Prune old tags:
  ```bash
  gcloud artifacts docker images list us-west1-docker.pkg.dev/<project>/firstseen/firstseen-agent --include-tags
  ```
  ```bash
  gcloud artifacts docker images delete us-west1-docker.pkg.dev/<project>/firstseen/firstseen-agent:<old-tag> --delete-tags
  ```
  Keep the running revision's image and one rollback target. Deleting an image a
  live revision uses breaks that revision's ability to scale up.
- **Secret Manager** — 6 active secret versions and 10,000 access operations free
  per month. Two secrets with a couple of versions each is well inside it; the
  service reads them at instance start, not per request. Disable superseded
  versions during rotation so the active count stays low.
- **Cloud Build** — 2,500 build-minutes free per month. A full build of this image
  takes a few minutes.
- **Supabase free tier** — 500 MB database and 5 GB egress. The local validation
  corpus (9,570 observations, 12,898 evidence rows) sits comfortably inside 500 MB;
  sustained archive collection is what would eventually exceed it. A paused free
  project returns connection errors until it is resumed in the dashboard.

Exceeding a Cloud Run allowance on a billing-enabled project **charges**; on a
project without billing it **stops serving**. Set a budget alert either way:

```bash
gcloud billing budgets create --billing-account=<id> --display-name="firstseen" --budget-amount=5USD
```

---

## 7. Web app on Cloudflare Workers

Prepared and dry-run verified; not yet deployed.

### Deploy

Log in once with `npx wrangler login` (or export `CLOUDFLARE_API_TOKEN`). Then, from the repository root:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon public key> FIRSTSEEN_AGENT_API_URL=https://<service>.run.app WEB_DOMAIN=1stseen.win npm run deploy:web
```

Set the two secrets once. Each command prompts for the value on stdin:

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --name firstseen-web
```

```bash
npx wrangler secret put AGENT_API_BEARER_TOKEN --name firstseen-web
```

`scripts/deploy-web.sh` validates its inputs, builds with the `NEXT_PUBLIC_*` values exported, inspects the
artifact, deploys the build-generated `apps/web/dist/server/wrangler.json` with the runtime vars and the
custom domain, confirms both secrets exist and that no `FIRSTSEEN_DEMO_MODE` secret does, and checks the
live response for security headers and fixture markers. It refuses to run with `FIRSTSEEN_DEMO_MODE` set, with
an anon key that is really a service-role key, or when not logged in.

### Where each value lives

| Value | Kind | Set by | Changing it requires |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | build-time, public | `deploy-web.sh` environment | rebuild and redeploy |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | build-time, public (RLS-limited) | `deploy-web.sh` environment | rebuild and redeploy |
| `NEXT_PUBLIC_APP_URL` | build-time, and runtime var | `deploy-web.sh` (default `https://$WEB_DOMAIN`) | rebuild and redeploy |
| `SUPABASE_URL` | runtime var | `--var` | redeploy |
| `FIRSTSEEN_ENV=production` | runtime var | `--var` | redeploy |
| `FIRSTSEEN_AGENT_API_URL` | runtime var | `--var` | redeploy |
| `SUPABASE_SERVICE_ROLE_KEY` | Worker secret | `wrangler secret put` | `secret put` (rotation: section 4) |
| `AGENT_API_BEARER_TOKEN` | Worker secret | `wrangler secret put` | `secret put`, with Cloud Run (section 4) |
| `FIRSTSEEN_DEMO_MODE` | never set in production | | |

Vite reads the root `.env` during every build (`envDir: "../.."`), so a build made outside the script can
fold development values into the server bundle.

### Custom domain

`1stseen.win` is registered with Cloudflare Registrar, so its zone is in the Worker's account. `--domain 1stseen.win`
attaches a Workers Custom Domain, which creates the DNS record and certificate. That works only when the zone is in the same
Cloudflare account as the Worker and no other record exists for the hostname. Once the domain serves, set
the Supabase Auth Site URL and Redirect URLs to it (`docs/hosted-supabase-setup.md` §3).

The app serves one origin. `www.1stseen.win` and `firstseen.tabishnavaid.dev` belong to a separate Worker,
`firstseen-redirects` (`infra/redirect-worker/`), which answers every request with a 301 to the same path and query on
`https://1stseen.win`. Serving the app on a second hostname would break sign-in across hosts (session cookies are
host-only, auth emails and OAuth callbacks name `NEXT_PUBLIC_APP_URL`) and split the guest cache. Deploy it with
`npx wrangler deploy --config infra/redirect-worker/wrangler.jsonc`; both zones must be in the Worker's account.

### Authentication

Every Supabase Auth call runs in the Worker's `/api/auth/*` routes; the browser never talks to Supabase.
Session cookies are `HttpOnly`, `SameSite=Lax`, and `Secure` over HTTPS, and `apps/web/proxy.ts` refreshes
them at the request boundary when the access token is near expiry.

Hosted project settings that must match the code:

| Setting (Supabase dashboard) | Value | Why |
|---|---|---|
| Authentication → Emails → **Confirm signup** template | contents of `supabase/templates/confirmation.html`, subject "Confirm your 1stSeen account" | the link carries its one-time token in the URL fragment, which never reaches a server or a request log; the default template puts it in the query string |
| Authentication → Emails → **Reset password** template | contents of `supabase/templates/recovery.html`, subject "Reset your 1stSeen password" | same |
| Authentication → Sign In / Providers → Confirm email | on | sign-up never signs anyone in; it waits for the confirmation link |
| Minimum password length | 8, and no extra character rules | the app enforces the same policy before calling Supabase; sign-up runs after its response is sent, so a stricter Supabase rule could not be reported to the user |
| Authentication → URL Configuration → Redirect URLs | `https://1stseen.win/**` (and `http://localhost:3000/**`) | the app sends `/auth/confirm` and `/auth/reset` as redirect targets |
| Authentication → Attack Protection → CAPTCHA | **off** | the auth routes send no CAPTCHA token, so turning it on makes every sign-in fail |

Account enumeration. Sign-up, resend, and reset requests wait for Supabase and answer the same 202 on a
1.5 s floor; sign-in failures share one body and an 800 ms floor. Slower-than-floor calls round up to the
next step, so the app's own routes do not reveal which addresses have accounts
(`tests/integration/auth-flows.test.mjs` measures it). If hosted Supabase's email sending routinely takes
longer than 1.5 s, raise `EMAIL_REQUEST_FLOOR_MS` in `lib/auth/policy.ts`. Supabase Auth's endpoint is
public, though, and can be probed directly without the app: that is Supabase's surface, limited by its rate
limits. Adding CAPTCHA would need the routes to forward a Turnstile token first.

The local rig reads the same templates from `supabase/config.toml` and raises the local email limit to
100 an hour for the integration tests; both apply after `supabase stop` and `supabase start`. Mail goes to
Mailpit at <http://127.0.0.1:55424>.

### Security headers

Set by the Worker entry on every rendered and API response (`apps/web/cloudflare/security-headers.ts`,
tested in `apps/web/tests/security-headers.test.mjs`):

- `Content-Security-Policy` with a fresh nonce per request: `default-src 'self'`, `script-src 'self'
  'nonce-…'`, `style-src 'self' 'unsafe-inline'` (React style attributes cannot carry a nonce),
  `img-src 'self' data:`, `font-src 'self'`, `connect-src 'self'` only (the browser never calls Supabase or the agent service directly),
  `frame-ancestors 'none'`, `form-action 'self'`, `base-uri 'none'`, `object-src 'none'`, and
  `upgrade-insecure-requests` over HTTPS
- `Strict-Transport-Security: max-age=31536000; includeSubDomains` (no `preload`)
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`

Files in `dist/client` are served by the asset layer before the Worker runs, so they carry only vinext's
generated `_headers` cache rule.

### Plan limits

Workers Free allows 100,000 requests a day and 10 ms of CPU per request. Measured in local workerd after
the read paths were bounded (`npm run measure:workerd`): dashboard 29 ms, role pages 19–40 ms, `/replay`
12 ms, and even a 14 KiB 404 page 10.8 ms. No page that renders evidence fits the Free limit, because
the React Server Components render floor alone is 6–11 ms. Deploy on Workers Paid, which raises the
per-request CPU limit far above these figures.

### Rollback

```bash
npx wrangler deployments list --name firstseen-web
```

```bash
npx wrangler rollback <version-id> --name firstseen-web
```

A rollback restores an earlier build, including the `NEXT_PUBLIC_*` values baked into it. Check
`npx wrangler secret list --name firstseen-web` afterwards.

The versions worth knowing, and how to tell them apart on the live site, are in `docs/operations.md`, "Rolling back
the web app".

---

## 8. Production configuration inventory

Names only. Where a value is empty it is not set in that place.

`npm run preflight -- --production --env-file .env.deploy` validates a production environment against
the same inventory (`scripts/lib/env-catalog.mjs`); `docs/PRODUCTION_CHECKLIST.md` is the step-by-step.

| Variable | Secret | Cloudflare Worker | Cloud Run | GitHub Actions | Local `.env` |
|---|---|---|---|---|---|
| `SUPABASE_URL` | no | var | env var | secret | yes |
| `SUPABASE_SERVICE_ROLE_KEY` | **yes** | secret | Secret Manager | secret | yes |
| `NEXT_PUBLIC_SUPABASE_URL` | no | build | | | yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | no | build | | | yes |
| `NEXT_PUBLIC_APP_URL` | no | build and var | | | development origin |
| `FIRSTSEEN_ENV` | no | `production` | `production` | unset (development) | `development` |
| `AGENT_API_BEARER_TOKEN` | **yes** | secret | Secret Manager | | optional |
| `FIRSTSEEN_AGENT_API_URL` | no | var | | | local service |
| `ALLOW_UNAUTHENTICATED_AGENT_DEV` | no | | `false` | | `false` |
| `AGENT_INTENT_LLM_ENABLED` | no | | `false` | | `false` |
| `AGENT_API_RATE_LIMIT_PER_MINUTE` | no | | default 60 | | optional |
| `MAX_SOURCE_BYTES` | no | | | var, fallback `10000000` | yes |
| `HTTP_MIN_HOST_INTERVAL_SECONDS` | no | | | var, fallback `0.25` | yes |
| `COURTESY_HTTP_MIN_HOST_INTERVAL_SECONDS` | no | | | var, fallback `1.5` | |
| `SUPABASE_DB_URL` | **yes** | | | secret (backup) | verification scripts only |
| `SUPABASE_DB_CA_CERT` | no | | | variable `SUPABASE_DB_CA_CERT_PEM` holds the certificate itself | path to Supabase's root CA, outside the repository |
| `FIRSTSEEN_CONTACT_EMAIL` | no | var, once confirmed to receive mail | | | optional |
| `ROBOTS_TXT_ENFORCED` | no | var (states the rule on `/data-sources`) | | var, fallback `false` | `false` |
| `FIRSTSEEN_DEMO_MODE` | no | never | never | never | commented out |

GitHub Actions leaves `FIRSTSEEN_ENV` unset on purpose: `production` makes `Settings` require
`AGENT_API_BEARER_TOKEN`, which the collectors do not use. Google Calendar, Gmail, Reddit, and model-provider
variables stay unset until they are configured; their secrets belong in Worker secrets, Secret
Manager, or Actions secrets, never in vars.

Scheduled collection, its concurrency rules, Actions-minute cost, and the Supabase inactivity pause are in
`docs/github-actions-collection.md`.
