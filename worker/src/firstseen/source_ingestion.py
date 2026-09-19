"""Source ingestion orchestration, page-level skipping, and job-level deduplication."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Protocol, cast
from uuid import UUID

from firstseen.inference import (
    DeterministicFirstInferencePolicy,
    InferenceMetrics,
    PageInferenceDecision,
)
from firstseen.models import ArchiveCapture, JobObservation

from .adapters.base import CollectionDiagnostic, HttpTransport, SourceConfig, robots_diagnostic
from .adapters.registry import AdapterRegistry
from .recruiting_paths import page_source_allowed
from .robots import RobotsDisallowedError

if TYPE_CHECKING:
    from .discovery import CompanyDiscoveryResult


class ObservationStore(Protocol):
    def last_document_hash(self, source_id: UUID) -> str | None: ...

    def record_fetch(
        self,
        source_id: UUID,
        *,
        fetched_at: datetime,
        content_hash: str,
        extraction_route: str,
        byte_count: int,
        unchanged: bool,
        jobs_detected: int,
        complete: bool,
        diagnostics: list[dict[str, object]],
    ) -> None: ...

    def upsert_job(self, observation: JobObservation) -> str: ...

    def touch_source_jobs(self, source_id: UUID, *, seen_at: datetime) -> int: ...

    def record_archive_captures(self, captures: list[ArchiveCapture]) -> None: ...

    def record_inference_decision(
        self,
        decision: PageInferenceDecision,
        *,
        decided_at: datetime,
        agent_run_id: UUID | None,
    ) -> None: ...


@dataclass(frozen=True)
class IngestionSummary:
    source_id: UUID
    detected: int
    created: int
    changed: int
    unchanged: int
    page_unchanged: bool
    document_hash: str
    inference_metrics: InferenceMetrics
    complete: bool = True
    diagnostics: tuple[CollectionDiagnostic, ...] = ()


class SourceIngestionService:
    def __init__(
        self,
        registry: AdapterRegistry,
        transport: HttpTransport,
        store: ObservationStore,
        *,
        agent_run_id: UUID | None = None,
        inference_policy: DeterministicFirstInferencePolicy | None = None,
    ) -> None:
        self.registry = registry
        self.transport = transport
        self.store = store
        self.agent_run_id = agent_run_id
        self.inference_policy = inference_policy or DeterministicFirstInferencePolicy()

    def ingest(self, source: SourceConfig, *, observed_at: datetime) -> IngestionSummary:
        if not page_source_allowed(source.adapter, str(source.url)):
            # A page source registered off a recruiting path is paid for on every run and yields nothing a program
            # needs (recruiting_paths.py). It is skipped before any request, and its earlier observations stay as they are.
            return IngestionSummary(
                source_id=source.id,
                detected=0,
                created=0,
                changed=0,
                unchanged=0,
                page_unchanged=False,
                document_hash="",
                inference_metrics=InferenceMetrics.from_decisions([]),
                complete=True,
                diagnostics=(
                    CollectionDiagnostic(
                        code="source_not_on_recruiting_path",
                        message="Skipped a page source whose address is not a recruiting page or sitemap.",
                        url=str(source.url),
                        details={"adapter": source.adapter},
                    ),
                ),
            )
        previous_hash = self.store.last_document_hash(source.id)
        adapter = self.registry.get(source.adapter)
        try:
            result = adapter.collect(
                source,
                self.transport,
                observed_at=observed_at,
                previous_document_hash=previous_hash,
            )
        except RobotsDisallowedError as refusal:
            # The source's own address is one robots.txt does not allow (robots.py). Nothing was requested and nothing
            # is written: its earlier observations stay as they are, like a source off a recruiting path. A rule is a
            # deliberate skip; an unreachable robots.txt leaves the source partial so the next run tries again.
            return IngestionSummary(
                source_id=source.id,
                detected=0,
                created=0,
                changed=0,
                unchanged=0,
                page_unchanged=False,
                document_hash="",
                inference_metrics=InferenceMetrics.from_decisions([]),
                complete=refusal.code == "robots_disallowed",
                diagnostics=(robots_diagnostic(refusal),),
            )
        created = changed = unchanged = 0
        if result.unchanged and result.complete:
            unchanged = self.store.touch_source_jobs(source.id, seen_at=observed_at)
        unique_observations: dict[str, JobObservation] = {}
        duplicate_count = 0
        for observation in result.observations:
            existing = unique_observations.get(observation.identity_key)
            if existing is not None:
                duplicate_count += 1
                if len(observation.evidence_excerpt) <= len(existing.evidence_excerpt):
                    continue
            unique_observations[observation.identity_key] = observation
        diagnostics = list(result.diagnostics)
        if duplicate_count:
            diagnostics.append(
                CollectionDiagnostic(
                    code="duplicate_observation_collapsed",
                    message=f"Collapsed {duplicate_count} duplicate observation entries.",
                    details={"duplicates": duplicate_count},
                )
            )
        for status in self._upsert_jobs(list(unique_observations.values())):
            if status == "created":
                created += 1
            elif status == "changed":
                changed += 1
            else:
                unchanged += 1
        if result.archive_captures:
            self.store.record_archive_captures(result.archive_captures)
        decisions = result.inference_decisions or [
            self.inference_policy.summarize_result(
                source_id=source.id,
                source_url=str(source.url),
                route=result.extraction_route,
                unchanged=result.unchanged,
                jobs=len(unique_observations),
            )
        ]
        record_many = getattr(self.store, "record_inference_decisions", None)
        if record_many is not None:
            record_many(decisions, decided_at=observed_at, agent_run_id=self.agent_run_id)
        else:
            for decision in decisions:
                self.store.record_inference_decision(
                    decision,
                    decided_at=observed_at,
                    agent_run_id=self.agent_run_id,
                )
        self.store.record_fetch(
            source.id,
            fetched_at=observed_at,
            content_hash=result.document_hash,
            extraction_route=result.extraction_route,
            byte_count=result.byte_count,
            unchanged=result.unchanged,
            jobs_detected=len(unique_observations),
            complete=result.complete,
            diagnostics=[item.as_dict() for item in diagnostics],
        )
        return IngestionSummary(
            source_id=source.id,
            detected=len(unique_observations),
            created=created,
            changed=changed,
            unchanged=unchanged,
            page_unchanged=result.unchanged,
            document_hash=result.document_hash,
            inference_metrics=InferenceMetrics.from_decisions(decisions),
            complete=result.complete,
            diagnostics=tuple(diagnostics),
        )

    def _upsert_jobs(self, observations: list[JobObservation]) -> list[str]:
        """Each posting's upsert_job outcome, written in bulk when the store can (the Supabase repository: upsert_jobs)."""
        upsert_many = getattr(self.store, "upsert_jobs", None)
        if upsert_many is not None:
            return cast(list[str], upsert_many(observations))
        return [self.store.upsert_job(observation) for observation in observations]

    def ingest_discovery(
        self,
        discovery: CompanyDiscoveryResult,
        *,
        observed_at: datetime,
    ) -> list[IngestionSummary]:
        """Ingest discovery output directly, without hand-authored source config."""
        return [self.ingest(source, observed_at=observed_at) for source in discovery.source_configs()]


