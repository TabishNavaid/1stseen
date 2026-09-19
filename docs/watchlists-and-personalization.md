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

A new account lands on `/welcome`, and the dashboard offers it to any signed-in account that has neither
finished nor skipped it and follows nothing. It asks four questions, each optional: the kind of role (seven tracks that
together cover the seventeen disciplines of docs/role-scope.md exactly once), graduation year, target season, and up to
three places. `apps/web/lib/onboarding.ts` turns the answers into arguments for `onboarding_seed_roles` (migration
202608140030), which reads the dashboard's in-scope facts:

- A graduation year two or more years out asks for internships and co-ops, next year for those and graduate
  programs, and this year or earlier for graduate programs. No answer asks for every type.
- A stated season or place leaves out roles that state a different one. Roles that state none stay, ranked after
  the matches, because most roles state neither.
- Roles with a current forecast (two or more cycles and a window that has not ended) come first, then matched places
  and seasons, then confidence and cycles for current forecasts only. Low-confidence forecasts are not left out. At
  most two roles per company, and eight in all.

Nothing is saved until the user reviews the proposal. Finishing (`POST /api/onboarding`) writes
`recruiting_preferences` and one `canonical_role` follow per chosen in-scope role with the user's own client, so RLS
applies to every write. It then asks the worker for a readiness plan for the first chosen role with a current forecast
and lands on that role, stating whether the plan was built, not configured, unreachable, or refused. Skipping stores
`onboarding_skipped_at`. Settings runs the questions again; that proposes roles to add and removes none.

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
