from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections.abc import Sequence
from datetime import UTC, date, datetime
from hashlib import sha256
from pathlib import Path
from time import monotonic
from typing import Any
from uuid import UUID, uuid5

from postgrest.exceptions import APIError
from pydantic import HttpUrl, ValidationError

from .adapters.base import UrlLibTransport
from .adapters.reddit import RedditDataApiClient, RedditSignalAdapter
from .adapters.registry import AdapterRegistry
from .backtesting import BacktestRunner
from .config import get_settings
from .discovery import (
    DiscoveredSource,
    DiscoverRecruitingSources,
    DiscoveryEvidence,
    IdentifyCompany,
    LlmIdentityResolver,
    _canonical_url,
    board_names_company,
)
from .enrichment import EnrichmentSummary, EvidenceEnrichmentService
from .forecasting import Forecast, InsufficientEvidenceError
from .providers import ModelRouter
from .readiness import (
    ApplicationReadinessPlanner,
    ReadinessContext,
    ReadinessForecast,
    SupabaseReadinessPlanStore,
)
from .recruiting_paths import page_source_allowed
from .repository import BacktestDataset, IntelligenceRepository
from .role_identity_migration import (
    RoleIdentityMigrationService,
    RoleIdentityPlan,
    RoleIdentitySummary,
)
from .role_resolution import RESOLVER_VERSION, LlmRoleClassifier, RoleResolver
from .scope import (
    DISCIPLINES,
    EARLY_CAREER_TYPES,
    SCOPE_CLASSIFIER_VERSION,
    LlmScopeClassifier,
    RoleScopeClassifier,
    RoleScopeService,
    RoleScopeSummary,
)
from .scope_review import (
    AMBIGUOUS_REASONS,
    DEFAULT_FIXTURES,
    OUT_OF_SCOPE_REASONS,
    REVIEW_BASES,
    ScopeDecision,
    ScopeReviewError,
    ScopeReviewService,
    render_queue,
)
from .security import redact_sensitive_text
from .signals import RecruitingSignalIngestionService, SignalForecastVersionService
from .source_ingestion import SourceIngestionService
from .takedown import TakedownRefused, TakedownService


def run_ingestion(company: str | None, *, collection: str = "all") -> int:
    settings = get_settings()
    repository = IntelligenceRepository.from_settings(settings)
    sources = repository.list_source_configs(company)
    if collection == "current":
        sources = [source for source in sources if source.adapter not in {"wayback", "reddit"}]
    elif collection == "historical":
        sources = [source for source in sources if source.adapter == "wayback"]
    fingerprint = sha256("|".join(sorted(str(source.id) for source in sources)).encode()).hexdigest()
    run_id = repository.start_agent_run(
        agent_name="source_ingestion",
        purpose=f"Ingest recruiting sources for {company or 'all configured companies'}",
        input_fingerprint=fingerprint,
    )
    router = ModelRouter.from_settings(settings, tracker=repository)
    service = SourceIngestionService(
        AdapterRegistry.with_fallbacks(router.client("extract", agent_run_id=run_id)),
        UrlLibTransport(settings),
        repository,
        agent_run_id=run_id,
    )
    failures = degraded = 0
    diagnostic_counts: dict[str, int] = {}
    detected = created = changed = unchanged = 0
    for source in sources:
        started_at = datetime.now(UTC)
        try:
            summary = service.ingest(source, observed_at=started_at)
            detected += summary.detected
            created += summary.created
            changed += summary.changed
            unchanged += summary.unchanged
            if not summary.complete:
                degraded += 1
            for diagnostic in summary.diagnostics:
                diagnostic_counts[diagnostic.code] = diagnostic_counts.get(diagnostic.code, 0) + 1
            repository.record_tool_call(
                run_id,
                tool_name=f"source_adapter.{source.adapter}",
                status="succeeded" if summary.complete else "partial",
                input_redacted={"source_id": str(source.id), "company_id": str(source.company_id)},
                output_redacted={
                    "detected": summary.detected,
                    "created": summary.created,
                    "changed": summary.changed,
                    "unchanged": summary.unchanged,
                    "page_unchanged": summary.page_unchanged,
                    "document_hash": summary.document_hash,
                    "complete": summary.complete,
                    "diagnostic_codes": [item.code for item in summary.diagnostics[:20]],
                },
                started_at=started_at,
            )
        except Exception as exc:  # noqa: BLE001 - sources fail independently and are audited
            failures += 1
            repository.record_tool_call(
                run_id,
                tool_name=f"source_adapter.{source.adapter}",
                status="failed",
                input_redacted={"source_id": str(source.id), "company_id": str(source.company_id)},
                output_redacted={},
                started_at=started_at,
                error={"type": type(exc).__name__, "message": redact_sensitive_text(exc)},
            )
    # Collected evidence only becomes forecastable once it carries canonical role
    # identity and reconstructed opening history, so enrichment runs in the same
    # pass over exactly the companies whose sources were just collected.
    enrichment_summaries, enrichment_failures = _enrich_companies(
        repository,
        sorted({source.company_id for source in sources}, key=str),
        run_id=run_id,
        router=router,
    )
    enrichment = _enrichment_totals(enrichment_summaries, enrichment_failures)
    status = (
        "failed"
        if failures == len(sources) and sources
        else "partial"
        if failures or degraded or enrichment["failures"]
        else "succeeded"
    )
    repository.finish_agent_run(run_id, status=status)
    print(
        json.dumps(
            {
                "collection": collection,
                "sources": len(sources),
                "detected": detected,
                "created": created,
                "changed": changed,
                "unchanged": unchanged,
                "failures": failures,
                "degraded_sources": degraded,
                "diagnostics": diagnostic_counts,
                "enrichment": enrichment,
                "status": status,
                "run_id": str(run_id),
            },
            indent=2,
        )
    )
    return 1 if status == "failed" and sources else 0


