/**
 * A forecast's basis: whether its window rests mainly on the program's own openings or on comparable programs'
 * timing, read from forecasting.py's persisted contribution weights, never guessed.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BASIS, OWN_HISTORY_MAJORITY, basisLabel, basisPhrase, forecastBasis, forecastBasisFromContributions } from "../lib/forecast-basis.ts";

test("the basis is the majority of the window's weight, with its share", () => {
  const borrowed = forecastBasis(0.36, 0.64);
  assert.equal(borrowed.kind, "borrowed");
  assert.equal(basisLabel(borrowed), "Borrowed timing 64%");
  assert.match(basisPhrase(borrowed), /timing borrowed mainly from comparable programs \(64% of the weight\)/);

  const own = forecastBasis(0.72, 0.28);
  assert.equal(own.kind, "own");
  assert.equal(basisLabel(own), "Own history 72%");
  assert.match(basisPhrase(own), /own openings \(72% of the weight\)/);

  assert.equal(forecastBasis(OWN_HISTORY_MAJORITY, 1 - OWN_HISTORY_MAJORITY).kind, "own", "an even split rests on its own history");
  assert.equal(forecastBasis(0, 1).kind, "borrowed");
  assert.equal(forecastBasis(1, 0).kind, "own");
});

test("a forecast with no weighted evidence has no basis, rather than a guessed one", () => {
  assert.equal(forecastBasis(0, 0), null);
  assert.equal(forecastBasis(Number.NaN, 0), null);
  assert.equal(forecastBasisFromContributions([]), null);
});

test("contribution rows are read by class, and signals carry no weight toward either basis", () => {
  const basis = forecastBasisFromContributions([
    { contribution: "role_history", weight: 0.363 },
    { contribution: "role_family_prior", weight: 0.337 },
    { contribution: "company_prior", weight: 0.301 },
    { contribution: "signal", weight: 0 },
  ]);
  assert.equal(basis.kind, "borrowed");
  assert.equal(Math.round(basis.ownShare * 1000), 363);
  assert.equal(basisLabel(basis), "Borrowed timing 64%");
});

test("the two bases are told apart by label, icon, and colour, never by colour alone", () => {
  assert.notEqual(BASIS.own.label, BASIS.borrowed.label);
  assert.notEqual(BASIS.own.icon, BASIS.borrowed.icon);
  assert.notEqual(BASIS.own.className, BASIS.borrowed.className);
  for (const presentation of Object.values(BASIS)) assert.doesNotMatch(presentation.meaning, /probabilit|calibrat|chance/i);
});
