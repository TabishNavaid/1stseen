# Opening-window backtesting methodology

## Rolling-origin design

1stSeen uses rolling-origin evaluation. For each scoreable historical cycle, it hides the target and rebuilds
production inputs as of a cutoff 60 days before the earliest defensible target date by default. Exact targets
use their exact date. Bounded targets use their lower bound, ensuring the cutoff cannot accidentally occur
after the role may already have opened.

An event is admitted only when all of these are on or before the cutoff:

1. the historical opening or representative evidence date;
2. the resolved event's `available_at` timestamp;
3. the linked raw observation's availability; and
4. the persisted observation-to-role match availability.

Signals require both their observed/available timestamps and linked raw-observation availability. The target
ID and every same-role/year duplicate are held out regardless of malformed timestamps. Availability uses UTC
calendar days. These checks close leakage through late archive discovery, late normalization, and future role
resolution—not only through the obvious event date.

## Historical reconstruction and priors

Inputs are rebuilt independently for every target. Evidence within 45 days for the same canonical annual role
is treated as one cycle, including December/January duplicates; distinct January and December cycles are not
merged merely because they share a calendar year. Each cluster prefers exact over bounded over observed-by
evidence, then stronger identity confidence, source quality, lower uncertainty, and earlier availability.
Company priors use other roles at the same company; role-family priors use other companies.
Both require the same known level and recruiting season as the target. The direct, company, and family sets are
disjoint, so an event is not counted twice.

Sparse targets with one or two direct cycles are skipped when no compatible sourced prior exists. Targets with
no temporal evidence are also skipped. This mirrors production rather than inventing a benchmark forecast.

## Uncertain held-out outcomes

Exact held-out dates are scored as points. Bounded dates are interval-censored outcomes:

- absolute date error is zero when the forecast point lies in the actual interval, otherwise its distance to
  the nearest interval boundary;
- interval coverage is true when the forecast interval overlaps the defensible actual interval.

An observed-by target has only an upper observation bound and no known actual opening interval. It is excluded
from quantitative metrics with an explicit skip reason. Treating its capture date as exact would manufacture
errors and coverage outcomes. Every completed case stores the representative date, actual interval bounds, and
target precision. Backtest output schema version 2 reflects this semantic change.

## What production can score today

The first production backtest ran on 2026-09-20 over the hosted corpus (79 companies, 516 in-scope roles) and
scored **0 of 632 targets** in 69 seconds. Both skip reasons are the design working, not a failure:

| Skipped | Why |
| --- | --- |
| 468 | No temporal evidence existed by the forecast cutoff. Scoring a 2016 opening leakage-safely needs evidence from before 2016, and the archive coverage behind those cycles does not reach back that far. |
| 164 | The held-out opening is observed-by only, so there is no actual interval to score against. |

14,453 out-of-scope targets were excluded before any of this, as they should be.

So **the forecast model's accuracy is currently unmeasured on production data**, and no calibration claim can be
made from it. Two things change that, both slow by nature: the weekly historical run deepening archive evidence
before each cycle, and more openings arriving with an exact `published_at` rather than an observed-by boundary.
Until a run reports a non-zero `case_count`, treat the published confidence intervals as the model's own stated
uncertainty, not as validated calibration.

## Metrics and confidence diagnostics

Metrics use completed cases only; empty aggregates are JSON `null`.

- Median and mean absolute date error use the interval-censored distance above.
- Interval coverage is the fraction of forecast intervals overlapping scoreable actual intervals.
- Average interval width is the forecast end minus start in calendar days.
- History slices contain 0, 1, 2, 3, and 4+ direct observations.
- Source-quality slices use the held-out event quality, independent of forecast input features.

The legacy `confidence_calibration` buckets compare displayed confidence with the binary outcome “observed
opening interval overlapped the prediction interval.” Runs declare this target explicitly as
`observed_opening_inside_prediction_interval`. This is a conditional reliability diagnostic among roles that
did open; it cannot calibrate the probability that a role opens because the dataset has no reviewed negative
outcomes. Small buckets are descriptive only. No coefficient is fitted on the evaluated cases.

## Reproducibility and audit records

Every run stores model and output schema versions, cutoff policy, dataset fingerprint, timestamps, aggregate
and sliced metrics, cases, and skipped reasons. Every case stores the held-out target and interval, exact input
event and signal IDs, model fingerprint, and latest effective input availability. Database constraints require
the target to be absent from inputs and the latest input availability to be cutoff-safe.

The CLI operates only on configured Supabase data and persists the computed run:

```bash
.venv/bin/firstseen backtest --cutoff-days 60
.venv/bin/firstseen backtest --from-year 2022 --to-year 2025
```

The repository seeds no backtest benchmark and this document reports no performance number. Model selection,
prior tuning, or confidence recalibration must use a separately defined training period and a later untouched
evaluation period; the current rolling report must not be optimized in place.

## Forecast Replay

Replay uses the same admission rules and production model for one role/cycle. Future and late-discovered
evidence cannot change its fingerprint. Exact and bounded targets may be replayed and retain actual interval
semantics; observed-by targets are rejected as unscoreable. The later outcome is introduced only after the
forecast to compute interval-censored error and coverage. Replay output schema version 2 exposes target precision
and actual interval bounds to the UI.
