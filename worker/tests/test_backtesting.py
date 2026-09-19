from __future__ import annotations

import json
import unittest
from datetime import UTC, date, datetime
from uuid import UUID

from firstseen.backtesting import (
    BacktestEvent,
    BacktestRole,
    BacktestRunner,
    BacktestSignal,
)


def available(year: int, month: int, day: int) -> datetime:
    return datetime(year, month, day, 12, tzinfo=UTC)


class BacktestLeakageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.roles = [
            BacktestRole(
                "role-swe", "company-a", "software", level="internship", recruiting_season="fall"
            ),
            BacktestRole(
                "role-design", "company-a", "design", level="internship", recruiting_season="fall"
            ),
            BacktestRole(
                "role-family-peer",
                "company-b",
                "software",
                level="internship",
                recruiting_season="fall",
            ),
        ]

    def test_target_and_all_future_available_evidence_are_excluded(self) -> None:
        events = [
            BacktestEvent("swe-2022", "role-swe", date(2022, 9, 10), available(2022, 9, 10), 0.9),
            BacktestEvent("swe-2023", "role-swe", date(2023, 9, 12), available(2023, 9, 12), 0.9),
            # Malformed availability must not leak the held-out actual into its own input.
            BacktestEvent("target-2024", "role-swe", date(2024, 9, 11), available(2020, 1, 1), 0.95),
            # A second evidence record for the held-out cycle must not leak either.
            BacktestEvent("target-duplicate", "role-swe", date(2024, 9, 11), available(2020, 1, 2), 0.70),
            BacktestEvent("future-date", "role-swe", date(2025, 9, 9), available(2023, 1, 1), 0.9),
            # A historical event discovered after the cutoff is also unavailable.
            BacktestEvent("late-discovery", "role-swe", date(2021, 9, 8), available(2025, 1, 1), 0.9),
            BacktestEvent("company-prior", "role-design", date(2023, 9, 4), available(2023, 9, 4), 0.8),
            BacktestEvent("family-prior", "role-family-peer", date(2023, 9, 18), available(2023, 9, 18), 0.8),
            BacktestEvent("future-prior", "role-design", date(2025, 9, 4), available(2023, 1, 1), 0.8),
        ]
        signals = [
            BacktestSignal(
                "known-signal", "role-swe", date(2024, 6, 1), available(2024, 6, 1), 0.6, 0.8, "page_change"
            ),
            BacktestSignal(
                "late-signal",
                "role-swe",
                date(2024, 6, 2),
                available(2024, 10, 1),
                0.8,
                0.9,
                "late_page_change",
            ),
            BacktestSignal(
                "future-signal",
                "role-swe",
                date(2025, 1, 1),
                available(2023, 1, 1),
                0.8,
                0.9,
                "future_page_change",
            ),
        ]

        result = BacktestRunner().run(
            self.roles,
            events,
            signals,
            cutoff_days=60,
            from_year=2024,
            to_year=2024,
            run_id=UUID("00000000-0000-4000-8000-000000000990"),
        )

        self.assertEqual(result.completed_cases, 1)
        self.assertEqual(result.target_count, 1)
        case = result.cases[0]
        self.assertEqual(case.forecast_cutoff, date(2024, 7, 13))
        self.assertEqual(
            set(case.input_event_ids),
            {"swe-2022", "swe-2023", "company-prior", "family-prior"},
        )
        self.assertEqual(case.input_signal_ids, ("known-signal",))
        self.assertNotIn(case.target_event_id, case.input_event_ids)
        self.assertLessEqual(case.latest_input_available_at.date(), case.forecast_cutoff)

    def test_empty_evaluation_uses_null_metrics_not_fake_zeroes(self) -> None:
        result = BacktestRunner().run(
            [BacktestRole("role", "company", "software")],
            [BacktestEvent("only", "role", date(2024, 9, 1), available(2024, 9, 1), 1.0)],
            from_year=2024,
            to_year=2024,
        )
        self.assertEqual(result.completed_cases, 0)
        self.assertEqual(result.skipped_cases, 1)
        self.assertIsNone(result.metrics.mean_absolute_error_days)
        self.assertIsNone(result.metrics.interval_coverage)
        payload = json.loads(result.to_json())
        self.assertIsNone(payload["metrics"]["median_absolute_error_days"])
        self.assertEqual(payload["cases"], [])

    def test_metrics_are_derived_from_completed_cases_and_grouped(self) -> None:
        events = [
            BacktestEvent(f"cycle-{year}", "role-swe", date(year, 9, day), available(year, 9, day), quality)
            for year, day, quality in [
                (2021, 2, 0.55),
                (2022, 12, 0.70),
                (2023, 7, 0.90),
                (2024, 18, 0.95),
                (2025, 10, 0.80),
            ]
        ]
        result = BacktestRunner().run(self.roles, events, cutoff_days=60, from_year=2024, to_year=2025)
        self.assertEqual(result.completed_cases, 2)
        errors = [case.absolute_error_days for case in result.cases]
        widths = [case.interval_width_days for case in result.cases]
        self.assertEqual(result.metrics.mean_absolute_error_days, round(sum(errors) / 2, 2))
        self.assertEqual(result.metrics.average_interval_width_days, round(sum(widths) / 2, 2))
        self.assertEqual(
            result.metrics.interval_coverage,
            round(sum(case.inside_interval for case in result.cases) / 2, 4),
        )
        self.assertEqual({item.group for item in result.performance_by_history}, {"0", "1", "2", "3", "4+"})
        self.assertEqual(
            {item.group for item in result.performance_by_source_quality}, {"low", "medium", "high"}
        )
        empty_history = next(item for item in result.performance_by_history if item.group == "0")
        self.assertEqual(empty_history.metrics.case_count, 0)
        self.assertIsNone(empty_history.metrics.mean_absolute_error_days)
        self.assertEqual(sum(item.case_count for item in result.confidence_calibration), 2)
        self.assertTrue(all(case.model_version == result.model_version for case in result.cases))

    def test_naive_availability_timestamp_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "timezone-aware"):
            BacktestEvent(
                "event",
                "role",
                date(2024, 1, 1),
                datetime(2024, 1, 1),  # noqa: DTZ001
                0.8,
            )

    def test_replay_returns_only_cutoff_safe_evidence_and_holds_out_actual(self) -> None:
        events = [
            BacktestEvent("swe-2021", "role-swe", date(2021, 9, 9), available(2021, 9, 9), 0.9),
            BacktestEvent("swe-2022", "role-swe", date(2022, 9, 12), available(2022, 9, 12), 0.9),
            BacktestEvent("swe-2023", "role-swe", date(2023, 9, 10), available(2023, 9, 10), 0.9),
            BacktestEvent("target-2024", "role-swe", date(2024, 9, 11), available(2020, 1, 1), 0.95),
            BacktestEvent("target-duplicate", "role-swe", date(2024, 9, 12), available(2020, 1, 2), 0.7),
            BacktestEvent("future-event", "role-swe", date(2025, 1, 2), available(2020, 1, 1), 1.0),
            BacktestEvent("late-archive", "role-swe", date(2020, 9, 1), available(2024, 8, 1), 1.0),
        ]
        signals = [
            BacktestSignal("known", "role-swe", date(2024, 6, 1), available(2024, 6, 1), 0.5, 0.8, "page_change"),
            BacktestSignal("future", "role-swe", date(2024, 8, 1), available(2020, 1, 1), 1.0, 1.0, "future"),
            BacktestSignal("late", "role-swe", date(2024, 6, 2), available(2024, 8, 1), 1.0, 1.0, "late"),
        ]
        result = BacktestRunner().replay(
            self.roles,
            events,
            signals,
            role_id="role-swe",
            target_year=2024,
            forecast_cutoff=date(2024, 7, 1),
        )

        evidence_ids = {item.id for item in result.evidence}
        self.assertEqual(evidence_ids, {"swe-2021", "swe-2022", "swe-2023", "known"})
        self.assertNotIn(result.target_event_id, evidence_ids)
        self.assertTrue(all(item.evidence_on <= result.forecast_cutoff for item in result.evidence))
        self.assertTrue(all(item.available_at.date() <= result.forecast_cutoff for item in result.evidence))
        self.assertEqual(result.actual_opened_on, date(2024, 9, 11))
        # The replayed forecast reports its basis from the model's own date weights: here three cycles of its own and
        # no comparable program, so all of the weight is its own history, and a signal adds none.
        self.assertGreater(result.own_history_weight, 0)
        self.assertEqual(result.borrowed_weight, 0)
        self.assertIn("own_history_weight", result.to_dict())

    def test_replay_forecast_is_identical_when_future_evidence_is_removed(self) -> None:
        safe_events = [
            BacktestEvent(f"cycle-{year}", "role-swe", date(year, 9, day), available(year, 9, day), 0.9)
            for year, day in [(2021, 8), (2022, 12), (2023, 10), (2024, 11)]
        ]
        unsafe_events = safe_events + [
            BacktestEvent("future", "role-swe", date(2025, 12, 31), available(2020, 1, 1), 1.0),
            BacktestEvent("late", "role-swe", date(2020, 1, 1), available(2024, 8, 1), 1.0),
        ]
        kwargs = {"role_id": "role-swe", "target_year": 2024, "forecast_cutoff": date(2024, 7, 1)}
        safe = BacktestRunner().replay(self.roles, safe_events, **kwargs)
        unsafe = BacktestRunner().replay(self.roles, unsafe_events, **kwargs)
        self.assertEqual(safe.input_fingerprint, unsafe.input_fingerprint)
        self.assertEqual(safe.expected_opening_date, unsafe.expected_opening_date)
        self.assertEqual(safe.interval_start, unsafe.interval_start)
        self.assertEqual(safe.interval_end, unsafe.interval_end)
        self.assertEqual(safe.confidence, unsafe.confidence)

    def test_replay_rejects_cutoff_on_or_after_actual_opening(self) -> None:
        events = [
            BacktestEvent(f"cycle-{year}", "role-swe", date(year, 9, 10), available(year, 9, 10), 0.9)
            for year in range(2021, 2025)
        ]
        with self.assertRaisesRegex(ValueError, "before the held-out opening"):
            BacktestRunner().replay(
                self.roles,
                events,
                role_id="role-swe",
                target_year=2024,
                forecast_cutoff=date(2024, 9, 10),
            )

    def test_linked_observation_and_role_match_availability_block_leakage(self) -> None:
        events = [
            BacktestEvent(
                f"safe-{year}",
                "role-swe",
                date(year, 9, 10),
                available(year, 9, 10),
                0.9,
            )
            for year in (2021, 2022, 2023)
        ]
        events.extend(
            [
                BacktestEvent(
                    "late-observation",
                    "role-swe",
                    date(2024, 9, 10),
                    available(2024, 1, 1),
                    0.9,
                    observation_available_at=available(2025, 8, 1),
                ),
                BacktestEvent(
                    "late-role-match",
                    "role-swe",
                    date(2020, 9, 10),
                    available(2020, 9, 10),
                    0.9,
                    role_match_available_at=available(2025, 8, 1),
                ),
                BacktestEvent(
                    "target-2025",
                    "role-swe",
                    date(2025, 9, 10),
                    available(2025, 9, 10),
                    0.95,
                ),
            ]
        )
        result = BacktestRunner().run(
            self.roles, events, cutoff_days=60, from_year=2025, to_year=2025
        )
        self.assertEqual(result.completed_cases, 1)
        self.assertNotIn("late-observation", result.cases[0].input_event_ids)
        self.assertNotIn("late-role-match", result.cases[0].input_event_ids)
        self.assertEqual(
            result.confidence_evaluation_target,
            "observed_opening_inside_prediction_interval",
        )

    def test_incompatible_level_and_season_cannot_form_sparse_priors(self) -> None:
        roles = [
            BacktestRole(
                "target", "company-a", "software", level="internship", recruiting_season="fall"
            ),
            BacktestRole(
                "company-peer", "company-a", "design", level="new_grad", recruiting_season="fall"
            ),
            BacktestRole(
                "family-peer", "company-b", "software", level="internship", recruiting_season="spring"
            ),
        ]
        events = [
            BacktestEvent("target-2023", "target", date(2023, 9, 10), available(2023, 9, 10), 0.9),
            BacktestEvent("company-2023", "company-peer", date(2023, 9, 1), available(2023, 9, 1), 0.9),
            BacktestEvent("family-2023", "family-peer", date(2023, 3, 1), available(2023, 3, 1), 0.9),
            BacktestEvent("target-2024", "target", date(2024, 9, 10), available(2024, 9, 10), 0.9),
        ]
        result = BacktestRunner().run(roles, events, from_year=2024, to_year=2024)
        self.assertEqual(result.completed_cases, 0)
        self.assertIn("no sourced company or role-family prior", result.skipped_targets[0].reason)

    def test_uncertain_targets_are_scored_without_pretending_the_date_is_exact(self) -> None:
        history = [
            BacktestEvent(
                f"cycle-{year}", "role-swe", date(year, 9, 10), available(year, 9, 10), 0.9
            )
            for year in (2021, 2022, 2023)
        ]
        bounded = BacktestEvent(
            "bounded-2024",
            "role-swe",
            date(2024, 9, 15),
            available(2024, 9, 20),
            0.8,
            uncertainty_days=20,
            date_precision="bounded",
            opening_window_start=date(2024, 9, 5),
            opening_window_end=date(2024, 9, 25),
        )
        result = BacktestRunner().run(
            self.roles, [*history, bounded], from_year=2024, to_year=2024
        )
        case = result.cases[0]
        self.assertEqual(case.actual_interval_start, date(2024, 9, 5))
        self.assertEqual(case.actual_interval_end, date(2024, 9, 25))
        self.assertEqual(case.target_date_precision, "bounded")
        self.assertEqual(case.absolute_error_days, 0)

        observed = bounded.__class__(
            "observed-2024",
            "role-swe",
            date(2024, 9, 20),
            available(2024, 9, 20),
            0.7,
            uncertainty_days=None,
            date_precision="observed_by",
        )
        skipped = BacktestRunner().run(
            self.roles, [*history, observed], from_year=2024, to_year=2024
        )
        self.assertEqual(skipped.completed_cases, 0)
        self.assertIn("observed-by only", skipped.skipped_targets[0].reason)

    def test_cycle_deduplication_is_not_a_calendar_year_bucket(self) -> None:
        events = [
            BacktestEvent("jan-2023", "role-swe", date(2023, 1, 3), available(2023, 1, 3), 0.9),
            BacktestEvent("dec-2023", "role-swe", date(2023, 12, 29), available(2023, 12, 29), 0.8),
            BacktestEvent("jan-duplicate", "role-swe", date(2024, 1, 2), available(2024, 1, 2), 1.0),
        ]
        collapsed = BacktestRunner._one_event_per_cycle(events)

        # The December/January pair is one cycle spanning the calendar boundary, so
        # three events must reduce to two cycles rather than three.
        self.assertEqual(len(collapsed), 2)
        # A cycle is dated by when it first opened, not by whichever duplicate record
        # carries the strongest source quality.
        self.assertEqual([item.id for item in collapsed], ["jan-2023", "dec-2023"])
        self.assertEqual([item.opened_on for item in collapsed], [date(2023, 1, 3), date(2023, 12, 29)])


if __name__ == "__main__":
    unittest.main()
