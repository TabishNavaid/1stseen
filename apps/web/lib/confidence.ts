/**
 * How a forecast's confidence is written, everywhere it appears.
 *
 * forecasting.py scores 0 to 100 how much consistent evidence backs a window. It is not the chance that the window is
 * right and never a calibrated probability, so it is never written with a percent sign.
 */

export type ConfidenceTone = "strong" | "moderate" | "limited";

/** What the number means, for the places that explain it: attached to the score, never a product-wide disclaimer. */
export const CONFIDENCE_MEANING =
  "The confidence score, 0 to 100, measures how much consistent evidence backs a window. It is not the chance that the window is right.";

export function confidenceTone(value: number): ConfidenceTone {
  return value >= 75 ? "strong" : value >= 60 ? "moderate" : "limited";
}

/** The score as shown beside its label: "48". One decimal only where the source value carries one. */
export function formatConfidence(value: number, digits = 0): string {
  return value.toFixed(digits);
}

/** The score with its scale, for a cell or a compact line: "48 / 100". */
export function confidenceOutOf(value: number, digits = 0): string {
  return `${formatConfidence(value, digits)} / 100`;
}

/** A sentence fragment for prose, emails, calendar events, and screen readers: "confidence score 48 of 100". */
export function confidencePhrase(value: number, digits = 0): string {
  return `confidence score ${formatConfidence(value, digits)} of 100`;
}
