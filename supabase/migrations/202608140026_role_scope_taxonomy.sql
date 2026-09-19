-- Product scope for canonical roles: early-career technical programs only.
--
-- The worker's deterministic classifier (worker/src/firstseen/scope.py) writes these columns during
-- enrichment and through `firstseen classify-roles`; this migration adds no rows and backfills nothing,
-- because the rules live in Python. A null scope_status means "not yet classified" and is treated as
-- not in scope by every product read and by forecasting. Out-of-scope roles are never deleted.

create type public.role_scope_status as enum ('in_scope', 'out_of_scope', 'ambiguous');

create type public.role_discipline as enum (
  'software_engineering',
  'machine_learning',
  'infrastructure',
  'security',
  'hardware',
  'robotics',
  'data',
  'quantitative',
  'product_management',
  'design'
);

create type public.early_career_type as enum ('internship', 'co_op', 'new_grad', 'graduate_program', 'rotational');

alter table public.canonical_roles
  add column scope_status public.role_scope_status,
  add column scope_reason text check (scope_reason ~ '^[a-z_]{1,64}$'),
  add column discipline public.role_discipline,
  add column early_career_type public.early_career_type,
  add column scope_evidence jsonb not null default '[]'::jsonb
    check (jsonb_typeof(scope_evidence) = 'array' and octet_length(scope_evidence::text) <= 16384),
  add column scope_method text check (scope_method in ('deterministic', 'model_assisted')),
  add column scope_classifier_version text check (octet_length(scope_classifier_version) <= 80),
  add column scope_classified_at timestamptz,
  add constraint canonical_roles_scope_classified_together check (
    (
      scope_status is null
      and scope_reason is null
      and scope_method is null
      and scope_classifier_version is null
      and scope_classified_at is null
    )
    or (
      scope_status is not null
      and scope_reason is not null
      and scope_method is not null
      and scope_classifier_version is not null
      and scope_classified_at is not null
    )
  ),
  add constraint canonical_roles_in_scope_is_evidenced check (
    (scope_status = 'in_scope') = (scope_reason = 'in_scope')
    and (scope_status is distinct from 'in_scope' or (discipline is not null and early_career_type is not null))
  );

comment on column public.canonical_roles.scope_status is
  'in_scope roles are surfaced and forecast; out_of_scope roles stay as evidence only; ambiguous roles wait for review.';
comment on column public.canonical_roles.scope_evidence is
  'Rules that fired, in evaluation order: tier (title, ats_category, model), kind, rule, matched text, field.';

-- Filtering and search read in-scope roles only. Partial indexes keep those reads bounded
-- without indexing the out-of-scope majority.
create index canonical_roles_in_scope_facets_idx
  on public.canonical_roles (discipline, early_career_type, recruiting_season, company_id)
  where scope_status = 'in_scope' and active;

create index canonical_roles_in_scope_company_idx
  on public.canonical_roles (company_id, discipline)
  where scope_status = 'in_scope' and active;

create index canonical_roles_in_scope_location_idx
  on public.canonical_roles (location_scope, specialization)
  where scope_status = 'in_scope' and active;

create extension if not exists pg_trgm with schema extensions;

create index canonical_roles_in_scope_title_trgm_idx
  on public.canonical_roles using gin (normalized_title extensions.gin_trgm_ops)
  where scope_status = 'in_scope' and active;

-- The review queue and the corpus report group by status and reason.
create index canonical_roles_scope_review_idx
  on public.canonical_roles (scope_status, scope_reason, company_id);
