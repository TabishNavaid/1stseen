"""Validated records at the evidence, forecasting, and agent audit boundaries."""

from __future__ import annotations

from datetime import date, datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, HttpUrl, model_validator


class SourceRecord(BaseModel):
    id: UUID | None = None
    company_id: UUID
    url: HttpUrl
    kind: Literal[
        "careers_page",
        "campus_page",
        "ats",
        "sitemap",
        "feed",
        "related_career_page",
        "archive",
        "recruiter_post",
        "program_page",
    ]
    trust_score: float = Field(ge=0, le=1)


class RawJobObservation(BaseModel):
    id: UUID | None = None
    source_id: UUID
    observed_at: datetime
    content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    extraction_method: Literal["http", "playwright", "api", "archive"]
    raw_text: str = Field(min_length=1)
    raw_payload: dict[str, Any] = Field(default_factory=dict)


class AtsCategories(BaseModel):
    """How the applicant tracking system itself files a posting.

    Department and team (Greenhouse, Lever, Ashby, SmartRecruiters), plus SmartRecruiters'
    function and experience level. Kept as source evidence for scope classification; never part
    of a posting's identity or content hash.
    """

    department: str | None = Field(default=None, max_length=300)
    team: str | None = Field(default=None, max_length=300)
    function: str | None = Field(default=None, max_length=300)
    experience_level: str | None = Field(default=None, max_length=100)

    @property
    def is_empty(self) -> bool:
        return not any((self.department, self.team, self.function, self.experience_level))


class JobObservation(BaseModel):
    """A normalized, source-backed job record.

    `published_at` is nullable source data. `first_seen_at` and `last_seen_at` are
    1stSeen observation times and must never be used as substitutes for it.
    """

    id: UUID | None = None
    source_id: UUID
    external_job_id: str | None = None
    identity_key: str = Field(pattern=r"^[a-f0-9]{64}$")
    source_url: HttpUrl
    apply_url: HttpUrl
    raw_title: str = Field(min_length=1, max_length=500)
    company: str = Field(min_length=1, max_length=300)
    location: str | None = Field(default=None, max_length=500)
    employment_type: str | None = Field(default=None, max_length=200)
    published_at: datetime | None = None
    first_seen_at: datetime
    last_seen_at: datetime
    content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    source_type: str
    source_reliability: dict[str, Any]
    extraction_method: Literal[
        "structured_endpoint", "json_ld", "embedded_data", "static_html", "playwright", "llm", "archive"
    ]
    evidence_excerpt: str = Field(default="", max_length=65_536)
    archive_capture_at: datetime | None = None
    archive_url: HttpUrl | None = None
    archive_original_url: HttpUrl | None = None
    archive_digest: str | None = None
    ats_categories: AtsCategories | None = None

    @property
    def is_current(self) -> bool:
        return self.last_seen_at >= self.first_seen_at


class HistoricalOpeningEvent(BaseModel):
    id: UUID | None = None
    canonical_role_id: UUID
    observation_id: UUID
    opened_on: date
    closed_on: date | None = None
    evidence_quote: str = Field(min_length=1)
    source_quality: float = Field(ge=0, le=1)
    opening_window_start: date | None = None
    opening_window_end: date
    date_precision: Literal["exact", "bounded", "observed_by"]
    uncertainty_days: int | None = Field(default=None, ge=0)
    uncertainty_reason: str = Field(min_length=1)
    resolution_method: str = Field(min_length=1)
    provenance: list[dict[str, Any]] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_uncertainty(self) -> HistoricalOpeningEvent:
        if self.opening_window_start and self.opening_window_start > self.opened_on:
            raise ValueError("opening_window_start cannot be after opened_on")
        if self.opening_window_end < self.opened_on:
            raise ValueError("opening_window_end cannot be before opened_on")
        if self.date_precision == "exact":
            if self.opening_window_start != self.opened_on or self.opening_window_end != self.opened_on:
                raise ValueError("exact events require a zero-width opening window")
            if self.uncertainty_days != 0:
                raise ValueError("exact events require zero uncertainty_days")
        if self.date_precision == "bounded" and self.opening_window_start is None:
            raise ValueError("bounded events require opening_window_start")
        if self.opening_window_start is not None:
            width = (self.opening_window_end - self.opening_window_start).days
            if self.uncertainty_days != width:
                raise ValueError("uncertainty_days must equal the opening window width")
        return self


class ArchiveCapture(BaseModel):
    """An immutable Wayback observation; capture time means content existed by then."""

    id: UUID
    observation_id: UUID
    source_id: UUID
    original_url: HttpUrl
    archive_url: HttpUrl
    captured_at: datetime
    status_code: int = Field(ge=200, le=399)
    redirect_url: HttpUrl | None = None
    archive_digest: str | None = None
    content_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    meaningful_hash: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    change_kind: Literal["first_observed", "unchanged", "meaningful_change", "redirect", "unavailable"]
    completeness: float = Field(ge=0, le=1)
    is_partial: bool
    detected_titles: list[str] = Field(default_factory=list)
    evidence_excerpt: str = Field(default="", max_length=65_536)


class ForecastEvidenceRecord(BaseModel):
    observation_id: UUID
    historical_opening_event_id: UUID | None = None
    signal_id: UUID | None = None
    contribution: Literal[
        "role_history",
        "company_prior",
        "role_family_prior",
        "signal",
        "quality",
        "recency",
        "company_scale",
    ]
    weight: float = Field(ge=0, le=1)


class AgentRunRecord(BaseModel):
    id: UUID | None = None
    agent_name: str
    purpose: str
    status: Literal["running", "succeeded", "partial", "failed"] = "running"
    started_at: datetime
    finished_at: datetime | None = None
    input_fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    error: dict[str, Any] | None = None


class AgentToolCallRecord(BaseModel):
    agent_run_id: UUID
    tool_name: str
    started_at: datetime
    finished_at: datetime | None = None
    status: Literal["running", "succeeded", "failed"] = "running"
    input_redacted: dict[str, Any] = Field(default_factory=dict)
    output_redacted: dict[str, Any] = Field(default_factory=dict)


class ModelUsageRecord(BaseModel):
    agent_run_id: UUID | None = None
    tool_call_id: UUID | None = None
    provider: str
    model: str
    capability: Literal["extract", "classify", "normalize", "reason"]
    prompt_tokens: int = Field(ge=0)
    completion_tokens: int = Field(ge=0)
    estimated_cost_usd: float = Field(ge=0)
    latency_ms: int = Field(ge=0)
    success: bool
    failure_kind: (
        Literal[
            "rate_limit",
            "quota_exhausted",
            "temporary_provider",
            "timeout",
            "invalid_structured_output",
            "permanent_provider",
        ]
        | None
    ) = None
    fallback_reason: str | None = None
