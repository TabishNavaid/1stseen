/**
 * A forecast's basis: whether its window rests mainly on the program's own past openings or on timing borrowed from
 * comparable programs.
 *
 * forecasting.py weighs every contribution to a window and persists the weights in `forecast_evidence`: the program's
 * own openings (`role_history`), and, when its own history is short, the company's other programs (`company_prior`)
 * and similar programs elsewhere at the same level and season (`role_family_prior`). The weights sum to one per
 * forecast. The basis is read straight from them; nothing here computes a forecast.
 *
 * Cycle count alone does not say it: on the rig a one-cycle forecast takes anywhere from 1% to 89% of its weight from
 * its own openings, depending on how consistent the comparable programs are. So the basis is shown as data wherever a
 * forecast appears, as its own labelled class beside the evidence classes of `lib/precision.ts`, and always with its
 * share.
 *
 * Kept free of React so tests can read it under `node --experimental-strip-types`.
 */

import type { IconName } from "@/components/ui/icon-names";

export type ForecastBasisKind = "own" | "borrowed";

export type ForecastBasis = {
  kind: ForecastBasisKind;
  /** Share of the window's weight from the program's own openings, 0 to 1. */
  ownShare: number;
  /** Share from comparable programs, 0 to 1. */
  borrowedShare: number;
};

/** At least this share from its own openings, and a forecast rests mainly on its own history. */
export const OWN_HISTORY_MAJORITY = 0.5;

export const BASIS: Record<ForecastBasisKind, { label: string; icon: IconName; className: string; meaning: string; share: (basis: ForecastBasis) => number; of: string }> = {
  own: {
    label: "Own history",
    icon: "history",
    className: "basis-own",
    meaning: "Most of the window's weight comes from this program's own past openings.",
    share: (basis) => basis.ownShare,
    of: "of the weight from this program's own openings",
  },
  borrowed: {
    label: "Borrowed timing",
    icon: "git-merge",
    className: "basis-borrowed",
    meaning:
      "Most of the window's weight comes from comparable programs (this company's other programs, or similar programs elsewhere at the same level and season), because this program's own history is short.",
    share: (basis) => basis.borrowedShare,
    of: "of the weight from comparable programs",
  },
};

export const BASIS_ORDER: readonly ForecastBasisKind[] = ["own", "borrowed"];

/**
 * The basis from a forecast's persisted weights, or null when the forecast has no weighted evidence to read it from.
 * A null is shown as nothing, never as a guessed basis.
 */
export function forecastBasis(ownWeight: number, borrowedWeight: number): ForecastBasis | null {
  const own = Number.isFinite(ownWeight) && ownWeight > 0 ? ownWeight : 0;
  const borrowed = Number.isFinite(borrowedWeight) && borrowedWeight > 0 ? borrowedWeight : 0;
  const total = own + borrowed;
  if (total <= 0) return null;
  const ownShare = own / total;
  return { kind: ownShare >= OWN_HISTORY_MAJORITY ? "own" : "borrowed", ownShare, borrowedShare: 1 - ownShare };
}

/** The basis from contribution rows, as the role page and a replay hold them: `contribution` and `weight`. */
export function forecastBasisFromContributions(rows: ReadonlyArray<{ contribution: string; weight: number }>): ForecastBasis | null {
  let own = 0;
  let borrowed = 0;
  for (const row of rows) {
    if (row.contribution === "role_history") own += row.weight;
    else if (row.contribution === "company_prior" || row.contribution === "role_family_prior") borrowed += row.weight;
  }
  return forecastBasis(own, borrowed);
}

/** "Borrowed timing 64%": the chip's words, the share of the basis it names. */
export function basisLabel(basis: ForecastBasis): string {
  const presentation = BASIS[basis.kind];
  return `${presentation.label} ${Math.round(presentation.share(basis) * 100)}%`;
}

/** For prose, email, calendar events, and screen readers: "timing borrowed from comparable programs (64% of the weight)". */
export function basisPhrase(basis: ForecastBasis): string {
  const percent = Math.round(BASIS[basis.kind].share(basis) * 100);
  return basis.kind === "own"
    ? `based mainly on this program's own openings (${percent}% of the weight)`
    : `timing borrowed mainly from comparable programs (${percent}% of the weight)`;
}