def _enrich_companies(
    repository: IntelligenceRepository,
    company_ids: list[UUID],
    *,
    run_id: UUID,
    router: ModelRouter,
) -> tuple[list[EnrichmentSummary], int]:
    """Derive canonical roles and historical openings from persisted evidence.

    Companies enrich independently and every outcome is audited, so one failing
    company cannot discard another company's successfully derived records.
    """
    service = EvidenceEnrichmentService(
        repository,
        resolver=RoleResolver(
            llm=LlmRoleClassifier(router.client("classify", agent_run_id=run_id)),
        ),
        scope_service=RoleScopeService(
            repository,
            RoleScopeClassifier(LlmScopeClassifier(router.client("classify", agent_run_id=run_id))),
        ),
    )
    summaries: list[EnrichmentSummary] = []
    failures = 0
    for company_id in company_ids:
        started_at = datetime.now(UTC)
        try:
            summary = service.enrich_company(company_id)
        except Exception as exc:  # noqa: BLE001 - companies enrich independently
            failures += 1
            repository.record_tool_call(
                run_id,
                tool_name="enrichment.company",
                status="failed",
                input_redacted={"company_id": str(company_id)},
                output_redacted={},
                started_at=started_at,
                error={"type": type(exc).__name__, "message": redact_sensitive_text(exc)},
            )
            continue
        summaries.append(summary)
        repository.record_tool_call(
            run_id,
            tool_name="enrichment.company",
            status="succeeded" if summary.complete else "partial",
            input_redacted={"company_id": str(company_id)},
            output_redacted=summary.as_dict(),
            started_at=started_at,
        )
    return summaries, failures


def _enrichment_totals(summaries: list[EnrichmentSummary], failures: int) -> dict[str, object]:
    return {
        "companies": len(summaries) + failures,
        "observations_considered": sum(item.observations_considered for item in summaries),
        "roles_matched": sum(item.roles_matched for item in summaries),
        "roles_created": sum(item.roles_created for item in summaries),
        "historical_events_persisted": sum(item.events_persisted for item in summaries),
        "degraded_capture_sources": sum(item.degraded_capture_sources for item in summaries),
        "roles_in_scope": sum(item.roles_in_scope for item in summaries),
        "scope_classifications_written": sum(item.scope_classifications_written for item in summaries),
        "failures": failures
        + sum(item.resolution_failures + item.reconstruction_failures + item.scope_failures for item in summaries),
    }


def run_enrichment(company: str | None) -> int:
    """Standalone re-derivation of roles and openings from already-collected evidence."""
    settings = get_settings()
    repository = IntelligenceRepository.from_settings(settings)
    sources = repository.list_source_configs(company)
    company_ids = sorted({source.company_id for source in sources}, key=str)
    run_id = repository.start_agent_run(
        agent_name="evidence_enrichment",
        purpose=f"Derive recurring roles and opening history for {company or 'all companies'}",
        input_fingerprint=sha256("|".join(str(item) for item in company_ids).encode()).hexdigest(),
    )
    router = ModelRouter.from_settings(settings, tracker=repository)
    summaries, failures = _enrich_companies(repository, company_ids, run_id=run_id, router=router)
    totals = _enrichment_totals(summaries, failures)
    status = (
        "failed"
        if company_ids and failures == len(company_ids)
        else "partial"
        if totals["failures"]
        else "succeeded"
    )
    repository.finish_agent_run(run_id, status=status)
    print(json.dumps({**totals, "status": status, "run_id": str(run_id)}, indent=2))
    return 1 if status == "failed" and company_ids else 0


def _plan_readiness_for_watchers(
    repository: IntelligenceRepository,
    role_id: UUID,
    *,
    forecast: Forecast,
    forecast_id: UUID,
    as_of: date,
    watchers: Sequence[UUID],
) -> int:
    """Persist deterministic work-back plans for every user following this role.

    Dates come from the versioned readiness policy applied to the statistical
    forecast interval; the planner never re-derives forecast values. `watchers`
    is supplied by the caller so a pass over many roles resolves the watchlist
    once rather than rescanning it per role.
    """
    if forecast.window_end < as_of:
        # An elapsed interval cannot produce a defensible preparation deadline.
        return 0
    if not watchers:
        return 0
    context = repository.readiness_context_for_role(role_id)
    plan = ApplicationReadinessPlanner().plan(
        ReadinessForecast(
            forecast_id=forecast_id,
            role_id=role_id,
            as_of=as_of,
            expected_opening_date=forecast.point_date,
            interval_start=forecast.window_start,
            interval_end=forecast.window_end,
            confidence=forecast.confidence,
        ),
        ReadinessContext(**context) if context else ReadinessContext(),
    )
    store = SupabaseReadinessPlanStore(repository.client)
    for user_id in watchers:
        store.save_for_user(user_id, plan)
    return len(watchers)


def plan_readiness_for_watchlists() -> int:
    """Materialise work-back plans for every followed role from its latest forecast.

    Readiness plans are otherwise written only when a *new* forecast version is
    inserted, so a role followed after its last regeneration would never receive
    milestones. This command is idempotent: the planner is deterministic and the
    store upserts on (user, forecast, kind, policy version).
    """
    repository = IntelligenceRepository.from_settings(get_settings())
    started_at = datetime.now(UTC)
    # One resolution of the whole watchlist, reused for every role below.
    watchers_by_role = repository.watchers_by_role()
    role_ids = sorted(watchers_by_role, key=str)
    run_id = repository.start_agent_run(
        agent_name="scheduled_readiness_planning",
        purpose="Persist deterministic work-back plans for explicitly followed roles",
        input_fingerprint=sha256("|".join(map(str, role_ids)).encode()).hexdigest(),
    )
    planned = skipped = failures = 0
    for role_id in role_ids:
        role_started_at = datetime.now(UTC)
        try:
            # Only a current forecast is planned from: one the model has since declined is history.
            version = repository.current_forecast_version(role_id)
            if version is None:
                skipped += 1
                output: dict[str, Any] = {"result": "no_stored_forecast"}
            else:
                written = _plan_readiness_for_watchers(
                    repository,
                    role_id,
                    forecast=version.forecast,
                    forecast_id=version.id,
                    as_of=started_at.date(),
                    watchers=watchers_by_role.get(role_id, ()),
                )
                planned += written
                output = {"result": "plans_written", "readiness_plans_written": written}
            repository.record_tool_call(
                run_id,
                tool_name="readiness.plan_for_watchers",
                status="succeeded",
                input_redacted={"role_id": str(role_id)},
                output_redacted=output,
                started_at=role_started_at,
            )
        except Exception as exc:  # noqa: BLE001 - roles are planned independently
            failures += 1
            repository.record_tool_call(
                run_id,
                tool_name="readiness.plan_for_watchers",
                status="failed",
                input_redacted={"role_id": str(role_id)},
                output_redacted={},
                started_at=role_started_at,
                error={"type": type(exc).__name__, "message": redact_sensitive_text(exc)},
            )
    status = "succeeded" if failures == 0 else "failed" if failures == len(role_ids) else "partial"
    repository.finish_agent_run(run_id, status=status)
    print(
        json.dumps(
            {
                "watched_roles": len(role_ids),
                "readiness_plans_written": planned,
                "roles_without_forecast": skipped,
                "failures": failures,
                "status": status,
                "run_id": str(run_id),
            },
            indent=2,
        )
    )
    return 1 if status == "failed" and role_ids else 0


