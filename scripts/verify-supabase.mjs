#!/usr/bin/env node
/**
 * Hosted-Supabase acceptance check.
 *
 * Asserts that a linked project actually matches the schema and access contract
 * this repository claims: every table and view exists, RLS is on everywhere,
 * user-owned tables are `auth.uid()`-scoped, automation tables are unreachable
 * by `anon` and `authenticated`, and no reserved `.example` fixture string ever
 * reached the database.
 *
 * Two credentials, because they answer different questions:
 *   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY  -> PostgREST, the product's own read path
 *   SUPABASE_DB_URL                           -> catalog, policies, and grants
 *
 * PostgREST does not expose `pg_catalog` or `information_schema`, so the RLS,
 * policy, and grant checks are impossible without the direct connection. When it
 * is absent those checks report SKIP and the run fails — a check that did not run
 * is never reported as a pass.
 *
 * Exit code 0 only when every check passed.
 */

import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, loadDotEnv, restClient, sqlClient, safeDbTarget } from "./lib/db.mjs";
import {
  AUTHENTICATED_WRITES,
  authenticatedSequenceWrites,
  AUTHENTICATED_READS,
  apiRoleGrantViolations,
  authenticatedWriteViolations,
  browserDefaultPrivileges,
} from "./lib/grant-contract.mjs";

loadDotEnv();

/* ------------------------------------------------------------------ contract */

/** Evidence and reference tables: RLS on, readable by any authenticated session. */
const REFERENCE_TABLES = [
  "archive_captures",
  "canonical_roles",
  "companies",
  "forecast_evidence",
  "forecasts",
  "historical_opening_events",
  "observation_role_matches",
  "raw_job_observations",
  "role_aliases",
  "signals",
  "source_discovery_evidence",
  "source_fetches",
  "sources",
];

/** User-owned tables: RLS on, and at least one policy scoped by `auth.uid()`. */
const USER_OWNED_TABLES = [
  "profiles",
  "watchlists",
  "watchlist_items",
  "recruiting_preferences",
  "priority_companies",
  "readiness_milestones",
  "calendar_event_syncs",
  "email_digest_deliveries",
  "email_digest_items",
];

/**
 * Service-role-only tables: RLS on, zero policies, and no privilege for `anon`
 * or `authenticated`.
 *
 * `gmail_connections` and `google_calendar_connections` belong here, not in the
 * user-owned set, even though they are "integration" tables. They hold encrypted
 * OAuth refresh tokens, so they stay service-write-only; the
 * user-readable presentations are `calendar_event_syncs` and the digest tables,
 * which are `auth.uid()`-scoped above.
 */
const SERVICE_ONLY_TABLES = [
  "account_deletions",
  "agent_runs",
  "agent_tool_calls",
  "backtest_cases",
  "backtest_runs",
  "collection_checkpoints",
  // Every stop, resume, withdrawal, and erasure of collection (202608140039).
  "collection_takedowns",
  "forecast_changes",
  "gmail_connections",
  "google_calendar_connections",
  "inference_decisions",
  "model_usage",
  "role_evidence_changes",
  "role_identity_migrations",
  "role_scope_reviews",
  "signal_source_states",
];

const ALL_TABLES = [...REFERENCE_TABLES, ...USER_OWNED_TABLES, ...SERVICE_ONLY_TABLES].sort();

const EXPECTED_VIEWS = ["forecast_provenance", "inference_run_metrics"];
const SERVICE_ONLY_VIEWS = ["inference_run_metrics"];

/** Every migration in the repository, so adding one cannot leave this check stale. */
const MIGRATION_VERSIONS = readdirSync(resolve(ROOT, "supabase/migrations"))
  .filter((file) => /^\d{12}_[a-z0-9_]+\.sql$/.test(file))
  .map((file) => file.slice(0, 12))
  .sort();

/**
 * Bounded read-path functions (202608140023, 202608140025, 202608140029, 202608140035, 202608140040), the worker's
 * scope-review write (202608140033), and account export and deletion (202608140037). Callable only by service_role: an
 * anon or authenticated caller must not be able to run them through PostgREST's /rpc surface. finish_account_deletion
 * alone is SECURITY DEFINER, because it removes Supabase Auth's leftovers for a deleted id; checkDefinerFunctions pins
 * its search_path.
 */
