/**
 * The fixture set has to span the branches the list can take.
 *
 * This exists because it did not. Every fixture role carried `listedNow: false`, `outlook: null`,
 * `forecastable: true`, `followed: false`, no discipline, no season, no program year and every evidence count at
 * zero. So demo mode and every rendered-HTML test drew one branch of each and never the others — and the card led
 * with a guessed date for programmes that were open, for weeks, with a green suite, because no fixture was ever
 * open. The coverage was not thin; it was pointed at the wrong thing.
 *
 * Where a vocabulary is closed, this iterates the vocabulary rather than a list written out here, so adding a
 * state or a precision class fails until a fixture is in it. Where it is open — seventeen disciplines, six program
 * types — it asks only that at least one fixture has one, because a fixture per discipline would be a worse
 * fixture set, not a better one.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { PRECISIONS, defaultDashboardFilters, fixtureDashboardView } from "../lib/dashboard-query.ts";
import { WINDOW_STATES, windowState } from "../lib/forecast-window.ts";
import { fixtureListFacts, forecastRoles } from "../lib/demo-data.ts";

/** A fixed day, so the assertions are about the fixture set and not about the day the suite happens to run. */
const NOW = new Date("2027-05-20T12:00:00Z");
const TODAY = "2027-05-20";

function items(now = NOW) {
  // Page size is 20 and the per-company cap does not bite on one role per company, so this is the whole set.
  return fixtureDashboardView(forecastRoles(now), defaultDashboardFilters, () => null, fixtureListFacts, now).items;
}

test("every fixture role is described: a new one cannot inherit the old single branch by omission", () => {
  const missing = forecastRoles(NOW).filter((role) => !(role.id in fixtureListFacts)).map((role) => role.id);
  assert.deepEqual(missing, [], "each fixture role needs an entry in fixtureListFacts");
  const extra = Object.keys(fixtureListFacts).filter((id) => !forecastRoles(NOW).some((role) => role.id === id));
  assert.deepEqual(extra, [], "fixtureListFacts names a role that no longer exists");
});

test("a fixture sits in every window state, on any day the suite runs", () => {
  // Checked on four days spread through a year: the windows are offsets from the render date, so the set must
  // span the states whenever it is drawn, not only on the day someone wrote the dates down.
  for (const day of ["2027-01-11", "2027-05-20", "2027-09-02", "2027-12-29"]) {
    const now = new Date(`${day}T12:00:00Z`);
    const states = new Set(items(now).filter((item) => item.outlook).map((item) => windowState(item.outlook, day)));
    for (const state of WINDOW_STATES) {
      assert.ok(states.has(state), `no fixture is in the ${state} state on ${day}`);
    }
  }
});

test("a fixture is open now, and a fixture is not", () => {
  const listed = items().filter((item) => item.listedNow);
  assert.ok(listed.length > 0, "nothing is open: the dominant case in the corpus would go unrendered");
  assert.ok(listed.length < items().length, "everything is open: the forecast presentation would go unrendered");
});

test("a fixture has no window, so the no-date row is drawn too", () => {
  const refused = items().filter((item) => !item.forecastable);
  assert.ok(refused.length > 0, "every fixture is forecastable, so InsufficientRoleRow is never rendered");
  assert.ok(refused.every((item) => item.outlook === null), "a role with no window must not carry a date");
});

test("a fixture is followed, so the watched branch is drawn", () => {
  assert.ok(items().some((item) => item.followed), "no fixture is followed");
  assert.ok(items().some((item) => !item.followed), "every fixture is followed");
});

test("the evidence precisions are all represented, so the counts and filters see more than zero", () => {
  const all = items();
  const held = {
    exact: all.some((item) => item.exactEvents > 0),
    exact_or_bounded: all.some((item) => item.exactEvents + item.boundedEvents > 0),
    observed_only: all.some((item) => item.observedEvents > 0 && item.exactEvents + item.boundedEvents === 0),
    none: all.some((item) => item.exactEvents + item.boundedEvents + item.observedEvents === 0),
  };
  for (const [precision] of PRECISIONS) {
    assert.ok(held[precision], `no fixture matches the ${precision} filter, so that branch is never drawn`);
  }
});

test("a fixture carries a discipline, a season and a program year, and one carries none of them", () => {
  const all = items();
  assert.ok(all.some((item) => item.discipline), "every fixture reads 'Discipline not classified'");
  assert.ok(all.some((item) => item.season && item.season !== "unknown"), "no fixture states a season");
  assert.ok(all.some((item) => item.targetYear), "no fixture states a program year");
  // The unknown side is a real row too: a role the classifier could not place still has to render.
  assert.ok(all.some((item) => !item.discipline && !item.targetYear), "nothing exercises the unclassified row");
});

test("the first row carries an archived sighting, because the drawer opens on it", () => {
  // The drawer draws its archive caveat only for a role with archive evidence, and it opens on the first row of the
  // default sort. Without this the caveat silently stops being rendered the next time the sort or the set changes.
  const first = forecastRoles(NOW).find((role) => role.id === items()[0].id);
  assert.ok(first, "the first row is a fixture role");
  assert.ok(first.evidence.some((item) => item.kind === "archive"), `${first.id} is drawn first and has no archived sighting`);
});

test("the list actually draws a date, which is the presentation this product is for", () => {
  const dated = items().filter((item) => item.outlook);
  assert.ok(dated.length >= 3, `only ${dated.length} fixture rows carry an expected date`);
  for (const item of dated) {
    assert.ok(item.outlook.start <= item.outlook.expected && item.outlook.expected <= item.outlook.end,
      `${item.id}: the expected date has to sit inside its own window`);
  }
  void TODAY;
});
