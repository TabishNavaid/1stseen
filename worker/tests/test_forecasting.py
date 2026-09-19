from __future__ import annotations

import json
import sys
import unittest
from datetime import UTC, date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from firstseen.forecasting import (
    MODEL_VERSION,
    HistoricalOpening,
    SeasonalityPrior,
    Signal,
    forecast_opening_window,
)


def interval_days(result) -> int:
    return (result.window_end - result.window_start).days


class ForecastingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.stable_history = [
            HistoricalOpening(date(2022, 9, 11), 0.9, evidence_id="history-2022"),
            HistoricalOpening(date(2023, 9, 15), 1.0, evidence_id="history-2023"),
            HistoricalOpening(date(2024, 9, 8), 1.0, evidence_id="history-2024"),
            HistoricalOpening(date(2025, 9, 13), 1.0, evidence_id="history-2025"),
        ]
        self.company_prior = SeasonalityPrior(
            "company internship season",
            9,
            12,
            spread_days=13,
            effective_sample_size=8,
            quality=0.9,
            evidence_ids=("company-prior-1",),
        )
        self.family_prior = SeasonalityPrior(
            "software internship season",
            9,
            8,
            spread_days=18,
            effective_sample_size=12,
            quality=0.85,
            evidence_ids=("family-prior-1",),
        )

    def test_stable_annual_cycles_produce_a_narrow_high_quality_window(self) -> None:
        result = forecast_opening_window(
            self.stable_history,
            as_of=date(2026, 8, 14),
            company_prior=self.company_prior,
            role_family_prior=self.family_prior,
            company_size="enterprise",
        )

        self.assertTrue(date(2026, 9, 5) <= result.point_date <= date(2026, 9, 18))
        self.assertLessEqual(interval_days(result), 30)
        self.assertGreater(result.confidence, 65)
        self.assertEqual(result.model_version, MODEL_VERSION)
        self.assertEqual(result.prediction_interval_coverage, 0.8)

    def test_high_variance_cycles_widen_interval_and_reduce_confidence(self) -> None:
        high_variance = [
            HistoricalOpening(date(2022, 7, 2), 0.9),
            HistoricalOpening(date(2023, 8, 24), 0.9),
            HistoricalOpening(date(2024, 10, 18), 0.9),
            HistoricalOpening(date(2025, 11, 29), 0.9),
        ]
        stable = forecast_opening_window(self.stable_history, as_of=date(2026, 6, 1))
        variable = forecast_opening_window(high_variance, as_of=date(2026, 6, 1))

        self.assertGreater(interval_days(variable), interval_days(stable))
        self.assertLess(variable.confidence, stable.confidence)

    def test_one_observation_shrinks_to_priors_without_claiming_high_certainty(self) -> None:
        result = forecast_opening_window(
            [
                HistoricalOpening(
                    date(2025, 9, 27), 0.95, uncertainty_days=4, date_precision="bounded"
                )
            ],
            as_of=date(2026, 8, 1),
            company_prior=self.company_prior,
            role_family_prior=self.family_prior,
        )

        self.assertTrue(date(2026, 9, 8) <= result.point_date <= date(2026, 9, 23))
        self.assertGreaterEqual(interval_days(result), 60)
        self.assertLessEqual(result.confidence, 56)
        self.assertTrue(any(item.kind == "company_prior" for item in result.feature_contributions))

    def test_two_observations_remain_conservatively_bounded(self) -> None:
        result = forecast_opening_window(
            [
                HistoricalOpening(date(2024, 9, 6), 0.9),
                HistoricalOpening(date(2025, 9, 19), 0.9),
            ],
            as_of=date(2026, 8, 1),
            company_prior=self.company_prior,
            role_family_prior=self.family_prior,
        )

        self.assertGreaterEqual(interval_days(result), 42)
        self.assertLessEqual(result.confidence, 69)
        self.assertEqual(result.sample_size, 2)

    def test_no_role_history_uses_company_and_role_family_priors(self) -> None:
        result = forecast_opening_window(
            [],
            as_of=date(2026, 8, 1),
            company_prior=self.company_prior,
            role_family_prior=self.family_prior,
        )

        self.assertEqual(result.sample_size, 0)
        self.assertTrue(date(2026, 9, 1) <= result.point_date <= date(2026, 9, 20))
        self.assertGreaterEqual(interval_days(result), 80)
        self.assertLessEqual(result.confidence, 48)
        self.assertGreater(result.prior_effective_sample_size, 0)
        company_contribution = next(
            item for item in result.feature_contributions if item.kind == "company_prior"
        )
        self.assertEqual(company_contribution.evidence_ids, self.company_prior.evidence_ids)

    def test_conflicting_signals_reduce_confidence_but_never_move_the_date(self) -> None:
        supportive = forecast_opening_window(
            self.stable_history,
            [Signal(date(2026, 7, 28), 0.9, 0.95, "career page changed")],
            as_of=date(2026, 8, 1),
        )
        conflicting = forecast_opening_window(
            self.stable_history,
            [
                Signal(date(2026, 7, 28), 0.9, 0.95, "career page changed"),
                Signal(
                    date(2026, 7, 30),
                    0.95,
                    0.95,
                    "program paused",
                    direction="contradict",
                ),
            ],
            as_of=date(2026, 8, 1),
        )

        self.assertEqual(supportive.point_date, conflicting.point_date)
        self.assertLess(conflicting.confidence, supportive.confidence)
        self.assertGreater(conflicting.confidence_factors["signal_conflict"], 0.8)

    def test_missing_optional_data_is_safe_and_missing_temporal_data_is_explicit(self) -> None:
        result = forecast_opening_window(self.stable_history, as_of=date(2026, 8, 1))
        self.assertEqual(result.confidence_factors["current_signal_support"], 0)
        with self.assertRaisesRegex(ValueError, "role history or a sourced"):
            forecast_opening_window([], as_of=date(2026, 8, 1))
        with self.assertRaisesRegex(ValueError, "after as_of"):
            forecast_opening_window([HistoricalOpening(date(2027, 1, 1))], as_of=date(2026, 8, 1))
        with self.assertRaisesRegex(ValueError, "Sparse role history requires"):
            forecast_opening_window([HistoricalOpening(date(2025, 9, 1))], as_of=date(2026, 8, 1))

    def test_cross_year_dates_are_modeled_circularly(self) -> None:
        history = [
            HistoricalOpening(date(2022, 12, 30)),
            HistoricalOpening(date(2023, 12, 31)),
            HistoricalOpening(date(2025, 1, 2)),
            HistoricalOpening(date(2026, 1, 1)),
        ]
        result = forecast_opening_window(history, as_of=date(2026, 12, 15))

        self.assertEqual(result.point_date.year, 2027)
        self.assertTrue(result.point_date >= date(2027, 1, 1) or result.point_date >= date(2026, 12, 20))
        self.assertLess(interval_days(result), 35)

    def test_year_end_prediction_interval_can_cross_calendar_year(self) -> None:
        history = [
            HistoricalOpening(date(2022, 12, 27)),
            HistoricalOpening(date(2023, 12, 30)),
            HistoricalOpening(date(2024, 12, 29)),
            HistoricalOpening(date(2025, 12, 31)),
        ]
        result = forecast_opening_window(history, as_of=date(2026, 12, 1))

        self.assertEqual(result.point_date.month, 12)
        self.assertEqual(result.window_start.year, 2026)
        self.assertEqual(result.window_end.year, 2027)

    def test_event_uncertainty_and_source_quality_affect_width_and_confidence(self) -> None:
        precise = forecast_opening_window(self.stable_history, as_of=date(2026, 8, 1))
        uncertain = forecast_opening_window(
            [
                HistoricalOpening(
                    item.opened_on, 0.45, uncertainty_days=40, date_precision="bounded"
                )
                for item in self.stable_history
            ],
            as_of=date(2026, 8, 1),
        )

        self.assertGreater(interval_days(uncertain), interval_days(precise))
        self.assertLess(uncertain.confidence, precise.confidence)

    def test_contributions_are_normalized_and_explain_date_vs_confidence_inputs(self) -> None:
        result = forecast_opening_window(
            self.stable_history,
            [Signal(date(2026, 7, 28), 0.8, 0.9, "ATS taxonomy update")],
            as_of=date(2026, 8, 1),
            company_prior=self.company_prior,
            company_size="large",
        )
        date_contributions = [item for item in result.feature_contributions if item.influences_date]
        signal = next(item for item in result.feature_contributions if item.kind == "signal")

        self.assertAlmostEqual(sum(item.date_weight for item in date_contributions), 1, places=3)
        self.assertFalse(signal.influences_date)
        self.assertEqual(signal.date_weight, 0)

    def test_forecast_timestamp_is_deterministic_unless_explicitly_supplied(self) -> None:
        default = forecast_opening_window(self.stable_history, as_of=date(2026, 8, 1))
        explicit_at = datetime(2026, 8, 1, 12, 30, tzinfo=UTC)
        explicit = forecast_opening_window(
            self.stable_history,
            as_of=date(2026, 8, 1),
            forecasted_at=explicit_at,
        )

        self.assertEqual(default.forecasted_at, datetime(2026, 8, 1, tzinfo=UTC))
        self.assertEqual(explicit.forecasted_at, explicit_at)
        self.assertEqual(default.input_fingerprint, explicit.input_fingerprint)
        self.assertRegex(default.input_fingerprint, r"^[a-f0-9]{64}$")
        self.assertEqual(explicit.to_dict()["expected_opening_date"], explicit.point_date.isoformat())
        json.dumps(explicit.to_dict())

    def test_seasonality_prior_can_be_derived_from_sourced_history(self) -> None:
        prior = SeasonalityPrior.from_history("company", self.stable_history)
        result = forecast_opening_window([], as_of=date(2026, 8, 1), company_prior=prior)

        self.assertTrue(date(2026, 9, 5) <= result.point_date <= date(2026, 9, 20))
        self.assertEqual(prior.effective_sample_size > 0, True)

    def test_company_scale_and_signal_recency_affect_confidence_not_date(self) -> None:
        recent = Signal(date(2026, 7, 30), 0.9, 0.9, "recent page change")
        stale = Signal(date(2025, 1, 1), 0.9, 0.9, "stale page change")
        small_stale = forecast_opening_window(
            self.stable_history,
            [stale],
            as_of=date(2026, 8, 1),
            company_size="startup",
        )
        large_recent = forecast_opening_window(
            self.stable_history,
            [recent],
            as_of=date(2026, 8, 1),
            company_size="enterprise",
        )

        self.assertEqual(small_stale.point_date, large_recent.point_date)
        self.assertGreater(large_recent.confidence, small_stale.confidence)
        self.assertGreater(
            large_recent.confidence_factors["current_signal_support"],
            small_stale.confidence_factors["current_signal_support"],
        )

    def test_unsourced_prior_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "sourced evidence IDs"):
            SeasonalityPrior("unsourced", 9, 1, 10, 4)

    def test_observed_by_dates_remain_censored_and_conservative(self) -> None:
        exact = forecast_opening_window(self.stable_history, as_of=date(2026, 8, 1))
        observed_by = forecast_opening_window(
            [
                HistoricalOpening(
                    item.opened_on,
                    item.source_quality,
                    uncertainty_days=None,
                    evidence_id=item.evidence_id,
                    date_precision="observed_by",
                )
                for item in self.stable_history
            ],
            as_of=date(2026, 8, 1),
        )
        self.assertGreater(interval_days(observed_by), interval_days(exact))
        self.assertLess(observed_by.confidence, exact.confidence)
        self.assertGreaterEqual(interval_days(observed_by), 90)

    def test_role_match_uncertainty_reduces_weight_and_confidence(self) -> None:
        strong = forecast_opening_window(self.stable_history, as_of=date(2026, 8, 1))
        weak = forecast_opening_window(
            [
                HistoricalOpening(
                    item.opened_on,
                    item.source_quality,
                    evidence_id=item.evidence_id,
                    role_match_confidence=0.45,
                )
                for item in self.stable_history
            ],
            as_of=date(2026, 8, 1),
        )
        self.assertLess(weak.confidence, strong.confidence)
        self.assertGreaterEqual(interval_days(weak), interval_days(strong))

    def test_duplicate_signal_evidence_cannot_inflate_confidence(self) -> None:
        signal = Signal(date(2026, 7, 28), 0.9, 0.9, "career page changed", evidence_id="s1")
        once = forecast_opening_window(self.stable_history, [signal], as_of=date(2026, 8, 1))
        duplicated = forecast_opening_window(
            self.stable_history, [signal, signal], as_of=date(2026, 8, 1)
        )
        self.assertEqual(once.confidence, duplicated.confidence)
        self.assertEqual(once.input_fingerprint, duplicated.input_fingerprint)
        with self.assertRaisesRegex(ValueError, "conflicting semantics"):
            forecast_opening_window(
                self.stable_history,
                [signal, Signal(date(2026, 7, 28), 0.9, 0.9, "program paused", "contradict", "s1")],
                as_of=date(2026, 8, 1),
            )

    def test_input_order_does_not_change_forecast_fingerprint(self) -> None:
        forward = forecast_opening_window(self.stable_history, as_of=date(2026, 8, 1))
        reverse = forecast_opening_window(reversed(self.stable_history), as_of=date(2026, 8, 1))
        self.assertEqual(forward.input_fingerprint, reverse.input_fingerprint)
        self.assertEqual(forward.to_dict(), reverse.to_dict())


if __name__ == "__main__":
    unittest.main()