const SERVICE_ONLY_FUNCTIONS = [
  "followed_role_ids",
  "forecast_role_states",
  "forecast_history_depth",
  "forecast_basis",
  "forecast_basis_for_forecasts",
  "dashboard_role_facts",
  "dashboard_filtered_roles",
  "dashboard_role_page",
  "dashboard_role_summary",
  "dashboard_filter_options",
  "replay_latest_backtest_outcomes",
  "replay_candidates",
  "replay_candidate_page",
  "replay_candidate_summary",
  "replay_candidate_companies",
  "replay_backtest_reasons",
  "onboarding_seed_roles",
  "public_data_version",
  "public_agent_activity",
  "record_role_scope_review",
  "split_canonical_role",
  // Takedowns (202608140039): the only way a source or a company's roles are switched off on request.
  "apply_collection_takedown",
  // Account export and deletion (202608140037).
  "account_agent_run_ids",
  "delete_account_data",
  "finish_account_deletion",
  "record_late_google_revocation",
];

/* -------------------------------------------------------------------- output */

const results = [];
const record = (status, check, detail) => {
  results.push({ status, check, detail });
  const glyph = { PASS: "PASS", FAIL: "FAIL", SKIP: "SKIP", INFO: "INFO" }[status];
  process.stdout.write(`  ${glyph}  ${check}\n`);
  if (detail && status !== "PASS") process.stdout.write(`        ${detail}\n`);
};

function table() {
  const w1 = Math.max(6, ...results.map((r) => r.status.length));
  const w2 = Math.max(5, ...results.map((r) => r.check.length));
  const line = `+${"-".repeat(w1 + 2)}+${"-".repeat(w2 + 2)}+${"-".repeat(62)}+`;
  const rows = [
    line,
    `| ${"STATUS".padEnd(w1)} | ${"CHECK".padEnd(w2)} | ${"DETAIL".padEnd(60)} |`,
    line,
  ];
  for (const r of results) {
    const detail = (r.detail ?? "").replace(/\s+/g, " ");
    const chunks = detail.length > 60 ? detail.match(/.{1,60}/g) : [detail];
    rows.push(
      `| ${r.status.padEnd(w1)} | ${r.check.padEnd(w2)} | ${(chunks[0] ?? "").padEnd(60)} |`,
    );
    for (const extra of (chunks ?? []).slice(1)) {
      rows.push(`| ${"".padEnd(w1)} | ${"".padEnd(w2)} | ${extra.padEnd(60)} |`);
    }
  }
  rows.push(line);
  return rows.join("\n");
}

/* -------------------------------------------------------------------- checks */

/**
 * What went wrong with a PostgREST read, in words that say what to change. A HEAD (count) request has no body, so its
 * error message is empty; the status is the evidence, and a one-row GET fetches PostgREST's own error. Never prints the
 * key: only whether it has stray whitespace and what role and project its claims name.
 */
async function describeRestFailure(rest, error, status, statusText) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!status) {
    const cause = error.message || error.details || "no response";
    return `network error, no HTTP response (${cause}): check SUPABASE_URL and this machine's connection`;
  }
  let detail = error.message;
  if (!detail) {
    const retry = await rest.from("companies").select("id").limit(1);
    detail = retry.error ? [retry.error.code, retry.error.message].filter(Boolean).join(" ") : "";
  }
  const parts = [`HTTP ${status}${statusText ? ` ${statusText}` : ""}${detail ? `, ${detail}` : ""}`];
  if (key !== key.trim()) parts.push("SUPABASE_SERVICE_ROLE_KEY has leading or trailing whitespace");
  const claims = (() => {
    try {
      return JSON.parse(Buffer.from(key.trim().split(".")[1], "base64url").toString("utf8"));
    } catch {
      return null;
    }
  })();
  if (claims?.role && claims.role !== "service_role") parts.push(`the key's role claim is "${claims.role}", not "service_role" (the anon key?)`);
  if (claims?.ref && !String(process.env.SUPABASE_URL).includes(claims.ref)) parts.push("the key belongs to a different project than SUPABASE_URL");
  if (status === 401) parts.push("the key was rejected: use the service_role key of this project");
  else if (status === 403) parts.push("the key was accepted, but the service_role role lacks a privilege on the table: a grant is missing in the database, not a key problem");
  else if (status === 404) parts.push("no such endpoint or table: check SUPABASE_URL and that the migrations are applied");
  return parts.join("; ");
}

