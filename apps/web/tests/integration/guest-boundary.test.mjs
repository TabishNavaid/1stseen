/**
 * Integration test: guest mode's boundary against the local rig, through the built Worker.
 *
 * Needs: `scripts/local-rig.sh up` and `npm run build`. Runs in `npm run test:integration`, not the gate.
 *
 * Every Supabase request the Worker makes is recorded. Then every page and every API route (found on disk, so a new
 * route is covered without editing this file) is requested with no session.
 *
 * What it proves:
 *   - a guest request reads only allowlisted relations and columns, calls only public functions, and never passes a
 *     user argument; no user-owned or service-only relation is touched, including through the agent and replay routes
 *   - a guest agent question reaches the agent service as a guest with no user identity; a guest replay is refused
 *   - anon holds no privilege on any public table, sequence, or read-path function, and the anon key cannot read any
 *     relation or call any read-path function through PostgREST. These fail the moment anon is granted a privilege.
 *   - a statement on a table guest pages read advances the public data version, even when rolled back; a statement on
 *     the agent audit tables does not
 *   - public_agent_activity never returns a run a user started or one whose stored state names an actor
 *
 * The runs and the account it creates are its own, and it deletes them.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import "../support/retain-request-clones.mjs";

import { loadDotEnv, sqlClient } from "../../../../scripts/lib/db.mjs";
import { NEVER_PUBLIC_RELATIONS, PUBLIC_FUNCTIONS, PUBLIC_TABLE_COLUMNS, assertPublicSelect } from "../../lib/public-read-policy.ts";

loadDotEnv();
const require = createRequire(new URL("../../package.json", import.meta.url));
const { createClient } = require("@supabase/supabase-js");

const RUN = randomUUID().slice(0, 8);
const API_ROOT = fileURLToPath(new URL("../../app/api", import.meta.url));
const READ_PATH_FUNCTIONS = [...PUBLIC_FUNCTIONS, "public_data_version", "followed_role_ids", "onboarding_seed_roles", "dashboard_role_facts", "dashboard_filtered_roles", "forecast_role_states"];
const ALLOW = { limit: async () => ({ success: true }) };

const supabaseOrigin = () => new URL(process.env.SUPABASE_URL).origin;
const recorded = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input.clone() : new Request(input, init);
  const url = new URL(request.url);
  if (url.origin === supabaseOrigin()) {
    const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    recorded.push({ method: request.method, path: url.pathname, select: url.searchParams.get("select"), body });
  }
  return realFetch(input, init);
};

let workerModule;
async function guest(pathname, { method = "GET", body, headers = {}, bindings = {} } = {}) {
  workerModule ??= (await import(new URL(`../../dist/server/index.js?guest=${RUN}`, import.meta.url).href)).default;
  const from = recorded.length;
  const response = await workerModule.fetch(
    new Request(`http://localhost${pathname}`, {
      method,
      headers: { accept: method === "GET" ? "text/html" : "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, ...bindings },
    { waitUntil() {}, passThroughOnException() {} },
  );
  const text = await response.text();
  return { response, text, calls: recorded.slice(from) };
}

/** The route path of every app/api route file, with dynamic segments filled in. */
function apiRoutes(directory = API_ROOT) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return apiRoutes(path);
    return name === "route.ts" ? [`/api/${relative(API_ROOT, directory)}`.replace(/\\/g, "/")] : [];
  });
}

function assertGuestCall(call, label) {
  const where = `${label}: ${call.method} ${call.path}`;
  assert.doesNotMatch(call.path, /^\/auth\/v1\/admin/, `${where} used the auth admin API`);
  if (call.path.startsWith("/auth/v1/")) return;
  const rpc = call.path.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/);
  if (rpc) {
    assert.ok(PUBLIC_FUNCTIONS.includes(rpc[1]), `${where} called a function that is not public`);
    const args = call.body ? JSON.parse(call.body) : {};
    for (const [name, value] of Object.entries(args)) {
      if (/user/i.test(name)) assert.equal(value, null, `${where} passed ${name}`);
    }
    return;
  }
  const relation = call.path.match(/^\/rest\/v1\/([a-z_]+)$/)?.[1];
  assert.ok(relation, `${where} is not a PostgREST relation or function`);
  assert.ok(!NEVER_PUBLIC_RELATIONS.includes(relation), `${where} read a user-owned or service-only relation`);
  assert.ok(relation in PUBLIC_TABLE_COLUMNS, `${where} read a relation outside the allowlist`);
  // HEAD is a count with no rows (the dashboard's confirmed-openings total); both are reads.
  assert.ok(["GET", "HEAD"].includes(call.method), `${where} wrote`);
  assert.doesNotThrow(() => assertPublicSelect(relation, call.select ?? "*"), `${where} selected ${call.select}`);
}

