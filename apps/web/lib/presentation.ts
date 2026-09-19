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

/** A normalized location scope as a place name; most postings state none. */
export function locationLabel(scope: string | null | undefined): string {
  if (!scope || scope === "unspecified") return "Location not stated";
  return scope
    .split(" ")
    .map((word) => (word.length <= 2 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
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
