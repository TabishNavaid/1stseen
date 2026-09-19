# Takedown: stopping collection, and removing a company

What happens when a company asks 1stSeen to stop reading its sites, to leave the product, or to erase what was
collected, from the email arriving to the confirmation going back. `/data-sources` is the public promise; this is
how it is kept. Everything here is a draft for the owner's review, like the policy pages.

## Before this procedure can run

- **The contact address.** Requests arrive at `FIRSTSEEN_CONTACT_EMAIL`, which every policy page reads: in production
  `hello@1stseen.win`, routed by Cloudflare Email Routing and confirmed to receive mail. On a deployment without the
  variable, `/contact` says no address is configured and `/data-sources` (the public side of this procedure) is not
  published: it answers 404 and no page links to it (`publishedSitePages`, `apps/web/lib/site-links.ts`). Setting the
  variable publishes it; no rebuild is needed.
- **Migration 202608140039** (`collection_takedowns` and `apply_collection_takedown`) must be applied. Every command
  below reads or writes that table, and discovery refuses to run without it.
- **Migration 202608140036** makes every product read path skip a role with `active = false`. A withdrawal relies on it.

## The three things a request can ask for

| Request | Command | What changes | What is kept |
| --- | --- | --- | --- |
| Stop reading one site or feed | `sources disable --source <id>` | That source is never fetched again. | Everything collected, still in the product. |
| Stop reading the company | `sources disable --company <domain>` | None of its sources is fetched, and discovery cannot add or re-enable one. | Everything collected, still in the product. |
| Remove the company from 1stSeen | `withdraw-company <domain> --apply` | The above, and every role of the company leaves the product (below). | Everything collected, unreachable from the product. |
| Erase what was collected | The manual step under **Erasure** | The company's observations and everything derived from them are deleted. | The company's name and domain, its source addresses, and the record of the request. |

A request to be removed is a withdrawal. Erasure happens only when it is asked for, after a withdrawal.

## Timelines

These are the ones `/data-sources` states. They are proposals for the owner to confirm.

- **Acknowledge** within two business days of the email arriving.
- **Act** within five business days of verifying the requester. Collection stops before the next scheduled run; the
  product changes within seconds of the command.
- **Erase**, when asked, within 30 days of verifying the request.
- **Confirm back** the same day the work is done.

## 1. Verify the requester

- The request must name the company and its website. Find it: `firstseen sources show --company <domain>` prints its
  sources, whether collection is already held, and every earlier takedown action.
- Reply to confirm, and ask the requester to answer **from an address at the company's own domain** (the `domain` the
  command printed, or a subdomain of it). A request already sent from that domain is verified by the reply.
- A request from a law firm or agency acting for the company: ask for the same confirmation from the company's domain,
  or for evidence of authority the owner accepts.
- Record how it was verified in the `--reason` you give every command below, with the request date, for example
  `"Takedown request from careers@example.com, 2026-09-17; verified by reply from the same domain"`.

A request that cannot be verified gets a reply saying so, and nothing is changed.

## 2. Run the commands

Every command takes `--reason` and `--by` (or `FIRSTSEEN_REVIEWER`). Each change is one transaction that also writes a
`collection_takedowns` row: who, when, why, and exactly which sources and roles it changed.

```bash
# See the company, its sources, and its takedown history.
.venv/bin/firstseen sources show --company example.com

# Stop one source (the id is in `sources show`), or every source of the company.
.venv/bin/firstseen sources disable --source <source id> --reason "<why, request date, verification>" --by "<you>"
.venv/bin/firstseen sources disable --company example.com --reason "<why, request date, verification>" --by "<you>"

# Remove the company. Without --apply this is a dry run that writes nothing and prints what would change.
.venv/bin/firstseen withdraw-company example.com --reason "<why, request date, verification>"
.venv/bin/firstseen withdraw-company example.com --reason "<why, request date, verification>" --by "<you>" --apply
```

The dry run prints the sources it would stop (by adapter), the roles it would take off the product and how many are in
scope, how many people follow them, how many observations stay stored, and how many other programs' forecasts cite the
company and will be recomputed.

### What `withdraw-company --apply` does

1. In one transaction: every source of the company is disabled, every one of its canonical roles is set
   `active = false`, and the audit row lists both.
