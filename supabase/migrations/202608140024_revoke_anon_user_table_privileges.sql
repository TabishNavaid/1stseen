-- Browser-anonymous callers hold no privilege on user-owned tables.
--
-- Current Supabase Postgres images grant `anon` SELECT/INSERT/UPDATE/DELETE on every table
-- created in `public`. Row-level security already returns nothing to `anon` on these
-- tables, because every policy is `to authenticated` and scoped by auth.uid(), but the
-- access contract (scripts/verify-supabase.mjs, grants/anon-on-user-tables) is that
-- `anon` holds no privilege on them at all. A freshly started project failed that check
-- for six tables. `authenticated` privileges, including the column-level update grants
-- from 202608140019, are unchanged.
--
-- Revoking is a no-op where a privilege was never granted, so this is safe on projects
-- created before the default changed.

revoke all on public.profiles from anon;
revoke all on public.watchlists from anon;
revoke all on public.watchlist_items from anon;
revoke all on public.recruiting_preferences from anon;
revoke all on public.priority_companies from anon;
revoke all on public.readiness_milestones from anon;
revoke all on public.calendar_event_syncs from anon;
revoke all on public.email_digest_deliveries from anon;
revoke all on public.email_digest_items from anon;
