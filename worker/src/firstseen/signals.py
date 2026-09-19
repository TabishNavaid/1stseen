"""Deterministic recruiting-signal collection and forecast change detection."""

from __future__ import annotations

import re
from abc import ABC, abstractmethod
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from hashlib import sha256
from html.parser import HTMLParser
from typing import Literal, Protocol, cast
from urllib.parse import urlparse
from uuid import UUID, uuid5
from xml.etree import ElementTree

from pydantic import BaseModel, Field, HttpUrl, model_validator

from .adapters.base import ExtractionRoute, HttpTransport, SourceConfig
from .adapters.common import parse_published_datetime, strip_html
from .forecasting import Forecast, Signal
from .recruiting_paths import sitemap_children
from .robots import RobotsDisallowedError
from .security import parse_untrusted_xml

SignalType = Literal[
    "career_page_changed",
    "internship_program_page_changed",
    "new_relevant_sitemap_url",
    "company_recruiting_blog_post",
    "university_recruiting_page_update",
    "new_ats_role_family_appearing",
    "community_recruiting_discussion",
]
CommunityEventType = Literal["applications_opened", "applications_closed", "applications_opening_soon"]
ClaimedDatePrecision = Literal["explicit", "relative_to_post", "relative_unresolved", "unknown"]
SocialSource = Literal["reddit", "community", "other"]

SIGNAL_STRENGTH: dict[SignalType, float] = {
    "career_page_changed": 0.45,
    "internship_program_page_changed": 0.68,
    "new_relevant_sitemap_url": 0.52,
    "company_recruiting_blog_post": 0.62,
    "university_recruiting_page_update": 0.66,
    "new_ats_role_family_appearing": 0.75,
    "community_recruiting_discussion": 0.30,
}

RECRUITING_TERMS = (
    "intern",
    "internship",
    "university",
    "campus",
    "student",
    "graduate",
    "new grad",
    "early career",
    "recruit",
    "application",
    "hiring",
    "career",
    "job",
)


class RecruitingSignal(BaseModel):
    """Normalized, source-backed supporting evidence; never an opening event."""

    id: UUID
    identity_key: str = Field(pattern=r"^[a-f0-9]{64}$")
    content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    company_id: UUID
    company: str = Field(min_length=1, max_length=300)
    canonical_role_id: UUID | None = None
    signal_type: SignalType
    observed_at: datetime
    claimed_event_at: datetime | None = None
    source_published_at: datetime | None = None
    community_event_type: CommunityEventType | None = None
    claimed_date_text: str | None = Field(default=None, max_length=200)
    claimed_date_precision: ClaimedDatePrecision | None = None
    evidence_semantics: Literal["supporting_only"] = "supporting_only"
    source_id: UUID
    source_url: HttpUrl
    source_reliability: float = Field(ge=0, le=1)
    signal_strength: float = Field(ge=0, le=1)
    evidence_snippet: str = Field(min_length=1, max_length=8_192)
    extraction_method: ExtractionRoute
    observation_id: UUID

    @model_validator(mode="after")
    def timestamps_are_aware(self) -> RecruitingSignal:
        for value in (self.observed_at, self.claimed_event_at, self.source_published_at):
            if value is not None and value.tzinfo is None:
                raise ValueError("signal timestamps must be timezone-aware")
        return self

    def as_forecast_signal(self) -> Signal:
        return Signal(
            observed_on=self.observed_at.date(),
            strength=self.signal_strength,
            reliability=self.source_reliability,
            kind=self.signal_type,
            evidence_id=str(self.id),
        )


class SignalSourceState(BaseModel):
    source_id: UUID
    meaningful_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    normalized_text: str = Field(default="", max_length=65_536)
    item_keys: tuple[str, ...] = ()
    urls: tuple[str, ...] = ()
    observed_at: datetime

    @model_validator(mode="after")
    def observed_time_is_aware(self) -> SignalSourceState:
        if self.observed_at.tzinfo is None:
            raise ValueError("signal state observed_at must be timezone-aware")
        return self


@dataclass(frozen=True)
class SignalCandidate:
    signal_type: SignalType
    source_url: str
    evidence_snippet: str
    extraction_method: ExtractionRoute
    claimed_event_at: datetime | None = None
    source_published_at: datetime | None = None
    community_event_type: CommunityEventType | None = None
    claimed_date_text: str | None = None
    claimed_date_precision: ClaimedDatePrecision | None = None
    strength: float | None = None


