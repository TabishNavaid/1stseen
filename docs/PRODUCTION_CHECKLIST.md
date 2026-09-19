# Production checklist

Everything between "I have the accounts" and "the site is live and collecting". Written to be followed
tired: do the steps in order, run each command as shown, compare with **Expected**, and do what
**If not** says. Nothing here needs code changes. If a step fails in a way this page does not cover,
stop and file it; do not improvise around a check.

Total time: about 90 minutes, plus corpus collection time (step 6).

Values never go into chat, commits, screenshots, or command arguments. They go in your password
manager, `.env.deploy` (gitignored), and the three secret stores named below.

---

## 0. Before you start

You need, logged in:

| Account | Needed for | Note |
|---|---|---|
| Supabase | database and sign-in | Free plan is fine to launch |
| Google Cloud, with billing enabled | agent API on Cloud Run | Cloud Run needs a billing account even inside its free tier |
| Cloudflare, holding the `1stseen.win` zone | web app on Workers | See the plan note below |
| GitHub | scheduled collection | The repository is public, so Actions minutes are unmetered; see step 7 |

Tools on this machine:

```bash
gcloud auth login
```

```bash
npx wrangler login
```

```bash
gh auth status
```

**Expected:** each reports a logged-in account.

Two decisions this checklist does not make for you:

- **Cloudflare plan.** Workers Free allows 10 ms of CPU per request. Measured evidence pages use 12–40 ms
  (`npm run measure:workerd`), so on Free the dashboard and role pages will fail under the limit. Pick Workers
  Paid before step 4, or accept that only light pages work.
- **Repository visibility.** Scheduled collection needs about 4,000 Actions minutes a month. Public
  repositories get that free; a private one on GitHub Free gets 2,000.

---

## 1. Supabase project (15 min)

Follow `docs/hosted-supabase-setup.md` §1–§3 exactly. The short version:

1. Create the project (region `us-west-1`), store the database password in your password manager.
2. Copy four values into your password manager: Project URL, `anon` key, `service_role` key, and the
   direct connection string (**Project Settings → Database → Connection string → URI**, port 5432).
3. Apply migrations:

```bash
npx supabase link --project-ref <ref>
```

```bash
npx supabase migration list --linked
```

```bash
npx supabase db push
```

**Expected:** after `db push`, `migration list --linked` shows every migration on both sides, through
`202608140045` (the collectors' batched writes; without it enrichment fails for every company, because it asks the
database for each source's latest fetch through a function that migration adds). Three of them change what the hosted
database allows, so confirm each landed:
`202608140031_guest_access` (anon loses every table grant; `npm run verify:supabase` reports
`grants/anon-anywhere` PASS), `202608140032_scope_widening` (seven disciplines and the apprenticeship type), and
`202608140033_role_scope_reviews` (the service-only review table and `record_role_scope_review`).
**If not:** re-run `db push` and read its error. **Never** run `db reset --linked` or pass `--include-seed`:
both load fixture data into the real database.

4. **Authentication → Sign In / Providers:** Email on, Confirm email on, minimum password length 8,
   anonymous sign-ins off.
5. **Authentication → URL Configuration:** Site URL `https://1stseen.win`; Redirect URLs
   `https://1stseen.win/**` and `http://localhost:3000/**`.
6. **Authentication → Emails → Templates:** paste `supabase/templates/confirmation.html` into **Confirm signup**
   (subject `Confirm your 1stSeen account`) and `supabase/templates/recovery.html` into **Reset password**
   (subject `Reset your 1stSeen password`). With the default templates, confirmation and reset links will not
   work.
7. **Authentication → Attack Protection:** leave **CAPTCHA off**. The app's sign-in routes do not send a
   CAPTCHA token, so turning it on breaks every sign-in.

Supabase's built-in email sender is for testing and is tightly rate-limited (the dashboard's
**Authentication → Emails** page shows the current limit). Confirmation emails will be slow or capped until
custom SMTP is configured, which is not done yet. This does not block launch; it limits sign-ups.

---

## 2. `.env.deploy` and preflight (5 min)

Generate the agent token once and store it in your password manager:

```bash
openssl rand -base64 32 | tr '+/' '-_' | tr -d '='
```

Create `.env.deploy` at the repository root. Put every value in **single quotes** so the shell and the
scripts read it the same way:

