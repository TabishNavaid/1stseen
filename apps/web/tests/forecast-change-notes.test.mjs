/**
 * What a revision of a forecast says to the person watching it (lib/forecast-change-notes.ts).
 *
 * The watchlist used to show every revision of every program, with the score that moved and the reason code the
 * detector crossed: "Confidence up 0" beside "prediction_interval_threshold_crossed". These are the rules that
 * replaced it, and the first of them is that most revisions are not worth showing at all.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { changeNotes, confidenceWordChanged, isFelt, spanWords, windowMoved } from "../lib/forecast-change-notes.ts";

const facts = (over = {}) => ({ startDeltaDays: 0, endDeltaDays: 0, confidenceBefore: 40, confidenceAfter: 40, ...over });

test("a stretch of time is said the way a person would say it", () => {
  assert.equal(spanWords(0), "a day");
  assert.equal(spanWords(1), "a day");
  assert.equal(spanWords(-1), "a day");
  assert.equal(spanWords(9), "9 days");
  assert.equal(spanWords(14), "2 weeks");
  assert.equal(spanWords(-21), "3 weeks");
  assert.equal(spanWords(30), "4 weeks");
  assert.equal(spanWords(59), "8 weeks");
  assert.equal(spanWords(60), "2 months");
  assert.equal(spanWords(90), "3 months");
});

test("a revision that leaves the dates alone and only moves a score is not shown", () => {
  const scoreOnly = facts({ confidenceBefore: 44.5, confidenceAfter: 41.7 });
  assert.equal(windowMoved(scoreOnly), false);
  assert.equal(confidenceWordChanged(scoreOnly), false, "both are Low");
  assert.equal(isFelt(scoreOnly), false);
  // Even a large move of the score, while it stays inside one band, changes nothing the reader was ever shown.
  assert.equal(isFelt(facts({ confidenceBefore: 12, confidenceAfter: 59 })), false);
});

test("a revision is shown when the window moved, however little", () => {
  assert.equal(isFelt(facts({ startDeltaDays: 1, endDeltaDays: 1 })), true);
  assert.equal(isFelt(facts({ startDeltaDays: -2, endDeltaDays: 2 })), true);
});

test("a revision is shown when the word beside the window changed", () => {
  const crossed = facts({ confidenceBefore: 59, confidenceAfter: 61 });
  assert.equal(confidenceWordChanged(crossed), true);
  assert.equal(isFelt(crossed), true);
  assert.deepEqual(changeNotes(crossed), ["Now medium confidence"]);
  assert.deepEqual(changeNotes(facts({ confidenceBefore: 70, confidenceAfter: 80 })), ["Now high confidence"]);
});

test("a window that slid says how far and which way", () => {
  assert.deepEqual(changeNotes(facts({ startDeltaDays: -14, endDeltaDays: -14 })), ["Window moved 2 weeks earlier"]);
  assert.deepEqual(changeNotes(facts({ startDeltaDays: 3, endDeltaDays: 3 })), ["Window moved 3 days later"]);
});

test("a window that also changed size says that too", () => {
  // Slid a day and grew four: a reader planning around the end of it would notice the second more than the first.
  assert.deepEqual(changeNotes(facts({ startDeltaDays: -1, endDeltaDays: 3 })), ["Window moved a day later", "Window widened by 4 days"]);
  // Two days either side is a narrowing and nothing else.
  assert.deepEqual(changeNotes(facts({ startDeltaDays: 2, endDeltaDays: -2 })), ["Window narrowed by 4 days"]);
  // A change of size under the detector's own three days is not worth a second sentence beside a move.
  assert.deepEqual(changeNotes(facts({ startDeltaDays: 7, endDeltaDays: 9 })), ["Window moved 8 days later"]);
});

test("a felt revision always says something, and a word change leads", () => {
  const both = facts({ startDeltaDays: -30, endDeltaDays: -30, confidenceBefore: 59, confidenceAfter: 76 });
  assert.deepEqual(changeNotes(both), ["Now high confidence", "Window moved 4 weeks earlier"]);
  // Every combination that is felt produces at least one sentence, and no sentence carries a number out of the model.
  for (const start of [-9, -1, 0, 1, 9]) {
    for (const end of [-9, -1, 0, 1, 9]) {
      const item = facts({ startDeltaDays: start, endDeltaDays: end });
      if (!isFelt(item)) continue;
      const notes = changeNotes(item);
      assert.ok(notes.length > 0, `${start}/${end} says something`);
      for (const note of notes) assert.doesNotMatch(note, /_|\d+\.\d|confidence score/, note);
    }
  }
});
