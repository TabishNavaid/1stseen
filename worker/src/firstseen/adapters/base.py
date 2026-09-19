"""Adapter contract and transport primitives."""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from hashlib import sha256
from http.client import HTTPException
from threading import Lock
from time import monotonic, sleep
from typing import Any, Literal, Protocol
from urllib.error import HTTPError
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit
from urllib.request import HTTPRedirectHandler, OpenerDirector, Request, build_opener
from uuid import UUID

from pydantic import BaseModel, Field, HttpUrl

from firstseen.config import Settings, get_settings
from firstseen.inference import PageInferenceDecision
from firstseen.models import ArchiveCapture, AtsCategories, JobObservation
from firstseen.robots import (
    COLLECTOR_USER_AGENT,
    ROBOTS_MAX_BYTES,
    RobotsDisallowedError,
    RobotsFetch,
    RobotsGate,
)
from firstseen.security import PublicUrlPolicy, redact_sensitive_text

AdapterName = Literal[
    "greenhouse",
    "lever",
    "ashby",
    "smartrecruiters",
    "generic",
    "rss",
    "sitemap",
    "wayback",
    "reddit",
]
ExtractionRoute = Literal[
    "structured_endpoint", "json_ld", "embedded_data", "static_html", "playwright", "llm", "archive"
]


class SourceConfig(BaseModel):
    id: UUID
    company_id: UUID
    company: str = Field(min_length=1)
    adapter: AdapterName
    url: HttpUrl
    external_key: str | None = None
    trust_score: float = Field(default=0.7, ge=0, le=1)
    options: dict[str, Any] = Field(default_factory=dict)


@dataclass(frozen=True)
class FetchedDocument:
    url: str
    status: int
    content_type: str
    body: bytes

    @property
    def text(self) -> str:
        return self.body.decode("utf-8", errors="replace")

    @property
    def content_hash(self) -> str:
        return sha256(self.body).hexdigest()


class HttpTransport(Protocol):
    def get(self, url: str, *, accept: str = "*/*", max_bytes: int | None = None) -> FetchedDocument: ...


# The most one source may read, whatever its own `max_source_bytes` option asks for. MAX_SOURCE_BYTES (at most 10 MB)
# bounds every source; a source whose single response is legitimately larger, such as a Greenhouse board with a few
# thousand postings (Anduril's is 42 MB, and the board API has no paging), names its own limit instead, so raising
# one source never raises the others.
SOURCE_BYTES_CEILING = 64_000_000


def source_byte_limit(source: SourceConfig) -> int | None:
    """The source's own read limit from its `max_source_bytes` option, or None to use MAX_SOURCE_BYTES."""
    value = source.options.get("max_source_bytes")
    if value is None or isinstance(value, bool):
        return None
    try:
        limit = int(value)
    except (TypeError, ValueError):
        return None
    return max(10_000, min(limit, SOURCE_BYTES_CEILING))


