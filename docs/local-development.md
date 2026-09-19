# Local development rig

Everything 1stSeen does, running on one machine with no hosted credentials: Postgres and auth
(local Supabase), a mail catcher for sign-up and password-reset email, a local model for the
LLM-gated paths, the Python agent API, and the web dev server. The rig runs in **real mode**:
Supabase is configured, so every surface reads collected evidence and fixtures are unreachable.

`scripts/local-rig.sh` drives it. Nothing it does prints a key.

| Component | Address | Started by |
|---|---|---|
| Supabase API (PostgREST, auth) | `http://127.0.0.1:55421` | `scripts/local-rig.sh up` |
| Postgres | `127.0.0.1:55422` (user `postgres`) | same |
| Mail catcher (Mailpit, configured as `[local_smtp]`) | `http://127.0.0.1:55424` | same |
| Ollama with `qwen2.5:7b` | `http://127.0.0.1:11434` | `ollama serve` |
| Agent API | `http://127.0.0.1:8000` | `scripts/local-rig.sh agent` |
| Web app | `http://localhost:3000` | `npm run dev` |

The Supabase ports are `5542x` rather than the CLI defaults (`5432x`), because another local
Supabase project on the same machine usually holds the defaults. Studio is off to keep the stack
small; set `[studio] enabled = true` in `supabase/config.toml` if you want a table browser.

---

## 1. Prerequisites

- Docker Desktop, running
- Node 22.13+ and Python 3.11+
- `make setup` (installs npm packages, creates `.venv`, copies `.env.example` to `.env`)
- The agent API extra: `.venv/bin/pip install -e "worker[api]"`

## 2. Supabase, migrations, and `.env`

```bash
scripts/local-rig.sh up
```

This runs `supabase start` with the pinned CLI (`supabase@2.117.0`), which applies every migration in
`supabase/migrations` to a fresh database, then writes these values into `.env` without printing
them: `SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, `FIRSTSEEN_AGENT_API_URL`, `MAX_SOURCE_BYTES`, and a
generated `AGENT_API_BEARER_TOKEN` (kept if one already exists).

**Seeding is off.** `supabase/config.toml` sets `[db.seed] enabled = false`. `seed.sql` holds reserved
`.example` fixtures, and in a real-mode rig they would render as if they were collected evidence.
Never run `supabase db reset --linked`, and never pass `--include-seed` to anything.

Check the database matches the contract:

```bash
npm run verify:supabase
```

Every row should be `PASS`, including `data/no-example-domains`.

Confirmation and password-reset emails land in the mail catcher at <http://127.0.0.1:55424>. Sign-up
requires a confirmed email, as the hosted project does.

## 3. The collected corpus

The corpus is collected live from public boards, so it needs network access but no keys. Run these
in order. Measured on 2026-09-14 for the 13 companies: discovery 96 s, current collection 16 min, the archive
pass 8.5 min at courtesy pacing, enrichment and regeneration under 2 min.

Collection escalates ambiguous role matches to the `classify` model, and most matches are ambiguous. With the
local 7B model reachable that projected to about 14 hours, so the collection commands below point the model
routes at a port that refuses connections: every escalation then records that no model route succeeded and
keeps the deterministic score, as the August corpus was built. Ollama stays running for the agent and the
intent evaluation.

```bash
scripts/bootstrap-companies.sh
```

```bash
MAX_SOURCE_BYTES=10000000 HTTP_MIN_HOST_INTERVAL_SECONDS=1.5 OLLAMA_API_BASE=http://127.0.0.1:9 LLM_API_BASE=http://127.0.0.1:9 .venv/bin/firstseen ingest --all --collection current
```

```bash
MAX_SOURCE_BYTES=10000000 HTTP_MIN_HOST_INTERVAL_SECONDS=1.5 OLLAMA_API_BASE=http://127.0.0.1:9 LLM_API_BASE=http://127.0.0.1:9 .venv/bin/firstseen ingest --all --collection historical
```

```bash
OLLAMA_API_BASE=http://127.0.0.1:9 LLM_API_BASE=http://127.0.0.1:9 .venv/bin/firstseen enrich --all
```

```bash
.venv/bin/firstseen regenerate-forecasts
```

Then record it:

```bash
npm run metrics:corpus
```

## 4. Local model

The LLM-gated paths (ambiguous role classification, generic page extraction after deterministic
parsing is inconclusive, and the opt-in agent intent widening) use the route in `.env`,
`LLM_MODEL=ollama/qwen2.5:7b` at `http://localhost:11434`. No provider key is involved.

Install Ollama from <https://ollama.com/download>, or, where Homebrew cannot install it, unpack the
official release binary from <https://github.com/ollama/ollama/releases> into a user directory. Then:

```bash
ollama serve
```

```bash
ollama pull qwen2.5:7b
```

The model needs about 5 GB of memory while loaded. With Ollama stopped, every model route fails fast
and the pipeline stays fully deterministic, which is also a supported configuration.

## 5. Agent API

In its own terminal:

```bash
scripts/local-rig.sh agent
```

It reads `.env`, so it uses the same bearer token as the web app. Forecast Replay, agent
investigation, and readiness-plan generation all call it.

## 6. Web app

```bash
npm run dev
```

Open <http://localhost:3000>. A first visit shows the landing page; <http://localhost:3000/roles> lists every in-scope
role from the rig's data.

## 7. Check the whole rig

```bash
scripts/local-rig.sh doctor
```

It reports each component as `up` or `DOWN` with the command that starts it.

`npm run preflight` checks `.env` itself: every variable, whether it is set, and what breaks without
it. Against the rig it should end `READY`, with Google Calendar, Gmail, and Reddit `off`.

## 8. Tests that need the rig

`npm run check` needs no database. The integration tests do:

```bash
npm run test:integration
```

They write synthetic rows inside a transaction that is always rolled back, so nothing is committed.

## Troubleshooting

- **Port already allocated.** Another Supabase project holds a port in `supabase/config.toml`. Stop that
  project or change the port here.
- **`supabase start` hangs pulling an image.** Docker Desktop routes registry traffic through its own
  proxy, which can stall. If an older build of the same Postgres major is already cached, pin it with
  the CLI's own override, then start again (`supabase/.temp` is gitignored):
  ```bash
  mkdir -p supabase/.temp && docker images --format '{{.Tag}}' public.ecr.aws/supabase/postgres | grep '^17\.' | head -1 > supabase/.temp/postgres-version
  ```
- **Stop without losing data:** `scripts/local-rig.sh down`. Data persists in Docker volumes.