2. It then re-forecasts every other in-scope role whose **latest** forecast cites the company's evidence (a company or
   role-family prior). Each gets a new forecast version, `recomputation_reason = 'company_withdrawn'`, computed without
   the company, because `load_backtest_dataset` reads only active roles and their openings and signals. Older versions
   stay, as every forecast version does, but only a role's current version is shown with its evidence. A role the model
   can no longer forecast without the company is recorded as declined (migration 202608140043): its stored versions,
   which cite the company, are history and no longer shown anywhere, and it is listed under
   `still_citing_withdrawn_company` so the owner can see which roles lost their forecast. Measured on the rig for the five most-cited companies (Waymo, Lyft, Five Rings, Hudson
   River Trading, Tanium; about 90 citing roles each), none became unforecastable.

After it:

- The company's roles are on no product read path: the dashboard, filters, role pages (404), Replay candidates, recent
  openings and changes, onboarding suggestions, and the agent's portfolio answers (migration 202608140036).
- The agent cannot resolve the company at all, so it never reads back its stored postings, pages, or archives.
- Follows of its roles cover nothing, and no preparation plan is written for them (`watchers_by_role` skips inactive
  roles, as `followed_role_ids` does). A company follow stays on the person's list and covers no role.
- Guest pages refresh within about ten seconds: the role and source updates advance the public data version.
- No collector fetches its sources: current, historical, signal, and enrichment runs start from enabled sources only.
  A run already in progress finishes with the source list it loaded when it started, so check the Actions tab and
  confirm back after it ends.
- Discovery (`firstseen discover`) refuses the company before making any request, and board registration refuses it;
  saving sources for a held company raises `CollectionHeldError`.

### Resuming

`firstseen sources enable --source <id>` turns one source back on; it is refused while the whole company is held.
`firstseen sources enable --company <domain>` lifts a company-wide stop or withdrawal: exactly the sources those holds
turned off come back, except one disabled on its own since, and a withdrawal's roles are listed again, except one a
re-resolution superseded in the meantime. Other programs' forecasts pick the company's evidence up again the next time
they are recomputed. Rediscovery never turns a disabled source back on by itself.

## 3. Confirm back

Reply with what was done and when, for example:

> We have stopped collecting from example.com (4 sources) and removed Example from 1stSeen as of 17 September 2026,
> 14:05 UTC. Its programs no longer appear on any page, in any watchlist, or in the agent's answers, and other
> programs' forecasts have been recomputed without its postings. What we had already collected is kept out of sight;
> if you would like it erased, reply and we will do so within 30 days.

## What is retained, and what "unreachable" means

A withdrawal deletes nothing. Kept: the raw observations and archive captures, opening events, role aliases, signals,
the company's own forecasts and their evidence, earlier forecast versions of other roles that cited it, backtest cases,
people's follows and plans that referenced its roles, and agent run records. None of it is read by a product surface:
roles are filtered on `active`, the agent will not resolve the company, and the only forecast whose evidence is shown for
any role is its latest, which the withdrawal recomputed. They remain for audit, and so that a mistaken withdrawal can be
lifted without loss.

## Erasure

Only on a verified request to erase, and only after `withdraw-company --apply`. It is a manual step, run by the owner
against the database with `psql` (or pasted into the Supabase SQL editor with the variables filled in). There is no
command for it, on purpose.

It deletes, in one transaction: the company's observations; the opening events, signals, archive captures, role
aliases, and role matches built from them; its canonical roles with their forecasts, preparation milestones, follows of
those roles, and scope reviews; the fetch records, inference decisions, change-detection state, and discovery quotes
about its sources; and the identity evidence in the company row. It keeps the company's name and domain, its source
addresses (disabled), and every `collection_takedowns` row, and adds an `erase` row, so the company stays held and is
never collected again.

What it costs, and why it is the one exception to the provenance rules:

- **Other programs' earlier forecast versions lose the evidence rows that cited the company.** Their latest versions no
  longer cite it (the withdrawal recomputed them), but an older version's provenance becomes incomplete. Every
  forecast must expose every contributing observation; a verified erasure request is the only thing that
  overrides it.
- `forecast_changes` between the company's own forecast versions, backtest cases that targeted or used its roles, and
  digest items that listed them are deleted. The stored backtest run's aggregate metrics are not recomputed; the next
  backtest run is.
