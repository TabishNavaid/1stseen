/**
 * Integration test: the first run against the local rig, through the built Worker.
 *
 * Needs: `scripts/local-rig.sh up` and `npm run build`. With `scripts/local-rig.sh agent` running, finishing the first
 * run must build a real readiness plan; without it, the test requires the honest outcome instead. Runs in
 * `npm run test:integration`, not the gate.
 *
 * Every account uses the reserved `.invalid` domain, is created here, and is deleted at the end; its preferences,
 * follows, and milestones go with it (on delete cascade), and the test checks that they did.
 *
 * What it proves:
 *   - signed out, the first run is open: the first question renders with "Skip, just browse", a link to the roles view,
 *     and the payoff counts and lists exactly what the roles view's own functions return for the answers; settings
 *     still sends the visitor to sign in, and /api/onboarding answers 401
 *   - every role the payoff lists fits the answers: the chosen field, the chosen program type, current forecasts first
 *   - finishing (what a guest's answers post after sign-up) saves the fields, follows exactly the chosen in-scope roles
 *     and the picked company for this user only (an out-of-scope id is ignored), lands on the first chosen role with a
 *     current forecast, and builds its plan when the planner runs
 *   - finishing twice does not duplicate a follow; a cross-origin or malformed request changes nothing
 *   - skipping is saved and stops the roles view offering the first run; one user's first run never touches another's
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import "../support/retain-request-clones.mjs";

import { loadDotEnv } from "../../../../scripts/lib/db.mjs";
import { PLAN_OUTCOME_MESSAGES, programTypesFor } from "../../lib/onboarding.ts";

loadDotEnv();
const require = createRequire(new URL("../../package.json", import.meta.url));
const { createClient } = require("@supabase/supabase-js");

const RUN = randomUUID().slice(0, 8);
const address = (label) => `onboarding-${label}-${RUN}@firstseen-test.invalid`;
const FIRST_RUN_OFFER = "Start with a watchlist that fits";

let workerModule;
async function worker() {
  workerModule ??= (await import(new URL(`../../dist/server/index.js?onboarding=${RUN}`, import.meta.url).href)).default;
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
    { waitUntil() {}, passThroughOnException() {} },
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

const decode = (html) => html.replace(/<!-- -->/g, "").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
/** The roles the payoff lists, in order: each row links to its role page. */
const payoffIdsIn = (html) => {
  const list = html.slice(html.indexOf("payoff-title"));
  return [...new Set([...list.matchAll(/href="\/roles\/([0-9a-f-]{36})"/g)].map((match) => match[1]))];
};

async function signIn(email, password) {
  const jar = new Map();
  const response = await call("/api/auth/sign-in", { method: "POST", body: { email, password }, jar });
  assert.equal(response.status, 200, `sign-in for ${email}`);
  return jar;
}

