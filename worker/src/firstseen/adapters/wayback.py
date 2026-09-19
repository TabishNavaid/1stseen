"""Internet Archive Wayback adapter for historical recruiting evidence."""

from __future__ import annotations

import json
import re
from datetime import UTC, datetime
from hashlib import sha256
from html.parser import HTMLParser
from typing import ClassVar
from urllib.parse import urlencode
from uuid import NAMESPACE_URL, uuid5

from pydantic import HttpUrl

from firstseen.inference import PageInferenceDecision
from firstseen.models import ArchiveCapture, JobObservation
from firstseen.robots import RobotsDisallowedError

from .base import (
    AdapterResult,
    CollectionDiagnostic,
    HttpTransport,
    JobCandidate,
    SourceAdapter,
    SourceConfig,
    build_observation,
    robots_diagnostic,
)
from .generic import GenericCareerPageAdapter
from .structured import composite_document_hash

CDX_ENDPOINT = "https://web.archive.org/cdx/search/cdx"
ARCHIVE_ENDPOINT = "https://web.archive.org/web"
# Memento TimeMap enumerates the same captures as CDX through a different endpoint.
# It stays available during CDX outages, so it is the fallback index rather than a
# separate historical pipeline.
TIMEMAP_ENDPOINT = "https://web.archive.org/web/timemap/link"
_TIMEMAP_MEMENTO = re.compile(
    r"<(?P<url>https?://web\.archive\.org/web/(?P<timestamp>\d{14})/(?P<original>[^>]+))>"
    r"\s*;\s*rel=\"(?P<rel>[^\"]*)\"",
    re.IGNORECASE,
)


