# Opening-window forecasting methodology

## Scope and model contract

1stSeen models recurring recruiting openings as annual temporal events. The production model is
`hierarchical-circular-shrinkage-v3`. It is deterministic, interpretable, and replaceable through the
`OpeningWindowModel` protocol. No LLM chooses dates, weights, intervals, confidence, or readiness dates.

The forecast is conditional on the sourced role identity and recurrence assumption. It estimates the next
annual opening phase; it does not claim that an employer must run the program again.

## Version 2 audit changes

The ML audit corrected four material version-1 assumptions:

- one-sided archive `observed_by` evidence is no longer converted from null uncertainty to zero;
- observation-to-role match confidence now reduces temporal weight and evidence confidence;
- company and role-family priors require matching known role level and recruiting season; and
- broad priors are precision-discounted, while duplicate signal evidence cannot accumulate repeatedly.

The model version changed because identical legacy inputs can now produce wider intervals and lower
confidence. Stored version-1 forecasts remain immutable.

## Version 3: which cycle the estimate names

Version 2 took the next occurrence of the posterior centre at or after `as_of`, so one day past the centre the
estimate jumped a whole cycle. Measured over the rig's 115 scoreable backtest cases, 50 of them — 43% — named a
date a median 353 days after the cutoff when the held-out opening was 60 days after it, and 42 of those landed
300 to 365 days out. A modest centre error was being converted into a ten-month one, and that, not the width of
the intervals, is why measured coverage read 50.4% against the nominal 0.80.

Version 3 names the cycle whose own window covers `as_of`, and the next one once that window has closed. The test
is the role's own half-width, which makes the rule self-consistent. Measured, intervals unchanged:

| | v2 | v3 |
|---|---|---|
| interval coverage | 50.4% | **76.5%** |
| mean absolute error | 140.6 d | **61.2 d** |
| median absolute error | 59.0 d | 59.0 d |
| p80 absolute error | 298 d | 87 d |
| average interval width | 162 d | 162 d |

So the intervals were never the defect, and widening them was the wrong fix: 73 of the 115 cases already sat at
the 90-day cap, and reaching 80% coverage by widening alone required a 3.5× multiplier and a median 630-day
window. Grace windows of 75, 90, 105 and 120 days all reached 76.5% coverage, and a flat 90 scored marginally better on
mean error (58.6 d). It was not chosen: a flat grace wider than a role's own window leaves a third state — centre
passed, window closed, next cycle not yet named — which no stored field can render, because the model publishes one
date. On the rig at 2026-09-26 that state held 33 of 149 forecasts. Tying the grace to the half-width holds coverage
at 76.5%, costs 2.6 days of mean error, and leaves none.

Two consequences are deliberate. The point date can be in the past whenever its window still covers today, which is
a fact about the program rather than an error: that cycle has opened. So a forecast is in one of exactly two states,
both derivable from stored fields — `window_start > today` (ahead) or `window_start <= today <= window_end` (open
now) — and the product says which. Measured on the rig: 37 ahead and 112 open now at 2026-09-26, 149 ahead and none
open at 2026-12-15, so neither state is an edge case and the mix is seasonal. And confidence does not move:
`interval_precision` reads the half-width, which is unchanged, and the sparse cap binds 118 of 149 regardless.

**This is measured under a content-availability assumption**, because the production backtest completes zero
cases: every event's availability is when 1stSeen collected it, so nothing is admissible before a cutoff that
precedes collection. The assumption treats an opening's own date as when it was publicly visible. It measures the
model, never what the product would have known, and no accuracy figure is published from it.

## Inputs and uncertain dates

Each role event contains a representative date, source quality, evidence ID, date precision, uncertainty
width, and role-match confidence.

- `exact`: source-supplied date and zero uncertainty.
- `bounded`: representative midpoint plus a positive closed interval width.
- `observed_by`: the role existed by the observation date, with no defensible lower bound.

Bounded uncertainty uses the stored interval width. An observed-by event is not assigned a fabricated lower
date; for variance and weighting only, version 2 applies a conservative 90-day uncertainty scale. This makes
the capture a weak annual-phase observation while preventing it from behaving like an exact publication date.

Sparse forecasts may use company and role-family priors. A prior is admitted only from other roles with the
same known level and recruiting season. Unknown or conflicting populations are not pooled. Every prior must
carry evidence IDs; no hand-authored date can silently become a prior.

## Circular date representation

Calendar dates are normalized to a phase on a `365.2425`-day circle:

```text
theta_i = 2 pi d_i / 365.2425
mu = atan2(sum_i w_i sin(theta_i), sum_i w_i cos(theta_i))
```

This keeps December 31 and January 2 close. The center is mapped to the first occurrence on or after `as_of`.
Inputs and evidence IDs are sorted before arithmetic and fingerprinting, so input order cannot change output.

## Direct-event weights

For event `i`, with effective uncertainty `u_i` and role-identity confidence `r_i`:

