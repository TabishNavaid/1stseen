"""The agent's role-history step counts recruiting cycles, not postings: a repost is not a new cycle.

It said "Checked 11 historical recruiting cycles" for a role with 11 opening events, most of them reposts inside one
season. Openings are grouped into cycles exactly as forecasting groups them (cycles.py).
"""

from __future__ import annotations

import unittest
from datetime import date, timedelta
from uuid import UUID

from firstseen.agent import EvidenceRef, RoleHistoryItem, recruiting_cycle_count


def _opening(index: int, opened_on: date, cycle_key: str | None = None) -> RoleHistoryItem:
    return RoleHistoryItem(
        event_id=UUID(f"00000000-0000-4000-8000-{index:012d}"),
        opened_on=opened_on,
        window_start=opened_on,
        window_end=opened_on,
        precision="exact",
        uncertainty_days=0,
        evidence=EvidenceRef(
            id=f"event-{index}",
            kind="history",
            source_url="https://boards.greenhouse.io/example/jobs/1",
            observed_at=f"{opened_on.isoformat()}T12:00:00Z",
            content_hash="a" * 64,
            summary="Applications opened.",
            reliability=0.9,
        ),
        cycle_key=cycle_key,
    )


class RecruitingCycleCountTest(unittest.TestCase):
    def test_reposts_in_one_season_are_one_cycle(self) -> None:
        reposts = [_opening(index, date(2025, 8, 1) + timedelta(days=20 * index)) for index in range(5)]
        self.assertEqual(recruiting_cycle_count(reposts), 1)

    def test_annual_openings_are_one_cycle_each(self) -> None:
        annual = [_opening(1, date(2023, 9, 8)), _opening(2, date(2024, 9, 19)), _opening(3, date(2025, 9, 11))]
        self.assertEqual(recruiting_cycle_count(annual), 3)

    def test_a_named_cohort_is_one_cycle_however_far_apart(self) -> None:
        cohort = [_opening(1, date(2025, 3, 1), "summer-2026"), _opening(2, date(2026, 2, 20), "summer-2026")]
        self.assertEqual(recruiting_cycle_count(cohort), 1)

    def test_no_openings_is_no_cycles(self) -> None:
        self.assertEqual(recruiting_cycle_count([]), 0)


if __name__ == "__main__":
    unittest.main()
