-- A signed-in session holds only the writes the product performs through it.
--
-- Supabase's default privileges give `authenticated` every table privilege on every table created in public
-- (INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, SELECT). Row level security is what kept a signed-in user
-- from writing a companies or forecasts row, and TRUNCATE is not governed by RLS at all. A signed-in user can reach
-- PostgREST directly with their own access token and the public anon key, so the grants are a real boundary.
--
-- What a signed-in session writes. Every write through a user-scoped client is in
-- apps/web/app/api/personalization/route.ts and apps/web/app/api/onboarding/route.ts; every other write in the web
-- app and the worker uses the service role, which this migration does not touch.
--
--   watchlist_items          INSERT (follow), DELETE (unfollow), UPDATE of alerts_enabled only (following again)
--   recruiting_preferences   INSERT and UPDATE: a PostgREST upsert on user_id (preferences, onboarding, skipping it)
--   priority_companies       INSERT and DELETE: saving preferences replaces the list
--
-- Their auth.uid() policies are unchanged and still decide which rows.
--
-- Revoked from authenticated:
--   - INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES and TRIGGER on every table and view in public; the writes above are
--     then granted back. No product path creates a foreign key or a trigger as a signed-in user.
--   - The column grants from 202608140019 (profiles.display_name, profiles.timezone, readiness_milestones.completed_at).
--     Nothing writes them through a user-scoped client. Their policies stay, so a feature that needs one grants that
--     column back in its own migration.
--   - UPDATE (setval) on public sequences.
--
-- SELECT is unchanged. Default privileges stop granting authenticated a write on tables and sequences created in public
-- from now on, as 202608140031 did for anon, so a new user-owned table grants what its route performs, explicitly.
-- scripts/verify-supabase.mjs (grants/authenticated-writes, grants/default-privileges) fails on any regrant, and
-- apps/web/tests/integration/authenticated-grants.test.mjs exercises the writes that remain.

revoke insert, update, delete, truncate, references, trigger on all tables in schema public from authenticated;

-- A table-level revoke leaves column-level grants in place, so each one is revoked by name.
do $$
declare
  target record;
begin
  for target in
    select c.oid::regclass as relation, a.attname as column_name, acl.privilege_type
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(a.attacl) as acl
     where n.nspname = 'public'
       and a.attnum > 0
       and not a.attisdropped
       and acl.grantee = 'authenticated'::regrole
       and acl.privilege_type in ('INSERT', 'UPDATE', 'REFERENCES')
  loop
    execute format('revoke %s (%I) on %s from authenticated', target.privilege_type, target.column_name, target.relation);
  end loop;
end;
$$;

revoke update on all sequences in schema public from authenticated;

grant insert, delete on public.watchlist_items to authenticated;
grant update (alerts_enabled) on public.watchlist_items to authenticated;
grant insert, update on public.recruiting_preferences to authenticated;
grant insert, delete on public.priority_companies to authenticated;

alter default privileges for role postgres in schema public
  revoke insert, update, delete, truncate, references, trigger on tables from authenticated;
alter default privileges for role postgres in schema public revoke update on sequences from authenticated;
