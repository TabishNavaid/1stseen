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

export type ConfidenceWord = "Low" | "Medium" | "High";

/** The one word a card shows for the score, from the same bands as its tone: 75 and up is High, 60 to 74 Medium. */
export function confidenceWord(value: number): ConfidenceWord {
  const tone = confidenceTone(value);
  return tone === "strong" ? "High" : tone === "moderate" ? "Medium" : "Low";
}

const WORD_MEANING: Record<ConfidenceWord, string> = {
  High: "Plenty of consistent evidence backs this window.",
  Medium: "A fair amount of consistent evidence backs this window.",
  Low: "Only a little consistent evidence backs this window so far, so treat it as a rough guide.",
};

/** What the word means, for its tooltip: the band, then the score in its own words, never as a percentage. */
export function confidenceExplanation(value: number): string {
  const word = confidenceWord(value);
  return `${word} confidence. ${WORD_MEANING[word]} It is a ${confidencePhrase(value)}, which measures the evidence, not the chance the window is right.`;
}
