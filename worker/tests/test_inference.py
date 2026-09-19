from __future__ import annotations

import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from firstseen.adapters.base import FetchedDocument, SourceConfig
from firstseen.adapters.registry import AdapterRegistry
from firstseen.inference import InferenceMetrics, PageInferenceDecision
from firstseen.source_ingestion import MemoryObservationStore, SourceIngestionService

FIXTURES = Path(__file__).with_name("fixtures")
SEEN_AT = datetime(2026, 8, 14, 8, 0, tzinfo=UTC)
SOURCE_ID = UUID("00000000-0000-4000-8000-000000000701")
COMPANY_ID = UUID("00000000-0000-4000-8000-000000000001")


class CountingClient:
    def __init__(self) -> None:
        self.calls = 0

    def complete(self, **kwargs):
        self.calls += 1
        raise AssertionError("A straightforward structured page must not call a model")


class FakeTransport:
    def __init__(self, responses: dict[str, tuple[bytes, str]]) -> None:
        self.responses = responses

    def get(self, url: str, *, accept: str = "*/*") -> FetchedDocument:
        del accept
        body, content_type = self.responses[url]
        return FetchedDocument(url=url, status=200, content_type=content_type, body=body)


def configured(adapter: str, url: str, **updates) -> SourceConfig:
    payload = {
        "id": SOURCE_ID,
        "company_id": COMPANY_ID,
        "company": "Fixture Robotics",
        "adapter": adapter,
        "url": url,
        "external_key": None,
        "trust_score": 0.9,
        "options": {"allow_llm": True},
        **updates,
    }
    return SourceConfig.model_validate(payload)


class DeterministicInferenceTests(unittest.TestCase):
    def test_official_structured_jobs_require_zero_model_calls(self) -> None:
        client = CountingClient()
        url = "https://boards-api.greenhouse.io/v1/boards/fixture/jobs?content=true"
        store = MemoryObservationStore()
        service = SourceIngestionService(
            AdapterRegistry.with_fallbacks(client),
            FakeTransport({url: ((FIXTURES / "greenhouse.json").read_bytes(), "application/json")}),
            store,
        )

        summary = service.ingest(
            configured(
                "greenhouse",
                "https://boards.example.test",
                external_key="fixture",
            ),
            observed_at=SEEN_AT,
        )

        self.assertEqual(client.calls, 0)
        self.assertEqual(summary.inference_metrics.deterministically_parsed, 1)
        self.assertEqual(summary.inference_metrics.llm_escalations, 0)
        self.assertEqual(store.inference_decisions[0].reason, "structured_source_parsed")

    def test_jobposting_schema_requires_zero_model_calls_even_when_llm_is_enabled(self) -> None:
        client = CountingClient()
        url = "https://careers.example.test/jobs"
        store = MemoryObservationStore()
        service = SourceIngestionService(
            AdapterRegistry.with_fallbacks(client),
            FakeTransport({url: ((FIXTURES / "career_jsonld.html").read_bytes(), "text/html")}),
            store,
        )

        summary = service.ingest(configured("generic", url), observed_at=SEEN_AT)

        self.assertEqual(client.calls, 0)
        self.assertEqual(summary.inference_metrics.llm_escalation_percentage, 0)
        self.assertEqual(store.inference_decisions[0].reason, "schema_extraction_succeeded")

    def test_explicit_no_openings_suppresses_model_escalation(self) -> None:
        client = CountingClient()
        url = "https://careers.example.test/closed"
        store = MemoryObservationStore()
        service = SourceIngestionService(
            AdapterRegistry.with_fallbacks(client),
            FakeTransport(
                {url: (b"<html><body>No current openings. Check back later.</body></html>", "text/html")}
            ),
            store,
        )

        service.ingest(configured("generic", url), observed_at=SEEN_AT)

        self.assertEqual(client.calls, 0)
        self.assertEqual(store.inference_decisions[0].action, "suppressed")
        self.assertEqual(store.inference_decisions[0].reason, "explicitly_no_open_jobs")

    def test_metrics_report_escalation_success_and_fallback_frequency(self) -> None:
        base = {
            "source_id": SOURCE_ID,
            "source_url": "https://careers.example.test/jobs",
            "page_changed": True,
            "deterministic_route": "static_html",
            "deterministic_job_count": 0,
        }
        decisions = [
            PageInferenceDecision(
                **base,
                action="escalated",
                reason="ambiguous_recruiting_content",
                llm_escalated=True,
                model_extraction_succeeded=True,
                model_fallback_used=True,
            ),
            PageInferenceDecision(
                **base,
                action="escalated",
                reason="ambiguous_recruiting_content",
                llm_escalated=True,
                model_extraction_succeeded=True,
            ),
        ]

        metrics = InferenceMetrics.from_decisions(decisions)

        self.assertEqual(metrics.pages_processed, 2)
        self.assertEqual(metrics.llm_escalation_percentage, 100)
        self.assertEqual(metrics.successful_model_extractions, 2)
        self.assertEqual(metrics.fallback_frequency, 50)


if __name__ == "__main__":
    unittest.main()
