#!/usr/bin/env node
/**
 * Corpus backup: the collected evidence that cannot be recollected, as a standard pg_dump archive plus a manifest that
 * proves what is in it.
 *
 *   node scripts/backup-corpus.mjs dump <dir>            corpus.dump (pg_dump custom format, data only) + manifest.json
 *   node scripts/backup-corpus.mjs verify <dir>          row counts and content hashes of a database against a manifest
 *   node scripts/backup-corpus.mjs prove-restore <dir>   restore into a new scratch database, verify it, drop it
 *
 * What is backed up, and why (docs/operations.md has the long form): CORPUS_TABLES below. Collected evidence first —
 * raw_job_observations, archive_captures, source_fetches, historical_opening_events, signals — because their timestamps
 * are accumulated collection time: an opening event's availability is when 1stSeen learned it, so a re-derived corpus
 * would start every backtest cutoff from the day of the restore. Then what makes that evidence meaningful and loadable
 * (companies, sources, discovery provenance, canonical roles, aliases, role matches, signal state), the decisions people
 * made (scope reviews, identity re-keys), the predictions as they were made (forecasts, evidence, changes; a stored
 * prediction cannot be recreated later), and the evaluation history (backtest runs and cases).
 *
 * Not backed up: user-owned tables, deliberately (profiles, follows, preferences, readiness plans, calendar and digest
 * rows, OAuth connections); agent runs, tool calls, model usage, and inference decisions, which are operational audit logs
 * and can hold a user's own questions; and collection_checkpoints, a cursor whose loss costs one full regeneration pass.
 *
 * Consistency: the manifest is computed and the archive dumped inside one exported REPEATABLE READ snapshot, so the counts
 * and hashes describe exactly the rows in the archive even while collection writes. A content hash is the md5 of the
 * sorted md5s of every row's text form, with the session's output settings pinned, so it compares a restored copy row for
 * row without depending on physical order.
 *
 * Restoring into a new project: apply supabase/migrations (the manifest records the level it was taken at), then
 *   pg_restore --data-only --no-owner --no-privileges --single-transaction --exit-on-error --dbname=<new> corpus.dump
 * then `verify` against it. `prove-restore` does exactly that into a throwaway database.
 *
 * Connection: SUPABASE_DB_URL, for every mode (a direct or session-pooler Postgres URL; GitHub runners have no IPv6, so a
 * hosted project needs its session pooler there). prove-restore creates its scratch database on that server. The password
 * reaches pg_dump and pg_restore through PG* environment variables, never an argument, and nothing prints a credential or
 * the connection string. A hosted server's certificate is verified against SUPABASE_DB_CA_CERT (scripts/lib/db.mjs): the
 * Node client with it as its CA, and the tools with PGSSLMODE=verify-full and PGSSLROOTCERT naming it. A tools container
 * gets the file mounted at a fixed path and its own PGSSLROOTCERT pointing there (an explicit -e value wins over the
 * inherited one; Docker Desktop cannot mount a single file at its macOS path).
 *
 * The client tools must be at least the server's major version. BACKUP_PG_TOOLS is an optional command prefix for them,
 * such as a Postgres 17 container that inherits the PG* variables and reads the CA file at /supabase-ca.crt (the prefix
 * is split on spaces, so the file's path must not contain one):
 *   BACKUP_PG_TOOLS="docker run --rm -i --network host -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE -e PGSSLROOTCERT=/supabase-ca.crt -e PGAPPNAME -v $SUPABASE_DB_CA_CERT:/supabase-ca.crt:ro postgres:17-alpine"
 * or the local rig's own database container (its explicit -e values win over the inherited ones):
 *   BACKUP_PG_TOOLS="docker exec -i -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE -e PGSSLROOTCERT -e PGAPPNAME supabase_db_firstseen-local"
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { ROOT, connectPg, libpqTlsEnv, loadDotEnv, safeDbTarget } from "./lib/db.mjs";

loadDotEnv();

/** In foreign-key order, parents first. docs/operations.md explains each; worker/tests/test_ops_workflows.py checks the lists. */
const CORPUS_TABLES = [
  "companies",
  "sources",
  // Every stop, resume, withdrawal, and erasure of collection: without it a restored corpus would collect again from a
  // company that asked to be left alone (docs/takedown.md).
  "collection_takedowns",
  "source_discovery_evidence",
  "source_fetches",
  "signal_source_states",
  "raw_job_observations",
  "archive_captures",
  "canonical_roles",
  "role_aliases",
  "observation_role_matches",
  "historical_opening_events",
  "signals",
  "role_scope_reviews",
  "role_identity_migrations",
  "forecasts",
  "forecast_evidence",
  "forecast_changes",
  "backtest_runs",
  "backtest_cases",
];

