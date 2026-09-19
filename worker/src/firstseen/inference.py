"""Deterministic-first inference gates and admin-ready ingestion metrics."""

from __future__ import annotations

import re
from html import unescape
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

DeterministicRoute = Literal[
    "structured_endpoint",
    "json_ld",
    "embedded_data",
    "static_html",
    "playwright",
    "archive",
]
InferenceAction = Literal["not_required", "escalated", "suppressed"]
InferenceReason = Literal[
    "content_unchanged",
    "structured_source_parsed",
    "schema_extraction_succeeded",
    "html_extraction_succeeded",
    "archive_extraction_succeeded",
    "model_not_enabled",
    "explicitly_no_open_jobs",
    "insufficient_recruiting_evidence",
    "ambiguous_recruiting_content",
]
RoleInferenceReason = Literal[
    "stored_alias_match",
    "deterministic_match_confident",
    "no_compatible_canonical_mapping",
    "model_not_configured",
    "ambiguous_role_match",
]


class PageInferenceDecision(BaseModel):
    source_id: UUID
    source_url: str = Field(min_length=1)
    action: InferenceAction
    reason: InferenceReason
    page_changed: bool
    deterministic_route: str
    deterministic_job_count: int = Field(ge=0)
    llm_escalated: bool = False
    model_extraction_succeeded: bool = False
    model_fallback_used: bool = False
    details: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_escalation(self) -> PageInferenceDecision:
        if self.action == "escalated" and not self.llm_escalated:
            raise ValueError("escalated decisions must record an LLM escalation")
        if self.model_extraction_succeeded and not self.llm_escalated:
            raise ValueError("successful model extraction requires an LLM escalation")
        if self.model_fallback_used and not self.llm_escalated:
            raise ValueError("model fallback requires an LLM escalation")
        return self


class InferenceMetrics(BaseModel):
    pages_processed: int = Field(ge=0)
    pages_changed: int = Field(ge=0)
    deterministically_parsed: int = Field(ge=0)
    llm_escalations: int = Field(ge=0)
    llm_escalation_percentage: float = Field(ge=0, le=100)
    successful_model_extractions: int = Field(ge=0)
    fallback_frequency: float = Field(ge=0, le=100)

    @classmethod
    def from_decisions(cls, decisions: list[PageInferenceDecision]) -> InferenceMetrics:
        processed = len(decisions)
        changed = sum(decision.page_changed for decision in decisions)
        escalations = sum(decision.llm_escalated for decision in decisions)
        deterministic = sum(
            decision.action == "not_required"
            and decision.page_changed
            and decision.deterministic_job_count > 0
            for decision in decisions
        )
        successes = sum(decision.model_extraction_succeeded for decision in decisions)
        fallbacks = sum(decision.model_fallback_used for decision in decisions)
        return cls(
            pages_processed=processed,
            pages_changed=changed,
            deterministically_parsed=deterministic,
            llm_escalations=escalations,
            llm_escalation_percentage=round(100 * escalations / processed, 2) if processed else 0,
            successful_model_extractions=successes,
            fallback_frequency=round(100 * fallbacks / escalations, 2) if escalations else 0,
        )


class RoleInferenceDecision(BaseModel):
    action: InferenceAction
    reason: RoleInferenceReason
    llm_escalated: bool
    deterministic_best_score: float = Field(ge=0, le=1)
    deterministic_margin: float = Field(ge=0, le=1)

    @model_validator(mode="after")
    def validate_role_escalation(self) -> RoleInferenceDecision:
        if self.action == "escalated" and not self.llm_escalated:
            raise ValueError("escalated role decisions must record an LLM escalation")
        return self


ScopeInferenceReason = Literal[
    "deterministic_scope_decided",
    "not_discipline_ambiguity",
    "model_not_configured",
    "ambiguous_discipline",
]


class ScopeInferenceDecision(BaseModel):
    action: InferenceAction
    reason: ScopeInferenceReason
    llm_escalated: bool

    @model_validator(mode="after")
    def validate_scope_escalation(self) -> ScopeInferenceDecision:
        if (self.action == "escalated") != self.llm_escalated:
            raise ValueError("only an escalated scope decision records an LLM escalation")
        return self