@dataclass(frozen=True)
class SignalAdapterResult:
    candidates: tuple[SignalCandidate, ...]
    state: SignalSourceState
    evidence_text: str
    document_hash: str
    byte_count: int


class RecruitingSignalAdapter(ABC):
    @abstractmethod
    def collect(
        self,
        source: SourceConfig,
        transport: HttpTransport,
        *,
        observed_at: datetime,
        previous_state: SignalSourceState | None,
    ) -> SignalAdapterResult: ...


class SocialRecruitingSignalAdapter(Protocol):
    """Narrow, read-only boundary for community recruiting-event evidence."""

    source_name: SocialSource

    def collect(self, company: str, *, since: datetime | None = None) -> Sequence[SignalCandidate]: ...


class _VisibleTextParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._ignored = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        if tag.lower() in {"script", "style", "noscript", "svg"}:
            self._ignored += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {"script", "style", "noscript", "svg"} and self._ignored:
            self._ignored -= 1

    def handle_data(self, data: str) -> None:
        clean = " ".join(data.split())
        if not self._ignored and clean:
            self.parts.append(clean)


_CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def _normalized_page_text(html: str) -> str:
    """Visible lines without control characters, within the stored 65,536-byte bound.

    The state row stores exactly this text, so the next fetch diffs against what this fetch saw.
    A character bound let a large non-ASCII page lose its tail on save and report that tail as
    newly added on every later change.
    """
    parser = _VisibleTextParser()
    parser.feed(_CONTROL_CHARACTERS.sub("", html))
    text = "\n".join(dict.fromkeys(parser.parts))
    encoded = text.encode()
    if len(encoded) <= 65_536:
        return text
    # Whole lines only, so a cut never leaves a fragment that looks newly added.
    return encoded[:65_536].decode(errors="ignore").rsplit("\n", 1)[0]


def _meaningful_hash(text: str) -> str:
    # The set of visible lines: a page serving the same lines in another order has not changed.
    # Ramp's careers page reorders its content on every request.
    lines = sorted({line.casefold() for line in text.splitlines()} - {""})
    return sha256("\n".join(lines).encode()).hexdigest()


def _relevant(text: str) -> bool:
    lowered = text.casefold()
    return any(term in lowered for term in RECRUITING_TERMS)


def _change_snippet(previous: str, current: str) -> str:
    """The recruiting lines this fetch added, or "" when it added none.

    Only added recruiting material is evidence that a program may be becoming active. Removed or
    reordered lines are not, and a generic "content changed" sentence is not evidence at all: it
    once stood in for an empty diff, matched the recruiting terms itself, and turned page
    reorderings into signals that moved forecast confidence.
    """
    old_lines = {line.casefold() for line in previous.splitlines()}
    added = [line for line in current.splitlines() if line.casefold() not in old_lines]
    return " · ".join([line for line in added if _relevant(line)][:5])[:8_192]


class CompanyPageSignalAdapter(RecruitingSignalAdapter):
    def collect(
        self,
        source: SourceConfig,
        transport: HttpTransport,
        *,
        observed_at: datetime,
        previous_state: SignalSourceState | None,
    ) -> SignalAdapterResult:
        document = transport.get(str(source.url), accept="text/html,application/xhtml+xml")
        text = _normalized_page_text(document.text)
        meaningful_hash = _meaningful_hash(text)
        candidates: list[SignalCandidate] = []
        if previous_state and previous_state.meaningful_hash != meaningful_hash:
            snippet = _change_snippet(previous_state.normalized_text, text)
            signal_type = self._type(source, f"{document.url}\n{text}")
            if snippet:
                candidates.append(
                    SignalCandidate(
                        signal_type,
                        document.url,
                        snippet,
                        "static_html",
                    )
                )
        state = SignalSourceState(
            source_id=source.id,
            meaningful_hash=meaningful_hash,
            normalized_text=text,
            observed_at=observed_at,
        )
        return SignalAdapterResult(
            tuple(candidates), state, text or "Empty visible page", document.content_hash, len(document.body)
        )

    @staticmethod
    def _type(source: SourceConfig, text: str) -> SignalType:
        explicit = source.options.get("signal_type")
        if explicit in SIGNAL_STRENGTH:
            return cast(SignalType, explicit)
        lowered = text.casefold()
        if any(
            term in lowered
            for term in ("university recruiting", "campus recruiting", "/university", "/campus")
        ):
            return "university_recruiting_page_update"
        if any(
            term in lowered
            for term in (
                "internship",
                "student program",
                "early career",
                "new grad",
                "/student",
                "/intern",
            )
        ):
            return "internship_program_page_changed"
        return "career_page_changed"


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _child_text(element: ElementTree.Element, name: str) -> str | None:
    for child in element:
        if _local_name(child.tag) == name and child.text:
            return child.text.strip()
    return None