```
SUPABASE_URL='https://<ref>.supabase.co'
SUPABASE_SERVICE_ROLE_KEY='<service_role key>'
NEXT_PUBLIC_SUPABASE_URL='https://<ref>.supabase.co'
NEXT_PUBLIC_SUPABASE_ANON_KEY='<anon key>'
NEXT_PUBLIC_APP_URL='https://1stseen.win'
FIRSTSEEN_ENV='production'
AGENT_API_BEARER_TOKEN='<token you just generated>'
FIRSTSEEN_AGENT_API_URL='https://placeholder.invalid'
SUPABASE_DB_URL='<session pooler URI: project page > Connect > Session pooler>'
SUPABASE_DB_CA_CERT='/Users/<you>/.config/firstseen/supabase-prod-ca-2021.crt'
WEB_DOMAIN='1stseen.win'
PROJECT_ID='<gcp project id>'
```

`FIRSTSEEN_AGENT_API_URL` gets its real value in step 3. Do not add `FIRSTSEEN_DEMO_MODE` at all.

Also add `FIRSTSEEN_CONTACT_EMAIL='hello@1stseen.win'` (Cloudflare Email Routing, confirmed to receive mail): it is the
one address the terms, privacy, data-source, and contact pages give, including for takedown requests
(`docs/takedown.md`). Preflight treats it as required in production. And add `ROBOTS_TXT_ENFORCED='true'`: collection
checks robots.txt before each request, and `/data-sources` says so. It skips Bosch's SmartRecruiters board, which the
owner accepted.

```bash
git check-ignore -v .env.deploy
```

**Expected:** a line naming `.gitignore` and the `.env*` rule.
**If not:** stop. Do not continue until the file is ignored.

```bash
npm run preflight -- --production --env-file .env.deploy
```

**Expected:** `READY` on the last line. Google Calendar, Gmail, and Reddit report `off`; that is correct for
launch.
**If not:** the table names each problem next to its variable (`missing` or `malformed`, with the reason).
Fix the value and run it again. Preflight never prints values, so its output is safe to share.

Check the database matches the contract:

```bash
node --env-file=.env.deploy scripts/verify-supabase.mjs
```

**Expected:** every row `PASS`, and the target it prints is the session pooler (`aws-0-<region>.pooler.supabase.com`), not
`127.0.0.1`. The pooler, not `db.<ref>.supabase.co`: that direct host is IPv6-only, and neither this machine nor GitHub's
runners have an IPv6 route.
**If not:** a `FAIL` names the table, grant, or migration. A missing migration means step 1.3 did not finish.
`sql/connect` failing with "self-signed certificate in certificate chain" means `SUPABASE_DB_CA_CERT` is unset or names
the wrong file: Supabase's Postgres certificate chains to Supabase's own root CA, which no system trust store holds.
Download it from **Project Settings > Database > SSL Configuration > Download certificate** (`prod-ca-2021.crt`) and save
it outside the repository, at the path above. `rest/reachable` failing with HTTP 403 and `grants/api-roles` failing mean
migration 202608140044 has not been pushed: it grants the API roles what a new hosted project's default
privileges leave out.

Every later command that needs these values runs in a subshell, so nothing stays exported in your terminal:

```bash
( set -a; . ./.env.deploy; set +a; <command> )
```

---

## 3. Agent API on Cloud Run (15 min)

```bash
( set -a; . ./.env.deploy; set +a; bash scripts/deploy-agent.sh )
```

The first run asks for two secrets, one at a time, with input hidden: paste the `service_role` key and
press Enter, then paste the agent token and press Enter. It refuses an empty or malformed value and stores
nothing in that case; just run it again.

**Expected:** it ends with `service URL: https://firstseen-agent-….run.app`.

```bash
curl -s https://<service URL>/health
```