def regenerate_changed_forecasts() -> int:
    repository = IntelligenceRepository.from_settings(get_settings())
    pipeline = "forecast_regeneration"
    cursor = repository.collection_checkpoint(pipeline)
    started_at = datetime.now(UTC)
    changed_role_ids = repository.changed_role_ids_since(cursor)
    # Only in-scope roles are forecast. Out-of-scope and unclassified roles stay as evidence and are
    # skipped here, which is most of the corpus.
    in_scope = repository.in_scope_role_ids()
    role_ids = [role_id for role_id in changed_role_ids if role_id in in_scope]
    out_of_scope_skipped = len(changed_role_ids) - len(role_ids)
    fingerprint = sha256(
        f"{cursor.isoformat() if cursor else 'initial'}|{'|'.join(map(str, role_ids))}".encode()
    ).hexdigest()
    run_id = repository.start_agent_run(
        agent_name="scheduled_forecast_regeneration",
        purpose="Regenerate forecasts only for roles with changed source evidence",
        input_fingerprint=fingerprint,
    )
    regenerated = unchanged = failures = plans_written = readiness_failures = insufficient = 0
    # The temporal evidence set and the watchlist are identical for every role in
    # this pass: regeneration writes forecasts, changes, and plans, none of which
    # feed either read. Loading them once turns a per-role full re-read of every
    # role, observation, match, event, and signal into a single load.
    #
    # A failed preload falls back to the per-role path rather than aborting the
    # run, so one transient read error still fails only the roles it affects and
    # the run is still finished and audited.
    dataset: BacktestDataset | None = None
    watchers_by_role: dict[UUID, list[UUID]] = {}
    if role_ids:
        try:
            dataset = repository.load_backtest_dataset()
            watchers_by_role = repository.watchers_by_role()
        except Exception as exc:  # noqa: BLE001 - preloading is an optimisation, not a precondition
            dataset = None
            preload_error = redact_sensitive_text(exc, limit=200)
            repository.record_tool_call(
                run_id,
                tool_name="forecast.preload_shared_evidence",
                status="failed",
                input_redacted={"roles_changed": len(role_ids)},
                output_redacted={"result": "falling_back_to_per_role_reads"},
                started_at=started_at,
                error={"type": type(exc).__name__, "message": preload_error},
            )
    for role_id in role_ids:
        role_started_at = datetime.now(UTC)
        try:
            forecast = repository.build_current_forecast(
                role_id, as_of=started_at.date(), dataset=dataset
            )
            previous = repository.latest_forecast_version(role_id)
            # Unchanged only against a current version: after a refusal, the same inputs as an old version still need a
            # new version for the role to have a forecast again.
            current = repository.current_forecast_version(role_id)
            output: dict[str, Any]
            if current and current.forecast.input_fingerprint == forecast.input_fingerprint:
                unchanged += 1
                output = {"result": "unchanged_input_fingerprint"}
            else:
                forecast_id = repository.save_agent_forecast_version(
                    role_id,
                    forecast,
                    as_of=started_at.date(),
                    supersedes_id=previous.id if previous else None,
                    recomputation_reason="changed_source_evidence",
                )
                regenerated += 1
                output = {
                    "result": "forecast_version_inserted",
                    "input_fingerprint": forecast.input_fingerprint,
                }
                # Readiness plans are a pure function of the committed forecast and
                # can be re-derived, so a planning failure is reported without
                # discarding the forecast version or blocking the cursor.
                try:
                    planned = _plan_readiness_for_watchers(
                        repository,
                        role_id,
                        forecast=forecast,
                        forecast_id=forecast_id,
                        as_of=started_at.date(),
                        watchers=watchers_by_role.get(role_id, ()),
                    )
                    plans_written += planned
                    output["readiness_plans_written"] = planned
                except Exception as exc:  # noqa: BLE001 - readiness is downstream of the forecast
                    readiness_failures += 1
                    output["readiness_error"] = redact_sensitive_text(exc, limit=200)
            repository.record_tool_call(
                run_id,
                tool_name="forecast.regenerate_changed_role",
                status="succeeded",
                input_redacted={"role_id": str(role_id)},
                output_redacted=output,
                started_at=role_started_at,
            )
        except InsufficientEvidenceError as exc:
            # Too little history and no sourced prior is honest output, not a failure: the role is
            # recorded as skipped and must not hold the cursor back for every later run. The refusal is recorded on
            # the role, so a forecast it held before stops being shown as current (migration 202608140043).
            insufficient += 1
            repository.record_forecast_refusal(role_id, reason=str(exc), at=role_started_at)
            repository.record_tool_call(
                run_id,
                tool_name="forecast.regenerate_changed_role",
                status="succeeded",
                input_redacted={"role_id": str(role_id)},
                output_redacted={"result": "insufficient_evidence", "reason": str(exc)[:300]},
                started_at=role_started_at,
            )
        except Exception as exc:  # noqa: BLE001 - roles are regenerated independently
            failures += 1
            repository.record_tool_call(
                run_id,
                tool_name="forecast.regenerate_changed_role",
                status="failed",
                input_redacted={"role_id": str(role_id)},
                output_redacted={},
                started_at=role_started_at,
                error={"type": type(exc).__name__, "message": redact_sensitive_text(exc)},
            )
    status = "succeeded" if failures == 0 else "failed" if failures == len(role_ids) else "partial"
    repository.finish_agent_run(run_id, status=status)
    cursor_advanced = failures == 0
    if cursor_advanced:
        repository.save_collection_checkpoint(
            pipeline,
            cursor_at=started_at,
            run_id=run_id,
            status=status,
            metadata={
                "roles_changed": len(changed_role_ids),
                "out_of_scope_skipped": out_of_scope_skipped,
                "regenerated": regenerated,
                "unchanged": unchanged,
                "insufficient_evidence": insufficient,
            },
        )
    print(
        json.dumps(
            {
                "roles_changed": len(changed_role_ids),
                "out_of_scope_skipped": out_of_scope_skipped,
                "forecasts_regenerated": regenerated,
                "unchanged_input_fingerprints": unchanged,
                "insufficient_evidence": insufficient,
                "readiness_plans_written": plans_written,
                "readiness_failures": readiness_failures,
                "failures": failures,
                "cursor_advanced": cursor_advanced,
                "status": status,
                "run_id": str(run_id),
            },
            indent=2,
        )
    )
    return 1 if status == "failed" and role_ids else 0