class RecruitingFeedSignalAdapter(RecruitingSignalAdapter):
    def collect(
        self,
        source: SourceConfig,
        transport: HttpTransport,
        *,
        observed_at: datetime,
        previous_state: SignalSourceState | None,
    ) -> SignalAdapterResult:
        document = transport.get(
            str(source.url), accept="application/rss+xml,application/atom+xml,application/xml"
        )
        root = parse_untrusted_xml(document.body)
        entries: list[tuple[str, str, str, datetime | None]] = []
        for entry in root.iter():
            if _local_name(entry.tag) not in {"item", "entry"}:
                continue
            title = _child_text(entry, "title") or ""
            link = _child_text(entry, "link") or ""
            if not link:
                link = next(
                    (
                        child.attrib["href"]
                        for child in entry
                        if _local_name(child.tag) == "link" and child.attrib.get("href")
                    ),
                    "",
                )
            summary = strip_html(_child_text(entry, "description") or _child_text(entry, "summary") or "")
            key = _child_text(entry, "guid") or _child_text(entry, "id") or link or title
            published = parse_published_datetime(
                _child_text(entry, "pubDate") or _child_text(entry, "published")
            )
            if key and link:
                entries.append((key, link, " · ".join(part for part in (title, summary) if part), published))
        prior_keys = set(previous_state.item_keys if previous_state else ())
        emit_initial = bool(source.options.get("emit_initial_signals", False))
        candidates = tuple(
            SignalCandidate(
                "company_recruiting_blog_post",
                link,
                snippet[:8_192],
                "structured_endpoint",
                claimed_event_at=published,
            )
            for key, link, snippet, published in entries
            if _relevant(snippet) and (key not in prior_keys) and (previous_state or emit_initial)
        )
        state = SignalSourceState(
            source_id=source.id,
            meaningful_hash=document.content_hash,
            normalized_text="\n".join(item[2] for item in entries)[:65_536],
            item_keys=tuple(sorted({item[0] for item in entries})),
            observed_at=observed_at,
        )
        return SignalAdapterResult(
            candidates,
            state,
            state.normalized_text or "Empty recruiting feed",
            document.content_hash,
            len(document.body),
        )


class RecruitingSitemapSignalAdapter(RecruitingSignalAdapter):
    def collect(
        self,
        source: SourceConfig,
        transport: HttpTransport,
        *,
        observed_at: datetime,
        previous_state: SignalSourceState | None,
    ) -> SignalAdapterResult:
        documents: list[bytes] = []
        urls = self._urls(
            str(source.url),
            transport,
            documents,
            0,
            min(25, max(1, _safe_int(source.options.get("max_sitemaps"), 5))),
            set(),
        )
        relevant_urls = sorted({url for url in urls if _relevant(urlparse(url).path.replace("-", " "))})
        prior_urls = set(previous_state.urls if previous_state else ())
        emit_initial = bool(source.options.get("emit_initial_signals", False))
        candidates = tuple(
            SignalCandidate(
                "new_relevant_sitemap_url",
                url,
                f"New recruiting-related sitemap URL: {url}"[:8_192],
                "structured_endpoint",
            )
            for url in relevant_urls
            if url not in prior_urls and (previous_state or emit_initial)
        )
        combined_hash = sha256(b"\n".join(documents)).hexdigest()
        state = SignalSourceState(
            source_id=source.id,
            meaningful_hash=combined_hash,
            normalized_text="\n".join(relevant_urls)[:65_536],
            urls=tuple(relevant_urls),
            observed_at=observed_at,
        )
        return SignalAdapterResult(
            candidates,
            state,
            state.normalized_text or "No recruiting sitemap URLs",
            combined_hash,
            sum(len(item) for item in documents),
        )

    def _urls(
        self,
        url: str,
        transport: HttpTransport,
        documents: list[bytes],
        depth: int,
        max_sitemaps: int,
        visited: set[str],
    ) -> list[str]:
        if url in visited or len(visited) >= max_sitemaps:
            return []
        visited.add(url)
        document = transport.get(url, accept="application/xml,text/xml")
        documents.append(document.body)
        root = parse_untrusted_xml(document.body)
        locations = [
            child.text.strip() for child in root.iter() if _local_name(child.tag) == "loc" and child.text
        ]
        if _local_name(root.tag) != "sitemapindex" or depth >= 1:
            return locations
        nested: list[str] = []
        for location in sitemap_children(locations):
            nested.extend(
                self._urls(location, transport, documents, depth + 1, max_sitemaps, visited)
            )
        return nested


