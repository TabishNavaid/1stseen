/**
 * The first run: three questions anyone can answer, the dashboard filters they make, the URL they travel in, a guest's
 * answers in local storage and how they carry into an account, and the celebration that respects reduced motion.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { REDUCED_MOTION_QUERY } from "../lib/celebration.ts";
import { DISCIPLINES, PROGRAM_TYPES, dashboardHref, parseDashboardFilters } from "../lib/dashboard-query.ts";
import { dashboardTiles } from "../lib/dashboard-tiles.ts";
import {
  GUEST_ONBOARDING_KEY,
  answering,
  clearGuestOnboarding,
  completeRequest,
  hasGuestAnswers,
  parseGuestOnboarding,
  reachedPayoff,
  readGuestOnboarding,
  shouldCarryOver,
  writeGuestOnboarding,
} from "../lib/guest-onboarding.ts";
import {
  FIELDS,
  LOOKING_FOR,
  MAX_COMPANIES,
  MAX_SEED_FOLLOWS,
  PLAN_OUTCOMES,
  PLAN_OUTCOME_MESSAGES,
  answersFromPreferences,
  answersSummary,
  answersToFilters,
  disciplinesForFields,
  browseHref,
  cleanAnswers,
  emptyAnswers,
  firstRunPending,
  hasAnyAnswer,
  legacyFromPreferences,
  parseOnboardingAnswers,
  parsePlanOutcome,
  planError,
  planOutcome,
  programTypesFor,
  welcomeHref,
} from "../lib/onboarding.ts";
import { SITE_NAV, navItems } from "../lib/site-nav.ts";

const COMPANY_A = "48fb2fe5-b8d0-5731-9b5a-7502252115dd";
const COMPANY_B = "0f0e3a3c-1111-4222-8333-944455556666";
const NOW = new Date("2026-09-19T12:00:00Z");

function paramsOf(href) {
  const params = {};
  for (const [key, value] of new URL(href, "http://localhost").searchParams) {
    params[key] = key in params ? [].concat(params[key], value) : value;
  }
  return params;
}

/** An in-memory Storage, and one that refuses everything, as a private window can. */
function memoryStorage() {
  const map = new Map();
  return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: (key) => map.delete(key) };
}
const blockedStorage = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };

test("the questions map onto the scope's own program types and disciplines, each exactly once", () => {
  assert.deepEqual(FIELDS.map((field) => field.label), ["SWE", "ML/AI", "Data", "Infra", "Security", "Hardware", "Robotics", "Quant", "PM", "Design", "Other engineering"]);
  // The eleven fields cover the seventeen scope disciplines exactly once.
  const disciplines = FIELDS.flatMap((field) => field.disciplines);
  assert.equal(new Set(disciplines).size, disciplines.length, "no discipline is under two fields");
  assert.deepEqual([...disciplines].sort(), DISCIPLINES.map(([value]) => value).sort());
  assert.deepEqual(disciplinesForFields(["other_engineering"]), ["mechanical_engineering", "aerospace_engineering", "manufacturing_engineering", "materials_engineering", "chemical_engineering", "civil_engineering", "biomedical_engineering"]);
  assert.deepEqual(answersToFilters({ lookingFor: null, fields: ["design", "other_engineering"], companies: [] }).disciplines.length, 8);

  const types = new Set(PROGRAM_TYPES.map(([value]) => value));
  const covered = LOOKING_FOR.flatMap((option) => option.types);
  for (const type of covered) assert.ok(types.has(type), type);
  assert.deepEqual([...covered].sort(), [...types].sort(), "the three answers cover every early-career program type once");
  assert.deepEqual(LOOKING_FOR.map((option) => option.label), ["Internship", "New grad", "Co-op"]);
  assert.deepEqual(programTypesFor("co_op"), ["co_op"]);
  assert.deepEqual(programTypesFor(null), [], "no answer is every type");
});