- A digest already sent is in the recipient's mailbox, and a date added to someone's Google Calendar is in their
  calendar; neither is 1stSeen's to erase.
- **Agent run records** can quote evidence the agent read. Find the runs that mention the company and delete them too
  (their tool calls and model usage go with them):

  ```sql
  select id, started_at, initiated_by is not null as signed_in
  from public.agent_runs
  where metadata::text ilike '%' || :'domain' || '%' or metadata::text ilike '%' || :'company_name' || '%';
  ```

Save the script, then run it with the company's id (from `sources show`):

```bash
psql "$SUPABASE_DB_URL" -v company_id=<company uuid> \
  -v reason='Erasure requested by <address> on <date>; verified <how>' -v requested_by='<you>' -f erase_company.sql
```

It prints what it is about to erase, refuses to run unless the company's latest company-wide takedown is a withdrawal,
and commits only if every statement succeeds. It was checked on synthetic rows inside a rolled-back transaction: the
company's evidence, roles, and derived records are gone, another company's forecast keeps its own evidence and loses
only the rows citing the erased company, and the company stays held.

```sql
-- Erase what 1stSeen collected from one withdrawn company (docs/takedown.md, "Erasure").
--
-- psql -v company_id=<uuid> -v reason='<why, with the request date>' -v requested_by='<you>' -f erase_company.sql
--
-- It refuses to run unless the company's latest company-wide takedown is a withdrawal, and runs as one transaction.
\set ON_ERROR_STOP on
begin;

select coalesce((
  select t.action = 'withdraw'
  from public.collection_takedowns t
  where t.company_id = :'company_id' and t.source_id is null
  order by t.recorded_at desc, t.id desc
  limit 1
), false) as withdrawn \gset
\if :withdrawn
\else
  \echo 'Refused: run firstseen withdraw-company <domain> --apply first. Nothing was changed.'
  rollback;
  \quit
\endif

-- What will be erased: everything collected from the company's sources, and everything derived from it.
create temporary table erase_sources on commit drop as
  select id from public.sources where company_id = :'company_id';
create temporary table erase_observations on commit drop as
  select id from public.raw_job_observations where source_id in (select id from erase_sources);
create temporary table erase_roles on commit drop as
  select id from public.canonical_roles where company_id = :'company_id';
create temporary table erase_events on commit drop as
  select id from public.historical_opening_events
  where observation_id in (select id from erase_observations) or canonical_role_id in (select id from erase_roles);
create temporary table erase_signals on commit drop as
  select id from public.signals
  where company_id = :'company_id' or source_id in (select id from erase_sources)
     or observation_id in (select id from erase_observations) or canonical_role_id in (select id from erase_roles);
create temporary table erase_forecasts on commit drop as
  select id from public.forecasts where canonical_role_id in (select id from erase_roles);

select
  (select count(*) from erase_sources) as sources_kept_as_addresses,
  (select count(*) from erase_observations) as observations,
  (select count(*) from erase_roles) as roles,
  (select count(*) from erase_events) as opening_events,
  (select count(*) from erase_signals) as signals,
  (select count(*) from erase_forecasts) as forecasts;

-- 1. Provenance rows that cite the company's evidence, including rows in other companies' forecast versions.
delete from public.forecast_evidence
where forecast_id in (select id from erase_forecasts)
   or observation_id in (select id from erase_observations)
   or historical_opening_event_id in (select id from erase_events)
   or signal_id in (select id from erase_signals);

-- 2. Records elsewhere that point at the company's forecasts, openings, and roles.
delete from public.forecast_changes
where before_forecast_id in (select id from erase_forecasts) or after_forecast_id in (select id from erase_forecasts);
delete from public.backtest_cases
where canonical_role_id in (select id from erase_roles) or target_event_id in (select id from erase_events);
delete from public.email_digest_items
where canonical_role_id in (select id from erase_roles)
   or forecast_id in (select id from erase_forecasts)
   or historical_opening_event_id in (select id from erase_events);

-- 3. The evidence itself.
delete from public.signals where id in (select id from erase_signals);
delete from public.historical_opening_events where id in (select id from erase_events);
delete from public.archive_captures
where source_id in (select id from erase_sources) or observation_id in (select id from erase_observations);
delete from public.role_aliases
where canonical_role_id in (select id from erase_roles)
   or first_observation_id in (select id from erase_observations)
   or last_observation_id in (select id from erase_observations);
delete from public.observation_role_matches
where observation_id in (select id from erase_observations) or canonical_role_id in (select id from erase_roles);
delete from public.raw_job_observations where id in (select id from erase_observations);

-- 4. The company's roles. This also removes their forecasts, preparation milestones, follows of those roles, and scope
--    reviews; a calendar sync that pointed at one keeps its row with the reference cleared.
delete from public.canonical_roles where id in (select id from erase_roles);

-- 5. What collection kept about the sources. The source rows stay: their addresses are what stops re-collection.
delete from public.source_fetches where source_id in (select id from erase_sources);
delete from public.inference_decisions where source_id in (select id from erase_sources);
delete from public.signal_source_states where source_id in (select id from erase_sources);
delete from public.source_discovery_evidence where company_id = :'company_id';
update public.companies
set metadata = jsonb_build_object('erased_at', now()), careers_url = null, recruiting_url = null
where id = :'company_id';

-- 6. The record. The company stays held: discovery and board registration keep refusing it.
insert into public.collection_takedowns (company_id, action, reason, requested_by, role_ids)
select :'company_id'::uuid, 'erase', :'reason', :'requested_by', coalesce(array_agg(id order by id), '{}')
from erase_roles;

commit;
```