/**
 * Every other table in public, and why it is not backed up. worker/tests/test_ops_workflows.py fails on a table that a
 * migration creates and neither list names, so a new table is a decision, not an omission.
 */
const NOT_BACKED_UP = {
  profiles: "user-owned",
  watchlists: "user-owned",
  watchlist_items: "user-owned",
  priority_companies: "user-owned",
  recruiting_preferences: "user-owned",
  readiness_milestones: "user-owned",
  calendar_event_syncs: "user-owned",
  email_digest_deliveries: "user-owned",
  email_digest_items: "user-owned",
  gmail_connections: "user-owned, and holds encrypted OAuth tokens",
  google_calendar_connections: "user-owned, and holds encrypted OAuth tokens",
  agent_runs: "operational audit log that can hold a user's own questions",
  agent_tool_calls: "operational audit log that can hold a user's own questions",
  model_usage: "operational audit log",
  inference_decisions: "operational audit log",
  collection_checkpoints: "a cursor: losing it costs one full regeneration pass",
  account_deletions: "an anonymous count of deletions, no evidence: nothing to restore a corpus from",
  role_evidence_changes: "a change log for regeneration: losing it costs one full regeneration pass",
};

const MANIFEST_VERSION = "corpus-backup-v1";
const ARCHIVE = "corpus.dump";
const MANIFEST = "manifest.json";

/** Output settings pinned so a row's text form is the same in every session that hashes it. */
const PINNED_SETTINGS = [
  "set local timezone = 'UTC'",
  "set local datestyle = 'ISO, YMD'",
  "set local intervalstyle = 'postgres'",
  "set local extra_float_digits = 3",
  "set local bytea_output = 'hex'",
];

async function connect(connectionString, applicationName) {
  // TLS is decided in scripts/lib/db.mjs: verified against SUPABASE_DB_CA_CERT for a hosted server, off on loopback.
  // Hashing the largest table is a full scan; allow for a corpus many times today's.
  return connectPg(connectionString, { applicationName, statementTimeout: 30 * 60_000 });
}