test("answers round-trip through the welcome URL, and malformed values are dropped, never guessed", () => {
  const answers = { lookingFor: "internship", fields: ["software_engineering", "machine_learning"], companies: [COMPANY_A] };
  const href = welcomeHref(answers, "ready");
  assert.equal(paramsOf(href).step, "ready");
  assert.deepEqual(parseOnboardingAnswers(paramsOf(href)), answers);
  assert.equal(welcomeHref(emptyAnswers), "/welcome");
  assert.deepEqual(
    parseOnboardingAnswers({ for: "astronaut", field: ["data", "sales", "data", "other_engineering", "mechanical_engineering"], company: ["not-a-uuid", COMPANY_B.toUpperCase()] }),
    { lookingFor: null, fields: ["data", "other_engineering"], companies: [COMPANY_B] },
  );
  const many = Array.from({ length: 14 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  assert.equal(cleanAnswers({ companies: many }).companies.length, MAX_COMPANIES);
  assert.equal(hasAnyAnswer(emptyAnswers), false);
});

test("the answers make the same filters the roles view reads, and companies reorder rather than filter", () => {
  const answers = { lookingFor: "new_grad", fields: ["quantitative"], companies: [COMPANY_A] };
  const filters = answersToFilters(answers);
  assert.deepEqual(filters.types, ["new_grad", "graduate_program", "rotational", "apprenticeship"]);
  assert.deepEqual(filters.disciplines, ["quantitative"]);
  assert.deepEqual(filters.companies, [], "a watched company goes to the top of the payoff; it does not hide every other company");
  const browse = browseHref(answers);
  assert.match(browse, /^\/roles\?/);
  assert.deepEqual(parseDashboardFilters(paramsOf(browse)).types, filters.types);
  assert.equal(browseHref(emptyAnswers), dashboardHref(parseDashboardFilters({})), "no answers browse everything");
});

test("the payoff's summary names at most two picked companies, and counts more", () => {
  const names = { [COMPANY_A]: "Acme", [COMPANY_B]: "Bolt" };
  assert.equal(answersSummary({ lookingFor: "internship", fields: ["software_engineering"], companies: [] }), "Internships in software engineering");
  assert.equal(answersSummary({ lookingFor: "co_op", fields: ["machine_learning", "data"], companies: [] }), "Co-ops in AI/ML and data");
  assert.equal(answersSummary({ lookingFor: "new_grad", fields: ["security", "hardware", "other_engineering"], companies: [] }), "New-grad roles in security, hardware, and other engineering");
  assert.equal(answersSummary({ lookingFor: "internship", fields: ["data", "security", "hardware", "robotics"], companies: [] }), "Internships in 4 fields");
  assert.equal(answersSummary({ lookingFor: null, fields: [], companies: [COMPANY_A] }, (id) => names[id]), "Every program in every field, with Acme first");
  assert.equal(answersSummary({ lookingFor: null, fields: [], companies: [COMPANY_A, COMPANY_B] }), "Every program in every field, with your 2 companies first");
});

test("stored preferences prefill the fields; answers an earlier first run stored stay readable", () => {
  const row = { target_disciplines: ["software_engineering", "mechanical_engineering", "security"], graduation_year: 2028, target_recruiting_season: "summer", preferred_locations: ["London"] };
  // "Other engineering" is chosen only when every discipline it covers is stored.
  assert.deepEqual(answersFromPreferences(row), { lookingFor: null, fields: ["software_engineering", "security"], companies: [] });
  const all = { target_disciplines: disciplinesForFields(["other_engineering"]) };
  assert.deepEqual(answersFromPreferences(all).fields, ["other_engineering"]);
  assert.deepEqual(legacyFromPreferences(row), { graduationYear: 2028, season: "summer", places: ["London"] });
  assert.deepEqual(legacyFromPreferences(null), { graduationYear: null, season: null, places: [] });
});

test("a guest's answers are kept in local storage as they are given, and a skip leaves nothing to carry over", () => {
  const storage = memoryStorage();
  assert.equal(readGuestOnboarding(storage), null);
  const answers = { lookingFor: "internship", fields: ["data"], companies: [] };
  assert.ok(writeGuestOnboarding(storage, answering(answers, null)));
  const record = readGuestOnboarding(storage);
  assert.deepEqual(record.answers, answers);
  // Still answering: nothing is offered back and nothing is saved on sign-in.
  assert.equal(hasGuestAnswers(record), false);
  // A guest who skips to browsing never reached the payoff, so a later sign-in has nothing to save.
  assert.equal(shouldCarryOver(record), false);
  // Blocked storage (a private window) is simply no storage, never an error.
  assert.equal(writeGuestOnboarding(blockedStorage, record), false);
  assert.equal(readGuestOnboarding(blockedStorage), null);
  assert.doesNotThrow(() => clearGuestOnboarding(blockedStorage));
});

test("reaching the payoff and choosing to save marks the answers to carry into the account on sign-up", () => {
  const storage = memoryStorage();
  const answers = { lookingFor: "co_op", fields: ["hardware", "robotics"], companies: [COMPANY_A] };
  writeGuestOnboarding(storage, reachedPayoff(answers, NOW, false));
  assert.equal(hasGuestAnswers(readGuestOnboarding(storage)), true, "a guest who reached the payoff is welcomed back with their picks");
  assert.equal(shouldCarryOver(readGuestOnboarding(storage)), false, "keeping browsing as a guest does not save anything");

  writeGuestOnboarding(storage, reachedPayoff(answers, NOW, true));
  const pending = readGuestOnboarding(storage);
  assert.equal(shouldCarryOver(pending), true);

  // What the signed-in first run posts: the same answers, the listed roles, and the companies, within the API's limits.
  const roleIds = Array.from({ length: 15 }, (_, index) => `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  const body = completeRequest(pending.answers, [...roleIds, roleIds[0]]);
  assert.equal(body.action, "complete");
  assert.deepEqual(body.answers, { looking_for: "co_op", fields: ["hardware", "robotics"], companies: [COMPANY_A] });
  assert.equal(body.role_ids.length, MAX_SEED_FOLLOWS);
  assert.equal(new Set(body.role_ids).size, body.role_ids.length);

  // Editing the answers again as a guest cancels a pending save: the save is for the answers the guest confirmed.
  assert.equal(shouldCarryOver(answering(answers, pending)), false);

  // Saved: the record is cleared, so a second sign-in never saves it twice.
  clearGuestOnboarding(storage);
  assert.equal(storage.map.has(GUEST_ONBOARDING_KEY), false);
  assert.equal(shouldCarryOver(readGuestOnboarding(storage)), false);
});

test("a stored record is re-validated: a tampered or foreign value carries nothing", () => {
  assert.equal(parseGuestOnboarding("not json"), null);
  assert.equal(parseGuestOnboarding(JSON.stringify({ version: 2, answers: {} })), null);
  const tampered = parseGuestOnboarding(JSON.stringify({ version: 1, answers: { lookingFor: "ceo", fields: ["sales", "data"], companies: ["x"] }, completedAt: "yesterday", pendingSave: true }));
  assert.deepEqual(tampered.answers, { lookingFor: null, fields: ["data"], companies: [] });
  assert.equal(tampered.pendingSave, false, "a save is never pending without a real completion time");
});

test("the onboarding API takes exactly the answers the browser sends", () => {
  const route = readFileSync(new URL("../app/api/onboarding/route.ts", import.meta.url), "utf8");
  assert.match(route, /looking_for: z\.enum\(LOOKING_FOR_VALUES/);
  assert.match(route, /fields: z\.array\(z\.enum\(FIELD_VALUES/);
  assert.match(route, /companies: z\.array\(z\.string\(\)\.uuid\(\)\)\.max\(MAX_COMPANIES\)/);
  assert.match(route, /target_type: "company"/, "a picked company is followed");
  assert.match(route, /target_disciplines: disciplinesForFields\(/, "a field is stored as the disciplines it covers");
  assert.doesNotMatch(route, /graduation_year: answers|preferred_locations: answers/, "answers this first run no longer asks are left as stored");
});

test("the guest skip path: every step offers 'Skip, just browse', a plain link to the roles view for a guest", () => {
  const flow = readFileSync(new URL("../components/onboarding/onboarding-flow.tsx", import.meta.url), "utf8");
  const header = flow.slice(flow.indexOf("<header"), flow.indexOf("</header>"));
  assert.match(header, /<Link href="\/roles"[^>]*>\s*Skip, just browse\s*<\/Link>/, "a guest skips with a link that works before script loads");
  assert.match(header, /onClick=\{\(\) => void skip\(\)\}[^>]*>\s*Skip, just browse/, "a signed-in skip is saved so it is not offered again");
  // The only condition on the skip is whether the answers were just saved; it is never limited to some steps.
  assert.doesNotMatch(header, /step\s*[<>=!]=?\s*\d/);
});

test("zero tiles are never rendered, and a guest never sees the watched tile", () => {
  assert.deepEqual(dashboardTiles({ openingWithin30Days: 0, followedRoles: 0, confirmedOpenings: 0, signedIn: false }), []);
  assert.deepEqual(dashboardTiles({ openingWithin30Days: 0, followedRoles: 4, confirmedOpenings: 62, signedIn: false }), [{ key: "opened", value: 62 }]);
  assert.deepEqual(dashboardTiles({ openingWithin30Days: 3, followedRoles: 4, confirmedOpenings: 0, signedIn: true }), [{ key: "soon", value: 3 }, { key: "watched", value: 4 }]);
  for (const signedIn of [false, true]) {
    for (const tile of dashboardTiles({ openingWithin30Days: 0, followedRoles: 0, confirmedOpenings: 5, signedIn })) assert.ok(tile.value > 0);
  }
});

test("a guest's navigation is Explore, Just opened, and Ask; an account adds its watchlist and calendar", () => {
  assert.deepEqual(navItems(false).map((item) => item.label), ["Explore", "Just opened", "Ask"]);
  assert.deepEqual(navItems(true).map((item) => item.label), ["Explore", "Just opened", "Ask", "Watchlist", "Calendar"]);
  const hrefs = SITE_NAV.map((item) => item.href);
  assert.ok(!hrefs.includes("/replay") && !hrefs.includes("/digests"), "Replay and Digests are not in the navigation");
});

test("step one moves on with a single tap; the multi-select steps keep Continue", () => {
  const flow = readFileSync(new URL("../components/onboarding/onboarding-flow.tsx", import.meta.url), "utf8");
  const stepOne = flow.slice(flow.indexOf("{step === 1 && ("), flow.indexOf("{step === 2 && ("));
  assert.match(stepOne, /onClick=\{\(\) => choose\(option\.value\)\}/, "each choice is a button that chooses and advances");
  assert.match(stepOne, /Show me all three/);
  assert.doesNotMatch(stepOne, /type="radio"/);
  assert.match(flow, /const choose = \(value: LookingFor \| null\) => \{[\s\S]*?setLocalStep\(2\);/);
  assert.match(flow, /\(step === 2 \|\| step === 3\) && \(\s*<button type="button" onClick=\{next\}/, "Continue is shown for the multi-select steps only");
});

test("the payoff leads with the top six and puts the total in the subtitle; saving never promises alerts", () => {
  const flow = readFileSync(new URL("../components/onboarding/onboarding-flow.tsx", import.meta.url), "utf8");
  assert.match(flow, /`Your top \$\{payoff\.roles\.length\} to watch`/);
  assert.match(flow, /plural\(payoff\.matchingRoles, "program matches", "programs match"\)/);
  assert.equal((flow.match(/Save to my watchlist/g) ?? []).length >= 2, true, "guest and member both save to the watchlist");
  assert.doesNotMatch(flow, /get alerts|alerts\b/i);
});

test("reduced motion: nothing moves, and the save is stamped rather than burst over", () => {
  assert.equal(REDUCED_MOTION_QUERY, "(prefers-reduced-motion: reduce)");

  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const block = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  assert.match(block, /animation-duration: 0\.01ms !important/);
  assert.match(block, /transition-duration: 0\.01ms !important/);
  assert.match(block, /\.lift:hover \{ transform: none; \}/);
  // The stamp is already on the page rather than landing on it.
  assert.match(block, /\.stamp-in \{ animation: none;/);
  // Nothing bursts anywhere any more.
  assert.doesNotMatch(css, /confetti/i);

  // Before hydration the flow assumes reduced motion, so the server render never moves anything.
  const flow = readFileSync(new URL("../components/onboarding/onboarding-flow.tsx", import.meta.url), "utf8");
  assert.match(flow, /useSyncExternalStore\(subscribeReducedMotion, [^,]+, \(\) => true\)/);
  assert.doesNotMatch(flow, /confetti/i);
});

test("the first run is offered only to an account that has not finished it, skipped it, or followed anything", () => {
  assert.equal(firstRunPending({ completedAt: null, skippedAt: null, followedRoles: 0 }), true);
  assert.equal(firstRunPending({ completedAt: "2026-09-15T00:00:00Z", skippedAt: null, followedRoles: 0 }), false);
  assert.equal(firstRunPending({ completedAt: null, skippedAt: "2026-09-15T00:00:00Z", followedRoles: 0 }), false);
  assert.equal(firstRunPending({ completedAt: null, skippedAt: null, followedRoles: 1 }), false);
});

test("each readiness outcome maps from the worker's status and has a message", () => {
  assert.equal(planOutcome(200), "ready");
  // The planner answers 503 for three situations, and only one of them is "there is no planner here". A reader whose
  // planner is merely down is told to try again, not that the product does not do this.
  assert.equal(planOutcome(503, "readiness_api_unavailable"), "not_configured");
  assert.equal(planOutcome(503, "readiness_api_unreachable"), "unreachable");
  assert.equal(planOutcome(503, "readiness_api_failed"), "unreachable");
  assert.equal(planOutcome(503), "unreachable", "an unlabelled 503 is a planner that did not answer, not an absent one");
  assert.equal(planOutcome(502), "unreachable");
  assert.equal(planOutcome(403), "refused");
  assert.equal(planOutcome(422), "refused");
  assert.equal(planError({ error: "readiness_api_unreachable" }), "readiness_api_unreachable");
  assert.equal(planError({ plan: [] }), null);
  assert.equal(planError(null), null);
  assert.equal(parsePlanOutcome("ready"), "ready");
  assert.equal(parsePlanOutcome(["none", "ready"]), "none");
  assert.equal(parsePlanOutcome("<script>"), null);
  for (const outcome of PLAN_OUTCOMES) assert.ok(PLAN_OUTCOME_MESSAGES[outcome].startsWith("Your watchlist is set."));
});
