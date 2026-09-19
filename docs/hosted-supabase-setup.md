# Hosted Supabase setup

Standing up the hosted project and pointing the app at it. Steps marked **[you]** need
credentials and must be run by the operator; everything else is scripted.

The single rule that governs this whole document: **`supabase/seed.sql` must never run against
the hosted project.** It inserts fixtures on reserved `.example` domains, and a reserved domain
in a production row would make fixture and real evidence indistinguishable. `npm run
verify:supabase` fails loudly if one ever appears.

---

## 1. Create the project **[you]**

1. Sign in at <https://supabase.com/dashboard>.
2. **New project** (inside an organization — create a free one first if you have none).
3. Fill in:
   - **Name** — `firstseen` (or `firstseen-prod`).
   - **Database Password** — generate a strong one and put it straight into your password
     manager. You need it in step 2 and for `SUPABASE_DB_URL`; it is shown only once.
   - **Region** — **West US (North California)** `us-west-1`. That is the closest region to
     Pacific time. West US (Oregon) `us-west-2` is an equally good second choice; pick one and
     keep every later setting consistent with it.
   - **Plan** — Free.
4. **Create new project**, then wait for provisioning to finish (a minute or two — the API
   settings page shows "setting up" until it is ready).
5. Collect four values. **Project Settings → API**:
   - Project URL → `https://<ref>.supabase.co` — this is `SUPABASE_URL` and
     `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` `public` key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` `secret` key → `SUPABASE_SERVICE_ROLE_KEY` (**server-only, never
     `NEXT_PUBLIC_*`**)

   **Project Settings → General** → Reference ID → the `<ref>` used below.

> The free tier pauses a project after a week of inactivity. The scheduled collection workflow
> keeps it warm; if you pause development, resume the project in the dashboard before running
> anything here.

---

## 2. Link the repository and apply the migrations **[you]**

From the repository root:

```bash
npx supabase login
```

```bash
npx supabase link --project-ref <ref>
```

It prompts for the database password from step 1.

Check what is pending before changing anything:

```bash
npx supabase migration list --linked
```

Every migration (`202608140001` … `202608140025`) should show as local-only. Then apply them:

```bash
npx supabase db push
```

**Do not pass `--include-seed`, and never run `npx supabase db reset --linked`.** `db push`
applies migrations only; both of those alternatives would execute `supabase/seed.sql` and put
`.example` fixture rows into the hosted database.

`supabase/config.toml` sets `[db.seed] enabled = false`, so even the local rig never loads
`supabase/seed.sql` (it runs in real mode against a collected corpus; see
`docs/local-development.md`). The protection for the hosted project is still the command you run,
plus the verification in step 5.

Confirm every migration landed:

```bash
npx supabase migration list --linked
```

---

## 3. Enable email/password auth **[you]**

**Authentication → Sign In / Providers**:

| Setting | Value |
|---|---|
| **Email** provider | Enabled |
| Confirm email | Enabled (leave on — sign-up never signs anyone in; `/auth/confirm` finishes it from the emailed link) |
| Secure email change | Enabled |
| Minimum password length | `8`, with no extra character rules — `lib/auth/policy.ts` enforces the same policy before calling Supabase |

Disable every provider you are not using. Anonymous sign-in stays **off**: every user-owned
table is `auth.uid()`-scoped, and an anonymous identity is still a real `profiles.id`.

**Authentication → Emails → Templates**: replace **Confirm signup** with
`supabase/templates/confirmation.html` and **Reset password** with `supabase/templates/recovery.html`. Their
links put the one-time token in the URL fragment, which `/auth/confirm` and `/auth/reset` read; the default
templates put it in the query string and will not work with the app. Leave **Attack Protection → CAPTCHA**
off: the sign-in routes send no CAPTCHA token.

**Authentication → URL Configuration** — this is the part that must match `NEXT_PUBLIC_APP_URL`:

| Setting | Local development | Deployed |
|---|---|---|
| **Site URL** | `http://localhost:3000` | the exact `NEXT_PUBLIC_APP_URL` origin, e.g. `https://firstseen.example-domain.com` |
| **Redirect URLs** | `http://localhost:3000/**` | `https://<your NEXT_PUBLIC_APP_URL host>/**` |