```text
w_i = 0.86 ^ age_years
      * max(0.01, source_quality_i * r_i)
      * 1 / (1 + (u_i / 21)^2)
```

Measurement variance follows a uniform bounded-window approximation, `u_i^2 / 12`. Observed-by evidence uses
the documented 90-day scale, not zero. Role-history strength and circular consistency use these effective
weights, so a low-confidence alias cannot count like a verified recurring-program match.

## Hierarchical shrinkage for sparse roles and prior quality

Company and role-family priors enter as capped pseudo-observations with effective sample-size caps of `3.0`
and `2.5`. Prior multipliers remain `1.00`, `0.80`, `0.55`, `0.25`, and `0.10` for zero, one, two, three, and
four-or-more direct cycles. A prior's contribution is additionally multiplied by:

```text
max(0.10, exp(-prior_spread_days / 45))
```

This prevents a diffuse or multimodal population prior from dominating a sparse role merely because it has
many observations. With no direct history and no compatible sourced prior, the model refuses to forecast.

## Prediction interval

The model combines each component's measurement or historical spread with its circular distance from the
posterior center. It applies the normal 80% multiplier `1.282` and a sparse-data half-width floor of 42, 32,
22, 12, or 7 days for zero through four-plus direct cycles. Recruiting scale can adjust that floor by at most
five percent in either direction. Half-width is capped at `MAX_HALF_WIDTH_DAYS`, 90 days. The same half-width decides
which cycle the estimate names (see version 3 above), so a window is open exactly while it contains `as_of`.

`prediction_interval_coverage = 0.80` is the nominal construction target, not a claim of demonstrated 80%
coverage. Empirical coverage is reported only by backtests and is never improved by narrowing intervals.

## Evidence confidence and signals

The displayed confidence is a bounded, versioned evidence-sufficiency score combining effective role-history
weight, prior support, circular consistency, source and identity quality, recency, date precision, interval
precision, recruiting scale, and current signals. The legacy storage field is named `calibrated_probability`,
but version 2 is not empirically probability-calibrated; a dataset containing non-openings is not yet available.
It must not be presented as a measured probability that the employer will open the role.

The conservative affine mapping remains `0.08 + 0.84 * raw_score`, with caps of 0.48, 0.56, 0.69, 0.82,
and 0.92. Version 2 selects the cap from effective role-history weight—not raw row count—at thresholds 0.50,
1.25, 2.25, and 3.25. Four weak aliases or censored captures therefore cannot escape sparse-data limits by
count alone. These are policy caps, not learned calibration coefficients.

Signals affect confidence only. Each term is `strength * reliability * exp(-age_days / 45)`, then support and
contradiction sums are separately saturated. Conflicting evidence subtracts an additional bounded term.
Signals never move the date or interval. Identical evidence IDs are counted once; conflicting semantics under
one evidence ID fail validation rather than silently changing confidence.

## Provenance, reproducibility, and limitations

Every forecast stores normalized date weights, confidence-only contributions, evidence IDs, model version,
nominal interval target, input fingerprint, and forecast timestamp. The fingerprint includes sorted history,
date precision, role-match confidence, compatible priors, deduplicated signals, `as_of`, and company context.

The model still assumes approximately annual recurrence and does not model cancellations, structural breaks,
multiple cohorts, selection bias, or employer survival explicitly. Confidence cannot be empirically calibrated
until prospective forecasts include both openings and defensible non-opening outcomes. A future survival or
Bayesian hierarchical model may replace this implementation without weakening provenance contracts.

## Recruiting-cycle identity (what `sample_size` counts)

Version: `recruiting-cycle-identity-v1` (`worker/src/firstseen/cycles.py`).

`sample_size` is the number of **recruiting cycles (cohorts)**, not the number of
historical opening events. A historical opening event records one requisition
publication; a cycle is the annual instance of a recurring program. Live boards
publish evergreen roles several times a year, and each republication carries a
genuine `first_published` timestamp, so counting events would inflate history and
let a role escape the sparse-history confidence caps without any annual program
existing.

Events collapse into cycles in two tiers:

1. **Explicit cohort evidence.** A target year stated in the posting title, combined
   with the recruiting season when present, yields a cohort key such as `fall-2026`.
   Postings naming the same cohort are one cycle however far apart they were
   published; postings naming different cohorts are distinct cycles even when close
   together. A season alone is not a cohort, and the publication year is never used
   to infer one — a Fall 2026 internship is commonly posted during 2025.
2. **No cohort evidence.** Distinctness is unproven, so openings closer together than
   `ANNUAL_CYCLE_MIN_GAP_DAYS` (300) remain a single cycle. Ambiguity collapses rather
   than inflating sample size.

A cycle is dated by its earliest opening; stronger-quality duplicates only break ties
on that date. A new requisition ID alone is never a new cycle.

This is distinct from `backtesting.CYCLE_MERGE_DAYS` (45), which remains unchanged and
only deduplicates near-identical evidence for the same opening. Leak-safe evaluation
excludes every representation of the held-out cohort, so a late repost of the target
cannot enter its own inputs.
