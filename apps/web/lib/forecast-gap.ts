/**
 * Why a role has no forecast window, stated once for every surface that lists one.
 *
 * forecasting.py forecasts a program with three or more recruiting cycles of its own from that history alone, and one
 * with fewer only when a comparable program (the same level and recruiting season, at the same company or in the same
 * field) gives it a timing to borrow. Otherwise it raises InsufficientEvidenceError and nothing is stored. Every stored
 * forecast is shown (migration 202608140035), so a role without one is a role the model refused, and this says why in
 * plain words. It is a statement about the history, not an error: the openings that exist are listed beside it.
 *
 * The count is of recorded openings. Openings less than 300 days apart without a stated cohort are one cycle
 * (docs/forecasting-methodology.md), so three openings can still be fewer than three cycles.
 *
 * Before this, the dashboard card, the role page and the calendar each said "a forecast needs two cycles", which was
 * true of no surface: 119 forecasts on the rig rest on one cycle, and 245 one-cycle roles have none.
 */

const WORDS = ["No", "One", "Two"] as const;

function openingsPhrase(openings: number): string {
  const count = openings < WORDS.length ? WORDS[openings] : openings.toLocaleString("en-US");
  return `${count} opening${openings === 1 ? "" : "s"} recorded`;
}

/** One sentence for a list row or a calendar entry. */
export function noForecastReason(openings: number): string {
  if (openings <= 0) return "No opening recorded yet, and no comparable program to learn its timing from.";
  const cycles = openings >= 3 ? ", in fewer than three distinct cycles" : "";
  return `${openingsPhrase(openings)}${cycles}: too little history on its own, and no comparable program to learn its timing from.`;
}

/** The same fact for a card, in the fewest words: no cycles, no comparable programs, just what there is. */
export function plainNoForecastReason(openings: number): string {
  if (openings <= 0) return "No past opening on record yet, so there is nothing to predict from.";
  return `Not enough history to predict the next opening yet: ${openings === 1 ? "one past opening" : `${openings.toLocaleString("en-US")} past openings`} on record.`;
}

/** The role page's fuller statement, with how many of the openings carry an exact date. */
export function noForecastExplanation(openings: number, exact: number): string {
  if (openings <= 0) {
    return "No opening of this program has been recorded yet, and no comparable program gives the model a timing to borrow, so there is nothing to forecast from.";
  }
  const dated = exact === 0
    ? "none with an exact date"
    : exact === openings
      ? (openings === 1 ? "with an exact date" : "all with exact dates")
      : `${exact} with an exact date`;
  const recorded = `${openingsPhrase(openings)}, ${dated}.`;
  return `${recorded} A program with fewer than three distinct recruiting cycles is forecast only when a comparable program (the same level and recruiting season, at this company or in the same field) gives the model a timing to borrow, and none does yet.`;
}

/**
 * Whether a stored forecast is current (migration 202608140043). When forecast regeneration finds a role it can no
 * longer forecast, it records the refusal on the role, and every earlier version becomes history until the model
 * forecasts the role again. forecast_role_states and forecast_basis apply the same rule in SQL.
 */
export function forecastIsCurrent(forecastedAt: string | null | undefined, refusedAt: string | null | undefined): boolean {
  if (!refusedAt || !forecastedAt) return true;
  return Date.parse(forecastedAt) > Date.parse(refusedAt);
}