class UrlLibTransport:
    """The one HTTP path every collector request takes: public-address policy, robots.txt, pacing, then a bounded read.

    With `ROBOTS_TXT_ENFORCED` on, robots.txt is honoured per `firstseen.robots`: read once per origin for the life of
    this transport, which is one run, and a refused URL raises `RobotsDisallowedError` before any request. Redirect
    targets are checked the same way. With it off (the default) robots.txt is never read.
    """

    def __init__(
        self,
        settings: Settings | None = None,
        *,
        url_policy: PublicUrlPolicy | None = None,
        clock: Callable[[], float] = monotonic,
        sleeper: Callable[[float], None] = sleep,
        opener: OpenerDirector | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.url_policy = url_policy or PublicUrlPolicy()
        self.robots = RobotsGate(self._fetch_robots) if self.settings.robots_txt_enforced else None
        self.opener = opener or build_opener(_SafeRedirectHandler(self.url_policy, self.robots))
        # robots.txt is read through its own opener, so a robots.txt redirect is never itself checked against robots.txt.
        self._robots_opener = opener or build_opener(_SafeRedirectHandler(self.url_policy))
        self._limiter = HostRateLimiter(
            self.settings.http_min_host_interval_seconds,
            clock=clock,
            sleeper=sleeper,
        )

    def get(self, url: str, *, accept: str = "*/*", max_bytes: int | None = None) -> FetchedDocument:
        limit = max_bytes or self.settings.max_source_bytes
        self.url_policy.validate(url)
        if self.robots is not None:
            self.robots.check(url)
        self._limiter.wait(url)
        request = Request(
            url,
            headers={
                "Accept": accept,
                "User-Agent": COLLECTOR_USER_AGENT,
            },
        )
        with self.opener.open(request, timeout=self.settings.http_timeout_seconds) as response:
            self.url_policy.validate(response.url)
            declared_length = response.headers.get("content-length")
            if declared_length:
                try:
                    if int(declared_length) > limit:
                        raise ValueError("source_response_too_large")
                except ValueError as exc:
                    if str(exc) == "source_response_too_large":
                        raise
                    # Broken Content-Length headers are ignored; the bounded read remains authoritative.
            body = response.read(limit + 1)
            if len(body) > limit:
                raise ValueError("source_response_too_large")
            return FetchedDocument(
                url=response.url,
                status=response.status,
                content_type=response.headers.get("content-type", ""),
                body=body,
            )

    def _fetch_robots(self, robots_url: str) -> RobotsFetch:
        """Read one robots.txt. No status means it could not be reached, which `RobotsPolicy` treats as disallow-all."""
        try:
            self.url_policy.validate(robots_url)
            self._limiter.wait(robots_url)
            request = Request(robots_url, headers={"Accept": "text/plain", "User-Agent": COLLECTOR_USER_AGENT})
            with self._robots_opener.open(request, timeout=self.settings.http_timeout_seconds) as response:
                self.url_policy.validate(response.url)
                return RobotsFetch(response.status, response.read(ROBOTS_MAX_BYTES))
        except HTTPError as error:
            error.close()
            return RobotsFetch(error.code)
        except (OSError, ValueError, HTTPException):
            return RobotsFetch(None)


class HostRateLimiter:
    """Schedule requests per host without retries or quota workarounds."""

    def __init__(
        self,
        interval_seconds: float,
        *,
        clock: Callable[[], float] = monotonic,
        sleeper: Callable[[float], None] = sleep,
    ) -> None:
        self.interval_seconds = max(0.0, interval_seconds)
        self.clock = clock
        self.sleeper = sleeper
        self._next_request_at: dict[str, float] = {}
        self._lock = Lock()

    def wait(self, url: str) -> None:
        host = (urlsplit(url).hostname or "").casefold()
        if not host or self.interval_seconds == 0:
            return
        with self._lock:
            now = self.clock()
            scheduled = max(now, self._next_request_at.get(host, now))
            self._next_request_at[host] = scheduled + self.interval_seconds
        delay = scheduled - now
        if delay > 0:
            self.sleeper(delay)


class _SafeRedirectHandler(HTTPRedirectHandler):
    def __init__(self, url_policy: PublicUrlPolicy, robots: RobotsGate | None = None) -> None:
        self.url_policy = url_policy
        self.robots = robots

    def redirect_request(self, req: Request, fp: Any, code: int, msg: str, headers: Any, newurl: str):
        self.url_policy.validate(newurl)
        if self.robots is not None:
            self.robots.check(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


@dataclass(frozen=True)
class JobCandidate:
    source_url: str
    apply_url: str
    raw_title: str
    company: str
    location: str | None = None
    employment_type: str | None = None
    published_at: datetime | None = None
    external_job_id: str | None = None
    evidence_excerpt: str = ""
    reliability: dict[str, Any] = field(default_factory=dict)
    archive_capture_at: datetime | None = None
    archive_url: str | None = None
    archive_original_url: str | None = None
    archive_digest: str | None = None
    observation_id: UUID | None = None
    ats_categories: AtsCategories | None = None


@dataclass(frozen=True)
class CollectionDiagnostic:
    code: str
    message: str
    severity: Literal["warning", "error"] = "warning"
    url: str | None = None
    details: dict[str, Any] = field(default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        bounded_details = {
            redact_sensitive_text(key, limit=100): (
                value
                if value is None or isinstance(value, (bool, int, float))
                else redact_sensitive_text(value)
            )
            for key, value in list(self.details.items())[:20]
        }
        return {
            "code": self.code[:100],
            "message": redact_sensitive_text(self.message),
            "severity": self.severity,
            "url": redact_sensitive_text(self.url, limit=2_000) if self.url else None,
            "details": bounded_details,
        }


def robots_diagnostic(refusal: RobotsDisallowedError) -> CollectionDiagnostic:
    """A URL robots.txt refused, as a typed diagnostic.

    A rule is a deliberate, stable skip, so it is a warning and does not make a collection partial. An unreachable
    robots.txt says nothing about what the site allows, so it is an error: the run is partial and retries next time.
    """
    ruled = refusal.code == "robots_disallowed"
    message = (
        "Skipped a URL that the site's robots.txt disallows."
        if ruled
        else "Skipped a URL because the site's robots.txt could not be read, so the whole site is treated "
        "as disallowed for this run."
    )
    return CollectionDiagnostic(refusal.code, message, "warning" if ruled else "error", refusal.url, refusal.details())


@dataclass(frozen=True)
class AdapterResult:
    observations: list[JobObservation]
    document_hash: str
    extraction_route: ExtractionRoute
    byte_count: int
    unchanged: bool = False
    archive_captures: list[ArchiveCapture] = field(default_factory=list)
    inference_decisions: list[PageInferenceDecision] = field(default_factory=list)
    complete: bool = True
    diagnostics: list[CollectionDiagnostic] = field(default_factory=list)


class SourceAdapter(ABC):
    name: AdapterName

    @abstractmethod
    def collect(
        self,
        source: SourceConfig,
        transport: HttpTransport,
        *,
        observed_at: datetime,
        previous_document_hash: str | None = None,
    ) -> AdapterResult:
        """Fetch and normalize a configured source without persisting it."""


def build_observation(
    source: SourceConfig,
    candidate: JobCandidate,
    *,
    observed_at: datetime,
    extraction_route: ExtractionRoute,
) -> JobObservation:
    published_at = candidate.published_at
    reliability_overrides: dict[str, Any] = {}
    if published_at is not None and published_at.tzinfo is None:
        published_at = None
        reliability_overrides = {"published_date_rejected": "timezone_missing"}
    elif published_at is not None and published_at > observed_at:
        rejected_published_at = published_at.isoformat()
        published_at = None
        reliability_overrides = {
            "published_date_rejected": "after_first_seen",
            "rejected_published_at": rejected_published_at,
        }
    identity_material = (
        candidate.external_job_id
        or _identity_url(candidate.apply_url)
        or (f"{candidate.source_url}|{candidate.raw_title}|{candidate.location or ''}")
    )
    identity_key = sha256(f"{source.id}|{identity_material}".encode()).hexdigest()
    canonical = "|".join(
        [
            candidate.raw_title.strip(),
            candidate.company.strip(),
            (candidate.location or "").strip(),
            (candidate.employment_type or "").strip(),
            candidate.source_url.strip(),
            candidate.apply_url.strip(),
            published_at.isoformat() if published_at else "",
            " ".join(candidate.evidence_excerpt.split()),
            # Archive capture time is source-supplied evidence, not a retrieval clock.
            # The schema requires one observation per capture, so two captures of an
            # unchanged page are distinct observations and must not collide on the
            # (source_id, content_hash) uniqueness. Non-archive candidates contribute
            # an empty component and keep their existing hashes.
            candidate.archive_capture_at.isoformat() if candidate.archive_capture_at else "",
        ]
    )
    content_hash = sha256(canonical.encode()).hexdigest()
    reliability = {
        "score": source.trust_score,
        "adapter": source.adapter,
        "route": extraction_route,
        **candidate.reliability,
        **reliability_overrides,
    }
    return JobObservation(
        id=candidate.observation_id,
        source_id=source.id,
        external_job_id=candidate.external_job_id,
        identity_key=identity_key,
        source_url=HttpUrl(candidate.source_url),
        apply_url=HttpUrl(candidate.apply_url),
        raw_title=candidate.raw_title.strip(),
        company=candidate.company.strip(),
        location=candidate.location.strip() if candidate.location else None,
        employment_type=candidate.employment_type.strip() if candidate.employment_type else None,
        ats_categories=(
            candidate.ats_categories
            if candidate.ats_categories and not candidate.ats_categories.is_empty
            else None
        ),
        published_at=published_at,
        first_seen_at=observed_at,
        last_seen_at=observed_at,
        content_hash=content_hash,
        source_type=source.adapter,
        source_reliability=reliability,
        extraction_method=extraction_route,
        evidence_excerpt=candidate.evidence_excerpt[:65_536],
        archive_capture_at=candidate.archive_capture_at,
        archive_url=HttpUrl(candidate.archive_url) if candidate.archive_url else None,
        archive_original_url=HttpUrl(candidate.archive_original_url)
        if candidate.archive_original_url
        else None,
        archive_digest=candidate.archive_digest,
    )


def build_observations(
    source: SourceConfig,
    candidates: list[JobCandidate],
    *,
    observed_at: datetime,
    extraction_route: ExtractionRoute,
) -> tuple[list[JobObservation], list[CollectionDiagnostic]]:
    """Normalize independently so one malformed candidate cannot discard valid sibling jobs."""
    observations: list[JobObservation] = []
    diagnostics: list[CollectionDiagnostic] = []
    for candidate in candidates:
        try:
            observations.append(
                build_observation(
                    source,
                    candidate,
                    observed_at=observed_at,
                    extraction_route=extraction_route,
                )
            )
        except ValueError as exc:
            diagnostics.append(
                CollectionDiagnostic(
                    "invalid_job_candidate_skipped",
                    "A detected job had invalid normalized fields and was skipped.",
                    "warning",
                    candidate.source_url,
                    {"error_type": type(exc).__name__},
                )
            )
    return observations, diagnostics


def _identity_url(url: str) -> str:
    """Remove only known tracking noise while retaining job-identifying parameters."""
    parsed = urlsplit(url)
    tracking_keys = {"fbclid", "gclid", "mc_cid", "mc_eid"}
    query = [
        (key, value)
        for key, value in parse_qsl(parsed.query, keep_blank_values=True)
        if not key.casefold().startswith("utm_") and key.casefold() not in tracking_keys
    ]
    return urlunsplit(
        (parsed.scheme.casefold(), parsed.netloc.casefold(), parsed.path, urlencode(sorted(query)), "")
    )