def _safe_int(value: object, default: int) -> int:
    try:
        return int(value) if isinstance(value, (str, bytes, int, float)) else default
    except (TypeError, ValueError):
        return default


class AtsRoleFamilySignalDetector:
    def detect(
        self,
        *,
        source_url: str,
        previous_families: Iterable[str],
        current_families: Iterable[str],
    ) -> tuple[SignalCandidate, ...]:
        previous = {item.casefold().strip() for item in previous_families}
        added = sorted({item.casefold().strip() for item in current_families} - previous)
        return tuple(
            SignalCandidate(
                "new_ats_role_family_appearing",
                source_url,
                f"New ATS role family observed: {family}"[:8_192],
                "structured_endpoint",
            )
            for family in added
            if family
        )


class SignalAdapterRegistry:
    def __init__(self) -> None:
        self.page = CompanyPageSignalAdapter()
        self.feed = RecruitingFeedSignalAdapter()
        self.sitemap = RecruitingSitemapSignalAdapter()

    def get(self, source: SourceConfig) -> RecruitingSignalAdapter:
        if source.adapter == "rss":
            return self.feed
        if source.adapter == "sitemap":
            return self.sitemap
        return self.page


class RecruitingSignalStore(Protocol):
    def get_signal_source_state(self, source_id: UUID) -> SignalSourceState | None: ...

    def save_signal_source_state(self, state: SignalSourceState) -> None: ...

    def save_signal_observation(
        self,
        source: SourceConfig,
        *,
        observed_at: datetime,
        document_hash: str,
        evidence_text: str,
        extraction_method: ExtractionRoute,
    ) -> UUID: ...

    def resolve_signal_role(self, company_id: UUID, evidence: str) -> UUID | None: ...

    def list_company_role_ids(self, company_id: UUID) -> list[UUID]: ...

    def upsert_recruiting_signal(self, signal: RecruitingSignal) -> bool: ...


@dataclass(frozen=True)
class SignalIngestionSummary:
    source_id: UUID
    detected: int
    created: int
    unchanged: int
    affected_role_ids: tuple[UUID, ...]
    signal_ids: tuple[UUID, ...]
    # Set when the source was not read at all, to the typed reason (`robots_disallowed`, `robots_unreachable`).
    skipped: str | None = None


