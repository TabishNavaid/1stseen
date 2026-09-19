"""Official structured endpoint adapters for major applicant tracking systems."""

from __future__ import annotations

import json
from datetime import datetime
from hashlib import sha256
from typing import Any

from firstseen.models import AtsCategories

from .base import (
    AdapterResult,
    CollectionDiagnostic,
    HttpTransport,
    JobCandidate,
    SourceAdapter,
    SourceConfig,
    build_observations,
    source_byte_limit,
)
from .common import location_text, parse_published_datetime, strip_html


def _category_text(value: Any) -> str | None:
    """A category's display text: a plain string, or the label or name of an object."""
    if isinstance(value, dict):
        value = value.get("label") or value.get("name")
    if not isinstance(value, str):
        return None
    return " ".join(value.split())[:300] or None


def _categories(**values: Any) -> AtsCategories | None:
    categories = AtsCategories(**{key: _category_text(value) for key, value in values.items()})
    return None if categories.is_empty else categories


class _JsonEndpointAdapter(SourceAdapter):
    reliability_label = "official_public_endpoint"

    def endpoint(self, source: SourceConfig) -> str:
        return str(source.url)

    def candidates(self, source: SourceConfig, payload: Any) -> list[JobCandidate]:
        raise NotImplementedError

    def payload_items(self, payload: Any) -> list[Any] | None:
        raise NotImplementedError

    def payload_diagnostics(
        self, payload: Any, items: list[Any], *, url: str
    ) -> list[CollectionDiagnostic]:
        return []

    def collect(
        self,
        source: SourceConfig,
        transport: HttpTransport,
        *,
        observed_at: datetime,
        previous_document_hash: str | None = None,
    ) -> AdapterResult:
        # A source's own limit is passed only when it has one, so a transport that predates the option still works.
        limit = source_byte_limit(source)
        document = (
            transport.get(self.endpoint(source), accept="application/json", max_bytes=limit)
            if limit is not None
            else transport.get(self.endpoint(source), accept="application/json")
        )
        if previous_document_hash == document.content_hash:
            return AdapterResult([], document.content_hash, "structured_endpoint", len(document.body), True)
        diagnostics: list[CollectionDiagnostic] = []
        if document.content_type and "json" not in document.content_type.casefold():
            diagnostics.append(
                CollectionDiagnostic(
                    "unexpected_content_type",
                    "The structured endpoint returned JSON under an unexpected content type.",
                    "warning",
                    document.url,
                    {"content_type": document.content_type[:200]},
                )
            )
        try:
            payload = json.loads(document.text)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return AdapterResult(
                [],
                document.content_hash,
                "structured_endpoint",
                len(document.body),
                complete=False,
                diagnostics=[
                    CollectionDiagnostic(
                        "invalid_json_response",
                        "The structured endpoint did not return valid JSON.",
                        "error",
                        document.url,
                        {"content_type": document.content_type[:200]},
                    )
                ],
            )
        items = self.payload_items(payload)
        if items is None:
            return AdapterResult(
                [],
                document.content_hash,
                "structured_endpoint",
                len(document.body),
                complete=False,
                diagnostics=[
                    CollectionDiagnostic(
                        "unexpected_json_shape",
                        "The structured endpoint JSON did not match the supported response shape.",
                        "error",
                        document.url,
                    )
                ],
            )
        candidates = self.candidates(source, payload)
        diagnostics.extend(self.payload_diagnostics(payload, items, url=document.url))
        skipped = len(items) - len(candidates)
        if skipped:
            diagnostics.append(
                CollectionDiagnostic(
                    "malformed_job_entries_skipped",
                    f"Skipped {skipped} structured entries missing required job fields.",
                    "warning" if candidates else "error",
                    document.url,
                    {"entries": len(items), "accepted": len(candidates), "skipped": skipped},
                )
            )
        observations, normalization_diagnostics = build_observations(
            source,
            candidates,
            observed_at=observed_at,
            extraction_route="structured_endpoint",
        )
        diagnostics.extend(normalization_diagnostics)
        return AdapterResult(
            observations,
            document.content_hash,
            "structured_endpoint",
            len(document.body),
            complete=not bool(items and not observations)
            and not any(item.severity == "error" for item in diagnostics),
            diagnostics=diagnostics,
        )

    def reliability(self) -> dict[str, Any]:
        return {"endpoint_kind": self.reliability_label, "published_date_semantics": "source_explicit_only"}


