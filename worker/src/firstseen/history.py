"""Uncertainty-aware reconstruction of historical recurring-role openings."""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import BaseModel, Field

from .models import ArchiveCapture, HistoricalOpeningEvent, JobObservation

DatePrecision = Literal["exact", "bounded", "observed_by"]
Visibility = Literal["present", "absent", "unknown"]

# A capture only proves absence if it is recognisably the same recruiting surface.
_RECRUITING_SURFACE_TERMS = (
    "job",
    "career",
    "position",
    "opening",
    "vacanc",
    "apply",
    "hiring",
    "recruit",
    "intern",
)


def _recruiting_surface(capture: ArchiveCapture) -> bool:
    """True when the capture looks like a recruiting page at all.

    A cookie wall, error page, or redirect landing is not evidence that a role
    disappeared, so it must not be read as absence.
    """
    if capture.detected_titles:
        return True
    text = capture.evidence_excerpt.casefold()
    return any(term in text for term in _RECRUITING_SURFACE_TERMS)


class RecurringRoleIdentity(BaseModel):
    id: UUID
    company_id: UUID
    company: str = Field(min_length=1)
    canonical_title: str = Field(min_length=1)
    track: str
    aliases: list[str] = Field(default_factory=list)


@dataclass
class _Candidate:
    observation_id: UUID
    representative: date
    earliest: date | None
    latest: date
    precision: DatePrecision
    source_quality: float
    evidence_quote: str
    uncertainty_reason: str
    method: str
    provenance: list[dict[str, object]]
    closed_on: date | None = None


def _tokens(value: str) -> set[str]:
    replacements = {
        "internship": "intern",
        "internships": "intern",
        "graduates": "graduate",
        "engineering": "engineer",
        "developers": "developer",
    }
    words = re.findall(r"[a-z0-9]+", value.casefold())
    return {replacements.get(word, word) for word in words if word not in {"the", "and", "at", "role"}}