async function checkRestSurface() {
  let rest;
  try {
    rest = await restClient();
  } catch (error) {
    record("FAIL", "rest/credentials", error.message);
    return null;
  }
  const { error, status, statusText } = await rest.from("companies").select("id", { count: "exact", head: true });
  if (error) {
    record("FAIL", "rest/reachable", `service-role read of public.companies failed: ${await describeRestFailure(rest, error, status, statusText)}`);
    return rest;
  }
  record("PASS", "rest/reachable", "service-role key reads public.companies through PostgREST");
  return rest;
}

async function checkMigrations(sql) {
  const { rows } = await sql.query(
    "select version from supabase_migrations.schema_migrations order by version",
  );
  const applied = new Set(rows.map((r) => String(r.version)));
  const missing = MIGRATION_VERSIONS.filter((v) => !applied.has(v));
  if (missing.length) {
    record("FAIL", "migrations/applied", `${missing.length} of ${MIGRATION_VERSIONS.length} not recorded: ${missing.join(", ")}`);
  } else {
    record("PASS", "migrations/applied", `all ${MIGRATION_VERSIONS.length} recorded (${MIGRATION_VERSIONS[0]}..${MIGRATION_VERSIONS.at(-1)})`);
  }
  const extra = [...applied].filter((v) => !MIGRATION_VERSIONS.includes(v));
  if (extra.length) record("INFO", "migrations/extra", `also applied: ${extra.join(", ")}`);
}

async function checkTablesAndViews(sql) {
  const { rows } = await sql.query(
    `select c.relname as name,
            c.relkind as kind,
            c.relrowsecurity as rls,
            coalesce('security_invoker=true' = any (c.reloptions), false) as security_invoker
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'v', 'm')`,
  );
  const byName = new Map(rows.map((r) => [r.name, r]));

  const missingTables = ALL_TABLES.filter((t) => byName.get(t)?.kind !== "r");
  if (missingTables.length) {
    record("FAIL", "schema/tables", `missing ${missingTables.length}/${ALL_TABLES.length}: ${missingTables.join(", ")}`);
  } else {
    record("PASS", "schema/tables", `all ${ALL_TABLES.length} expected tables present in public`);
  }

  const missingViews = EXPECTED_VIEWS.filter((v) => byName.get(v)?.kind !== "v");
  if (missingViews.length) {
    record("FAIL", "schema/views", `missing: ${missingViews.join(", ")}`);
  } else {
    record("PASS", "schema/views", `forecast_provenance and inference_run_metrics present`);
  }

  const leaky = EXPECTED_VIEWS.filter(
    (v) => byName.get(v)?.kind === "v" && !byName.get(v).security_invoker,
  );
  if (leaky.length) {
    record("FAIL", "schema/views-security-invoker", `${leaky.join(", ")} would bypass caller RLS`);
  } else if (missingViews.length === 0) {
    record("PASS", "schema/views-security-invoker", "both views run with the caller's RLS");
  }

  const known = new Set([...ALL_TABLES, ...EXPECTED_VIEWS]);
  const unexpected = rows.map((r) => r.name).filter((n) => !known.has(n));
  if (unexpected.length) {
    record("INFO", "schema/unexpected", `not in the contract: ${unexpected.sort().join(", ")}`);
  }
  return byName;
}

