/**
 * Which of its states a stored forecast is in today, and the words for each.
 *
 * A forecast answers "when will this open", and the answer reads differently depending on where today falls in its
 * window. The three states below are the cases in FORECAST_COPY_CASES.md; the one that matters is the last, where the
 * expected date has passed and nothing has been seen open. Rendering that as "Likely around <a date in the past>"
 * puts a past date under a future-tense label, which is the one thing this must not do.
 *
 * Every state is a comparison of stored dates — `YYYY-MM-DD` strings compare correctly as text — so no date
 * arithmetic happens here and nothing is derived that the model did not store.
 *
 * Kept free of React and of path aliases, the way lib/dashboard-query.ts is, so the components, the pages and the
 * tests all read one set of rules under `node --experimental-strip-types`.
 */

export type Outlook = { expected: string; start: string; end: string };

export type WindowState =
  /** The window has not begun: `start` is still ahead. */
  | "ahead"
  /** The window has begun and the expected date is still ahead of it. */
  | "expected_ahead"
  /** The expected date has passed and no posting has been seen. */
  | "expected_passed";

/**
 * `today` is a calendar day, `YYYY-MM-DD`.
 *
 * `expected_passed` also covers a window whose end has passed, which is not a state the current model produces — a
 * window is open exactly while it contains today — but a forecast stored before that change can still be in it, and
 * "not seen open yet" is true of both.
 */
export function windowState(outlook: Outlook, today: string): WindowState {
  if (outlook.start > today) return "ahead";
  return outlook.expected > today ? "expected_ahead" : "expected_passed";
}

/**
 * What the date above the window is called. "Likely" is a prediction about a date still to come; once the window has
 * begun the model is no longer guessing at whether, only at when, so the word changes.
 */
export function outlookLabel(state: WindowState): string {
  return state === "ahead" ? "Likely around" : "Expected around";
}

/**
 * The fact that belongs beside the window, or null when the window alone says everything. It is the case where the
 * forecast is most likely wrong and the reader most needs to know it.
 */
export function outlookNote(state: WindowState): string | null {
  return state === "expected_passed" ? "Not seen open yet" : null;
}