Site URL is where a confirmation link lands. It must be the same origin as
`NEXT_PUBLIC_APP_URL`, because that variable is also what the digest builder uses to construct
links — a mismatch sends a user who clicks "confirm" to a different deployment than the one
that emailed them.

Add both the local and the deployed entry to **Redirect URLs** so one project serves both. A
redirect target that is not on this list is rejected by Supabase, which is the behaviour you
want.

> `NEXT_PUBLIC_APP_URL` has no trailing slash and includes the scheme.

---

## 4. Create `.env` **[you — values only]**

`.env` already exists in the working tree, generated from `.env.example` with the hosted-safe
adjustments applied and the secret placeholders commented out. It is gitignored (`.gitignore:33` `.env*`, with `!.env.example` on line
34); confirm for yourself at any time:

```bash
git check-ignore -v .env && git ls-files --error-unmatch .env 2>/dev/null || echo "ignored and untracked"
```

Uncomment and fill in the five values marked `TODO` from step 1.

**They are commented out rather than left blank on purpose.** `config.Settings` types
`SUPABASE_URL` as `HttpUrl | None`, and pydantic rejects `""` as an invalid URL while accepting
an absent variable as `None`. A line reading `SUPABASE_URL=` with nothing after it therefore
crashes *every* worker command at import — including `firstseen dry-run` and `npm run check` —
with `Input should be a valid URL, input is empty`. Leave a value commented out until you have
it. The same applies to any `.env` you write by hand.

Two things matter when you write it:

- **`FIRSTSEEN_DEMO_MODE` stays commented out**, as it is in `.env.example`. Against a real
  database it is inert either way (`app/page.tsx` checks `hasServiceRoleConfig()` first), but
  production must not set it at all.
- **`SUPABASE_DB_URL`** is listed, commented out, in `.env.example`. The worker never uses it;
  `npm run verify:supabase` and `npm run metrics:corpus` need it because RLS state, policy
  bodies, and role grants are not reachable through PostgREST.

  Get it from the project page's **Connect → Session pooler** URI and substitute your database
  password. Use the session pooler (port 5432) rather than the transaction pooler (6543): the
  verification runs catalog queries and a multi-statement session. The direct connection
  (`db.<ref>.supabase.co`) is IPv6-only, and neither a machine without an IPv6 route nor GitHub's
  runners can reach it.
- **`SUPABASE_DB_CA_CERT`** is the path to Supabase's root certificate, which every hosted
  `SUPABASE_DB_URL` needs: the Postgres certificate chains to Supabase's own CA, which no system
  trust store holds, so without it the connection fails with "self-signed certificate in
  certificate chain" (certificate verification is never switched off). Download it from
  **Project Settings → Database → SSL Configuration → Download certificate** (`prod-ca-2021.crt`)
  and keep it outside the repository, for example `~/.config/firstseen/supabase-prod-ca-2021.crt`.

`npm run preflight` checks the finished file and names anything missing or malformed.

Never commit `.env`, and never move a `service_role` key or `SUPABASE_DB_URL` into a
`NEXT_PUBLIC_*` name.

### Known trap: `.env` breaks `npm run check`

`config.Settings` reads `.env` even under test, so values in it leak into tests that construct
`Settings(...)` directly. With `REDDIT_COMMUNITIES` set — which `.env.example` does set, and
which `make setup` therefore copies into `.env` —
`worker/tests/test_reddit.py::test_live_collection_requires_credentials_and_descriptive_user_agent`
fails, because the allowlist it expects to be missing is supplied by the file:

```
AssertionError: ValueError not raised
```

This is pre-existing and reproduces with a verbatim `cp .env.example .env`; it is not caused by
anything in this setup. The generated `.env` therefore keeps `REDDIT_COMMUNITIES` commented out,
which is also correct on its own terms — Reddit collection is off for this project.

The real fix is to make the assertions hermetic so a developer's local `.env` cannot change what
the test means, by pinning the env file off in that test:

```python
Settings(_env_file=None, REDDIT_API_ENABLED=True, ...)
```

