/**
 * Connection helpers shared by the hosted-Supabase verification and metrics scripts.
 *
 * Two surfaces, because they answer different questions:
 *
 * - `restClient()` is PostgREST with the service-role key. It is the surface the
 *   web app and worker actually use, so reaching a table through it proves the
 *   deployed read path works.
 * - `sqlClient()` is a direct Postgres session. `pg_catalog`, `information_schema`,
 *   and privilege introspection are not exposed through PostgREST at all, so RLS
 *   state, policy bodies, and role grants can only be verified this way.
 *
 * Neither helper ever prints a credential.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Minimal `.env` reader: real environment variables always win. */
export function loadDotEnv(file = resolve(ROOT, ".env")) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Put it in .env (gitignored) or export it for this command.`,
    );
  }
  return value;
}

/** Redact everything but the host, so failures can be reported without leaking a password. */
export function safeDbTarget(connectionString) {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port || "5432"}${url.pathname}`;
  } catch {
    return "(unparseable SUPABASE_DB_URL)";
  }
}

/*
 * TLS for every Postgres connection this repository opens: the Node client here and in backup-corpus.mjs, and the
 * libpq tools (pg_dump, pg_restore) behind it.
 *
 * Hosted Supabase does not use a publicly trusted certificate for Postgres. Its pooler and direct endpoints present a
 * chain issued by Supabase's own CA (server certificate -> "Supabase Intermediate 2021 CA" -> "Supabase Root 2021 CA",
 * self-signed), which no system trust store holds, so verification needs that root. SUPABASE_DB_CA_CERT is the path to
 * it: Supabase dashboard, Project Settings, Database, SSL Configuration, "Download certificate" (prod-ca-2021.crt).
 * With it the certificate chain and the host name are both verified. Without it, a remote connection is still verified
 * against the system store and fails with "self-signed certificate in certificate chain", and the error says what to
 * set. Verification is never skipped by default.
 *
 * A loopback target is a local `supabase start` stack or a throwaway container, which serves plain TCP. The TLS
 * parameters in a connection string (`sslmode`, `sslrootcert`, ...) are removed and decided here instead, because
 * node-postgres lets them override the `ssl` object. SUPABASE_DB_SSL_INSECURE=true turns verification off for a
 * self-hosted server with no CA file; preflight refuses it in production.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const TLS_URL_PARAMS = ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "sslcrl", "uselibpqcompat"];
const UNTRUSTED_CHAIN = new Set(["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT"]);

export function isLoopbackTarget(connectionString) {
  try {
    return LOOPBACK_HOSTS.has(new URL(connectionString).hostname);
  } catch {
    return false;
  }
}

/** The CA file named by SUPABASE_DB_CA_CERT, read and checked, or null when it is unset. Never prints the path's contents. */
export function databaseCaCertificate() {
  const path = process.env.SUPABASE_DB_CA_CERT;
  if (!path) return null;
  let pem;
  try {
    pem = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`SUPABASE_DB_CA_CERT names a file that cannot be read (${error.code ?? error.message}): ${path}`);
  }
  if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error(`SUPABASE_DB_CA_CERT is not a PEM certificate (no BEGIN CERTIFICATE line): ${path}`);
  }
  return pem;
}

/** node-postgres `ssl` for a connection string: false on loopback, otherwise verified (with the Supabase CA when set). */
export function pgTls(connectionString) {
  if (isLoopbackTarget(connectionString)) return false;
  if (process.env.SUPABASE_DB_SSL_INSECURE === "true") return { rejectUnauthorized: false };
  const ca = databaseCaCertificate();
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

/** libpq's equivalent of pgTls, for pg_dump and pg_restore: the same rule, as PGSSLMODE and PGSSLROOTCERT. */
export function libpqTlsEnv(connectionString) {
  if (isLoopbackTarget(connectionString)) return { PGSSLMODE: "disable" };
  if (process.env.SUPABASE_DB_SSL_INSECURE === "true") return { PGSSLMODE: "require" };
  // Read it once here so a bad path fails before any tool starts. `system` is libpq 16+'s name for the OS trust store.
  return { PGSSLMODE: "verify-full", PGSSLROOTCERT: databaseCaCertificate() ? process.env.SUPABASE_DB_CA_CERT : "system" };
}

/** A connection string without TLS parameters, so pgTls alone decides TLS. */
function withoutTlsParams(connectionString) {
  try {
    const url = new URL(connectionString);
    for (const name of TLS_URL_PARAMS) url.searchParams.delete(name);
    return url.toString();
  } catch {
    return connectionString;
  }
}

/**
 * A connected node-postgres client, with TLS decided by pgTls. A chain the client could not verify is reported with
 * what to set, not as a bare "self-signed certificate".
 */
export async function connectPg(connectionString, { applicationName, statementTimeout } = {}) {
  let pg;
  try {
    pg = (await import("pg")).default;
  } catch {
    throw new Error("The 'pg' package is missing. Run `npm ci` at the repository root.");
  }
  const client = new pg.Client({
    connectionString: withoutTlsParams(connectionString),
    ssl: pgTls(connectionString),
    ...(applicationName ? { application_name: applicationName } : {}),
    ...(statementTimeout ? { statement_timeout: statementTimeout } : {}),
  });
  try {
    await client.connect();
  } catch (error) {
    if (UNTRUSTED_CHAIN.has(error.code)) {
      const hint = process.env.SUPABASE_DB_CA_CERT
        ? "the file in SUPABASE_DB_CA_CERT is not the CA that issued this server's certificate"
        : "set SUPABASE_DB_CA_CERT to the path of Supabase's root certificate (Project Settings > Database > SSL Configuration)";
      throw new Error(`${error.message} (${error.code}) connecting to ${safeDbTarget(connectionString)}: ${hint}`);
    }
    throw error;
  }
  return client;
}

/**
 * Direct Postgres session. Returns null when SUPABASE_DB_URL is absent so callers
 * can report an explicit SKIP instead of silently passing a check they never ran.
 */
export async function sqlClient() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) return null;
  return connectPg(connectionString, { applicationName: "firstseen-verify", statementTimeout: 120_000 });
}

/** PostgREST with the service-role key — the surface the product itself reads. */
export async function restClient() {
  const url = requireEnv("SUPABASE_URL").replace(/\/+$/, "");
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: "public" },
  });
}