def run_discovery(company: str, *, ingest: bool) -> int:
    settings = get_settings()
    repository = IntelligenceRepository.from_settings(settings)
    known = repository.company_by_query(company)
    hold = repository.company_hold(UUID(str(known["id"]))) if known else None
    if known and hold:
        # A company that asked to be left alone is not fetched at all (docs/takedown.md). The save refuses it too, for a
        # query that only discovery can resolve to its domain.
        refusal = {"status": "refused", "reason": "company_collection_held", "domain": known["domain"], "hold": hold}
        print(json.dumps(refusal, indent=2))
        return 1
    transport = UrlLibTransport(settings)
    started_at = datetime.now(UTC)
    fingerprint = sha256(company.casefold().strip().encode()).hexdigest()
    run_id = repository.start_agent_run(
        agent_name="recruiting_source_discovery",
        purpose=f"Identify {company} and discover its recruiting sources",
        input_fingerprint=fingerprint,
    )
    router = ModelRouter.from_settings(settings, tracker=repository)
    llm_resolver = LlmIdentityResolver(router.client("reason", agent_run_id=run_id))
    tool = DiscoverRecruitingSources(IdentifyCompany(transport, llm=llm_resolver), transport)
    try:
        discovery = tool.run(company)
        configs = repository.save_company_discovery(discovery)
        repository.record_tool_call(
            run_id,
            tool_name="DiscoverRecruitingSources",
            status="succeeded",
            input_redacted={"company_query": company},
            output_redacted={
                "company_id": str(discovery.identity.id),
                "domain": discovery.identity.domain,
                "sources": len(discovery.sources),
                "ats_provider": discovery.identity.ats_provider,
            },
            started_at=started_at,
        )
        failures = 0
        if ingest:
            service = SourceIngestionService(
                AdapterRegistry.with_fallbacks(router.client("extract", agent_run_id=run_id)),
                transport,
                repository,
                agent_run_id=run_id,
            )
            for source in configs:
                try:
                    service.ingest(source, observed_at=datetime.now(UTC))
                except Exception:  # noqa: BLE001 - discovery remains useful if one source fails
                    failures += 1
        repository.finish_agent_run(run_id, status="succeeded" if failures == 0 else "partial")
        print(
            json.dumps(
                {
                    "company": discovery.identity.model_dump(mode="json"),
                    "sources": [source.model_dump(mode="json") for source in discovery.sources],
                    "rejected_sources": [source.model_dump(mode="json") for source in discovery.rejected_sources],
                    "ingested": ingest,
                    "ingestion_failures": failures,
                },
                indent=2,
            )
        )
        return 0
    except Exception as exc:  # noqa: BLE001 - top-level tool failures must be audited and reported
        repository.record_tool_call(
            run_id,
            tool_name="DiscoverRecruitingSources",
            status="failed",
            input_redacted={"company_query": company},
            output_redacted={},
            started_at=started_at,
            error={"type": type(exc).__name__, "message": redact_sensitive_text(exc)},
        )
        repository.finish_agent_run(
            run_id,
            status="failed",
            error={"type": type(exc).__name__, "message": redact_sensitive_text(exc)},
        )
        print(
            f"discovery_failed company={company} error={type(exc).__name__}: "
            f"{redact_sensitive_text(exc)}"
        )
        return 1


GREENHOUSE_TENANT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}")


def run_ats_board_registration(company_domain: str, tenant: str) -> int:
    """Register a Greenhouse board that discovery could not observe on the company's own pages.

    A tenant is accepted only from an observed ATS URL or an official structured endpoint,
    never from a company name alone. The operator supplies the tenant, and it is accepted only
    when Greenhouse's own board metadata endpoint names this company. That response is stored as
    the source's `structured_metadata` provenance; anything else is refused and nothing is saved.
    """

    def report(payload: dict[str, Any], code: int) -> int:
        print(json.dumps(payload, indent=2))
        return code

    if not GREENHOUSE_TENANT.fullmatch(tenant):
        return report({"status": "refused", "reason": "invalid_tenant"}, 1)
    settings = get_settings()
    repository = IntelligenceRepository.from_settings(settings)
    company = repository.company_by_domain(company_domain)
    if company is None:
        return report({"status": "refused", "reason": "unknown_company", "domain": company_domain}, 1)

    company_id = UUID(str(company["id"]))
    company_name = str(company["name"])
    domain = str(company["domain"])
    if repository.company_hold(company_id) is not None:
        return report({"status": "refused", "reason": "company_collection_held", "domain": domain}, 1)
    metadata_url = f"https://boards-api.greenhouse.io/v1/boards/{tenant}"
    started_at = datetime.now(UTC)
    run_id = repository.start_agent_run(
        agent_name="ats_board_registration",
        purpose=f"Verify and register the Greenhouse board {tenant} for {domain}",
        input_fingerprint=sha256(f"greenhouse|{domain}|{tenant}".encode()).hexdigest(),
    )

    board_name = ""
    reason: str | None = None
    try:
        document = UrlLibTransport(settings).get(metadata_url, accept="application/json")
        if document.status >= 400:
            reason = "board_not_found"
        else:
            board_name = str(json.loads(document.text).get("name") or "").strip()
    except (OSError, ValueError) as exc:
        reason = f"board_metadata_unavailable: {type(exc).__name__}"

    if reason is None and not (board_name and board_names_company(board_name, company_name, domain)):
        reason = "board_name_mismatch"

    if reason is not None:
        repository.record_tool_call(
            run_id,
            tool_name="ats_board_registration.greenhouse",
            status="failed",
            input_redacted={"domain": domain, "tenant": tenant},
            output_redacted={"board_name": board_name[:200]},
            started_at=started_at,
            error={"type": "RegistrationRefused", "message": reason},
        )
        repository.finish_agent_run(run_id, status="failed", error={"type": "RegistrationRefused", "message": reason})
        return report(
            {"status": "refused", "reason": reason, "domain": domain, "tenant": tenant, "board_name": board_name},
            1,
        )

    board_url = _canonical_url(f"https://boards.greenhouse.io/{tenant}")
    source = DiscoveredSource(
        id=uuid5(company_id, board_url),
        company_id=company_id,
        url=HttpUrl(board_url),
        category="ats",
        adapter="greenhouse",
        external_key=tenant,
        trust_score=0.95,
        evidence=[
            DiscoveryEvidence(
                method="structured_metadata",
                evidence_url=HttpUrl(metadata_url),
                quote=f'Greenhouse board metadata at {metadata_url} names the board "{board_name}".',
                metadata={"board_name": board_name, "verified_at": started_at.isoformat()},
            )
        ],
    )
    configs = repository.save_discovered_sources(company_id, company_name, [source])
    repository.record_tool_call(
        run_id,
        tool_name="ats_board_registration.greenhouse",
        status="succeeded",
        input_redacted={"domain": domain, "tenant": tenant},
        output_redacted={"board_name": board_name[:200], "source_id": str(configs[0].id)},
        started_at=started_at,
    )
    repository.finish_agent_run(run_id, status="succeeded")
    return report(
        {
            "status": "registered",
            "domain": domain,
            "adapter": "greenhouse",
            "tenant": tenant,
            "board_name": board_name,
            "source_id": str(configs[0].id),
        },
        0,
    )


