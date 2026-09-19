# Forecasting ML audit

Audited 2026-08-14 against the production forecast, rolling backtest, replay, repository loading, role
resolution, historical reconstruction, signals, migrations, and shared web contracts.

## Material findings corrected

| Area | Finding | Correction |
| --- | --- | --- |
| Temporal leakage | Resolved-event availability was enforced, but linked raw-observation and role-match availability were not independently enforced. | Backtest and production admission now use the maximum of all three timestamps; signals also enforce raw-observation availability. |
| Uncertain dates | Null uncertainty on one-sided `observed_by` events became numeric zero in repository loading. | Null remains null; the model applies a documented 90-day conservative scale and observed-by targets are not quantitatively scored. |
| Held-out outcomes | Bounded and observed-by targets were compared with their representative dates as exact outcomes. | Bounded targets use interval-censored error and overlap coverage; observed-by targets are skipped with a reason. |
| Small samples | Confidence caps used raw cycle count, so several weak aliases could escape sparse-data limits. | Caps now use effective uncertainty-, quality-, recency-, and identity-weighted role evidence. |
| Priors | Company priors mixed levels and seasons, and diffuse priors could dominate through sample count. | Priors require matching known level and season and receive a spread-based precision discount. |
| Role resolution | Observation-to-role match confidence disappeared before forecasting. | Match confidence is persisted into backtest events, date weights, prior quality, and confidence features. |
| Signal weighting | Duplicate evidence IDs could add repeated support. | Signals are deduplicated; conflicting semantics under one ID fail validation. |
| Cycle identity | Calendar-year buckets merged distant January/December cycles and missed cross-year duplicates. | Same-role evidence is clustered within 45 days across year boundaries. |
| Reproducibility | Equal-date input order could affect serialized fingerprints and floating-point accumulation order. | History, evidence IDs, and signals are sorted deterministically before modeling and hashing. |
| Calibration claims | Heuristic confidence was compared with positive-only interval coverage and described too strongly. | Output declares the evaluated target; documentation treats it as conditional reliability, not recurrence-probability calibration. |

## Evaluation execution

The automated rolling-origin, leakage, replay, uncertain-target, prior-compatibility, signal-deduplication,
and deterministic-order backtests run in the worker test suite. The persisted CLI backtest was also invoked,
but this workspace has no configured `SUPABASE_URL` and service-role key, so no database-backed performance
run or metric was generated. No benchmark number is inferred from fixtures or written into documentation.

## Residual research limitations

- The confidence score remains a conservative heuristic until prospective positive and reviewed negative
  outcomes support calibration on a training period and evaluation on a later untouched period.
- The 80% interval is a nominal parametric construction. Backtest coverage should be monitored, not assumed.
- The 90-day observed-by uncertainty scale and 45-day cycle merge threshold are versioned policy choices,
  not learned values. They should change only through a new model version and untouched-period evaluation.
- The annual circular model cannot represent multiple cohorts, cancellation, or structural breaks. Those
  require explicit role identity or a survival/state-space replacement rather than ad hoc interval shrinkage.
