"""Collection writes in bulk: postings, model attempts, and scope decisions, each with upsert_job's outcomes.

Each of these was one request per row. The tests pin that the bulk forms choose exactly what the per-row forms chose,
send few requests, and fall back to the per-row form where the database refuses a batch.
"""

from __future__ import annotations

import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from postgrest.exceptions import APIError

from firstseen.models import AtsCategories, JobObservation
from firstseen.providers import ModelAttempt
from firstseen.repository import IntelligenceRepository
from firstseen.scope import RoleScopeClassification, RoleScopeService

SOURCE_ID = UUID("00000000-0000-4000-8000-000000000101")
SEEN = datetime(2026, 9, 14, 10, tzinfo=UTC)


def posting(number: int, *, content: str = "b", categories: AtsCategories | None = None) -> JobObservation:
    return JobObservation(
        source_id=SOURCE_ID,
        external_job_id=str(number),
        identity_key=f"{number:064x}",
        source_url=f"https://jobs.example.test/{number}",
        apply_url=f"https://jobs.example.test/{number}/apply",
        raw_title="Software Engineer Intern",
        company="Fixture Robotics",
        first_seen_at=SEEN,
        last_seen_at=SEEN,
        content_hash=content * 64,
        source_type="ats",
        source_reliability={"score": 0.9},
        extraction_method="structured_endpoint",
        ats_categories=categories,
    )


class Query:
    def __init__(self, client: Client, table: str) -> None:
        self.client, self.table, self.op = client, table, "select"
        self.payload: Any = None
        self.options: dict[str, Any] = {}
        self.offset = 0

    def select(self, *_: Any) -> Query:
        return self

    def eq(self, *_: Any) -> Query:
        return self

    def is_(self, *_: Any) -> Query:
        return self

    @property
    def not_(self) -> Query:
        return self

    def order(self, *_: Any, **__: Any) -> Query:
        return self

    def range(self, start: int, end: int) -> Query:
        del end
        self.offset = start
        return self

    def insert(self, payload: Any, **options: Any) -> Query:
        self.op, self.payload, self.options = "insert", payload, options
        return self

    def upsert(self, payload: Any, **options: Any) -> Query:
        self.op, self.payload, self.options = "upsert", payload, options
        return self

    def execute(self) -> Any:
        return self.client.run(self.table, self.op, self.payload, self.options, self.offset)


class Client:
    """Answers reads from `rows` and records every request; `refuse` names requests to fail as Postgres would."""

    def __init__(self, rows: dict[str, list[dict[str, Any]]] | None = None) -> None:
        self.rows = rows or {}
        self.requests: list[tuple[str, str, Any, dict[str, Any]]] = []
        self.refuse: set[tuple[str, str]] = set()

    def table(self, name: str) -> Query:
        return Query(self, name)

    def rpc(self, name: str, params: dict[str, Any]) -> Any:
        return SimpleNamespace(execute=lambda: self.run(name, "rpc", params, {}, 0))

    def run(self, table: str, op: str, payload: Any, options: dict[str, Any], offset: int) -> Any:
        self.requests.append((table, op, payload, options))
        if (table, op) in self.refuse:
            raise APIError({"message": "refused", "code": "23505"})
        if op == "select":
            return SimpleNamespace(data=self.rows.get(table, [])[offset : offset + 1000])
        return SimpleNamespace(data=None)


def repository(client: Client) -> IntelligenceRepository:
    return IntelligenceRepository(client)  # type: ignore[arg-type]


class UpsertJobsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.stored = [
            {"id": "row-unchanged", "identity_key": f"{2:064x}", "first_seen_at": "2025-01-01T00:00:00+00:00", "content_hash": "b" * 64},
            {"id": "row-changed", "identity_key": f"{3:064x}", "first_seen_at": "2025-02-01T00:00:00+00:00", "content_hash": "b" * 64},
            {"id": "row-categorized", "identity_key": f"{4:064x}", "first_seen_at": "2025-03-01T00:00:00+00:00", "content_hash": "b" * 64},
        ]

    def test_each_posting_gets_upsert_jobs_outcome_in_three_writes(self) -> None:
        client = Client({"raw_job_observations": self.stored})
        outcomes = repository(client).upsert_jobs(
            [posting(1), posting(2), posting(3, content="c"), posting(4, categories=AtsCategories(team="Backend"))]
        )

        self.assertEqual(outcomes, ["created", "unchanged", "changed", "unchanged"])
        writes = [(table, op) for table, op, _, _ in client.requests if op != "select"]
        self.assertEqual(
            writes,
            [("raw_job_observations", "insert"), ("raw_job_observations", "upsert"), ("touch_job_observations", "rpc")],
        )
        inserted = next(payload for _, op, payload, _ in client.requests if op == "insert")
        self.assertEqual([row["identity_key"] for row in inserted], [f"{1:064x}"])
        changed = next(payload for _, op, payload, _ in client.requests if op == "upsert")
        self.assertEqual(changed[0]["id"], "row-changed")
        self.assertEqual(changed[0]["first_seen_at"], "2025-02-01T00:00:00+00:00", "the first sighting is kept")
        touched = next(payload["p_rows"] for _, op, payload, _ in client.requests if op == "rpc")
        self.assertEqual(
            [set(row) for row in touched],
            [{"id", "last_seen_at", "observed_at"}, {"id", "last_seen_at", "observed_at", "raw_payload"}],
            "an unchanged posting records only that it was seen again, and its ATS categories when it has them",
        )

    def test_a_refused_batch_is_written_one_posting_at_a_time_through_upsert_job(self) -> None:
        client = Client({"raw_job_observations": self.stored})
        client.refuse.add(("raw_job_observations", "insert"))
        replayed: list[str] = []

        class Replaying(IntelligenceRepository):
            def upsert_job(self, observation: JobObservation) -> str:
                replayed.append(observation.identity_key)
                return "created"

        outcomes = Replaying(client).upsert_jobs([posting(1), posting(5), posting(2)])  # type: ignore[arg-type]
        self.assertEqual(outcomes, ["created", "created", "unchanged"])
        self.assertEqual(replayed, [f"{1:064x}", f"{5:064x}"])

    def test_a_source_is_read_once_however_many_postings_it_has(self) -> None:
        client = Client({"raw_job_observations": self.stored})
        repository(client).upsert_jobs([posting(number) for number in range(10, 610)])
        reads = [request for request in client.requests if request[1] == "select"]
        writes = [request for request in client.requests if request[1] != "select"]
        self.assertEqual(len(reads), 2, "one page and the empty page that ends it")
        self.assertEqual(len(writes), 2, "600 new postings in two chunks of at most 500")


