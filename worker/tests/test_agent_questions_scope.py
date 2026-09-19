"""The agent's portfolio questions answer truthfully about active, in-scope roles.

- A role retired by a re-resolution, or withdrawn with its company, is not answered about (migration 202608140036).
- "Which companies open earliest" counts recruiting cycles, not postings: reposts are not recruiting cycles,
  so openings are collapsed exactly as forecasting collapses them (cycles.py).
- It reads every event, not the first 1,000 PostgREST returns, and uses only openings whose date says when a program
  opened (exact, bounded), never an archive capture that only saw it (observed_by).
"""

from __future__ import annotations

import unittest
from datetime import date, timedelta
from typing import Any

from firstseen.agent_questions import (
    RoleForecastItem,
    SupabasePortfolioQueries,
    _in_product,
    basis_phrase,
    confidence_phrase,
    forecast_phrase,
)

ACTIVE_CO = "00000000-0000-4000-8000-0000000000a1"
RETIRED_CO = "00000000-0000-4000-8000-0000000000b2"
REPOST_CO = "00000000-0000-4000-8000-0000000000c3"
ROW_CAP = 1000


def _value(row: dict[str, Any], path: str) -> Any:
    for part in path.split("."):
        row = row.get(part) if isinstance(row, dict) else None  # type: ignore[assignment]
    return row


class _Query:
    """A PostgREST stand-in that honours the filters these reads use, and caps a response at 1000 rows."""

    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows
        self._range: tuple[int, int] | None = None

    def select(self, *_args: Any, **_kwargs: Any) -> _Query:
        return self

    def eq(self, column: str, value: Any) -> _Query:
        self._rows = [row for row in self._rows if _value(row, column) == value]
        return self

    def in_(self, column: str, values: list[Any]) -> _Query:
        self._rows = [row for row in self._rows if _value(row, column) in values]
        return self

    def order(self, column: str, *, desc: bool = False) -> _Query:
        self._rows = sorted(self._rows, key=lambda row: str(_value(row, column)), reverse=desc)
        return self

    def range(self, start: int, end: int) -> _Query:
        self._range = (start, end)
        return self

    def execute(self) -> Any:
        start, end = self._range or (0, len(self._rows) - 1)
        page = self._rows[start : min(end + 1, start + ROW_CAP)]
        return type("Result", (), {"data": page})()


class _Client:
    def __init__(self, tables: dict[str, list[dict[str, Any]]]) -> None:
        self._tables = tables

    def table(self, name: str) -> _Query:
        return _Query(list(self._tables[name]))


def _event(
    event_id: str,
    opened_on: date,
    company_id: str,
    name: str,
    *,
    role: str = "role-1",
    active: bool = True,
    precision: str = "exact",
    title: str = "Software Engineer Intern",
) -> dict[str, Any]:
    return {
        "id": event_id,
        "canonical_role_id": role,
        "opened_on": opened_on.isoformat(),
        "date_precision": precision,
        "raw_job_observations": {"raw_title": title},
        "canonical_roles": {
            "company_id": company_id,
            "recruiting_season": "summer",
            "scope_status": "in_scope",
            "active": active,
            "companies": {"name": name},
        },
    }


def _earliest(events: list[dict[str, Any]]) -> dict[str, int]:
    result = SupabasePortfolioQueries(_Client({"historical_opening_events": events})).earliest_companies(
        date(2026, 9, 17)
    )
    return {item.company: item.historical_cycle_count for item in result.items}


class InProductRoleTest(unittest.TestCase):
    def test_only_an_active_in_scope_role_is_in_the_product(self) -> None:
        self.assertTrue(_in_product({"scope_status": "in_scope", "active": True}))
        self.assertFalse(_in_product({"scope_status": "in_scope", "active": False}))
        self.assertFalse(_in_product({"scope_status": "in_scope"}), "a read that forgot to select active shows nothing")
        self.assertFalse(_in_product({"scope_status": "out_of_scope", "active": True}))

    def test_earliest_companies_never_ranks_a_retired_role(self) -> None:
        counts = _earliest(
            [
                _event("a1", date(2024, 8, 1), ACTIVE_CO, "Active Co"),
                _event("a2", date(2025, 8, 3), ACTIVE_CO, "Active Co"),
                _event("r1", date(2024, 1, 10), RETIRED_CO, "Withdrawn Co", role="role-r", active=False),
                _event("r2", date(2025, 1, 12), RETIRED_CO, "Withdrawn Co", role="role-r", active=False),
            ]
        )
        self.assertEqual(counts, {"Active Co": 2})