def show_inference_metrics(run_id: str | None) -> int:
    repository = IntelligenceRepository.from_settings(get_settings())
    parsed_run_id = UUID(run_id) if run_id else None
    print(json.dumps(repository.list_inference_metrics(parsed_run_id), indent=2))
    return 0


def re_resolve_role_identities(company: str | None, *, apply: bool, show: int) -> int:
    """Split canonical roles whose observed titles state more than one early-career type.

    Without `--apply` nothing is written: it prints what it would do. Merges this rule cannot decide
    — two disciplines at the same type, a specialization split, senior beside junior — are counted
    under `unsplit_merges` and left exactly as they are.
    """
    settings = get_settings()
    repository = IntelligenceRepository.from_settings(settings)
    company_ids: list[UUID | None] = (
        [None]
        if company is None
        else sorted({source.company_id for source in repository.list_source_configs(company)}, key=str)
    )
    run_id = repository.start_agent_run(
        agent_name="role_identity_re_resolution",
        purpose=f"Re-key merged canonical roles for {company or 'all companies'}",
        input_fingerprint=sha256(f"{RESOLVER_VERSION}|{company or 'all'}|{apply}".encode()).hexdigest(),
    )
    service = RoleIdentityMigrationService(repository)
    started = monotonic()
    summary = RoleIdentitySummary()
    plans: list[RoleIdentityPlan] = []
    for company_id in company_ids:
        part, part_plans = service.run(company_id, apply=apply)
        summary.roles_examined += part.roles_examined
        summary.roles_split += part.roles_split
        summary.roles_created += part.roles_created
        summary.observations_moved += part.observations_moved
        summary.unsplit_merges += part.unsplit_merges
        summary.failures += part.failures
        for name, count in part.by_company.items():
            summary.by_company[name] += count
        plans.extend(part_plans)
    status = "partial" if summary.failures else "succeeded"
    repository.finish_agent_run(run_id, status=status)
    for plan in plans[:show]:
        print(f"\n{plan.company} — {plan.canonical_title}")
        for split in (plan.keeps, *plan.moves):
            kept = " (keeps the role)" if split is plan.keeps else ""
            print(
                f"    {', '.join(sorted(split.stated_types)) or 'none stated':<24}"
                f"{len(split.observation_ids):>4} observations{kept}  {split.title}"
            )
    print(
        json.dumps(
            {
                **summary.as_dict(),
                "applied": apply,
                "resolver_version": RESOLVER_VERSION,
                "elapsed_ms": round((monotonic() - started) * 1000),
                "status": status,
                "run_id": str(run_id),
            },
            indent=2,
        )
    )
    return 0 if not summary.failures else 1


def run_scope_classification(company: str | None) -> int:
    """Classify canonical roles into product scope from their stored titles and ATS categories."""
    settings = get_settings()
    repository = IntelligenceRepository.from_settings(settings)
    company_ids: list[UUID | None] = (
        [None] if company is None else sorted({source.company_id for source in repository.list_source_configs(company)}, key=str)
    )
    run_id = repository.start_agent_run(
        agent_name="role_scope_classification",
        purpose=f"Classify canonical roles into product scope for {company or 'all companies'}",
        input_fingerprint=sha256(f"{SCOPE_CLASSIFIER_VERSION}|{company or 'all'}".encode()).hexdigest(),
    )
    router = ModelRouter.from_settings(settings, tracker=repository)
    service = RoleScopeService(
        repository, RoleScopeClassifier(LlmScopeClassifier(router.client("classify", agent_run_id=run_id)))
    )
    started = monotonic()
    summary = RoleScopeSummary()
    for company_id in company_ids:
        summary.absorb(service.classify(company_id))
    status = (
        "failed" if summary.roles and summary.failures == summary.roles else "partial" if summary.failures else "succeeded"
    )
    repository.finish_agent_run(run_id, status=status)
    print(
        json.dumps(
            {
                **summary.as_dict(),
                "classifier_version": SCOPE_CLASSIFIER_VERSION,
                "elapsed_ms": round((monotonic() - started) * 1000),
                "status": status,
                "run_id": str(run_id),
            },
            indent=2,
        )
    )
    return 1 if status == "failed" else 0


def list_scope_review_queue(company: str | None, reason: str | None, limit: int) -> int:
    """Print the ambiguous roles with the evidence that made each one ambiguous."""
    repository = IntelligenceRepository.from_settings(get_settings())
    company_ids = (
        None if company is None else sorted({source.company_id for source in repository.list_source_configs(company)}, key=str)
    )
    if company_ids == []:
        print(f"error: no configured company matches {company!r}", file=sys.stderr)
        return 2
    print(render_queue(ScopeReviewService(repository).queue(company_ids, reason), max(limit, 1)))
    return 0


def record_scope_decision(args: argparse.Namespace) -> int:
    """Record a person's scope decision on one role, and add it to the labeled cases."""
    reviewer = args.reviewer or os.environ.get("FIRSTSEEN_REVIEWER", "")
    if not reviewer.strip():
        print("error: name who is deciding with --reviewer or FIRSTSEEN_REVIEWER. Nothing was recorded.", file=sys.stderr)
        return 2
    try:
        decision = ScopeDecision(
            status="in_scope" if args.in_scope else "out_of_scope",
            reason="in_scope" if args.in_scope else args.out_of_scope,
            discipline=args.discipline,
            early_career_type=args.early_career_type,
            basis=args.basis,
            note=args.note,
            reviewer=reviewer,
        )
    except ValueError as error:
        errors = error.errors() if isinstance(error, ValidationError) else []
        details = "; ".join(str(item["msg"]).removeprefix("Value error, ") for item in errors)
        print(f"error: {details or error}. Nothing was recorded.", file=sys.stderr)
        return 2
    repository = IntelligenceRepository.from_settings(get_settings())
    try:
        outcome = ScopeReviewService(repository, args.fixtures).decide(args.role_id, decision)
    except ScopeReviewError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    print(json.dumps(outcome.as_dict(), indent=2))
    if not outcome.rules_agree:
        print(
            f"The rules do not yet reach this decision from these titles, so worker/tests/test_role_scope.py fails on "
            f"{outcome.fixture_case_id} until a rule does. Teach the rule, run the tests, then `firstseen classify-roles --all`.",
            file=sys.stderr,
        )
    return 0


