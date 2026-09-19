# Guest access

A signed-out visitor gets a real, read-only 1stSeen: the landing section, the dashboard of every in-scope role, role
pages with their evidence and provenance, Forecast Replay's candidate list, and the agent. Nothing a guest does writes
anything, and nothing user-owned is reachable. This page is the contract.

## The boundary

**Guests reach the database only through the Worker.** The browser never talks to Supabase: the page's
`connect-src` is `'self'`, and every read happens in a server render or an API route with the service role.

**Every read of non-user data goes through one allowlist.** `apps/web/lib/public-read-policy.ts` lists the relations,
columns, and functions a guest render may read, and `lib/public-read.ts` refuses anything else before a request is made:

- **Relations:** companies, canonical roles, opening events, observations (no raw text or payload), observation role
  matches, forecasts, the provenance view, forecast changes, signals, and backtest run totals.
- **Functions:** the dashboard and replay read paths, plus `public_agent_activity`. Any argument naming a user must be
  null.
- **Selects:** a select is checked column by column at every level of embedding. `*`, JSON paths, casts, spreads, and
  unlisted embedded relations are refused.

Signed-in renders use the same reader for non-user data. User-owned rows (a watchlist, milestones, preferences,
integrations) are read with the service role and an explicit user filter, and only when a session exists.

**Anon holds no privilege on anything in `public`.** RLS is unchanged:

- Migration `202608140024` revoked anon on user-owned tables.
- Migration `202608140031` revoked the default grants anon still held on the reference tables and the provenance view,
  and stops default privileges granting anon on future tables, sequences, and functions.
- `verify:supabase` checks both (`grants/anon-on-user-tables`, `grants/anon-anywhere`).

**No write path.** Following a role, generating a plan, running a replay, previewing a digest, and connecting an
integration all require a session. Each surface prompts to create an account rather than failing: the watch button,
the readiness panel, the calendar and digest pages, the replay and integration messages, and the agent's limit message.

**Agent activity shown on the dashboard is never tied to a user.** `public_agent_activity` returns only the latest
recruiting-agent run that no user started (`agent_runs.initiated_by`, now recorded at run start) and whose stored
state names no actor.

## The agent for guests

A signed-out question reaches the agent route only after the Worker entry (`apps/web/cloudflare/index.ts`) passes it
through two Workers Rate Limiting bindings:

| Binding | Key | Limit |
| --- | --- | --- |
| `GUEST_AGENT_ADDRESS_LIMIT` | the client address (`cf-connecting-ip`) | 5 questions a minute |
| `GUEST_AGENT_OVERALL_LIMIT` | every guest together | 10 questions a minute |

- **The entry vouches for a question.** It deletes any client-sent `x-firstseen-guest-agent` header and sets its own,
  so only the entry can say a question passed. A deployment without the bindings refuses guest questions (503) instead
  of running them unlimited.
- **A refusal is honest.** It is a 429 with `Retry-After: 60`, the scope that refused it, and a sentence saying so,
  which the agent panel shows with a link to create an account.
- **A guest question carries no user.** The route sends `audience: "guest"` and no `user_id`, and the agent service
  rejects a guest question that names one. Tool selection is the same deterministic selection, except that a guest
  never gets a readiness plan (the answer says a plan needs an account), and a watchlist question is refused as for any
  unscoped caller.
- **The bindings are approximate.** They count per Cloudflare location and settle eventually, so they bound cost and
  abuse, not an exact quota.
- **Deploy note:** the two `namespace_id`s (18001, 18002) are account-wide integers and must not collide with another
  Worker's.

## The edge cache

Every guest sees the same dashboard and role pages, so the Worker entry serves them from the Cloudflare Cache API
(`apps/web/cloudflare/guest-cache.ts`).

- **What is cached:** a whole-document GET with no Supabase session cookie, to `/` or `/roles/<uuid>`. A signed-in
  request, an RSC navigation, and every other method or path always render. Only a 200 HTML response without Set-Cookie
  is stored.
- **The key:** the canonical path plus the public data version. The dashboard's query is canonicalised (unknown
  parameters dropped, known ones ordered, filter values sorted and de-duplicated, the page kept), so a random query
  string cannot force a render.
- **Purge:** any statement on a table a guest page reads advances `public_data_version_seq`, so a forecast regeneration
  or a collection run moves every guest page to a new key everywhere, with no purge API call.
  - The Worker reads the version at most every 10 seconds per isolate, and a stored page lives at most 5 minutes.
  - Agent audit tables do not advance the version, so a guest cannot empty the cache by asking questions.
- **Nonces:** a rendered page carries its CSP nonce in 37 places. The stored copy records its nonce, and a hit swaps
  in the request's fresh one, so no nonce is ever shared between visitors.
- **Switch:** `FIRSTSEEN_EDGE_CACHE=off` renders every request. It is used to measure the uncached path.

## Landing

A signed-out visitor on the dashboard's default view gets a landing section above it (`components/landing-section.tsx`).
It is the first thing on `/` rather than a separate page, because the public dashboard already lives at `/` and every
filter link points there. It has four parts:

- **What 1stSeen predicts**, and the three decisions that make it evidence-first.
- **One real forecast**, chosen by a stated rule: the highest confidence score among in-scope forecasts. It is shown
  with its interval, evidence classes, and the sources its openings were seen on.
- **The accuracy position:** the one-sentence statement from the first run, plus the latest backtest's own totals.
- **Two actions:** create an account, or browse every role.

## Tests

| What | Where |
| --- | --- |
| Allowlist, cache key, nonce swap, version memo, and guest limits, without workerd | `apps/web/tests/guest-edge.test.mjs` |
| Forged identity and guest headers against the built Worker | `apps/web/tests/agent-caller.test.mjs` |
| Every guest page and every API route, with every Supabase request recorded and checked | `apps/web/tests/integration/guest-boundary.test.mjs` |
| Anon privileges in the catalog and through PostgREST | same file; fails the moment anon is granted a privilege |
| Version bumps, and user-tied runs excluded from `public_agent_activity` | same file |
| Guest agent audience, no plan, run initiator, and exact role resolution | `worker/tests/test_agent.py` |
| Cache CPU (on and off) | `npm run measure:workerd -- [--edge-cache off] <paths>` |
| Limit behaviour | `npm run measure:guest-limits` |
