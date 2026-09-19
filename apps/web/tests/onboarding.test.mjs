/**
 * The first run: the four answers, what each asks the seed function for, and the URL they travel in. The accuracy
 * position is no longer restated before the first question: it is said once, in the site footer.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DISCIPLINES } from "../lib/dashboard-query.ts";
import {
  PLAN_OUTCOMES,
  PLAN_OUTCOME_MESSAGES,
  TRACKS,
  TRACK_VALUES,
  answersFromPreferences,
  disciplinesFor,
  emptyAnswers,
  firstRunPending,
  graduationYears,
  parseOnboardingAnswers,
  parsePlaces,
  parsePlanOutcome,
  placesText,
  planOutcome,
  programTypesFor,
  seedRpcArgs,
  welcomeHref,
} from "../lib/onboarding.ts";

const TODAY = new Date("2026-09-15T12:00:00Z");

function paramsOf(href) {
  const params = {};
  for (const [key, value] of new URL(href, "http://localhost").searchParams) {
    params[key] = key in params ? [].concat(params[key], value) : value;
  }
  return params;
}

test("the seven tracks cover the seventeen scope disciplines exactly once", () => {
  const covered = TRACKS.flatMap((track) => track.disciplines);
  assert.equal(new Set(covered).size, covered.length, "no discipline is under two tracks");
  assert.deepEqual([...covered].sort(), DISCIPLINES.map(([value]) => value).sort());
  assert.deepEqual(TRACKS.map((track) => track.value), [...TRACK_VALUES]);
  assert.deepEqual(disciplinesFor(["hardware", "software"]), ["software_engineering", "infrastructure", "security", "hardware", "robotics"]);
});

test("a graduation year picks program types the way personalization ranks them", () => {
  assert.deepEqual(programTypesFor(null, TODAY), []);
  assert.deepEqual(programTypesFor(2031, TODAY), ["internship", "co_op"]);
  assert.deepEqual(programTypesFor(2028, TODAY), ["internship", "co_op"]);
  assert.deepEqual(programTypesFor(2027, TODAY), ["internship", "co_op", "new_grad", "graduate_program", "rotational", "apprenticeship"]);
  assert.deepEqual(programTypesFor(2026, TODAY), ["new_grad", "graduate_program", "rotational", "apprenticeship"]);
  assert.deepEqual(programTypesFor(2024, TODAY), ["new_grad", "graduate_program", "rotational", "apprenticeship"]);
  assert.deepEqual(graduationYears(TODAY), [2025, 2026, 2027, 2028, 2029, 2030, 2031]);
  assert.deepEqual(graduationYears(TODAY, 2022), [2022, 2025, 2026, 2027, 2028, 2029, 2030, 2031]);
});

test("answers round-trip through the welcome URL, and malformed values are dropped", () => {
  const answers = { tracks: ["software", "quantitative"], graduationYear: 2028, season: "summer", places: ["New York, NY", "London"] };
  const href = welcomeHref(answers, "review");
  assert.equal(paramsOf(href).step, "review");
  assert.deepEqual(parseOnboardingAnswers(paramsOf(href)), answers);
  assert.equal(welcomeHref(emptyAnswers), "/welcome");
  assert.deepEqual(parseOnboardingAnswers({ track: ["astronaut", "data"], grad: "soon", season: "monsoon", place: "  " }), { ...emptyAnswers, tracks: ["data"] });
  assert.equal(parseOnboardingAnswers({ grad: "1999" }).graduationYear, null);
  assert.equal(parseOnboardingAnswers({ grad: "2022" }).graduationYear, 2022, "a stored year outside the offered list survives");
});

test("places split on 'or' and semicolons, keep a comma inside a place, and are capped at three", () => {
  assert.deepEqual(parsePlaces("New York, NY or London; Toronto"), ["New York, NY", "London", "Toronto"]);
  assert.deepEqual(parsePlaces("Portland, Oregon"), ["Portland, Oregon"], "'or' inside a word does not split");
  assert.deepEqual(parsePlaces("london or London or  LONDON "), ["london"]);
  assert.deepEqual(parsePlaces("A or B or C or D"), ["A", "B", "C"]);
  assert.deepEqual(parsePlaces(`${"x".repeat(81)} or Paris or ---`), ["Paris"]);
  assert.deepEqual(parsePlaces(placesText(["New York, NY", "London"])), ["New York, NY", "London"]);
});

test("stored preferences prefill the questions, and a track is checked only when all its disciplines are stored", () => {
  const answers = answersFromPreferences({
    target_disciplines: ["software_engineering", "infrastructure", "security", "quantitative", "hardware"],
    graduation_year: 2028,
    target_recruiting_season: "year_round",
    preferred_locations: ["London"],
  });
  assert.deepEqual(answers, { tracks: ["software", "quantitative"], graduationYear: 2028, season: null, places: ["London"] });
  assert.deepEqual(answersFromPreferences(null), emptyAnswers);
});

test("an unanswered question passes null to the seed function, which matches every role", () => {
  assert.deepEqual(seedRpcArgs(emptyAnswers, TODAY), { p_disciplines: null, p_types: null, p_season: null, p_locations: null });
  assert.deepEqual(seedRpcArgs({ tracks: ["data"], graduationYear: 2026, season: "winter", places: ["Chicago"] }, TODAY), {
    p_disciplines: ["data"],
    p_types: ["new_grad", "graduate_program", "rotational", "apprenticeship"],
    p_season: "winter",
    p_locations: ["Chicago"],
  });
});

test("the first run is offered only to an account that has not finished it, skipped it, or followed anything", () => {
  assert.equal(firstRunPending({ completedAt: null, skippedAt: null, followedRoles: 0 }), true);
  assert.equal(firstRunPending({ completedAt: "2026-09-15T00:00:00Z", skippedAt: null, followedRoles: 0 }), false);
  assert.equal(firstRunPending({ completedAt: null, skippedAt: "2026-09-15T00:00:00Z", followedRoles: 0 }), false);
  assert.equal(firstRunPending({ completedAt: null, skippedAt: null, followedRoles: 1 }), false);
});

test("each readiness outcome maps from the worker's status and has a message", () => {
  assert.equal(planOutcome(200), "ready");
  assert.equal(planOutcome(503), "not_configured");
  assert.equal(planOutcome(502), "unreachable");
  assert.equal(planOutcome(403), "refused");
  assert.equal(planOutcome(422), "refused");
  assert.equal(parsePlanOutcome("ready"), "ready");
  assert.equal(parsePlanOutcome(["none", "ready"]), "none");
  assert.equal(parsePlanOutcome("<script>"), null);
  for (const outcome of PLAN_OUTCOMES) assert.ok(PLAN_OUTCOME_MESSAGES[outcome].startsWith("Your watchlist is set."));
});