## robots.txt

Separate from takedown requests, collection can honour each site's robots.txt before every request
(`worker/src/firstseen/robots.py`, RFC 9309). It is **off** until the owner turns it on with `ROBOTS_TXT_ENFORCED=true`
in the GitHub Actions variables (the three collection workflows pass it) and on the Worker (so `/data-sources` says
which rule collection follows). With it off, robots.txt is never read before a request, and `/data-sources` says so.

The rule, when on:

- robots.txt is read once per origin per run, through the same public-address policy, pacing, and timeout as any
  request, and at most 512 KiB of it.
- The group naming `1stSeenEvidenceBot` applies, else the `*` groups; the longest matching Allow or Disallow wins, and a
  tie goes to Allow. `*` and a final `$` are honoured; rules match the path and query.
- A 4xx robots.txt (other than 429) means no restrictions. A 5xx, a 429, a timeout, or no answer means the whole origin
  is skipped for that run.
- The ATS API hosts (`boards-api.greenhouse.io`, `api.lever.co`, `api.ashbyhq.com`, `api.smartrecruiters.com`) and the
  Wayback Machine (`web.archive.org`) are subject to their own robots.txt the same way.
- A refused URL is never requested. It is recorded as a `robots_disallowed` (warning, with the rule) or
  `robots_unreachable` (error: the source is partial and retried next run) diagnostic. A source whose own address is
  refused is skipped like a source off a recruiting path, with its earlier observations left as they are. Crawl-delay is
  not read.

Measured on 17 September 2026 against the rig's 450 enabled sources (78 distinct robots.txt origins, one read each, no
other request), turning it on would skip 3 sources that collection reads today, and 112 others are already skipped by
the recruiting-path rule:

| Company | Skipped by robots.txt | Why | Coverage left |
| --- | --- | --- | --- |
| Bosch Global | SmartRecruiters board (its only ATS board) | `api.smartrecruiters.com` allows only LinkedInBot on `/v1/companies/`; `*` is `Disallow: /` | 7 career pages and its Wayback archive; no ATS board. 20 in-scope roles are evidenced only by that board and would stop updating. |
| Canonical | `/careers/feed` (RSS) | `canonical.com`: `Disallow: /careers/feed` | Its Greenhouse board and 14 page sources; the feed's 4 in-scope roles are all also evidenced elsewhere. |
| DV Trading | `sitemap_index.xml` | `www.dvtrading.co/robots.txt` answered HTTP 526 at measurement, so that host is skipped for the run | Its ATS board and 3 other page sources. Likely transient. |

No company loses every source, and only Bosch loses a kind of source (its ATS board). The Wayback Machine
(`web.archive.org/robots.txt` answered 404) and the Greenhouse, Lever, and Ashby APIs allow everything collection
requests. Ten hosts declare a Crawl-delay (up to 10 seconds, at Akuna, Shield AI, Tower Research, and Old Mission);
collection's per-host pacing is 0.25 s for current postings and 1.5 s for pages and the archive.