async function checkCompositePrimaryKey(sql) {
  const { rows } = await sql.query(
    `select a.attname as column, k.ordinality as position
       from pg_constraint con
       join pg_class c on c.oid = con.conrelid
       join pg_namespace n on n.oid = c.relnamespace
       join lateral unnest(con.conkey) with ordinality as k(attnum, ordinality) on true
       join pg_attribute a on a.attrelid = c.oid and a.attnum = k.attnum
      where n.nspname = 'public'
        and c.relname = 'observation_role_matches'
        and con.contype = 'p'
      order by k.ordinality`,
  );
  const actual = rows.map((r) => r.column);
  const expected = ["observation_id", "canonical_role_id"];
  if (actual.length === 0) {
    record("FAIL", "schema/orm-pk", "observation_role_matches has no primary key");
  } else if (actual.join(",") !== expected.join(",")) {
    record(
      "FAIL",
      "schema/orm-pk",
      `observation_role_matches PK is (${actual.join(", ")}), expected (${expected.join(", ")}) — migration 0022 did not apply`,
    );
  } else {
    record("PASS", "schema/orm-pk", "observation_role_matches PK is (observation_id, canonical_role_id)");
  }
}

/**
 * Product scope (migration 0026): canonical_roles carries the classification, and no role is left
 * unclassified. Unclassified roles are treated as out of scope by every read path, so a corpus
 * enriched before 0026 would silently show nothing until `firstseen classify-roles --all` runs.
 */
