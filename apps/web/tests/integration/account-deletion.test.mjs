/**
 * Integration test: account export and deletion against the local rig, through the built Worker.
 *
 * Needs: `scripts/local-rig.sh up`, migration 202608140037 applied, and `npm run build`. Runs in
 * `npm run test:integration`, not the gate. Google is never contacted: this process's fetch answers every Google URL
 * itself and records the call, and Google Calendar and Gmail are configured here with throwaway keys so the
 * connections can hold encrypted fake tokens.
 *
 * What must be covered is read from the catalog, not from a list in this file:
 *   - every column that can hold a user id: each foreign key to auth.users(id) or public.profiles(id), and each uuid or
 *     text column named like a user reference (user_id, owner, initiated_by, actor_id, ...), in any schema;
 *   - every public table that a covered public table's rows take with them (ON DELETE CASCADE, followed transitively).
 * The synthetic account gets at least one row in each. A public table, or a non-foreign-key auth column, with no seed
 * here fails the test: add the seed, add the table to delete_account_data (migration) and to the export
 * (lib/account/data.ts). An auth column that is a foreign key to auth.users with ON DELETE CASCADE is Supabase Auth's
 * own and is covered by that cascade, which the catalog proves.
 *
 * Afterwards every row of every readable table is scanned as text for the account's id and its email, and the
 * revoke endpoint must have been called exactly once per connection. A third account is deleted while Google does not
 * answer: it must be deleted all the same, recorded as unconfirmed, told to remove access at myaccount.google.com, and
 * its tokens offered to Google again after the response without being written anywhere. A second account is present
 * throughout and must be untouched. Both accounts, and the anonymous deletion records this test causes, are removed in `finally` even when
 * an assertion fails.
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import "../support/retain-request-clones.mjs";

import { loadDotEnv, sqlClient } from "../../../../scripts/lib/db.mjs";
import { importTokenKey, sealToken } from "../../lib/oauth-token-crypto.ts";

loadDotEnv();
const require = createRequire(new URL("../../package.json", import.meta.url));
const { createClient } = require("@supabase/supabase-js");

const RUN = randomUUID().slice(0, 8);
const address = (label) => `account-deletion-${label}-${RUN}@firstseen-test.invalid`;
const password = `Correct-horse-${RUN}`;
const randomKey = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

/* ------------------------------------------------------------------ Google, answered locally */

const INTEGRATION_ENV = {
  GOOGLE_CALENDAR_CLIENT_ID: "synthetic-calendar-client-id.account-deletion-test",
  GOOGLE_CALENDAR_CLIENT_SECRET: "synthetic-calendar-client-secret-account-deletion",
  GOOGLE_CALENDAR_REDIRECT_URI: "http://localhost/api/integrations/google-calendar/callback",
  GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY: randomKey(),
  GMAIL_OAUTH_CLIENT_ID: "synthetic-gmail-client-id.account-deletion-test",
  GMAIL_OAUTH_CLIENT_SECRET: "synthetic-gmail-client-secret-account-deletion",
  GMAIL_OAUTH_REDIRECT_URI: "http://localhost/api/integrations/gmail/callback",
  EMAIL_TOKEN_ENCRYPTION_KEY: randomKey(),
};
const savedEnv = Object.fromEntries(Object.keys(INTEGRATION_ENV).map((name) => [name, process.env[name]]));
Object.assign(process.env, INTEGRATION_ENV);

const google = { mode: "answer", calls: [] };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : null;
  const url = new URL(request ? request.url : String(input));
  if (!/(^|\.)google(apis)?\.com$/.test(url.hostname)) return realFetch(input, init);
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const body = init?.body instanceof URLSearchParams ? init.body.toString() : typeof init?.body === "string" ? init.body : "";
  google.calls.push({ url: `${url.origin}${url.pathname}`, method, body });
  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/revoke") {
    return google.mode === "unreachable" ? new Response("", { status: 503 }) : new Response("", { status: 200 });
  }
  if (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/calendar/v3/") && method === "DELETE") {
    return google.mode === "unreachable" ? new Response("", { status: 503 }) : new Response(null, { status: 204 });
  }
  return new Response("not stubbed", { status: 599 });
};
const revokeCalls = () => google.calls.filter((call) => call.url === "https://oauth2.googleapis.com/revoke");

