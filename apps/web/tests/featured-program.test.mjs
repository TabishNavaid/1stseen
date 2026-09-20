/**
 * The rule that decides which program the landing page's chart draws (lib/featured-program.ts). It is the one place
 * the product chooses what to put in front of a first-time visitor, so the choice has to be a rule and not a taste.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DAYS_IN_YEAR, featuredOf, openingSpread, rhythmOf } from "../lib/featured-program.ts";

const near = (value, expected, slack = 1.5) => assert.ok(Math.abs(value - expected) <= slack, `${value} is not within ${slack} of ${expected}`);

test("a spread is the shortest stretch of the year that holds every opening", () => {
  assert.equal(openingSpread([]), 0);
  assert.equal(openingSpread([180]), 0);
  near(openingSpread([100, 110]), 10);
  near(openingSpread([100, 110, 105]), 10);
});

test("a spread is measured around the circle, so a program that opens either side of New Year reads as tight", () => {
  // 21 December and 6 January are sixteen days apart, not three hundred and forty-nine.
  const december = rhythmOf(["2023-12-21", "2024-12-27", "2026-01-06"]);
  assert.equal(december.years, 3);
  near(december.spread, 16, 2.5);
  // The same three days of the year, read as a straight line, would have spanned almost the whole year.
  assert.ok(december.spread < DAYS_IN_YEAR / 4);
});

test("a program's rhythm counts distinct years, not openings", () => {
  const twice = rhythmOf(["2024-03-01", "2024-03-08", "2025-03-04"]);
  assert.equal(twice.years, 2);
  near(twice.spread, 7, 2);
  assert.deepEqual(rhythmOf([]), { years: 0, spread: DAYS_IN_YEAR });
});

const role = (id, windowStart) => ({ role_id: id, window_start: windowStart });

test("the featured program is the tightest rhythm over three years or more, then the soonest window", () => {
  const rows = [role("loose", "2027-01-10"), role("tight", "2027-09-01"), role("tied", "2027-08-01")];
  const rhythms = new Map([
    ["loose", { years: 4, spread: 90 }],
    ["tight", { years: 3, spread: 9 }],
    ["tied", { years: 5, spread: 9 }],
  ]);
  // A tighter rhythm wins over more years and over a sooner window; an equal rhythm is settled by the sooner window.
  assert.equal(featuredOf(rows, rhythms)?.role_id, "tied");
  assert.equal(featuredOf([role("loose", "2027-01-10"), role("tight", "2027-09-01")], rhythms)?.role_id, "tight");
});

test("a program with too few years cannot be featured while one with enough is there", () => {
  const rows = [role("two-years", "2027-01-05"), role("three-years", "2027-11-30")];
  const rhythms = new Map([["two-years", { years: 2, spread: 1 }], ["three-years", { years: 3, spread: 120 }]]);
  assert.equal(featuredOf(rows, rhythms)?.role_id, "three-years");
});

test("when nothing reaches three years the most years wins, then the soonest window", () => {
  const rows = [role("one", "2027-02-01"), role("two-late", "2027-12-01"), role("two-early", "2027-03-01")];
  const rhythms = new Map([["one", { years: 1, spread: 0 }], ["two-late", { years: 2, spread: 4 }], ["two-early", { years: 2, spread: 200 }]]);
  assert.equal(featuredOf(rows, rhythms)?.role_id, "two-early");
});

test("nothing to feature is null, and a role with no openings on record never wins", () => {
  assert.equal(featuredOf([], new Map()), null);
  assert.equal(featuredOf([role("unknown", "2027-02-01"), role("known", "2027-09-09")], new Map([["known", { years: 1, spread: 0 }]]))?.role_id, "known");
});

test("the same corpus always draws the same program", () => {
  const rows = [role("b", "2027-05-01"), role("a", "2027-05-01")];
  const rhythms = new Map([["a", { years: 3, spread: 12 }], ["b", { years: 3, spread: 12 }]]);
  assert.equal(featuredOf(rows, rhythms)?.role_id, "a");
  assert.equal(featuredOf([...rows].reverse(), rhythms)?.role_id, "a");
});
