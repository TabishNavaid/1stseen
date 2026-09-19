# Guest access

A signed-out visitor gets a real, read-only 1stSeen: the landing page, the roles view of every in-scope role, Just
opened, the first run and its payoff, role pages with their evidence and provenance, Forecast Replay's candidate list,
and the agent's Ask page. Nothing a guest does writes anything, and nothing user-owned is reachable. This page is the
contract.

## What a guest sees

The navigation (`lib/site-nav.ts`) shows a guest three items: **Explore** (`/roles`), **Just opened** (`/opened`), and
**Ask** (`/ask`), with Sign in and Get started beside them. Watchlist and Calendar appear only after sign-in; nothing is
shown locked. Forecast Replay is linked from `/methodology` and digests from settings; neither is in the navigation.

- **Just opened** lists every in-scope program with an exact opening date in the last 45 days, newest first, 30 to a
  page, each linking its role page and the posting. The landing page shows the newest eight as a strip, one per
  company, and the roles view's tile ("N programs opened in the last 45 days") links to it.
- **Ask** is the agent's own page: a question box, three suggested questions, and the guest limit said plainly. A role
  page asks the same agent about that program.
- The roles view never draws a tile whose number is zero (`lib/dashboard-tiles.ts`).

## The boundary

**Guests reach the database only through the Worker.** The browser never talks to Supabase: the page's
`connect-src` is `'self'`, and every read happens in a server render or an API route with the service role.

**Every read of non-user data goes through one allowlist.** `apps/web/lib/public-read-policy.ts` lists the relations,
columns, and functions a guest render may read, and `lib/public-read.ts` refuses anything else before a request is made:

- **Relations:** companies, canonical roles, role aliases (a role's recorded titles, read so a title keeps the
  company's accents and punctuation), opening events, observations (no raw text or payload), observation role matches,
  forecasts, the provenance view, forecast changes, signals, and backtest run totals.
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

**Agent activity is never tied to a user.** No page shows agent activity now; `public_agent_activity` stays in the
allowlist and returns only the latest recruiting-agent run that no user started (`agent_runs.initiated_by`, recorded at
run start) and whose stored state names no actor.

## The agent for guests

A signed-out question reaches the agent route only after the Worker entry (`apps/web/cloudflare/index.ts`) passes it
through two limits, each a sliding 60-second window counted exactly by the `GuestQuestionLimiter` Durable Object
(`apps/web/cloudflare/guest-limiter.ts`, binding `GUEST_QUESTION_LIMITER`), one object per key:

| Limit | Key | Allows |
| --- | --- | --- |
| per address | `address:<cf-connecting-ip>` | 5 questions a minute |
| overall | `all-guests` | 10 questions a minute, every guest together |

- **The entry vouches for a question.** It deletes any client-sent `x-firstseen-guest-agent` header and sets its own,
  so only the entry can say a question passed. A deployment without the limiter refuses guest questions (503) instead
  of running them unlimited.
- **A refusal is honest.** It is a 429 with `Retry-After: 60`, the scope that refused it, and a sentence saying so,
  which the agent panel shows with a link to create an account.
- **A paused agent service reads as a pause.** When the agent API does not answer or answers with an error (as when the
  Cloud Run spend cap has stopped it), the route answers 503 and the panel says "Asking questions is temporarily
  unavailable. Forecasts, role pages, and their evidence still work. Please try again later." No account is offered: one
  would not help.
- **A guest question carries no user.** The route sends `audience: "guest"` and no `user_id`, and the agent service
  rejects a guest question that names one. Tool selection is the same deterministic selection, except that a guest
  never gets a readiness plan (the answer says a plan needs an account), and a watchlist question is refused as for any
  unscoped caller.
- **The limits are exact.** Each key is one Durable Object, which handles its questions one at a time and keeps its
  count in its own storage, so the sixth question from an address in a minute is refused wherever it arrives from. Workers
  Rate Limiting bindings, used before, count per Cloudflare location and late: on the production edge, one set to 3 a
  minute allowed 13 calls from one address before its first refusal, and 22 guest questions from one address in two
  minutes were all answered. The shared `all-guests` object lives near where it was first created, so a guest far from it
  waits one extra round trip before the answer starts.

## The edge cache

Every guest sees the same landing page, roles view, Just opened, methodology, and role pages, so the Worker entry serves
them from the Cloudflare Cache API (`apps/web/cloudflare/guest-cache.ts`).

- **What is cached:** a whole-document GET with no Supabase session cookie, to `/`, `/roles`, `/opened`,
  `/methodology`, or `/roles/<uuid>`. A signed-in
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

`/` is a landing page for a first-time visitor (`components/landing/landing-page.tsx`), never the app. The roles view
lives at `/roles`, and every filter link points there; an old `/?…` dashboard link redirects to the same view at
`/roles`, and a signed-in visit to `/` goes to `/roles` from the Worker entry (`cloudflare/front-door.ts`) before
anything renders. One idea per section:

- **The promise and two actions:** "Get started" opens the first run; "Just browse" opens the roles view as a guest.
  Beside them, one real program (`lib/landing-data.ts`), chosen by a stated rule: the highest confidence score among
  current forecasts resting on two or more of its own cycles, shown with its likely date, its window, its confidence
  word, and the openings behind it with where each was seen. With no such forecast, the role with the most dated
  openings is shown as its observed history, with the plain reason it has no date.
- **Just opened:** the newest programs that opened, one per company, and a link to all of them. Hidden when none opened.
- **How it works**, in three plain steps.
- **Opening soon:** every current forecast, soonest window first, one per company, up to six; "Next to open" when the
  first window is more than 90 days away. Hidden when there is none.
- **Trust in one line:** every date links to where it was seen, and a link to the methodology page, which carries the
  evidence model's three rules and the accuracy position.

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