def run_backtest(*, cutoff_days: int, from_year: int | None, to_year: int | None) -> int:
    repository = IntelligenceRepository.from_settings(get_settings())
    roles, events, signals = repository.load_backtest_dataset()
    result = BacktestRunner().run(
        roles,
        events,
        signals,
        cutoff_days=cutoff_days,
        from_year=from_year,
        to_year=to_year,
        target_role_ids={str(role_id) for role_id in repository.in_scope_role_ids()},
    )
    repository.save_backtest_run(result)
    print(result.to_json())
    return 0


def run_signal_ingestion(company: str | None) -> int:
    settings = get_settings()
    repository = IntelligenceRepository.from_settings(settings)
    sources = [
        source
        for source in repository.list_source_configs(company)
        if source.adapter in {"generic", "rss", "sitemap", "reddit"}
        # The same recruiting-path rule as collection (recruiting_paths.py): a page off a recruiting path is no signal.
        and page_source_allowed(source.adapter, str(source.url))
    ]
    fingerprint = sha256("|".join(sorted(str(source.id) for source in sources)).encode()).hexdigest()
    run_id = repository.start_agent_run(
        agent_name="recruiting_signal_ingestion",
        purpose=f"Collect supporting recruiting signals for {company or 'all configured companies'}",
        input_fingerprint=fingerprint,
    )
    service = RecruitingSignalIngestionService(repository, UrlLibTransport(settings))
    reddit_client = RedditDataApiClient(settings) if settings.reddit_api_enabled else None
    reddit_llm = (
        ModelRouter.from_settings(settings, tracker=repository).client("extract", agent_run_id=run_id)
        if settings.reddit_llm_extraction_enabled
        else None
    )
    versioner = SignalForecastVersionService(repository)
    created = recomputed = material = failures = insufficient_roles = unchanged_versions = 0
    skipped: dict[str, int] = {}
    for source in sources:
        started_at = datetime.now(UTC)
        try:
            if source.adapter == "reddit":
                if reddit_client is None:
                    repository.record_tool_call(
                        run_id,
                        tool_name="recruiting_signal.reddit",
                        status="succeeded",
                        input_redacted={"source_id": str(source.id)},
                        output_redacted={"reason": "reddit_api_disabled"},
                        started_at=started_at,
                    )
                    continue
                configured_communities = source.options.get("communities")
                communities = (
                    tuple(str(item) for item in configured_communities)
                    if isinstance(configured_communities, list)
                    else settings.reddit_community_allowlist()
                )
                configured_aliases = source.options.get("company_aliases")
                aliases = (
                    tuple(str(item) for item in configured_aliases)
                    if isinstance(configured_aliases, list)
                    else ()
                )
                summary = service.ingest_social(
                    source,
                    RedditSignalAdapter(
                        reddit_client,
                        communities=communities,
                        company_aliases=aliases,
                        llm=reddit_llm,
                    ),
                    observed_at=started_at,
                )
            else:
                summary = service.ingest(source, observed_at=started_at)
            if summary.skipped:
                skipped[summary.skipped] = skipped.get(summary.skipped, 0) + 1
            created += summary.created
            changes: list[dict[str, object]] = []
            if summary.signal_ids:
                for role_id in summary.affected_role_ids:
                    try:
                        forecast = repository.build_current_forecast(role_id, as_of=started_at.date())
                    except InsufficientEvidenceError:
                        # A company-scoped signal reaches roles that cannot be forecast yet; that
                        # skips the role, it does not fail the source.
                        insufficient_roles += 1
                        changes.append({"role_id": str(role_id), "skipped": "insufficient_evidence"})
                        continue
                    change = versioner.persist_recomputed(
                        role_id, forecast, trigger_signal_ids=summary.signal_ids
                    )
                    if versioner.last_outcome == "unchanged":
                        unchanged_versions += 1
                        changes.append({"role_id": str(role_id), "skipped": "unchanged_input_fingerprint"})
                        continue
                    recomputed += 1
                    if change and change.material:
                        material += 1
                    changes.append(
                        {
                            "role_id": str(role_id),
                            "material": change.material if change else None,
                            "confidence_delta": change.confidence_delta if change else None,
                        }
                    )
            repository.record_tool_call(
                run_id,
                tool_name=f"recruiting_signal.{source.adapter}",
                status="succeeded",
                input_redacted={"source_id": str(source.id)},
                output_redacted={
                    "detected": summary.detected,
                    "created": summary.created,
                    "affected_roles": len(summary.affected_role_ids),
                    "forecast_changes": changes,
                    "skipped": summary.skipped,
                },
                started_at=started_at,
            )
        except Exception as exc:  # noqa: BLE001 - source failures remain isolated and audited
            failures += 1
            repository.record_tool_call(
                run_id,
                tool_name=f"recruiting_signal.{source.adapter}",
                status="failed",
                input_redacted={"source_id": str(source.id)},
                output_redacted={},
                started_at=started_at,
                error={"type": type(exc).__name__, "message": redact_sensitive_text(exc)},
            )
    status = "succeeded" if failures == 0 else "failed" if failures == len(sources) else "partial"
    repository.finish_agent_run(run_id, status=status)
    print(
        json.dumps(
            {
                "sources": len(sources),
                "signals_created": created,
                "forecasts_recomputed": recomputed,
                "material_forecast_changes": material,
                "insufficient_evidence_roles": insufficient_roles,
                "unchanged_input_fingerprints": unchanged_versions,
                "skipped_sources": skipped,
                "failures": failures,
                "status": status,
            },
            indent=2,
        )
    )
    return 1 if status == "failed" and sources else 0


