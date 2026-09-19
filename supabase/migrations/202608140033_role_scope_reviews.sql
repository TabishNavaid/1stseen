-- A person's scope decision for an ambiguous role (docs/role-scope.md, `firstseen review-scope`).
--
-- The classifier abstains into `ambiguous` rather than guess. A reviewer reads the evidence that made the role
-- ambiguous and decides in or out. Each decision is kept here with its provenance: who decided, when, from what
-- (the titles alone, or the posting itself), why, and exactly what they were shown. The outcome is written to
-- canonical_roles with scope_method 'human_review', and reclassification keeps it for as long as the role's titles
-- and ATS filing still match `evidence_fingerprint`.

create table public.role_scope_reviews (
  id uuid primary key,
  canonical_role_id uuid not null references public.canonical_roles(id) on delete cascade,
  status public.role_scope_status not null check (status <> 'ambiguous'),
  reason text not null check (reason ~ '^[a-z_]{1,64}$'),
  discipline public.role_discipline,
  early_career_type public.early_career_type,
  basis text not null check (basis in ('titles', 'posting')),
  note text not null check (char_length(btrim(note)) >= 3 and octet_length(note) <= 4000),
  reviewer text not null check (char_length(btrim(reviewer)) >= 1 and octet_length(reviewer) <= 480),
  evidence_fingerprint text not null check (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
  shown jsonb not null check (jsonb_typeof(shown) = 'object' and octet_length(shown::text) <= 65536),
  decided_at timestamptz not null default now(),
  constraint role_scope_reviews_in_scope_is_evidenced check (
    (status = 'in_scope') = (reason = 'in_scope')
    and (status <> 'in_scope' or (discipline is not null and early_career_type is not null))
    and (status = 'in_scope' or discipline is null)
  )
);

comment on table public.role_scope_reviews is
  'Service-only. One row per scope decision a person made on an ambiguous role; the latest one per role is in force.';
comment on column public.role_scope_reviews.basis is
  'titles: the titles and ATS filing decide it, so the rules should learn it. posting: the posting itself was needed.';
comment on column public.role_scope_reviews.shown is
  'The classification, per-title evidence, and postings the reviewer was shown when deciding.';

create index role_scope_reviews_role_idx on public.role_scope_reviews (canonical_role_id, decided_at desc);

alter table public.role_scope_reviews enable row level security;
revoke all on public.role_scope_reviews from anon, authenticated;

alter table public.canonical_roles drop constraint canonical_roles_scope_method_check;
alter table public.canonical_roles
  add constraint canonical_roles_scope_method_check
  check (scope_method in ('deterministic', 'model_assisted', 'human_review'));

-- The review row and the role's outcome are written together or not at all. The role must still be the one the
-- reviewer was shown: unchanged since it was listed, and awaiting review or already decided by a person.
create function public.record_role_scope_review(
  p_review_id uuid,
  p_role_id uuid,
  p_listed_classified_at timestamptz,
  p_status public.role_scope_status,
  p_reason text,
  p_discipline public.role_discipline,
  p_early_career_type public.early_career_type,
  p_basis text,
  p_note text,
  p_reviewer text,
  p_evidence_fingerprint text,
  p_shown jsonb,
  p_scope_evidence jsonb,
  p_classifier_version text
)
returns timestamptz
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_decided_at timestamptz := now();
begin
  update public.canonical_roles
     set scope_status = p_status,
         scope_reason = p_reason,
         discipline = p_discipline,
         early_career_type = p_early_career_type,
         scope_evidence = p_scope_evidence,
         scope_method = 'human_review',
         scope_classifier_version = p_classifier_version,
         scope_classified_at = v_decided_at
   where id = p_role_id
     and scope_classified_at = p_listed_classified_at
     and (scope_status = 'ambiguous' or scope_method = 'human_review');
  if not found then
    raise exception 'role % changed since it was listed, or is not awaiting review', p_role_id
      using errcode = 'P0002';
  end if;

  insert into public.role_scope_reviews (
    id, canonical_role_id, status, reason, discipline, early_career_type, basis, note, reviewer,
    evidence_fingerprint, shown, decided_at
  ) values (
    p_review_id, p_role_id, p_status, p_reason, p_discipline, p_early_career_type, p_basis, p_note, p_reviewer,
    p_evidence_fingerprint, p_shown, v_decided_at
  );
  return v_decided_at;
end;
$$;

revoke all on function public.record_role_scope_review(
  uuid, uuid, timestamptz, public.role_scope_status, text, public.role_discipline, public.early_career_type, text, text,
  text, text, jsonb, jsonb, text
) from public, anon, authenticated;
grant execute on function public.record_role_scope_review(
  uuid, uuid, timestamptz, public.role_scope_status, text, public.role_discipline, public.early_career_type, text, text,
  text, text, jsonb, jsonb, text
) to service_role;
