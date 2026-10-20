/**
 * A fixture date is an offset from the day it is rendered on, never a date.
 *
 * Written as dates, fixtures rot, and they rot silently: measured 2026-10-16, sixty of the sixty-one absolute
 * dates in the web fixtures were already in the past. The role page's fixture forecast had become a window that
 * closed weeks ago, and the demo calendar was a calendar of things that had already happened — which nobody saw,
 * because the calendar page pinned its own `today` to a day eight weeks gone so the stale dates still straddled it.
 *
 * Three separate good intentions would not have caught any of that. One rule does: time comes in as a value, and a
 * fixture date is an offset from it (AGENTS.md). This is the half of that rule a test can hold.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureCalendarEvents } from "../lib/calendar-data.ts";
import { fixtureListFacts, fixtureRoleViews, forecastRoles } from "../lib/demo-data.ts";

const WEB = fileURLToPath(new URL("..", import.meta.url));

/** The files that hold what demo mode draws. A new one belongs in this list. */
const FIXTURE_FILES = ["lib/demo-data.ts", "lib/calendar-data.ts"];

const ISO = /(?<!\d)(20\d\d-\d\d-\d\d)(?!\d)/g;
const DISPLAY = /"([A-Z][a-z]{2} \d{1,2}, 20\d\d)"/g;

test("no fixture file holds an absolute date", () => {
  const offenders = [];
  for (const file of FIXTURE_FILES) {
    const source = readFileSync(join(WEB, file), "utf8");
    // Comments explain the rot in terms of the dates it happened on, and those are prose, not fixture data.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const [, date] of code.matchAll(ISO)) offenders.push(`${file}: ${date}`);
    for (const [, date] of code.matchAll(DISPLAY)) offenders.push(`${file}: ${date}`);
  }
  assert.deepEqual(offenders, [], "write the date as an offset in days from the day it is rendered on");
});

test("every fixture file is in the list, so a new one cannot opt itself out", () => {
  const named = new Set(FIXTURE_FILES.map((file) => join(WEB, file)));
  const found = readdirSync(join(WEB, "lib"))
    .filter((name) => /^(demo|fixture)|-data\.ts$|^calendar-data\.ts$/.test(name) && name.endsWith(".ts"))
    .map((name) => join(WEB, "lib", name))
    // Loaders read the database; only the files that *hold* fixture values are in scope.
    .filter((path) => /fixture|demo|calendar-data/.test(path) && !readFileSync(path, "utf8").includes('import "server-only"'));
  const missing = found.filter((path) => !named.has(path)).map((path) => path.slice(WEB.length));
  assert.deepEqual(missing, [], "add it to FIXTURE_FILES");
});

test("the dates the fixtures produce straddle whatever day they are rendered on", () => {
  // The point of an offset is that this holds on any day, so it is asked on four spread through a year.
  for (const day of ["2027-01-11", "2027-05-20", "2027-09-02", "2027-12-29"]) {
    const now = new Date(`${day}T12:00:00Z`);

    const events = fixtureCalendarEvents(now).map((event) => event.date);
    assert.ok(events.some((date) => date >= day), `every fixture calendar entry is in the past on ${day}`);
    assert.ok(events.some((date) => date < day), `no fixture calendar entry is in the past on ${day}`);

    const views = Object.values(fixtureRoleViews(now));
    const windows = views.map((view) => view.forecast).filter(Boolean);
    assert.ok(windows.length > 0, "a fixture role page carries a forecast");
    assert.ok(windows.some((forecast) => forecast.windowEnd >= day), `every fixture forecast has closed on ${day}`);

    // And the list's own windows, which fixture-coverage checks the states of, are dated from the same clock.
    const outlooks = Object.values(fixtureListFacts).map((facts) => facts.outlook).filter(Boolean);
    assert.ok(outlooks.some((outlook) => outlook.endsIn > 0), "no fixture window is still open");
    assert.ok(outlooks.some((outlook) => outlook.startsIn < 0), "no fixture window has started");
  }
});

test("the fixture roles parse on any day, so an offset cannot make one invalid", () => {
  // daysUntil is non-negative in the shared schema; an offset that went negative would throw here, not in a page.
  for (const day of ["2027-01-11", "2027-12-29"]) {
    assert.ok(forecastRoles(new Date(`${day}T12:00:00Z`)).length >= 6, day);
  }
});
