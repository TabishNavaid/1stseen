"""Narrow Supabase persistence adapter for evidence and audit records."""

from __future__ import annotations

import json
import re
from collections import defaultdict
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from functools import partial
from hashlib import sha256
from typing import TYPE_CHECKING, Any, cast
from uuid import UUID

from postgrest.exceptions import APIError
from postgrest.types import CountMethod, ReturnMethod
from pydantic import HttpUrl
from supabase import Client, create_client

from .adapters.base import SourceConfig
from .backtesting import (
    BacktestEvent,
    BacktestRole,
    BacktestRun,
    BacktestSignal,
    collapse_event_cycles,
    compatible_prior_role,
)
from .config import Settings, get_settings
from .cycles import derive_cycle_key
from .discovery import CompanyDiscoveryResult, DiscoveredSource, DiscoveryEvidence
from .forecast_currency import forecast_is_current, parse_timestamp
from .forecasting import (
    Forecast,
    ForecastContribution,
    HierarchicalCircularForecastModel,
    HistoricalOpening,
    SeasonalityPrior,
    Signal,
)
from .history import RecurringRoleIdentity
from .inference import PageInferenceDecision
from .models import ArchiveCapture, AtsCategories, HistoricalOpeningEvent, JobObservation
from .providers import ModelAttempt
from .role_resolution import (
    CanonicalRoleIdentity,
    RoleFeatures,
    RoleResolution,
    identifying_title_tokens,
    normalize_company,
    normalize_title,
)
from .scope import RoleScopeClassification, RoleScopeInput, ScopeEvidence, StoredRoleScope, TitleEvidence
from .scope_review import (
    POSTING_LIMIT,
    Posting,
    ScopeDecision,
    ScopeReviewError,
    ScopeReviewItem,
    StoredScopeReview,
)
from .signals import ForecastChange, RecruitingSignal, SignalSourceState, StoredForecastVersion
from .takedown import HOLD_ACTIONS, CollectionHeldError, TakedownAction

if TYPE_CHECKING:
    import httpx

    from .enrichment_session import CompanyEnrichmentSession

HISTORICAL_ATTRIBUTION_VERSION = "archive-attribution-v1"
ENRICHMENT_FINGERPRINT_PIPELINE = "enrichment_fingerprints"


_PAGE_SIZE = 1000
# A paged read that reaches this many rows stops with an error rather than returning a partial result. The largest
# relation on the corpus holds about 19,000 rows; this is a ceiling against a runaway loop, not a working limit.
_MAX_PAGED_ROWS = 2_000_000
# PostgREST puts filters in the query string, so a long id list becomes a URL the
# server rejects with 414. Keep each IN() filter well inside that limit.
_FILTER_CHUNK = 100
# The unique key of each relation read through `_rows_in`, which fetch_all_rows pages over.
_UNIQUE_KEY: dict[str, str | tuple[str, ...]] = {
    "forecast_evidence": "id",
    "forecasts": "id",
    "historical_opening_events": "id",
    "signals": "id",
    "raw_job_observations": "id",
    "observation_role_matches": ("observation_id", "canonical_role_id"),
    "role_scope_reviews": "id",
}


#: Roles, historical opening events, and signals: the full temporal evidence set.
BacktestDataset = tuple[list["BacktestRole"], list["BacktestEvent"], list["BacktestSignal"]]


@dataclass
class ForecastEvidence:
    """Everything in the temporal evidence set but its signals, with each loaded observation's availability time."""

    roles: list[BacktestRole]
    events: list[BacktestEvent]
    observed_at: dict[str, datetime]
    active_role_ids: set[str]

_FOLLOW_COLUMNS = "user_id,target_type,company_id,canonical_role_id,role_family,track"
_ROLE_FOLLOW_COLUMNS = "id,company_id,role_family,track,scope_status,active"


def _follow_covers_role(follow: dict[str, Any], role: dict[str, Any]) -> bool:
    """Whether one explicit follow covers one canonical role.

    A role enters a watchlist only through an explicit company, canonical-role,
    role-family, or track follow, exactly as `personalization.py` defines it.
    Nothing is inferred, so an unknown target type covers nothing.
    """
    target = str(follow["target_type"])
    if target == "canonical_role":
        return str(follow.get("canonical_role_id")) == str(role["id"])
    if target == "company":
        return str(follow.get("company_id")) == str(role["company_id"])
    if target == "role_family":
        return str(follow.get("role_family")) == str(role["role_family"])
    if target == "track":
        return str(follow.get("track")) == str(role["track"])
    return False


def _stored_scope(row: dict[str, Any]) -> RoleScopeClassification | None:
    """The stored classification, or None when unclassified or written in a vocabulary since retired."""
    if not row.get("scope_status"):
        return None
    try:
        return RoleScopeClassification(
            status=row["scope_status"],
            reason=row["scope_reason"],
            discipline=row.get("discipline"),
            early_career_type=row.get("early_career_type"),
            evidence=[ScopeEvidence.model_validate(item) for item in row.get("scope_evidence") or []],
            method=row["scope_method"],
            classifier_version=row["scope_classifier_version"],
        )
    except (KeyError, ValueError):
        return None


def fetch_all_rows(
    build: Callable[[], Any], *, key: str | tuple[str, ...], page_size: int = _PAGE_SIZE
) -> list[dict[str, Any]]:
    """Page through a PostgREST query instead of accepting its row cap.

    PostgREST returns at most `db.max_rows` (1000 by default) per request and reports no error when it truncates.
    Evidence loading must never silently drop observations, matches, or events, so every read that is not bounded by
    construction pages to exhaustion here, and `worker/tests/test_read_bounds.py` fails on any read that does neither.

    `key` is the relation's unique key (a column, or the columns of a composite key). It is appended to whatever
    order the query already has, because offset paging over an unordered or non-unique order can return one row
    twice and skip another between pages. The loop stops only on an empty page, so a server whose max_rows is below
    `page_size` is paged correctly rather than cut off at its first short page. `build` returns a fresh query
    because applying an order or a range mutates the builder.
    """
    keys = (key,) if isinstance(key, str) else key
    if not keys:
        raise ValueError("fetch_all_rows needs the relation's unique key to page stably")
    rows: list[dict[str, Any]] = []
    offset = 0
    while True:
        query = build()
        for column in keys:
            query = query.order(column)
        page = cast(list[dict[str, Any]], query.range(offset, offset + page_size - 1).execute().data or [])
        if not page:
            return rows
        rows.extend(page)
        offset += len(page)
        if offset >= _MAX_PAGED_ROWS:
            raise RuntimeError(f"a paged read passed {_MAX_PAGED_ROWS} rows; refusing to return a partial result")


def _chunked(values: list[str], size: int) -> list[list[str]]:
    """Split an IN() filter so a long id list cannot exceed URL or row limits."""
    return [values[index : index + size] for index in range(0, len(values), size)] or [[]]


# A bulk write sends at most this many rows, and about this many bytes of JSON, in one request. A role row carries a
# description of up to 32 KB and a posting up to 128 KB of text, so the byte bound is the one that usually applies.
_WRITE_CHUNK_ROWS = 500
_WRITE_CHUNK_BYTES = 2_000_000


def write_chunks(rows: Sequence[dict[str, Any]], *, by_columns: bool = True) -> list[list[dict[str, Any]]]:
    """Split rows into requests, each holding rows with one set of columns, bounded in rows and bytes.

    PostgREST writes a bulk request's rows with the union of their columns, so a row without a column would write NULL
    where a one-row request left the column alone. Rows are therefore grouped by their columns, and keep their order
    within each group. A function that reads a missing column as "leave it" (touch_job_observations) passes
    by_columns=False and gets its rows in their order, bounded only in size.
    """
    groups: dict[frozenset[str], list[dict[str, Any]]] = {}
    for row in rows:
        groups.setdefault(frozenset(row) if by_columns else frozenset(), []).append(row)
    chunks: list[list[dict[str, Any]]] = []
    for group in groups.values():
        current: list[dict[str, Any]] = []
        size = 0
        for row in group:
            row_size = len(json.dumps(row, default=str))
            if current and (len(current) >= _WRITE_CHUNK_ROWS or size + row_size > _WRITE_CHUNK_BYTES):
                chunks.append(current)
                current, size = [], 0
            current.append(row)
            size += row_size
        if current:
            chunks.append(current)
    return chunks


_CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def bounded_utf8(value: str, max_bytes: int) -> str:
    """Trim text to a byte budget without splitting a UTF-8 character.

    Record models bound evidence by character count, but the schema bounds the
    matching columns with `octet_length`. Any non-ASCII posting near the limit is
    therefore valid in Python and rejected by Postgres, so persistence applies the
    byte bound the database actually enforces.

    Archived pages also carry binary noise. Postgres text cannot hold a NUL byte,
    so control characters are removed before bounding; they carry no evidence.
    """
    value = _CONTROL_CHARACTERS.sub("", value)
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


_LEVEL_TO_TRACK = {
    "internship": "internship",
    "new_grad": "new_grad",
    "apprenticeship": "apprenticeship",
    "full_time": "other",
    "unknown": "other",
}