**Expected:** a small JSON body with `"status":"ok"`.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<service URL>/v1/forecast-replay
```

**Expected:** `401`. Anything else means the service is not enforcing its token: stop and do not continue.

Put the service URL into `.env.deploy` as `FIRSTSEEN_AGENT_API_URL` (no trailing slash), then run preflight
from step 2 again. **Expected:** `READY`.

---

## 4. Web app on Cloudflare Workers (10 min)

```bash
( set -a; . ./.env.deploy; set +a; npm run deploy:web )
```

The script validates inputs, builds, inspects the build for leaked secrets and fixture data, deploys, and
checks the live site.

**Expected on the very first run:** everything passes until **Worker secrets**, which lists both secrets as
`MISSING` and exits 1. That is normal: a Worker must exist before it can hold secrets. Set them (each
prompts for the value):

```bash
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY --name firstseen-web
```

```bash
npx wrangler secret put AGENT_API_BEARER_TOKEN --name firstseen-web
```

Use the same token as step 3. Then deploy again:

```bash
( set -a; . ./.env.deploy; set +a; npm run deploy:web )
```

**Expected:** both secrets `present`, `PASS  CSP header present`, `PASS  HSTS header present`,
`PASS  no fixture markers in the dashboard HTML`, and no `WARN … Not configured`.

**The guest agent limits are a Durable Object** (`GUEST_QUESTION_LIMITER`, migration `v1-guest-question-limiter`),
created by the first deploy; nothing needs reserving in the account first.

**Verify the guest edge cache and the guest agent limits on the real edge**: local workerd (`npm run measure:workerd`
and `npm run measure:guest-limits`) simulates the Cache API. Neither is done until:
- a repeated signed-out request to `/` returns `x-firstseen-cache: hit`, a signed-in request carries no
  `x-firstseen-cache` header, and the first signed-out request after a corpus write returns `miss`;
- a sixth guest agent question from one address within a minute gets HTTP 429 with `Retry-After`, and a signed-in
  question does not count against it.
**If not:**
- `HTTP 000` right after the first deploy: the custom domain's certificate takes a few minutes. Wait five,
  then run the deploy again.
- `WARN … Not configured`: the Worker's `SUPABASE_SERVICE_ROLE_KEY` is wrong. Put it again.
- `FAIL` in **Inspect the build output**: nothing was deployed. Read the line; it names the file.
- `--domain` fails: the zone must be in the same Cloudflare account and have no existing record for
  `firstseen`.

---

## 5. First look (5 min)

Open <https://1stseen.win>.

**Expected:** the dashboard renders with a real, empty workspace (no roles yet). It must not say "Live data
is not configured" and must not show any company on an `.example` domain.
**If you see fixture companies:** stop and take the site down (`docs/deployment.md` §7 Rollback). That is a
P0 bug.

---

## 6. Seed the corpus (about 5 min of your time; collection runs longer)

Discovery and the first collection run from this machine. Follow `docs/hosted-supabase-setup.md` §7, each
command wrapped in the subshell so it targets the hosted project:

```bash
( set -a; . ./.env.deploy; set +a; scripts/bootstrap-companies.sh )
```

**Expected:** a per-company table ending `discovered N, skipped 0, failed 0`, then the Greenhouse boards
section with every board `registered`. A company that fails is reported; re-running the script picks it
up.

Then, in order:

```bash
( set -a; . ./.env.deploy; set +a; .venv/bin/firstseen ingest --all --collection current )
```

```bash
( set -a; . ./.env.deploy; set +a; .venv/bin/firstseen ingest --all --collection historical )
```

```bash
( set -a; . ./.env.deploy; set +a; .venv/bin/firstseen enrich --all )
```

Enrichment also classifies every role into product scope (`docs/role-scope.md`). A corpus enriched before
migration 0026 needs one explicit pass, and `npm run verify:supabase` fails until it has run:

```bash
( set -a; . ./.env.deploy; set +a; .venv/bin/firstseen classify-roles --all )
```

```bash
( set -a; . ./.env.deploy; set +a; .venv/bin/firstseen regenerate-forecasts )
```

Model classification uses Ollama if it is running on this machine and records a failure per call if it is
not; deterministic extraction stands either way. With Ollama running, current ingestion is much slower
(each escalated page is a 13–30 s local model call).

```bash
( set -a; . ./.env.deploy; set +a; npm run metrics:corpus )
```

**Expected:** non-zero companies, sources, observations, roles, and events; `bounded` events may be 0, which
is correct. Keep the table: it is the baseline later collection is compared against.

```bash
node --env-file=.env.deploy scripts/verify-supabase.mjs
```

**Expected:** still all `PASS`, including the `.example` row scan, which only means something now that real
rows exist.

---

## 7. Scheduled collection on GitHub Actions (10 min)

Schedules run only from the default branch. This is the step where the local branches get merged to `main`
and pushed; nothing in this checklist does that for you.

Repository secrets (each prompts for the value):

```bash
gh secret set SUPABASE_URL
```

```bash
gh secret set SUPABASE_SERVICE_ROLE_KEY
```

Repository variables are all optional; the workflows fall back to `MAX_SOURCE_BYTES=10000000` and the
pacing in `docs/github-actions-collection.md`.

Run one collection by hand before trusting the schedule:

```bash
gh workflow run current-jobs.yml
```

```bash
gh run watch
```

**Expected:** the run succeeds. Then:

```bash
( set -a; . ./.env.deploy; set +a; npm run health:collection )
```

**Expected:** rows added in the last 24 hours, the current-jobs run listed as the last success, and no
failure streaks.
**If not:** a streak names the source. One failing source is not a launch blocker; a failing workflow is.

---

## 8. Smoke test (15 min)

As a brand-new user, on the live site:

| Step | Expected |
|---|---|
| Sign up with a real address | "Check your email" state; the confirmation arrives (slowly, see step 1) |
| Click the confirmation link | Lands on `https://1stseen.win`, signed in |
| Sign out, then **Forgot your password?** | "Check your email"; the reset link opens "Choose a new password" |
| Save a new password | Lands on the dashboard signed in; the old password no longer works |
| Dashboard | Real companies, filters and pages change the URL |
| Open a role with a forecast | Window, interval, and confidence, with evidence classes visibly distinct |
| Open a role without enough cycles | States the gap; no window, no date |
| Follow the role, Generate preparation plan | Milestones appear; `/calendar` lists them |
| Ask the agent a question | Tool activity streams, then an answer citing evidence |
| `/replay` | Candidates list, or an honest empty state |
| `/digests` | Preview renders; Gmail panel says it is not configured |
| `/calendar` sync panel | Says Google Calendar is not configured |