class RecruitingSignalIngestionService:
    def __init__(
        self,
        store: RecruitingSignalStore,
        transport: HttpTransport,
        registry: SignalAdapterRegistry | None = None,
    ) -> None:
        self.store = store
        self.transport = transport
        self.registry = registry or SignalAdapterRegistry()

    def ingest(self, source: SourceConfig, *, observed_at: datetime) -> SignalIngestionSummary:
        previous = self.store.get_signal_source_state(source.id)
        try:
            result = self.registry.get(source).collect(
                source, self.transport, observed_at=observed_at, previous_state=previous
            )
        except RobotsDisallowedError as refusal:
            # robots.txt does not allow this source (robots.py): no observation and no state change, so the next
            # permitted read diffs against what was last actually seen.
            return SignalIngestionSummary(source.id, 0, 0, 0, (), (), skipped=refusal.code)
        route = (
            result.candidates[0].extraction_method
            if result.candidates
            else ("structured_endpoint" if source.adapter in {"rss", "sitemap"} else "static_html")
        )
        observation_id = self.store.save_signal_observation(
            source,
            observed_at=observed_at,
            document_hash=result.document_hash,
            evidence_text=result.evidence_text[:65_536],
            extraction_method=route,
        )
        created = unchanged = 0
        signal_ids: list[UUID] = []
        role_ids: set[UUID] = set()
        for candidate in result.candidates:
            role_id = self.store.resolve_signal_role(source.company_id, candidate.evidence_snippet)
            signal = self._normalize(source, candidate, observed_at, observation_id, role_id)
            if self.store.upsert_recruiting_signal(signal):
                created += 1
                signal_ids.append(signal.id)
                if role_id:
                    role_ids.add(role_id)
                else:
                    role_ids.update(self.store.list_company_role_ids(source.company_id))
            else:
                unchanged += 1
        self.store.save_signal_source_state(result.state)
        return SignalIngestionSummary(
            source.id,
            len(result.candidates),
            created,
            unchanged,
            tuple(sorted(role_ids, key=str)),
            tuple(signal_ids),
        )

    def ingest_social(
        self,
        source: SourceConfig,
        adapter: SocialRecruitingSignalAdapter,
        *,
        observed_at: datetime,
    ) -> SignalIngestionSummary:
        """Persist bounded community evidence without treating it as a job posting."""
        previous = self.store.get_signal_source_state(source.id)
        candidates = tuple(adapter.collect(source.company, since=previous.observed_at if previous else None))
        evidence_text = "\n".join(candidate.evidence_snippet for candidate in candidates)
        document_hash = sha256(evidence_text.encode()).hexdigest()
        observation_id = self.store.save_signal_observation(
            source,
            observed_at=observed_at,
            document_hash=document_hash,
            evidence_text=evidence_text[:65_536] or "No new relevant Reddit recruiting claims.",
            extraction_method=(
                "llm"
                if any(item.extraction_method == "llm" for item in candidates)
                else "structured_endpoint"
            ),
        )
        created = unchanged = 0
        signal_ids: list[UUID] = []
        role_ids: set[UUID] = set()
        for candidate in candidates:
            role_id = self.store.resolve_signal_role(source.company_id, candidate.evidence_snippet)
            signal = self._normalize(source, candidate, observed_at, observation_id, role_id)
            if self.store.upsert_recruiting_signal(signal):
                created += 1
                signal_ids.append(signal.id)
                if role_id:
                    role_ids.add(role_id)
                else:
                    role_ids.update(self.store.list_company_role_ids(source.company_id))
            else:
                unchanged += 1
        self.store.save_signal_source_state(
            SignalSourceState(
                source_id=source.id,
                meaningful_hash=document_hash,
                normalized_text=evidence_text[:65_536],
                item_keys=tuple(str(item.source_url) for item in candidates),
                observed_at=observed_at,
            )
        )
        return SignalIngestionSummary(
            source.id,
            len(candidates),
            created,
            unchanged,
            tuple(sorted(role_ids, key=str)),
            tuple(signal_ids),
        )

    @staticmethod
    def _normalize(
        source: SourceConfig,
        candidate: SignalCandidate,
        observed_at: datetime,
        observation_id: UUID,
        role_id: UUID | None,
    ) -> RecruitingSignal:
        identity_material = "|".join(
            (
                str(source.id),
                candidate.signal_type,
                candidate.source_url,
                candidate.claimed_event_at.isoformat() if candidate.claimed_event_at else "",
                candidate.community_event_type or "",
                " ".join(candidate.evidence_snippet.casefold().split()),
            )
        )
        identity_key = sha256(identity_material.encode()).hexdigest()
        content_hash = sha256(
            f"{identity_key}|{role_id or ''}|{candidate.strength or SIGNAL_STRENGTH[candidate.signal_type]}".encode()
        ).hexdigest()
        signal_id = uuid5(UUID("ed97b6c7-e00c-4b45-81d8-17e558db0696"), identity_key)
        reliability = source.trust_score
        if candidate.signal_type == "community_recruiting_discussion":
            reliability = min(reliability, 0.45)
        return RecruitingSignal(
            id=signal_id,
            identity_key=identity_key,
            content_hash=content_hash,
            company_id=source.company_id,
            company=source.company,
            canonical_role_id=role_id,
            signal_type=candidate.signal_type,
            observed_at=observed_at.astimezone(UTC),
            claimed_event_at=candidate.claimed_event_at,
            source_published_at=candidate.source_published_at,
            community_event_type=candidate.community_event_type,
            claimed_date_text=candidate.claimed_date_text,
            claimed_date_precision=candidate.claimed_date_precision,
            source_id=source.id,
            source_url=HttpUrl(candidate.source_url),
            source_reliability=reliability,
            signal_strength=candidate.strength or SIGNAL_STRENGTH[candidate.signal_type],
            evidence_snippet=candidate.evidence_snippet,
            extraction_method=candidate.extraction_method,
            observation_id=observation_id,
        )


