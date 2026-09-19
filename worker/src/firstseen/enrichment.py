"""Post-ingestion orchestration from persisted evidence to canonical roles and openings.

Collection persists immutable observations and archive captures. This stage reads
that persisted evidence back and produces the intermediate records forecasting
requires: `observation_role_matches` and `historical_opening_events`.

It deliberately operates over the system of record rather than an in-memory
collection result, so a re-run, a backfill, and a scheduled pass all behave
identically and remain idempotent.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from typing import Protocol
from uuid import UUID

from .adapters.base import CollectionDiagnostic
from .history import HistoricalOpeningResolver, RecurringRoleIdentity
from .models import ArchiveCapture, HistoricalOpeningEvent, JobObservation
from .role_resolution import (
    CanonicalRoleIdentity,
    PersistentRoleResolver,
    RoleResolution,
    RoleResolver,
)
from .scope import RoleScopeService

# An archived career page is attributed to a role by the reconstruction rule that
# requires at least 75% canonical-title or alias token overlap. It is weaker than a
# direct resolver decision over a job posting, so it enters forecasting at a
# conservative fixed confidence that reduces the evidence weight accordingly.
ARCHIVE_ATTRIBUTION_CONFIDENCE = 0.75
ARCHIVE_ATTRIBUTION_RATIONALE = (
    "Archived capture attributed to this recurring role by canonical-title or alias match "
    "during historical reconstruction."
)


class EnrichmentStore(Protocol):
    """Persisted evidence required to derive recurring identity and opening history."""

    def list_unresolved_observations(self, company_id: UUID) -> list[JobObservation]: ...

    def list_canonical_roles_for_resolution(self, company_id: UUID) -> list[CanonicalRoleIdentity]: ...

    def role_match_exists(self, observation_id: UUID) -> bool: ...

    def role_evidence_exists(self, observation_id: UUID, role_id: UUID) -> bool: ...

    def save_role_resolution(self, resolution: RoleResolution) -> None: ...

    def list_recurring_roles(self, company_id: UUID) -> list[RecurringRoleIdentity]: ...

    def list_role_observations(self, role_id: UUID) -> list[JobObservation]: ...

    def list_company_archive_captures(self, company_id: UUID) -> list[ArchiveCapture]: ...

    def list_historical_events(self, role_id: UUID) -> list[HistoricalOpeningEvent]: ...

    def save_historical_openings(self, events: list[HistoricalOpeningEvent]) -> None: ...

    def link_observation_to_role(
        self,
        observation_id: UUID,
        role_id: UUID,
        *,
        match_confidence: float,
        rationale: str,
    ) -> None: ...

    def degraded_source_ids(self, company_id: UUID) -> set[UUID]: ...


@dataclass(frozen=True)
class EnrichmentSummary:
    company_id: UUID
    observations_considered: int
    roles_matched: int
    roles_created: int
    resolution_failures: int
    roles_reconstructed: int
    events_persisted: int
    reconstruction_failures: int
    degraded_capture_sources: int
    diagnostics: tuple[CollectionDiagnostic, ...] = ()
    roles_in_scope: int = 0
    scope_classifications_written: int = 0
    scope_failures: int = 0

    @property
    def complete(self) -> bool:
        return self.resolution_failures == 0 and self.reconstruction_failures == 0 and self.scope_failures == 0

    def as_dict(self) -> dict[str, object]:
        return {
            "company_id": str(self.company_id),
            "observations_considered": self.observations_considered,
            "roles_matched": self.roles_matched,
            "roles_created": self.roles_created,
            "resolution_failures": self.resolution_failures,
            "roles_reconstructed": self.roles_reconstructed,
            "events_persisted": self.events_persisted,
            "reconstruction_failures": self.reconstruction_failures,
            "degraded_capture_sources": self.degraded_capture_sources,
            "roles_in_scope": self.roles_in_scope,
            "scope_classifications_written": self.scope_classifications_written,
            "scope_failures": self.scope_failures,
            "diagnostics": [item.as_dict() for item in self.diagnostics],
        }


@dataclass
class _Counters:
    matched: int = 0
    created: int = 0
    failures: int = 0
    diagnostics: list[CollectionDiagnostic] = field(default_factory=list)


class EvidenceEnrichmentService:
    """Turn persisted observations and captures into recurring roles and opening events.

    Both stages are independently idempotent. Role resolution skips observations that
    already carry a persisted match; historical reconstruction re-derives the same
    cycles from the same evidence and the store upserts them on their natural key.
    """

    def __init__(
        self,
        store: EnrichmentStore,
        *,
        resolver: RoleResolver | None = None,
        history_resolver: HistoricalOpeningResolver | None = None,
        scope_service: RoleScopeService | None = None,
    ) -> None:
        self.store = store
        # Classify as we ingest: every company pass re-derives scope from its roles' current evidence.
        self.scope_service = scope_service
        self.persistent_resolver = PersistentRoleResolver(resolver or RoleResolver(), store)
        self.history_resolver = history_resolver or HistoricalOpeningResolver()

    @staticmethod
    def _is_page_level(observation: JobObservation) -> bool:
        """Archived career-page anchors are capture provenance, not job postings.

        They exist so an archive capture has an immutable observation to point at.
        Treating one as a job would invent a canonical role named after the page.
        """
        return bool(observation.source_reliability.get("page_level_evidence"))

    def enrich_company(self, company_id: UUID) -> EnrichmentSummary:
        observations = [
            item
            for item in self.store.list_unresolved_observations(company_id)
            if not self._is_page_level(item)
        ]
        resolution = self._resolve_roles(company_id, observations)
        degraded = self.store.degraded_source_ids(company_id)
        reconstruction = self._reconstruct_history(company_id, degraded_sources=degraded)
        roles_reconstructed, events_persisted, history_counters = reconstruction
        scope_diagnostics: list[CollectionDiagnostic] = []
        roles_in_scope = scope_written = scope_failures = 0
        if self.scope_service is not None:
            try:
                scope = self.scope_service.classify(company_id)
                roles_in_scope = scope.by_status.get("in_scope", 0)
                scope_written = scope.written
                scope_failures = scope.failures
            except Exception as exc:  # noqa: BLE001 - scope is re-derived next pass; the failure is reported
                scope_failures = 1
                scope_diagnostics.append(
                    CollectionDiagnostic(
                        code="scope_classification_failed",
                        message=f"Scope classification failed for the company: {type(exc).__name__}.",
                        severity="error",
                    )
                )
        return EnrichmentSummary(
            company_id=company_id,
            observations_considered=len(observations),
            roles_matched=resolution.matched,
            roles_created=resolution.created,
            resolution_failures=resolution.failures,
            roles_reconstructed=roles_reconstructed,
            events_persisted=events_persisted,
            reconstruction_failures=history_counters.failures,
            degraded_capture_sources=len(degraded),
            diagnostics=tuple(resolution.diagnostics + history_counters.diagnostics + scope_diagnostics),
            roles_in_scope=roles_in_scope,
            scope_classifications_written=scope_written,
            scope_failures=scope_failures,
        )

    def _resolve_roles(self, company_id: UUID, observations: Sequence[JobObservation]) -> _Counters:
        counters = _Counters()
        if not observations:
            return counters
        # Candidates are reloaded per observation so a role created earlier in this
        # pass can immediately absorb a later observation of the same program.
        for observation in observations:
            if observation.id is None:
                continue
            try:
                candidates = self.store.list_canonical_roles_for_resolution(company_id)
                result = self.persistent_resolver.resolve_new(
                    company_id=company_id,
                    observation=observation,
                    candidates=candidates,
                )
            except Exception as exc:  # noqa: BLE001 - observations resolve independently
                counters.failures += 1
                counters.diagnostics.append(
                    CollectionDiagnostic(
                        code="role_resolution_failed",
                        message=f"Role resolution failed for one observation: {type(exc).__name__}.",
                        severity="error",
                        details={"observation_id": str(observation.id)},
                    )
                )
                continue
            if result is None:
                continue
            if result.decision == "matched":
                counters.matched += 1
            else:
                counters.created += 1
        return counters

    def _reconstruct_history(
        self,
        company_id: UUID,
        *,
        degraded_sources: set[UUID],
    ) -> tuple[int, int, _Counters]:
        counters = _Counters()
        roles = self.store.list_recurring_roles(company_id)
        if not roles:
            return 0, 0, counters
        captures = self._admissible_captures(company_id, degraded_sources, counters)
        reconstructed = 0
        persisted = 0
        for role in roles:
            try:
                observations = self.store.list_role_observations(role.id)
                if not observations and not captures:
                    continue
                events = self.history_resolver.resolve(
                    role,
                    captures=captures,
                    observations=observations,
                    historical_first_seen=self.store.list_historical_events(role.id),
                )
                if events:
                    self.store.save_historical_openings(events)
                    persisted += len(events)
                    self._link_event_observations(role.id, events)
                reconstructed += 1
            except Exception as exc:  # noqa: BLE001 - roles reconstruct independently
                counters.failures += 1
                counters.diagnostics.append(
                    CollectionDiagnostic(
                        code="historical_reconstruction_failed",
                        message=(
                            f"Historical reconstruction failed for one role: {type(exc).__name__}."
                        ),
                        severity="error",
                        details={"canonical_role_id": str(role.id)},
                    )
                )
        return reconstructed, persisted, counters

    def _link_event_observations(
        self,
        role_id: UUID,
        events: Sequence[HistoricalOpeningEvent],
    ) -> None:
        """Guarantee every opening event's observation carries a role match.

        Archive-derived events cite the page capture's observation. Forecast and
        backtest loading require a persisted match for that observation, and its
        confidence must stay visible so it can reduce downstream evidence weight.
        """
        for event in events:
            # Checked per (observation, role) pair: one archived page is evidence for
            # many roles, so an existing match for a different role must not block
            # this role's attribution.
            if self.store.role_evidence_exists(event.observation_id, role_id):
                continue
            self.store.link_observation_to_role(
                event.observation_id,
                role_id,
                match_confidence=ARCHIVE_ATTRIBUTION_CONFIDENCE,
                rationale=ARCHIVE_ATTRIBUTION_RATIONALE,
            )

    def _admissible_captures(
        self,
        company_id: UUID,
        degraded_sources: set[UUID],
        counters: _Counters,
    ) -> list[ArchiveCapture]:
        captures = self.store.list_company_archive_captures(company_id)
        if not degraded_sources:
            return captures
        return list(self._demote_degraded(captures, degraded_sources, counters))

    @staticmethod
    def _demote_degraded(
        captures: Iterable[ArchiveCapture],
        degraded_sources: set[UUID],
        counters: _Counters,
    ) -> Iterable[ArchiveCapture]:
        """Keep presence evidence from a degraded run but never let it prove absence.

        A degraded archive collection may be missing captures entirely, which the
        resolver cannot detect. Marking those captures partial preserves their
        ability to show a role was present while preventing them from acting as the
        complete earlier capture that would manufacture a bounded opening window.
        """
        demoted = 0
        for capture in captures:
            if capture.source_id in degraded_sources and not capture.is_partial:
                demoted += 1
                yield capture.model_copy(update={"is_partial": True})
            else:
                yield capture
        if demoted:
            counters.diagnostics.append(
                CollectionDiagnostic(
                    code="degraded_archive_absence_suppressed",
                    message=(
                        f"Treated {demoted} capture(s) from degraded sources as partial so an "
                        "incomplete archive pass cannot produce a bounded opening date."
                    ),
                    details={"captures": demoted, "sources": len(degraded_sources)},
                )
            )