class GreenhouseAdapter(_JsonEndpointAdapter):
    name = "greenhouse"

    def endpoint(self, source: SourceConfig) -> str:
        if source.external_key:
            return f"https://boards-api.greenhouse.io/v1/boards/{source.external_key}/jobs?content=true"
        return str(source.url)

    def payload_items(self, payload: Any) -> list[Any] | None:
        return payload.get("jobs") if isinstance(payload, dict) and isinstance(payload.get("jobs"), list) else None

    def candidates(self, source: SourceConfig, payload: Any) -> list[JobCandidate]:
        results: list[JobCandidate] = []
        for job in payload.get("jobs", []):
            if not isinstance(job, dict):
                continue
            url = job.get("absolute_url")
            title = job.get("title")
            if not url or not title:
                continue
            # `first_published` is the board's own first-publication timestamp and is
            # the explicit source field for this adapter. `updated_at` remains
            # intentionally unused: it moves whenever a posting is edited.
            published_at = parse_published_datetime(job.get("first_published"))
            results.append(
                JobCandidate(
                    source_url=url,
                    apply_url=url,
                    raw_title=title,
                    company=source.company,
                    location=location_text(job.get("location")),
                    external_job_id=str(job.get("id")) if job.get("id") is not None else None,
                    published_at=published_at,
                    evidence_excerpt=strip_html(str(job.get("content", ""))),
                    ats_categories=_categories(
                        department="; ".join(
                            name
                            for item in job.get("departments") or []
                            if isinstance(item, dict) and (name := _category_text(item.get("name")))
                        )
                    ),
                    reliability={
                        **self.reliability(),
                        "published_date_available": published_at is not None,
                        "published_date_field": "first_published" if published_at else None,
                    },
                )
            )
        return results


class LeverAdapter(_JsonEndpointAdapter):
    name = "lever"

    def endpoint(self, source: SourceConfig) -> str:
        if source.external_key:
            return f"https://api.lever.co/v0/postings/{source.external_key}?mode=json"
        return str(source.url)

    def payload_items(self, payload: Any) -> list[Any] | None:
        return payload if isinstance(payload, list) else None

    def candidates(self, source: SourceConfig, payload: Any) -> list[JobCandidate]:
        results: list[JobCandidate] = []
        for job in payload if isinstance(payload, list) else []:
            if not isinstance(job, dict):
                continue
            title = job.get("text")
            source_url = job.get("hostedUrl") or job.get("applyUrl")
            apply_url = job.get("applyUrl") or source_url
            if not title or not source_url or not apply_url:
                continue
            categories = job.get("categories") or {}
            results.append(
                JobCandidate(
                    source_url=source_url,
                    apply_url=apply_url,
                    raw_title=title,
                    company=source.company,
                    location=categories.get("location"),
                    employment_type=categories.get("commitment"),
                    published_at=parse_published_datetime(job.get("createdAt")),
                    external_job_id=str(job.get("id")) if job.get("id") else None,
                    evidence_excerpt=strip_html(
                        str(job.get("descriptionPlain") or job.get("description") or "")
                    ),
                    ats_categories=_categories(department=categories.get("department"), team=categories.get("team")),
                    reliability={
                        **self.reliability(),
                        "published_date_field": "createdAt" if job.get("createdAt") else None,
                    },
                )
            )
        return results


