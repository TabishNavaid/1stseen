/**
 * What a signed-in session may write, and the catalog queries that prove nothing else holds a write.
 *
 * scripts/verify-supabase.mjs runs these against a hosted project, and
 * apps/web/tests/integration/authenticated-grants.test.mjs runs the same ones inside a rolled-back transaction, so the
 * check and its proof cannot drift apart. Migration 202608140038 is what makes them pass.
 */

/**
 * Every write `authenticated` holds in public, and why. A table-level privilege is listed by name; a column-level one as
 * `PRIVILEGE (column)`. Each is performed through the user-scoped client in apps/web/app/api/personalization/route.ts or
 * apps/web/app/api/onboarding/route.ts, under an auth.uid() policy.
 */
export const AUTHENTICATED_WRITES = {
  watchlist_items: ["INSERT", "DELETE", "UPDATE (alerts_enabled)"],
  recruiting_preferences: ["INSERT", "UPDATE"],
  priority_companies: ["INSERT", "DELETE"],
};

const WRITE_PRIVILEGES = ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];

/** Every write privilege `authenticated` holds on a relation in public, as `relation:PRIVILEGE` or `relation:PRIVILEGE (column)`. */
export async function authenticatedWrites(sql) {
  const { rows: tableRows } = await sql.query(
    `select c.relname as relation, p.privilege
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      cross join unnest($1::text[]) as p(privilege)
      where n.nspname = 'public'
        and c.relkind in ('r', 'v', 'm', 'p', 'f')
        and has_table_privilege('authenticated', c.oid, p.privilege)`,
    [WRITE_PRIVILEGES],
  );
  // A column privilege counts only where the table-level one is absent; has_column_privilege is also true through it.
  const { rows: columnRows } = await sql.query(
    `select c.relname as relation, p.privilege, a.attname as column_name
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      cross join unnest(array['INSERT', 'UPDATE', 'REFERENCES']) as p(privilege)
      where n.nspname = 'public'
        and c.relkind in ('r', 'v', 'm', 'p', 'f')
        and has_column_privilege('authenticated', c.oid, a.attnum, p.privilege)
        and not has_table_privilege('authenticated', c.oid, p.privilege)`,
  );
  return [
    ...tableRows.map((row) => `${row.relation}:${row.privilege}`),
    ...columnRows.map((row) => `${row.relation}:${row.privilege} (${row.column_name})`),
  ].sort();
}

/** `{ unexpected, missing }` against AUTHENTICATED_WRITES. Both empty means the contract holds. */
export async function authenticatedWriteViolations(sql) {
  const held = new Set(await authenticatedWrites(sql));
  const expected = new Set(
    Object.entries(AUTHENTICATED_WRITES).flatMap(([relation, privileges]) => privileges.map((privilege) => `${relation}:${privilege}`)),
  );
  return {
    unexpected: [...held].filter((grant) => !expected.has(grant)).sort(),
    missing: [...expected].filter((grant) => !held.has(grant)).sort(),
  };
}

/**
 * Default privileges that would hand a browser role a write on the next table, sequence, or function `postgres` creates in
 * public: anything for anon (202608140031), and any write for authenticated (202608140038). Returned as
 * `role:objecttype:PRIVILEGE`, where objecttype is tables, sequences, or functions.
 */
export async function browserDefaultPrivileges(sql) {
  const { rows } = await sql.query(
    `select acl.grantee::regrole::text as role,
            case d.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions' else d.defaclobjtype::text end as object_type,
            acl.privilege_type as privilege
       from pg_default_acl d
       join pg_namespace n on n.oid = d.defaclnamespace
      cross join lateral aclexplode(d.defaclacl) as acl
      where d.defaclrole = 'postgres'::regrole
        and n.nspname = 'public'
        and acl.grantee <> 0
        and (
          acl.grantee = 'anon'::regrole
          or (
            acl.grantee = 'authenticated'::regrole
            and (
              (d.defaclobjtype = 'r' and acl.privilege_type = any($1::text[]))
              or (d.defaclobjtype = 'S' and acl.privilege_type = 'UPDATE')
            )
          )
        )
      order by 1, 2, 3`,
    [WRITE_PRIVILEGES],
  );
  return rows.map((row) => `${row.role}:${row.object_type}:${row.privilege}`);
}

/** UPDATE (setval) on a public sequence, which is a write however the sequence is used. */
export async function authenticatedSequenceWrites(sql) {
  const { rows } = await sql.query(
    `select c.relname as sequence
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        -- A CASE, because Postgres may evaluate the privilege call before the relkind test, and it raises on an index.
        and case when c.relkind = 'S' then has_sequence_privilege('authenticated', c.oid, 'UPDATE') else false end
      order by 1`,
  );
  return rows.map((row) => row.sequence);
}

/**
 * What the API roles must hold: the other direction from everything above, which only proves what they must not. The
 * checks above all passed on a hosted project where service_role could read no table at all, because that project's
 * default privileges grant the API roles no SELECT, INSERT, UPDATE, or DELETE. Migration
 * 202608140044 grants these explicitly.
 *
 * service_role is the server-side role of the web app, the agent API, and the collectors: it must hold every read and
 * write on every table and view in public, and USAGE on every sequence. authenticated reads exactly these relations
 * through the user-scoped client, row level security deciding which rows; a new one is a decision, listed here.
 */
export const AUTHENTICATED_READS = [
  "archive_captures", "calendar_event_syncs", "canonical_roles", "companies", "email_digest_deliveries",
  "email_digest_items", "forecast_evidence", "forecast_provenance", "forecasts", "historical_opening_events",
  "observation_role_matches", "priority_companies", "profiles", "raw_job_observations", "readiness_milestones",
  "recruiting_preferences", "role_aliases", "signals", "source_discovery_evidence", "source_fetches", "sources",
  "watchlist_items", "watchlists",
];
const SERVICE_ROLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE"];

/** `{ serviceRoleMissing, authenticatedUnexpected, authenticatedMissing }`, each sorted. All empty means the contract holds. */
export async function apiRoleGrantViolations(sql) {
  const { rows: missingRows } = await sql.query(
    `select c.relname || ':' || p.privilege as grant
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      cross join unnest($1::text[]) as p(privilege)
      where n.nspname = 'public'
        and c.relkind in ('r', 'v', 'm', 'p', 'f')
        and not has_table_privilege('service_role', c.oid, p.privilege)
     union all
     select c.relname || ':USAGE'
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        -- CASE, because the planner may otherwise call has_sequence_privilege on a row that is not a sequence, which errors.
        and case when c.relkind = 'S' then not has_sequence_privilege('service_role', c.oid, 'USAGE') else false end`,
    [SERVICE_ROLE_PRIVILEGES],
  );
  const { rows: readRows } = await sql.query(
    `select c.relname as relation
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'v', 'm', 'p', 'f')
        and has_table_privilege('authenticated', c.oid, 'SELECT')`,
  );
  const held = new Set(readRows.map((row) => row.relation));
  const expected = new Set(AUTHENTICATED_READS);
  return {
    serviceRoleMissing: missingRows.map((row) => row.grant).sort(),
    authenticatedUnexpected: [...held].filter((relation) => !expected.has(relation)).sort(),
    authenticatedMissing: [...expected].filter((relation) => !held.has(relation)).sort(),
  };
}