class ModelAttemptBufferTests(unittest.TestCase):
    @staticmethod
    def attempt() -> ModelAttempt:
        return ModelAttempt(
            provider="gemini", model="gemini-test", capability="classify", latency_ms=12, success=False,
            failure_kind="temporary_provider", fallback_reason="refused",
        )

    def test_attempts_are_written_together_before_the_next_tool_call(self) -> None:
        client = Client()
        subject = repository(client)
        subject.buffer_model_attempts()
        for _ in range(3):
            subject.record_model_attempt(self.attempt())
        self.assertEqual(client.requests, [])
        subject.flush_model_attempts()
        self.assertEqual([(table, op, len(payload)) for table, op, payload, _ in client.requests], [("model_usage", "insert", 3)])

    def test_the_buffer_is_written_every_two_hundred_attempts_and_unbuffered_writes_each(self) -> None:
        client = Client()
        subject = repository(client)
        subject.buffer_model_attempts()
        for _ in range(450):
            subject.record_model_attempt(self.attempt())
        self.assertEqual([len(payload) for _, _, payload, _ in client.requests], [200, 200])

        unbuffered = Client()
        repository(unbuffered).record_model_attempt(self.attempt())
        self.assertEqual(len(unbuffered.requests), 1)


class RequestCounterTests(unittest.TestCase):
    def test_every_request_the_postgrest_session_sends_is_counted(self) -> None:
        hooks: dict[str, list[Any]] = {"request": [], "response": []}
        client = SimpleNamespace(postgrest=SimpleNamespace(session=SimpleNamespace(event_hooks=hooks)))
        subject = IntelligenceRepository(client)  # type: ignore[arg-type]
        for hook in hooks["request"]:
            hook(object())
            hook(object())
        self.assertEqual(subject.database_requests, 2)


class ScopeBulkSaveTests(unittest.TestCase):
    @staticmethod
    def classification(status: str) -> RoleScopeClassification:
        return RoleScopeClassification(
            status=status,  # type: ignore[arg-type]
            reason="discipline_unknown" if status == "ambiguous" else "in_scope",
            discipline=None if status == "ambiguous" else "software_engineering",
            early_career_type="internship",
            evidence=[],
            method="deterministic",
            classifier_version="test",
        )

    def test_changed_decisions_are_saved_together_and_a_refusal_is_retried_role_by_role(self) -> None:
        roles = [UUID(int=index) for index in range(1, 4)]

        class Store:
            def __init__(self, refuse_bulk: bool) -> None:
                self.refuse_bulk = refuse_bulk
                self.bulk: list[list[UUID]] = []
                self.single: list[UUID] = []

            def list_role_scope_inputs(self, company_id: UUID | None = None) -> list[Any]:
                return [SimpleNamespace(role_id=role, current=None) for role in roles]

            def role_description_excerpt(self, role_id: UUID) -> str:
                return ""

            def save_role_scopes(self, decisions: list[tuple[UUID, RoleScopeClassification]]) -> None:
                if self.refuse_bulk:
                    raise RuntimeError("refused")
                self.bulk.append([role for role, _ in decisions])

            def save_role_scope(self, role_id: UUID, classification: RoleScopeClassification) -> None:
                if role_id == roles[1]:
                    raise RuntimeError("this role is refused")
                self.single.append(role_id)

        class Service(RoleScopeService):
            def _classify(self, stored: Any, summary: Any) -> RoleScopeClassification:
                return ScopeBulkSaveTests.classification("in_scope")

        together = Store(refuse_bulk=False)
        summary = Service(together).classify()  # type: ignore[arg-type]
        self.assertEqual((together.bulk, together.single), ([roles], []))
        self.assertEqual((summary.written, summary.failures, summary.by_status["in_scope"]), (3, 0, 3))

        refused = Store(refuse_bulk=True)
        summary = Service(refused).classify()  # type: ignore[arg-type]
        self.assertEqual(refused.single, [roles[0], roles[2]])
        self.assertEqual((summary.written, summary.failures, summary.by_status["in_scope"]), (2, 1, 2))


if __name__ == "__main__":
    unittest.main()
