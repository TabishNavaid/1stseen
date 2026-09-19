-- Two reads that could not be paged to exhaustion (the 1000-row cap sweep).
--
-- forecast_provenance had no unique column. One forecast_evidence row joins to one observation, so its id identifies a
-- provenance row, but the view did not expose it: the rig's 18,813 rows had 17,067 distinct (forecast_id,
-- observation_id) pairs, so a pager ordered by those could skip or repeat rows across pages. evidence_id is appended
-- (create or replace view may only add columns at the end), and the view keeps its grants and security_invoker.
--
-- replay_candidate_companies ended in `limit 500`. The replay company filter would silently lose every company after
-- the 500th alphabetically; the corpus already has more companies than that. It now returns them all, and the web app
-- pages it like any other read.

create or replace view public.forecast_provenance with (security_invoker = true) as
select
  f.id as forecast_id,
  f.canonical_role_id,
  fe.contribution,
  fe.weight,
  fe.rationale,
  o.id as observation_id,
  o.observed_at,
  o.content_hash,
  o.extraction_method,
  s.id as source_id,
  s.url as source_url,
  co.id as company_id,
  co.name as company_name,
  he.opened_on,
  he.opening_window_start,
  he.opening_window_end,
  he.date_precision,
  he.uncertainty_days,
  he.provenance as historical_provenance,
  sig.kind as signal_kind,
  fe.id as evidence_id
from public.forecasts f
join public.forecast_evidence fe on fe.forecast_id = f.id
join public.raw_job_observations o on o.id = fe.observation_id
join public.sources s on s.id = o.source_id
join public.companies co on co.id = s.company_id
left join public.historical_opening_events he on he.id = fe.historical_opening_event_id
left join public.signals sig on sig.id = fe.signal_id;

create or replace function public.replay_candidate_companies()
returns table (
  company_name text,
  candidates bigint
)
language sql
stable
set search_path = ''
as $$
  select c.company_name, count(*)
  from public.replay_candidates(null, null, null, null) c
  group by c.company_name
  order by c.company_name
$$;
