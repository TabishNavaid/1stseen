/**
 * How model fields read on product surfaces. Confidence is a score, never a percentage; confidence factors are
 * colored by what they do to the score; locations and contributions read as plain words.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { CONFIDENCE_MEANING, confidenceOutOf, confidencePhrase, confidenceTone, formatConfidence } from "../lib/confidence.ts";
import { contributionLabel, factorLabel, factorLowersConfidence, factorTone, locationLabel } from "../lib/presentation.ts";

test("a confidence score is written out of 100 and never with a percent sign", () => {
  assert.equal(formatConfidence(47.6), "48");
  assert.equal(confidenceOutOf(47.6, 1), "47.6 / 100");
  assert.equal(confidencePhrase(71), "confidence score 71 of 100");
  for (const text of [formatConfidence(56), confidenceOutOf(56), confidencePhrase(56)]) assert.doesNotMatch(text, /%|probab|chance/i);
  assert.deepEqual([confidenceTone(80), confidenceTone(60), confidenceTone(59.9)], ["strong", "moderate", "limited"]);
});

test("factors that lower confidence are colored by what they do to the score", () => {
  // forecasting.py subtracts signal contradiction and conflict; a conflict of 0.00 is good news, not a warning.
  assert.equal(factorLowersConfidence("signal_conflict"), true);
  assert.equal(factorTone("signal_conflict", 0.9), "warning");
  assert.equal(factorTone("signal_contradiction", 0.1), "positive");
  assert.equal(factorTone("signal_conflict", 0), "neutral", "no signal at all is neutral");
  assert.equal(factorTone("current_signal_support", 0), "neutral");
  assert.equal(factorTone("cycle_consistency", 0.12), "warning");
  assert.equal(factorTone("prior_support", 1), "positive");
  assert.equal(factorLabel("interval_precision"), "Narrow window");
  assert.equal(factorLabel("some_new_factor"), "Some new factor", "an unknown field still reads as words");
});

test("locations and contributions read as plain words", () => {
  assert.equal(locationLabel("unspecified"), "Location not stated");
  assert.equal(locationLabel(null), "Location not stated");
  assert.equal(locationLabel("new york ny"), "New York NY");
  assert.equal(contributionLabel("role_history"), "An opening of this program");
  assert.equal(contributionLabel("company_prior"), "This company's other programs");
  assert.doesNotMatch(contributionLabel("role_family_prior"), /_/);
});

test("the confidence score's meaning says what it measures and that it is not the chance the window is right", () => {
  assert.match(CONFIDENCE_MEANING, /0 to 100, measures how much consistent evidence backs a window/);
  assert.match(CONFIDENCE_MEANING, /not the chance that the window is right/);
  // The score is never a calibrated probability, and never written as a percentage.
  assert.doesNotMatch(CONFIDENCE_MEANING, /calibrat|probabilit|%/i);
});
