"""Forecast regeneration re-forecasts a role whose evidence moved or went, not only one that gained evidence.

An opening moved to another program by a re-resolution creates no row, so the role that lost it kept a forecast built
from it ("3 cycles behind it" beside 2 openings on the rig). Migration 202608140042 records such roles in
role_evidence_changes; changed_role_ids_since reads it beside new fetches, events, signals, and scope decisions.
"""

from __future__ import annotations

import unittest
from datetime import datetime
from typing import Any
from uuid import UUID

from firstseen.repository import IntelligenceRepository

LOST = UUID("00000000-0000-4000-8000-00000000000a")
GAINED = UUID("00000000-0000-4000-8000-00000000000b")
NEW_EVENT = UUID("00000000-0000-4000-8000-00000000000c")
OLD_CHANGE = UUID("00000000-0000-4000-8000-00000000000d")


class _Query:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self._rows = rows
        self._range: tuple[int, int] | None = None

    def select(self, *_args: Any, **_kwargs: Any) -> _Query:
        return self

    def eq(self, column: str, value: Any) -> _Query:
        self._rows = [row for row in self._rows if row.get(column) == value]
        return self

    def gt(self, column: str, value: str) -> _Query:
        self._rows = [row for row in self._rows if str(row.get(column, "")) > value]
        return self

    def in_(self, column: str, values: list[Any]) -> _Query:
        self._rows = [row for row in self._rows if row.get(column) in values]
        return self

    def order(self, column: str, **_kwargs: Any) -> _Query:
        self._rows = sorted(self._rows, key=lambda row: str(row.get(column)))
        return self

    def range(self, start: int, end: int) -> _Query:
        self._range = (start, end)
        return self

    def execute(self) -> Any:
        start, end = self._range or (0, len(self._rows) - 1)
        return type("Result", (), {"data": self._rows[start : end + 1]})()


class _Client:
    def __init__(self, tables: dict[str, list[dict[str, Any]]]) -> None:
        self._tables = tables

    def table(self, name: str) -> _Query:
        return _Query(list(self._tables.get(name, [])))


def _repository(tables: dict[str, list[dict[str, Any]]]) -> IntelligenceRepository:
    repository = IntelligenceRepository.__new__(IntelligenceRepository)
    repository.client = _Client(tables)  # type: ignore[assignment]
    return repository


class ChangedRolesTest(unittest.TestCase):
    def test_a_role_that_lost_or_gained_a_moved_opening_is_regenerated(self) -> None:
        since = "2026-09-18T00:00:00+00:00"
        tables = {
            "historical_opening_events": [
                {"id": "e1", "canonical_role_id": str(NEW_EVENT), "created_at": "2026-09-18T01:00:00+00:00"}
            ],
            "role_evidence_changes": [
                {"id": 1, "canonical_role_id": str(LOST), "changed_at": "2026-09-18T02:00:00+00:00"},
                {"id": 2, "canonical_role_id": str(GAINED), "changed_at": "2026-09-18T02:00:00+00:00"},
                {"id": 3, "canonical_role_id": str(OLD_CHANGE), "changed_at": "2026-09-17T23:00:00+00:00"},
            ],
        }
        changed = _repository(tables).changed_role_ids_since(datetime.fromisoformat(since))
        self.assertEqual(set(changed), {NEW_EVENT, LOST, GAINED}, "a change before the cursor was already handled")

    def test_the_first_pass_reads_every_recorded_change(self) -> None:
        tables = {"role_evidence_changes": [{"id": 1, "canonical_role_id": str(LOST), "changed_at": "2026-01-01T00:00:00+00:00"}]}
        self.assertEqual(_repository(tables).changed_role_ids_since(None), [LOST])


if __name__ == "__main__":
    unittest.main()