class DeterministicFirstInferencePolicy:
    """Permit model extraction only for changed, plausibly recruiting-related ambiguity."""

    _recruiting_markers = re.compile(
        r"\b(?:apply|career|intern(?:ship)?|job|opening|position|requisition|role|vacanc(?:y|ies))\b",
        re.IGNORECASE,
    )
    _explicit_empty = re.compile(
        r"\b(?:no (?:current )?(?:jobs|openings|open positions)|positions? (?:are )?currently closed)\b",
        re.IGNORECASE,
    )

    @staticmethod
    def _visible_text(html: str) -> str:
        without_hidden = re.sub(
            r"<(?:script|style|noscript|template)\b[^>]*>.*?</(?:script|style|noscript|template)>",
            " ",
            html,
            flags=re.IGNORECASE | re.DOTALL,
        )
        return " ".join(unescape(re.sub(r"<[^>]+>", " ", without_hidden)).split())

    def should_escalate(
        self,
        html: str,
        *,
        deterministic_job_count: int,
        llm_enabled: bool,
    ) -> tuple[bool, InferenceReason, dict[str, Any]]:
        if deterministic_job_count:
            return False, "html_extraction_succeeded", {"deterministic_jobs": deterministic_job_count}
        if not llm_enabled:
            return False, "model_not_enabled", {}
        text = self._visible_text(html)
        if self._explicit_empty.search(text):
            return False, "explicitly_no_open_jobs", {"visible_characters": len(text)}
        markers = sorted({match.group(0).casefold() for match in self._recruiting_markers.finditer(text)})
        if not markers:
            return False, "insufficient_recruiting_evidence", {"visible_characters": len(text)}
        return (
            True,
            "ambiguous_recruiting_content",
            {
                "visible_characters": len(text),
                "recruiting_markers": markers[:12],
            },
        )

    @staticmethod
    def deterministic_reason(route: str, jobs: int) -> InferenceReason:
        if route == "structured_endpoint":
            return "structured_source_parsed"
        if route in {"json_ld", "embedded_data"}:
            return "schema_extraction_succeeded"
        if route == "archive":
            return "archive_extraction_succeeded"
        if jobs:
            return "html_extraction_succeeded"
        return "insufficient_recruiting_evidence"

    def summarize_result(
        self,
        *,
        source_id: UUID,
        source_url: str,
        route: str,
        unchanged: bool,
        jobs: int,
    ) -> PageInferenceDecision:
        if unchanged:
            return PageInferenceDecision(
                source_id=source_id,
                source_url=source_url,
                action="not_required",
                reason="content_unchanged",
                page_changed=False,
                deterministic_route=route,
                deterministic_job_count=0,
            )
        return PageInferenceDecision(
            source_id=source_id,
            source_url=source_url,
            action="not_required" if jobs else "suppressed",
            reason=self.deterministic_reason(route, jobs),
            page_changed=True,
            deterministic_route=route,
            deterministic_job_count=jobs,
        )

    @staticmethod
    def decide_role_resolution(
        *,
        best_score: float,
        margin: float,
        exact_alias: bool,
        has_compatible_candidate: bool,
        llm_enabled: bool,
    ) -> RoleInferenceDecision:
        if not has_compatible_candidate:
            return RoleInferenceDecision(
                action="not_required",
                reason="no_compatible_canonical_mapping",
                llm_escalated=False,
                deterministic_best_score=0,
                deterministic_margin=1,
            )
        if exact_alias:
            return RoleInferenceDecision(
                action="not_required",
                reason="stored_alias_match",
                llm_escalated=False,
                deterministic_best_score=best_score,
                deterministic_margin=margin,
            )
        ambiguous = 0.58 <= best_score <= 0.80 or margin < 0.10
        if not ambiguous:
            return RoleInferenceDecision(
                action="not_required",
                reason="deterministic_match_confident",
                llm_escalated=False,
                deterministic_best_score=best_score,
                deterministic_margin=margin,
            )
        if not llm_enabled:
            return RoleInferenceDecision(
                action="suppressed",
                reason="model_not_configured",
                llm_escalated=False,
                deterministic_best_score=best_score,
                deterministic_margin=margin,
            )
        return RoleInferenceDecision(
            action="escalated",
            reason="ambiguous_role_match",
            llm_escalated=True,
            deterministic_best_score=best_score,
            deterministic_margin=margin,
        )

    @staticmethod
    def decide_scope_classification(*, status: str, reason: str, llm_enabled: bool) -> ScopeInferenceDecision:
        """Permit a model only for a role whose discipline the rules found no evidence for.

        Decided roles never reach a model, and neither do conflicts or design and advocacy
        boundaries: those abstentions are for a reviewer, not a tiebreak.
        """
        if status != "ambiguous":
            return ScopeInferenceDecision(action="not_required", reason="deterministic_scope_decided", llm_escalated=False)
        if reason != "discipline_unknown":
            return ScopeInferenceDecision(action="not_required", reason="not_discipline_ambiguity", llm_escalated=False)
        if not llm_enabled:
            return ScopeInferenceDecision(action="suppressed", reason="model_not_configured", llm_escalated=False)
        return ScopeInferenceDecision(action="escalated", reason="ambiguous_discipline", llm_escalated=True)
