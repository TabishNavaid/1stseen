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
        self.filters: list[tuple[str, set[str]]] = []

    def select(self, *_: Any) -> Query:
        return self

    def eq(self, *_: Any) -> Query:
        return self

    def in_(self, column: str, values: list[str]) -> Query:
        self.filters.append((column, set(values)))
        return self

    def is_(self, *_: Any) -> Query:
        return self

    def limit(self, *_: Any) -> Query:
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

    def update(self, payload: Any, **options: Any) -> Query:
        self.op, self.payload, self.options = "update", payload, options
        return self

    def execute(self) -> Any:
        return self.client.run(self.table, self.op, self.payload, self.options, self.offset, self.filters)


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

    def run(
        self,
        table: str,
        op: str,
        payload: Any,
        options: dict[str, Any],
        offset: int,
        filters: list[tuple[str, set[str]]] | None = None,
    ) -> Any:
        self.requests.append((table, op, payload, options))
        if (table, op) in self.refuse:
            raise APIError({"message": "refused", "code": "23505"})
        if op == "select":
            rows = [
                row for row in self.rows.get(table, []) if all(str(row[column]) in values for column, values in filters or [])
            ]
            return SimpleNamespace(data=rows[offset : offset + 1000])
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


class ForecastEvidenceTests(unittest.TestCase):
    """Signal ingestion reads roles and openings once and re-reads only the signals; the result must be a full load's."""

    ROLE = "00000000-0000-4000-8000-00000000a001"
    COMPANY = "00000000-0000-4000-8000-00000000c001"

    def tables(self) -> dict[str, list[dict[str, Any]]]:
        return {
            "canonical_roles": [
                {"id": self.ROLE, "company_id": self.COMPANY, "role_family": "software_engineering", "level": "internship",
                 "recruiting_season": "summer", "companies": {"metadata": {"company_size": "large"}}},
            ],
            "raw_job_observations": [
                {"id": "obs-1", "observed_at": "2025-08-01T00:00:00+00:00", "raw_title": "Software Engineer Intern"},
                {"id": "page-1", "observed_at": "2026-06-01T00:00:00+00:00", "raw_title": "Careers"},
            ],
            "observation_role_matches": [
                {"observation_id": "obs-1", "canonical_role_id": self.ROLE, "match_confidence": 0.9,
                 "created_at": "2025-08-01T00:00:00+00:00"},
            ],
            "historical_opening_events": [
                {"id": "event-1", "canonical_role_id": self.ROLE, "observation_id": "obs-1", "opened_on": "2025-08-01",
                 "source_quality": 0.9, "opening_window_start": None, "opening_window_end": "2025-08-01",
                 "uncertainty_days": 0, "date_precision": "exact", "available_at": "2025-08-01T00:00:00+00:00"},
            ],
            "signals": [
                {"id": "signal-1", "company_id": self.COMPANY, "canonical_role_id": None, "observation_id": "page-1",
                 "observed_at": "2026-06-01T00:00:00+00:00", "available_at": "2026-06-01T00:00:00+00:00",
                 "strength": 0.5, "reliability": 0.7, "kind": "new_relevant_sitemap_url", "metadata": {}},
            ],
        }

    def test_the_split_load_is_the_full_load(self) -> None:
        client = Client(self.tables())
        full = repository(client).load_backtest_dataset()
        evidence = repository(client).load_forecast_evidence()
        self.assertEqual((evidence.roles, evidence.events, repository(client).load_backtest_signals(evidence)), full)
        self.assertEqual(len(full[2]), 1, "a company-scoped signal reaches the company's role")

    def test_a_signal_written_after_the_evidence_was_loaded_is_read_with_its_page(self) -> None:
        client = Client(self.tables())
        subject = repository(client)
        evidence = subject.load_forecast_evidence()
        client.rows["raw_job_observations"].append(
            {"id": "page-2", "observed_at": "2026-09-19T12:00:00+00:00", "raw_title": "Careers"}
        )
        client.rows["signals"].append(
            {**client.rows["signals"][0], "id": "signal-2", "observation_id": "page-2",
             "observed_at": "2026-09-19T12:00:00+00:00", "available_at": "2026-09-19T12:00:00+00:00"}
        )
        refreshed = subject.load_backtest_signals(evidence)
        self.assertEqual(refreshed, repository(client).load_backtest_dataset()[2])
        self.assertEqual(len(refreshed), 2)


class CompanyRoleCacheTests(unittest.TestCase):
    def test_a_company_s_roles_are_read_once_when_cached_and_every_time_otherwise(self) -> None:
        rows = {"canonical_roles": [{"id": "00000000-0000-4000-8000-00000000a001", "normalized_title": "software engineer intern",
                                     "company_normalized": "fixture", "role_aliases": []}]}
        company = UUID(int=1)
        for cached, expected_reads in ((True, 2), (False, 8)):
            client = Client(rows)
            subject = repository(client)
            if cached:
                subject.cache_company_roles()
            for _ in range(2):
                subject.resolve_signal_role(company, "software engineer intern")
                subject.list_company_role_ids(company)
            reads = [request for request in client.requests if request[1] == "select"]
            self.assertEqual(len(reads), expected_reads, "each read is one page and the empty page that ends it")


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




