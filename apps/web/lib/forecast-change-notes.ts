/**
 * What a change to a forecast means to the person watching the program.
 *
 * `forecast_changes` records every revision the model made, with the deltas the detector measured
 * (worker/src/firstseen/signals.py) and the reason codes it crossed. Those codes and those numbers are the machine's
 * account of itself: a reader has no use for "confidence_threshold_crossed", and a score that moved from 44.5 to 41.7
 * tells them nothing, because the score is not a probability and they were never shown it.
 *
 * So a change is only worth showing when the reader would feel it: the window they are planning around moved, or the
 * confidence word beside it changed. A revision that leaves the dates exactly where they were and only moves a number
 * behind them is not news, and is not shown at all.
 *
 * No `server-only` import, so the rules can be read directly by their test.
 */

// A relative import, so the rules can be read by a test without the bundler's path aliases.
import { confidenceWord } from "./confidence.ts";

/** One revision, as the stored before and after forecasts describe it. Deltas are in days, after minus before. */
export type ForecastChangeFacts = {
  startDeltaDays: number;
  endDeltaDays: number;
  confidenceBefore: number;
  confidenceAfter: number;
};

/** A stretch of time in words. Days up to a fortnight, then weeks, then months: nobody plans in 47 days. */
export function spanWords(days: number): string {
  const size = Math.abs(Math.round(days));
  if (size <= 1) return "a day";
  if (size < 14) return `${size} days`;
  if (size < 60) {
    const weeks = Math.round(size / 7);
    return weeks === 1 ? "a week" : `${weeks} weeks`;
  }
  const months = Math.round(size / 30);
  return months === 1 ? "a month" : `${months} months`;
}

/** Whether the window itself moved. Both ends where they were means the reader's plan is unchanged. */
export function windowMoved(facts: ForecastChangeFacts): boolean {
  return facts.startDeltaDays !== 0 || facts.endDeltaDays !== 0;
}

/** Whether the word beside the window changed: Low to Medium is news, 44.5 to 41.7 is not. */
export function confidenceWordChanged(facts: ForecastChangeFacts): boolean {
  return confidenceWord(facts.confidenceBefore) !== confidenceWord(facts.confidenceAfter);
}

/** Whether this revision is worth a reader's attention at all. */
export function isFelt(facts: ForecastChangeFacts): boolean {
  return windowMoved(facts) || confidenceWordChanged(facts);
}

/**
 * What changed, in the reader's own terms: short sentences, and never none when `isFelt` is true.
 *
 * The window's move is its middle moving, and its change of size is its two ends moving apart or together. A revision
 * that did both says both, because a window that slid a day and grew a month is not a window that slid a day.
 */
export function changeNotes(facts: ForecastChangeFacts): string[] {
  const notes: string[] = [];
  if (confidenceWordChanged(facts)) notes.push(`Now ${confidenceWord(facts.confidenceAfter).toLowerCase()} confidence`);
  const moved = Math.round((facts.startDeltaDays + facts.endDeltaDays) / 2);
  const widened = facts.endDeltaDays - facts.startDeltaDays;
  if (moved !== 0) notes.push(`Window moved ${spanWords(moved)} ${moved < 0 ? "earlier" : "later"}`);
  // A window that changed size by less than the detector's own three days is not worth a second sentence, unless it
  // is the only thing that happened: then it is why the reader is reading this at all.
  if (Math.abs(widened) >= 3 || (moved === 0 && widened !== 0)) {
    notes.push(`Window ${widened > 0 ? "widened" : "narrowed"} by ${spanWords(widened)}`);
  }
  return notes;
}