class AshbyAdapter(_JsonEndpointAdapter):
    name = "ashby"

    def endpoint(self, source: SourceConfig) -> str:
        if source.external_key:
            return f"https://api.ashbyhq.com/posting-api/job-board/{source.external_key}"
        return str(source.url)

    def payload_items(self, payload: Any) -> list[Any] | None:
        return (
            payload.get("jobs")
            if isinstance(payload, dict) and isinstance(payload.get("jobs"), list)
            else None
        )

    def candidates(self, source: SourceConfig, payload: Any) -> list[JobCandidate]:
        results: list[JobCandidate] = []
        for job in payload.get("jobs", []):
            if not isinstance(job, dict):
                continue
            source_url = job.get("jobUrl") or job.get("applyUrl")
            apply_url = job.get("applyUrl") or source_url
            if not job.get("title") or not source_url or not apply_url:
                continue
            results.append(
                JobCandidate(
                    source_url=source_url,
                    apply_url=apply_url,
                    raw_title=job["title"],
                    company=source.company,
                    location=location_text(job.get("location")),
                    employment_type=job.get("employmentType"),
                    published_at=parse_published_datetime(job.get("publishedAt")),
                    external_job_id=str(job.get("id")) if job.get("id") else None,
                    evidence_excerpt=strip_html(
                        str(job.get("descriptionHtml") or job.get("descriptionPlain") or "")
                    ),
                    ats_categories=_categories(department=job.get("department"), team=job.get("team")),
                    reliability={
                        **self.reliability(),
                        "published_date_field": "publishedAt" if job.get("publishedAt") else None,
                    },
                )
            )
        return results


class SmartRecruitersAdapter(_JsonEndpointAdapter):
    name = "smartrecruiters"

    def endpoint(self, source: SourceConfig) -> str:
        if source.external_key:
            return f"https://api.smartrecruiters.com/v1/companies/{source.external_key}/postings?limit=100"
        return str(source.url)

    def payload_items(self, payload: Any) -> list[Any] | None:
        return (
            payload.get("content")
            if isinstance(payload, dict) and isinstance(payload.get("content"), list)
            else None
        )

    def payload_diagnostics(
        self, payload: Any, items: list[Any], *, url: str
    ) -> list[CollectionDiagnostic]:
        total = payload.get("totalFound") if isinstance(payload, dict) else None
        if isinstance(total, int) and total > len(items):
            return [
                CollectionDiagnostic(
                    "structured_page_truncated",
                    "The endpoint reports more jobs than the supported response page returned.",
                    "error",
                    url,
                    {"reported": total, "received": len(items), "limit": 100},
                )
            ]
        return []

    def candidates(self, source: SourceConfig, payload: Any) -> list[JobCandidate]:
        results: list[JobCandidate] = []
        for job in payload.get("content", []):
            if not isinstance(job, dict):
                continue
            ref = job.get("ref") or job.get("postingUrl")
            if isinstance(ref, dict):
                ref = ref.get("jobAd") or ref.get("apply")
            apply_url = job.get("applyUrl") or ref
            if not job.get("name") or not ref or not apply_url:
                continue
            employment = job.get("typeOfEmployment") or {}
            results.append(
                JobCandidate(
                    source_url=ref,
                    apply_url=apply_url,
                    raw_title=job["name"],
                    company=source.company,
                    location=location_text(job.get("location")),
                    employment_type=employment.get("label")
                    if isinstance(employment, dict)
                    else str(employment),
                    published_at=parse_published_datetime(job.get("releasedDate")),
                    external_job_id=str(job.get("id")) if job.get("id") else None,
                    evidence_excerpt=strip_html(str(job.get("jobAd") or "")),
                    ats_categories=_categories(
                        department=job.get("department"),
                        function=job.get("function"),
                        # The level's id ("internship", "entry_level", "mid_senior_level") is the
                        # stable value; its label is localized display text.
                        experience_level=(job.get("experienceLevel") or {}).get("id")
                        if isinstance(job.get("experienceLevel"), dict)
                        else job.get("experienceLevel"),
                    ),
                    reliability={
                        **self.reliability(),
                        "published_date_field": "releasedDate" if job.get("releasedDate") else None,
                    },
                )
            )
        return results


def composite_document_hash(documents: list[bytes]) -> str:
    return sha256(b"\0".join(documents)).hexdigest()