/* ------------------------------------------------------------------ the built Worker */

/** Work the Worker handed to ctx.waitUntil (vinext's after()), so a test can let it finish before the next request. */
const background = [];
const settleBackground = async () => {
  while (background.length) await Promise.allSettled(background.splice(0));
};

let workerModule;
async function worker() {
  workerModule ??= (await import(new URL(`../../dist/server/index.js?account-deletion=${RUN}`, import.meta.url).href)).default;
  return workerModule;
}

/** A request to the built Worker, carrying and collecting cookies like a browser would. */
async function call(pathname, { method = "GET", body, jar, headers: extra = {} } = {}) {
  const headers = { accept: method === "GET" ? "text/html" : "application/json", ...extra };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (jar?.size) headers.cookie = [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  const { fetch } = await worker();
  const response = await fetch(
    new Request(`http://localhost${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual" }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil(promise) { background.push(promise); }, passThroughOnException() {} },
  );
  if (jar) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";").map((part) => part.trim());
      const name = pair.slice(0, pair.indexOf("="));
      const value = pair.slice(pair.indexOf("=") + 1);
      if (attributes.some((attribute) => /^max-age=0$/i.test(attribute)) || value === "") jar.delete(name);
      else jar.set(name, value);
    }
  }
  return response;
}

async function signIn(email) {
  const jar = new Map();
  const response = await call("/api/auth/sign-in", { method: "POST", body: { email, password }, jar });
  return { response, jar };
}

/* ------------------------------------------------------------------ the catalog */

const SYSTEM_SCHEMA = "n.nspname !~ '^pg_' and n.nspname <> 'information_schema'";
const USER_COLUMN_NAME = "^(user_id|owner|owner_id|initiated_by|actor_id|profile_id|account_id|created_by|updated_by|deleted_by|requested_by)$";

/**
 * Columns whose name looks like a user reference but that never hold a 1stSeen account id, each with the reason. Kept
 * short on purpose: an entry here is a claim that no product path writes an account id into the column.
 */
const NOT_ACCOUNT_REFERENCES = {
  // The operator who applied a takedown, typed with `--by` or FIRSTSEEN_REVIEWER (docs/takedown.md), and the record of a
  // company's request, which must outlive any account.
  "public.collection_takedowns.requested_by": "the operator name given to firstseen sources/withdraw-company --by",
};

/** Every column that can hold a user id, read from the catalog. */
async function userColumns(sql) {
  const foreignKeys = await sql.query(
    `select n.nspname as schema, c.relname as "table", a.attname as "column", con.confdeltype as on_delete,
            con.confrelid::regclass::text as refers_to
       from pg_constraint con
       join pg_class c on c.oid = con.conrelid
       join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attnum = con.conkey[1]
      where con.contype = 'f' and cardinality(con.conkey) = 1
        and con.confrelid in ('auth.users'::regclass, 'public.profiles'::regclass)`,
  );
  const named = await sql.query(
    `select n.nspname as schema, c.relname as "table", a.attname as "column"
       from pg_attribute a
       join pg_class c on c.oid = a.attrelid
       join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and not c.relispartition and a.attnum > 0 and not a.attisdropped and ${SYSTEM_SCHEMA}
        and a.atttypid in ('uuid'::regtype, 'text'::regtype, 'varchar'::regtype)
        and a.attname ~ $1`,
    [USER_COLUMN_NAME],
  );
  const columns = new Map();
  for (const row of foreignKeys.rows) columns.set(`${row.schema}.${row.table}.${row.column}`, { ...row, foreignKey: true });
  for (const row of named.rows) {
    const key = `${row.schema}.${row.table}.${row.column}`;
    if (key in NOT_ACCOUNT_REFERENCES) continue;
    if (!columns.has(key)) columns.set(key, { ...row, foreignKey: false, on_delete: null, refers_to: null });
  }
  return [...columns.values()];
}

/** Public tables whose rows are deleted with a covered public table's rows: ON DELETE CASCADE, followed transitively. */
async function cascadeChildren(sql, parents) {
  const { rows } = await sql.query(
    `select c.relname as child, p.relname as parent
       from pg_constraint con
       join pg_class c on c.oid = con.conrelid join pg_namespace cn on cn.oid = c.relnamespace
       join pg_class p on p.oid = con.confrelid join pg_namespace pn on pn.oid = p.relnamespace
      where con.contype = 'f' and con.confdeltype = 'c' and cn.nspname = 'public' and pn.nspname = 'public'`,
  );
  const owned = new Set(parents);
  for (let grew = true; grew;) {
    grew = false;
    for (const { child, parent } of rows) {
      if (owned.has(parent) && !owned.has(child)) {
        owned.add(child);
        grew = true;
      }
    }
  }
  return owned;
}

/** Every base table outside the system schemas, scanned whole as text for any of the needles. */
async function rowsMentioning(sql, needles) {
  const { rows: tables } = await sql.query(
    `select format('%I.%I', n.nspname, c.relname) as name, n.nspname as schema
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and not c.relispartition and ${SYSTEM_SCHEMA}
      order by 1`,
  );
  const found = [];
  const unreadable = [];
  for (const { name, schema } of tables) {
    try {
      const { rows } = await sql.query(
        `select count(*)::int as n from ${name} as r where ${needles.map((_, index) => `strpos(r::text, $${index + 1}) > 0`).join(" or ")}`,
        needles,
      );
      if (rows[0].n > 0) found.push(`${name}: ${rows[0].n}`);
    } catch (error) {
      unreadable.push({ name, schema, reason: error.code ?? error.message });
    }
  }
  return { found, unreadable, scanned: tables.length };
}

/* ------------------------------------------------------------------ seeding */

const sha = (value) => createHash("sha256").update(value).digest("hex");

async function seedAccount(sql, userId, email, reference, { full }) {
  const seeded = {};
  const note = (table, id) => (seeded[table] ??= []).push(id);
  const one = async (text, values) => (await sql.query(text, values)).rows[0];

  await sql.query("update public.profiles set display_name = $2 where id = $1", [userId, `Synthetic ${RUN}`]);
  note("profiles", userId);
  await sql.query(
    "insert into public.recruiting_preferences (user_id, graduation_year, target_disciplines, onboarding_completed_at) values ($1, 2028, '{software_engineering}', now())",
    [userId],
  );
  note("recruiting_preferences", userId);
  note("watchlist_items", (await one("insert into public.watchlist_items (user_id, target_type, canonical_role_id) values ($1, 'canonical_role', $2) returning id", [userId, reference.roleId])).id);
  const run = await one(
    "insert into public.agent_runs (initiated_by, agent_name, purpose, status, input_fingerprint, metadata) values ($1, 'recruiting_agent', 'Answer a recruiting intelligence question from stored evidence', 'succeeded', $2, $3) returning id",
    [userId, sha(`question-${userId}`), { state_version: "recruiting-agent-state-v1", state: { goal: `When does the synthetic program open? ${RUN}`, actor_id: userId, audience: "member" }, contains_private_chain_of_thought: false }],
  );
  note("agent_runs", run.id);
  if (!full) return { seeded };

  note("watchlists", reference.roleId);
  await sql.query("insert into public.watchlists (user_id, canonical_role_id) values ($1, $2)", [userId, reference.roleId]);
  note("priority_companies", reference.companyId);
  await sql.query("insert into public.priority_companies (user_id, company_id, priority) values ($1, $2, 2)", [userId, reference.companyId]);
  const milestone = await one(
    `insert into public.readiness_milestones (user_id, canonical_role_id, forecast_id, kind, due_on, ideal_due_on, lead_days, policy_version, rationale, adjustments, window_start, window_end)
     values ($1, $2, $3, 'networking', '2027-01-04', '2027-01-04', 60, 'synthetic-account-deletion-test', 'Synthetic milestone for the account deletion test.', '[]', '2027-03-01', '2027-04-01') returning id`,
    [userId, reference.roleId, reference.forecastId],
  );
  note("readiness_milestones", milestone.id);
  note("calendar_event_syncs", (await one(
    `insert into public.calendar_event_syncs (user_id, source_kind, source_key, canonical_role_id, readiness_milestone_id, google_calendar_id, google_event_id, event_fingerprint, status)
     values ($1, 'readiness_milestone', $2, $3, $4, 'primary', $5, $6, 'active') returning id`,
    [userId, `synthetic:${RUN}:networking`, reference.roleId, milestone.id, `syntheticevent${RUN}`, sha(`event-${RUN}`)],
  )).id);

  const tokens = {
    calendar: { access: `synthetic-calendar-access-${RUN}`, refresh: `synthetic-calendar-refresh-${RUN}` },
    gmail: { access: `synthetic-gmail-access-${RUN}`, refresh: `synthetic-gmail-refresh-${RUN}` },
  };
  const calendarKey = await importTokenKey(INTEGRATION_ENV.GOOGLE_CALENDAR_TOKEN_ENCRYPTION_KEY, "invalid_key");
  const gmailKey = await importTokenKey(INTEGRATION_ENV.EMAIL_TOKEN_ENCRYPTION_KEY, "invalid_key");
  const sealed = {
    calendarAccess: await sealToken(calendarKey, "google-calendar", userId, tokens.calendar.access),
    calendarRefresh: await sealToken(calendarKey, "google-calendar", userId, tokens.calendar.refresh),
    gmailAccess: await sealToken(gmailKey, "gmail", userId, tokens.gmail.access),
    gmailRefresh: await sealToken(gmailKey, "gmail", userId, tokens.gmail.refresh),
  };
  await sql.query(
    `insert into public.google_calendar_connections (user_id, google_account_label, access_token_ciphertext, refresh_token_ciphertext, token_expires_at, scopes)
     values ($1, $2, $3, $4, now() + interval '1 hour', '{https://www.googleapis.com/auth/calendar.events}')`,
    [userId, `calendar-${RUN}@firstseen-test.invalid`, sealed.calendarAccess, sealed.calendarRefresh],
  );
  note("google_calendar_connections", userId);
  await sql.query(
    `insert into public.gmail_connections (user_id, google_account_email, access_token_ciphertext, refresh_token_ciphertext, token_expires_at, scopes)
     values ($1, $2, $3, $4, now() + interval '1 hour', '{https://www.googleapis.com/auth/gmail.send}')`,
    [userId, `gmail-${RUN}@firstseen-test.invalid`, sealed.gmailAccess, sealed.gmailRefresh],
  );
  note("gmail_connections", userId);

  const delivery = await one(
    `insert into public.email_digest_deliveries (user_id, digest_version, period_start, period_end, as_of, input_fingerprint, recipient_email, subject, structured_payload, rendered_html, status, failure_code)
     values ($1, 'synthetic-digest', '2027-01-01', '2027-01-07', '2027-01-02', $2, $3, 'Synthetic digest', '{"items": 1}', '<p>Synthetic digest</p>', 'failed', 'synthetic') returning id`,
    [userId, sha(`digest-${RUN}`), email],
  );
  note("email_digest_deliveries", delivery.id);
  // Points at the user's own milestone, whose foreign key is ON DELETE RESTRICT: the order delete_account_data needs.
  note("email_digest_items", (await one(
    `insert into public.email_digest_items (delivery_id, item_key, kind, canonical_role_id, readiness_milestone_id, event_on, payload)
     values ($1, 'networking', 'networking_deadline', $2, $3, '2027-01-04', '{"label": "Start networking"}') returning id`,
    [delivery.id, reference.roleId, milestone.id],
  )).id);

  // A run from before initiated_by was recorded: the user is only the actor in its stored state.
  note("agent_runs", (await one(
    "insert into public.agent_runs (agent_name, purpose, status, input_fingerprint, metadata) values ('recruiting_agent', 'Answer a recruiting intelligence question from stored evidence', 'succeeded', $1, $2) returning id",
    [sha(`legacy-${userId}`), { state: { goal: "An older question", actor_id: userId } }],
  )).id);
  const toolCall = await one(
    "insert into public.agent_tool_calls (agent_run_id, tool_name, status, input_redacted, output_redacted, finished_at) values ($1, 'recruiting_agent.generate_forecast', 'succeeded', $2, '{\"summary\": \"synthetic\"}', now()) returning id",
    [run.id, { actor_id: userId, role_id: reference.roleId }],
  );
  note("agent_tool_calls", toolCall.id);
  note("model_usage", (await one(
    "insert into public.model_usage (agent_run_id, tool_call_id, provider, model, prompt_tokens, completion_tokens, latency_ms, capability, success) values ($1, $2, 'synthetic', 'synthetic-model', 10, 5, 12, 'reason', true) returning id",
    [run.id, toolCall.id],
  )).id);

  // PKCE state Supabase Auth keeps with a user id and no foreign key.
  await sql.query(
    "insert into auth.flow_state (id, user_id, auth_code, code_challenge_method, code_challenge, provider_type, authentication_method, created_at, updated_at) values ($1, $2, $3, 's256', $4, 'email', 'email/signup', now(), now())",
    [randomUUID(), userId, randomUUID(), sha(`challenge-${RUN}`)],
  );
  note("auth.flow_state", userId);
  return { seeded, tokens, sealed };
}

/** Rows still present for each seeded public table, looked up by the ids the seeding noted. */
async function seededRowsLeft(sql, seeded) {
  const keys = {
    profiles: "id", recruiting_preferences: "user_id", watchlists: "user_id", priority_companies: "user_id",
    google_calendar_connections: "user_id", gmail_connections: "user_id",
  };
  const left = {};
  for (const [table, ids] of Object.entries(seeded)) {
    if (table.includes(".")) continue;
    const column = keys[table] ?? "id";
    const values = column === "user_id" ? [seeded.profiles[0]] : ids;
    const { rows } = await sql.query(`select count(*)::int as n from public.${table} where ${column} = any($1::uuid[])`, [values]);
    left[table] = rows[0].n;
  }
  return left;
}

/* ------------------------------------------------------------------ the test */

test("account export and deletion against the local rig", async (t) => {
  for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_DB_URL"]) {
    assert.ok(process.env[name], `${name} is not set. Start the local rig first: scripts/local-rig.sh up`);
  }
  const sql = await sqlClient();
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const created = [];
  const { rows: before } = await sql.query("select id from public.account_deletions");
  const existingRecords = before.map((row) => row.id);

  try {
    const migrated = await sql.query("select to_regprocedure('public.delete_account_data(uuid)') is not null as ok");
    assert.ok(migrated.rows[0].ok, "migration 202608140037 is not applied: npx supabase@2.117.0 migration up --local");

    const reference = (await sql.query(
      `select f.id as "forecastId", f.canonical_role_id as "roleId", r.company_id as "companyId"
         from public.forecasts f join public.canonical_roles r on r.id = f.canonical_role_id
        where r.scope_status = 'in_scope' order by f.forecasted_at desc limit 1`,
    )).rows[0];
    assert.ok(reference, "the rig has a stored forecast to point a milestone at");

    for (const label of ["deleted", "bystander", "unanswered"]) {
      const result = await admin.auth.admin.createUser({ email: address(label), password, email_confirm: true });
      assert.ifError(result.error);
      created.push(result.data.user.id);
    }
    const [userId, bystanderId, unansweredId] = created;
    const email = address("deleted");

    const signedIn = await signIn(email);
    assert.equal(signedIn.response.status, 200, "the synthetic account signs in");
    const jar = signedIn.jar;
    const { seeded, tokens, sealed } = await seedAccount(sql, userId, email, reference, { full: true });
    const bystander = (await seedAccount(sql, bystanderId, address("bystander"), reference, { full: false })).seeded;

    await t.test("every column that can hold a user id, and every table its rows take with them, has a row for the account", async () => {
      const columns = await userColumns(sql);
      assert.ok(columns.length >= 20, `found ${columns.length} user columns`);
      const missing = [];
      const publicTables = new Set();
      for (const column of columns) {
        const where = `${column.schema}.${column.table}.${column.column}`;
        if (column.schema === "public") publicTables.add(column.table);
        const { rows } = await sql.query(`select count(*)::int as n from ${column.schema}.${column.table} where ${column.column}::text = $1`, [userId]);
        if (rows[0].n > 0) continue;
        // Supabase Auth's own tables that its users table cascades into are covered by that cascade.
        if (column.schema === "auth" && column.foreignKey && column.on_delete === "c" && column.refers_to === "auth.users") continue;
        missing.push(where);
      }
      assert.deepEqual(missing, [], "columns that can hold a user id with no row for the test account: seed them here, delete them in delete_account_data, and export them");

      const owned = await cascadeChildren(sql, publicTables);
      const unseeded = [...owned].filter((table) => !seeded[table]?.length).sort();
      assert.deepEqual(unseeded, [], "public tables owned through a cascade with no seeded row");
      t.diagnostic(`${columns.length} user columns; ${owned.size} public tables owned: ${[...owned].sort().join(", ")}`);
    });

    await t.test("the export holds every owned table, for this account only, and no credential", async () => {
      const response = await call(`/api/account/export?user_id=${bystanderId}`, { jar, headers: { "sec-fetch-site": "same-origin" } });
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-disposition") ?? "", /^attachment; filename="1stseen-account-\d{4}-\d{2}-\d{2}\.json"$/);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const text = await response.text();
      const exported = JSON.parse(text);
      assert.equal(exported.format, "1stseen-account-export");
      assert.equal(exported.account.id, userId, "the owner is the session's, whatever the query says");
      assert.equal(exported.account.email, email);

      const columns = await userColumns(sql);
      const owned = await cascadeChildren(sql, new Set(columns.filter((column) => column.schema === "public").map((column) => column.table)));
      for (const table of owned) assert.ok(exported.tables[table]?.length >= 1, `the export has no ${table} rows`);
      assert.equal(exported.tables.agent_runs.length, 2, "both of the account's questions, the one with only an actor too");
      assert.ok(exported.tables.agent_runs.some((run) => run.question?.includes(RUN)), "the question text is exported");
      assert.deepEqual(exported.tables.google_calendar_connections.map((row) => [row.connected, row.google_account_label]), [[true, `calendar-${RUN}@firstseen-test.invalid`]]);
      assert.deepEqual(exported.tables.gmail_connections.map((row) => [row.connected, row.google_account_email]), [[true, `gmail-${RUN}@firstseen-test.invalid`]]);
      assert.ok(exported.referenced_roles.some((role) => role.id === reference.roleId && role.title && role.company), "followed roles are named");

      for (const secret of [...Object.values(tokens.calendar), ...Object.values(tokens.gmail), ...Object.values(sealed)]) {
        assert.ok(!text.includes(secret), "a token or its ciphertext is in the export");
      }
      assert.doesNotMatch(text, /ciphertext|token_expires_at|"access_token"|"refresh_token"/);
      assert.ok(!text.includes(bystanderId), "another account's id is in the export");
      for (const id of bystander.watchlist_items) assert.ok(!text.includes(id), "another account's follow is in the export");
    });

    await t.test("settings offers the download, and the deletion dialog states the Google revocation and the events choice", async () => {
      const response = await call("/settings", { jar });
      assert.equal(response.status, 200);
      const html = (await response.text()).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
      assert.match(html, /<h2 id="data-title"[^>]*>Your data<\/h2>/);
      assert.match(html, /<a href="\/api\/account\/export" download=""/);
      assert.match(html, /asks Google to revoke 1stSeen's access to your Google account\. Your data is deleted whatever Google answers/);
      assert.match(html, /The event 1stSeen added to your Google Calendar/);
      assert.match(html, /Keep them in my calendar/);
      const keep = html.match(/<input(?=[^>]*type="radio")(?=[^>]*value="keep")[^>]*>/)?.[0] ?? "";
      assert.match(keep, /\bchecked=""/, `keeping the events is the default: ${keep}`);
      assert.match(html, /Type <span[^>]*>delete my account<\/span> to confirm/);
    });

    await t.test("a refused request deletes nothing", async () => {
      const refusals = [
        [{ confirmation: "delete my acount" }, {}, 400, "confirmation_mismatch"],
        [{ confirmation: "delete my account", user_id: bystanderId }, {}, 400, "invalid_request"],
        [{ confirmation: "delete my account" }, { origin: "https://attacker.example" }, 403, "cross_origin"],
      ];
      for (const [body, headers, status, error] of refusals) {
        const response = await call("/api/auth/delete-account", { method: "POST", body, jar, headers });
        assert.equal(response.status, status, JSON.stringify(body));
        assert.deepEqual(await response.json(), { error });
      }
      assert.equal(revokeCalls().length, 0, "nothing was revoked");
      const left = await seededRowsLeft(sql, seeded);
      for (const [table, n] of Object.entries(left)) assert.ok(n >= 1, `${table} lost its rows`);
      assert.ok((await admin.auth.admin.getUserById(userId)).data.user, "the account still exists");
    });

    await t.test("when Google does not answer, the account is deleted anyway, the user is told to revoke and to check their calendar, and Google is asked again", async () => {
      const unansweredEmail = address("unanswered");
      const unanswered = await signIn(unansweredEmail);
      assert.equal(unanswered.response.status, 200);
      const own = await seedAccount(sql, unansweredId, unansweredEmail, reference, { full: true });
      google.mode = "unreachable";
      google.calls.length = 0;

      const response = await call("/api/auth/delete-account", { method: "POST", body: { confirmation: "delete my account", remove_synced_events: true }, jar: unanswered.jar });
      assert.equal(response.status, 200, "Google's silence does not stop a deletion");
      assert.deepEqual(await response.json(), {
        status: "deleted",
        redirect: "/account/deleted?google=not_revoked&events=not_removed",
        google_revocation: "not_confirmed",
      });
      assert.equal(unanswered.jar.size, 0, "every session cookie was cleared");
      assert.equal(revokeCalls().length, 2, "each connection was asked once before the rows were deleted");
      assert.equal((await admin.auth.admin.getUserById(unansweredId)).data.user, null, "the auth user is gone");
      assert.deepEqual(Object.entries(await seededRowsLeft(sql, own.seeded)).filter(([, n]) => n > 0), [], "seeded rows remain");
      for (const column of await userColumns(sql)) {
        const { rows } = await sql.query(`select count(*)::int as n from ${column.schema}.${column.table} where ${column.column}::text = $1`, [unansweredId]);
        assert.equal(rows[0].n, 0, `${column.schema}.${column.table}.${column.column} still holds the account`);
      }
      const recorded = async () => (await sql.query(
        "select google_calendar_revocation, gmail_revocation, synced_calendar_events from public.account_deletions where not (id = any($1::uuid[])) order by deleted_on",
        [existingRecords],
      )).rows;
      assert.deepEqual(await recorded(), [{ google_calendar_revocation: "unconfirmed", gmail_revocation: "unconfirmed", synced_calendar_events: "not_removed" }]);

      const page = await call("/account/deleted?google=not_revoked&events=not_removed");
      const html = (await page.text()).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
      assert.match(html, /Remove 1stSeen's access in your Google Account\./);
      assert.match(html, /Google Calendar did not let 1stSeen remove every event it added/);
      assert.match(html, /<a href="https:\/\/myaccount\.google\.com\/connections"[^>]*>\s*myaccount\.google\.com\/connections\s*<\/a>/);

      // Google answers again: the retry after the response revokes both grants and the anonymous record says so.
      google.mode = "answer";
      await settleBackground();
      const retried = revokeCalls().slice(2);
      assert.deepEqual(
        retried.map((call) => new URLSearchParams(call.body).get("token")).sort(),
        [own.tokens.calendar.refresh, own.tokens.gmail.refresh].sort(),
        "each unconfirmed token was offered to Google again",
      );
      assert.deepEqual(await recorded(), [{ google_calendar_revocation: "revoked", gmail_revocation: "revoked", synced_calendar_events: "not_removed" }]);
      const tokenScan = await rowsMentioning(sql, [...Object.values(own.tokens.calendar), ...Object.values(own.tokens.gmail)]);
      assert.deepEqual(tokenScan.found, [], "a token the retry held was written somewhere");
      await sql.query("delete from public.account_deletions where not (id = any($1::uuid[]))", [existingRecords]);
    });

    await t.test("a confirmed deletion revokes once per connection, removes synced events, and leaves no row anywhere", async () => {
      google.mode = "answer";
      google.calls.length = 0;
      const response = await call("/api/auth/delete-account", { method: "POST", body: { confirmation: "  Delete My Account ", remove_synced_events: true }, jar });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "deleted", redirect: "/account/deleted" });
      assert.equal(jar.size, 0, "every session cookie was cleared");

      const revoked = revokeCalls();
      assert.equal(revoked.length, 2, "one revocation per connection");
      assert.deepEqual(revoked.map((call) => new URLSearchParams(call.body).get("token")).sort(), [tokens.calendar.refresh, tokens.gmail.refresh].sort());
      const removedEvents = google.calls.filter((call) => call.method === "DELETE" && call.url.startsWith("https://www.googleapis.com/calendar/v3/"));
      assert.equal(removedEvents.length, 1, "the synced event was removed from Google Calendar");
      assert.ok(removedEvents[0].url.endsWith(`/events/syntheticevent${RUN}`));

      const lookup = await admin.auth.admin.getUserById(userId);
      assert.equal(lookup.data.user, null, "the auth user is gone");
      const left = await seededRowsLeft(sql, seeded);
      assert.deepEqual(Object.entries(left).filter(([, n]) => n > 0), [], "seeded rows remain");

      for (const column of await userColumns(sql)) {
        const { rows } = await sql.query(`select count(*)::int as n from ${column.schema}.${column.table} where ${column.column}::text = $1`, [userId]);
        assert.equal(rows[0].n, 0, `${column.schema}.${column.table}.${column.column} still holds the account`);
      }

      const signInAgain = await signIn(email);
      assert.equal(signInAgain.response.status, 400, "signing in no longer works");
      assert.deepEqual(await signInAgain.response.json(), { error: "invalid_credentials" });

      const scan = await rowsMentioning(sql, [userId, email]);
      assert.deepEqual(scan.found, [], "rows that still mention the account's id or email");
      const unreadableUserData = scan.unreadable.filter((table) => ["public", "auth", "storage"].includes(table.schema));
      assert.deepEqual(unreadableUserData, [], "tables that could not be scanned");
      t.diagnostic(`scanned ${scan.scanned} tables as text; ${scan.unreadable.length} unreadable outside public/auth/storage: ${scan.unreadable.map((table) => `${table.name} (${table.reason})`).join(", ") || "none"}`);

      const records = await sql.query("select * from public.account_deletions where not (id = any($1::uuid[]))", [existingRecords]);
      assert.equal(records.rows.length, 1, "one anonymous record of the deletion");
      const record = records.rows[0];
      assert.equal(record.google_calendar_revocation, "revoked");
      assert.equal(record.gmail_revocation, "revoked");
      assert.equal(record.synced_calendar_events, "removed");
      for (const table of ["watchlist_items", "readiness_milestones", "email_digest_items", "agent_runs", "agent_tool_calls", "model_usage"]) {
        assert.ok(record.rows_deleted[table] >= 1, `the record counts ${table}`);
      }
      assert.equal(record.rows_deleted.agent_runs, 2);
    });

    await t.test("the old session is refused and the landing page says the account is gone", async () => {
      const stale = new Map([["sb-127-auth-token", "stale"]]);
      assert.equal((await call("/api/account/export", { jar: stale })).status, 401);
      const page = await call("/account/deleted?events=kept");
      assert.equal(page.status, 200);
      const html = (await page.text()).replace(/<!-- -->/g, "").replace(/&#x27;/g, "'");
      assert.match(html, /Your account has been deleted/);
      assert.match(html, /Events 1stSeen added to your Google Calendar are still there/);
      assert.doesNotMatch(html, /Google did not confirm/);
    });

    await t.test("the other account is untouched", async () => {
      const left = await seededRowsLeft(sql, bystander);
      for (const [table, n] of Object.entries(left)) assert.ok(n >= 1, `the bystander lost its ${table} rows`);
      assert.ok((await admin.auth.admin.getUserById(bystanderId)).data.user, "the bystander still exists");
      const runs = await sql.query("select count(*)::int as n from public.account_agent_run_ids($1)", [bystanderId]);
      assert.equal(runs.rows[0].n, 1);
    });
  } finally {
    // The product's own path, so nothing of either account survives even when an assertion above failed.
    for (const id of created) {
      await sql.query("select public.delete_account_data($1)", [id]).catch(() => undefined);
      await admin.auth.admin.deleteUser(id).catch(() => undefined);
      await sql.query("select public.finish_account_deletion($1, '{}'::jsonb, 'not_connected', 'not_connected', 'none')", [id]).catch(() => undefined);
    }
    await sql.query("delete from public.account_deletions where not (id = any($1::uuid[]))", [existingRecords]);
    if (created.length) {
      const leftovers = await rowsMentioning(sql, created);
      assert.deepEqual(leftovers.found, [], "the test left rows behind");
    }
    await sql.end();
    globalThis.fetch = realFetch;
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