class StoredRowKeepsItsIdTests(unittest.TestCase):
    """A posting written onto a row that already exists never moves that row's primary key.

    Historical events and role matches reference an observation by id, so an update that changed the id was refused by
    the database (FK 23503 on historical_opening_events) and failed the whole source. That is how the first weekly
    historical run failed on 2026-09-19: a Wayback posting whose recomputed id no longer matched its stored row.
    """

    def stored(self) -> list[dict[str, Any]]:
        return [{"id": "row-stored", "identity_key": f"{7:064x}", "first_seen_at": "2025-01-01T00:00:00+00:00",
                 "content_hash": "b" * 64}]

    def changed_posting(self) -> JobObservation:
        # A posting carrying its own id, different from the stored row's, and different content.
        observation = posting(7, content="c")
        return observation.model_copy(update={"id": UUID("00000000-0000-4000-8000-0000000007ff")})

    def test_the_batched_write_keeps_the_stored_id(self) -> None:
        client = Client({"raw_job_observations": self.stored()})
        outcomes = repository(client).upsert_jobs([self.changed_posting()])
        self.assertEqual(outcomes, ["changed"])
        written = [payload for table, op, payload, _ in client.requests if table == "raw_job_observations" and op != "select"]
        self.assertEqual(len(written), 1, "one bulk write, not a per-posting fallback")
        self.assertEqual([row["id"] for row in written[0]], ["row-stored"])
        self.assertEqual(written[0][0]["first_seen_at"], "2025-01-01T00:00:00+00:00", "the first sighting is kept")

    def test_the_per_posting_write_keeps_the_stored_id(self) -> None:
        client = Client({"raw_job_observations": self.stored()})
        self.assertEqual(repository(client).upsert_job(self.changed_posting()), "changed")
        updates = [payload for table, op, payload, _ in client.requests if op == "update"]
        self.assertEqual([payload["id"] for payload in updates], ["row-stored"])

    def test_an_unchanged_posting_is_touched_on_the_stored_id(self) -> None:
        client = Client({"raw_job_observations": self.stored()})
        observation = posting(7, content="b").model_copy(update={"id": UUID("00000000-0000-4000-8000-0000000007ff")})
        self.assertEqual(repository(client).upsert_jobs([observation]), ["unchanged"])
        touched = [payload for name, op, payload, _ in client.requests if op == "rpc"]
        self.assertEqual([row["id"] for row in touched[0]["p_rows"]], ["row-stored"])


if __name__ == "__main__":
    unittest.main()


class ArchiveCaptureWriteTests(unittest.TestCase):
    """A second pass over an archived page updates the capture it already stored.

    Wayback derives a capture's id, and its page observation's with it, from the archive digest, which archive.org can
    report differently for a capture it served before. The rows are keyed by the capture instead, so a recomputed id
    must not insert a second row (unique source_id, original_url, captured_at — how the first weekly historical run
    failed on 2026-09-19) or point at an observation id the database does not have.
    """

    URL = "https://careers.example.test/early-careers/"
    CAPTURED = datetime(2022, 11, 17, 23, 22, 42, tzinfo=UTC)

    def capture(self, suffix: str) -> Any:
        from firstseen.models import ArchiveCapture

        return ArchiveCapture(
            id=UUID(f"00000000-0000-4000-8000-00000000c0{suffix}"),
            observation_id=UUID(f"00000000-0000-4000-8000-00000000d0{suffix}"),
            source_id=SOURCE_ID,
            original_url=self.URL,
            archive_url=f"https://web.archive.org/web/20221117232242/{self.URL}",
            captured_at=self.CAPTURED,
            status_code=200,
            change_kind="unchanged",
            completeness=0.9,
            is_partial=False,
            evidence_excerpt="Early careers at Example",
        )

    def client_with_stored_rows(self) -> Client:
        return Client(
            {
                "raw_job_observations": [
                    {"id": "stored-observation", "source_id": str(SOURCE_ID),
                     "archive_original_url": self.URL, "archive_capture_at": self.CAPTURED.isoformat()}
                ],
                "archive_captures": [
                    {"id": "stored-capture", "source_id": str(SOURCE_ID),
                     "original_url": self.URL, "captured_at": self.CAPTURED.isoformat()}
                ],
            }
        )

    def written(self, client: Client) -> tuple[Any, dict[str, Any]]:
        writes = [(payload, options) for table, op, payload, options in client.requests
                  if table == "archive_captures" and op == "upsert"]
        self.assertEqual(len(writes), 1)
        return writes[0]

    def test_a_capture_already_stored_keeps_its_id_and_its_observation(self):
        client = self.client_with_stored_rows()
        repository(client).record_archive_captures([self.capture("11")])
        payload, options = self.written(client)
        self.assertEqual(payload[0]["id"], "stored-capture")
        self.assertEqual(payload[0]["observation_id"], "stored-observation")
        self.assertEqual(options["on_conflict"], "source_id,original_url,captured_at")
        self.assertEqual(payload[0]["change_kind"], "unchanged", "the capture's own data is still written")

    def test_a_new_capture_is_written_with_its_own_ids(self):
        client = Client({"raw_job_observations": [], "archive_captures": []})
        repository(client).record_archive_captures([self.capture("22")])
        payload, _ = self.written(client)
        self.assertEqual(payload[0]["id"], "00000000-0000-4000-8000-00000000c022")
        self.assertEqual(payload[0]["observation_id"], "00000000-0000-4000-8000-00000000d022")

    def test_no_captures_reads_nothing(self):
        client = Client({})
        repository(client).record_archive_captures([])
        self.assertEqual(client.requests, [])
