"""ATS categories are stored as source evidence without touching identity or content hashes."""

from __future__ import annotations

import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from firstseen.adapters.base import JobCandidate, SourceConfig, build_observation
from firstseen.models import AtsCategories, JobObservation
from firstseen.repository import IntelligenceRepository

SEEN = datetime(2026, 9, 14, 10, tzinfo=UTC)
SOURCE = SourceConfig(
    id=UUID("00000000-0000-4000-8000-000000000101"),
    company_id=UUID("00000000-0000-4000-8000-000000000001"),
    company="Fixture Robotics",
    adapter="ashby",
    url="https://jobs.example.test",
    trust_score=0.9,
    options={},
)


def observation(categories: AtsCategories | None) -> JobObservation:
    return JobObservation(
        source_id=SOURCE.id,
        external_job_id="301",
        identity_key="a" * 64,
        source_url="https://jobs.example.test/301",
        apply_url="https://jobs.example.test/301/apply",
        raw_title="Software Engineer Intern",
        company="Fixture Robotics",
        first_seen_at=SEEN,
        last_seen_at=SEEN,
        content_hash="b" * 64,
        source_type="ats",
        source_reliability={"score": 0.9},
        extraction_method="structured_endpoint",
        ats_categories=categories,
    )


class RecordingTable:
    """Answers the existing-row lookup and records writes."""

    def __init__(self, existing: list[dict[str, Any]]) -> None:
        self.existing = existing
        self.updates: list[dict[str, Any]] = []
        self.inserts: list[dict[str, Any]] = []

    def select(self, columns: str) -> RecordingTable:
        del columns
        return self

    def eq(self, column: str, value: object) -> RecordingTable:
        del column, value
        return self

    def limit(self, count: int) -> RecordingTable:
        del count
        return self

    def update(self, payload: dict[str, Any]) -> RecordingTable:
        self.updates.append(payload)
        return self

    def insert(self, payload: dict[str, Any]) -> RecordingTable:
        self.inserts.append(payload)
        return self

    def execute(self) -> Any:
        return type("Response", (), {"data": self.existing})()


class RecordingClient:
    def __init__(self, table: RecordingTable) -> None:
        self.recording = table

    def table(self, name: str) -> RecordingTable:
        if name != "raw_job_observations":
            raise AssertionError(f"unexpected table {name}")
        return self.recording


def repository(table: RecordingTable) -> IntelligenceRepository:
    subject = IntelligenceRepository.__new__(IntelligenceRepository)
    subject.client = RecordingClient(table)  # type: ignore[assignment]
    return subject


class AtsCategoryPersistenceTests(unittest.TestCase):
    def test_categories_are_kept_in_the_raw_payload(self) -> None:
        payload = IntelligenceRepository._job_payload(
            observation(AtsCategories(department="Engineering", team="Backend"))
        )
        self.assertEqual(
            payload["raw_payload"],
            {"external_job_id": "301", "ats_categories": {"department": "Engineering", "team": "Backend"}},
        )

    def test_a_posting_without_categories_keeps_the_old_payload_shape(self) -> None:
        self.assertEqual(IntelligenceRepository._job_payload(observation(None))["raw_payload"], {"external_job_id": "301"})

    def test_an_unchanged_posting_records_its_categories_and_nothing_else_moves(self) -> None:
        table = RecordingTable([{"id": "row-1", "first_seen_at": SEEN.isoformat(), "content_hash": "b" * 64}])

        outcome = repository(table).upsert_job(observation(AtsCategories(department="Engineering")))

        self.assertEqual(outcome, "unchanged")
        self.assertEqual(table.inserts, [])
        self.assertEqual(len(table.updates), 1)
        self.assertEqual(set(table.updates[0]), {"last_seen_at", "observed_at", "raw_payload"})
        self.assertEqual(table.updates[0]["raw_payload"]["ats_categories"], {"department": "Engineering"})

    def test_an_unchanged_posting_without_categories_only_touches_its_seen_time(self) -> None:
        table = RecordingTable([{"id": "row-1", "first_seen_at": SEEN.isoformat(), "content_hash": "b" * 64}])

        repository(table).upsert_job(observation(None))

        self.assertEqual(set(table.updates[0]), {"last_seen_at", "observed_at"})

    def test_categories_never_change_identity_or_content_hash(self) -> None:
        def built(categories: AtsCategories | None) -> JobObservation:
            candidate = JobCandidate(
                source_url="https://jobs.example.test/301",
                apply_url="https://jobs.example.test/301/apply",
                raw_title="Software Engineer Intern",
                company="Fixture Robotics",
                external_job_id="301",
                ats_categories=categories,
            )
            return build_observation(SOURCE, candidate, observed_at=SEEN, extraction_route="structured_endpoint")

        plain = built(None)
        filed = built(AtsCategories(department="Engineering", team="Backend"))
        self.assertEqual((plain.identity_key, plain.content_hash), (filed.identity_key, filed.content_hash))
        self.assertIsNone(built(AtsCategories()).ats_categories)


if __name__ == "__main__":
    unittest.main()