class MemoryObservationStore:
    """Deterministic test/local store implementing production dedupe semantics."""

    def __init__(self) -> None:
        self.jobs: dict[tuple[UUID, str], JobObservation] = {}
        self.document_hashes: dict[UUID, str] = {}
        self.fetches: list[dict[str, object]] = []
        self.archive_captures: dict[UUID, ArchiveCapture] = {}
        self.inference_decisions: list[PageInferenceDecision] = []

    def last_document_hash(self, source_id: UUID) -> str | None:
        return self.document_hashes.get(source_id)

    def upsert_job(self, observation: JobObservation) -> str:
        key = (observation.source_id, observation.identity_key)
        previous = self.jobs.get(key)
        if previous is None:
            self.jobs[key] = observation
            return "created"
        if previous.content_hash == observation.content_hash:
            self.jobs[key] = previous.model_copy(update={"last_seen_at": observation.last_seen_at})
            return "unchanged"
        self.jobs[key] = observation.model_copy(update={"first_seen_at": previous.first_seen_at})
        return "changed"

    def touch_source_jobs(self, source_id: UUID, *, seen_at: datetime) -> int:
        touched = 0
        for key, observation in list(self.jobs.items()):
            if observation.source_id == source_id:
                self.jobs[key] = observation.model_copy(update={"last_seen_at": seen_at})
                touched += 1
        return touched

    def record_fetch(
        self,
        source_id: UUID,
        *,
        fetched_at: datetime,
        content_hash: str,
        extraction_route: str,
        byte_count: int,
        unchanged: bool,
        jobs_detected: int,
        complete: bool,
        diagnostics: list[dict[str, object]],
    ) -> None:
        if complete:
            self.document_hashes[source_id] = content_hash
        self.fetches.append(
            {
                "source_id": source_id,
                "fetched_at": fetched_at,
                "content_hash": content_hash,
                "extraction_route": extraction_route,
                "byte_count": byte_count,
                "unchanged": unchanged,
                "jobs_detected": jobs_detected,
                "complete": complete,
                "diagnostics": diagnostics,
            }
        )

    def record_archive_captures(self, captures: list[ArchiveCapture]) -> None:
        for capture in captures:
            self.archive_captures[capture.id] = capture

    def record_inference_decision(
        self,
        decision: PageInferenceDecision,
        *,
        decided_at: datetime,
        agent_run_id: UUID | None,
    ) -> None:
        del decided_at, agent_run_id
        self.inference_decisions.append(decision)

    def inference_metrics(self) -> InferenceMetrics:
        return InferenceMetrics.from_decisions(self.inference_decisions)