```bash
curl -sI https://1stseen.win | grep -iE 'content-security|strict-transport|x-frame'
```

**Expected:** all three headers.

Record the date and result of each row in `docs/production-smoke-test.md`.

---

## What says "not configured" at launch, and what proves it

Every credential-dependent feature degrades to a truthful state. This is the full list.

| Missing | What a visitor sees | Proven by |
|---|---|---|
| `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` on the Worker | Dashboard, `/calendar`, `/digests`, and `/replay` say "Live data is not configured"; role pages 404; never fixtures | `apps/web/tests/rendered-html.test.mjs` (unconfigured dashboard, calendar, digest, replay, and fixture role pages unreachable); deploy-web live check warns |
| `NEXT_PUBLIC_SUPABASE_URL` or `NEXT_PUBLIC_SUPABASE_ANON_KEY` at build time | `/signin` says "Supabase authentication is not configured" | Cannot be rendered in tests (the values are inlined at build); `deploy-web.sh` refuses to build without them and preflight fails |
| `FIRSTSEEN_AGENT_API_URL` or `AGENT_API_BEARER_TOKEN` on the Worker | Signed in: agent, replay, and preparation-plan actions say their service is not configured (HTTP 503). Signed out: 401 before any upstream call | Signed-out and forged-identity paths: `apps/web/tests/agent-caller.test.mjs`. The signed-in 503 path is exercised with a real session when the authentication flows were built |
| All four `GOOGLE_CALENDAR_*` | `/calendar` sync panel: not configured; connect and sync never redirect to Google | `apps/web/tests/integrations-not-configured.test.mjs` |
| All four Gmail variables | `/digests` preview works; Gmail panel: not configured; send refuses | `apps/web/tests/integrations-not-configured.test.mjs` |
| `EMAIL_DIGEST_SEND_ENABLED` not `true` | "Preview-only mode. Actual sends are disabled by server configuration." | `apps/web/tests/rendered-html.test.mjs` (preview-only digest) |
| `FIRSTSEEN_CONTACT_EMAIL` on the Worker | `/contact` says "No contact address is configured on this deployment."; the terms, privacy, Google, and data-source pages point to the contact page instead of giving an address | `apps/web/tests/legal-pages.test.mjs` |
| `ROBOTS_TXT_ENFORCED` not `true` | `/data-sources` says collection does not yet check robots.txt before each request; collection reads no robots.txt | `apps/web/tests/legal-pages.test.mjs`, `worker/tests/test_robots.py` |
| Model provider keys or a model server | Deterministic extraction and keyword agent intents only; each failed model call is recorded, never retried | `worker/tests/test_model_router.py` |
| Reddit credentials | Reddit signals not collected; enabling without credentials stops the worker at startup rather than collecting half-configured | `worker/tests/test_reddit.py`, `apps/web/tests/preflight.test.mjs` |
| `SUPABASE_DB_URL` | `verify:supabase`, `metrics:corpus`, and `test:integration` exit with "SUPABASE_DB_URL is not set" | `scripts/lib/db.mjs` `requireEnv` |