Left alone here because it is a worker-test change unrelated to provisioning. Until it is made,
`make setup` followed by `npm run check` fails on a clean clone.

---

## 5. Verify the project matches the contract

```bash
npm run verify:supabase
```

Asserts, and prints a pass/fail table for:

- all 33 tables and both views (`forecast_provenance`, `inference_run_metrics`) exist, and both
  views run `security_invoker` so they cannot bypass a caller's RLS
- `observation_role_matches` has primary key `(observation_id, canonical_role_id)` — the
  migration-0022 evidence model
- every migration in `supabase/migrations` is recorded in `supabase_migrations.schema_migrations`
- the eight bounded read-path functions exist and neither `anon` nor `authenticated` can execute them
- RLS is enabled on all 33 tables
- all 9 user-owned tables carry an `auth.uid()` policy
- the 11 automation tables and `inference_run_metrics` expose no privilege to `anon` or
  `authenticated`, and `anon` holds nothing on any user-owned table
- **no row in any table contains `.example`** — the whole row is cast to text, so a fixture
  domain nested in `jsonb` or inside a `text[]` is caught too

A check that could not run reports `SKIP` and the command still exits non-zero. A skipped check
is never counted as a pass.

> **Why `gmail_connections` and `google_calendar_connections` are not in the user-owned set.**
> They are integration tables, but they hold encrypted OAuth refresh tokens, so they stay
> service-write-only with no policy at all. Asserting an `auth.uid()` policy on them would
> fail against a correctly migrated database. The user-readable presentations —
> `calendar_event_syncs`, `email_digest_deliveries`, `email_digest_items` — are the ones that
> carry `auth.uid()` policies, and they are checked.

---

## 6. Run the app against hosted Supabase

```bash
npm run dev
```

Open <http://localhost:3000>. What you should see, and what each state means:

| Dashboard state | Meaning |
|---|---|
| "Not configured" / "Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`" | `.env` is not being read, or those two values are blank |
| Real workspace, zero roles | Connected. The schema is live but the corpus is empty — continue to step 7 |
| Fixture forecasts on `.example` domains | Should be impossible. Stop: it means `.env` lacks service-role credentials **and** demo mode is on |

Confirm demo mode really is unset:

```bash
grep -n 'FIRSTSEEN_DEMO_MODE' .env
```

The only match should be the commented-out line. Sign-in lives at `/signin`; create an account
with the email/password provider enabled in step 3.

---

## 7. Seed the corpus **[you]**

Discovery makes live HTTP requests to 13 real companies, so it runs from your machine, not CI.

```bash
scripts/bootstrap-companies.sh
```

It sets `MAX_SOURCE_BYTES=10000000` and `HTTP_MIN_HOST_INTERVAL_SECONDS=1.5` itself (override by
exporting them first), runs `firstseen discover --company <domain>` for each company, skips
companies that already have sources, and prints a per-company summary. It is safe to re-run: the
repository upserts companies on `domain` and sources on `(company_id, url)`, so IDs stay stable.
Preview without touching the network:

```bash
scripts/bootstrap-companies.sh --dry-run
```

There are no retries, by design: a collector never retries automatically. A company
that fails is reported and picked up by the next run.

Then, in order:

```bash
.venv/bin/firstseen ingest --all --collection current
```

```bash
.venv/bin/firstseen enrich --all
```

```bash
.venv/bin/firstseen regenerate-forecasts
```

Re-run the verification once the corpus exists — the `.example` scan is only meaningful against
real rows:

```bash
npm run verify:supabase
```

---

## 8. Record the corpus

```bash
npm run metrics:corpus
```

Prints the corpus table as markdown, straight from the system of record. Keep it: it is the
baseline later collection is compared against.

Three rows come out as `pending`: model-ready cycles and the two "roles by cycle count" rows.
Cohort collapse and repost exclusion live in `cycles.py`, and recomputing them in SQL would
create a second definition that could silently drift. The target count comes from:

```bash
.venv/bin/firstseen backtest --cutoff-days 60
```

Expect zero evaluable cases on a freshly collected corpus. That is correct, not a failure: every
fact's `effective_available_at` is its collection date, so no cutoff admits prior evidence.
Only accumulated collection across real cycles changes it.
