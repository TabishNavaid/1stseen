"""Watchlist resolution: shared matching rules, and reads that page to exhaustion."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from firstseen.repository import IntelligenceRepository, _follow_covers_role

USER_A = "00000000-0000-4000-8000-0000000000a1"
USER_B = "00000000-0000-4000-8000-0000000000a2"
ROLE = {
    "id": "00000000-0000-4000-8000-0000000000f1",
    "company_id": "00000000-0000-4000-8000-0000000000b1",
    "role_family": "software_engineering",
    "track": "internship",
    "scope_status": "in_scope",
}


class FakeQuery:
    """Records range() calls so pagination can be asserted, not assumed."""

    def __init__(self, table: FakeTable) -> None:
        self.table = table
        self._filter: tuple[str, str] | None = None
        self._range: tuple[int, int] | None = None
        self._limit: int | None = None

    def select(self, columns: str) -> FakeQuery:
        self.table.selected_columns.append(columns)
        return self

    def eq(self, column: str, value: str) -> FakeQuery:
        self._filter = (column, value)
        return self

    def limit(self, count: int) -> FakeQuery:
        self._limit = count
        return self

    def order(self, column: str, *, desc: bool = False) -> FakeQuery:
        self.table.orders.append(column)
        return self

    def range(self, start: int, end: int) -> FakeQuery:
        self._range = (start, end)
        return self

    def execute(self) -> Any:
        self.table.executions += 1
        rows = list(self.table.rows)
        if self._filter:
            column, value = self._filter
            rows = [row for row in rows if str(row.get(column)) == value]
        if self._range is not None:
            start, end = self._range
            self.table.ranges.append((start, end))
            rows = rows[start : end + 1]
        elif self._limit is not None:
            rows = rows[: self._limit]
        return type("Response", (), {"data": rows})()


class FakeTable:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows
        self.executions = 0
        self.ranges: list[tuple[int, int]] = []
        self.selected_columns: list[str] = []
        self.orders: list[str] = []


class FakeClient:
    def __init__(self, tables: dict[str, list[dict[str, Any]]]) -> None:
        self.tables = {name: FakeTable(rows) for name, rows in tables.items()}

    def table(self, name: str) -> FakeQuery:
        return FakeQuery(self.tables[name])


def repository(tables: dict[str, list[dict[str, Any]]]) -> IntelligenceRepository:
    subject = IntelligenceRepository.__new__(IntelligenceRepository)
    subject.client = FakeClient(tables)  # type: ignore[attr-defined]
    return subject


class FollowMatchingTests(unittest.TestCase):
    def test_each_target_type_covers_only_its_own_dimension(self) -> None:
        cases = [
            ({"target_type": "canonical_role", "canonical_role_id": ROLE["id"]}, True),
            ({"target_type": "canonical_role", "canonical_role_id": "other"}, False),
            ({"target_type": "company", "company_id": ROLE["company_id"]}, True),
            ({"target_type": "company", "company_id": "other"}, False),
            ({"target_type": "role_family", "role_family": "software_engineering"}, True),
            ({"target_type": "role_family", "role_family": "product"}, False),
            ({"target_type": "track", "track": "internship"}, True),
            ({"target_type": "track", "track": "new_grad"}, False),
        ]
        for follow, expected in cases:
            with self.subTest(follow=follow):
                self.assertIs(_follow_covers_role(follow, ROLE), expected)

    def test_an_unknown_target_type_covers_nothing(self) -> None:
        # Membership is explicit; a target type this build does not understand
        # must never be treated as a follow.
        self.assertFalse(_follow_covers_role({"target_type": "vibes"}, ROLE))


class WatchlistReadTests(unittest.TestCase):
    def test_watchers_by_role_maps_every_covered_role(self) -> None:
        subject = repository(
            {
                "watchlist_items": [
                    {"user_id": USER_A, "target_type": "canonical_role",
                     "canonical_role_id": ROLE["id"]},
                    {"user_id": USER_B, "target_type": "track", "track": "internship"},
                ],
                "canonical_roles": [
                    ROLE,
                    {"id": "00000000-0000-4000-8000-0000000000f2",
                     "company_id": "00000000-0000-4000-8000-0000000000b9",
                     "role_family": "product", "track": "new_grad", "scope_status": "in_scope"},
                ],
            }
        )

        watchers = subject.watchers_by_role()

        self.assertEqual(list(watchers), [UUID(ROLE["id"])])
        self.assertEqual(watchers[UUID(ROLE["id"])], sorted([UUID(USER_A), UUID(USER_B)], key=str))
        # An unfollowed role must not appear at all.
        self.assertNotIn("00000000-0000-4000-8000-0000000000f2", {str(key) for key in watchers})

    def test_watched_role_ids_derives_from_the_same_map(self) -> None:
        subject = repository(
            {
                "watchlist_items": [
                    {"user_id": USER_A, "target_type": "company",
                     "company_id": ROLE["company_id"]}
                ],
                "canonical_roles": [ROLE],
            }
        )

        self.assertEqual(subject.watched_role_ids(), [UUID(ROLE["id"])])

    def test_reads_page_past_the_postgrest_row_cap(self) -> None:
        # PostgREST truncates at db.max_rows and reports no error, so a single
        # unpaged read would silently drop followed roles beyond the cap.
        roles = [
            {"id": f"00000000-0000-4000-8000-{index:012d}", "company_id": ROLE["company_id"],
             "role_family": "software_engineering", "track": "internship", "scope_status": "in_scope"}
            for index in range(1500)
        ]
        subject = repository(
            {
                "watchlist_items": [
                    {"user_id": USER_A, "target_type": "company",
                     "company_id": ROLE["company_id"]}
                ],
                "canonical_roles": roles,
            }
        )

        watchers = subject.watchers_by_role()

        self.assertEqual(len(watchers), 1500)
        client: Any = subject.client
        self.assertGreater(len(client.tables["canonical_roles"].ranges), 1)

    def test_single_role_lookup_does_not_read_every_role(self) -> None:
        subject = repository(
            {
                "watchlist_items": [
                    {"user_id": USER_A, "target_type": "track", "track": "internship"}
                ],
                "canonical_roles": [
                    ROLE,
                    {"id": "00000000-0000-4000-8000-0000000000f2",
                     "company_id": "00000000-0000-4000-8000-0000000000b9",
                     "role_family": "product", "track": "new_grad", "scope_status": "in_scope"},
                ],
            }
        )

        self.assertEqual(subject.list_role_watchers(UUID(ROLE["id"])), [UUID(USER_A)])
        client: Any = subject.client
        # The role table is filtered to the one role, never ranged over.
        self.assertEqual(client.tables["canonical_roles"].ranges, [])


if __name__ == "__main__":
    unittest.main()