async function checkRoleScope(sql) {
  const { rows: columns } = await sql.query(
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'canonical_roles'
        and column_name in ('scope_status', 'scope_reason', 'discipline', 'early_career_type', 'scope_evidence')`,
  );
  if (columns.length !== 5) {
    record("FAIL", "schema/role-scope", "canonical_roles is missing scope columns: migration 0026 did not apply");
    return;
  }
  const { rows } = await sql.query(
    `select count(*)::int as total,
            count(*) filter (where scope_status is null)::int as unclassified,
            count(*) filter (where scope_status = 'in_scope')::int as in_scope
       from public.canonical_roles`,
  );
  const { total, unclassified, in_scope: inScope } = rows[0];
  if (unclassified > 0) {
    record("FAIL", "data/role-scope", `${unclassified} of ${total} roles are unclassified; run: firstseen classify-roles --all`);
  } else {
    record("PASS", "data/role-scope", `every role is classified (${inScope} of ${total} in scope)`);
  }
}

async function checkRowLevelSecurity(byName) {
  const without = ALL_TABLES.filter((t) => byName.get(t)?.kind === "r" && !byName.get(t).rls);
  if (without.length) {
    record("FAIL", "rls/enabled", `RLS is OFF on: ${without.join(", ")}`);
  } else {
    record("PASS", "rls/enabled", `row level security enabled on all ${ALL_TABLES.length} tables`);
  }
}

async function checkUserPolicies(sql) {
  const { rows } = await sql.query(
    `select tablename, policyname,
            coalesce(qual, '') || ' ' || coalesce(with_check, '') as body
       from pg_policies where schemaname = 'public'`,
  );
  const byTable = new Map();
  for (const r of rows) {
    if (!byTable.has(r.tablename)) byTable.set(r.tablename, []);
    byTable.get(r.tablename).push(r);
  }

  const failures = [];
  for (const t of USER_OWNED_TABLES) {
    const policies = byTable.get(t) ?? [];
    const scoped = policies.filter((p) => /auth\.uid\(\)/.test(p.body));
    if (scoped.length === 0) {
      failures.push(`${t} (${policies.length} policies, none reference auth.uid())`);
    }
  }
  if (failures.length) {
    record("FAIL", "rls/auth-uid-policies", failures.join("; "));
  } else {
    record(
      "PASS",
      "rls/auth-uid-policies",
      `all ${USER_OWNED_TABLES.length} user-owned tables carry an auth.uid() policy`,
    );
  }

  const stray = SERVICE_ONLY_TABLES.filter((t) => (byTable.get(t) ?? []).length > 0);
  if (stray.length) {
    record("FAIL", "rls/service-only-policies", `unexpected policies on: ${stray.join(", ")}`);
  } else {
    record("PASS", "rls/service-only-policies", "automation tables expose no policy to any browser role");
  }
}

async function checkGrants(sql) {
  const targets = [...SERVICE_ONLY_TABLES, ...SERVICE_ONLY_VIEWS];
  const { rows } = await sql.query(
    `select t.relname as name, r.rolname as role, p.priv as privilege
       from unnest($1::text[]) as t(relname)
       cross join unnest(array['anon','authenticated']) as r(rolname)
       cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','REFERENCES','TRIGGER']) as p(priv)
      where to_regclass('public.' || t.relname) is not null
        and has_table_privilege(r.rolname, 'public.' || t.relname, p.priv)`,
    [targets],
  );
  if (rows.length) {
    const detail = rows.map((r) => `${r.role}:${r.name}:${r.privilege}`).join(", ");
    record("FAIL", "grants/service-role-only", `browser roles hold privileges: ${detail}`);
  } else {
    record(
      "PASS",
      "grants/service-role-only",
      `no anon/authenticated privilege on ${targets.length} automation relations`,
    );
  }

  const { rows: anonRows } = await sql.query(
    `select t.relname as name, p.priv as privilege
       from unnest($1::text[]) as t(relname)
       cross join unnest(array['SELECT','INSERT','UPDATE','DELETE']) as p(priv)
      where to_regclass('public.' || t.relname) is not null
        and has_table_privilege('anon', 'public.' || t.relname, p.priv)`,
    [USER_OWNED_TABLES],
  );
  if (anonRows.length) {
    record(
      "FAIL",
      "grants/anon-on-user-tables",
      `anon holds: ${anonRows.map((r) => `${r.name}:${r.privilege}`).join(", ")}`,
    );
  } else {
    record("PASS", "grants/anon-on-user-tables", "anon holds no privilege on any user-owned table");
  }

  // Guest mode serves signed-out visitors from the Worker, so anon needs nothing at all (migration 202608140031).
  const { rows: anywhere } = await sql.query(
    `select c.relname as name
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'v', 'm', 'p', 'S')
        and case
          when c.relkind = 'S' then has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE')
          else has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        end
      order by 1`,
  );
  if (anywhere.length) {
    record("FAIL", "grants/anon-anywhere", `anon holds privileges on: ${anywhere.map((row) => row.name).join(", ")}`);
  } else {
    record("PASS", "grants/anon-anywhere", "anon holds no privilege on any table, view, or sequence in public");
  }
}

/**
 * A signed-in session writes only what the personalization and onboarding routes write (migration 202608140038,
 * contract in scripts/lib/grant-contract.mjs). Any other INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, or TRIGGER held by
 * authenticated in public is a regrant, table or column, and so is a default privilege that would grant one to the next
 * table created. A missing contract write fails too: the route that performs it would break.
 */
async function checkAuthenticatedWrites(sql) {
  const { unexpected, missing } = await authenticatedWriteViolations(sql);
  const sequences = await authenticatedSequenceWrites(sql);
  const byRelation = new Map();
  for (const grant of [...unexpected, ...sequences.map((sequence) => `${sequence}:UPDATE (sequence)`)]) {
    const [relation, privilege] = grant.split(":");
    byRelation.set(relation, [...(byRelation.get(relation) ?? []), privilege]);
  }
  const problems = [
    ...[...byRelation].map(([relation, privileges]) => `holds ${relation} ${privileges.join(", ")}`),
    ...missing.map((grant) => `lacks ${grant.replace(":", " ")}, which a signed-in route performs`),
  ];
  if (problems.length) {
    record("FAIL", "grants/authenticated-writes", `authenticated ${problems.join("; ")}`);
  } else {
    const kept = Object.entries(AUTHENTICATED_WRITES).map(([relation, privileges]) => `${relation} ${privileges.join(", ")}`).join("; ");
    record("PASS", "grants/authenticated-writes", `authenticated writes only: ${kept}`);
  }

  const defaults = await browserDefaultPrivileges(sql);
  if (defaults.length) {
    record("FAIL", "grants/default-privileges", `new objects in public would grant: ${defaults.join(", ")}`);
  } else {
    record("PASS", "grants/default-privileges", "new tables, sequences, and functions in public grant anon nothing and authenticated no write");
  }
}

/**
 * What service_role and authenticated must hold (scripts/lib/grant-contract.mjs). Every other grant check proves an
 * absence, so without this one a database whose default privileges granted the API roles nothing passed them all.
 */
async function checkApiRoleGrants(sql) {
  const { serviceRoleMissing, authenticatedUnexpected, authenticatedMissing } = await apiRoleGrantViolations(sql);
  const problems = [
    serviceRoleMissing.length ? `service_role lacks ${serviceRoleMissing.length}: ${serviceRoleMissing.slice(0, 8).join(", ")}${serviceRoleMissing.length > 8 ? ", ..." : ""}` : "",
    authenticatedMissing.length ? `authenticated cannot read ${authenticatedMissing.join(", ")}` : "",
    authenticatedUnexpected.length ? `authenticated reads ${authenticatedUnexpected.join(", ")}, not in AUTHENTICATED_READS` : "",
  ].filter(Boolean);
  if (problems.length) {
    record("FAIL", "grants/api-roles", `${problems.join("; ")} (migration 202608140044 grants these)`);
  } else {
    record("PASS", "grants/api-roles", `service_role reads and writes every table, view, and sequence; authenticated reads the ${AUTHENTICATED_READS.length} relations a session reads`);
  }
}

async function checkFunctionGrants(sql) {
  const { rows: present } = await sql.query(
    `select distinct p.proname as name
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = any($1)`,
    [SERVICE_ONLY_FUNCTIONS],
  );
  const found = new Set(present.map((row) => row.name));
  const missing = SERVICE_ONLY_FUNCTIONS.filter((name) => !found.has(name));
  if (missing.length) {
    record("FAIL", "schema/functions", `missing: ${missing.join(", ")}`);
  } else {
    record("PASS", "schema/functions", `all ${SERVICE_ONLY_FUNCTIONS.length} service-only functions exist`);
  }

  const { rows } = await sql.query(
    `select p.proname as name, r.rolname as role
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       cross join (values ('anon'), ('authenticated')) as r(rolname)
      where n.nspname = 'public'
        and p.proname = any($1)
        and has_function_privilege(r.rolname, p.oid, 'EXECUTE')`,
    [SERVICE_ONLY_FUNCTIONS],
  );
  if (rows.length) {
    record("FAIL", "grants/service-only-functions", `browser roles can execute: ${rows.map((r) => `${r.role}:${r.name}`).join(", ")}`);
  } else {
    record("PASS", "grants/service-only-functions", "no anon/authenticated EXECUTE on any read-path function");
  }
}

/**
 * A SECURITY DEFINER function runs with its owner's rights, so it must pin search_path (or a caller's objects could
 * shadow the ones it names) and, unless it is a trigger or event-trigger function, must not be callable by a browser
 * role. Neither kind can be called from a query or through PostgREST: Postgres refuses ("cannot display a value of type
 * event_trigger"), which is how hosted Supabase's own `rls_auto_enable()` is exempt, EXECUTE grant or not.
 */
async function checkDefinerFunctions(sql) {
  const { rows } = await sql.query(
    `select p.proname as name,
            coalesce(exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'), false) as pinned,
            p.prorettype in ('trigger'::regtype, 'event_trigger'::regtype) as trigger,
            has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
            has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
      order by 1`,
  );
  const unpinned = rows.filter((row) => !row.pinned).map((row) => row.name);
  const callable = rows.filter((row) => !row.trigger && (row.anon || row.authenticated)).map((row) => row.name);
  if (unpinned.length || callable.length) {
    const detail = [
      unpinned.length ? `no pinned search_path: ${unpinned.join(", ")}` : "",
      callable.length ? `callable by a browser role: ${callable.join(", ")}` : "",
    ].filter(Boolean).join("; ");
    record("FAIL", "functions/security-definer", detail);
  } else {
    record("PASS", "functions/security-definer", `${rows.length} SECURITY DEFINER functions pin search_path; none but trigger and event-trigger functions is callable by a browser role`);
  }
}

async function checkNoFixtureRows(sql) {
  /*
   * Casting the whole row to text is the only complete scan: it covers every
   * column, including nested jsonb, arrays, and columns added later, without
   * enumerating types.
   */
  const offenders = [];
  for (const t of ALL_TABLES) {
    const { rows } = await sql.query(
      `select count(*)::int as n from public.${t} as r where r::text ilike '%.example%'`,
    );
    if (rows[0].n > 0) offenders.push(`${t}=${rows[0].n}`);
  }
  if (offenders.length) {
    record(
      "FAIL",
      "data/no-example-domains",
      `reserved .example fixture strings found — seed.sql was executed against this project: ${offenders.join(", ")}`,
    );
  } else {
    record("PASS", "data/no-example-domains", `all ${ALL_TABLES.length} tables scanned, zero rows contain ".example"`);
  }
}

async function checkNoFixtureRowsViaRest(rest) {
  const probes = [
    ["companies", "domain"],
    ["sources", "url"],
    ["raw_job_observations", "source_url"],
  ];
  const offenders = [];
  for (const [t, column] of probes) {
    const { count, error } = await rest
      .from(t)
      .select(column, { count: "exact", head: true })
      .ilike(column, "%.example%");
    if (error) {
      offenders.push(`${t}: ${error.message}`);
      continue;
    }
    if (count > 0) offenders.push(`${t}.${column}=${count}`);
  }
  if (offenders.length) {
    record("FAIL", "data/no-example-domains", `partial scan found: ${offenders.join(", ")}`);
  } else {
    record(
      "SKIP",
      "data/no-example-domains",
      `only 3 of ${ALL_TABLES.length} tables scanned (companies.domain, sources.url, raw_job_observations.source_url) — set SUPABASE_DB_URL for the complete row scan`,
    );
  }
}

/* ---------------------------------------------------------------------- main */

async function main() {
  process.stdout.write("\n1stSeen — hosted Supabase verification\n\n");

  const rest = await checkRestSurface();

  let sql = null;
  try {
    sql = await sqlClient();
  } catch (error) {
    record("FAIL", "sql/connect", error.message);
  }

  if (sql) {
    process.stdout.write(`  ..    direct connection: ${safeDbTarget(process.env.SUPABASE_DB_URL)}\n`);
    try {
      await checkMigrations(sql);
      const byName = await checkTablesAndViews(sql);
      await checkCompositePrimaryKey(sql);
      await checkRoleScope(sql);
      await checkRowLevelSecurity(byName);
      await checkUserPolicies(sql);
      await checkGrants(sql);
      await checkAuthenticatedWrites(sql);
      await checkApiRoleGrants(sql);
      await checkFunctionGrants(sql);
      await checkDefinerFunctions(sql);
      await checkNoFixtureRows(sql);
    } finally {
      await sql.end();
    }
  } else if (!results.some((r) => r.check === "sql/connect")) {
    const reason = "SUPABASE_DB_URL is not set; pg_catalog is not reachable through PostgREST";
    for (const check of [
      "migrations/applied",
      "schema/tables",
      "schema/views",
      "schema/orm-pk",
      "rls/enabled",
      "rls/auth-uid-policies",
      "grants/service-role-only",
      "grants/authenticated-writes",
      "grants/default-privileges",
      "grants/api-roles",
      "schema/functions",
      "grants/service-only-functions",
      "functions/security-definer",
    ]) {
      record("SKIP", check, reason);
    }
    if (rest) await checkNoFixtureRowsViaRest(rest);
  }

  process.stdout.write(`\n${table()}\n`);

  const failed = results.filter((r) => r.status === "FAIL");
  const skipped = results.filter((r) => r.status === "SKIP");
  const passed = results.filter((r) => r.status === "PASS");
  process.stdout.write(
    `\n${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped\n`,
  );

  if (failed.length || skipped.length) {
    process.stdout.write(
      failed.length
        ? "\nNOT READY — fix every FAIL above before deploying.\n\n"
        : "\nNOT READY — a skipped check is not a passed check.\n\n",
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write("\nAll checks green.\n\n");
}

main().catch((error) => {
  process.stderr.write(`\nverify-supabase failed: ${error.message}\n\n`);
  process.exitCode = 1;
});
