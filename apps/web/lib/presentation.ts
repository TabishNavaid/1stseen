import { displayPlace } from "./display-names.ts";

/**
 * Plain labels for the model fields a product surface shows. The exact field name stays visible in a role's
 * "Model details", so nothing is hidden; a heading just never reads like a column name.
 */

export type FactorTone = "positive" | "neutral" | "warning";

/**
 * forecasting.py's confidence factors, in the terms of its formula. Every factor raises the score except signals
 * against and signal conflict, which lower it, so their tone is inverted: a conflict of 0.00 is good news.
 */
const FACTORS: Record<string, { label: string; lowers?: true; signal?: true }> = {
  role_history_strength: { label: "This program's own openings" },
  prior_support: { label: "Company and role-family history" },
  cycle_consistency: { label: "Same time each cycle" },
  source_quality: { label: "Source quality" },
  evidence_recency: { label: "Recent evidence" },
  event_uncertainty_precision: { label: "Date precision" },
  interval_precision: { label: "Narrow window" },
  company_recruiting_scale: { label: "Company recruiting scale" },
  current_signal_support: { label: "Signals for", signal: true },
  signal_contradiction: { label: "Signals against", lowers: true, signal: true },
  signal_conflict: { label: "Signal conflict", lowers: true, signal: true },
};

export function factorLabel(key: string): string {
  return FACTORS[key]?.label ?? key.replace(/_/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

export function factorLowersConfidence(key: string): boolean {
  return Boolean(FACTORS[key]?.lowers);
}

export function factorTone(key: string, value: number): FactorTone {
  // No signal at all is neither good nor bad news: most roles have none.
  if (FACTORS[key]?.signal && value === 0) return "neutral";
  const good = factorLowersConfidence(key) ? 1 - value : value;
  return good >= 0.66 ? "positive" : good >= 0.33 ? "neutral" : "warning";
}

/** A normalized location scope as a place name (lib/display-names.ts); most postings state none. */
export function locationLabel(scope: string | null | undefined): string {
  return displayPlace(scope);
}

const CONTRIBUTIONS: Record<string, string> = {
  role_history: "An opening of this program",
  role_family_prior: "Similar programs across companies",
  company_prior: "This company's other programs",
};

export function contributionLabel(contribution: string): string {
  return CONTRIBUTIONS[contribution] ?? contribution.replace(/_/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

export function humanize(value: string): string {
  return value.replace(/_/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

/**
 * Why an opening's date is not exact, in the reader's words.
 *
 * `historical_opening_events.uncertainty_reason` is written by collection for the record
 * (worker/src/firstseen/history.py), in its own vocabulary: "absence boundary", "trustworthy earlier capture", "the
 * source supplied". Those are the words of a system explaining itself to its authors. A reason this does not
 * recognise is left out rather than shown raw, because a sentence from inside the machine is worse than no sentence.
 */
const UNCERTAINTY_REASONS: Array<[RegExp, string]> = [
  [/^The source supplied an explicit publication date\.$/i, "The posting itself carried this date."],
  [/absence boundary is available/i, "This is the first day 1stSeen saw it listed. It may have opened earlier."],
  [/No trustworthy earlier capture establishes absence/i, "No earlier copy of the page is on record, so it may have opened before this."],
];

export function uncertaintyReason(stored: string): string | null {
  const trimmed = stored.trim();
  if (!trimmed) return null;
  return UNCERTAINTY_REASONS.find(([pattern]) => pattern.test(trimmed))?.[1] ?? null;
}
