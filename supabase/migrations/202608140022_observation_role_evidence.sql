-- One observation may be evidence for many canonical roles.
--
-- An archived careers page legitimately lists hundreds of requisitions, so the
-- original one-row-per-observation primary key made archive reconstruction
-- structurally impossible: every role after the first conflicted, and the
-- backtest loader rejected the dataset. The natural key is the pair.

alter table public.observation_role_matches
  drop constraint if exists observation_role_matches_pkey;

alter table public.observation_role_matches
  add constraint observation_role_matches_pkey
    primary key (observation_id, canonical_role_id);

-- Ranked evidence: an archived page match is weaker than a resolver decision over
-- a single posting, and consumers must be able to tell them apart.
alter table public.observation_role_matches
  add column if not exists evidence_kind text not null default 'observation_resolution',
  add column if not exists is_primary boolean not null default true;

alter table public.observation_role_matches
  drop constraint if exists observation_role_matches_evidence_kind_check;
alter table public.observation_role_matches
  add constraint observation_role_matches_evidence_kind_check check (
    evidence_kind in ('observation_resolution', 'archive_page_attribution')
  );

-- A posting-level resolution is the observation's primary identity; an archived
-- page has no single primary role. Enforced as a partial unique index so at most
-- one role may claim primary evidence for an observation.
drop index if exists observation_role_matches_primary_key_idx;
create unique index observation_role_matches_primary_key_idx
  on public.observation_role_matches (observation_id)
  where is_primary;

create index if not exists observation_role_matches_observation_idx
  on public.observation_role_matches (observation_id);

comment on table public.observation_role_matches is
  'Role evidence for a raw observation. One observation may support many canonical '
  'roles; at most one row per observation is the primary posting-level resolution.';
comment on column public.observation_role_matches.evidence_kind is
  'observation_resolution = resolver decision over a single posting. '
  'archive_page_attribution = the role was visible on a shared archived page capture.';
comment on column public.observation_role_matches.is_primary is
  'True for the observation''s own posting-level identity. Archived page attributions '
  'are never primary because one capture carries evidence for many roles.';

-- Archive attributions are secondary by construction.
update public.observation_role_matches
set is_primary = false
where evidence_kind = 'archive_page_attribution';

-- Browser roles keep read-only access; writes stay service-role only.
revoke insert, update, delete on public.observation_role_matches from anon, authenticated;
