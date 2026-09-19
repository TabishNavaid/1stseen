-- Align the persisted signal vocabulary with the runtime model and apply the
-- explicit service-only privilege pattern to the remaining automation tables.

-- `program_page_change` was permitted by the database but had no SignalType member
-- and no entry in the versioned strength table, so no collector could produce it
-- and no consumer could weight it. Its meaning is covered by the supported
-- `internship_program_page_changed` type, which carries a defined strength.
update public.signals
set kind = 'internship_program_page_changed'
where kind = 'program_page_change';

alter table public.signals drop constraint if exists signals_kind_normalized_check;
alter table public.signals add constraint signals_kind_normalized_check check (kind in (
  'career_page_changed',
  'internship_program_page_changed',
  'new_relevant_sitemap_url',
  'company_recruiting_blog_post',
  'university_recruiting_page_update',
  'new_ats_role_family_appearing',
  'community_recruiting_discussion'
));

comment on constraint signals_kind_normalized_check on public.signals is
  'Supported signal types must match firstseen.signals.SignalType and its versioned strength table.';

-- These tables already enable RLS with no policy, which denies browser roles by
-- default. Revoking explicitly matches the pattern used by the other automation
-- tables so a future policy cannot silently expose automation state.
revoke all on public.backtest_runs from anon, authenticated;
revoke all on public.backtest_cases from anon, authenticated;
revoke all on public.signal_source_states from anon, authenticated;
revoke all on public.forecast_changes from anon, authenticated;

comment on table public.backtest_runs is
  'Service-role evaluation runs. Browser roles have no privileges on this table.';
comment on table public.backtest_cases is
  'Service-role held-out evaluation cases retaining the exact cutoff-safe input set.';
comment on table public.signal_source_states is
  'Service-role deterministic change-detection state for recruiting sources.';
comment on table public.forecast_changes is
  'Service-role immutable before/after forecast deltas linked to their trigger signals.';