@dataclass(frozen=True)
class StoredForecastVersion:
    id: UUID
    role_id: UUID
    forecast: Forecast


@dataclass(frozen=True)
class ForecastChange:
    before_forecast_id: UUID
    after_forecast_id: UUID
    trigger_signal_ids: tuple[UUID, ...]
    material: bool
    confidence_delta: float
    point_date_delta_days: int
    interval_start_delta_days: int
    interval_end_delta_days: int
    reasons: tuple[str, ...] = field(default_factory=tuple)


class ForecastChangeDetector:
    """Fixed, auditable materiality rules; no model or LLM judgment."""

    def __init__(self, *, confidence_points: float = 1.0, date_days: int = 3) -> None:
        self.confidence_points = confidence_points
        self.date_days = date_days

    def compare(
        self,
        before: StoredForecastVersion,
        after: StoredForecastVersion,
        trigger_signal_ids: Iterable[UUID],
    ) -> ForecastChange:
        confidence_delta = round(after.forecast.confidence - before.forecast.confidence, 2)
        point_delta = (after.forecast.point_date - before.forecast.point_date).days
        start_delta = (after.forecast.window_start - before.forecast.window_start).days
        end_delta = (after.forecast.window_end - before.forecast.window_end).days
        reasons: list[str] = []
        if abs(confidence_delta) >= self.confidence_points:
            reasons.append("confidence_threshold_crossed")
        if abs(point_delta) >= self.date_days:
            reasons.append("expected_date_threshold_crossed")
        if max(abs(start_delta), abs(end_delta)) >= self.date_days:
            reasons.append("prediction_interval_threshold_crossed")
        return ForecastChange(
            before.id,
            after.id,
            tuple(trigger_signal_ids),
            bool(reasons),
            confidence_delta,
            point_delta,
            start_delta,
            end_delta,
            tuple(reasons),
        )


class ForecastVersionStore(Protocol):
    def latest_forecast_version(self, role_id: UUID) -> StoredForecastVersion | None: ...

    def save_signal_forecast_version(
        self,
        role_id: UUID,
        forecast: Forecast,
        *,
        supersedes_id: UUID | None,
        trigger_signal_ids: Sequence[UUID],
    ) -> StoredForecastVersion: ...

    def save_forecast_change(self, change: ForecastChange) -> None: ...


class SignalForecastVersionService:
    def __init__(
        self,
        store: ForecastVersionStore,
        detector: ForecastChangeDetector | None = None,
    ) -> None:
        self.store = store
        self.detector = detector or ForecastChangeDetector()
        # "inserted", "first_version", or "unchanged" for the most recent persist_recomputed call.
        self.last_outcome: str | None = None

    def persist_recomputed(
        self,
        role_id: UUID,
        forecast: Forecast,
        *,
        trigger_signal_ids: Sequence[UUID],
    ) -> ForecastChange | None:
        before = self.store.latest_forecast_version(role_id)
        if before is not None and before.forecast.input_fingerprint == forecast.input_fingerprint:
            # Identical inputs: a re-run writes no version and no change row.
            self.last_outcome = "unchanged"
            return None
        after = self.store.save_signal_forecast_version(
            role_id,
            forecast,
            supersedes_id=before.id if before else None,
            trigger_signal_ids=trigger_signal_ids,
        )
        if not before:
            self.last_outcome = "first_version"
            return None
        self.last_outcome = "inserted"
        change = self.detector.compare(before, after, trigger_signal_ids)
        self.store.save_forecast_change(change)
        return change
