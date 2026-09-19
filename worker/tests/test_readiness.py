from __future__ import annotations

import unittest
from datetime import date
from uuid import UUID

from firstseen.readiness import (
    ApplicationReadinessPlanner,
    ReadinessContext,
    ReadinessForecast,
    ReadinessPolicy,
)

ROLE_ID = UUID("00000000-0000-4000-8000-000000000011")
FORECAST_ID = UUID("00000000-0000-4000-8000-000000000501")


def forecast(
    *,
    as_of: date = date(2026, 8, 1),
    interval_start: date = date(2026, 10, 1),
    interval_end: date = date(2026, 10, 15),
    confidence: float = 82,
) -> ReadinessForecast:
    return ReadinessForecast(
        forecast_id=FORECAST_ID,
        role_id=ROLE_ID,
        as_of=as_of,
        expected_opening_date=interval_start + (interval_end - interval_start) / 2,
        interval_start=interval_start,
        interval_end=interval_end,
        confidence=confidence,
    )


class ApplicationReadinessPlannerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.planner = ApplicationReadinessPlanner()

    def test_small_company_uses_shorter_leads_and_only_relevant_milestones(self) -> None:
        plan = self.planner.plan(
            forecast(),
            ReadinessContext(
                company_size="small",
                recruiting_scale=0.2,
                role_competitiveness=0.3,
                role_family="operations",
            ),
        )

        self.assertEqual(plan.total_adjustment_days, -10)
        self.assertNotIn("portfolio_ready", {item.kind for item in plan.milestones})
        networking = next(item for item in plan.milestones if item.kind == "networking")
        self.assertEqual(networking.lead_days, 53)
        self.assertIn("Policy base: 63 days", networking.rationale)
        self.assertEqual(len(networking.adjustments), 5)

    def test_large_competitive_company_starts_preparation_earlier(self) -> None:
        small = self.planner.plan(
            forecast(),
            ReadinessContext(
                company_size="small",
                recruiting_scale=0.2,
                role_competitiveness=0.3,
                role_family="software_engineering",
            ),
        )
        large = self.planner.plan(
            forecast(),
            ReadinessContext(
                company_size="enterprise",
                recruiting_scale=0.9,
                role_competitiveness=0.9,
                role_family="software_engineering",
            ),
        )

        self.assertIn("portfolio_ready", {item.kind for item in large.milestones})
        self.assertGreater(large.total_adjustment_days, small.total_adjustment_days)
        self.assertLess(large.milestones[0].ideal_due_on, small.milestones[0].ideal_due_on)

    def test_uncertain_forecast_moves_every_deadline_earlier(self) -> None:
        stable = self.planner.plan(
            forecast(confidence=85),
            ReadinessContext(role_family="data_science"),
        )
        uncertain = self.planner.plan(
            forecast(
                interval_start=date(2026, 9, 15),
                interval_end=date(2026, 11, 14),
                confidence=50,
            ),
            ReadinessContext(role_family="data_science"),
        )

        self.assertGreater(uncertain.total_adjustment_days, stable.total_adjustment_days)
        for milestone in uncertain.milestones:
            factors = {item.factor: item.days for item in milestone.adjustments}
            self.assertGreater(factors["forecast_interval_width"], 0)
            self.assertGreater(factors["forecast_confidence"], 0)

        capped = ApplicationReadinessPlanner(ReadinessPolicy(maximum_adjustment_days=5)).plan(
            forecast(
                interval_start=date(2026, 9, 15),
                interval_end=date(2026, 11, 14),
                confidence=50,
            ),
            ReadinessContext(role_family="data_science"),
        )
        self.assertEqual(capped.total_adjustment_days, 5)

    def test_imminent_forecast_marks_missed_ideal_dates_due_now(self) -> None:
        as_of = date(2026, 8, 14)
        plan = self.planner.plan(
            forecast(
                as_of=as_of,
                interval_start=date(2026, 8, 16),
                interval_end=date(2026, 8, 22),
                confidence=75,
            ),
            ReadinessContext(role_family="software_engineering"),
        )

        self.assertEqual((plan.interval_start, plan.interval_end), (date(2026, 8, 16), date(2026, 8, 22)))
        self.assertTrue(all(item.is_immediate for item in plan.milestones))
        self.assertTrue(all(item.due_on == as_of for item in plan.milestones))
        self.assertTrue(all("due now" in item.rationale for item in plan.milestones))


if __name__ == "__main__":
    unittest.main()