/** libpq environment for a connection string, so no password is ever an argument. */
function libpqEnv(connectionString, database) {
  const url = new URL(connectionString);
  return {
    PGHOST: url.hostname,
    PGPORT: url.port || "5432",
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: database ?? decodeURIComponent(url.pathname.replace(/^\//, "") || "postgres"),
    // verify-full with SUPABASE_DB_CA_CERT for a hosted server, the same rule as the Node client; off on loopback.
    ...libpqTlsEnv(connectionString),
    PGAPPNAME: "firstseen-backup",
  };
}

/** A Postgres client tool, behind the optional BACKUP_PG_TOOLS prefix. */
function tool(name) {
  return [...(process.env.BACKUP_PG_TOOLS ?? "").trim().split(/\s+/).filter(Boolean), name];
}

/** Runs a client tool with libpq env; stdout goes to `stdout` (a stream) or is collected; stderr is kept for errors. */
function run(argv, env, { stdin, stdout } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(argv[0], argv.slice(1), { env: { ...process.env, ...env }, stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    let errors = "";
    let collected = "";
    child.stderr.on("data", (chunk) => { errors += chunk; });
    if (stdout) child.stdout.pipe(stdout);
    else child.stdout.on("data", (chunk) => { collected += chunk; });
    if (stdin) stdin.pipe(child.stdin);
    // A file is complete only once its stream has flushed, which can be after the process exits.
    const flushed = stdout ? new Promise((ok) => stdout.on("finish", ok)) : Promise.resolve();
    child.on("error", fail);
    child.on("close", async (code) => {
      // Client tools name the host and database in errors, never the password; strip the password anyway.
      const scrub = (text) => (env.PGPASSWORD ? text.split(env.PGPASSWORD).join("[redacted]") : text);
      if (code !== 0) {
        fail(new Error(`${argv.find((part) => part.startsWith("pg_")) ?? argv[0]} exited ${code}: ${scrub(errors).trim().slice(-1500)}`));
        return;
      }
      await flushed;
      done(collected);
    });
  });
}

async function hashTables(client, tables) {
  const result = {};
  for (const table of tables) {
    const started = performance.now();
    const { rows } = await client.query(
      `select count(*)::bigint as rows, md5(coalesce(string_agg(h, '' order by h), '')) as content_md5
         from (select md5(t::text) as h from public.${table} as t) as hashed`,
    );
    result[table] = { rows: Number(rows[0].rows), content_md5: rows[0].content_md5, hash_ms: Math.round(performance.now() - started) };
  }
  return result;
}

async function migrationLevel(client) {
  const { rows } = await client.query(
    "select case when to_regclass('supabase_migrations.schema_migrations') is null then null else (select max(version) from supabase_migrations.schema_migrations) end as level",
  );
  return rows[0].level ?? null;
}

async function sha256File(path) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

const mib = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;

async function dump(dir) {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("SUPABASE_DB_URL is not set");
  mkdirSync(dir, { recursive: true });
  const started = performance.now();
  const client = await connect(url, "firstseen-backup");
  try {
    await client.query("begin isolation level repeatable read read only");
    for (const setting of PINNED_SETTINGS) await client.query(setting);
    const { rows } = await client.query("select pg_export_snapshot() as snapshot, current_setting('server_version') as server_version, now() as taken_at");
    const { snapshot, server_version: serverVersion, taken_at: takenAt } = rows[0];

    // The archive first, while the snapshot is held, then the manifest from the same snapshot.
    const archive = join(dir, ARCHIVE);
    const dumpTool = tool("pg_dump");
    const toolVersion = (await run([...dumpTool, "--version"], {})).trim();
    const dumpStarted = performance.now();
    await run(
      [
        ...dumpTool,
        "--format=custom",
        "--data-only",
        "--no-owner",
        "--no-privileges",
        `--snapshot=${snapshot}`,
        ...CORPUS_TABLES.map((table) => `--table=public.${table}`),
      ],
      libpqEnv(url),
      { stdout: createWriteStream(archive) },
    );
    const dumpMs = Math.round(performance.now() - dumpStarted);
    const hashStarted = performance.now();
    const tables = await hashTables(client, CORPUS_TABLES);
    const hashMs = Math.round(performance.now() - hashStarted);
    const level = await migrationLevel(client);
    await client.query("commit");

    const bytes = statSync(archive).size;
    const manifest = {
      manifest_version: MANIFEST_VERSION,
      taken_at: new Date(takenAt).toISOString(),
      server_version: serverVersion,
      dump_tool: toolVersion,
      migration_level: level,
      archive: { file: ARCHIVE, bytes, sha256: await sha256File(archive), format: "pg_dump custom, data only" },
      tables,
      not_backed_up: NOT_BACKED_UP,
      totals: { tables: CORPUS_TABLES.length, rows: Object.values(tables).reduce((sum, table) => sum + table.rows, 0) },
      timings_ms: { dump: dumpMs, hash: hashMs, total: Math.round(performance.now() - started) },
    };
    writeFileSync(join(dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(
      `backup: ${manifest.totals.rows} rows in ${CORPUS_TABLES.length} tables from ${safeDbTarget(url)} at migration ${level ?? "unknown"}\n`
        + `backup: ${ARCHIVE} ${mib(bytes)}; dump ${(dumpMs / 1000).toFixed(1)} s, hashes ${(hashMs / 1000).toFixed(1)} s, total ${(manifest.timings_ms.total / 1000).toFixed(1)} s\n`,
    );
    return manifest;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

/** Compares a database's corpus tables with a manifest. Returns the mismatches; prints a table. */
async function verifyAgainst(connectionString, manifest, label) {
  const client = await connect(connectionString, "firstseen-backup-verify");
  try {
    await client.query("begin isolation level repeatable read read only");
    for (const setting of PINNED_SETTINGS) await client.query(setting);
    const actual = await hashTables(client, Object.keys(manifest.tables));
    await client.query("commit");
    const mismatches = [];
    const lines = [`| Table | Rows in backup | Rows in ${label} | Content hash |`, "|---|---:|---:|---|"];
    for (const [table, expected] of Object.entries(manifest.tables)) {
      const found = actual[table];
      const same = found.rows === expected.rows && found.content_md5 === expected.content_md5;
      if (!same) mismatches.push(table);
      lines.push(`| ${table} | ${expected.rows} | ${found.rows} | ${same ? `match (${expected.content_md5.slice(0, 12)})` : `**MISMATCH** ${expected.content_md5.slice(0, 12)} vs ${found.content_md5.slice(0, 12)}`} |`);
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return mismatches;
  } finally {
    await client.end();
  }
}

function readManifest(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, MANIFEST), "utf8"));
  if (manifest.manifest_version !== MANIFEST_VERSION) throw new Error(`unknown manifest version ${manifest.manifest_version}`);
  return manifest;
}

async function checkArchive(dir, manifest) {
  const archive = join(dir, manifest.archive.file);
  const digest = await sha256File(archive);
  if (digest !== manifest.archive.sha256) throw new Error(`${manifest.archive.file} does not match its manifest sha256`);
  return archive;
}

async function verify(dir) {
  const manifest = readManifest(dir);
  await checkArchive(dir, manifest);
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("set SUPABASE_DB_URL to the database to verify");
  const mismatches = await verifyAgainst(url, manifest, safeDbTarget(url));
  if (mismatches.length) throw new Error(`${mismatches.length} table(s) differ from the backup: ${mismatches.join(", ")}`);
  process.stdout.write(`verify: all ${Object.keys(manifest.tables).length} tables match the backup taken ${manifest.taken_at}\n`);
}

/** What a new hosted project has before migrations run and a bare Postgres does not: the auth schema, roles, extensions. */
const SCRATCH_PRELUDE = `
create schema if not exists extensions;
create schema if not exists auth;
create extension if not exists pgcrypto with schema extensions;
create table if not exists auth.users (id uuid primary key, email text, raw_user_meta_data jsonb not null default '{}'::jsonb);
create or replace function auth.uid() returns uuid language sql stable
  as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$
declare
  role_name text;
begin
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      execute format('create role %I nologin', role_name);
    end if;
  end loop;
end;
$$;
`;

async function proveRestore(dir) {
  const manifest = readManifest(dir);
  const archive = await checkArchive(dir, manifest);
  const adminUrl = process.env.SUPABASE_DB_URL;
  if (!adminUrl) throw new Error("set SUPABASE_DB_URL to a server where a scratch database can be created");
  const scratch = `firstseen_restore_check_${randomBytes(4).toString("hex")}`;
  const scratchUrl = (() => {
    const url = new URL(adminUrl);
    url.pathname = `/${scratch}`;
    return url.toString();
  })();
  const timings = {};
  const admin = await connect(adminUrl, "firstseen-backup-scratch");
  let created = false;
  try {
    let step = performance.now();
    await admin.query(`create database ${scratch}`);
    created = true;
    const target = await connect(scratchUrl, "firstseen-backup-scratch");
    try {
      // The schema a new project gets: the repository's migrations, in order, up to the level the backup was taken at.
      // The search_path hosted Supabase runs `db push` with. `extensions` is not on it, so a migration that calls an
      // extension function without `extensions.` fails here as it does there (the rig's postgres role would hide it).
      await target.query(`set search_path = "$user", public`);
      await target.query(SCRATCH_PRELUDE);
      const migrations = readdirSync(resolve(ROOT, "supabase/migrations"))
        .filter((file) => /^\d{12}_[a-z0-9_]+\.sql$/.test(file))
        .sort()
        .filter((file) => !manifest.migration_level || file.slice(0, 12) <= manifest.migration_level);
      for (const file of migrations) {
        try {
          await target.query(readFileSync(resolve(ROOT, "supabase/migrations", file), "utf8"));
        } catch (error) {
          throw new Error(`migration ${file} failed on the scratch database: ${error.message}`);
        }
      }
      timings.schema = Math.round(performance.now() - step);
      process.stdout.write(`prove-restore: ${scratch} built from ${migrations.length} migrations in ${(timings.schema / 1000).toFixed(1)} s\n`);
    } finally {
      await target.end();
    }

    step = performance.now();
    await run(
      [...tool("pg_restore"), "--data-only", "--no-owner", "--no-privileges", "--single-transaction", "--exit-on-error", `--dbname=${scratch}`],
      libpqEnv(adminUrl, scratch),
      { stdin: createReadStream(archive) },
    );
    timings.restore = Math.round(performance.now() - step);
    process.stdout.write(`prove-restore: pg_restore of ${mib(manifest.archive.bytes)} took ${(timings.restore / 1000).toFixed(1)} s\n`);

    step = performance.now();
    const mismatches = await verifyAgainst(scratchUrl, manifest, "restore");
    timings.verify = Math.round(performance.now() - step);
    if (mismatches.length) throw new Error(`restore differs from the backup in: ${mismatches.join(", ")}`);
    process.stdout.write(
      `prove-restore: all ${Object.keys(manifest.tables).length} tables and ${manifest.totals.rows} rows match; verify ${(timings.verify / 1000).toFixed(1)} s\n`,
    );
    return timings;
  } finally {
    if (created) {
      // Never leave the scratch database behind, whatever failed.
      await admin.query(`drop database if exists ${scratch} with (force)`).catch((error) => {
        process.stderr.write(`prove-restore: could not drop ${scratch}: ${error.message}\n`);
      });
      process.stdout.write(`prove-restore: dropped ${scratch}\n`);
    }
    await admin.end();
  }
}

const [mode, dirArg] = process.argv.slice(2);
const dir = dirArg ? resolve(dirArg) : null;
const modes = { dump, verify, "prove-restore": proveRestore };
if (!modes[mode] || !dir) {
  process.stderr.write("usage: node scripts/backup-corpus.mjs <dump|verify|prove-restore> <dir>\n");
  process.exit(2);
}
modes[mode](dir).catch((error) => {
  process.stderr.write(`backup-corpus ${mode} failed: ${error.message}\n`);
  process.exitCode = 1;
});
