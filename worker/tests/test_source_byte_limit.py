"""A source may name its own read limit above MAX_SOURCE_BYTES, bounded by a hard ceiling; no other source moves.

Anduril's Greenhouse board is one 42 MB response (2,374 postings, and the board API has no paging), four times the
10 MB that MAX_SOURCE_BYTES allows at most. Its source carries `max_source_bytes` in its options instead of the cap
rising for every source.
"""

from __future__ import annotations

import json
import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from test_robots import transport

from firstseen.adapters.base import SOURCE_BYTES_CEILING, FetchedDocument, SourceConfig, source_byte_limit
from firstseen.adapters.structured import GreenhouseAdapter

BOARD = "https://boards-api.greenhouse.io/v1/boards/fixture/jobs?content=true"


def source(options: dict[str, Any] | None = None) -> SourceConfig:
    return SourceConfig(
        id=UUID("00000000-0000-4000-8000-000000000301"),
        company_id=UUID("00000000-0000-4000-8000-000000000001"),
        company="Fixture Robotics",
        adapter="greenhouse",
        url="https://boards.example.test",
        external_key="fixture",
        trust_score=0.95,
        options=options or {},
    )


class SourceByteLimitTests(unittest.TestCase):
    def test_the_option_is_read_bounded_and_ignored_when_unusable(self) -> None:
        self.assertIsNone(source_byte_limit(source()))
        self.assertEqual(source_byte_limit(source({"max_source_bytes": 50_000_000})), 50_000_000)
        self.assertEqual(source_byte_limit(source({"max_source_bytes": "50000000"})), 50_000_000)
        self.assertEqual(source_byte_limit(source({"max_source_bytes": 10**12})), SOURCE_BYTES_CEILING)
        self.assertEqual(source_byte_limit(source({"max_source_bytes": 1})), 10_000)
        for unusable in (True, "lots", None, [1]):
            self.assertIsNone(source_byte_limit(source({"max_source_bytes": unusable})))

    def test_the_transport_reads_past_the_global_cap_only_when_asked(self) -> None:
        body = b"x" * 3_000_000
        collector, _ = transport({"https://careers.example.test/board": body}, enforced=False)
        collector.settings.max_source_bytes = 2_000_000
        with self.assertRaisesRegex(ValueError, "source_response_too_large"):
            collector.get("https://careers.example.test/board")
        self.assertEqual(len(collector.get("https://careers.example.test/board", max_bytes=4_000_000).body), 3_000_000)
        with self.assertRaisesRegex(ValueError, "source_response_too_large"):
            collector.get("https://careers.example.test/board", max_bytes=2_500_000)


class RecordingTransport:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def get(self, url: str, **options: Any) -> FetchedDocument:
        self.calls.append({"url": url, **options})
        body = json.dumps({"jobs": []}).encode()
        return FetchedDocument(url=url, status=200, content_type="application/json", body=body)


class GreenhouseLimitTests(unittest.TestCase):
    def test_a_board_passes_its_own_limit_and_every_other_board_passes_none(self) -> None:
        seen = datetime(2026, 9, 19, tzinfo=UTC)
        limited, plain = RecordingTransport(), RecordingTransport()
        GreenhouseAdapter().collect(source({"max_source_bytes": 50_000_000}), limited, observed_at=seen)
        GreenhouseAdapter().collect(source(), plain, observed_at=seen)
        self.assertEqual(limited.calls, [{"url": BOARD, "accept": "application/json", "max_bytes": 50_000_000}])
        self.assertEqual(plain.calls, [{"url": BOARD, "accept": "application/json"}])


if __name__ == "__main__":
    unittest.main()