def _regenerate_after_withdrawal(repository: IntelligenceRepository, company_id: UUID) -> dict[str, Any]:
    """Re-forecast every other role whose latest forecast cited the withdrawn company.

    The withdrawal has already made the company's roles inactive, so `load_backtest_dataset` leaves their evidence out and
    each new version is computed without it. Older versions stay, as every forecast version does. A role the model can no
    longer forecast keeps its last version and is listed, for the operator to see (docs/takedown.md).
    """
    started_at = datetime.now(UTC)
    role_ids = repository.roles_whose_latest_forecast_cites(company_id)
    run_id = repository.start_agent_run(
        agent_name="withdrawal_forecast_regeneration",
        purpose="Re-forecast roles whose latest forecast cited a withdrawn company",
        input_fingerprint=sha256(f"{company_id}|{'|'.join(map(str, role_ids))}".encode()).hexdigest(),
    )
    dataset = repository.load_backtest_dataset() if role_ids else None
    watchers = repository.watchers_by_role() if role_ids else {}
    regenerated = unchanged = failures = 0
    still_citing: list[str] = []
    for role_id in role_ids:
        role_started_at = datetime.now(UTC)
        try:
            forecast = repository.build_current_forecast(role_id, as_of=started_at.date(), dataset=dataset)
            previous = repository.latest_forecast_version(role_id)
            current = repository.current_forecast_version(role_id)
            if current and current.forecast.input_fingerprint == forecast.input_fingerprint:
                unchanged += 1
                output: dict[str, Any] = {"result": "unchanged_input_fingerprint"}
            else:
                forecast_id = repository.save_agent_forecast_version(
                    role_id,
                    forecast,
                    as_of=started_at.date(),
                    supersedes_id=previous.id if previous else None,
                    recomputation_reason="company_withdrawn",
                )
                regenerated += 1
                output = {"result": "forecast_version_inserted", "input_fingerprint": forecast.input_fingerprint}
                output["readiness_plans_written"] = _plan_readiness_for_watchers(
                    repository, role_id, forecast=forecast, forecast_id=forecast_id,
                    as_of=started_at.date(), watchers=watchers.get(role_id, ()),
                )
            status = "succeeded"
        except InsufficientEvidenceError as exc:
            # Without the company the model declines the role: its forecast, which cited the company, stops being
            # current and is no longer shown anywhere (migration 202608140043).
            repository.record_forecast_refusal(role_id, reason=str(exc), at=role_started_at)
            still_citing.append(str(role_id))
            output, status = {"result": "insufficient_evidence", "reason": str(exc)[:300]}, "succeeded"
        except Exception as exc:  # noqa: BLE001 - roles are re-forecast independently
            failures += 1
            still_citing.append(str(role_id))
            output, status = {"error": type(exc).__name__, "message": redact_sensitive_text(exc, limit=300)}, "failed"
        repository.record_tool_call(
            run_id,
            tool_name="forecast.regenerate_after_withdrawal",
            status=status,
            input_redacted={"role_id": str(role_id), "company_id": str(company_id)},
            output_redacted=output,
            started_at=role_started_at,
        )
    repository.finish_agent_run(run_id, status="partial" if failures else "succeeded")
    return {
        "roles_citing_company": len(role_ids),
        "forecasts_regenerated": regenerated,
        "unchanged_input_fingerprints": unchanged,
        "failures": failures,
        # Their latest forecast still lists the company's evidence: too little else to forecast from, or a failure.
        "still_citing_withdrawn_company": still_citing,
        "run_id": str(run_id),
    }


