"""Signal observation writes: page text is untrusted bytes and must satisfy the column checks."""

from __future__ import annotations

import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from firstseen.adapters.base import SourceConfig
from firstseen.repository import IntelligenceRepository

OBSERVATION_ID = "00000000-0000-4000-8000-0000000000c1"
SOURCE = SourceConfig(
    id=UUID("00000000-0000-4000-8000-000000000101"),
    company_id=UUID("00000000-0000-4000-8000-000000000001"),
    company="Fixture Robotics",
    adapter="generic",
    url="https://fixture.example/jp/university",
    trust_score=0.85,
    options={},
)


class RecordingQuery:
    """Answers the duplicate lookup with no rows and records the insert payload."""

    def __init__(self, inserts: list[dict[str, Any]]) -> None:
        self.inserts = inserts
        self.inserting = False

    def select(self, columns: str) -> RecordingQuery:
        del columns
        return self

    def eq(self, column: str, value: str) -> RecordingQuery:
        del column, value
        return self

    def limit(self, count: int) -> RecordingQuery:
        del count
        return self

    def insert(self, payload: dict[str, Any]) -> RecordingQuery:
        self.inserts.append(payload)
        self.inserting = True
        return self

    def execute(self) -> Any:
        rows = [{"id": OBSERVATION_ID}] if self.inserting else []
        return type("Response", (), {"data": rows})()


class RecordingClient:
    def __init__(self) -> None:
        self.inserts: list[dict[str, Any]] = []

    def table(self, name: str) -> RecordingQuery:
        if name != "raw_job_observations":
            raise AssertionError(f"unexpected table {name}")
        return RecordingQuery(self.inserts)


class SignalObservationWriteTests(unittest.TestCase):
    def save(self, evidence_text: str) -> dict[str, Any]:
        client = RecordingClient()
        subject = IntelligenceRepository.__new__(IntelligenceRepository)
        subject.client = client  # type: ignore[assignment]
        observation_id = subject.save_signal_observation(
            SOURCE,
            observed_at=datetime(2026, 9, 14, 9, 55, tzinfo=UTC),
            document_hash="a" * 64,
            evidence_text=evidence_text,
            extraction_method="static_html",
        )
        self.assertEqual(observation_id, UUID(OBSERVATION_ID))
        self.assertEqual(len(client.inserts), 1)
        return client.inserts[0]

    def test_nul_and_control_characters_never_reach_postgres(self) -> None:
        # Databricks' /jp/university page carries NUL inside visible text, and Postgres text
        # cannot hold it: the whole observation was rejected with 22P05.
        payload = self.save("無料版にアクセ\x00ス\n教育者コミュニティ\x08に参加")
        for column in ("raw_text", "evidence_excerpt"):
            self.assertEqual(payload[column], "無料版にアクセス\n教育者コミュニティに参加")

    def test_non_ascii_text_fits_the_byte_checks_not_just_the_character_count(self) -> None:
        payload = self.save("採用" * 40_000)  # 80,000 characters, 240,000 UTF-8 bytes
        for column in ("raw_text", "evidence_excerpt"):
            self.assertLessEqual(len(payload[column].encode()), 65_536)
            self.assertTrue(payload[column].startswith("採用"))

    def test_text_that_is_only_noise_still_satisfies_the_non_empty_check(self) -> None:
        payload = self.save("\x00\x01 \x02")
        self.assertEqual(payload["raw_text"], "No visible recruiting content.")
        self.assertEqual(payload["evidence_excerpt"], "No visible recruiting content.")


if __name__ == "__main__":
    unittest.main()