test("guest mode's boundary against the local rig", async (t) => {
  for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_DB_URL"]) {
    assert.ok(process.env[name], `${name} is not set. Start the local rig first: scripts/local-rig.sh up`);
  }
  const sql = await sqlClient();
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const created = { users: [], runs: [] };

  try {
    const forecastable = (await sql.query("select role_id from public.dashboard_role_facts(now(), null) where forecastable order by confidence desc limit 1")).rows[0].role_id;
    const insufficient = (await sql.query("select role_id from public.dashboard_role_facts(now(), null) where not forecastable limit 1")).rows[0].role_id;

    await t.test("a guest page reads only allowlisted relations and columns, with no user", async () => {
      const pages = [
        "/", "/roles", "/roles?watched=1", "/roles?discipline=quantitative&sort=confidence&page=2", "/?discipline=data",
        `/roles/${forecastable}`, `/roles/${insufficient}`, "/replay", "/calendar", "/digests", "/settings", "/welcome",
        "/welcome?step=ready&for=internship&field=software_engineering&field=data&field=other_engineering", "/opened", "/opened?page=2", "/ask",
        "/signin", "/auth/forgot", "/design-system", "/methodology",
      ];
      let total = 0;
      for (const path of pages) {
        const { response, calls } = await guest(path);
        assert.ok(response.status < 500, `${path} answered ${response.status}`);
        for (const call of calls) assertGuestCall(call, path);
        total += calls.length;
      }
      const home = await guest("/");
      assert.match(home.text, /Know when internships open,/, "the landing page renders for a guest");
      assert.ok(home.calls.some((call) => call.path === "/rest/v1/rpc/dashboard_role_page"), "its preview and forecasts are read through the public reader");
      const roles = await guest("/roles");
      assert.ok(roles.calls.some((call) => call.path === "/rest/v1/rpc/dashboard_role_page"));
      assert.ok(roles.calls.some((call) => call.path === "/rest/v1/role_aliases"), "titles are read from the allowlisted aliases, for their accents and punctuation");
      const payoff = await guest("/welcome?step=ready&for=internship&field=software_engineering");
      assert.match(payoff.text, /Your top \d+ to watch|Nothing fits all of that yet/, "a guest reaches the first run's payoff without an account");
      t.diagnostic(`${pages.length} guest pages made ${total} Supabase requests, all inside the allowlist`);
    });

    await t.test("every API route, called with no session, reaches nothing user-owned", async () => {
      const agentCalls = [];
      const stub = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          agentCalls.push({ url: request.url, body });
          response.writeHead(200, { "content-type": "text/event-stream" }).end("event: run_started\ndata: {}\n\n");
        });
      });
      await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
      const saved = { url: process.env.FIRSTSEEN_AGENT_API_URL, token: process.env.AGENT_API_BEARER_TOKEN };
      process.env.FIRSTSEEN_AGENT_API_URL = `http://127.0.0.1:${stub.address().port}`;
      process.env.AGENT_API_BEARER_TOKEN = "synthetic-guest-boundary-token-0000000000";
      try {
        const routes = apiRoutes();
        assert.ok(routes.length >= 20, `found ${routes.length} API routes`);
        const bodies = {
          "/api/recruiting-agent": { question: "When does IMC open its trader internship?" },
          "/api/forecast-replay": { role_id: forecastable, target_year: 2025, forecast_cutoff: "2025-06-01" },
          "/api/readiness": { role_id: forecastable },
          "/api/onboarding": { action: "skip" },
          "/api/personalization": { action: "follow", target: { target_type: "canonical_role", canonical_role_id: forecastable } },
        };
        for (const route of routes) {
          for (const method of ["GET", "POST"]) {
            // Auth routes with an empty body are refused on the input; none sends mail or signs anyone in.
            const { response, text, calls } = await guest(route, { method, body: method === "POST" ? bodies[route] ?? {} : undefined, bindings: { GUEST_AGENT_ADDRESS_LIMIT: ALLOW, GUEST_AGENT_OVERALL_LIMIT: ALLOW } });
            assert.ok(response.status < 500 || response.status === 503, `${method} ${route} answered ${response.status}`);
            for (const call of calls) assertGuestCall(call, `${method} ${route}`);
            const userOnly = method === "POST"
              ? ["/api/readiness", "/api/onboarding", "/api/personalization", "/api/forecast-replay", "/api/digests/send", "/api/integrations/google-calendar/sync"]
              : ["/api/digests/preview"];
            if (userOnly.includes(route)) assert.equal(response.status, 401, `${method} ${route} lets a guest through`);
            // An integration status route may say the integration is not configured; it never describes an account to a guest.
            if (method === "GET" && ["/api/integrations/gmail", "/api/integrations/google-calendar"].includes(route) && response.status !== 401) {
              const status = JSON.parse(text);
              assert.equal(status.connected, false, route);
              assert.equal(status.account_email ?? status.account_label ?? null, null, route);
            }
          }
        }
        assert.equal(agentCalls.length, 1, "only the guest agent question reached the agent service");
        const sent = JSON.parse(agentCalls[0].body);
        assert.equal(agentCalls[0].url, "/v1/recruiting/query");
        assert.equal(sent.audience, "guest");
        assert.equal("user_id" in sent, false);
        t.diagnostic(`${routes.length} API routes called with GET and POST`);
      } finally {
        await new Promise((resolve) => stub.close(resolve));
        for (const [name, value] of [["FIRSTSEEN_AGENT_API_URL", saved.url], ["AGENT_API_BEARER_TOKEN", saved.token]]) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    });

    await t.test("anon holds no privilege, and the anon key reads nothing through PostgREST", async () => {
      const tableGrants = await sql.query("select table_name, privilege_type from information_schema.role_table_grants where grantee = 'anon' and table_schema = 'public' order by 1, 2");
      assert.deepEqual(tableGrants.rows, [], "anon has a table or view privilege");
      const sequenceGrants = await sql.query("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and case when c.relkind = 'S' then has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE') else false end");
      assert.deepEqual(sequenceGrants.rows, [], "anon has a sequence privilege");
      const functionGrants = await sql.query(
        "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any($1) and has_function_privilege('anon', p.oid, 'EXECUTE')",
        [READ_PATH_FUNCTIONS],
      );
      assert.deepEqual(functionGrants.rows, [], "anon can execute a read-path function");

      const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
      const headers = { apikey: anon, authorization: `Bearer ${anon}` };
      for (const relation of [...NEVER_PUBLIC_RELATIONS, ...Object.keys(PUBLIC_TABLE_COLUMNS)]) {
        const response = await realFetch(`${supabaseOrigin()}/rest/v1/${relation}?select=*&limit=1`, { headers });
        assert.notEqual(response.status, 200, `the anon key read ${relation}`);
        await response.arrayBuffer();
      }
      for (const fn of READ_PATH_FUNCTIONS) {
        const response = await realFetch(`${supabaseOrigin()}/rest/v1/rpc/${fn}`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{}" });
        assert.notEqual(response.status, 200, `the anon key called ${fn}`);
        await response.arrayBuffer();
      }
    });

    await t.test("a statement on a guest-read table advances the public data version; agent audit writes do not", async () => {
      const version = async () => Number((await sql.query("select public.public_data_version() as v")).rows[0].v);
      const before = await version();
      await sql.query("begin");
      await sql.query("update public.forecasts set confidence = confidence where false");
      await sql.query("rollback");
      const afterForecasts = await version();
      assert.ok(afterForecasts > before, `version ${before} -> ${afterForecasts}`);
      await sql.query("begin");
      await sql.query("update public.agent_runs set status = status where false");
      await sql.query("update public.agent_tool_calls set status = status where false");
      await sql.query("rollback");
      assert.equal(await version(), afterForecasts, "an agent audit write purged the guest cache");
    });

    await t.test("public_agent_activity never returns a run tied to a user", async () => {
      const account = await admin.auth.admin.createUser({ email: `guest-boundary-${RUN}@firstseen-test.invalid`, password: `Correct-horse-${RUN}`, email_confirm: true });
      assert.ifError(account.error);
      created.users.push(account.data.user.id);
      const userId = account.data.user.id;
      const insert = async (offsetHours, initiatedBy, metadata, status = "succeeded") => {
        const { rows } = await sql.query(
          `insert into public.agent_runs (agent_name, purpose, input_fingerprint, status, started_at, finished_at, initiated_by, metadata)
           values ('recruiting_agent', 'guest-boundary test run', encode(sha256(gen_random_uuid()::text::bytea), 'hex'), $1::public.run_status,
                   now() + make_interval(hours => $2), case when $1 = 'running' then null else now() + make_interval(hours => $2) end, $3, $4)
           returning id`,
          [status, offsetHours, initiatedBy, metadata],
        );
        created.runs.push(rows[0].id);
        return rows[0].id;
      };
      const latestPublic = async () => (await admin.rpc("public_agent_activity").maybeSingle()).data?.run_id ?? null;

      const clean = await insert(10, null, { state: { actor_id: null, audience: "guest" } });
      assert.equal(await latestPublic(), clean, "a guest run with no actor is public");
      await insert(20, userId, { state: { actor_id: null } });
      await insert(30, null, { state: { actor_id: userId } });
      await insert(40, null, {}, "running");
      assert.equal(await latestPublic(), clean, "a run started by a user, one naming an actor, or one with no stored state is never returned");
    });
  } finally {
    if (created.runs.length) await sql.query("delete from public.agent_runs where id = any($1)", [created.runs]);
    for (const id of created.users) await admin.auth.admin.deleteUser(id);
    await sql.end();
  }
});