def run_takedown_command(args: argparse.Namespace) -> int:
    """`sources disable|enable|show` and `withdraw-company` (docs/takedown.md). Each change is one audited transaction."""
    repository = IntelligenceRepository.from_settings(get_settings())
    service = TakedownService(repository)
    requested_by = getattr(args, "by", None) or os.environ.get("FIRSTSEEN_REVIEWER", "")
    try:
        if args.command == "withdraw-company":
            result = service.withdraw(
                company_domain=args.domain, reason=args.reason, requested_by=requested_by, apply=args.apply
            )
            if args.apply:
                # The withdrawal is committed; the company's postings must also leave other roles' provenance.
                result["regeneration"] = _regenerate_after_withdrawal(repository, UUID(result["company"]["id"]))
        elif args.sources_command == "show":
            result = service.show(args.company)
        else:
            act = service.disable if args.sources_command == "disable" else service.enable
            result = act(company_domain=args.company, source_id=args.source, reason=args.reason, requested_by=requested_by)
    except TakedownRefused as refusal:
        print(json.dumps({"status": "refused", "reason": refusal.reason, "message": str(refusal)}, indent=2))
        return 1
    except APIError as error:
        # The transaction refused it (a hold changed underneath, or a constraint): nothing was changed.
        print(json.dumps({"status": "refused", "reason": "database_refused", "message": error.message}, indent=2))
        return 1
    print(json.dumps(result, indent=2, default=str))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="1stSeen recruiting source ingestion")
    subparsers = parser.add_subparsers(dest="command")
    subparsers.add_parser("dry-run", help="Validate local worker configuration")
    ingest = subparsers.add_parser("ingest", help="Ingest configured recruiting sources")
    scope = ingest.add_mutually_exclusive_group(required=True)
    scope.add_argument("--company", help="Company name, domain, or UUID")
    scope.add_argument("--all", action="store_true", help="Ingest all enabled companies")
    ingest.add_argument(
        "--collection",
        choices=("all", "current", "historical"),
        default="all",
        help="Limit collection to current recruiting sources or Wayback enrichment",
    )
    discover = subparsers.add_parser("discover", help="Discover and persist recruiting sources")
    discover.add_argument("--company", required=True, help="Official domain or company name")
    discover.add_argument("--ingest", action="store_true", help="Immediately ingest every discovered source")
    register = subparsers.add_parser(
        "register-ats-board",
        help="Register a Greenhouse board after its official metadata endpoint confirms the company",
    )
    register.add_argument("--company", required=True, help="Exact domain of an already discovered company")
    register.add_argument("--tenant", required=True, help="Greenhouse board token")
    metrics = subparsers.add_parser(
        "metrics", help="Show admin-ready deterministic inference efficiency metrics"
    )
    metrics.add_argument("--run-id", help="Limit metrics to one agent run UUID")
    backtest = subparsers.add_parser(
        "backtest", help="Run leakage-safe rolling historical forecast evaluation"
    )
    backtest.add_argument(
        "--cutoff-days",
        type=int,
        default=60,
        help="Days before each actual opening at which the forecast is reconstructed",
    )
    backtest.add_argument("--from-year", type=int, help="First target opening year")
    backtest.add_argument("--to-year", type=int, help="Last target opening year")
    signal_parser = subparsers.add_parser(
        "signals", help="Collect supporting recruiting signals and version affected forecasts"
    )
    signal_scope = signal_parser.add_mutually_exclusive_group(required=True)
    signal_scope.add_argument("--company", help="Company name, domain, or UUID")
    signal_scope.add_argument("--all", action="store_true", help="Process all configured companies")
    enrich_parser = subparsers.add_parser(
        "enrich",
        help="Derive canonical roles and historical openings from already-collected evidence",
    )
    enrich_scope = enrich_parser.add_mutually_exclusive_group(required=True)
    enrich_scope.add_argument("--company", help="Company name, domain, or UUID")
    enrich_scope.add_argument("--all", action="store_true", help="Process all configured companies")
    classify_parser = subparsers.add_parser(
        "classify-roles",
        help="Classify canonical roles into product scope: early-career technical programs only",
    )
    classify_scope = classify_parser.add_mutually_exclusive_group(required=True)
    classify_scope.add_argument("--company", help="Company name, domain, or UUID")
    classify_scope.add_argument("--all", action="store_true", help="Classify every canonical role")
    review_parser = subparsers.add_parser(
        "review-scope",
        help="List roles the scope classifier left ambiguous, or record a person's decision on one",
    )
    review_commands = review_parser.add_subparsers(dest="review_command", required=True)
    review_list = review_commands.add_parser("list", help="Show each ambiguous role with the evidence behind it")
    review_list.add_argument("--company", help="Company name, domain, or UUID")
    review_list.add_argument("--reason", choices=AMBIGUOUS_REASONS, help="Only roles ambiguous for this reason")
    review_list.add_argument("--limit", type=int, default=20, help="Roles to show (default 20)")
    review_decide = review_commands.add_parser(
        "decide", help="Record a decision as stated evidence and add the role to the labeled cases"
    )
    review_decide.add_argument("role_id", type=UUID, help="The role id printed by `review-scope list`")
    review_outcome = review_decide.add_mutually_exclusive_group(required=True)
    review_outcome.add_argument("--in-scope", action="store_true", help="An early-career role in a listed discipline")
    review_outcome.add_argument("--out-of-scope", choices=OUT_OF_SCOPE_REASONS, metavar="REASON", help=", ".join(OUT_OF_SCOPE_REASONS))
    review_decide.add_argument("--discipline", choices=DISCIPLINES, help="Required with --in-scope")
    review_decide.add_argument("--type", dest="early_career_type", choices=EARLY_CAREER_TYPES, help="Required with --in-scope; an exclusion keeps the type the rules found unless given")
    review_decide.add_argument(
        "--basis",
        choices=REVIEW_BASES,
        required=True,
        help="titles: the titles and ATS filing decide it, so the rules should learn it; posting: the posting itself was needed",
    )
    review_decide.add_argument("--note", required=True, help="Why, in a sentence; stored with the decision")
    review_decide.add_argument("--reviewer", help="Who is deciding (default: FIRSTSEEN_REVIEWER)")
    review_decide.add_argument("--fixtures", type=Path, default=DEFAULT_FIXTURES, help="The labeled cases file (default: this checkout's)")
    identity_parser = subparsers.add_parser(
        "re-resolve-roles",
        help="Split canonical roles that merged two programs, under the current identity rules",
    )
    identity_scope = identity_parser.add_mutually_exclusive_group(required=True)
    identity_scope.add_argument("--company", help="Company name, domain, or UUID")
    identity_scope.add_argument("--all", action="store_true", help="Examine every active canonical role")
    identity_parser.add_argument(
        "--apply", action="store_true", help="Perform the splits; without it nothing is written"
    )
    identity_parser.add_argument(
        "--show", type=int, default=0, help="Also print this many planned splits in full"
    )
    subparsers.add_parser(
        "regenerate-forecasts",
        help="Regenerate only roles whose persisted source evidence changed since the last clean pass",
    )
    subparsers.add_parser(
        "plan-readiness",
        help="Persist deterministic work-back plans for every explicitly followed role",
    )
    sources_parser = subparsers.add_parser(
        "sources", help="Stop or resume collection from one source or a whole company (docs/takedown.md)"
    )
    sources_commands = sources_parser.add_subparsers(dest="sources_command", required=True)
    for name, text in (
        ("disable", "Stop collecting from a source, or from every source of a company"),
        ("enable", "Resume a source, or lift a company-wide stop or withdrawal"),
    ):
        takedown_parser = sources_commands.add_parser(name, help=text)
        takedown_target = takedown_parser.add_mutually_exclusive_group(required=True)
        takedown_target.add_argument("--company", help="Exact domain of the company")
        takedown_target.add_argument("--source", type=UUID, help="One source id, from `sources show`")
        takedown_parser.add_argument("--reason", required=True, help="Why, in a sentence; stored with the action")
        takedown_parser.add_argument("--by", help="Who is acting (default: FIRSTSEEN_REVIEWER)")
    sources_show = sources_commands.add_parser(
        "show", help="A company's sources, whether its collection is held, and every takedown action on it"
    )
    sources_show.add_argument("--company", required=True, help="Exact domain of the company")
    withdraw_parser = subparsers.add_parser(
        "withdraw-company",
        help="Stop collecting a company and take its roles off the product; deletes nothing. Dry run unless --apply",
    )
    withdraw_parser.add_argument("domain", help="Exact domain of the company")
    withdraw_parser.add_argument("--reason", required=True, help="Why, in a sentence; stored with the action")
    withdraw_parser.add_argument("--by", help="Who is acting (default: FIRSTSEEN_REVIEWER); required with --apply")
    withdraw_parser.add_argument("--apply", action="store_true", help="Withdraw; without it nothing is written")
    args = parser.parse_args()
    if args.command in {"sources", "withdraw-company"}:
        return run_takedown_command(args)
    if args.command == "ingest":
        return run_ingestion(args.company if not args.all else None, collection=args.collection)
    if args.command == "discover":
        return run_discovery(args.company, ingest=args.ingest)
    if args.command == "register-ats-board":
        return run_ats_board_registration(args.company, args.tenant)
    if args.command == "metrics":
        return show_inference_metrics(args.run_id)
    if args.command == "backtest":
        return run_backtest(
            cutoff_days=args.cutoff_days,
            from_year=args.from_year,
            to_year=args.to_year,
        )
    if args.command == "signals":
        return run_signal_ingestion(args.company if not args.all else None)
    if args.command == "enrich":
        return run_enrichment(args.company if not args.all else None)
    if args.command == "classify-roles":
        return run_scope_classification(args.company if not args.all else None)
    if args.command == "review-scope":
        if args.review_command == "list":
            return list_scope_review_queue(args.company, args.reason, args.limit)
        return record_scope_decision(args)
    if args.command == "re-resolve-roles":
        return re_resolve_role_identities(
            args.company if not args.all else None, apply=args.apply, show=args.show
        )
    if args.command == "regenerate-forecasts":
        return regenerate_changed_forecasts()
    if args.command == "plan-readiness":
        return plan_readiness_for_watchlists()
    settings = get_settings()
    print(f"environment={settings.environment} model={settings.llm_model} status=ok")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
