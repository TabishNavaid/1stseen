-- The API roles' privileges, granted explicitly rather than inherited from the platform's default privileges.
--
-- Every earlier migration relied on Supabase's default privileges for what `postgres` creates in public. The local
-- image grants anon, authenticated, and service_role every privilege on each new table, sequence, and function, and
-- 202608140031 and 202608140038 then took back what anon and authenticated must not hold. The hosted project began
-- with defaults that grant those roles only TRUNCATE, REFERENCES, TRIGGER, and MAINTAIN on tables and nothing on
-- sequences or functions, so there service_role could read or write none of the 38 tables, and a signed-in session
-- could read none of the evidence its pages show.
--
-- This grants exactly what the local rig holds, measured object by object, so both end in
-- the same state whatever defaults they began with, and sets the rig's default privileges for what later migrations
-- create. On the rig every statement is a no-op. scripts/lib/grant-contract.mjs checks the result.

-- service_role is the server-side role of the web app, the agent API, and the collectors: every privilege on every
-- table and view, the sequences its inserts advance, and the trigger functions its writes fire.
grant all on all tables in schema public to service_role;
grant usage, select, update on all sequences in schema public to service_role;
grant execute on function public.bump_public_data_version() to service_role;
grant execute on function public.create_profile_for_new_user() to service_role;
grant execute on function public.record_role_evidence_change() to service_role;
grant execute on function public.set_updated_at() to service_role;

-- A signed-in session reads these through the user-scoped client, row level security deciding which rows. Its writes
-- are 202608140038's (watchlist_items, recruiting_preferences, priority_companies), unchanged here.
grant select on
  public.archive_captures,
  public.calendar_event_syncs,
  public.canonical_roles,
  public.companies,
  public.email_digest_deliveries,
  public.email_digest_items,
  public.forecast_evidence,
  public.forecast_provenance,
  public.forecasts,
  public.historical_opening_events,
  public.observation_role_matches,
  public.priority_companies,
  public.profiles,
  public.raw_job_observations,
  public.readiness_milestones,
  public.recruiting_preferences,
  public.role_aliases,
  public.signals,
  public.source_discovery_evidence,
  public.source_fetches,
  public.sources,
  public.watchlist_items,
  public.watchlists
to authenticated;
grant usage, select on sequence public.role_evidence_changes_id_seq to authenticated;

-- What later migrations create gets the rig's defaults: service_role everything, authenticated read and execute (its
-- writes stay explicit, 202608140038), anon nothing (202608140031).
alter default privileges for role postgres in schema public grant all on tables to service_role;
alter default privileges for role postgres in schema public grant usage, select, update on sequences to service_role;
alter default privileges for role postgres in schema public grant execute on functions to service_role;
alter default privileges for role postgres in schema public grant select on tables to authenticated;
alter default privileges for role postgres in schema public grant usage, select on sequences to authenticated;
alter default privileges for role postgres in schema public grant execute on functions to authenticated;