class HistoricalOpeningResolver:
    """Resolve sourced opening events without treating archive time as publication time."""

    def __init__(self, *, merge_window_days: int = 75, max_bound_days: int = 120) -> None:
        self.merge_window_days = merge_window_days
        self.max_bound_days = max_bound_days

    def resolve(
        self,
        role: RecurringRoleIdentity,
        *,
        captures: Iterable[ArchiveCapture],
        observations: Iterable[JobObservation],
        historical_first_seen: Iterable[HistoricalOpeningEvent] = (),
    ) -> list[HistoricalOpeningEvent]:
        capture_list = self._unique_captures(captures)
        observation_list = list(observations)
        candidates = self._capture_candidates(role, capture_list)
        candidates.extend(self._observation_candidates(role, observation_list))
        candidates.extend(self._prior_candidates(historical_first_seen))
        merged = self._merge_candidates(candidates)
        return [self._event(role, item) for item in merged]

    @staticmethod
    def _unique_captures(captures: Iterable[ArchiveCapture]) -> list[ArchiveCapture]:
        unique: dict[tuple[UUID, str, object], ArchiveCapture] = {}
        for capture in sorted(captures, key=lambda item: item.captured_at):
            key = (capture.source_id, str(capture.original_url), capture.captured_at)
            existing = unique.get(key)
            if existing is None or capture.completeness > existing.completeness:
                unique[key] = capture
        return sorted(unique.values(), key=lambda item: item.captured_at)

    def _visibility(self, role: RecurringRoleIdentity, capture: ArchiveCapture) -> Visibility:
        """Classify what one capture actually proves about a role's visibility.

        Absence is only claimed from a capture that is a complete, comparable
        recruiting surface. A redirect, partial body, failed fetch, or page with no
        recruiting context proves nothing and stays `unknown`, because treating it
        as absence would manufacture an opening transition on the next capture.
        """
        if capture.status_code != 200:
            return "unknown"
        # Presence is positive evidence: seeing the role proves it was visible even
        # if the rest of the capture is truncated.
        if self._capture_matches(role, capture):
            return "present"
        # Absence is a much stronger claim. A truncated body or a page that is not
        # recognisably the same recruiting surface proves nothing.
        if capture.is_partial or not _recruiting_surface(capture):
            return "unknown"
        return "absent"

    def _capture_candidates(
        self,
        role: RecurringRoleIdentity,
        captures: list[ArchiveCapture],
    ) -> list[_Candidate]:
        by_url: dict[str, list[ArchiveCapture]] = {}
        for capture in captures:
            by_url.setdefault(str(capture.original_url), []).append(capture)
        candidates: list[_Candidate] = []
        for url, url_captures in by_url.items():
            # Visibility is a state machine over time. Only an absent -> present
            # transition is an opening; present -> present is continued visibility
            # and must never become a second opening.
            state: Visibility = "unknown"
            last_absent: ArchiveCapture | None = None
            open_candidate: _Candidate | None = None
            for capture in sorted(url_captures, key=lambda item: item.captured_at):
                observed = self._visibility(role, capture)
                if observed == "unknown":
                    continue
                if observed == "absent":
                    if state == "present" and open_candidate is not None:
                        # Disappearance bounds the end of the previous appearance.
                        open_candidate.closed_on = capture.captured_at.date()
                        open_candidate.provenance.append(
                            {
                                "kind": "archive_disappearance",
                                "capture_id": str(capture.id),
                                "captured_at": capture.captured_at.isoformat(),
                                "semantics": "role_absent_by_capture_time",
                            }
                        )
                    state = "absent"
                    last_absent = capture
                    continue
                if state == "present":
                    # Continued visibility only; not another opening.
                    continue

                latest = capture.captured_at.date()
                earliest: date | None = None
                precision: DatePrecision = "observed_by"
                reason = "No trustworthy earlier capture establishes absence before this appearance."
                if last_absent is not None:
                    proposed_earliest = last_absent.captured_at.date() + timedelta(days=1)
                    gap_days = (latest - proposed_earliest).days
                    if 0 <= gap_days <= self.max_bound_days:
                        earliest = proposed_earliest
                        precision = "bounded"
                        reason = (
                            "Role was absent from the previous complete recruiting capture and "
                            "present in this capture; the true opening lies within the interval."
                        )
                    else:
                        reason = (
                            "The previous capture establishing absence is too distant to provide "
                            "a defensible lower bound."
                        )
                representative = (
                    earliest + timedelta(days=(latest - earliest).days // 2)
                    if earliest is not None
                    else latest
                )
                candidate = _Candidate(
                    observation_id=capture.observation_id,
                    representative=representative,
                    earliest=earliest,
                    latest=latest,
                    precision=precision,
                    source_quality=round(
                        (0.85 if precision == "bounded" else 0.6) * capture.completeness, 3
                    ),
                    evidence_quote=self._quote(role, capture.evidence_excerpt),
                    uncertainty_reason=reason,
                    method="wayback_visibility_state_v2",
                    provenance=[
                        {
                            "kind": "archive_capture",
                            "capture_id": str(capture.id),
                            "observation_id": str(capture.observation_id),
                            "original_url": url,
                            "archive_url": str(capture.archive_url),
                            "captured_at": capture.captured_at.isoformat(),
                            "semantics": "role_visible_by_capture_time",
                            "previous_absent_capture_at": (
                                last_absent.captured_at.isoformat() if last_absent else None
                            ),
                            "completeness": capture.completeness,
                        }
                    ],
                )
                candidates.append(candidate)
                open_candidate = candidate
                state = "present"
        return candidates

    def _observation_candidates(
        self,
        role: RecurringRoleIdentity,
        observations: list[JobObservation],
    ) -> list[_Candidate]:
        candidates: list[_Candidate] = []
        for observation in observations:
            if observation.id is None or not self._title_matches(role, observation.raw_title):
                continue
            if observation.published_at:
                opened = observation.published_at.date()
                candidates.append(
                    _Candidate(
                        observation_id=observation.id,
                        representative=opened,
                        earliest=opened,
                        latest=opened,
                        precision="exact",
                        source_quality=float(observation.source_reliability.get("score", 0.9)),
                        evidence_quote=observation.evidence_excerpt or observation.raw_title,
                        uncertainty_reason="The source supplied an explicit publication date.",
                        method="source_published_date_v1",
                        provenance=[
                            {
                                "kind": "job_observation",
                                "observation_id": str(observation.id),
                                "source_url": str(observation.source_url),
                                "published_at": observation.published_at.isoformat(),
                                "content_hash": observation.content_hash,
                            }
                        ],
                    )
                )
            elif observation.source_type != "wayback":
                latest = observation.first_seen_at.date()
                candidates.append(
                    _Candidate(
                        observation_id=observation.id,
                        representative=latest,
                        earliest=None,
                        latest=latest,
                        precision="observed_by",
                        source_quality=min(0.75, float(observation.source_reliability.get("score", 0.7))),
                        evidence_quote=observation.evidence_excerpt or observation.raw_title,
                        uncertainty_reason=(
                            "1stSeen first observed the role on this date, but no earlier absence boundary is available."
                        ),
                        method="firstseen_observed_by_v1",
                        provenance=[
                            {
                                "kind": "firstseen_observation",
                                "observation_id": str(observation.id),
                                "source_url": str(observation.source_url),
                                "first_seen_at": observation.first_seen_at.isoformat(),
                                "content_hash": observation.content_hash,
                            }
                        ],
                    )
                )
        return candidates

    @staticmethod
    def _prior_candidates(events: Iterable[HistoricalOpeningEvent]) -> list[_Candidate]:
        return [
            _Candidate(
                observation_id=event.observation_id,
                representative=event.opened_on,
                earliest=event.opening_window_start,
                latest=event.opening_window_end,
                precision=event.date_precision,
                source_quality=event.source_quality,
                evidence_quote=event.evidence_quote,
                uncertainty_reason=event.uncertainty_reason,
                method=event.resolution_method,
                provenance=[*event.provenance],
            )
            for event in events
        ]

    def _merge_candidates(self, candidates: list[_Candidate]) -> list[_Candidate]:
        merged: list[_Candidate] = []
        precision_rank = {"observed_by": 0, "bounded": 1, "exact": 2}
        for candidate in sorted(
            candidates, key=lambda item: (item.representative, -precision_rank[item.precision])
        ):
            existing = next(
                (
                    item
                    for item in reversed(merged)
                    if abs((candidate.representative - item.representative).days) <= self.merge_window_days
                    and candidate.representative.year == item.representative.year
                ),
                None,
            )
            if existing is None:
                merged.append(candidate)
                continue
            existing.provenance.extend(
                item for item in candidate.provenance if item not in existing.provenance
            )
            if precision_rank[candidate.precision] > precision_rank[existing.precision]:
                existing.observation_id = candidate.observation_id
                existing.representative = candidate.representative
                existing.earliest = candidate.earliest
                existing.latest = candidate.latest
                existing.precision = candidate.precision
                existing.uncertainty_reason = candidate.uncertainty_reason
                existing.method = candidate.method
                existing.evidence_quote = candidate.evidence_quote
            elif existing.precision == candidate.precision == "bounded":
                starts = [item for item in (existing.earliest, candidate.earliest) if item]
                existing.earliest = max(starts) if starts else None
                existing.latest = min(existing.latest, candidate.latest)
                if existing.earliest and existing.earliest > existing.latest:
                    existing.earliest = min(starts)
                    existing.latest = max(existing.latest, candidate.latest)
            existing.source_quality = max(existing.source_quality, candidate.source_quality)
        return merged

    @staticmethod
    def _event(role: RecurringRoleIdentity, candidate: _Candidate) -> HistoricalOpeningEvent:
        uncertainty_days = (
            (candidate.latest - candidate.earliest).days if candidate.earliest is not None else None
        )
        event_id = uuid5(
            NAMESPACE_URL,
            f"historical-opening:{role.id}:{candidate.representative}:{candidate.observation_id}",
        )
        return HistoricalOpeningEvent(
            id=event_id,
            canonical_role_id=role.id,
            observation_id=candidate.observation_id,
            opened_on=candidate.representative,
            closed_on=candidate.closed_on,
            evidence_quote=candidate.evidence_quote[:8_192],
            source_quality=min(1.0, max(0.0, candidate.source_quality)),
            opening_window_start=candidate.earliest,
            opening_window_end=candidate.latest,
            date_precision=candidate.precision,
            uncertainty_days=uncertainty_days,
            uncertainty_reason=candidate.uncertainty_reason,
            resolution_method=candidate.method,
            provenance=candidate.provenance,
        )

    def _capture_matches(self, role: RecurringRoleIdentity, capture: ArchiveCapture) -> bool:
        if any(self._title_matches(role, title) for title in capture.detected_titles):
            return True
        text = " ".join(capture.evidence_excerpt.casefold().split())
        text_tokens = _tokens(text)
        recruiting_context = any(
            term in text for term in ("apply", "application", "job", "career", "opening")
        )
        return recruiting_context and any(
            bool(expected := _tokens(name))
            and len(expected.intersection(text_tokens)) / len(expected) >= 0.75
            for name in (role.canonical_title, *role.aliases)
        )

    @staticmethod
    def _title_matches(role: RecurringRoleIdentity, title: str) -> bool:
        observed = _tokens(title)
        for name in (role.canonical_title, *role.aliases):
            expected = _tokens(name)
            if expected and len(expected.intersection(observed)) / len(expected) >= 0.75:
                return True
        return False

    @staticmethod
    def _quote(role: RecurringRoleIdentity, text: str) -> str:
        compact = " ".join(text.split())
        lowered = compact.casefold()
        markers = [role.canonical_title, *role.aliases]
        positions = [lowered.find(marker.casefold()) for marker in markers]
        positions = [position for position in positions if position >= 0]
        if not positions:
            return compact[:1_000] or f"Archived evidence for {role.canonical_title}"
        start = max(0, min(positions) - 160)
        return compact[start : start + 1_000]