Google Calendar and Gmail are complete in code and proven only with synthetic tokens
(`apps/web/tests/oauth-integrations.test.mjs`). They have never run against Google. When the OAuth client
exists, `docs/oauth-manual-test-plan.md` is the 15-minute first real test.

---

## Where each value lives

| Variable | Worker | Cloud Run | Actions | Build |
|---|---|---|---|---|
| `SUPABASE_URL` | var (deploy script) | env var (deploy script) | secret | |
| `SUPABASE_SERVICE_ROLE_KEY` | secret | Secret Manager | secret | removed from build env |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | | | | inlined by deploy script |
| `NEXT_PUBLIC_APP_URL` | var | | | inlined |
| `FIRSTSEEN_ENV=production` | var | env var | unset on purpose | |
| `FIRSTSEEN_AGENT_API_URL` | var | | | |
| `AGENT_API_BEARER_TOKEN` | secret | Secret Manager (same value) | | removed from build env |
| `FIRSTSEEN_CONTACT_EMAIL` | var (deploy script, when set) | | | |
| `ROBOTS_TXT_ENFORCED` | var (deploy script, when set) | | variable (collection workflows) | |
| `FIRSTSEEN_DEMO_MODE` | never | never | never | never |

Every variable, with what breaks without it: `npm run preflight`. Full inventory: `docs/deployment.md` §8.

## Operations (docs/operations.md)

- Failures reach the owner as `ops-alert` issues assigned to the repository owner: keep GitHub email notifications for
  participating on, and install GitHub Mobile for pushes.
- Add the GitHub Actions secrets `SUPABASE_DB_URL` (the session pooler URL) and `BACKUP_ENCRYPTION_PASSPHRASE` (generate
  it with `openssl rand -base64 32`, keep it in your password manager) and the variable `SUPABASE_DB_CA_CERT_PEM` (the
  contents of `prod-ca-2021.crt`) for the weekly corpus backup, and run
  `backup-corpus.yml` once by hand: it must end with "all 20 tables … match".
- Add the repository variables `FIRSTSEEN_WEB_URL` and `FIRSTSEEN_AGENT_API_URL`, and for Worker errors and CPU the
  variable `CLOUDFLARE_ACCOUNT_ID` and secret `CLOUDFLARE_ANALYTICS_TOKEN` (Account Analytics: Read). Run
  `ops-health.yml` once by hand: every check should be ok or say why it is not configured.
- In Google Cloud Monitoring, add uptime checks on the web `/api/health` and the agent `/health`, with an email alert:
  the only check that does not depend on GitHub's scheduler.
- Watch the database size: the rebuilt rig is 243 MB of Supabase Free's 500 MB, and the growth rate is not yet measured
  (docs/operations.md, "When the database fills").
- Deploy the Worker on Workers Paid: a guest page with no database call already measures 6.6 to 7.5 ms of the Free
  plan's 10 ms.

## When something goes wrong later

- Roll back the web app: `docs/deployment.md` §7 Rollback. The agent API: §5.
- Rotate a secret: `docs/deployment.md` §4. The agent token must change in Secret Manager and the Worker
  together.
- Collection stopped: `npm run health:collection`; GitHub disables schedules after 60 days without repository
  activity, and Supabase Free pauses a week after that.

## Known limits at launch (not bugs)

- Forecast accuracy is not yet validated: the backtest has 0 evaluable cases until collection accumulates
  across real cycles. Skip reasons are honest output.
- `bounded` events can be 0 on real data.
- Google OAuth apps stay in Testing (listed test users only, 7-day refresh tokens) until sensitive-scope
  verification; see `docs/oauth-manual-test-plan.md`.