class IntelligenceRepository:
    # Every request this repository's client sends to PostgREST, and the bytes its responses carried on the wire,
    # counted so a run can report its round trips and what it cost of the project's egress.
    database_requests: int = 0
    database_bytes: int = 0

    def __init__(self, client: Client) -> None:
        self.client = client
        self._count_requests()

    def _count_requests(self) -> None:
        """Count each HTTP request the PostgREST client sends and the bytes each response carried on the wire
        (compressed, as egress is billed). Test doubles without an HTTP session count nothing."""
        session = getattr(getattr(self.client, "postgrest", None), "session", None)
        hooks = getattr(session, "event_hooks", None)
        if isinstance(hooks, dict):
            hooks.setdefault("request", []).append(self._record_request)
            hooks.setdefault("response", []).append(self._record_response)

    def _record_request(self, request: object) -> None:
        del request
        self.database_requests += 1

    def _record_response(self, response: httpx.Response) -> None:
        # The body is read here rather than when the caller reads it, so its size is known; httpx reads it once.
        response.read()
        self.database_bytes += response.num_bytes_downloaded

    def insert_rows(self, table: str, rows: Sequence[dict[str, Any]]) -> None:
        """Insert rows in as few requests as write_chunks allows."""
        for chunk in write_chunks(rows):
            self.client.table(table).insert(chunk, returning=ReturnMethod.minimal).execute()

    def upsert_rows(self, table: str, rows: Sequence[dict[str, Any]], *, on_conflict: str) -> None:
        """Upsert rows on a unique key in as few requests as write_chunks allows. Each key must appear once."""
        for chunk in write_chunks(rows):
            self.client.table(table).upsert(
                chunk, on_conflict=on_conflict, returning=ReturnMethod.minimal
            ).execute()

    @classmethod
    def from_settings(cls, settings: Settings | None = None) -> IntelligenceRepository:
        url, key = (settings or get_settings()).require_supabase()
        return cls(create_client(url, key))

    def list_source_configs(self, company: str | None = None) -> list[SourceConfig]:
        rows = fetch_all_rows(
            lambda: self.client.table("sources")
            .select("id,company_id,url,adapter,trust_score,metadata,companies!inner(name,domain)")
            .eq("enabled", True),
            key="id",
        )
        configs: list[SourceConfig] = []
        for row in rows:
            company_row = cast(dict[str, Any], row.get("companies") or {})
            if company and company.casefold() not in {
                str(company_row.get("name", "")).casefold(),
                str(company_row.get("domain", "")).casefold(),
                str(row["company_id"]).casefold(),
            }:
                continue
            metadata = cast(dict[str, Any], row.get("metadata") or {})
            configs.append(
                SourceConfig(
                    id=row["id"],
                    company_id=row["company_id"],
                    company=str(company_row.get("name") or "Unknown company"),
                    adapter=row["adapter"],
                    url=row["url"],
                    external_key=metadata.get("external_key"),
                    trust_score=row["trust_score"],
                    options=cast(dict[str, Any], metadata.get("options") or {}),
                )
            )
        return configs

    def source_fetch_times(self) -> dict[UUID, datetime | None]:
        """Each source's last fetch, so a run with a time budget can take the least recently collected first."""
        rows = fetch_all_rows(
            lambda: self.client.table("sources").select("id,last_fetched_at").eq("enabled", True),
            key="id",
        )
        return {
            UUID(str(row["id"])): datetime.fromisoformat(str(row["last_fetched_at"])) if row.get("last_fetched_at") else None
            for row in rows
        }

    def collection_checkpoint(self, pipeline: str) -> datetime | None:
        # bounded: one row, the checkpoint keyed by its primary key (pipeline).
        response = (
            self.client.table("collection_checkpoints")
            .select("cursor_at")
            .eq("pipeline", pipeline)
            .limit(1)
            .execute()
        )
        rows = cast(list[dict[str, Any]], response.data or [])
        return datetime.fromisoformat(str(rows[0]["cursor_at"])) if rows else None

    def save_collection_checkpoint(
        self,
        pipeline: str,
        *,
        cursor_at: datetime,
        run_id: UUID,
        status: str,
        metadata: dict[str, Any],
    ) -> None:
        self.client.table("collection_checkpoints").upsert(
            {
                "pipeline": pipeline,
                "cursor_at": cursor_at.isoformat(),
                "last_run_id": str(run_id),
                "last_status": status,
                "metadata": metadata,
                "updated_at": datetime.now(UTC).isoformat(),
            },
            on_conflict="pipeline",
        ).execute()

    def company_enrichment_fingerprints(self, company_ids: Sequence[UUID]) -> dict[UUID, str]:
        """Each company's enrichment-input fingerprint, computed in the database (migration 202608140046)."""
        fingerprints: dict[UUID, str] = {}
        ids = [str(item) for item in company_ids]
        # Ten companies a call: the function hashes every row a company's enrichment reads, about 150 ms of database
        # time per company, so a call stays far inside any statement timeout.
        for chunk in (ids[index : index + 10] for index in range(0, len(ids), 10)):
            # bounded: one row per company in the chunk, at most ten.
            response = self.client.rpc("company_enrichment_fingerprints", {"p_company_ids": chunk}).execute()
            for row in cast(list[dict[str, Any]], response.data or []):
                fingerprints[UUID(str(row["company_id"]))] = str(row["fingerprint"])
        return fingerprints

    def enrichment_noop_keys(self) -> dict[str, str]:
        """Per company, the key of its last enrichment pass that changed nothing (enrichment_fingerprints.py)."""
        # bounded: one row, the checkpoint keyed by its primary key (pipeline).
        response = (
            self.client.table("collection_checkpoints")
            .select("metadata")
            .eq("pipeline", ENRICHMENT_FINGERPRINT_PIPELINE)
            .limit(1)
            .execute()
        )
        rows = cast(list[dict[str, Any]], response.data or [])
        companies = cast(dict[str, Any], rows[0].get("metadata") or {}).get("companies") if rows else None
        return {str(key): str(value) for key, value in (companies or {}).items()}

    def save_enrichment_noop_keys(self, keys: dict[str, str], *, run_id: UUID) -> None:
        self.save_collection_checkpoint(
            ENRICHMENT_FINGERPRINT_PIPELINE,
            cursor_at=datetime.now(UTC),
            run_id=run_id,
            status="succeeded",
            metadata={"companies": dict(sorted(keys.items()))},
        )

    def changed_role_ids_since(self, since: datetime | None) -> list[UUID]:
        boundary = since.isoformat() if since is not None else None

        def fetches() -> Any:
            query = self.client.table("source_fetches").select("source_id").eq("unchanged", False)
            return query.gt("fetched_at", boundary) if boundary else query

        def histories() -> Any:
            query = self.client.table("historical_opening_events").select("canonical_role_id")
            return query.gt("created_at", boundary) if boundary else query

        def signals() -> Any:
            query = self.client.table("signals").select("canonical_role_id")
            return query.gt("created_at", boundary) if boundary else query

        def reclassified() -> Any:
            # A role that enters product scope may have no new evidence at all, and it still needs a forecast.
            query = self.client.table("canonical_roles").select("id")
            return query.gt("scope_classified_at", boundary) if boundary else query

        def evidence_changes() -> Any:
            # Evidence that was updated, moved to another role, or deleted creates no new row, so it is recorded by a
            # trigger instead (migration 202608140042): both roles of a moved opening, and the role that lost one.
            query = self.client.table("role_evidence_changes").select("id,canonical_role_id")
            return query.gt("changed_at", boundary) if boundary else query

        source_ids = sorted({str(row["source_id"]) for row in fetch_all_rows(fetches, key="id")})
        role_ids: set[UUID] = {
            UUID(str(row["canonical_role_id"]))
            for row in fetch_all_rows(histories, key="id")
            if row.get("canonical_role_id")
        }
        role_ids.update(
            UUID(str(row["canonical_role_id"]))
            for row in fetch_all_rows(signals, key="id")
            if row.get("canonical_role_id")
        )
        role_ids.update(UUID(str(row["id"])) for row in fetch_all_rows(reclassified, key="id"))
        role_ids.update(UUID(str(row["canonical_role_id"])) for row in fetch_all_rows(evidence_changes, key="id"))
        if source_ids:
            observation_ids = [
                str(row["id"])
                for row in self._rows_in("raw_job_observations", "id", "source_id", source_ids)
            ]
            matches = self._rows_in(
                "observation_role_matches", "canonical_role_id", "observation_id", observation_ids
            )
            role_ids.update(
                UUID(str(row["canonical_role_id"])) for row in matches if row.get("canonical_role_id")
            )
        return sorted(role_ids, key=str)

    def save_company_discovery(self, discovery: CompanyDiscoveryResult) -> list[SourceConfig]:
        """Persist discovered identity, sources, and evidence; return runnable configs."""
        identity = discovery.identity
        # bounded: an existence check on the unique company domain, one row at most.
        company_query = (
            self.client.table("companies").select("id,name").eq("domain", identity.domain).limit(1).execute()
        )
        company_rows = cast(list[dict[str, Any]], company_query.data or [])
        if company_rows:
            # A company that asked to be left alone is not re-identified or re-sourced (docs/takedown.md).
            self._refuse_if_held(UUID(str(company_rows[0]["id"])), identity.domain)
        company_payload: dict[str, Any] = {
            # A company keeps the name it is already stored under. A page's name for itself is a starting point, not a
            # correction: ten of the 80 stored names read as page titles on 2026-09-20 ("Reddit Inc Homepage",
            # "Snowflake AI Data Cloud") and were corrected by hand, and re-running discovery would otherwise put every
            # one of them back.
            "name": str(company_rows[0]["name"]) if company_rows and company_rows[0].get("name") else identity.name,
            "domain": identity.domain,
            "careers_url": str(identity.careers_url) if identity.careers_url else None,
            "recruiting_url": str(identity.recruiting_url) if identity.recruiting_url else None,
            "ats_provider": identity.ats_provider,
            "ats_tenant": identity.ats_tenant,
            "metadata": {
                "official_url": str(identity.official_url),
                "identity_evidence": [item.model_dump(mode="json") for item in identity.evidence],
            },
        }
        if company_rows:
            company_id = UUID(str(company_rows[0]["id"]))
            self.client.table("companies").update(company_payload).eq("id", str(company_id)).execute()
        else:
            company_id = identity.id
            self.client.table("companies").insert({"id": str(company_id), **company_payload}).execute()

        return self.save_discovered_sources(company_id, identity.name, discovery.sources)

    def company_by_domain(self, domain: str) -> dict[str, Any] | None:
        """The persisted company row for an exact domain, or None."""
        # bounded: one row, the company with this unique domain.
        response = (
            self.client.table("companies")
            .select("id,name,domain")
            .eq("domain", domain.strip().casefold())
            .limit(1)
            .execute()
        )
        rows = cast(list[dict[str, Any]], response.data or [])
        return rows[0] if rows else None

    def save_discovered_sources(
        self, company_id: UUID, company_name: str, sources: Sequence[DiscoveredSource]
    ) -> list[SourceConfig]:
        """Upsert sources and their provenance. Stable ids make repeated saves idempotent.

        Saving never turns a source on again: an existing source keeps its `enabled` flag, whoever turned it off and
        why, and only enabled sources are returned to run. A company whose collection is held or withdrawn is refused
        outright (`CollectionHeldError`), so discovery and board registration cannot re-create what a takedown stopped.
        """
        self._refuse_if_held(company_id, company_name)
        configs: list[SourceConfig] = []
        kind_by_category = {
            "careers_page": "careers_page",
            "campus_page": "campus_page",
            "ats": "ats",
            "sitemap": "sitemap",
            "feed": "feed",
            "related_career_page": "related_career_page",
            "archive": "archive",
        }
        for source in sources:
            source_url = str(source.url)
            # bounded: an existence check on the unique (company, url, adapter) source, one row at most.
            existing_query = (
                self.client.table("sources")
                .select("id,enabled,metadata")
                .eq("company_id", str(company_id))
                .eq("url", source_url)
                .eq("adapter", source.adapter)
                .limit(1)
                .execute()
            )
            existing_rows = cast(list[dict[str, Any]], existing_query.data or [])
            source_id = UUID(str(existing_rows[0]["id"])) if existing_rows else source.id
            enabled = bool(existing_rows[0].get("enabled", True)) if existing_rows else True
            # A stored source keeps the options it was given, with anything this save names winning. Discovery
            # carries no options, so re-running it must not drop the read limit an oversized board was given: without
            # this, one `discover --force` would put Anduril's 42 MB board back over the cap and fail it every run.
            stored_options = cast(dict[str, Any], (existing_rows[0].get("metadata") or {}).get("options") or {}) if existing_rows else {}
            source_payload: dict[str, Any] = {
                "company_id": str(company_id),
                "url": source_url,
                "kind": kind_by_category[source.category],
                "adapter": source.adapter,
                "trust_score": source.trust_score,
                "metadata": {
                    "external_key": source.external_key,
                    "options": {**stored_options, **source.options},
                    "discovery_category": source.category,
                },
            }
            if existing_rows:
                self.client.table("sources").update(source_payload).eq("id", str(source_id)).execute()
            else:
                self.client.table("sources").insert({"id": str(source_id), "enabled": True, **source_payload}).execute()
            for evidence in source.evidence:
                self._save_discovery_evidence(company_id, source_id, evidence)
            if not enabled:
                continue
            configs.append(
                SourceConfig(
                    id=source_id,
                    company_id=company_id,
                    company=company_name,
                    adapter=source.adapter,
                    url=source.url,
                    external_key=source.external_key,
                    trust_score=source.trust_score,
                    options=source.options,
                )
            )
        return configs

    def _save_discovery_evidence(
        self,
        company_id: UUID,
        source_id: UUID,
        evidence: DiscoveryEvidence,
    ) -> None:
        self.client.table("source_discovery_evidence").upsert(
            {
                "company_id": str(company_id),
                "source_id": str(source_id),
                "method": evidence.method,
                "evidence_url": str(evidence.evidence_url),
                "evidence_quote": bounded_utf8(evidence.quote, 8_192),
                "metadata": evidence.metadata,
            },
            on_conflict="source_id,evidence_fingerprint",
        ).execute()

    def last_document_hash(self, source_id: UUID) -> str | None:
        # bounded: one row, the source by its primary key.
        response = (
            self.client.table("sources")
            .select("last_content_hash")
            .eq("id", str(source_id))
            .limit(1)
            .execute()
        )
        rows = cast(list[dict[str, Any]], response.data or [])
        return str(rows[0]["last_content_hash"]) if rows and rows[0].get("last_content_hash") else None

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
        fetch_payload: dict[str, Any] = {
            "source_id": str(source_id),
            "fetched_at": fetched_at.isoformat(),
            "content_hash": content_hash,
            "extraction_route": extraction_route,
            "byte_count": byte_count,
            "unchanged": unchanged,
            "jobs_detected": jobs_detected,
            "error": (
                None
                if complete and not diagnostics
                else {"status": "complete" if complete else "degraded", "diagnostics": diagnostics}
            ),
        }
        self.client.table("source_fetches").insert(fetch_payload).execute()
        source_update: dict[str, Any] = {"last_fetched_at": fetched_at.isoformat()}
        if complete:
            source_update["last_content_hash"] = content_hash
        self.client.table("sources").update(source_update).eq("id", str(source_id)).execute()

    def record_inference_decision(
        self,
        decision: PageInferenceDecision,
        *,
        decided_at: datetime,
        agent_run_id: UUID | None,
    ) -> None:
        payload = decision.model_dump(mode="json")
        payload["decided_at"] = decided_at.isoformat()
        payload["agent_run_id"] = str(agent_run_id) if agent_run_id else None
        self.client.table("inference_decisions").insert(payload).execute()

    def record_inference_decisions(
        self,
        decisions: Sequence[PageInferenceDecision],
        *,
        decided_at: datetime,
        agent_run_id: UUID | None,
    ) -> None:
        """record_inference_decision for a source's decisions, in one request."""
        payloads = []
        for decision in decisions:
            payload = decision.model_dump(mode="json")
            payload["decided_at"] = decided_at.isoformat()
            payload["agent_run_id"] = str(agent_run_id) if agent_run_id else None
            payloads.append(payload)
        self.insert_rows("inference_decisions", payloads)

    def list_inference_metrics(self, run_id: UUID | None = None) -> list[dict[str, Any]]:
        def metrics() -> Any:
            query = self.client.table("inference_run_metrics").select("*")
            return query.eq("agent_run_id", str(run_id)) if run_id else query

        # One row per agent run, and runs accumulate about a hundred a day.
        return fetch_all_rows(metrics, key="agent_run_id")

    @staticmethod
    def _job_payload(observation: JobObservation) -> dict[str, Any]:
        payload = {
            "source_id": str(observation.source_id),
            "observed_at": observation.last_seen_at.isoformat(),
            "fetched_at": observation.last_seen_at.isoformat(),
            "external_job_id": observation.external_job_id,
            "identity_key": observation.identity_key,
            "source_url": str(observation.source_url),
            "apply_url": str(observation.apply_url),
            "raw_title": observation.raw_title,
            "company_name": observation.company,
            "location": observation.location,
            "employment_type": observation.employment_type,
            "published_at": observation.published_at.isoformat() if observation.published_at else None,
            "first_seen_at": observation.first_seen_at.isoformat(),
            "last_seen_at": observation.last_seen_at.isoformat(),
            "content_hash": observation.content_hash,
            "source_type": observation.source_type,
            "source_reliability": observation.source_reliability,
            "extraction_method": observation.extraction_method,
            "evidence_excerpt": bounded_utf8(observation.evidence_excerpt, 65_536),
            # Postgres retains only bounded, normalized evidence by default, and
            # requires it to be non-empty. Adapters that expose no excerpt still
            # observed a real title, so that is retained rather than an empty row.
            "raw_text": bounded_utf8(observation.evidence_excerpt or observation.raw_title, 65_536),
            "raw_payload": {
                "external_job_id": observation.external_job_id,
                **(
                    {"ats_categories": observation.ats_categories.model_dump(exclude_none=True)}
                    if observation.ats_categories
                    else {}
                ),
            },
            "archive_capture_at": (
                observation.archive_capture_at.isoformat() if observation.archive_capture_at else None
            ),
            "archive_url": str(observation.archive_url) if observation.archive_url else None,
            "archive_original_url": (
                str(observation.archive_original_url) if observation.archive_original_url else None
            ),
            "archive_digest": observation.archive_digest,
        }
        if observation.id:
            payload["id"] = str(observation.id)
        return payload

    def upsert_job(self, observation: JobObservation) -> str:
        # bounded: an existence check on the unique (source, identity key) posting, one row at most.
        response = (
            self.client.table("raw_job_observations")
            .select("id,first_seen_at,content_hash")
            .eq("source_id", str(observation.source_id))
            .eq("identity_key", observation.identity_key)
            .limit(1)
            .execute()
        )
        rows = cast(list[dict[str, Any]], response.data or [])
        payload = self._job_payload(observation)
        if not rows:
            self.client.table("raw_job_observations").insert(payload).execute()
            return "created"
        existing = rows[0]
        # The stored row keeps its id whatever the observation recomputes, because historical events and role matches
        # reference it: moving a primary key the database still has references to is refused outright (FK 23503, which
        # is how the first weekly historical run failed on 2026-09-19).
        payload["id"] = str(existing["id"])
        if existing["content_hash"] == observation.content_hash:
            seen: dict[str, Any] = {
                "last_seen_at": observation.last_seen_at.isoformat(),
                "observed_at": observation.last_seen_at.isoformat(),
            }
            if observation.ats_categories:
                # ATS categories were first captured after most postings were stored. They sit
                # outside the content hash, so an unchanged posting still records how its board
                # files it; title, text, and dates stay as first observed.
                seen["raw_payload"] = payload["raw_payload"]
            self.client.table("raw_job_observations").update(seen).eq("id", existing["id"]).execute()
            return "unchanged"
        payload["first_seen_at"] = existing["first_seen_at"]
        self.client.table("raw_job_observations").update(payload).eq("id", existing["id"]).execute()
        return "changed"

    def upsert_jobs(self, observations: Sequence[JobObservation]) -> list[str]:
        """upsert_job for a batch of postings, in a few requests instead of two per posting.

        Each posting's existing row is found in one paged read of its source, and the outcome is upsert_job's: a new
        posting is inserted; an unchanged one records that it was seen again (and its ATS categories), through
        touch_job_observations (migration 202608140045); a changed one is rewritten in full on its existing id, keeping
        its first-seen time. A request that fails is retried one posting at a time through upsert_job, so a posting the
        database refuses fails the source exactly as it did before, after the postings ahead of it are kept.
        """
        outcomes: list[str] = []
        created: list[tuple[JobObservation, dict[str, Any]]] = []
        changed: list[tuple[JobObservation, dict[str, Any]]] = []
        touched: list[tuple[JobObservation, dict[str, Any]]] = []
        existing = self._existing_postings({str(item.source_id) for item in observations})
        for observation in observations:
            row = existing.get((str(observation.source_id), observation.identity_key))
            payload = self._job_payload(observation)
            if row is None:
                created.append((observation, payload))
                outcomes.append("created")
            elif row["content_hash"] == observation.content_hash:
                seen: dict[str, Any] = {
                    "id": row["id"],
                    "last_seen_at": observation.last_seen_at.isoformat(),
                    "observed_at": observation.last_seen_at.isoformat(),
                }
                if observation.ats_categories:
                    seen["raw_payload"] = payload["raw_payload"]
                touched.append((observation, seen))
                outcomes.append("unchanged")
            else:
                payload["first_seen_at"] = row["first_seen_at"]
                # As in upsert_job: the stored row keeps its id, so a posting whose recomputed id differs is written
                # onto the row it already has rather than moving a primary key that events and matches reference.
                payload["id"] = str(row["id"])
                changed.append((observation, payload))
                outcomes.append("changed")
        for chunk in write_chunks([payload for _, payload in created]):
            self._write_or_replay(
                created, chunk, lambda rows: self.insert_rows("raw_job_observations", rows)
            )
        for chunk in write_chunks([payload for _, payload in changed]):
            self._write_or_replay(
                changed, chunk, lambda rows: self.upsert_rows("raw_job_observations", rows, on_conflict="id")
            )
        for chunk in write_chunks([payload for _, payload in touched], by_columns=False):
            # bounded: a write; the function returns one integer, the number of rows it updated.
            self._write_or_replay(
                touched, chunk, lambda rows: self.client.rpc("touch_job_observations", {"p_rows": rows}).execute()
            )
        return outcomes

    def _write_or_replay(
        self,
        pairs: list[tuple[JobObservation, dict[str, Any]]],
        chunk: list[dict[str, Any]],
        write: Callable[[list[dict[str, Any]]], object],
    ) -> None:
        """Send one chunk; if the database refuses it, write its postings one at a time through upsert_job."""
        try:
            write(chunk)
        except APIError:
            members = {id(payload) for payload in chunk}
            for observation, payload in pairs:
                if id(payload) in members:
                    self.upsert_job(observation)

    def _existing_postings(self, source_ids: set[str]) -> dict[tuple[str, str], dict[str, Any]]:
        """Each source's stored postings by identity key: the id, first-seen time, and content hash upsert_job reads."""
        existing: dict[tuple[str, str], dict[str, Any]] = {}
        for source_id in sorted(source_ids):
            rows = fetch_all_rows(
                partial(
                    lambda source: self.client.table("raw_job_observations")
                    .select("id,identity_key,first_seen_at,content_hash")
                    .eq("source_id", source)
                    .not_.is_("identity_key", "null"),
                    source_id,
                ),
                key="id",
            )
            for row in rows:
                existing[(source_id, str(row["identity_key"]))] = row
        return existing

    def touch_source_jobs(self, source_id: UUID, *, seen_at: datetime) -> int:
        # The update reports how many rows it touched. Selecting the ids first to count them read at most 1000 rows,
        # and one Databricks board already holds 930.
        response = (
            self.client.table("raw_job_observations")
            .update(
                {
                    "last_seen_at": seen_at.isoformat(),
                    "observed_at": seen_at.isoformat(),
                },
                count=CountMethod.exact,
                returning=ReturnMethod.minimal,
            )
            .eq("source_id", str(source_id))
            .not_.is_("identity_key", "null")
            .execute()
        )
        return int(response.count or 0)

    def _stored_archive_rows(self, source_ids: set[str]) -> tuple[dict[tuple[str, str, datetime], str], dict[tuple[str, str, datetime], str]]:
        """What the database already holds for each (source, archived URL, capture time): its observation and capture.

        Wayback derives a capture's id, and the page observation's with it, from the archive digest, which archive.org
        can report differently for a capture it served before. The rows themselves are keyed by the capture instead
        (`archive_captures` is unique on source, URL, and capture time; the observation carries the same three
        columns), so a second pass finds them here rather than inventing ids the database would refuse.
        """
        if not source_ids:
            return {}, {}
        ids = sorted(source_ids)
        observations = fetch_all_rows(
            lambda: self.client.table("raw_job_observations")
            .select("id,source_id,archive_original_url,archive_capture_at")
            .in_("source_id", ids)
            .not_.is_("archive_capture_at", "null"),
            key="id",
        )
        captures = fetch_all_rows(
            lambda: self.client.table("archive_captures")
            .select("id,source_id,original_url,captured_at")
            .in_("source_id", ids),
            key="id",
        )
        def key(row: dict[str, Any], url_column: str, time_column: str) -> tuple[str, str, datetime] | None:
            url, moment = row.get(url_column), row.get(time_column)
            if not url or not moment:
                return None
            return str(row["source_id"]), str(url), datetime.fromisoformat(str(moment))

        return (
            {item: str(row["id"]) for row in observations if (item := key(row, "archive_original_url", "archive_capture_at"))},
            {item: str(row["id"]) for row in captures if (item := key(row, "original_url", "captured_at"))},
        )

    def record_archive_captures(self, captures: list[ArchiveCapture]) -> None:
        if not captures:
            return
        stored_observations, stored_captures = self._stored_archive_rows({str(capture.source_id) for capture in captures})

        def identity(capture: ArchiveCapture) -> tuple[str, str, datetime]:
            return str(capture.source_id), str(capture.original_url), capture.captured_at

        self.client.table("archive_captures").upsert(
            [
                {
                    # A capture the database already holds keeps its own id and the observation it points at: its
                    # observation_id is unique and references raw_job_observations, and that row kept the id it was
                    # first written with (upsert_job).
                    "id": stored_captures.get(identity(capture), str(capture.id)),
                    "source_id": str(capture.source_id),
                    "observation_id": stored_observations.get(identity(capture), str(capture.observation_id)),
                    "original_url": str(capture.original_url),
                    "archive_url": str(capture.archive_url),
                    "captured_at": capture.captured_at.isoformat(),
                    "status_code": capture.status_code,
                    "redirect_url": str(capture.redirect_url) if capture.redirect_url else None,
                    "archive_digest": capture.archive_digest,
                    "content_hash": capture.content_hash,
                    "meaningful_hash": capture.meaningful_hash,
                    "change_kind": capture.change_kind,
                    "completeness": capture.completeness,
                    "is_partial": capture.is_partial,
                    "detected_titles": capture.detected_titles,
                    "evidence_excerpt": bounded_utf8(capture.evidence_excerpt, 65_536),
                }
                for capture in captures
            ],
            # The schema's natural key, not the generated id: a capture re-read with a different digest recomputes a
            # different id, and inserting it beside the stored row violates unique (source_id, original_url,
            # captured_at) — which is how the first weekly historical run failed on 2026-09-19.
            on_conflict="source_id,original_url,captured_at",
        ).execute()

    def save_historical_openings(self, events: list[HistoricalOpeningEvent]) -> None:
        if not events:
            return
        # Conflict on the schema's natural key, not the generated id, so re-running
        # reconstruction updates the existing cycle instead of inserting a duplicate
        # alongside a row that was created with a different identifier.
        self.client.table("historical_opening_events").upsert(
            self.event_payloads(events, self.stored_event_quotes(events)),
            on_conflict=self.EVENT_KEY,
        ).execute()

    def stored_event_quotes(self, events: Sequence[HistoricalOpeningEvent]) -> dict[tuple[str, str, str], str]:
        """The quote each of these events is already stored with, by natural key."""
        keys = {str(event.canonical_role_id) for event in events}
        rows = self._rows_in(
            "historical_opening_events",
            "canonical_role_id,opened_on,observation_id,evidence_quote",
            "canonical_role_id",
            sorted(keys),
        )
        return {
            (str(row["canonical_role_id"]), str(row["opened_on"]), str(row["observation_id"])): str(row["evidence_quote"])
            for row in rows
            if row.get("evidence_quote")
        }

    @classmethod
    def event_payloads(
        cls,
        events: Sequence[HistoricalOpeningEvent],
        stored_quotes: dict[tuple[str, str, str], str],
    ) -> list[dict[str, Any]]:
        """Each event's row, with a stored event keeping the quote it was created with.

        An opening is dated from the evidence that was visible when it was established, and reconstruction runs again
        over the same cycle every pass. Re-deriving the quote each time rewrote an opening dated 2025 with text a
        posting carried in 2026, and made every pass read the text of every observation of every role, which was the
        largest part of what enrichment downloaded. The quote a stored event was created with is kept.
        """
        payloads = []
        for event in events:
            payload = cls.event_payload(event)
            stored = stored_quotes.get(
                (payload["canonical_role_id"], str(payload["opened_on"]), payload["observation_id"])
            )
            if stored:
                payload["evidence_quote"] = stored
            payloads.append(payload)
        return payloads

    EVENT_KEY = "canonical_role_id,opened_on,observation_id"

    @staticmethod
    def event_payload(event: HistoricalOpeningEvent) -> dict[str, Any]:
        """The historical_opening_events row reconstruction upserts on the event's natural key."""
        return {
            "canonical_role_id": str(event.canonical_role_id),
            "observation_id": str(event.observation_id),
            "opened_on": event.opened_on.isoformat(),
            "closed_on": event.closed_on.isoformat() if event.closed_on else None,
            "evidence_quote": bounded_utf8(event.evidence_quote, 8_192),
            "source_quality": event.source_quality,
            "extraction_version": event.resolution_method,
            "opening_window_start": event.opening_window_start.isoformat() if event.opening_window_start else None,
            "opening_window_end": event.opening_window_end.isoformat(),
            "date_precision": event.date_precision,
            "uncertainty_days": event.uncertainty_days,
            "uncertainty_reason": event.uncertainty_reason,
            "resolution_method": event.resolution_method,
            "provenance": event.provenance,
        }

    def role_match_exists(self, observation_id: UUID) -> bool:
        # bounded: an existence check, one row at most.
        response = (
            self.client.table("observation_role_matches")
            .select("observation_id")
            .eq("observation_id", str(observation_id))
            .limit(1)
            .execute()
        )
        return bool(response.data)

    _SCOPE_ROLE_COLUMNS = (
        "id,canonical_title,scope_status,scope_reason,discipline,early_career_type,scope_evidence,"
        "scope_method,scope_classifier_version,scope_classified_at,role_aliases(alias_title,first_seen_at,id)"
    )

    def list_role_scope_inputs(self, company_id: UUID | None = None) -> list[StoredRoleScope]:
        """Every canonical role's titles, ATS categories, and stored scope, for classification.

        Titles are the observed aliases verbatim. The canonical title is normalized (cohort words such
        as "early career" are stripped from it), so it is used only for a role with no alias.
        """

        def roles() -> Any:
            query = self.client.table("canonical_roles").select(self._SCOPE_ROLE_COLUMNS).order("id")
            return query.eq("company_id", str(company_id)) if company_id else query

        role_rows = fetch_all_rows(roles, key="id")
        inputs, _ = self._scope_inputs(role_rows)
        reviewed = self._latest_scope_reviews(
            [str(row["id"]) for row in role_rows if row.get("scope_method") == "human_review"]
        )
        stored: list[StoredRoleScope] = []
        for row in role_rows:
            role_id = str(row["id"])
            review = reviewed.get(role_id)
            stored.append(
                StoredRoleScope(
                    role_id=UUID(role_id),
                    role=inputs[role_id],
                    current=_stored_scope(row),
                    classified_at=row.get("scope_classified_at"),
                    reviewed_fingerprint=review.evidence_fingerprint if review else None,
                )
            )
        return stored

    def _scope_inputs(
        self, role_rows: list[dict[str, Any]], *, postings: bool = False
    ) -> tuple[dict[str, RoleScopeInput], dict[str, list[Posting]]]:
        """Each role's classifier input and, when asked, its most recently seen postings."""
        columns = "canonical_role_id,raw_job_observations(raw_title,employment_type,raw_payload"
        columns += ",source_url,apply_url,evidence_excerpt,last_seen_at)" if postings else ")"
        match_rows = self._rows_in(
            "observation_role_matches", columns, "canonical_role_id", [str(row["id"]) for row in role_rows]
        )
        # ATS evidence stays with the title of the posting that carried it (see TitleEvidence).
        categories: dict[tuple[str, str], list[AtsCategories]] = defaultdict(list)
        employment: dict[tuple[str, str], set[str]] = defaultdict(set)
        seen: dict[str, dict[str, tuple[str, Posting]]] = defaultdict(dict)
        for row in match_rows:
            observation = cast(dict[str, Any], row.get("raw_job_observations") or {})
            role_id = str(row["canonical_role_id"])
            key = (role_id, str(observation.get("raw_title") or ""))
            payload = cast(dict[str, Any], observation.get("raw_payload") or {})
            filed = payload.get("ats_categories")
            if isinstance(filed, dict):
                try:
                    parsed = AtsCategories.model_validate(filed)
                except ValueError:
                    parsed = None
                if parsed is not None and not parsed.is_empty and parsed not in categories[key]:
                    categories[key].append(parsed)
            if observation.get("employment_type"):
                employment[key].add(str(observation["employment_type"]))
            url = str(observation.get("apply_url") or observation.get("source_url") or "")
            if postings and url:
                last_seen = str(observation.get("last_seen_at") or "")
                if url not in seen[role_id] or seen[role_id][url][0] < last_seen:
                    seen[role_id][url] = (
                        last_seen,
                        Posting(
                            url=url,
                            title=str(observation.get("raw_title") or ""),
                            excerpt=str(observation.get("evidence_excerpt") or ""),
                        ),
                    )
        inputs: dict[str, RoleScopeInput] = {}
        recent: dict[str, list[Posting]] = {}
        for row in role_rows:
            role_id = str(row["id"])
            # Earliest-seen title first. When every title is out of scope the classifier reports the first title's
            # reason, and PostgREST embeds aliases in no particular order, so a role's stored reason flipped between
            # passes over the same evidence.
            aliases = [
                str(item.get("alias_title") or "")
                for item in sorted(
                    cast(list[dict[str, Any]], row.get("role_aliases") or []),
                    key=lambda item: (str(item.get("first_seen_at") or ""), str(item.get("id") or "")),
                )
            ]
            titles = tuple(dict.fromkeys(alias for alias in aliases if alias.strip())) or (str(row["canonical_title"]),)
            inputs[role_id] = RoleScopeInput(
                titles=titles,
                title_evidence=tuple(
                    TitleEvidence(
                        title=title,
                        categories=tuple(categories[(role_id, title)][:20]),
                        employment_types=tuple(sorted(employment[(role_id, title)])[:10]),
                    )
                    for title in titles
                ),
            )
            ranked = sorted(seen[role_id].values(), key=lambda pair: pair[0], reverse=True)
            recent[role_id] = [posting for _, posting in ranked[:POSTING_LIMIT]]
        return inputs, recent

    def _latest_scope_reviews(self, role_ids: list[str]) -> dict[str, StoredScopeReview]:
        rows = self._rows_in(
            "role_scope_reviews",
            "id,canonical_role_id,status,reason,discipline,early_career_type,basis,note,reviewer,"
            "evidence_fingerprint,decided_at",
            "canonical_role_id",
            role_ids,
        )
        latest: dict[str, StoredScopeReview] = {}
        for row in rows:
            review = StoredScopeReview.model_validate(row)
            role_id = str(row["canonical_role_id"])
            if role_id not in latest or latest[role_id].decided_at < review.decided_at:
                latest[role_id] = review
        return latest

    def list_scope_review_queue(
        self, company_ids: Sequence[UUID] | None = None, reason: str | None = None
    ) -> list[ScopeReviewItem]:
        """Active roles the scope classifier left ambiguous, with the evidence and postings a reviewer needs."""

        def roles() -> Any:
            query = (
                self.client.table("canonical_roles")
                .select(f"{self._SCOPE_ROLE_COLUMNS},companies(name)")
                .eq("scope_status", "ambiguous")
                .eq("active", True)
                .order("id")
            )
            if company_ids is not None:
                query = query.in_("company_id", [str(company_id) for company_id in company_ids])
            return query.eq("scope_reason", reason) if reason else query

        return self._scope_review_items(fetch_all_rows(roles, key="id"))

    def get_scope_review_item(self, role_id: UUID) -> ScopeReviewItem | None:
        # bounded: one row, the role by its primary key.
        rows = cast(
            list[dict[str, Any]],
            self.client.table("canonical_roles")
            .select(f"{self._SCOPE_ROLE_COLUMNS},companies(name)")
            .eq("id", str(role_id))
            .eq("active", True)
            .limit(1)
            .execute()
            .data
            or [],
        )
        items = self._scope_review_items(rows)
        return items[0] if items else None

    def _scope_review_items(self, role_rows: list[dict[str, Any]]) -> list[ScopeReviewItem]:
        inputs, postings = self._scope_inputs(role_rows, postings=True)
        reviews = self._latest_scope_reviews([str(row["id"]) for row in role_rows])
        items: list[ScopeReviewItem] = []
        for row in role_rows:
            role_id = str(row["id"])
            current = _stored_scope(row)
            if current is None or not row.get("scope_classified_at"):
                continue
            company = cast(dict[str, Any], row.get("companies") or {})
            items.append(
                ScopeReviewItem(
                    role_id=UUID(role_id),
                    company=str(company.get("name") or ""),
                    canonical_title=str(row["canonical_title"]),
                    role=inputs[role_id],
                    current=current,
                    classified_at=row["scope_classified_at"],
                    postings=postings[role_id],
                    last_review=reviews.get(role_id),
                )
            )
        return items

    def record_role_scope_review(
        self,
        *,
        review_id: UUID,
        item: ScopeReviewItem,
        decision: ScopeDecision,
        classification: RoleScopeClassification,
        fingerprint: str,
        shown: dict[str, Any],
    ) -> datetime:
        """Write the review and the role's outcome in one transaction (migration 202608140033)."""
        try:
            # bounded: a write in one transaction; the function returns a single row.
            response = self.client.rpc(
                "record_role_scope_review",
                {
                    "p_review_id": str(review_id),
                    "p_role_id": str(item.role_id),
                    "p_listed_classified_at": item.classified_at.isoformat(),
                    "p_status": classification.status,
                    "p_reason": classification.reason,
                    "p_discipline": classification.discipline,
                    "p_early_career_type": classification.early_career_type,
                    "p_basis": decision.basis,
                    "p_note": decision.note,
                    "p_reviewer": decision.reviewer,
                    "p_evidence_fingerprint": fingerprint,
                    "p_shown": shown,
                    "p_scope_evidence": [entry.model_dump() for entry in classification.evidence],
                    "p_classifier_version": classification.classifier_version,
                },
            ).execute()
        except APIError as error:
            if error.code == "P0002":
                raise ScopeReviewError(f"{error.message}. List the queue again and decide on what it shows now.") from error
            raise
        return datetime.fromisoformat(str(response.data))

    def list_role_identity_candidates(self, company_id: UUID | None) -> list[dict[str, Any]]:
        """Every active role's observations, with the title each was observed under.

        The re-resolution needs the titles themselves, not the stored level, because the stored level
        was widened by each posting's description — which is the flaw it exists to undo.
        """
        def page() -> Any:
            query = (
                self.client.table("observation_role_matches")
                .select(
                    "observation_id,canonical_role_id,"
                    "canonical_roles!inner(id,company_id,canonical_title,company_normalized,active,scope_reason,"
                    "companies!inner(name)),"
                    "raw_job_observations!inner(raw_title)"
                )
                .eq("canonical_roles.active", True)
                # Only rows that are an identity decision. A page-level archive capture is attached
                # as `archive_page_attribution` and its title is the page ("Archived recruiting page:
                # www.imc.com"), which must never resolve into a role or become an
                # alias; letting it state a type would split every role that has one.
                .eq("evidence_kind", "observation_resolution")
            )
            if company_id is not None:
                query = query.eq("canonical_roles.company_id", str(company_id))
            return query

        rows: list[dict[str, Any]] = []
        for row in fetch_all_rows(page, key=("observation_id", "canonical_role_id")):
            role = cast(dict[str, Any], row.get("canonical_roles") or {})
            observation = cast(dict[str, Any], row.get("raw_job_observations") or {})
            company = cast(dict[str, Any], role.get("companies") or {})
            rows.append(
                {
                    "role_id": str(row["canonical_role_id"]),
                    "company": str(company.get("name") or ""),
                    "company_normalized": str(role.get("company_normalized") or ""),
                    "canonical_title": str(role.get("canonical_title") or ""),
                    "scope_reason": role.get("scope_reason"),
                    "observation_id": str(row["observation_id"]),
                    "raw_title": str(observation.get("raw_title") or ""),
                }
            )
        return rows

    def split_canonical_role(
        self,
        *,
        source_role_id: UUID,
        canonical_title: str,
        normalized_title: str,
        level: str,
        recurrence_key: str,
        observation_ids: list[UUID],
        stated_types: list[str],
        reason: str,
        resolver_version_from: str,
        resolver_version_to: str,
        source_canonical_title: str | None = None,
        source_normalized_title: str | None = None,
        source_level: str | None = None,
    ) -> UUID:
        """Move one program out of a merged role, in one transaction (migration 202608140034)."""
        # bounded: a write in one transaction; the function returns the new role id.
        response = self.client.rpc(
            "split_canonical_role",
            {
                "p_source_role_id": str(source_role_id),
                "p_canonical_title": canonical_title,
                "p_normalized_title": normalized_title,
                "p_level": level,
                "p_recurrence_key": recurrence_key,
                "p_observation_ids": [str(item) for item in observation_ids],
                "p_stated_types": stated_types,
                "p_reason": reason,
                "p_resolver_version_from": resolver_version_from,
                "p_resolver_version_to": resolver_version_to,
                "p_source_canonical_title": source_canonical_title,
                "p_source_normalized_title": source_normalized_title,
                "p_source_level": source_level,
            },
        ).execute()
        return UUID(str(response.data))

    def role_description_excerpt(self, role_id: UUID) -> str:
        # bounded: one row, the newest identity match whose posting carries an excerpt, chosen in the query.
        rows = cast(
            list[dict[str, Any]],
            self.client.table("observation_role_matches")
            .select("raw_job_observations!inner(evidence_excerpt)")
            .eq("canonical_role_id", str(role_id))
            .eq("evidence_kind", "observation_resolution")
            .neq("raw_job_observations.evidence_excerpt", "")
            .order("created_at", desc=True)
            .order("observation_id")
            .limit(1)
            .execute()
            .data
            or [],
        )
        excerpts = (
            str(cast(dict[str, Any], row.get("raw_job_observations") or {}).get("evidence_excerpt") or "")
            for row in rows
        )
        return next((item for item in excerpts if item.strip()), "")[:4_000]

    def save_role_scope(self, role_id: UUID, classification: RoleScopeClassification) -> None:
        self.client.table("canonical_roles").update(
            {
                "scope_status": classification.status,
                "scope_reason": classification.reason,
                "discipline": classification.discipline,
                "early_career_type": classification.early_career_type,
                "scope_evidence": [item.model_dump() for item in classification.evidence],
                "scope_method": classification.method,
                "scope_classifier_version": classification.classifier_version,
                "scope_classified_at": datetime.now(UTC).isoformat(),
            }
        ).eq("id", str(role_id)).execute()

    def save_role_scopes(self, decisions: Sequence[tuple[UUID, RoleScopeClassification]]) -> None:
        """save_role_scope for many roles, through save_role_scopes (migration 202608140045) in a few requests."""
        rows = [
            {
                "id": str(role_id),
                "scope_status": classification.status,
                "scope_reason": classification.reason,
                "discipline": classification.discipline,
                "early_career_type": classification.early_career_type,
                "scope_evidence": [item.model_dump() for item in classification.evidence],
                "scope_method": classification.method,
                "scope_classifier_version": classification.classifier_version,
                "scope_classified_at": datetime.now(UTC).isoformat(),
            }
            for role_id, classification in decisions
        ]
        for chunk in write_chunks(rows):
            # bounded: a write; the function returns one integer, the number of roles it updated.
            self.client.rpc("save_role_scopes", {"p_rows": chunk}).execute()

    def in_scope_role_ids(self) -> set[UUID]:
        rows = fetch_all_rows(
            lambda: self.client.table("canonical_roles")
            .select("id")
            .eq("scope_status", "in_scope")
            .eq("active", True)
            .order("id"), key="id"
        )
        return {UUID(str(row["id"])) for row in rows}

    def list_canonical_roles_for_resolution(self, company_id: UUID) -> list[CanonicalRoleIdentity]:
        # A company can hold hundreds of active roles (Stripe has 521), so this pages rather than trusting one response.
        rows = fetch_all_rows(
            lambda: self.client.table("canonical_roles")
            .select(f"{self.RESOLUTION_ROLE_COLUMNS},role_aliases(alias_title)")
            .eq("company_id", str(company_id))
            .eq("active", True),
            key="id",
        )
        return [
            self.resolution_identity(
                row, [str(alias["alias_title"]) for alias in row.get("role_aliases") or [] if alias.get("alias_title")]
            )
            for row in rows
        ]

    # The canonical_roles columns a resolution candidate is built from, without its aliases.
    RESOLUTION_ROLE_COLUMNS = (
        "id,company_id,company_normalized,canonical_title,recurrence_key,normalized_title,"
        "role_family,level,recruiting_season,specialization,feature_profile,description_prototype"
    )

    @staticmethod
    def resolution_identity(row: dict[str, Any], aliases: list[str]) -> CanonicalRoleIdentity:
        """A stored canonical role as the resolver compares it: its columns, its feature profile, and its aliases."""
        profile = cast(dict[str, Any], row.get("feature_profile") or {})
        return CanonicalRoleIdentity(
            id=row["id"],
            company_id=row["company_id"],
            company_normalized=normalize_company(str(row["company_normalized"])),
            canonical_title=str(row["canonical_title"]),
            recurrence_key=str(row["recurrence_key"]),
            features=RoleFeatures(
                normalized_title=str(row["normalized_title"]),
                level=row["level"],
                role_family=str(row["role_family"]),
                specialization=row.get("specialization"),
                recruiting_season=row["recruiting_season"],
                location_scope=str(profile.get("location_scope") or "unspecified"),
                description_fingerprint=str(profile.get("description_fingerprint") or sha256(b"").hexdigest()),
            ),
            aliases=aliases,
            description_prototype=str(row.get("description_prototype") or ""),
        )

    @staticmethod
    def role_payload(resolution: RoleResolution) -> dict[str, Any]:
        """The canonical_roles row a resolution upserts."""
        role = resolution.canonical_role
        role_payload: dict[str, Any] = {
            "id": str(role.id),
            "company_id": str(role.company_id),
            "canonical_title": role.canonical_title,
            "track": _LEVEL_TO_TRACK[role.features.level],
            "location_scope": role.features.location_scope,
            "recurrence_key": role.recurrence_key,
            "company_normalized": role.company_normalized,
            "normalized_title": role.features.normalized_title,
            "role_family": role.features.role_family,
            "level": role.features.level,
            "recruiting_season": role.features.recruiting_season,
            "specialization": role.features.specialization,
            "feature_profile": role.features.model_dump(mode="json"),
            "description_prototype": bounded_utf8(role.description_prototype, 32_768),
            "resolver_version": resolution.resolver_version,
        }
        if role.description_embedding and len(role.description_embedding) == 1536:
            role_payload["description_embedding"] = role.description_embedding
        return role_payload

    @staticmethod
    def alias_insert_payload(resolution: RoleResolution, seen: dict[str, Any]) -> dict[str, Any]:
        """The role_aliases row a resolution inserts when its role has no alias of that normalized title yet.

        `seen` is the observation's stored first_seen_at and last_seen_at.
        """
        return {
            "canonical_role_id": str(resolution.canonical_role.id),
            "alias_title": resolution.observed_alias,
            "normalized_alias": normalize_title(resolution.observed_alias),
            "first_observation_id": str(resolution.observation_id),
            "last_observation_id": str(resolution.observation_id),
            "first_seen_at": seen["first_seen_at"],
            "last_seen_at": seen["last_seen_at"],
            "match_confidence": resolution.match_confidence,
            "match_evidence": [item.model_dump(mode="json") for item in resolution.evidence],
            "resolver_version": resolution.resolver_version,
        }

    @staticmethod
    def alias_update_payload(
        resolution: RoleResolution, seen: dict[str, Any], stored_confidence: object
    ) -> dict[str, Any]:
        """What a resolution changes on an alias its role already has: the latest sighting and the higher confidence."""
        return {
            "alias_title": resolution.observed_alias,
            "last_observation_id": str(resolution.observation_id),
            "last_seen_at": seen["last_seen_at"],
            "match_confidence": max(float(cast(Any, stored_confidence)), resolution.match_confidence),
            "match_evidence": [item.model_dump(mode="json") for item in resolution.evidence],
            "resolver_version": resolution.resolver_version,
        }

    @staticmethod
    def match_payload(resolution: RoleResolution) -> dict[str, Any]:
        """The observation_role_matches row a resolution upserts: the observation's primary identity."""
        return {
            "observation_id": str(resolution.observation_id),
            "canonical_role_id": str(resolution.canonical_role.id),
            "decision": resolution.decision,
            "match_confidence": resolution.match_confidence,
            "feature_scores": resolution.feature_scores,
            "reasons": resolution.reasons,
            "evidence": [item.model_dump(mode="json") for item in resolution.evidence],
            "used_embedding": resolution.used_embedding,
            "used_llm": resolution.used_llm,
            "inference_decision": resolution.inference_decision.model_dump(mode="json"),
            "resolver_version": resolution.resolver_version,
            "evidence_kind": "observation_resolution",
            "is_primary": True,
        }

    def save_role_resolution(self, resolution: RoleResolution) -> None:
        role = resolution.canonical_role
        self.client.table("canonical_roles").upsert(self.role_payload(resolution), on_conflict="id").execute()

        # bounded: one row, the observation by its primary key.
        observation = (
            self.client.table("raw_job_observations")
            .select("first_seen_at,last_seen_at")
            .eq("id", str(resolution.observation_id))
            .limit(1)
            .execute()
        )
        observation_rows = cast(list[dict[str, Any]], observation.data or [])
        if not observation_rows:
            raise RuntimeError("Cannot persist a role alias without its observation")
        seen = observation_rows[0]
        # bounded: an existence check on the unique (role, normalized alias), one row at most.
        existing_alias = (
            self.client.table("role_aliases")
            .select("id,match_confidence")
            .eq("canonical_role_id", str(role.id))
            .eq("normalized_alias", normalize_title(resolution.observed_alias))
            .limit(1)
            .execute()
        )
        alias_rows = cast(list[dict[str, Any]], existing_alias.data or [])
        if alias_rows:
            self.client.table("role_aliases").update(
                self.alias_update_payload(resolution, seen, alias_rows[0].get("match_confidence", 0))
            ).eq("id", alias_rows[0]["id"]).execute()
        else:
            self.client.table("role_aliases").insert(self.alias_insert_payload(resolution, seen)).execute()
        self.client.table("observation_role_matches").upsert(
            self.match_payload(resolution), on_conflict="observation_id,canonical_role_id"
        ).execute()

    # Everything an observation carries except its evidence excerpt, which averages 3,041 bytes on hosted and is about
    # three fifths of what enriching one company downloads. Two decisions read it: resolving an observation for the
    # first time, and quoting an opening the first time that opening is recorded. It is read for those and no others
    # (`observation_excerpts`).
    _OBSERVATION_COLUMNS_SLIM = (
        "id,source_id,external_job_id,identity_key,source_url,apply_url,raw_title,company_name,"
        "location,employment_type,published_at,first_seen_at,last_seen_at,content_hash,source_type,"
        "source_reliability,extraction_method,archive_capture_at,archive_url,"
        "archive_original_url,archive_digest"
    )
    _OBSERVATION_COLUMNS = f"{_OBSERVATION_COLUMNS_SLIM},evidence_excerpt"

    @staticmethod
    def _observation_from_row(row: dict[str, Any]) -> JobObservation | None:
        """Rebuild a validated observation; rows without a stable identity are unusable."""
        if not row.get("identity_key"):
            return None
        published = row.get("published_at")
        captured = row.get("archive_capture_at")
        return JobObservation(
            id=UUID(str(row["id"])),
            source_id=UUID(str(row["source_id"])),
            external_job_id=row.get("external_job_id"),
            identity_key=str(row["identity_key"]),
            source_url=HttpUrl(str(row["source_url"])),
            apply_url=HttpUrl(str(row["apply_url"])),
            raw_title=str(row["raw_title"]),
            company=str(row["company_name"]),
            location=row.get("location"),
            employment_type=row.get("employment_type"),
            published_at=datetime.fromisoformat(str(published)) if published else None,
            first_seen_at=datetime.fromisoformat(str(row["first_seen_at"])),
            last_seen_at=datetime.fromisoformat(str(row["last_seen_at"])),
            content_hash=str(row["content_hash"]),
            source_type=str(row["source_type"]),
            source_reliability=cast(dict[str, Any], row.get("source_reliability") or {}),
            extraction_method=cast(Any, row["extraction_method"]),
            evidence_excerpt=str(row.get("evidence_excerpt") or ""),
            archive_capture_at=datetime.fromisoformat(str(captured)) if captured else None,
            archive_url=row.get("archive_url"),
            archive_original_url=row.get("archive_original_url"),
            archive_digest=row.get("archive_digest"),
        )

    def _rows_in(
        self, table: str, columns: str, column: str, values: list[str]
    ) -> list[dict[str, Any]]:
        """Read every row matching an id list, chunking the filter and paging results."""
        if not values:
            return []
        rows: list[dict[str, Any]] = []
        for chunk in _chunked(values, _FILTER_CHUNK):
            rows.extend(
                fetch_all_rows(
                    partial(
                        lambda ids: self.client.table(table).select(columns).in_(column, ids),
                        chunk,
                    ),
                    key=_UNIQUE_KEY[table],
                )
            )
        return rows

    def enrichment_session(self, company_id: UUID) -> CompanyEnrichmentSession:
        """One company's enrichment reading its evidence once and writing its decisions in bulk (enrichment_session.py)."""
        from .enrichment_session import CompanyEnrichmentSession

        return CompanyEnrichmentSession(self, company_id)

    def company_observation_rows(self, source_ids: list[str], *, with_excerpt: bool = True) -> list[dict[str, Any]]:
        """Every stored observation of these sources, including rows without an identity key.

        Without `with_excerpt` the rows carry no `evidence_excerpt` key at all, so a reader that needs one asks for it
        (`observation_excerpts`) instead of quietly seeing an empty string where the database holds text.
        """
        if not source_ids:
            return []
        columns = self._OBSERVATION_COLUMNS if with_excerpt else self._OBSERVATION_COLUMNS_SLIM
        return fetch_all_rows(
            lambda: self.client.table("raw_job_observations").select(columns).in_("source_id", source_ids),
            key="id",
        )

    def observation_excerpts(self, observation_ids: list[str]) -> dict[str, str]:
        """The evidence excerpt of each of these observations, read in chunks."""
        rows = self._rows_in("raw_job_observations", "id,evidence_excerpt", "id", sorted(set(observation_ids)))
        return {str(row["id"]): str(row.get("evidence_excerpt") or "") for row in rows}

    def observation_matches_for_sources(self, source_ids: list[str]) -> list[dict[str, Any]]:
        """Every role match, primary or not, of an observation from these sources."""
        if not source_ids:
            return []
        return fetch_all_rows(
            lambda: self.client.table("observation_role_matches")
            .select("observation_id,canonical_role_id,is_primary,raw_job_observations!inner(source_id)")
            .in_("raw_job_observations.source_id", source_ids),
            key=("observation_id", "canonical_role_id"),
        )

    def role_matches_for_company(self, company_id: UUID) -> list[dict[str, Any]]:
        """Every observation matched to one of the company's roles, active or not."""
        return fetch_all_rows(
            lambda: self.client.table("observation_role_matches")
            .select("observation_id,canonical_role_id,canonical_roles!inner(company_id)")
            .eq("canonical_roles.company_id", str(company_id)),
            key=("observation_id", "canonical_role_id"),
        )

    def resolution_role_rows(self, company_id: UUID) -> list[dict[str, Any]]:
        """The company's roles, active or not, with the columns a resolution candidate is built from."""
        return fetch_all_rows(
            lambda: self.client.table("canonical_roles")
            .select(f"{self.RESOLUTION_ROLE_COLUMNS},active")
            .eq("company_id", str(company_id)),
            key="id",
        )

    def alias_rows_for_company(self, company_id: UUID) -> list[dict[str, Any]]:
        """Every alias of the company's roles, with the columns save_role_resolution reads and writes."""
        return fetch_all_rows(
            lambda: self.client.table("role_aliases")
            .select(
                "id,canonical_role_id,alias_title,normalized_alias,first_observation_id,last_observation_id,"
                "first_seen_at,last_seen_at,match_confidence,match_evidence,resolver_version,"
                "canonical_roles!inner(company_id)"
            )
            .eq("canonical_roles.company_id", str(company_id)),
            key="id",
        )

    _EVENT_COLUMNS = (
        "id,canonical_role_id,observation_id,opened_on,closed_on,evidence_quote,source_quality,"
        "opening_window_start,opening_window_end,date_precision,uncertainty_days,"
        "uncertainty_reason,resolution_method,provenance"
    )

    def event_rows_for_company(self, company_id: UUID) -> list[dict[str, Any]]:
        """Every opening event of the company's roles, in id order."""
        return fetch_all_rows(
            lambda: self.client.table("historical_opening_events")
            .select(f"{self._EVENT_COLUMNS},canonical_roles!inner(company_id)")
            .eq("canonical_roles.company_id", str(company_id)),
            key="id",
        )

    def observation_rows_by_id(self, observation_ids: list[str]) -> list[dict[str, Any]]:
        return self._rows_in("raw_job_observations", self._OBSERVATION_COLUMNS, "id", observation_ids)

    def company_source_ids(self, company_id: UUID) -> list[str]:
        return self._company_source_ids(company_id)

    def _company_source_ids(self, company_id: UUID) -> list[str]:
        rows = fetch_all_rows(
            lambda: self.client.table("sources").select("id").eq("company_id", str(company_id)), key="id"
        )
        return [str(row["id"]) for row in rows]

    def list_unresolved_observations(self, company_id: UUID) -> list[JobObservation]:
        """Persisted observations for a company that have no canonical-role match yet."""
        source_ids = self._company_source_ids(company_id)
        if not source_ids:
            return []
        rows = fetch_all_rows(
            lambda: self.client.table("raw_job_observations")
            .select(self._OBSERVATION_COLUMNS)
            .in_("source_id", source_ids)
            .not_.is_("identity_key", "null"), key="id"
        )
        if not rows:
            return []
        return self.unresolved_among(rows, self.observation_matches_for_sources(source_ids))

    @classmethod
    def unresolved_among(
        cls, rows: list[dict[str, Any]], matches: list[dict[str, Any]]
    ) -> list[JobObservation]:
        """The observations among `rows` that no primary match resolves, oldest first.

        Only a primary posting-level resolution counts as resolved: an archive page attribution says the role was
        visible there, not that the observation's own identity is settled. Oldest evidence comes first so the earliest
        observation of a program establishes its canonical identity and later cycles match into it.
        """
        observations = [
            observation
            for row in cls.unresolved_rows(rows, matches)
            if (observation := cls._observation_from_row(row)) is not None
        ]
        return sorted(observations, key=lambda item: (item.first_seen_at, str(item.id)))

    @classmethod
    def unresolved_rows(cls, rows: list[dict[str, Any]], matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """The rows `unresolved_among` builds from, so a caller can prepare them before it does."""
        matched = {str(item["observation_id"]) for item in matches if item.get("is_primary")}
        return [row for row in rows if row.get("identity_key") is not None and str(row["id"]) not in matched]

    def list_recurring_roles(self, company_id: UUID) -> list[RecurringRoleIdentity]:
        rows = fetch_all_rows(
            lambda: self.client.table("canonical_roles")
            .select("id,company_id,canonical_title,track,companies(name),role_aliases(alias_title)")
            .eq("company_id", str(company_id))
            .eq("active", True),
            key="id",
        )
        roles: list[RecurringRoleIdentity] = []
        for row in rows:
            company = cast(dict[str, Any], row.get("companies") or {})
            alias_rows = cast(list[dict[str, Any]], row.get("role_aliases") or [])
            if not str(row.get("canonical_title") or "").strip():
                # One unusable stored row must not abort reconstruction for the
                # whole company; it is skipped and the remaining roles proceed.
                continue
            roles.append(
                RecurringRoleIdentity(
                    id=UUID(str(row["id"])),
                    company_id=UUID(str(row["company_id"])),
                    company=str(company.get("name") or row["canonical_title"]),
                    canonical_title=str(row["canonical_title"]),
                    track=str(row["track"]),
                    # Persisted aliases carry every observed title, so reconstruction
                    # recognizes renamed programs without re-running the resolver.
                    aliases=[
                        str(alias["alias_title"]) for alias in alias_rows if alias.get("alias_title")
                    ],
                )
            )
        return roles

    def list_role_observations(self, role_id: UUID) -> list[JobObservation]:
        match_rows = fetch_all_rows(
            lambda: self.client.table("observation_role_matches")
            .select("observation_id")
            .eq("canonical_role_id", str(role_id)), key=("observation_id", "canonical_role_id")
        )
        observation_ids = [str(row["observation_id"]) for row in match_rows]
        if not observation_ids:
            return []
        rows = self._rows_in(
            "raw_job_observations", self._OBSERVATION_COLUMNS, "id", observation_ids
        )
        observations = [
            observation
            for row in rows
            if (observation := self._observation_from_row(row)) is not None
        ]
        return sorted(observations, key=lambda item: (item.first_seen_at, str(item.id)))

    def list_company_archive_captures(self, company_id: UUID) -> list[ArchiveCapture]:
        return self.archive_captures_for_sources(self._company_source_ids(company_id))

    def archive_captures_for_sources(self, source_ids: list[str]) -> list[ArchiveCapture]:
        if not source_ids:
            return []
        rows = fetch_all_rows(
            lambda: self.client.table("archive_captures").select("*").in_("source_id", source_ids), key="id"
        )
        captures = [
            ArchiveCapture(
                id=UUID(str(row["id"])),
                observation_id=UUID(str(row["observation_id"])),
                source_id=UUID(str(row["source_id"])),
                original_url=HttpUrl(str(row["original_url"])),
                archive_url=HttpUrl(str(row["archive_url"])),
                captured_at=datetime.fromisoformat(str(row["captured_at"])),
                status_code=int(row["status_code"]),
                redirect_url=row.get("redirect_url"),
                archive_digest=row.get("archive_digest"),
                content_hash=row.get("content_hash"),
                meaningful_hash=row.get("meaningful_hash"),
                change_kind=cast(Any, row["change_kind"]),
                completeness=float(row["completeness"]),
                is_partial=bool(row["is_partial"]),
                detected_titles=cast(list[str], row.get("detected_titles") or []),
                evidence_excerpt=str(row.get("evidence_excerpt") or ""),
            )
            for row in rows
        ]
        return sorted(captures, key=lambda item: (item.captured_at, str(item.id)))

    def list_historical_events(self, role_id: UUID) -> list[HistoricalOpeningEvent]:
        rows = fetch_all_rows(
            lambda: self.client.table("historical_opening_events")
            .select(self._EVENT_COLUMNS)
            .eq("canonical_role_id", str(role_id)),
            key="id",
        )
        return self.events_from_rows(rows)

    @staticmethod
    def events_from_rows(rows: list[dict[str, Any]]) -> list[HistoricalOpeningEvent]:
        """Stored opening events, in the rows' order, skipping any without the provenance reconstruction requires."""
        events: list[HistoricalOpeningEvent] = []
        for row in rows:
            window_start = row.get("opening_window_start")
            closed = row.get("closed_on")
            provenance = cast(list[dict[str, Any]], row.get("provenance") or [])
            if not provenance:
                # Provenance is mandatory; a row without it cannot re-enter reconstruction.
                continue
            events.append(
                HistoricalOpeningEvent(
                    id=UUID(str(row["id"])),
                    canonical_role_id=UUID(str(row["canonical_role_id"])),
                    observation_id=UUID(str(row["observation_id"])),
                    opened_on=date.fromisoformat(str(row["opened_on"])),
                    closed_on=date.fromisoformat(str(closed)) if closed else None,
                    evidence_quote=str(row["evidence_quote"]),
                    source_quality=float(row["source_quality"]),
                    opening_window_start=(
                        date.fromisoformat(str(window_start)) if window_start else None
                    ),
                    opening_window_end=date.fromisoformat(str(row["opening_window_end"])),
                    date_precision=cast(Any, row["date_precision"]),
                    uncertainty_days=row.get("uncertainty_days"),
                    uncertainty_reason=str(row["uncertainty_reason"]),
                    resolution_method=str(row["resolution_method"]),
                    provenance=provenance,
                )
            )
        return events

    def role_evidence_exists(self, observation_id: UUID, role_id: UUID) -> bool:
        """True when this exact observation/role evidence pair is already recorded."""
        # bounded: an existence check on the (observation, role) primary key, one row at most.
        response = (
            self.client.table("observation_role_matches")
            .select("observation_id")
            .eq("observation_id", str(observation_id))
            .eq("canonical_role_id", str(role_id))
            .limit(1)
            .execute()
        )
        return bool(response.data)

    def link_observation_to_role(
        self,
        observation_id: UUID,
        role_id: UUID,
        *,
        match_confidence: float,
        rationale: str,
    ) -> None:
        """Record an archive attribution without mutating role identity or aliases.

        Reconstruction attributes an archived page capture to a role it already
        matched. Writing an alias here would feed the page title back into future
        title matching, so only the observation match row is persisted.
        """
        self.client.table("observation_role_matches").upsert(
            self.link_payload(observation_id, role_id, match_confidence=match_confidence, rationale=rationale),
            on_conflict="observation_id,canonical_role_id",
        ).execute()

    @staticmethod
    def link_payload(
        observation_id: UUID, role_id: UUID, *, match_confidence: float, rationale: str
    ) -> dict[str, Any]:
        """The observation_role_matches row an archive attribution upserts; never the observation's primary identity."""
        return {
            "observation_id": str(observation_id),
            "canonical_role_id": str(role_id),
            "decision": "matched",
            "match_confidence": match_confidence,
            "feature_scores": {"archive_title_attribution": match_confidence},
            "reasons": [rationale],
            "evidence": [
                {
                    "kind": "archive_capture_attribution",
                    "value": match_confidence,
                    "detail": rationale,
                }
            ],
            "used_embedding": False,
            "used_llm": False,
            "inference_decision": {
                "action": "not_required",
                "reason": "stored_alias_match",
                "llm_escalated": False,
                "deterministic_best_score": match_confidence,
                "deterministic_margin": 1.0,
            },
            "resolver_version": HISTORICAL_ATTRIBUTION_VERSION,
            # One archived capture is evidence for many roles, so an attribution
            # is never the observation's primary identity.
            "evidence_kind": "archive_page_attribution",
            "is_primary": False,
        }

    def degraded_source_ids(self, company_id: UUID) -> set[UUID]:
        """Sources whose most recent collection was incomplete.

        Their archive evidence may be missing captures entirely, so absence cannot
        be inferred from it.
        """
        return self.degraded_among(self._company_source_ids(company_id))

    def degraded_among(self, source_ids: list[str]) -> set[UUID]:
        if not source_ids:
            return set()
        # Only each source's latest fetch matters. Reading every fetch of every source met PostgREST's cap: one
        # company already has 130, and they grow by about sixty a day. latest_source_fetch_errors (migration
        # 202608140045) returns each source's newest fetch, the id breaking a tie on fetched_at, in one request.
        latest: list[dict[str, Any]] = []
        for chunk in _chunked(source_ids, _FILTER_CHUNK):
            # bounded: one row per source in the chunk, at most _FILTER_CHUNK rows.
            response = self.client.rpc("latest_source_fetch_errors", {"p_source_ids": chunk}).execute()
            latest += cast(list[dict[str, Any]], response.data or [])
        return {
            UUID(str(row["source_id"]))
            for row in latest
            if cast(dict[str, Any], row.get("error") or {}).get("status") == "degraded"
        }

    def list_role_watchers(self, role_id: UUID) -> list[UUID]:
        """Users whose explicit follows cover this one canonical role."""
        # bounded: one row, the role by its primary key.
        role_rows = cast(
            list[dict[str, Any]],
            self.client.table("canonical_roles")
            .select(_ROLE_FOLLOW_COLUMNS)
            .eq("id", str(role_id))
            .limit(1)
            .execute()
            .data
            or [],
        )
        if not role_rows:
            return []
        role = role_rows[0]
        if role.get("scope_status") != "in_scope" or not role.get("active", True):
            # Out-of-scope, unclassified, retired, and withdrawn roles are never surfaced to a watcher; this mirrors
            # followed_role_ids (migration 202608140036).
            return []
        follows = fetch_all_rows(
            lambda: self.client.table("watchlist_items").select(_FOLLOW_COLUMNS), key="id"
        )
        watchers = {
            UUID(str(row["user_id"])) for row in follows if _follow_covers_role(row, role)
        }
        return sorted(watchers, key=str)

    def watchers_by_role(self) -> dict[UUID, list[UUID]]:
        """Map every followed canonical role to the users following it.

        One read of each table instead of one pair of reads per role. Scheduled
        passes over many roles must not rescan the whole watchlist per role.
        """
        follows = fetch_all_rows(
            lambda: self.client.table("watchlist_items").select(_FOLLOW_COLUMNS), key="id"
        )
        if not follows:
            return {}
        roles = fetch_all_rows(
            lambda: self.client.table("canonical_roles").select(_ROLE_FOLLOW_COLUMNS), key="id"
        )
        watchers: dict[UUID, list[UUID]] = {}
        for role in roles:
            # A company, family, or track follow covers active in-scope roles only; the rest are evidence. A retired
            # or withdrawn role (active = false) is covered by no follow, as in followed_role_ids (202608140036).
            if role.get("scope_status") != "in_scope" or not role.get("active", True):
                continue
            covering = {
                UUID(str(row["user_id"])) for row in follows if _follow_covers_role(row, role)
            }
            if covering:
                watchers[UUID(str(role["id"]))] = sorted(covering, key=str)
        return watchers

    def watched_role_ids(self) -> list[UUID]:
        """Every canonical role covered by at least one explicit follow."""
        return sorted(self.watchers_by_role(), key=str)

    def readiness_context_for_role(self, role_id: UUID) -> dict[str, Any]:
        # bounded: one row, the role by its primary key.
        rows = cast(
            list[dict[str, Any]],
            self.client.table("canonical_roles")
            .select("id,role_family,feature_profile,companies(metadata)")
            .eq("id", str(role_id))
            .limit(1)
            .execute()
            .data
            or [],
        )
        if not rows:
            return {}
        row = rows[0]
        profile = cast(dict[str, Any], row.get("feature_profile") or {})
        company = cast(dict[str, Any], row.get("companies") or {})
        metadata = cast(dict[str, Any], company.get("metadata") or {})
        size = str(metadata.get("company_size") or "unknown")
        if size not in {"startup", "small", "medium", "large", "enterprise", "unknown"}:
            size = "unknown"
        return {
            "company_size": size,
            "recruiting_scale": float(metadata.get("recruiting_scale") or 0.5),
            "role_competitiveness": float(profile.get("role_competitiveness") or 0.5),
            "role_family": str(row.get("role_family") or "unknown"),
            "portfolio_required": profile.get("portfolio_required"),
        }

    def start_agent_run(
        self,
        *,
        agent_name: str,
        purpose: str,
        input_fingerprint: str,
        initiated_by: UUID | None = None,
    ) -> UUID:
        response = (
            self.client.table("agent_runs")
            .insert(
                {
                    "agent_name": agent_name,
                    "purpose": purpose,
                    "input_fingerprint": input_fingerprint,
                    "status": "running",
                    # public_agent_activity never returns a run a user started (migration 202608140031).
                    "initiated_by": str(initiated_by) if initiated_by else None,
                }
            )
            .execute()
        )
        rows = cast(list[dict[str, Any]], response.data or [])
        if not rows:
            raise RuntimeError("Supabase did not return the created agent run")
        return UUID(str(rows[0]["id"]))

    def finish_agent_run(self, run_id: UUID, *, status: str, error: dict[str, Any] | None = None) -> None:
        self.flush_model_attempts()
        self.client.table("agent_runs").update(
            {
                "status": status,
                "finished_at": datetime.now(UTC).isoformat(),
                "error": error,
            }
        ).eq("id", str(run_id)).execute()

    def save_recruiting_agent_state(self, run_id: UUID, state: Any) -> None:
        """Persist observable agent state, never private reasoning or raw model prompts."""
        from .agent import redact_goal

        payload = state.model_dump(mode="json")
        payload["goal"] = redact_goal(str(payload["goal"]))
        self.client.table("agent_runs").update(
            {
                "metadata": {
                    "state_version": "recruiting-agent-state-v1",
                    "state": payload,
                    "contains_private_chain_of_thought": False,
                }
            }
        ).eq("id", str(run_id)).execute()

    def record_tool_call(
        self,
        run_id: UUID,
        *,
        tool_name: str,
        status: str,
        input_redacted: dict[str, Any],
        output_redacted: dict[str, Any],
        started_at: datetime,
        error: dict[str, Any] | None = None,
    ) -> UUID:
        self.flush_model_attempts()
        response = (
            self.client.table("agent_tool_calls")
            .insert(
                {
                    "agent_run_id": str(run_id),
                    "tool_name": tool_name,
                    "status": status,
                    "input_redacted": input_redacted,
                    "output_redacted": output_redacted,
                    "started_at": started_at.isoformat(),
                    "finished_at": datetime.now(UTC).isoformat(),
                    "error": error,
                }
            )
            .execute()
        )
        rows = cast(list[dict[str, Any]], response.data or [])
        if not rows:
            raise RuntimeError("Supabase did not return the created tool call")
        return UUID(str(rows[0]["id"]))

    # Model attempts waiting to be inserted together, when buffer_model_attempts() is on; None writes each at once.
    _model_attempts: list[dict[str, Any]] | None = None
    _MODEL_ATTEMPT_BUFFER = 200

    def buffer_model_attempts(self) -> None:
        """Insert model attempts together instead of one request each: before every tool call and run outcome is
        recorded (each source, each company), and every 200 attempts.

        Collection escalates many observations to a model, and each attempt was its own insert. A run that dies
        between two tool calls loses the attempts of the source or company it was working on; every other record is
        written as before. Only the collection commands turn this on; the agent API writes each attempt as it happens.
        """
        if self._model_attempts is None:
            self._model_attempts = []

    def flush_model_attempts(self) -> None:
        pending = self._model_attempts
        if pending:
            self._model_attempts = []
            self.insert_rows("model_usage", pending)

    def record_model_attempt(self, attempt: ModelAttempt) -> None:
        """Persist every provider attempt, including failures that trigger fallback."""
        if self._model_attempts is None:
            self.client.table("model_usage").insert(attempt.model_dump(mode="json")).execute()
            return
        self._model_attempts.append(attempt.model_dump(mode="json"))
        if len(self._model_attempts) >= self._MODEL_ATTEMPT_BUFFER:
            self.flush_model_attempts()

    def get_signal_source_state(self, source_id: UUID) -> SignalSourceState | None:
        # bounded: one row, the signal state keyed by its source (primary key).
        response = (
            self.client.table("signal_source_states")
            .select("*")
            .eq("source_id", str(source_id))
            .limit(1)
            .execute()
        )
        rows = cast(list[dict[str, Any]], response.data or [])
        if not rows:
            return None
        row = rows[0]
        return SignalSourceState(
            source_id=row["source_id"],
            meaningful_hash=str(row["meaningful_hash"]),
            normalized_text=str(row.get("normalized_text") or ""),
            item_keys=tuple(str(item) for item in row.get("item_keys") or []),
            urls=tuple(str(item) for item in row.get("urls") or []),
            observed_at=datetime.fromisoformat(str(row["observed_at"])),
        )

    def save_signal_source_state(self, state: SignalSourceState) -> None:
        self.client.table("signal_source_states").upsert(
            {
                "source_id": str(state.source_id),
                "meaningful_hash": state.meaningful_hash,
                "normalized_text": bounded_utf8(state.normalized_text, 65_536),
                "item_keys": list(state.item_keys),
                "urls": list(state.urls),
                "observed_at": state.observed_at.isoformat(),
                "updated_at": datetime.now(UTC).isoformat(),
            },
            on_conflict="source_id",
        ).execute()

    def save_signal_observation(
        self,
        source: SourceConfig,
        *,
        observed_at: datetime,
        document_hash: str,
        evidence_text: str,
        extraction_method: str,
    ) -> UUID:
        # bounded: an existence check on (source, content hash), one row at most.
        existing = (
            self.client.table("raw_job_observations")
            .select("id")
            .eq("source_id", str(source.id))
            .eq("content_hash", document_hash)
            .limit(1)
            .execute()
        )
        existing_rows = cast(list[dict[str, Any]], existing.data or [])
        if existing_rows:
            return UUID(str(existing_rows[0]["id"]))
        # Page text is untrusted bytes: a NUL made Postgres reject Databricks' /jp and /kr
        # university pages, and a 65,536-character slice of non-ASCII text overruns the
        # 65,536-byte column checks. Bound it the way every other observation write does.
        evidence = bounded_utf8(evidence_text, 65_536).strip() or "No visible recruiting content."
        response = (
            self.client.table("raw_job_observations")
            .insert(
                {
                    "source_id": str(source.id),
                    "observed_at": observed_at.isoformat(),
                    "fetched_at": observed_at.isoformat(),
                    "content_hash": document_hash,
                    "extraction_method": extraction_method,
                    "raw_text": evidence,
                    "raw_payload": {"record_type": "recruiting_signal_source"},
                    "source_url": str(source.url),
                    "company_name": source.company,
                    "source_type": source.adapter,
                    "source_reliability": {"score": source.trust_score, "purpose": "signal"},
                    "evidence_excerpt": evidence,
                }
            )
            .execute()
        )
        rows = cast(list[dict[str, Any]], response.data or [])
        if not rows:
            raise RuntimeError("Supabase did not return the signal observation")
        return UUID(str(rows[0]["id"]))

    # A company's in-scope roles, kept for the rest of a run by cache_company_roles(); None reads them every time.
    _company_roles: dict[tuple[str, str], list[dict[str, Any]]] | None = None

    def cache_company_roles(self) -> None:
        """Read each company's in-scope roles once for the rest of this repository's life.

        Signal ingestion resolves every signal against its company's roles, and nothing it writes changes them, so a
        second read would return the same rows. Only that command turns this on.
        """
        if self._company_roles is None:
            self._company_roles = {}

    _SIGNAL_ROLE_COLUMNS = "id,normalized_title,company_normalized,role_aliases(normalized_alias)"

    def _in_scope_role_rows(self, company_id: UUID) -> list[dict[str, Any]]:
        """A company's active in-scope roles with the titles signal resolution matches against."""
        key = (str(company_id), self._SIGNAL_ROLE_COLUMNS)
        if self._company_roles is not None and key in self._company_roles:
            return self._company_roles[key]
        rows = fetch_all_rows(
            lambda: self.client.table("canonical_roles")
            .select(self._SIGNAL_ROLE_COLUMNS)
            .eq("scope_status", "in_scope")
            .eq("company_id", str(company_id))
            .eq("active", True),
            key="id",
        )
        if self._company_roles is not None:
            self._company_roles[key] = rows
        return rows

    def resolve_signal_role(self, company_id: UUID, evidence: str) -> UUID | None:
        rows = self._in_scope_role_rows(company_id)
        evidence_tokens = set(normalize_title(evidence).split())
        matches: list[tuple[int, UUID]] = []
        for row in rows:
            aliases = cast(list[dict[str, Any]], row.get("role_aliases") or [])
            names = [str(row.get("normalized_title") or "")]
            names.extend(str(alias.get("normalized_alias") or "") for alias in aliases)
            company = str(row.get("company_normalized") or "")
            score = 0
            for name in names:
                # Identity words only: the company name and "at" are on every page it publishes,
                # so "Figma Researcher" matched any Figma page that mentioned a researcher.
                tokens = identifying_title_tokens(name, company)
                if len(tokens) >= 2 and tokens <= evidence_tokens:
                    score = max(score, len(tokens))
            if score:
                matches.append((score, UUID(str(row["id"]))))
        matches.sort(key=lambda item: (-item[0], str(item[1])))
        if not matches or len(matches) > 1 and matches[0][0] == matches[1][0]:
            return None
        return matches[0][1]

    def list_company_role_ids(self, company_id: UUID) -> list[UUID]:
        """In-scope roles a company-scoped signal may recompute; nothing else is forecast."""
        return [UUID(str(row["id"])) for row in self._in_scope_role_rows(company_id)]

    def upsert_recruiting_signal(self, signal: RecruitingSignal) -> bool:
        # bounded: an existence check on the unique signal identity key, one row at most.
        existing = (
            self.client.table("signals")
            .select("id")
            .eq("identity_key", signal.identity_key)
            .limit(1)
            .execute()
        )
        if existing.data:
            return False
        # One page observation holds at most one signal of a kind for a role (signals' unique key: role, observation,
        # kind). A sitemap that gains two recruiting URLs naming the same role reaches that key twice, and a plain
        # insert of the second was refused, failing the whole source before its state was saved, so every later run
        # failed the same way. The first signal stands for the page; a later one for the same key is not stored.
        response = self.client.table("signals").upsert(
            {
                "id": str(signal.id),
                "company_id": str(signal.company_id),
                "canonical_role_id": str(signal.canonical_role_id) if signal.canonical_role_id else None,
                "observation_id": str(signal.observation_id),
                "source_id": str(signal.source_id),
                "kind": signal.signal_type,
                "observed_at": signal.observed_at.isoformat(),
                "available_at": signal.observed_at.isoformat(),
                "claimed_event_at": signal.claimed_event_at.isoformat() if signal.claimed_event_at else None,
                "source_published_at": signal.source_published_at.isoformat()
                if signal.source_published_at
                else None,
                "source_url": str(signal.source_url),
                "strength": signal.signal_strength,
                "reliability": signal.source_reliability,
                "evidence_quote": bounded_utf8(signal.evidence_snippet, 8_192),
                "extraction_method": signal.extraction_method,
                "identity_key": signal.identity_key,
                "content_hash": signal.content_hash,
                "metadata": {
                    "normalized_schema": "recruiting-signal-v2",
                    "community_event_type": signal.community_event_type,
                    "claimed_date_text": signal.claimed_date_text,
                    "claimed_date_precision": signal.claimed_date_precision,
                    "evidence_semantics": signal.evidence_semantics,
                    "confirmation_eligible_without_official_evidence": False
                    if signal.signal_type == "community_recruiting_discussion"
                    else None,
                },
            },
            on_conflict="canonical_role_id,observation_id,kind",
            ignore_duplicates=True,
        ).execute()
        return bool(response.data)

    @staticmethod
    def _forecast_from_row(row: dict[str, Any]) -> Forecast:
        contributions = tuple(
            ForecastContribution(
                name=str(item["name"]),
                kind=item["kind"],
                date_weight=float(item["date_weight"]),
                confidence_effect=float(item["confidence_effect"]),
                influences_date=bool(item["influences_date"]),
                rationale=str(item["rationale"]),
                evidence_id=item.get("evidence_id"),
                evidence_ids=tuple(str(value) for value in item.get("evidence_ids") or []),
                evidence_date=date.fromisoformat(item["evidence_date"])
                if item.get("evidence_date")
                else None,
            )
            for item in cast(list[dict[str, Any]], row.get("feature_contributions") or [])
        )
        return Forecast(
            point_date=date.fromisoformat(str(row["point_date"])),
            window_start=date.fromisoformat(str(row["window_start"])),
            window_end=date.fromisoformat(str(row["window_end"])),
            confidence=float(row["confidence"]),
            calibrated_probability=float(row["calibrated_probability"]),
            confidence_factors={
                str(key): float(value)
                for key, value in cast(dict[str, Any], row["confidence_factors"]).items()
            },
            feature_contributions=contributions,
            method=str(row["method"]),
            model_version=str(row["model_version"]),
            forecasted_at=datetime.fromisoformat(str(row["forecasted_at"])),
            sample_size=int(row["history_count"]),
            prior_effective_sample_size=float(row["prior_effective_sample_size"]),
            prediction_interval_coverage=float(row["prediction_interval_coverage"]),
            input_fingerprint=str(row["input_fingerprint"]),
        )

    def latest_forecast_version(self, role_id: UUID) -> StoredForecastVersion | None:
        # bounded: one row, the role's newest forecast, with its id breaking a tie on forecasted_at.
        response = (
            self.client.table("forecasts")
            .select("*")
            .eq("canonical_role_id", str(role_id))
            .order("forecasted_at", desc=True)
            .order("id", desc=True)
            .limit(1)
            .execute()
        )
        rows = cast(list[dict[str, Any]], response.data or [])
        if not rows:
            return None
        return StoredForecastVersion(UUID(str(rows[0]["id"])), role_id, self._forecast_from_row(rows[0]))

    def forecast_refused_at(self, role_id: UUID) -> datetime | None:
        """When regeneration last found the role unforecastable (migration 202608140043), or None."""
        # bounded: one row, the role by its primary key.
        rows = cast(
            list[dict[str, Any]],
            self.client.table("canonical_roles")
            .select("forecast_refused_at")
            .eq("id", str(role_id))
            .limit(1)
            .execute()
            .data
            or [],
        )
        return parse_timestamp(rows[0].get("forecast_refused_at")) if rows else None

    def current_forecast_version(self, role_id: UUID) -> StoredForecastVersion | None:
        """The latest version, unless the model has declined the role since: then the role has no current forecast."""
        latest = self.latest_forecast_version(role_id)
        if latest is None:
            return None
        return latest if forecast_is_current(latest.forecast.forecasted_at, self.forecast_refused_at(role_id)) else None

    def record_forecast_refusal(self, role_id: UUID, *, reason: str, at: datetime) -> None:
        """The model declined the role: earlier versions stop being current until it forecasts the role again."""
        self.client.table("canonical_roles").update(
            {"forecast_refused_at": at.isoformat(), "forecast_refusal_reason": reason[:500] or "insufficient evidence"}
        ).eq("id", str(role_id)).execute()

    def save_signal_forecast_version(
        self,
        role_id: UUID,
        forecast: Forecast,
        *,
        supersedes_id: UUID | None,
        trigger_signal_ids: Sequence[UUID],
    ) -> StoredForecastVersion:
        response = (
            self.client.table("forecasts")
            .insert(
                {
                    "canonical_role_id": str(role_id),
                    "as_of": forecast.forecasted_at.date().isoformat(),
                    "point_date": forecast.point_date.isoformat(),
                    "window_start": forecast.window_start.isoformat(),
                    "window_end": forecast.window_end.isoformat(),
                    "confidence": forecast.confidence,
                    "calibrated_probability": forecast.calibrated_probability,
                    "confidence_factors": forecast.confidence_factors,
                    "feature_contributions": [
                        {
                            **item.__dict__,
                            "evidence_date": item.evidence_date.isoformat() if item.evidence_date else None,
                        }
                        for item in forecast.feature_contributions
                    ],
                    "method": forecast.method,
                    "model_version": forecast.model_version,
                    "forecasted_at": forecast.forecasted_at.isoformat(),
                    "history_count": forecast.sample_size,
                    "prior_effective_sample_size": forecast.prior_effective_sample_size,
                    "prediction_interval_coverage": forecast.prediction_interval_coverage,
                    "input_fingerprint": forecast.input_fingerprint,
                    "supersedes_forecast_id": str(supersedes_id) if supersedes_id else None,
                    "trigger_signal_ids": [str(item) for item in trigger_signal_ids],
                    "recomputation_reason": "new_recruiting_signal",
                }
            )
            .execute()
        )
        rows = cast(list[dict[str, Any]], response.data or [])
        if not rows:
            raise RuntimeError("Supabase did not return the forecast version")
        stored = StoredForecastVersion(UUID(str(rows[0]["id"])), role_id, forecast)
        self._save_forecast_evidence(stored.id, forecast)
        return stored

    def save_agent_forecast_version(
        self,
        role_id: UUID,
        forecast: Forecast,
        *,
        as_of: date,
        supersedes_id: UUID | None = None,
        recomputation_reason: str = "recruiting_agent_request",
    ) -> UUID:
        """Insert a forecast computed by the statistical component for an agent request."""
        response = (
            self.client.table("forecasts")
            .insert(
                {
                    "canonical_role_id": str(role_id),
                    "as_of": as_of.isoformat(),
                    "point_date": forecast.point_date.isoformat(),
                    "window_start": forecast.window_start.isoformat(),
                    "window_end": forecast.window_end.isoformat(),
                    "confidence": forecast.confidence,
                    "calibrated_probability": forecast.calibrated_probability,
                    "confidence_factors": forecast.confidence_factors,
                    "feature_contributions": [
                        {
                            **item.__dict__,
                            "evidence_date": item.evidence_date.isoformat() if item.evidence_date else None,
                        }
                        for item in forecast.feature_contributions
                    ],
                    "method": forecast.method,
                    "model_version": forecast.model_version,
                    "forecasted_at": forecast.forecasted_at.isoformat(),
                    "history_count": forecast.sample_size,
                    "prior_effective_sample_size": forecast.prior_effective_sample_size,
                    "prediction_interval_coverage": forecast.prediction_interval_coverage,
                    "input_fingerprint": forecast.input_fingerprint,
                    "supersedes_forecast_id": str(supersedes_id) if supersedes_id else None,
                    "trigger_signal_ids": [],
                    "recomputation_reason": recomputation_reason,
                }
            )
            .execute()
        )
        rows = cast(list[dict[str, Any]], response.data or [])
        if not rows:
            raise RuntimeError("Supabase did not return the agent forecast version")
        forecast_id = UUID(str(rows[0]["id"]))
        self._save_forecast_evidence(forecast_id, forecast)
        return forecast_id

    def _save_forecast_evidence(self, forecast_id: UUID, forecast: Forecast) -> None:
        # Each piece of evidence is written with the observation it came from. Those are read for every cited signal
        # and opening together, a hundred ids a request, instead of one request per id: a forecast can cite over a
        # thousand signals.
        cited: dict[str, set[str]] = defaultdict(set)
        for contribution in forecast.feature_contributions:
            table = "signals" if contribution.kind == "signal" else "historical_opening_events"
            cited[table].update(
                str(item) for item in contribution.evidence_ids or ((contribution.evidence_id,) if contribution.evidence_id else ())
            )
        found = {
            (table, str(row["id"])): row
            for table, ids in cited.items()
            for row in self._rows_in(table, "id,observation_id", "id", sorted(ids))
        }
        payloads: list[dict[str, Any]] = []
        for contribution in forecast.feature_contributions:
            evidence_ids = contribution.evidence_ids or (
                (contribution.evidence_id,) if contribution.evidence_id else ()
            )
            if not evidence_ids:
                continue
            table = "signals" if contribution.kind == "signal" else "historical_opening_events"
            for evidence_id in evidence_ids:
                row = found.get((table, str(evidence_id)))
                if row is None:
                    continue
                total_weight = contribution.date_weight or abs(contribution.confidence_effect)
                payloads.append(
                    {
                        "forecast_id": str(forecast_id),
                        "observation_id": str(row["observation_id"]),
                        "historical_opening_event_id": str(row["id"])
                        if contribution.kind != "signal"
                        else None,
                        "signal_id": str(row["id"]) if contribution.kind == "signal" else None,
                        "contribution": contribution.kind,
                        "weight": min(1.0, max(0.0, total_weight / len(evidence_ids))),
                        "rationale": contribution.rationale,
                    }
                )
        if payloads:
            self.client.table("forecast_evidence").insert(payloads).execute()

    def save_forecast_change(self, change: ForecastChange) -> None:
        self.client.table("forecast_changes").insert(
            {
                "before_forecast_id": str(change.before_forecast_id),
                "after_forecast_id": str(change.after_forecast_id),
                "trigger_signal_ids": [str(item) for item in change.trigger_signal_ids],
                "material": change.material,
                "confidence_delta": change.confidence_delta,
                "point_date_delta_days": change.point_date_delta_days,
                "interval_start_delta_days": change.interval_start_delta_days,
                "interval_end_delta_days": change.interval_end_delta_days,
                "reasons": list(change.reasons),
            }
        ).execute()

    def build_current_forecast(
        self,
        role_id: UUID,
        *,
        as_of: date,
        dataset: BacktestDataset | None = None,
    ) -> Forecast:
        """Reconstruct the deterministic production inputs after new signals arrive.

        `dataset` lets a caller that forecasts many roles load the evidence once
        instead of re-reading every role, observation, match, event, and signal
        per role. Pass it only when nothing in the pass mutates that evidence;
        signal ingestion, which creates signals as it runs, re-reads the signals
        (load_backtest_signals) after each source that created some.
        """
        roles, events, signals = dataset if dataset is not None else self.load_backtest_dataset()
        role_by_id = {item.id: item for item in roles}
        role = role_by_id.get(str(role_id))
        if not role:
            raise ValueError(f"Unknown canonical role {role_id}")

        def openings(items: list[BacktestEvent]) -> list[HistoricalOpening]:
            return [
                item.as_opening()
                for item in collapse_event_cycles(
                    item
                    for item in items
                    if item.opened_on <= as_of and item.effective_available_at.date() <= as_of
                )
            ]

        history = openings([item for item in events if item.role_id == role.id])
        company_history = openings(
            [
                item
                for item in events
                if item.role_id != role.id and role_by_id[item.role_id].company_id == role.company_id
                and compatible_prior_role(role, role_by_id[item.role_id])
            ]
        )
        family_history = openings(
            [
                item
                for item in events
                if item.role_id != role.id
                and role_by_id[item.role_id].company_id != role.company_id
                and role_by_id[item.role_id].role_family == role.role_family
                and compatible_prior_role(role, role_by_id[item.role_id])
            ]
        )
        company_prior = (
            SeasonalityPrior.from_history("company seasonality", company_history) if company_history else None
        )
        family_prior = (
            SeasonalityPrior.from_history("role-family seasonality", family_history)
            if family_history
            else None
        )
        current_signals = [
            Signal(
                item.observed_on,
                item.strength,
                item.reliability,
                item.kind,
                item.direction,
                item.id,
            )
            for item in signals
            if item.role_id == role.id
            and item.observed_on <= as_of
            and item.effective_available_at.date() <= as_of
        ]
        return HierarchicalCircularForecastModel().forecast(
            history,
            current_signals,
            as_of=as_of,
            company_prior=company_prior,
            role_family_prior=family_prior,
            company_size=role.company_size,
            recruiting_scale=role.recruiting_scale,
            forecasted_at=datetime.now(UTC),
        )

    def load_backtest_dataset(self) -> BacktestDataset:
        """Load source-linked temporal evidence with its original availability time."""
        evidence = self.load_forecast_evidence()
        return evidence.roles, evidence.events, self.load_backtest_signals(evidence)

    def load_forecast_evidence(self) -> ForecastEvidence:
        """The dataset's roles and opening events, and when each observation became available.

        Signal ingestion adds signals (and the page observations they cite) and nothing else a forecast reads, so it
        loads this once and re-reads only the signals after each source that created some (load_backtest_signals).
        """
        role_rows = fetch_all_rows(
            lambda: self.client.table("canonical_roles")
            .select("id,company_id,role_family,level,recruiting_season,companies(metadata)")
            .eq("active", True), key="id"
        )
        # Only active roles and their evidence: a role retired by a re-resolution or hidden by a company withdrawal
        # (active = false) is out of the product, and its openings and signals inform no other role's prior.
        active_role_ids = {str(row["id"]) for row in role_rows}
        roles: list[BacktestRole] = []
        for row in role_rows:
            company = cast(dict[str, Any], row.get("companies") or {})
            metadata = cast(dict[str, Any], company.get("metadata") or {})
            company_size = str(metadata.get("company_size") or "unknown")
            if company_size not in {"startup", "small", "medium", "large", "enterprise", "unknown"}:
                company_size = "unknown"
            recruiting_scale = metadata.get("recruiting_scale")
            roles.append(
                BacktestRole(
                    id=str(row["id"]),
                    company_id=str(row["company_id"]),
                    role_family=str(row.get("role_family") or "other"),
                    company_size=cast(Any, company_size),
                    recruiting_scale=float(recruiting_scale) if recruiting_scale is not None else None,
                    level=str(row.get("level") or "unknown"),
                    recruiting_season=str(row.get("recruiting_season") or "unknown"),
                )
            )

        observation_rows = fetch_all_rows(
            lambda: self.client.table("raw_job_observations").select("id,observed_at,raw_title"), key="id"
        )
        observed_at = {
            str(row["id"]): datetime.fromisoformat(str(row["observed_at"])) for row in observation_rows
        }
        # The posting title is the only place a source states its target cohort.
        observation_title = {str(row["id"]): str(row.get("raw_title") or "") for row in observation_rows}
        role_season = {
            str(row["id"]): str(row.get("recruiting_season") or "unknown") for row in role_rows
        }
        match_rows = fetch_all_rows(
            lambda: self.client.table("observation_role_matches").select(
                "observation_id,canonical_role_id,match_confidence,created_at"
            ), key=("observation_id", "canonical_role_id")
        )
        # One observation may be evidence for many roles, so the match is keyed by
        # the pair. Availability still comes from the specific role's own match row.
        role_matches = {
            (str(row["observation_id"]), str(row["canonical_role_id"])): row for row in match_rows
        }
        event_rows = fetch_all_rows(
            lambda: self.client.table("historical_opening_events").select(
                "id,canonical_role_id,observation_id,opened_on,source_quality,"
                "opening_window_start,opening_window_end,uncertainty_days,date_precision,available_at"
            ), key="id"
        )
        events: list[BacktestEvent] = []
        for row in event_rows:
            if str(row["canonical_role_id"]) not in active_role_ids:
                continue
            observation_id = str(row["observation_id"])
            if observation_id not in observed_at:
                raise RuntimeError(f"Historical event {row['id']} has no available observation")
            role_match = role_matches.get((observation_id, str(row["canonical_role_id"])))
            if role_match is None:
                raise RuntimeError(
                    f"Historical event {row['id']} has no persisted role match for its role"
                )
            raw_uncertainty = row.get("uncertainty_days")
            opened_on = date.fromisoformat(str(row["opened_on"]))
            events.append(
                BacktestEvent(
                    id=str(row["id"]),
                    role_id=str(row["canonical_role_id"]),
                    opened_on=opened_on,
                    cycle_key=derive_cycle_key(
                        observation_title.get(observation_id),
                        role_season.get(str(row["canonical_role_id"])),
                        opened_on,
                    ),
                    available_at=datetime.fromisoformat(str(row["available_at"])),
                    source_quality=float(row["source_quality"]),
                    uncertainty_days=float(raw_uncertainty) if raw_uncertainty is not None else None,
                    observation_id=observation_id,
                    date_precision=cast(Any, row.get("date_precision") or "observed_by"),
                    observation_available_at=observed_at[observation_id],
                    role_match_confidence=float(role_match["match_confidence"]),
                    role_match_available_at=datetime.fromisoformat(str(role_match["created_at"])),
                    opening_window_start=date.fromisoformat(str(row["opening_window_start"]))
                    if row.get("opening_window_start")
                    else None,
                    opening_window_end=date.fromisoformat(str(row["opening_window_end"]))
                    if row.get("opening_window_end")
                    else None,
                )
            )
        return ForecastEvidence(roles=roles, events=events, observed_at=observed_at, active_role_ids=active_role_ids)

    def load_backtest_signals(self, evidence: ForecastEvidence) -> list[BacktestSignal]:
        """Every signal of an active role, as load_backtest_dataset reads them, against evidence loaded earlier.

        A signal cites the observation it was read from. One written after `evidence` was loaded is read by id here,
        so its availability time is the stored one, exactly as a fresh full load would find it.
        """
        roles, observed_at, active_role_ids = evidence.roles, evidence.observed_at, evidence.active_role_ids
        signal_rows = fetch_all_rows(
            lambda: self.client.table("signals").select(
                "id,company_id,canonical_role_id,observation_id,observed_at,available_at,"
                "strength,reliability,kind,metadata"
            ),
            key="id",
        )
        unseen = sorted({str(row["observation_id"]) for row in signal_rows} - set(observed_at))
        for row in self._rows_in("raw_job_observations", "id,observed_at", "id", unseen):
            observed_at[str(row["id"])] = datetime.fromisoformat(str(row["observed_at"]))
        signals: list[BacktestSignal] = []
        for row in signal_rows:
            if row.get("canonical_role_id") and str(row["canonical_role_id"]) not in active_role_ids:
                continue
            observation_id = str(row["observation_id"])
            if observation_id not in observed_at:
                raise RuntimeError(f"Signal {row['id']} has no available observation")
            signal_time = datetime.fromisoformat(str(row["observed_at"]))
            available_at = datetime.fromisoformat(str(row["available_at"]))
            metadata = cast(dict[str, Any], row.get("metadata") or {})
            direction = "contradict" if metadata.get("direction") == "contradict" else "support"
            role_ids = (
                [str(row["canonical_role_id"])]
                if row.get("canonical_role_id")
                else [role.id for role in roles if role.company_id == str(row["company_id"])]
            )
            for signal_role_id in role_ids:
                signals.append(
                    BacktestSignal(
                        id=str(row["id"]),
                        role_id=signal_role_id,
                        observed_on=signal_time.date(),
                        available_at=available_at,
                        strength=float(row["strength"]),
                        reliability=float(row["reliability"]),
                        kind=str(row["kind"]),
                        direction=cast(Any, direction),
                        observation_available_at=observed_at[observation_id],
                    )
                )
        return signals

    # ------------------------------------------------------------------ takedowns (docs/takedown.md)

    def company_hold(self, company_id: UUID) -> dict[str, Any] | None:
        """The company-wide disable or withdrawal in force, or None when collection is not held."""
        rows = cast(
            list[dict[str, Any]],
            # bounded: limit(1), the company's latest company-wide action.
            self.client.table("collection_takedowns")
            .select("id,action,reason,requested_by,recorded_at")
            .eq("company_id", str(company_id))
            .is_("source_id", "null")
            .order("recorded_at", desc=True)
            .order("id", desc=True)
            .limit(1)
            .execute()
            .data
            or [],
        )
        return rows[0] if rows and rows[0].get("action") in HOLD_ACTIONS else None

    def withdrawn_company_ids(self) -> set[UUID]:
        """Companies whose latest company-wide takedown is a withdrawal or an erasure: out of the product entirely."""
        rows = fetch_all_rows(
            lambda: self.client.table("collection_takedowns")
            .select("id,company_id,action,recorded_at")
            .is_("source_id", "null")
            .order("recorded_at"),
            key="id",
        )
        latest: dict[str, str] = {}
        for row in rows:
            latest[str(row["company_id"])] = str(row["action"])
        return {UUID(company_id) for company_id, action in latest.items() if action in {"withdraw", "erase"}}

    def _refuse_if_held(self, company_id: UUID, company: str) -> None:
        hold = self.company_hold(company_id)
        if hold is not None:
            raise CollectionHeldError(company, hold)

    def company_by_query(self, query: str) -> dict[str, Any] | None:
        """The persisted company whose domain, or failing that name, is `query`, ignoring case."""
        cleaned = query.strip()
        domain = cleaned.casefold().removeprefix("https://").removeprefix("http://").removeprefix("www.").rstrip("/")
        found = self.company_by_domain(domain)
        if found is not None:
            return found
        rows = cast(
            list[dict[str, Any]],
            # bounded: limit(2), enough to tell one match from several.
            self.client.table("companies").select("id,name,domain").ilike("name", cleaned).limit(2).execute().data or [],
        )
        return rows[0] if len(rows) == 1 else None

    def source_with_company(self, source_id: UUID) -> dict[str, Any] | None:
        rows = cast(
            list[dict[str, Any]],
            # bounded: one row, the source by its primary key.
            self.client.table("sources")
            .select("id,url,adapter,enabled,company_id,companies!inner(name,domain)")
            .eq("id", str(source_id))
            .limit(1)
            .execute()
            .data
            or [],
        )
        return rows[0] if rows else None

    def company_sources(self, company_id: UUID) -> list[dict[str, Any]]:
        return fetch_all_rows(
            lambda: self.client.table("sources")
            .select("id,url,adapter,enabled")
            .eq("company_id", str(company_id))
            .order("url"),
            key="id",
        )

    def takedown_history(self, company_id: UUID) -> list[dict[str, Any]]:
        return fetch_all_rows(
            lambda: self.client.table("collection_takedowns")
            .select("id,recorded_at,source_id,action,reason,requested_by,source_ids,role_ids")
            .eq("company_id", str(company_id))
            .order("recorded_at"),
            key="id",
        )

    def withdrawal_preview(self, company_id: UUID) -> dict[str, int]:
        """What a withdrawal would take off the product, counted without changing anything."""
        roles = fetch_all_rows(
            lambda: self.client.table("canonical_roles")
            .select("id,scope_status")
            .eq("company_id", str(company_id))
            .eq("active", True),
            key="id",
        )
        role_ids = {str(row["id"]) for row in roles}
        watchers = self.watchers_by_role()
        followers = {user for role_id, users in watchers.items() if str(role_id) in role_ids for user in users}
        observations = 0
        source_ids = [str(row["id"]) for row in self.company_sources(company_id)]
        for chunk in _chunked(source_ids, _FILTER_CHUNK):
            if chunk:
                response = (
                    # bounded: head=True returns a count and no rows.
                    self.client.table("raw_job_observations")
                    .select("id", count=cast(Any, "exact"), head=True)
                    .in_("source_id", chunk)
                    .execute()
                )
                observations += int(response.count or 0)
        return {
            "roles_to_deactivate": len(roles),
            "in_scope_roles_to_deactivate": sum(1 for row in roles if row.get("scope_status") == "in_scope"),
            "users_following_them": len(followers),
            "observations_retained": observations,
            "other_forecasts_to_regenerate": len(self.roles_whose_latest_forecast_cites(company_id)),
        }

    def roles_whose_latest_forecast_cites(self, company_id: UUID) -> list[UUID]:
        """Active in-scope roles of other companies whose latest forecast lists this company's evidence.

        After a withdrawal these are re-forecast, so the company's postings stop appearing in another role's provenance.
        """
        source_ids = [str(row["id"]) for row in self.company_sources(company_id)]
        observations = self._rows_in("raw_job_observations", "id", "source_id", source_ids)
        observation_ids = [str(row["id"]) for row in observations]
        evidence = self._rows_in("forecast_evidence", "forecast_id", "observation_id", observation_ids)
        forecast_ids = sorted({str(row["forecast_id"]) for row in evidence})
        citing = {
            str(row["canonical_role_id"]): str(row["id"])
            for row in self._rows_in("forecasts", "id,canonical_role_id", "id", forecast_ids)
        }
        own = {
            str(row["id"])
            for row in fetch_all_rows(
                lambda: self.client.table("canonical_roles").select("id").eq("company_id", str(company_id)), key="id"
            )
        }
        in_scope = {str(role_id) for role_id in self.in_scope_role_ids()}
        roles: list[UUID] = []
        for role_id in sorted(set(citing) & in_scope - own):
            latest = self.current_forecast_version(UUID(role_id))
            if latest is not None and str(latest.id) in set(forecast_ids):
                roles.append(UUID(role_id))
        return roles

    def apply_collection_takedown(
        self,
        company_id: UUID,
        source_id: UUID | None,
        action: TakedownAction,
        reason: str,
        requested_by: str,
    ) -> dict[str, Any]:
        """One takedown action and its audit row, in one transaction (migration 202608140039)."""
        data = (
            # bounded: the function returns the one audit row it wrote.
            self.client.rpc(
                "apply_collection_takedown",
                {
                    "p_company_id": str(company_id),
                    "p_source_id": str(source_id) if source_id else None,
                    "p_action": action,
                    "p_reason": reason,
                    "p_requested_by": requested_by,
                },
            )
            .execute()
            .data
        )
        row = data[0] if isinstance(data, list) and data else data
        if isinstance(row, dict):
            return cast(dict[str, Any], row)
        raise RuntimeError("Supabase did not return the recorded takedown")

    def save_backtest_run(self, run: BacktestRun) -> None:
        """Persist the immutable run summary and every auditable target evaluation."""
        self.client.table("backtest_runs").insert(
            {
                "id": str(run.id),
                "output_schema_version": run.schema_version,
                "model_version": run.model_version,
                "model_versions": list(run.model_versions),
                "status": "succeeded",
                "dataset_fingerprint": run.dataset_fingerprint,
                "cutoff_days": run.cutoff_days,
                "from_year": run.from_year,
                "to_year": run.to_year,
                "started_at": run.started_at.isoformat(),
                "finished_at": run.finished_at.isoformat(),
                "target_count": run.target_count,
                "completed_cases": run.completed_cases,
                "skipped_cases": run.skipped_cases,
                "aggregate_metrics": cast(dict[str, Any], run.to_dict()["metrics"]),
                "calibration_metrics": cast(
                    dict[str, Any],
                    {
                        "confidence_calibration": run.to_dict()["confidence_calibration"],
                        "performance_by_history": run.to_dict()["performance_by_history"],
                        "performance_by_source_quality": run.to_dict()["performance_by_source_quality"],
                        "skipped_targets": run.to_dict()["skipped_targets"],
                        "confidence_evaluation_target": run.confidence_evaluation_target,
                        "out_of_scope_targets_excluded": run.out_of_scope_targets_excluded,
                    },
                ),
            }
        ).execute()
        if run.cases:
            self.client.table("backtest_cases").insert(
                [
                    {
                        "run_id": str(run.id),
                        "canonical_role_id": case.role_id,
                        "target_event_id": case.target_event_id,
                        "target_year": case.target_year,
                        "forecast_cutoff": case.forecast_cutoff.isoformat(),
                        "actual_opened_on": case.actual_opened_on.isoformat(),
                        "actual_interval_start": case.actual_interval_start.isoformat(),
                        "actual_interval_end": case.actual_interval_end.isoformat(),
                        "target_date_precision": case.target_date_precision,
                        "expected_opening_date": case.expected_opening_date.isoformat(),
                        "interval_start": case.interval_start.isoformat(),
                        "interval_end": case.interval_end.isoformat(),
                        "confidence": case.confidence,
                        "absolute_error_days": case.absolute_error_days,
                        "inside_interval": case.inside_interval,
                        "interval_width_days": case.interval_width_days,
                        "history_observations": case.history_observations,
                        "target_source_quality": case.target_source_quality,
                        "source_quality_bucket": case.source_quality_bucket,
                        "company_prior_observations": case.company_prior_observations,
                        "role_family_prior_observations": case.role_family_prior_observations,
                        "model_version": case.model_version,
                        "input_fingerprint": case.input_fingerprint,
                        "input_event_ids": list(case.input_event_ids),
                        "input_signal_ids": list(case.input_signal_ids),
                        "latest_input_available_at": case.latest_input_available_at.isoformat(),
                        "latest_input_available_on": case.latest_input_available_at.date().isoformat(),
                    }
                    for case in run.cases
                ]
            ).execute()