test("the first run against the local rig", async (t) => {
  for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) {
    assert.ok(process.env[name], `${name} is not set. Start the local rig first: scripts/local-rig.sh up`);
  }
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  /*
   * There are three states, not two, and the first run reports a different honest outcome in each: the planner
   * answers and a plan is built, the planner is configured and cannot be reached, or no planner is configured at all.
   * Treating the last two as one is what made this test red on every machine that has not set FIRSTSEEN_AGENT_API_URL,
   * which is every machine running the local rig. It is not skipped: the outcome it asserts is simply the one that
   * belongs to the state it is in.
   */
  // The same two variables lib/readiness-plan.ts calls "configured": a URL with no token is not a planner.
  const plannerConfigured = Boolean(process.env.FIRSTSEEN_AGENT_API_URL && process.env.AGENT_API_BEARER_TOKEN);
  const plannerUp = plannerConfigured
    && await fetch(new URL("/health", process.env.FIRSTSEEN_AGENT_API_URL)).then((r) => r.ok).catch(() => false);
  const expectedPlan = plannerUp ? "ready" : plannerConfigured ? "unreachable" : "not_configured";
  t.diagnostic(`readiness planner ${plannerUp ? "is running" : plannerConfigured ? "is configured but unreachable" : "is not configured (FIRSTSEEN_AGENT_API_URL and AGENT_API_BEARER_TOKEN)"}: the first run must report "${expectedPlan}"`);

  const password = `Correct-horse-${RUN}`;
  const created = [];

  try {
    for (const label of ["finisher", "skipper"]) {
      const result = await admin.auth.admin.createUser({ email: address(label), password, email_confirm: true });
      assert.ifError(result.error);
      created.push(result.data.user.id);
    }
    const [finisherId, skipperId] = created;

    await t.test("signed out, the first run is open and skippable, and settings still asks for an account", async () => {
      const response = await call("/welcome");
      assert.equal(response.status, 200, "a guest is not sent to sign in");
      const html = decode(await response.text());
      const visible = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
      assert.match(visible, /What are you looking for\?/);
      for (const label of ["Internship", "New grad", "Co-op", "Show me all three"]) assert.ok(visible.includes(label), label);
      assert.match(visible, /<a[^>]*href="\/roles"[^>]*>\s*Skip, just browse\s*<\/a>/, "the guest skip path is a plain link to the roles view");
      assert.equal(visible.match(/accuracy is not\s+yet validated/g)?.length, 1, "the footer's disclosure, and only that");

      const settings = await call("/settings");
      assert.ok(settings.status >= 300 && settings.status < 400, `/settings redirects (got ${settings.status})`);
      assert.match(settings.headers.get("location") ?? "", /\/signin\?return_to=%2Fsettings$/);
      const api = await call("/api/onboarding", { method: "POST", body: { action: "skip" } });
      assert.equal(api.status, 401);
    });

    const jar = await signIn(address("finisher"), password);
    const answers = { looking_for: "internship", fields: ["software_engineering"], companies: [] };
    let payoffIds = [];

    await t.test("the payoff lists what the roles view's functions return, and every role fits the answers", async () => {
      const response = await call("/welcome?step=ready&for=internship&field=software_engineering");
      assert.equal(response.status, 200);
      const html = decode(await response.text());
      payoffIds = payoffIdsIn(html);
      assert.ok(payoffIds.length >= 3, `at least three roles listed (got ${payoffIds.length})`);

      const now = new Date().toISOString();
      const filters = { p_query: null, p_disciplines: ["software_engineering"], p_companies: null, p_types: programTypesFor("internship"), p_seasons: null, p_years: null, p_window_days: null, p_confidence: null, p_min_cycles: null, p_precision: null, p_locations: null, p_listed_now: false, p_watched_only: false };
      const [summary, expected] = await Promise.all([
        admin.rpc("dashboard_role_summary", { p_now: now, p_user_id: null, ...filters, p_per_company: 2 }).single(),
        admin.rpc("dashboard_role_page", { p_now: now, p_user_id: null, ...filters, p_sort: "window", p_per_company: 2, p_limit: 6, p_offset: 0 }),
      ]);
      assert.ifError(summary.error);
      assert.ifError(expected.error);
      assert.match(html, new RegExp(`Your top ${payoffIds.length} to watch`), "the headline leads with the listed programs");
      assert.match(html, new RegExp(`${Number(summary.data.matching_roles).toLocaleString("en-US")} programs? match`), "the count is the roles view's own");
      assert.deepEqual(payoffIds, expected.data.map((row) => row.role_id), "the page lists the function's roles, in order");

      let seenWithoutForecast = false;
      for (const row of expected.data) {
        assert.equal(row.discipline, "software_engineering", row.canonical_title);
        assert.equal(row.program_type, "internship", row.canonical_title);
        if (!row.forecastable) seenWithoutForecast = true;
        else assert.equal(seenWithoutForecast, false, "roles with a forecast come first");
      }
      const scope = await admin.from("canonical_roles").select("scope_status").in("id", payoffIds);
      assert.ifError(scope.error);
      assert.ok(scope.data.every((row) => row.scope_status === "in_scope"), "every listed role is in scope");

      const offered = await call("/roles", { jar });
      assert.match(decode(await offered.text()), new RegExp(FIRST_RUN_OFFER), "a new account is offered the first run");
    });

    await t.test("a cross-origin or malformed request changes nothing", async () => {
      const roleIds = payoffIds.slice(0, 1);
      const crossOrigin = await call("/api/onboarding", { method: "POST", body: { action: "complete", answers, role_ids: roleIds }, jar, headers: { origin: "https://attacker.example" } });
      assert.equal(crossOrigin.status, 403);
      for (const body of [
        { action: "complete", answers, role_ids: ["not-a-uuid"] },
        { action: "complete", answers: { ...answers, user_id: skipperId }, role_ids: roleIds },
        { action: "complete", answers, role_ids: roleIds, user_id: skipperId },
        { action: "complete", answers: { ...answers, fields: ["astronaut"] }, role_ids: roleIds },
        { action: "complete", answers: { ...answers, looking_for: "ceo" }, role_ids: roleIds },
        { action: "complete", answers: { ...answers, companies: ["not-a-uuid"] }, role_ids: roleIds },
        { action: "complete", answers: { tracks: ["software"], graduation_year: 2028, season: "summer", places: [] }, role_ids: roleIds },
      ]) {
        const response = await call("/api/onboarding", { method: "POST", body, jar });
        assert.equal(response.status, 400, JSON.stringify(body));
      }
      const follows = await admin.from("watchlist_items").select("id").in("user_id", created);
      assert.ifError(follows.error);
      assert.equal(follows.data.length, 0);
      const preferences = await admin.from("recruiting_preferences").select("user_id").in("user_id", created);
      assert.ifError(preferences.error);
      assert.equal(preferences.data.length, 0);
    });

    await t.test("finishing follows the chosen roles and company, lands on the first forecast, and builds its plan", async () => {
      const outOfScope = await admin.from("canonical_roles").select("id").eq("scope_status", "out_of_scope").limit(1).single();
      assert.ifError(outOfScope.error);
      const chosen = payoffIds.slice(0, 3);
      const company = await admin.from("canonical_roles").select("company_id").eq("id", chosen[0]).single();
      assert.ifError(company.error);
      const withCompany = { ...answers, companies: [company.data.company_id] };
      const response = await call("/api/onboarding", { method: "POST", body: { action: "complete", answers: withCompany, role_ids: [...chosen, outOfScope.data.id] }, jar });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.status, "completed");
      assert.equal(result.watching, 3);
      assert.equal(result.plan, expectedPlan);
      assert.equal(result.redirect, `/roles/${chosen[0]}?welcome=${result.plan}`);

      const preferences = await admin.from("recruiting_preferences").select("*").eq("user_id", finisherId).single();
      assert.ifError(preferences.error);
      assert.deepEqual([...preferences.data.target_disciplines], ["software_engineering"]);
      assert.equal(preferences.data.graduation_year, null, "a question this first run does not ask is not written");
      assert.ok(preferences.data.onboarding_completed_at);
      assert.equal(preferences.data.onboarding_skipped_at, null);

      const follows = await admin.from("watchlist_items").select("user_id,target_type,canonical_role_id,company_id").in("user_id", created);
      assert.ifError(follows.error);
      assert.deepEqual(
        follows.data.map((row) => [row.user_id, row.target_type, row.canonical_role_id ?? row.company_id]).sort(),
        [...chosen.map((id) => [finisherId, "canonical_role", id]), [finisherId, "company", company.data.company_id]].sort(),
      );

      const milestones = await admin.from("readiness_milestones").select("canonical_role_id").eq("user_id", finisherId);
      assert.ifError(milestones.error);
      if (plannerUp) {
        assert.ok(milestones.data.length >= 4, `a plan was built (${milestones.data.length} milestones)`);
        assert.ok(milestones.data.every((row) => row.canonical_role_id === chosen[0]), "only for the landing role");
      } else {
        assert.equal(milestones.data.length, 0, "no plan is pretended");
      }

      const landing = await call(result.redirect, { jar });
      assert.equal(landing.status, 200);
      const html = decode(await landing.text());
      assert.ok(html.includes(PLAN_OUTCOME_MESSAGES[result.plan]), "the landing states what happened");
      // The policy version is shown in its own <span>, so the assertion is on the
      // words the reader sees rather than on one uninterrupted string of markup.
      if (plannerUp) assert.match(html, /Prep plan rules\s*(?:<[^>]+>\s*)*readiness-workback-v1/);

      const dashboard = decode(await (await call("/roles", { jar })).text());
      assert.doesNotMatch(dashboard, new RegExp(FIRST_RUN_OFFER), "a finished first run is not offered again");

      const again = await call("/api/onboarding", { method: "POST", body: { action: "complete", answers: withCompany, role_ids: chosen }, jar });
      assert.equal(again.status, 200);
      const followsAgain = await admin.from("watchlist_items").select("id").eq("user_id", finisherId);
      assert.ifError(followsAgain.error);
      assert.equal(followsAgain.data.length, 4, "finishing again does not duplicate a follow");

      const rerun = decode(await (await call("/welcome", { jar })).text());
      assert.match(rerun, /What are you looking for now\?/, "a finished first run can be run again");
    });

    await t.test("skipping is saved, stops the offer, and leaves another user's first run alone", async () => {
      const skipper = await signIn(address("skipper"), password);
      assert.match(decode(await (await call("/roles", { jar: skipper })).text()), new RegExp(FIRST_RUN_OFFER));
      const skipped = await call("/api/onboarding", { method: "POST", body: { action: "skip" }, jar: skipper });
      assert.equal(skipped.status, 200);
      assert.deepEqual(await skipped.json(), { status: "skipped", redirect: "/roles" });
      assert.doesNotMatch(decode(await (await call("/roles", { jar: skipper })).text()), new RegExp(FIRST_RUN_OFFER));

      const preferences = await admin.from("recruiting_preferences").select("user_id,onboarding_skipped_at,onboarding_completed_at,target_disciplines").in("user_id", created).order("user_id");
      assert.ifError(preferences.error);
      const bySkipper = preferences.data.find((row) => row.user_id === skipperId);
      assert.ok(bySkipper.onboarding_skipped_at);
      assert.equal(bySkipper.onboarding_completed_at, null);
      assert.deepEqual(bySkipper.target_disciplines, []);
      const byFinisher = preferences.data.find((row) => row.user_id === finisherId);
      assert.ok(byFinisher.onboarding_completed_at, "the other user's finished first run is unchanged");
      const skipperFollows = await admin.from("watchlist_items").select("id").eq("user_id", skipperId);
      assert.ifError(skipperFollows.error);
      assert.equal(skipperFollows.data.length, 0);
    });
  } finally {
    for (const id of created) await admin.auth.admin.deleteUser(id);
    if (created.length) {
      for (const table of ["recruiting_preferences", "watchlist_items", "readiness_milestones"]) {
        const left = await admin.from(table).select("user_id").in("user_id", created);
        assert.ifError(left.error);
        assert.equal(left.data.length, 0, `${table} rows were removed with the test accounts`);
      }
    }
  }
});