class _VisibleTextParser(HTMLParser):
    _ignored: ClassVar[set[str]] = {"script", "style", "noscript", "svg", "template"}
    _noise: ClassVar[set[str]] = {"navigation", "cookie preferences", "privacy policy", "skip to content"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.casefold() in self._ignored:
            self.depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() in self._ignored and self.depth:
            self.depth -= 1

    def handle_data(self, data: str) -> None:
        value = " ".join(data.split())
        if self.depth or len(value) < 3 or value.casefold() in self._noise:
            return
        self.parts.append(value)


def meaningful_text(html: str) -> str:
    """Remove rendering noise while retaining recruiting facts and job titles."""
    parser = _VisibleTextParser()
    parser.feed(html)
    lines: list[str] = []
    seen: set[str] = set()
    for part in parser.parts:
        normalized = re.sub(
            r"\b(?:nonce|request|build)[-_ ]?id\s*[:=]?\s*[a-f0-9-]{6,}\b",
            "",
            part,
            flags=re.IGNORECASE,
        )
        normalized = " ".join(normalized.split())
        key = normalized.casefold()
        if normalized and key not in seen:
            seen.add(key)
            lines.append(normalized)
    return "\n".join(lines)


def _bounded_int(value: object, default: int, minimum: int, maximum: int) -> int:
    try:
        parsed = int(value) if isinstance(value, (str, bytes, int, float)) else default
    except (TypeError, ValueError):
        parsed = default
    return min(maximum, max(minimum, parsed))


class WaybackAdapter(SourceAdapter):
    """Query CDX, fetch unique captures, and normalize archived job evidence."""

    name = "wayback"

    def __init__(self, generic: GenericCareerPageAdapter | None = None) -> None:
        self.generic = generic or GenericCareerPageAdapter()

    @staticmethod
    def cdx_url(target_url: str, source: SourceConfig) -> str:
        params: list[tuple[str, str]] = [
            ("url", target_url),
            ("output", "json"),
            ("fl", "timestamp,original,statuscode,digest,mimetype,redirect,length"),
            ("filter", "mimetype:text/html"),
            ("filter", "statuscode:[23].."),
        ]
        if source.options.get("include_subpaths"):
            params[0] = ("url", f"{target_url.rstrip('/')}/*")
        if source.options.get("from"):
            params.append(("from", str(source.options["from"])))
        if source.options.get("to"):
            params.append(("to", str(source.options["to"])))
        per_target_limit = _bounded_int(source.options.get("max_captures"), 80, 1, 500)
        params.append(("limit", str(per_target_limit)))
        return f"{CDX_ENDPOINT}?{urlencode(params)}"

    @staticmethod
    def timemap_url(target_url: str) -> str:
        return f"{TIMEMAP_ENDPOINT}/{target_url}"

    @staticmethod
    def _parse_timemap(body: bytes) -> tuple[list[dict[str, str]], int]:
        """Parse Memento link-format captures into the CDX row contract.

        TimeMap carries no status code, digest, or MIME type, so those keys are
        omitted rather than guessed; the real status is taken from the snapshot
        fetch and the content hashes are computed from the retrieved body.
        """
        rows: list[dict[str, str]] = []
        invalid = 0
        for match in _TIMEMAP_MEMENTO.finditer(body.decode("utf-8", errors="replace")):
            if "memento" not in match.group("rel"):
                continue
            timestamp = match.group("timestamp")
            original = match.group("original").strip()
            try:
                datetime.strptime(timestamp, "%Y%m%d%H%M%S").replace(tzinfo=UTC)
            except ValueError:
                invalid += 1
                continue
            if not original:
                invalid += 1
                continue
            rows.append({"timestamp": timestamp, "original": original})
        return rows, invalid

    @staticmethod
    def _sample_range(rows: list[dict[str, str]], source: SourceConfig, limit: int) -> list[dict[str, str]]:
        """Apply the configured year window, then spread the capture budget evenly.

        CDX applies `from`/`to`/`limit` server-side and returns the earliest matches.
        TimeMap returns every capture, so taking the first N would fetch one dense
        period and leave later years unobserved. Even spacing keeps consecutive
        captures close enough across the whole window for absence/presence
        boundaries to remain defensible.
        """
        start = source.options.get("from")
        end = source.options.get("to")
        selected = [
            row
            for row in rows
            if (not start or int(row["timestamp"][:4]) >= int(start))
            and (not end or int(row["timestamp"][:4]) <= int(end))
        ]
        if len(selected) <= limit:
            return selected
        step = len(selected) / limit
        return [selected[int(index * step)] for index in range(limit)]

    @staticmethod
    def archive_url(timestamp: str, original_url: str) -> str:
        return f"{ARCHIVE_ENDPOINT}/{timestamp}id_/{original_url}"

    def collect(
        self,
        source: SourceConfig,
        transport: HttpTransport,
        *,
        observed_at: datetime,
        previous_document_hash: str | None = None,
    ) -> AdapterResult:
        configured_targets = source.options.get("target_urls")
        targets = [str(source.url)]
        if isinstance(configured_targets, list):
            targets = [str(item) for item in configured_targets if isinstance(item, str)][:20] or targets

        cdx_documents: list[bytes] = []
        rows: list[dict[str, str]] = []
        diagnostics: list[CollectionDiagnostic] = []
        failed_targets = 0
        per_target_limit = _bounded_int(source.options.get("max_captures"), 80, 1, 500)
        for target in targets:
            try:
                document = transport.get(self.cdx_url(target, source), accept="application/json")
                cdx_documents.append(document.body)
                parsed_rows, invalid_rows = self._parse_cdx(document.body)
                rows.extend(parsed_rows)
                if invalid_rows:
                    diagnostics.append(
                        CollectionDiagnostic(
                            "invalid_cdx_rows_skipped",
                            f"Skipped {invalid_rows} malformed archive index rows.",
                            "warning",
                            document.url,
                            {"skipped": invalid_rows},
                        )
                    )
            except Exception as cdx_error:  # noqa: BLE001 - enumeration falls back per target
                if isinstance(cdx_error, RobotsDisallowedError):
                    diagnostics.append(robots_diagnostic(cdx_error))
                try:
                    document = transport.get(self.timemap_url(target), accept="application/link-format")
                    cdx_documents.append(document.body)
                    parsed_rows, invalid_rows = self._parse_timemap(document.body)
                    sampled = self._sample_range(parsed_rows, source, per_target_limit)
                    rows.extend(sampled)
                    diagnostics.append(
                        CollectionDiagnostic(
                            "archive_index_fallback_timemap",
                            "CDX enumeration failed; captures were enumerated through the "
                            "Memento TimeMap endpoint instead.",
                            "warning",
                            target,
                            {
                                "cdx_error_type": type(cdx_error).__name__,
                                "captures_listed": len(parsed_rows),
                                "captures_sampled": len(sampled),
                                "invalid_rows": invalid_rows,
                            },
                        )
                    )
                except Exception as exc:  # noqa: BLE001 - target failures are isolated
                    failed_targets += 1
                    if isinstance(exc, RobotsDisallowedError):
                        diagnostics.append(robots_diagnostic(exc))
                    diagnostics.append(
                        CollectionDiagnostic(
                            "cdx_target_collection_failed",
                            "An archive index target could not be collected or parsed.",
                            "error",
                            target,
                            {
                                "error_type": type(exc).__name__,
                                "cdx_error_type": type(cdx_error).__name__,
                            },
                        )
                    )

        total_limit = _bounded_int(source.options.get("max_total_captures"), 200, 1, 1_000)
        deduplicated_rows = self._deduplicate(rows)
        unique_rows = deduplicated_rows[:total_limit]
        if len(deduplicated_rows) > total_limit:
            diagnostics.append(
                CollectionDiagnostic(
                    "archive_capture_limit_reached",
                    f"Limited archive enrichment to {total_limit} captures.",
                    details={"available": len(deduplicated_rows), "limit": total_limit},
                )
            )
        captures: list[ArchiveCapture] = []
        observations: list[JobObservation] = []
        snapshot_documents: list[bytes] = []
        last_meaningful_by_url: dict[str, str] = {}
        inference_decisions: list[PageInferenceDecision] = []
        unavailable_snapshots = 0

        for row in unique_rows:
            timestamp = row["timestamp"]
            original = row["original"]
            captured_at = datetime.strptime(timestamp, "%Y%m%d%H%M%S").replace(tzinfo=UTC)
            status = int(row.get("statuscode") or 200)
            archive_url = self.archive_url(timestamp, original)
            redirect = row.get("redirect") or None
            if 300 <= status < 400:
                capture = self._capture(
                    source,
                    original=original,
                    archive_url=archive_url,
                    captured_at=captured_at,
                    status=status,
                    digest=row.get("digest"),
                    redirect=redirect,
                    content_hash=None,
                    meaningful_hash=None,
                    change_kind="redirect",
                    completeness=0.25,
                    is_partial=True,
                    titles=[],
                    excerpt=f"Archived redirect from {original} to {redirect or 'an unavailable target'}",
                )
                captures.append(capture)
                observations.append(self._page_observation(source, capture, observed_at))
                continue

            try:
                snapshot = transport.get(archive_url, accept="text/html,application/xhtml+xml")
            except (OSError, ValueError, KeyError) as exc:
                unavailable_snapshots += 1
                # A snapshot robots.txt refused is still a missing capture: the pass cannot prove absence, so it stays
                # partial whatever the reason, and the reason is recorded.
                diagnostics.append(
                    robots_diagnostic(exc)
                    if isinstance(exc, RobotsDisallowedError)
                    else CollectionDiagnostic(
                        "archive_snapshot_unavailable",
                        "The archive index listed a snapshot that could not be retrieved.",
                        "error",
                        archive_url,
                    )
                )
                capture = self._capture(
                    source,
                    original=original,
                    archive_url=archive_url,
                    captured_at=captured_at,
                    status=status,
                    digest=row.get("digest"),
                    redirect=redirect,
                    content_hash=None,
                    meaningful_hash=None,
                    change_kind="unavailable",
                    completeness=0.1,
                    is_partial=True,
                    titles=[],
                    excerpt=(
                        "CDX lists this capture, but archived content was unavailable during collection."
                    ),
                )
                captures.append(capture)
                observations.append(self._page_observation(source, capture, observed_at))
                continue
            snapshot_documents.append(snapshot.body)
            # TimeMap rows carry no status code, so the retrieved snapshot supplies it
            # rather than the assumed default.
            if not row.get("statuscode"):
                status = snapshot.status if 200 <= snapshot.status < 400 else status
            visible = meaningful_text(snapshot.text)
            semantic_hash = sha256(visible.casefold().encode()).hexdigest()
            previous_hash = last_meaningful_by_url.get(original)
            change_kind = (
                "first_observed"
                if previous_hash is None
                else "unchanged"
                if previous_hash == semantic_hash
                else "meaningful_change"
            )
            last_meaningful_by_url[original] = semantic_hash
            is_partial = "</html>" not in snapshot.text.casefold() or len(visible) < 40
            completeness = 0.55 if is_partial else 0.9

            # Rebase relative archived links against their original URL, not web.archive.org.
            original_document = snapshot.__class__(
                url=original,
                status=snapshot.status,
                content_type=snapshot.content_type,
                body=snapshot.body,
            )
            deterministic_source = source.model_copy(
                update={"options": {**source.options, "allow_browser": False, "allow_llm": False}}
            )
            candidates, _, _, decision = self.generic.extract_document(
                original_document, deterministic_source
            )
            inference_decisions.append(decision)
            capture = self._capture(
                source,
                original=original,
                archive_url=archive_url,
                captured_at=captured_at,
                status=status,
                digest=row.get("digest"),
                redirect=redirect,
                content_hash=snapshot.content_hash,
                meaningful_hash=semantic_hash,
                change_kind=change_kind,
                completeness=completeness,
                is_partial=is_partial,
                titles=[candidate.raw_title for candidate in candidates],
                excerpt=visible[:65_536] or f"Archived HTML capture of {original}",
            )
            captures.append(capture)
            observations.append(self._page_observation(source, capture, observed_at))
            for candidate in candidates:
                stable_job = candidate.external_job_id or candidate.source_url
                archived_candidate = JobCandidate(
                    source_url=candidate.source_url,
                    apply_url=candidate.apply_url,
                    raw_title=candidate.raw_title,
                    company=candidate.company,
                    location=candidate.location,
                    employment_type=candidate.employment_type,
                    published_at=candidate.published_at,
                    external_job_id=f"wayback:{timestamp}:{stable_job}",
                    evidence_excerpt=candidate.evidence_excerpt or visible[:2_000],
                    reliability={
                        **candidate.reliability,
                        "archive_semantics": "content_existed_by_capture_time",
                        "capture_completeness": completeness,
                        "archive_change_kind": change_kind,
                    },
                    archive_capture_at=captured_at,
                    archive_url=archive_url,
                    archive_original_url=original,
                    archive_digest=row.get("digest"),
                )
                observations.append(
                    build_observation(
                        source,
                        archived_candidate,
                        observed_at=observed_at,
                        extraction_route="archive",
                    )
                )

        documents = [*cdx_documents, *snapshot_documents]
        document_hash = composite_document_hash(documents)
        complete = failed_targets == 0 and unavailable_snapshots == 0 and bool(cdx_documents)
        unchanged = previous_document_hash == document_hash and complete
        return AdapterResult(
            observations=[] if unchanged else observations,
            document_hash=document_hash,
            extraction_route="archive",
            byte_count=sum(map(len, documents)),
            unchanged=unchanged,
            archive_captures=[] if unchanged else captures,
            inference_decisions=[] if unchanged else inference_decisions,
            complete=complete,
            diagnostics=diagnostics,
        )

    @staticmethod
    def _parse_cdx(body: bytes) -> tuple[list[dict[str, str]], int]:
        payload = json.loads(body)
        if not isinstance(payload, list) or not payload:
            if payload == []:
                return [], 0
            raise ValueError("unexpected_cdx_shape")
        header = payload[0]
        if not isinstance(header, list):
            raise TypeError("unexpected_cdx_header")
        rows: list[dict[str, str]] = []
        invalid_rows = 0
        for values in payload[1:]:
            if not isinstance(values, list):
                invalid_rows += 1
                continue
            row = {str(key): str(value) for key, value in zip(header, values, strict=False)}
            try:
                datetime.strptime(row.get("timestamp", ""), "%Y%m%d%H%M%S").replace(tzinfo=UTC)
                int(row.get("statuscode") or 200)
            except (TypeError, ValueError):
                invalid_rows += 1
                continue
            if not row.get("original"):
                invalid_rows += 1
                continue
            rows.append(row)
        return rows, invalid_rows

    @staticmethod
    def _deduplicate(rows: list[dict[str, str]]) -> list[dict[str, str]]:
        seen_capture: set[tuple[str, str]] = set()
        unique: list[dict[str, str]] = []
        for row in sorted(rows, key=lambda item: (item["timestamp"], item["original"])):
            capture_key = (row["timestamp"], row["original"])
            if capture_key in seen_capture:
                continue
            seen_capture.add(capture_key)
            unique.append(row)
        return unique

    @staticmethod
    def _capture(
        source: SourceConfig,
        *,
        original: str,
        archive_url: str,
        captured_at: datetime,
        status: int,
        digest: str | None,
        redirect: str | None,
        content_hash: str | None,
        meaningful_hash: str | None,
        change_kind: str,
        completeness: float,
        is_partial: bool,
        titles: list[str],
        excerpt: str,
    ) -> ArchiveCapture:
        capture_key = f"{source.id}|{captured_at.isoformat()}|{original}|{digest or status}"
        capture_id = uuid5(NAMESPACE_URL, capture_key)
        return ArchiveCapture.model_validate(
            {
                "id": capture_id,
                "observation_id": uuid5(capture_id, "page-observation"),
                "source_id": source.id,
                "original_url": HttpUrl(original),
                "archive_url": HttpUrl(archive_url),
                "captured_at": captured_at,
                "status_code": status,
                "redirect_url": HttpUrl(redirect)
                if redirect and redirect.startswith(("http://", "https://"))
                else None,
                "archive_digest": digest or None,
                "content_hash": content_hash,
                "meaningful_hash": meaningful_hash,
                "change_kind": change_kind,
                "completeness": completeness,
                "is_partial": is_partial,
                "detected_titles": titles,
                "evidence_excerpt": excerpt[:65_536],
            }
        )

    @staticmethod
    def _page_observation(
        source: SourceConfig,
        capture: ArchiveCapture,
        observed_at: datetime,
    ) -> JobObservation:
        candidate = JobCandidate(
            source_url=str(capture.original_url),
            apply_url=str(capture.original_url),
            raw_title=f"Archived recruiting page: {capture.original_url.host or 'unknown host'}",
            company=source.company,
            external_job_id=f"wayback-page:{capture.captured_at:%Y%m%d%H%M%S}:{capture.original_url}",
            evidence_excerpt=capture.evidence_excerpt,
            reliability={
                "archive_semantics": "content_existed_by_capture_time",
                "capture_completeness": capture.completeness,
                "archive_change_kind": capture.change_kind,
                "page_level_evidence": True,
            },
            archive_capture_at=capture.captured_at,
            archive_url=str(capture.archive_url),
            archive_original_url=str(capture.original_url),
            archive_digest=capture.archive_digest,
            observation_id=capture.observation_id,
        )
        return build_observation(source, candidate, observed_at=observed_at, extraction_route="archive")
