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
 *   - signed out, /welcome and /settings send the visitor to sign in, and /api/onboarding answers 401
 *   - the first screen asks its four questions, and the accuracy position is said once, in the site footer
 *   - the review lists exactly what onboarding_seed_roles proposes, and every listed role fits the answers: a chosen
 *     discipline, a program type the graduation year points at, no other stated season, at most two per company, and
 *     roles with a current forecast first
 *   - finishing saves the answers, follows exactly the chosen in-scope roles for this user only (an out-of-scope id is
 *     ignored), lands on the first chosen role with a current forecast, and builds its plan when the planner runs
 *   - finishing twice does not duplicate a follow; a cross-origin or malformed request changes nothing
 *   - skipping is saved and stops the dashboard offering the first run; one user's first run never touches another's
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import "../support/retain-request-clones.mjs";

import { loadDotEnv } from "../../../../scripts/lib/db.mjs";
import { PLAN_OUTCOME_MESSAGES, TRACKS } from "../../lib/onboarding.ts";

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
const seedIdsIn = (html) => [...html.matchAll(/id="seed-([0-9a-f-]{36})"/g)].map((match) => match[1]);

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
  const plannerUp = Boolean(process.env.FIRSTSEEN_AGENT_API_URL)
    && await fetch(new URL("/health", process.env.FIRSTSEEN_AGENT_API_URL)).then((r) => r.ok).catch(() => false);
  t.diagnostic(plannerUp ? "readiness planner is running: a real plan is required" : "readiness planner is not running: the honest outcome is required");

  const password = `Correct-horse-${RUN}`;
  const created = [];
  const year = new Date().getUTCFullYear();

  try {
    for (const label of ["finisher", "skipper"]) {
      const result = await admin.auth.admin.createUser({ email: address(label), password, email_confirm: true });
      assert.ifError(result.error);
      created.push(result.data.user.id);
    }
    const [finisherId, skipperId] = created;

    await t.test("signed out, the first run and settings send the visitor to sign in", async () => {
      for (const [path, returnTo] of [["/welcome", "%2Fwelcome"], ["/settings", "%2Fsettings"]]) {
        const response = await call(path);
        assert.ok(response.status >= 300 && response.status < 400, `${path} redirects (got ${response.status})`);
        assert.match(response.headers.get("location") ?? "", new RegExp(`/signin\\?return_to=${returnTo}$`));
      }
      const api = await call("/api/onboarding", { method: "POST", body: { action: "skip" } });
      assert.equal(api.status, 401);
    });

    const jar = await signIn(address("finisher"), password);
    const answers = { tracks: ["software"], graduation_year: year + 2, season: "summer", places: [] };
    let seedIds = [];

    await t.test("the first screen asks four questions, and says the accuracy position once, in the footer", async () => {
      const response = await call("/welcome", { jar });
      assert.equal(response.status, 200);
      const html = decode(await response.text());
      const visible = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
      assert.equal(visible.match(/accuracy is not\s+yet validated/g)?.length, 1, "the footer's disclosure, and only that");
      const questions = ["What kind of role are you aiming for?", "When do you graduate?", "Which season are you targeting?", "Where would you work? (optional)"];
      for (const question of questions) assert.ok(html.includes(question), `"${question}" is asked`);
      assert.equal((html.match(/<fieldset/g) ?? []).length, questions.length, "four questions and no more");
      const offered = await call("/", { jar });
      assert.match(decode(await offered.text()), new RegExp(FIRST_RUN_OFFER), "a new account is offered the first run");
    });

    await t.test("the review lists what onboarding_seed_roles proposes, and every role fits the answers", async () => {
      const query = new URLSearchParams({ step: "review", track: "software", grad: String(answers.graduation_year), season: "summer" });
      const response = await call(`/welcome?${query}`, { jar });
      assert.equal(response.status, 200);
      const html = decode(await response.text());
      seedIds = seedIdsIn(html);
      assert.ok(seedIds.length >= 3, `at least three roles proposed (got ${seedIds.length})`);

      const disciplines = TRACKS.find((track) => track.value === "software").disciplines;
      const expected = await admin.rpc("onboarding_seed_roles", {
        p_now: new Date().toISOString(),
        p_user_id: finisherId,
        p_disciplines: [...disciplines],
        p_types: ["internship", "co_op"],
        p_season: "summer",
        p_locations: null,
        p_limit: 8,
      });
      assert.ifError(expected.error);
      assert.deepEqual(seedIds, expected.data.map((row) => row.role_id), "the page lists the function's proposal, in order");

      const perCompany = new Map();
      let seenWithoutForecast = false;
      for (const row of expected.data) {
        assert.ok(disciplines.includes(row.discipline), `${row.canonical_title}: discipline ${row.discipline}`);
        assert.ok(["internship", "co_op"].includes(row.program_type), `${row.canonical_title}: type ${row.program_type}`);
        assert.ok(["summer", "unknown", "year_round"].includes(row.season), `${row.canonical_title}: season ${row.season}`);
        perCompany.set(row.company_id, (perCompany.get(row.company_id) ?? 0) + 1);
        if (!row.current_forecast) seenWithoutForecast = true;
        else assert.equal(seenWithoutForecast, false, "roles with a current forecast come first");
      }
      assert.ok(Math.max(...perCompany.values()) <= 2, "at most two roles per company");
      assert.ok(expected.data[0].current_forecast, "the rig has a current forecast for these answers, so one leads");

      const scope = await admin.from("canonical_roles").select("scope_status").in("id", seedIds);
      assert.ifError(scope.error);
      assert.ok(scope.data.every((row) => row.scope_status === "in_scope"), "every proposed role is in scope");
    });

    await t.test("a cross-origin or malformed request changes nothing", async () => {
      const roleIds = seedIds.slice(0, 1);
      const crossOrigin = await call("/api/onboarding", { method: "POST", body: { action: "complete", answers, role_ids: roleIds }, jar, headers: { origin: "https://attacker.example" } });
      assert.equal(crossOrigin.status, 403);
      for (const body of [
        { action: "complete", answers, role_ids: ["not-a-uuid"] },
        { action: "complete", answers: { ...answers, user_id: skipperId }, role_ids: roleIds },
        { action: "complete", answers, role_ids: roleIds, user_id: skipperId },
        { action: "complete", answers: { ...answers, tracks: ["astronaut"] }, role_ids: roleIds },
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

    await t.test("finishing follows the chosen in-scope roles, lands on the first forecast, and builds its plan", async () => {
      const outOfScope = await admin.from("canonical_roles").select("id").eq("scope_status", "out_of_scope").limit(1).single();
      assert.ifError(outOfScope.error);
      const chosen = seedIds.slice(0, 3);
      const response = await call("/api/onboarding", { method: "POST", body: { action: "complete", answers, role_ids: [...chosen, outOfScope.data.id] }, jar });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.status, "completed");
      assert.equal(result.watching, 3);
      assert.equal(result.plan, plannerUp ? "ready" : "unreachable");
      assert.equal(result.redirect, `/roles/${chosen[0]}?welcome=${result.plan}`);

      const preferences = await admin.from("recruiting_preferences").select("*").eq("user_id", finisherId).single();
      assert.ifError(preferences.error);
      assert.deepEqual([...preferences.data.target_disciplines].sort(), ["infrastructure", "security", "software_engineering"]);
      assert.equal(preferences.data.graduation_year, answers.graduation_year);
      assert.equal(preferences.data.target_recruiting_season, "summer");
      assert.ok(preferences.data.onboarding_completed_at);
      assert.equal(preferences.data.onboarding_skipped_at, null);

      const follows = await admin.from("watchlist_items").select("user_id,target_type,canonical_role_id").in("user_id", created);
      assert.ifError(follows.error);
      assert.deepEqual(follows.data.map((row) => [row.user_id, row.target_type, row.canonical_role_id]).sort(), chosen.map((id) => [finisherId, "canonical_role", id]).sort());

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
      if (plannerUp) assert.match(html, /Policy\s*(?:<[^>]+>\s*)*readiness-workback-v1/);

      const dashboard = decode(await (await call("/", { jar })).text());
      assert.doesNotMatch(dashboard, new RegExp(FIRST_RUN_OFFER), "a finished first run is not offered again");

      const again = await call("/api/onboarding", { method: "POST", body: { action: "complete", answers, role_ids: chosen }, jar });
      assert.equal(again.status, 200);
      const followsAgain = await admin.from("watchlist_items").select("id").eq("user_id", finisherId);
      assert.ifError(followsAgain.error);
      assert.equal(followsAgain.data.length, 3, "finishing again does not duplicate a follow");

      const rerun = decode(await (await call("/welcome", { jar })).text());
      assert.match(rerun, /Update what you are preparing for/);
      const trackInput = (value) => rerun.match(new RegExp(`<input[^>]*name="track"[^>]*value="${value}"[^>]*>`))?.[0] ?? "";
      assert.match(trackInput("software"), /\bchecked=""/, "a re-run starts from the stored answers");
      assert.doesNotMatch(trackInput("data"), /\bchecked=""/);
    });

    await t.test("skipping is saved, stops the offer, and leaves another user's first run alone", async () => {
      const skipper = await signIn(address("skipper"), password);
      assert.match(decode(await (await call("/", { jar: skipper })).text()), new RegExp(FIRST_RUN_OFFER));
      const skipped = await call("/api/onboarding", { method: "POST", body: { action: "skip" }, jar: skipper });
      assert.equal(skipped.status, 200);
      assert.deepEqual(await skipped.json(), { status: "skipped", redirect: "/" });
      assert.doesNotMatch(decode(await (await call("/", { jar: skipper })).text()), new RegExp(FIRST_RUN_OFFER));

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
