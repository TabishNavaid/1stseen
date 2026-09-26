"""Re-deriving an opening that has not changed must not rewrite its row.

Reconstruction runs over every cycle on every pass and upserted them all: about 19,000 events a run, each an
`INSERT ... ON CONFLICT DO UPDATE` that writes a new version of the row whether or not a single value differs. That is
roughly 25 MB of row versions a run left dead for autovacuum, for no change to the corpus. A bloat fix, not a
correctness one -- the rows were always right.
"""

from __future__ import annotations

import unittest
from datetime import date
from types import SimpleNamespace
from uuid import UUID

from firstseen.models import HistoricalOpeningEvent
from firstseen.repository import IntelligenceRepository

ROLE = UUID("00000000-0000-4000-8000-000000000301")
OBSERVATION = UUID("00000000-0000-4000-8000-000000000401")


def event() -> HistoricalOpeningEvent:
    return HistoricalOpeningEvent(
        canonical_role_id=ROLE,
        observation_id=OBSERVATION,
        opened_on=date(2025, 9, 13),
        closed_on=None,
        evidence_quote="Applications for the 2026 internship are open.",
        source_quality=0.9,
        opening_window_start=date(2025, 9, 13),
        opening_window_end=date(2025, 9, 13),
        date_precision="exact",
        uncertainty_days=0,
        uncertainty_reason="source supplied the publication date",
        resolution_method="ats_published_at_v3",
        provenance=[{"source": "greenhouse", "collected_by": "current_jobs"}],
    )


class RowComparisonTests(unittest.TestCase):
    def test_a_row_the_database_already_holds_is_not_rewritten(self) -> None:
        payload = IntelligenceRepository.event_payload(event())
        # What PostgREST hands back: every scalar as a string, jsonb parsed, keys in whatever order it chose.
        stored = {
            key: (value if isinstance(value, (dict, list)) else None if value is None else str(value))
            for key, value in payload.items()
        }
        # The same provenance, with the object's keys in the order PostgREST happened to return them.
        stored["provenance"] = [{"collected_by": "current_jobs", "source": "greenhouse"}]
        self.assertTrue(
            IntelligenceRepository._event_row_matches(payload, stored),
            "a reordered jsonb key is not a change, and comparing dicts by repr would have said it was",
        )

    def test_a_real_difference_is_still_written(self) -> None:
        payload = IntelligenceRepository.event_payload(event())
        for column, changed in (
            ("date_precision", "bounded"),
            ("uncertainty_days", "9"),
            ("resolution_method", "archive_capture_v2"),
            ("evidence_quote", "Different text."),
            ("provenance", [{"source": "lever", "collected_by": "current_jobs"}]),
            ("closed_on", "2025-10-01"),
        ):
            with self.subTest(column=column):
                stored = {
                    key: (value if isinstance(value, (dict, list)) else None if value is None else str(value))
                    for key, value in payload.items()
                }
                stored[column] = changed
                self.assertFalse(IntelligenceRepository._event_row_matches(payload, stored))

    def test_an_event_the_database_does_not_hold_is_written(self) -> None:
        self.assertFalse(IntelligenceRepository._event_row_matches(IntelligenceRepository.event_payload(event()), {}))

    def test_every_column_the_upsert_writes_is_also_read_back(self) -> None:
        """Otherwise a column could differ while the comparison called the row unchanged."""
        written = set(IntelligenceRepository.event_payload(event()))
        read = set(IntelligenceRepository.STORED_EVENT_COLUMNS.split(","))
        self.assertEqual(written - read, set(), "a written column the comparison never reads")


class _Table:
    def __init__(self, recorder: list[str]) -> None:
        self.recorder = recorder

    def upsert(self, rows, on_conflict):
        self.recorder.append(f"upsert:{len(rows)}")
        return SimpleNamespace(execute=lambda: SimpleNamespace(data=[]))


class UpsertIsSkippedTests(unittest.TestCase):
    def test_nothing_is_sent_when_every_event_already_matches(self) -> None:
        calls: list[str] = []
        stored_payload = IntelligenceRepository.event_payload(event())

        class Repo(IntelligenceRepository):
            def __init__(self) -> None:  # no client, no HTTP
                self.client = SimpleNamespace(table=lambda name: _Table(calls))

            def stored_events(self, events):
                key = (
                    stored_payload["canonical_role_id"],
                    str(stored_payload["opened_on"]),
                    stored_payload["observation_id"],
                )
                return {key: dict(stored_payload)}

        Repo().save_historical_openings([event()])
        self.assertEqual(calls, [], "an unchanged cycle sends no write at all")

    def test_a_changed_event_is_still_sent(self) -> None:
        calls: list[str] = []

        class Repo(IntelligenceRepository):
            def __init__(self) -> None:
                self.client = SimpleNamespace(table=lambda name: _Table(calls))

            def stored_events(self, events):
                return {}

        Repo().save_historical_openings([event()])
        self.assertEqual(calls, ["upsert:1"])


if __name__ == "__main__":
    unittest.main()