class EarliestCompaniesCountsCyclesTest(unittest.TestCase):
    def test_reposts_of_one_cohort_are_one_cycle(self) -> None:
        # Four postings of one program within a few months: one recruiting cycle, so the company has one and is not
        # ranked (a ranking needs two). The old answer counted four "historical cycles".
        reposts = [_event(f"p{index}", date(2025, 7, 1) + timedelta(days=25 * index), REPOST_CO, "Repost Co") for index in range(4)]
        self.assertEqual(_earliest(reposts), {})

    def test_two_annual_cycles_count_two(self) -> None:
        annual = [
            _event("y1", date(2024, 8, 5), REPOST_CO, "Repost Co"),
            _event("y1b", date(2024, 9, 20), REPOST_CO, "Repost Co"),
            _event("y2", date(2025, 8, 4), REPOST_CO, "Repost Co"),
        ]
        self.assertEqual(_earliest(annual), {"Repost Co": 2})

    def test_a_stated_cohort_is_one_cycle_however_far_apart(self) -> None:
        cohort = [
            _event("c1", date(2025, 3, 1), REPOST_CO, "Repost Co", title="Software Engineer Intern Summer 2026"),
            _event("c2", date(2026, 2, 20), REPOST_CO, "Repost Co", title="Software Engineer Intern Summer 2026"),
        ]
        self.assertEqual(_earliest(cohort), {}, "one stated cohort is one cycle even 356 days apart")

    def test_observed_by_openings_do_not_count(self) -> None:
        events = [
            _event("e1", date(2024, 8, 5), ACTIVE_CO, "Active Co"),
            _event("o1", date(2025, 8, 4), ACTIVE_CO, "Active Co", precision="observed_by"),
        ]
        self.assertEqual(_earliest(events), {}, "an archive capture date is not an opening date")

    def test_every_event_is_read_past_the_row_cap(self) -> None:
        # 1,500 events, with the two that make Late Co rankable at the end, where a single capped read never looked.
        filler = [
            _event(f"f{index:04d}", date(2025, 1, 1) + timedelta(days=index % 300), ACTIVE_CO, "Active Co", role=f"filler-{index}")
            for index in range(1_498)
        ]
        late = [
            _event("z1", date(2024, 10, 1), REPOST_CO, "Late Co", role="late"),
            _event("z2", date(2025, 10, 2), REPOST_CO, "Late Co", role="late"),
        ]
        self.assertEqual(_earliest(filler + late).get("Late Co"), 2)


class AnswerWordingTest(unittest.TestCase):
    def _item(self, **weights: float) -> RoleForecastItem:
        return RoleForecastItem(
            company_id=ACTIVE_CO,
            company="Active Co",
            role_id=ACTIVE_CO,
            role="Software Engineer Intern",
            track="internship",
            forecast_id=RETIRED_CO,
            expected_opening_date=date(2027, 9, 6),
            interval_start=date(2027, 8, 5),
            interval_end=date(2027, 10, 8),
            confidence=56.0,
            as_of=date(2026, 9, 17),
            model_version="hierarchical-circular-shrinkage-v2",
            **weights,
        )

    def test_a_forecast_is_a_window_with_a_score_and_a_basis_never_a_bare_date_or_a_percentage(self) -> None:
        text = forecast_phrase(self._item(own_history_weight=0.36, borrowed_weight=0.64))
        self.assertIn("window August 5 to October 8, 2027, expected September 6, 2027", text)
        self.assertIn("confidence score 56 of 100", text)
        self.assertIn("timing borrowed mainly from comparable programs (64% of the weight)", text)
        self.assertNotRegex(text, r"\d%\s*confidence|confidence[^;]{0,20}\d%")
        self.assertNotIn("around", text)

    def test_the_phrases_match_the_web_definitions(self) -> None:
        self.assertEqual(confidence_phrase(55.6), "confidence score 56 of 100")
        self.assertEqual(basis_phrase(0.72, 0.28), "based mainly on this program's own openings (72% of the weight)")
        self.assertEqual(basis_phrase(0.5, 0.5), "based mainly on this program's own openings (50% of the weight)")
        self.assertIsNone(basis_phrase(0, 0), "no weighted evidence, no basis")


if __name__ == "__main__":
    unittest.main()
