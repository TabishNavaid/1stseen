# Watchlists and recruiting preferences

1stSeen personalization starts from explicit follows. A user can follow a company, canonical recurring
role, normalized role family, internship track, or new-grad track. Preferences rank only opportunities
already admitted by one of those follows; they never expand the candidate set into generic recommendations.

## Stored user data

`watchlist_items` stores one typed target per row. Database constraints reject mixed targets, invalid role
families, and unsupported broad tracks. Partial unique indexes make repeated follows idempotent at each
scope. The earlier role-only `watchlists` rows are migrated into this table and retained read-only for
audit compatibility.

`recruiting_preferences` stores target role families, graduation year, target recruiting season, preferred
locations, and company-size preferences. `priority_companies` stores a relational company reference and a
user-selected priority from 1–5. None of these fields is inferred from browsing behavior.

All three tables enable row-level security. Authenticated users receive owner-only select, insert, update,
and delete policies using `auth.uid() = user_id`; anonymous access is revoked. The worker's service-role
path adds the same actor/owner equality check before any repository call so internal APIs cannot use the
service role to cross user boundaries.

## The first run

The first run lives at `/welcome` and is open to everyone, signed in or not. The landing page's "Get started" opens
it; a confirmed sign-up lands on it; the roles view offers it to any signed-in account that has neither finished nor
skipped it and follows nothing. It is one question per screen, every question optional, with "Skip, just browse" on
every screen:

1. What are you looking for: Internship, New grad (every full-time early-career type: new grad, graduate program,
   rotational, apprenticeship), or Co-op.
2. Which fields: ten chips, each exactly one discipline of docs/role-scope.md (SWE, ML/AI, Data, Infra, Security,
   Hardware, Robotics, Quant, PM, Design). None means every field.
3. Any companies you are watching: a search over every company with an in-scope role, and the six with the most
   in-scope roles as suggestions ("most programs tracked").
4. The payoff, `/welcome?step=ready&…` with the answers in the URL: "Here are N programs to watch".

`apps/web/lib/onboarding.ts` turns the answers into the roles view's own filters (program types and disciplines), and
`lib/onboarding-data.ts` reads the payoff through the public reader: N is `dashboard_role_summary` for those filters,
so it is exactly what the roles view shows for them, and the list is `dashboard_role_page` in its default order
(forecasts first, soonest window first) at two roles per company, six in all, with the picked companies' matching roles
first. Companies reorder the list; they never hide every other company. Low-confidence forecasts and roles without a
forecast are not left out.

A guest's answers stay in the browser's local storage (`lib/guest-onboarding.ts`, key `firstseen:onboarding`); nothing
about a guest reaches the server. They personalize what the guest browses through the URL ("Keep browsing as guest"
opens the roles view filtered to them, and the landing page and the roles view offer them back). Choosing "Save these
and get alerts" marks them to carry over and opens sign-up; the first signed-in visit to `/welcome` then saves them
without asking again and clears the mark. Another device, or cleared storage, simply has no answers.

Saving (`POST /api/onboarding`, the same call a signed-in visitor's "Watch these" makes) writes
`recruiting_preferences.target_disciplines` and one `canonical_role` follow per listed in-scope role, plus one `company`
follow per picked company, with the user's own client, so RLS applies to every write. The program type has no column:
the follows carry it. Answers an earlier version of the first run stored (graduation year, season, places) are left as
they are and still shown in settings. It then asks the worker for a readiness plan for the first chosen role with a
current forecast and lands on that role, stating whether the plan was built, not configured, unreachable, or refused.
Skipping stores `onboarding_skipped_at`. Settings runs the questions again; that proposes roles to add and removes none.

`target_disciplines` is kept apart from `target_role_families`: role families are the older vocabulary that
`followed-timeline-ranking-v1` reads, and the first run does not write them.

## Timeline ranking version 1

`followed-timeline-ranking-v1` is a fixed ordinal ranking, not forecast confidence and not a learned
recommendation score. Only roles matching at least one follow are eligible. The rank includes:

- follow specificity: canonical role +40, company +25, role family +20, track +10;
- priority company: +12 through +20 for priority levels 1–5;
- target role family +10;
- target recruiting season +8;
- preferred location +8;
- preferred company size +6;
- compatible graduation timing +8; and
- readiness urgency: up to +30, otherwise near-term expected-opening urgency up to +12.

Every timeline item returns the follow scopes that admitted it and each scoring reason. Sorting uses score,
then the next readiness deadline or expected opening date. Forecasts older than seven days are excluded and
counted rather than silently presented as current.

The graduation rule is deliberately narrow: internships receive the timing adjustment when graduation is
after the current year; new-grad roles receive it for graduation in the current or following year. It does
not claim eligibility because job-specific eligibility requirements remain source evidence.

Future ranking changes require a new version, tests, and documentation. Do not add collaborative filtering,
behavioral profiling, opaque embeddings, or model-generated scores without a separately reviewed product
requirement.
