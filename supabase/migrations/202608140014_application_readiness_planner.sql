-- Versioned, explainable work-back plans derived from statistical forecast windows.

alter table public.readiness_milestones
  drop constraint if exists readiness_milestones_kind_check,
  drop constraint if exists readiness_milestones_user_id_forecast_id_kind_key,
  add column ideal_due_on date,
  add column lead_days integer,
  add column policy_version text,
  add column rationale text,
  add column adjustments jsonb not null default '[]'::jsonb,
  add column window_start date,
  add column window_end date;

update public.readiness_milestones
set kind = case kind
  when 'resume_lock' then 'resume_ready'
  when 'portfolio' then 'portfolio_ready'
  when 'referral' then 'referral_contacts'
  when 'application_ready' then 'high_alert'
  else kind
end;

update public.readiness_milestones as milestone
set
  ideal_due_on = milestone.due_on,
  lead_days = greatest(0, forecast.window_start - milestone.due_on),
  policy_version = 'legacy-fixed-lead-v0',
  rationale = 'Migrated from the legacy fixed lead-time planner.',
  window_start = forecast.window_start,
  window_end = forecast.window_end
from public.forecasts as forecast
where forecast.id = milestone.forecast_id;

alter table public.readiness_milestones
  alter column ideal_due_on set not null,
  alter column lead_days set not null,
  alter column policy_version set not null,
  alter column rationale set not null,
  alter column window_start set not null,
  alter column window_end set not null,
  add constraint readiness_milestones_kind_check check (
    kind in ('networking', 'referral_contacts', 'resume_ready', 'portfolio_ready', 'high_alert')
  ),
  add constraint readiness_milestones_lead_days_check check (lead_days >= 0),
  add constraint readiness_milestones_adjustments_array_check check (
    jsonb_typeof(adjustments) = 'array'
  ),
  add constraint readiness_milestones_window_check check (window_start <= window_end),
  add constraint readiness_milestones_user_forecast_kind_policy_key unique (
    user_id, forecast_id, kind, policy_version
  );

create index readiness_policy_due_idx
  on public.readiness_milestones (user_id, policy_version, due_on);

comment on table public.readiness_milestones is
  'User-scoped, versioned readiness dates calculated from forecast intervals by deterministic policy.';
comment on column public.readiness_milestones.ideal_due_on is
  'Uncompressed policy date; due_on becomes the plan generation date when the ideal date has passed.';
comment on column public.readiness_milestones.adjustments is
  'Explainable company-size, recruiting-scale, competitiveness, interval-width, and confidence adjustments.';
