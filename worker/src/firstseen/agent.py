"""Observable recruiting-intelligence orchestration over typed evidence tools."""

from __future__ import annotations

import calendar
import re
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from hashlib import sha256
from typing import Any, Literal, Protocol, cast
from uuid import UUID

from pydantic import BaseModel, Field, HttpUrl, field_validator, model_validator

from .agent_intent import GoalIntentProposal, LlmGoalIntentInterpreter
from .agent_questions import (
    CompanyTimingItem,
    ConfidenceExplanationItem,
    ForecastChangeItem,
    PreparationItem,
    RoleForecastItem,
    UsefulQuestionIntent,
    UsefulQuestionResult,
    UsefulQuestionTools,
    basis_phrase,
    confidence_phrase,
    forecast_phrase,
)
from .cycles import derive_cycle_key, group_indices_into_cycles
from .forecast_currency import forecast_is_current, parse_timestamp
from .forecasting import Forecast, InsufficientEvidenceError
from .readiness import (
    ApplicationReadinessPlanner,
    CompanySize,
    ReadinessContext,
    ReadinessForecast,
    ReadinessPlan,
    ReadinessPlanStore,
)
from .repository import IntelligenceRepository, fetch_all_rows
from .role_resolution import identifying_title_tokens, question_tracks, title_level
from .security import redact_sensitive_text

ToolName = Literal[
    "discover_company",
    "get_current_jobs",
    "inspect_career_page",
    "get_role_history",
    "inspect_archives",
    "get_recruiting_signals",
    "resolve_role",
    "generate_forecast",
    "get_forecast_evidence",
    "create_readiness_plan",
    "answer_portfolio_question",
]
ProgressType = Literal[
    "run_started",
    "tool_started",
    "tool_completed",
    "evidence_assessed",
    "answer_completed",
    "run_failed",
]


class CompanyEntity(BaseModel):
    id: UUID
    name: str
    domain: str
    careers_url: HttpUrl | None = None
    company_size: CompanySize = "unknown"
    recruiting_scale: float = Field(default=0.5, ge=0, le=1)
    ats_provider: str | None = None


class RoleEntity(BaseModel):
    id: UUID
    company_id: UUID
    title: str
    track: str
    role_family: str
    recurrence_key: str
    role_competitiveness: float = Field(default=0.5, ge=0, le=1)
    portfolio_required: bool | None = None
    # One title is deliberately split by location and specialization; these tell the splits apart.
    location_scope: str | None = None
    specialization: str | None = None
    # False for a role outside 1stSeen's scope: it is named in the answer, never answered about.
    in_product_scope: bool = True


EVIDENCE_SUMMARY_MAX = 1_000
ROLE_CANDIDATES_SHOWN = 8


class EvidenceRef(BaseModel):
    id: str
    kind: Literal["job", "page", "history", "archive", "signal", "forecast"]
    source_url: HttpUrl
    observed_at: datetime
    content_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    summary: str = Field(min_length=1, max_length=EVIDENCE_SUMMARY_MAX)
    reliability: float = Field(ge=0, le=1)

    @field_validator("summary", mode="before")
    @classmethod
    def bound_summary(cls, value: object) -> object:
        # Summaries are display text drawn from stored pages, archives, and postings, which can
        # be far longer than the limit. An over-long one used to fail validation inside a tool
        # call and end the whole agent run (the intent evaluation found it on a Databricks archive capture).
        if isinstance(value, str) and len(value) > EVIDENCE_SUMMARY_MAX:
            return value[: EVIDENCE_SUMMARY_MAX - 1].rstrip() + "…"
        return value


class CurrentJob(BaseModel):
    observation_id: UUID
    title: str
    apply_url: HttpUrl
    location: str | None = None
    published_at: datetime | None = None
    first_seen_at: datetime
    last_seen_at: datetime
    evidence: EvidenceRef


class CareerPageInspection(BaseModel):
    source_id: UUID
    url: HttpUrl
    last_checked_at: datetime | None = None
    content_hash: str | None = None
    relevant_excerpt: str | None = None
    evidence: EvidenceRef | None = None


class RoleHistoryItem(BaseModel):
    event_id: UUID
    opened_on: date
    window_start: date | None
    window_end: date
    precision: Literal["exact", "bounded", "observed_by"]
    uncertainty_days: int | None
    evidence: EvidenceRef
    # The cohort the posting names ("summer-2026"), from cycles.derive_cycle_key; None when it names none.
    cycle_key: str | None = None


def recruiting_cycle_count(history: Sequence[RoleHistoryItem]) -> int:
    """How many recruiting cycles a role's openings span, grouped as forecasting groups them (cycles.py).

    Openings are postings: a program reposted four times in one season is one cycle, not four. Postings naming the
    same cohort are one cycle, and unkeyed openings less than 300 days apart are one.
    """
    ordered = sorted(history, key=lambda item: (item.opened_on, str(item.event_id)))
    return len(set(group_indices_into_cycles([(item.opened_on, item.cycle_key) for item in ordered])))


class ArchiveInspection(BaseModel):
    capture_id: UUID
    captured_at: datetime
    completeness: float = Field(ge=0, le=1)
    is_partial: bool
    evidence: EvidenceRef


class RecruitingSignalFact(BaseModel):
    signal_id: UUID
    signal_type: str
    observed_at: datetime
    strength: float = Field(ge=0, le=1)
    reliability: float = Field(ge=0, le=1)
    claimed_event_at: datetime | None = None
    evidence: EvidenceRef


class ForecastResult(BaseModel):
    forecast_id: UUID | None = None
    role_id: UUID
    as_of: date
    expected_opening_date: date
    interval_start: date
    interval_end: date
    confidence: float = Field(ge=0, le=100)
    calibrated_probability: float = Field(ge=0, le=1)
    model_version: str
    history_count: int = Field(ge=0)
    cached: bool
    # The forecast's persisted date weight from the program's own openings and from comparable programs, which is
    # what the product shows as the forecast's basis (apps/web/lib/forecast-basis.ts). None when not read.
    own_history_weight: float | None = Field(default=None, ge=0, le=1)
    borrowed_weight: float | None = Field(default=None, ge=0, le=1)


class ForecastEvidenceFact(BaseModel):
    forecast_id: UUID
    contribution: str
    weight: float = Field(ge=0, le=1)
    rationale: str
    evidence: EvidenceRef


class AgentToolCall(BaseModel):
    tool: ToolName
    status: Literal["succeeded", "failed"]
    started_at: datetime
    finished_at: datetime
    input_summary: dict[str, Any] = Field(default_factory=dict)
    result_summary: str


AgentAudience = Literal["member", "guest"]


class RecruitingAgentState(BaseModel):
    goal: str = Field(min_length=3, max_length=2_000)
    actor_id: UUID | None = None
    # A guest asks without an account: no user-scoped answer and no readiness plan.
    audience: AgentAudience = "member"
    # The role a role page asked about, so a title shared by two programs still resolves to one.
    selected_role_id: UUID | None = None
    resolved_entities: dict[str, CompanyEntity | RoleEntity] = Field(default_factory=dict)
    known_facts: list[str] = Field(default_factory=list)
    unresolved_questions: list[str] = Field(default_factory=list)
    role_candidates: list[RoleEntity] = Field(default_factory=list)
    out_of_scope_roles: list[RoleEntity] = Field(default_factory=list)
    evidence: list[EvidenceRef] = Field(default_factory=list)
    tool_calls: list[AgentToolCall] = Field(default_factory=list)
    forecast: ForecastResult | None = None
    readiness_plan: ReadinessPlan | None = None
    structured_result: UsefulQuestionResult | None = None
    final_answer: str | None = None


class ProgressEvent(BaseModel):
    type: ProgressType
    run_id: UUID
    message: str
    tool: ToolName | None = None
    data: dict[str, Any] = Field(default_factory=dict)
    timestamp: datetime = Field(default_factory=lambda: datetime.now(UTC))

    @model_validator(mode="after")
    def timestamp_is_aware(self) -> ProgressEvent:
        if self.timestamp.tzinfo is None:
            raise ValueError("progress timestamp must be timezone-aware")
        return self


class RecruitingKnowledgeStore(Protocol):
    def find_companies(self, goal: str) -> list[CompanyEntity]: ...

    def find_roles(self, company_id: UUID, goal: str, role_id: UUID | None = None) -> list[RoleEntity]: ...

    def current_jobs(self, company_id: UUID, role_id: UUID | None) -> list[CurrentJob]: ...

    def inspect_career_page(self, company_id: UUID) -> CareerPageInspection | None: ...

    def role_history(self, role_id: UUID) -> list[RoleHistoryItem]: ...

    def archives(self, company_id: UUID, role_id: UUID | None) -> list[ArchiveInspection]: ...

    def signals(self, company_id: UUID, role_id: UUID | None) -> list[RecruitingSignalFact]: ...

    def generate_forecast(self, role_id: UUID, as_of: date) -> ForecastResult: ...

    def forecast_evidence(self, forecast_id: UUID) -> list[ForecastEvidenceFact]: ...


class AgentAuditStore(Protocol):
    def start_agent_run(
        self,
        *,
        agent_name: str,
        purpose: str,
        input_fingerprint: str,
        initiated_by: UUID | None = None,
    ) -> UUID: ...

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
    ) -> UUID: ...

    def save_recruiting_agent_state(self, run_id: UUID, state: RecruitingAgentState) -> None: ...

    def finish_agent_run(self, run_id: UUID, *, status: str, error: dict[str, Any] | None = None) -> None: ...


@dataclass(frozen=True)
class GoalIntent:
    current: bool
    history: bool
    archives: bool
    forecast: bool
    readiness: bool
    signals: bool
    page: bool

    @classmethod
    def parse(cls, goal: str) -> GoalIntent:
        lowered = goal.casefold()
        contains = lambda *terms: any(term in lowered for term in terms)
        forecast = contains(
            "when", "forecast", "predict", "likely to open", "opening window",
            "timeline", "opens", "will open", "expect",
        )
        current = contains("current", "open now", "live", "available", "current jobs", "apply now")
        history = forecast or contains(
            "history", "historical", "cycle", "previous year", "last year", "past year"
        )
        readiness = contains(
            "prepare", "prep", "readiness", "resume", "network", "referral", "deadline",
            "work backward", "get ready", "ready for",
        )
        return cls(
            current=current,
            history=history,
            archives=contains("archive", "wayback", "capture"),
            forecast=forecast,
            readiness=readiness,
            signals=forecast or current or contains("signal", "recruiting activity"),
            page=current or contains("career page", "careers page", "program page"),
        )

    @property
    def is_inconclusive(self) -> bool:
        """No evidence class was recognised, so the run would stop after identity."""
        # page counts: a page-only question still inspects the career page, so the run does
        # not stop after identity and needs no model.
        return not any(
            (self.current, self.history, self.archives, self.forecast, self.readiness, self.signals, self.page)
        )

    def widened_by(self, proposal: GoalIntentProposal) -> GoalIntent:
        """Merge a model proposal permissively.

        Only enabling is allowed. A model may not switch off an intent the
        deterministic rules recognised, so model unavailability or a wrong answer
        can never *narrow* the evidence the agent inspects.
        """
        return GoalIntent(
            current=self.current or proposal.wants_current_postings,
            history=self.history or proposal.wants_history or proposal.wants_forecast,
            archives=self.archives or proposal.wants_archives,
            forecast=self.forecast or proposal.wants_forecast,
            readiness=self.readiness or proposal.wants_readiness,
            signals=self.signals or proposal.wants_signals or proposal.wants_forecast,
            page=self.page or proposal.wants_career_page,
        )


class RecruitingTools:
    """Typed tool façade. No method fetches a website directly."""

    def __init__(
        self,
        store: RecruitingKnowledgeStore,
        *,
        readiness_planner: ApplicationReadinessPlanner | None = None,
        readiness_store: ReadinessPlanStore | None = None,
    ) -> None:
        self.store = store
        self.readiness_planner = readiness_planner or ApplicationReadinessPlanner()
        self.readiness_store = readiness_store

    def discover_company(self, goal: str) -> list[CompanyEntity]:
        return self.store.find_companies(goal)

    def resolve_role(self, company_id: UUID, goal: str, role_id: UUID | None = None) -> list[RoleEntity]:
        # A role page names its role exactly; a free-text question is matched on titles and aliases.
        if role_id is not None:
            return self.store.find_roles(company_id, goal, role_id=role_id)
        return self.store.find_roles(company_id, goal)

    def get_current_jobs(self, company_id: UUID, role_id: UUID | None) -> list[CurrentJob]:
        return self.store.current_jobs(company_id, role_id)

    def inspect_career_page(self, company_id: UUID) -> CareerPageInspection | None:
        return self.store.inspect_career_page(company_id)

    def get_role_history(self, role_id: UUID) -> list[RoleHistoryItem]:
        return self.store.role_history(role_id)

    def inspect_archives(self, company_id: UUID, role_id: UUID | None) -> list[ArchiveInspection]:
        return self.store.archives(company_id, role_id)

    def get_recruiting_signals(self, company_id: UUID, role_id: UUID | None) -> list[RecruitingSignalFact]:
        return self.store.signals(company_id, role_id)

    def generate_forecast(self, role_id: UUID, as_of: date) -> ForecastResult:
        return self.store.generate_forecast(role_id, as_of)

    def get_forecast_evidence(self, forecast_id: UUID) -> list[ForecastEvidenceFact]:
        return self.store.forecast_evidence(forecast_id)

    def create_readiness_plan(
        self,
        forecast: ForecastResult,
        company: CompanyEntity,
        role: RoleEntity,
        user_id: UUID | None = None,
    ) -> ReadinessPlan:
        plan = self.readiness_planner.plan(
            ReadinessForecast(
                forecast_id=forecast.forecast_id,
                role_id=forecast.role_id,
                as_of=forecast.as_of,
                expected_opening_date=forecast.expected_opening_date,
                interval_start=forecast.interval_start,
                interval_end=forecast.interval_end,
                confidence=forecast.confidence,
            ),
            ReadinessContext(
                company_size=company.company_size,
                recruiting_scale=company.recruiting_scale,
                role_competitiveness=role.role_competitiveness,
                role_family=role.role_family,
                portfolio_required=role.portfolio_required,
            ),
        )
        if user_id is not None and self.readiness_store is not None:
            self.readiness_store.save_for_user(user_id, plan)
        return plan


class RecruitingAgent:
    """State-dependent evidence orchestrator with observable, non-CoT progress."""

    max_tool_calls = 12

    def __init__(
        self,
        tools: RecruitingTools,
        audit: AgentAuditStore,
        *,
        today: date | None = None,
        useful_tools: UsefulQuestionTools | None = None,
        intent_interpreter: LlmGoalIntentInterpreter | None = None,
    ) -> None:
        self.tools = tools
        self.audit = audit
        self.today = today or datetime.now(UTC).date()
        self.useful_tools = useful_tools
        # Optional and permissive: widens which typed tools a question is
        # understood to need. It never selects a tool directly and never
        # produces a forecast value.
        self.intent_interpreter = intent_interpreter

    def run(
        self,
        goal: str,
        *,
        user_id: UUID | None = None,
        audience: AgentAudience = "member",
        role_id: UUID | None = None,
    ) -> RecruitingAgentState:
        final_state: RecruitingAgentState | None = None
        for event, state in self._execute(goal, user_id=user_id, audience=audience, role_id=role_id):
            del event
            final_state = state
        if final_state is None:  # pragma: no cover - defensive invariant
            raise RuntimeError("agent produced no state")
        return final_state

    def stream(
        self,
        goal: str,
        *,
        user_id: UUID | None = None,
        audience: AgentAudience = "member",
        role_id: UUID | None = None,
    ) -> Iterator[ProgressEvent]:
        for event, _ in self._execute(goal, user_id=user_id, audience=audience, role_id=role_id):
            yield event

    def _execute(
        self, goal: str, *, user_id: UUID | None, audience: AgentAudience, role_id: UUID | None = None
    ) -> Iterator[tuple[ProgressEvent, RecruitingAgentState]]:
        if audience == "guest" and user_id is not None:
            raise ValueError("a guest question carries no user identity")
        state = RecruitingAgentState(goal=goal, actor_id=user_id, audience=audience, selected_role_id=role_id)
        intent = GoalIntent.parse(goal)
        useful_intent = UsefulQuestionIntent.parse(goal) if self.useful_tools else None
        run_id = self.audit.start_agent_run(
            agent_name="recruiting_agent",
            purpose="Answer a recruiting intelligence question from stored evidence",
            input_fingerprint=sha256(goal.strip().encode()).hexdigest(),
            # Recorded at the start, so an unfinished run is already known to belong to a user.
            initiated_by=user_id,
        )
        run_started_at = datetime.now(UTC)
        yield (
            ProgressEvent(
                type="run_started",
                run_id=run_id,
                message="Started recruiting evidence review.",
                data={"execution_mode": "typed_tool_orchestration", "model_provider": None},
            ),
            state,
        )
        # Deterministic-first: a model is consulted only when the keyword rules
        # recognised no evidence class at all, and only to widen the typed tools
        # the question is understood to need.
        intent_provider: str | None = None
        if self.intent_interpreter and intent.is_inconclusive and useful_intent is None:
            proposal = self.intent_interpreter.interpret(goal, agent_run_id=run_id)
            if proposal is not None:
                intent = intent.widened_by(proposal)
                intent_provider = self.intent_interpreter.provider
                if proposal.portfolio_question != "none" and self.useful_tools:
                    useful_intent = UsefulQuestionIntent.from_choice(
                        proposal.portfolio_question, proposal.horizon_days
                    )
                yield (
                    ProgressEvent(
                        type="run_started",
                        run_id=run_id,
                        message="Interpreted the question into typed evidence requirements.",
                        data={
                            "execution_mode": "model_assisted_intent",
                            "model_provider": intent_provider,
                            "intent": {
                                "forecast": intent.forecast,
                                "history": intent.history,
                                "current": intent.current,
                                "readiness": intent.readiness,
                                "signals": intent.signals,
                                "archives": intent.archives,
                                "page": intent.page,
                            },
                        },
                    ),
                    state,
                )
        try:
            for _ in range(self.max_tool_calls):
                action = self._next_action(state, intent, useful_intent)
                if action is None:
                    break
                yield (
                    ProgressEvent(
                        type="tool_started",
                        run_id=run_id,
                        tool=action,
                        message=self._start_message(action),
                    ),
                    state,
                )
                tool_started_at = datetime.now(UTC)
                evidence_before = len(state.evidence)
                try:
                    result, summary = self._call(action, state, useful_intent)
                except Exception as exc:
                    self._audit_failed_call(run_id, action, state, tool_started_at, exc)
                    raise
                self._apply(action, result, state)
                self._audit_call(run_id, action, state, summary, tool_started_at)
                completed_at = datetime.now(UTC)
                yield (
                    ProgressEvent(
                        type="tool_completed",
                        run_id=run_id,
                        tool=action,
                        message=summary,
                        data=self._observable_tool_data(
                            action,
                            result,
                            state,
                            evidence_before=evidence_before,
                            duration_ms=max(0, int((completed_at - tool_started_at).total_seconds() * 1000)),
                        ),
                    ),
                    state,
                )
            self._assess(state, intent, useful_intent)
            yield (
                ProgressEvent(
                    type="evidence_assessed",
                    run_id=run_id,
                    message=self._assessment_message(state),
                    data={"unresolved_count": len(state.unresolved_questions)},
                ),
                state,
            )
            state.final_answer = self._final_answer(state, intent)
            self.audit.save_recruiting_agent_state(run_id, state)
            self.audit.finish_agent_run(
                run_id, status="succeeded" if not state.unresolved_questions else "partial"
            )
            yield (
                ProgressEvent(
                    type="answer_completed",
                    run_id=run_id,
                    message="Completed the evidence-backed answer.",
                    data={
                        "answer": state.final_answer,
                        "state": state.model_dump(mode="json"),
                        "tool_count": len(state.tool_calls),
                        "evidence_count": len(state.evidence),
                        "source_count": len({str(item.source_url) for item in state.evidence}),
                        "duration_ms": max(
                            0, int((datetime.now(UTC) - run_started_at).total_seconds() * 1000)
                        ),
                        "forecast_generated": state.forecast is not None,
                        # Null unless a model actually interpreted the question.
                        # Forecast values never come from a model.
                        "model_provider": intent_provider,
                    },
                ),
                state,
            )
        except Exception as exc:  # noqa: BLE001 - top-level agent failures are audited and streamed safely
            state.unresolved_questions.append("The evidence review could not be completed.")
            self.audit.save_recruiting_agent_state(run_id, state)
            self.audit.finish_agent_run(
                run_id,
                status="failed",
                error={
                    "type": type(exc).__name__,
                    "message": redact_sensitive_text(exc, limit=300),
                },
            )
            yield (
                ProgressEvent(
                    type="run_failed",
                    run_id=run_id,
                    message="The evidence review stopped before a responsible conclusion was available.",
                ),
                state,
            )

    @staticmethod
    def _invoked(state: RecruitingAgentState, tool: ToolName) -> bool:
        return any(call.tool == tool for call in state.tool_calls)

    def _next_action(
        self,
        state: RecruitingAgentState,
        intent: GoalIntent,
        useful_intent: UsefulQuestionIntent | None,
    ) -> ToolName | None:
        company = state.resolved_entities.get("company")
        role = state.resolved_entities.get("role")
        if useful_intent and not useful_intent.requires_role:
            return None if self._invoked(state, "answer_portfolio_question") else "answer_portfolio_question"
        if not self._invoked(state, "discover_company"):
            return "discover_company"
        if not isinstance(company, CompanyEntity):
            return None
        if not self._invoked(state, "resolve_role"):
            return "resolve_role"
        if not isinstance(role, RoleEntity):
            return None
        if useful_intent:
            return None if self._invoked(state, "answer_portfolio_question") else "answer_portfolio_question"
        if intent.current and not self._invoked(state, "get_current_jobs"):
            return "get_current_jobs"
        if intent.page and not self._invoked(state, "inspect_career_page"):
            return "inspect_career_page"
        if intent.history and not self._invoked(state, "get_role_history"):
            return "get_role_history"
        history_count = sum(item.kind == "history" for item in state.evidence)
        if (intent.archives or (intent.forecast and history_count < 2)) and not self._invoked(
            state, "inspect_archives"
        ):
            return "inspect_archives"
        if intent.signals and not self._invoked(state, "get_recruiting_signals"):
            return "get_recruiting_signals"
        if intent.forecast and state.forecast is None and not self._invoked(state, "generate_forecast"):
            return "generate_forecast"
        if (
            state.forecast
            and state.forecast.forecast_id
            and not self._invoked(state, "get_forecast_evidence")
        ):
            return "get_forecast_evidence"
        if state.forecast and state.readiness_plan is None and state.audience == "member":
            return "create_readiness_plan"
        return None

    def _call(
        self,
        action: ToolName,
        state: RecruitingAgentState,
        useful_intent: UsefulQuestionIntent | None,
    ) -> tuple[Any, str]:
        company = state.resolved_entities.get("company")
        role = state.resolved_entities.get("role")
        if action == "answer_portfolio_question" and useful_intent and self.useful_tools:
            result = self.useful_tools.answer(
                useful_intent,
                as_of=self.today,
                user_id=state.actor_id,
                role_id=role.id if isinstance(role, RoleEntity) else None,
            )
            return result, result.summary
        if action == "discover_company":
            companies = self.tools.discover_company(state.goal)
            provider = companies[0].ats_provider if len(companies) == 1 else None
            provider_text = f" Recruiting system: {provider}." if provider else ""
            return companies, f"Matched {len(companies)} company record{'s' if len(companies) != 1 else ''}.{provider_text}"
        if not isinstance(company, CompanyEntity):
            raise TypeError("company must be resolved before this tool")
        if action == "resolve_role":
            roles = self.tools.resolve_role(company.id, state.goal, role_id=state.selected_role_id)
            return roles, f"Resolved {len(roles)} recurring role identit{'ies' if len(roles) != 1 else 'y'} using persisted aliases and typed compatibility."
        role_id = role.id if isinstance(role, RoleEntity) else None
        if action == "get_current_jobs":
            jobs = self.tools.get_current_jobs(company.id, role_id)
            return jobs, f"Checked {len(jobs)} current matching job{'s' if len(jobs) != 1 else ''}."
        if action == "inspect_career_page":
            page = self.tools.inspect_career_page(company.id)
            return page, "Checked the latest stored career-page observation."
        if action == "get_role_history" and role_id:
            history = self.tools.get_role_history(role_id)
            cycles = recruiting_cycle_count(history)
            return history, (
                f"Checked {len(history)} recorded opening{'s' if len(history) != 1 else ''} across "
                f"{cycles} recruiting cycle{'s' if cycles != 1 else ''}."
            )
        if action == "inspect_archives":
            archives = self.tools.inspect_archives(company.id, role_id)
            return archives, f"Inspected {len(archives)} relevant archive captures."
        if action == "get_recruiting_signals":
            signals = self.tools.get_recruiting_signals(company.id, role_id)
            return signals, f"Checked {len(signals)} current recruiting signals."
        if action == "generate_forecast" and role_id:
            try:
                forecast = self.tools.generate_forecast(role_id, self.today)
            except InsufficientEvidenceError as exc:
                return None, f"Not enough recorded history to forecast this role yet: {exc}"
            source = "stored" if forecast.cached else "statistically generated"
            return forecast, f"Loaded a {source} forecast from the forecasting component."
        if action == "get_forecast_evidence" and state.forecast and state.forecast.forecast_id:
            forecast_evidence = self.tools.get_forecast_evidence(state.forecast.forecast_id)
            return forecast_evidence, f"Verified {len(forecast_evidence)} forecast evidence records."
        if action == "create_readiness_plan" and state.forecast:
            plan = self.tools.create_readiness_plan(
                state.forecast,
                cast(CompanyEntity, company),
                cast(RoleEntity, role),
                user_id=state.actor_id,
            )
            return plan, f"Created {len(plan.milestones)} forecast-based readiness milestones."
        raise ValueError(f"tool preconditions not met for {action}")

    def _apply(self, action: ToolName, result: Any, state: RecruitingAgentState) -> None:
        if action == "discover_company":
            companies = cast(list[CompanyEntity], result)
            if len(companies) == 1:
                state.resolved_entities["company"] = companies[0]
                state.known_facts.append(f"Resolved company: {companies[0].name}.")
            elif not companies:
                state.unresolved_questions.append("Which company should be investigated?")
            else:
                state.unresolved_questions.append("The company name is ambiguous.")
        elif action == "resolve_role":
            found = cast(list[RoleEntity], result)
            roles = [role for role in found if role.in_product_scope]
            if not roles and found:
                state.out_of_scope_roles = found
                state.unresolved_questions.append(
                    "1stSeen forecasts early-career technical programs only; the matching roles are outside that scope."
                )
            elif len(roles) == 1:
                state.resolved_entities["role"] = roles[0]
                state.known_facts.append(f"Resolved recurring role: {roles[0].title}.")
            elif not roles:
                state.unresolved_questions.append("Which recurring role or program is intended?")
            else:
                state.role_candidates = roles
                state.unresolved_questions.append("The role description matches multiple programs.")
        elif action == "generate_forecast" and result is None:
            state.unresolved_questions.append(
                "There is not enough recorded history, and no sourced company or role-family prior, "
                "to forecast this role yet."
            )
        elif action == "generate_forecast":
            state.forecast = cast(ForecastResult, result)
            state.known_facts.append(
                "The forecasting component returned an expected date, prediction interval, and bounded confidence score."
            )
        elif action == "create_readiness_plan":
            state.readiness_plan = cast(ReadinessPlan, result)
            state.known_facts.append("Readiness milestones were calculated from the forecast interval.")
        elif action == "answer_portfolio_question":
            state.structured_result = cast(UsefulQuestionResult, result)
            state.known_facts.append(state.structured_result.summary)
        else:
            added = self._evidence_from(result)
            state.evidence.extend(added)
            labels: dict[ToolName, str] = {
                "get_current_jobs": "current matching job observations",
                "inspect_career_page": "stored career-page observations",
                "get_role_history": "historical openings",
                "inspect_archives": "archive captures",
                "get_recruiting_signals": "supporting recruiting signals",
                "get_forecast_evidence": "forecast provenance records",
                "discover_company": "company records",
                "resolve_role": "role records",
                "generate_forecast": "forecast records",
                "create_readiness_plan": "readiness plans",
                "answer_portfolio_question": "portfolio query results",
            }
            state.known_facts.append(f"Found {len(added)} traceable {labels[action]}.")

    @staticmethod
    def _observable_tool_data(
        action: ToolName,
        result: Any,
        state: RecruitingAgentState,
        *,
        evidence_before: int,
        duration_ms: int,
    ) -> dict[str, Any]:
        if isinstance(result, list):
            result_count = len(result)
        elif result is None:
            result_count = 0
        else:
            result_count = 1
        data: dict[str, Any] = {
            "result_count": result_count,
            "new_evidence_count": max(0, len(state.evidence) - evidence_before),
            "evidence_count": len(state.evidence),
            "source_count": len({str(item.source_url) for item in state.evidence}),
            "duration_ms": duration_ms,
            "execution_kind": "statistical_model" if action == "generate_forecast" else "deterministic_tool",
            "model_provider": None,
        }
        if action == "discover_company" and isinstance(result, list) and len(result) == 1:
            company = result[0]
            if isinstance(company, CompanyEntity):
                data["recruiting_system"] = company.ats_provider
        if action == "generate_forecast" and isinstance(result, ForecastResult):
            data["forecast"] = {
                "expected_opening_date": result.expected_opening_date.isoformat(),
                "interval_start": result.interval_start.isoformat(),
                "interval_end": result.interval_end.isoformat(),
                "confidence": result.confidence,
                "model_version": result.model_version,
                "cached": result.cached,
            }
            if result.own_history_weight is not None and result.borrowed_weight is not None:
                data["forecast"]["own_history_weight"] = result.own_history_weight
                data["forecast"]["borrowed_weight"] = result.borrowed_weight
        if action == "create_readiness_plan" and isinstance(result, ReadinessPlan):
            data["milestone_count"] = len(result.milestones)
            data["policy_version"] = result.policy_version
        return data

    @staticmethod
    def _evidence_from(result: Any) -> list[EvidenceRef]:
        values: Sequence[Any] = result if isinstance(result, list) else [result]
        evidence: list[EvidenceRef] = []
        for value in values:
            if value is None:
                continue
            item = getattr(value, "evidence", None)
            if isinstance(item, EvidenceRef):
                evidence.append(item)
        existing: dict[str, EvidenceRef] = {item.id: item for item in evidence}
        return list(existing.values())

    @staticmethod
    def _audit_output(action: ToolName, state: RecruitingAgentState, summary: str) -> dict[str, Any]:
        """What a tool call records: its summary and counts, and for the forecast step whether a forecast came back.

        The dashboard reads `forecast_produced` to say "Statistical forecast ready" or "No forecast produced"; a
        refusal (InsufficientEvidenceError) is a succeeded call with no forecast, so the status alone cannot say it.
        """
        output: dict[str, Any] = {"summary": summary, "evidence_count": len(state.evidence)}
        if action == "generate_forecast":
            output["forecast_produced"] = state.forecast is not None
        return output

    def _audit_call(
        self,
        run_id: UUID,
        action: ToolName,
        state: RecruitingAgentState,
        summary: str,
        started_at: datetime,
    ) -> None:
        company = state.resolved_entities.get("company")
        role = state.resolved_entities.get("role")
        input_summary = {
            "company_id": str(company.id) if isinstance(company, CompanyEntity) else None,
            "role_id": str(role.id) if isinstance(role, RoleEntity) else None,
            "actor_id": str(state.actor_id) if state.actor_id else None,
        }
        self.audit.record_tool_call(
            run_id,
            tool_name=f"recruiting_agent.{action}",
            status="succeeded",
            input_redacted=input_summary,
            output_redacted=self._audit_output(action, state, summary),
            started_at=started_at,
        )
        state.tool_calls.append(
            AgentToolCall(
                tool=action,
                status="succeeded",
                started_at=started_at,
                finished_at=datetime.now(UTC),
                input_summary=input_summary,
                result_summary=summary,
            )
        )

    def _audit_failed_call(
        self,
        run_id: UUID,
        action: ToolName,
        state: RecruitingAgentState,
        started_at: datetime,
        exc: Exception,
    ) -> None:
        company = state.resolved_entities.get("company")
        role = state.resolved_entities.get("role")
        input_summary = {
            "company_id": str(company.id) if isinstance(company, CompanyEntity) else None,
            "role_id": str(role.id) if isinstance(role, RoleEntity) else None,
            "actor_id": str(state.actor_id) if state.actor_id else None,
        }
        result_summary = "Tool failed before returning usable evidence."
        self.audit.record_tool_call(
            run_id,
            tool_name=f"recruiting_agent.{action}",
            status="failed",
            input_redacted=input_summary,
            output_redacted={"summary": result_summary},
            started_at=started_at,
            error={
                "type": type(exc).__name__,
                "message": redact_sensitive_text(exc, limit=300),
            },
        )
        state.tool_calls.append(
            AgentToolCall(
                tool=action,
                status="failed",
                started_at=started_at,
                finished_at=datetime.now(UTC),
                input_summary=input_summary,
                result_summary=result_summary,
            )
        )

    @staticmethod
    def _assess(
        state: RecruitingAgentState,
        intent: GoalIntent,
        useful_intent: UsefulQuestionIntent | None,
    ) -> None:
        if useful_intent:
            if state.structured_result is None:
                state.unresolved_questions.append("The indexed question could not be answered.")
            elif state.structured_result.limitations:
                state.unresolved_questions.extend(state.structured_result.limitations)
            state.unresolved_questions = list(dict.fromkeys(state.unresolved_questions))
            return
        if intent.forecast and state.forecast is None and isinstance(state.resolved_entities.get("role"), RoleEntity):
            state.unresolved_questions.append("No statistical forecast could be produced for the role.")
        if state.forecast and state.forecast.forecast_id:
            has_forecast_evidence = any(item.kind == "forecast" for item in state.evidence)
            if not has_forecast_evidence:
                state.unresolved_questions.append("The forecast has no retrievable provenance records.")
        state.unresolved_questions = list(dict.fromkeys(state.unresolved_questions))

    @staticmethod
    def _assessment_message(state: RecruitingAgentState) -> str:
        if state.unresolved_questions:
            return f"Evidence review found {len(state.unresolved_questions)} unresolved item(s)."
        return f"Evidence was sufficient across {len(state.evidence)} traceable records."

    @staticmethod
    def _final_answer(state: RecruitingAgentState, intent: GoalIntent) -> str:
        if state.structured_result:
            result = state.structured_result
            details = RecruitingAgent._structured_details(result)
            limitations = " Limitations: " + " ".join(result.limitations) if result.limitations else ""
            return f"{result.summary}{details}{limitations}"
        company = state.resolved_entities.get("company")
        role = state.resolved_entities.get("role")
        if not isinstance(company, CompanyEntity):
            return "I could not identify one company from the stored evidence. Please name the company or domain."
        if not isinstance(role, RoleEntity):
            if state.out_of_scope_roles:
                return RecruitingAgent._out_of_scope_answer(company, state.out_of_scope_roles)
            if state.role_candidates:
                return RecruitingAgent._candidate_answer(company, state.role_candidates)
            return f"I found {company.name}, but could not identify one recurring role. Please specify the program or role."
        parts = [f"For {company.name}’s {role.title} program:"]
        if state.forecast:
            forecast = state.forecast
            parts.append(
                f"the statistical forecast expects an opening within a {forecast.interval_start:%B %-d}–"
                f"{forecast.interval_end:%B %-d, %Y} prediction interval, expected {forecast.expected_opening_date:%B %-d, %Y}, "
                f"with a {confidence_phrase(forecast.confidence)}. The score measures how much consistent evidence "
                "backs the window; it is not the chance that the window is right."
            )
            basis = basis_phrase(forecast.own_history_weight, forecast.borrowed_weight)
            parts.append(
                f"That result used {forecast.history_count} of this program's own recruiting cycle(s)"
                f"{f' and is {basis}' if basis else ''}, from model {forecast.model_version}; the agent did not "
                "calculate these values itself."
            )
        elif intent.forecast:
            parts.append(
                "there is not enough resolved statistical output to state an opening window responsibly."
            )
        history = [item for item in state.evidence if item.kind == "history"]
        signals = [item for item in state.evidence if item.kind == "signal"]
        if history:
            parts.append(f"I checked {len(history)} source-backed historical opening record(s).")
        if signals:
            parts.append(f"I also checked {len(signals)} supporting recruiting signal(s).")
        if state.readiness_plan:
            plan = state.readiness_plan
            deadlines = "; ".join(f"{item.title} by {item.due_on:%B %-d, %Y}" for item in plan.milestones)
            parts.append(f"Work-back plan: {deadlines}.")
            parts.append(
                f"The {plan.policy_version} policy adjusted every base lead time by "
                f"{plan.total_adjustment_days:+d} days using company size, recruiting scale, role "
                "competitiveness, interval width, and forecast confidence."
            )
        if state.audience == "guest" and intent.readiness and state.forecast:
            parts.append(
                "A work-back preparation plan needs an account, because it is saved to the watchlist it is built for."
            )
        if state.unresolved_questions:
            parts.append("Limitations: " + " ".join(state.unresolved_questions))
        if len(parts) == 1:
            # A resolved role with nothing asked of it used to return the bare heading.
            return (
                f"I found {company.name}’s {role.title} program, but the question did not ask for anything "
                "I can answer from stored evidence. Ask when it is likely to open, what its history shows, "
                "whether it has current postings, or how to prepare for it."
            )
        return " ".join(parts)

    @staticmethod
    def _out_of_scope_answer(company: CompanyEntity, roles: list[RoleEntity]) -> str:
        named = "; ".join(role.title for role in roles[:3]) + (f"; and {len(roles) - 3} more" if len(roles) > 3 else "")
        return (
            f"I found {company.name}, but the matching roles ({named}) are outside 1stSeen's scope. It forecasts "
            "early-career technical programs only: internships, co-ops, new grad, graduate, and rotational "
            "programs in engineering, machine learning, data, quantitative, product, and design roles."
        )

    @staticmethod
    def _candidate_answer(company: CompanyEntity, candidates: list[RoleEntity]) -> str:
        """Name the programs an ambiguous question matched, so the next question can pick one."""
        # Location and specialization are shown only where they are what separates programs sharing a
        # title. Stored specializations are inferred from description text and are unreliable on
        # their own ("Product Management Intern Summer" carries "infrastructure").
        shared = {title for title in (item.title for item in candidates) if sum(other.title == title for other in candidates) > 1}
        described = []
        for candidate in candidates[:ROLE_CANDIDATES_SHOWN]:
            split = [part for part in (candidate.location_scope, candidate.specialization) if part and part != "unspecified"]
            described.append(f"{candidate.title} ({', '.join(split)})" if split and candidate.title in shared else candidate.title)
        more = len(candidates) - len(described)
        listed = "; ".join(described) + (f"; and {more} more" if more > 0 else "")
        return (
            f"I found {company.name}, but the question matches {len(candidates)} of its recurring programs: "
            f"{listed}. Name the program to continue."
        )

    @staticmethod
    def _structured_details(result: UsefulQuestionResult) -> str:
        if not result.items:
            return ""
        lines: list[str] = []
        for item in result.items[:10]:
            if isinstance(item, RoleForecastItem):
                lines.append(f"{item.company} — {item.role}: {forecast_phrase(item)}.")
            elif isinstance(item, PreparationItem):
                lines.append(f"{item.company} — {item.role}: {item.action} by {item.due_on:%B %-d, %Y}.")
            elif isinstance(item, ForecastChangeItem):
                lines.append(
                    f"{item.company} — {item.role}: confidence {item.confidence_delta:+.1f} points; "
                    f"expected date {item.point_date_delta_days:+d} days."
                )
            elif isinstance(item, ConfidenceExplanationItem):
                limiting = [
                    factor.name.replace("_", " ") for factor in item.factors if factor.effect == "limits"
                ]
                lines.append(
                    f"{item.company} — {item.role}: {confidence_phrase(item.confidence)}; limiting factors: "
                    f"{', '.join(limiting[:3]) or 'none below threshold'}."
                )
            elif isinstance(item, CompanyTimingItem):
                lines.append(
                    f"{item.company}: typically around {calendar.month_name[item.typical_opening_month]} "
                    f"{item.typical_opening_day} across {item.historical_cycle_count} recruiting cycles of its programs."
                )
        return " " + " ".join(lines)

    @staticmethod
    def _start_message(action: ToolName) -> str:
        messages: dict[ToolName, str] = {
            "discover_company": "Matching the company against stored identities.",
            "resolve_role": "Resolving the recurring role without title-only merging.",
            "get_current_jobs": "Checking current stored job observations.",
            "inspect_career_page": "Inspecting the latest stored career-page evidence.",
            "get_role_history": "Reviewing source-backed historical openings.",
            "inspect_archives": "Reviewing archived recruiting evidence.",
            "get_recruiting_signals": "Checking current supporting recruiting signals.",
            "generate_forecast": "Requesting a forecast from the statistical model.",
            "get_forecast_evidence": "Verifying the forecast’s source evidence.",
            "create_readiness_plan": "Working backward into preparation deadlines.",
            "answer_portfolio_question": "Querying current indexed recruiting intelligence.",
        }
        return messages[action]


def roles_matching_question(goal: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The canonical role rows a question identifies at one company; ties stay ambiguous.

    A track the question names (intern, new grad, apprentice) is a hard filter. Within it, rows
    rank by identifying words shared with the question: title or alias, plus the location scope and
    specialization that deliberately split one title into several roles, never the company's own
    name. A question whose identifying words match nothing resolves nothing. Only a question with
    no identifying words falls back to its track: one role there resolves, several stay ambiguous.
    """
    tracks = question_tracks(goal)
    eligible = [row for row in rows if not tracks or row.get("track") in tracks]
    company = " ".join(sorted({str(row.get("company_normalized") or "") for row in rows}))
    goal_tokens = identifying_title_tokens(goal, company)
    scored: list[tuple[int, dict[str, Any]]] = []
    for row in eligible:
        names = [str(row["canonical_title"])] + [
            str(item.get("alias_title") or "")
            for item in cast(list[dict[str, Any]], row.get("role_aliases") or [])
        ]
        split = identifying_title_tokens(f"{row.get('location_scope') or ''} {row.get('specialization') or ''}", company)
        score = max(len((identifying_title_tokens(name, company) | split) & goal_tokens) for name in names)
        if score:
            scored.append((score, row))
    if scored:
        best = max(score for score, _ in scored)
        return [row for score, row in scored if score == best]
    if goal_tokens:
        return []
    return eligible if tracks or len(eligible) == 1 else []


# Words that appear in company names but say nothing about which company a question means. "When do trading firms
# open?" names no firm; counting "trading" matched Belvedere, DV, and Hudson River Trading at once.
_GENERIC_COMPANY_WORDS = frozenset(
    {
        "about", "asset", "capital", "careers", "company", "global", "group", "inc", "jobs", "labs", "management",
        "open", "partners", "research", "store", "technologies", "trading", "traders",
    }
)
_SECOND_LEVEL_LABELS = frozenset({"ac", "co", "com", "edu", "gov", "net", "org"})


def registrable_label(domain: str) -> str:
    """The label a domain is registered under: open.spotify.com -> spotify, about.gitlab.com -> gitlab, x.co.uk -> x.

    Matching used the first label, so Spotify (open.spotify.com) was "open" and every question about when a program
    opens matched Spotify; GitLab (about.gitlab.com) matched every question "about" anything.
    """
    labels = [label for label in domain.casefold().split(".") if label]
    if len(labels) >= 3 and labels[-2] in _SECOND_LEVEL_LABELS:
        return labels[-3]
    return labels[-2] if len(labels) >= 2 else (labels[0] if labels else "")


def company_identity_tokens(name: str, domain: str) -> set[str]:
    """The words that identify a company in a question: its name's distinctive words and its registrable label."""
    return {
        token
        for token in re.findall(r"[a-z0-9]+", f"{name.casefold()} {registrable_label(domain)}")
        if len(token) >= 4 and token not in _GENERIC_COMPANY_WORDS
    }


class SupabaseRecruitingKnowledge:
    """Read-only evidence queries plus the approved forecasting entrypoint."""

    def __init__(self, repository: IntelligenceRepository) -> None:
        self.repository = repository
        self.client = repository.client

    def find_companies(self, goal: str) -> list[CompanyEntity]:
        rows = fetch_all_rows(
            lambda: self.client.table("companies").select("id,name,domain,careers_url,ats_provider,metadata"), key="id"
        )
        lowered = goal.casefold()
        goal_tokens = set(re.findall(r"[a-z0-9]+", lowered))
        scored: list[tuple[int, dict[str, Any]]] = []
        for row in rows:
            name = str(row["name"]).casefold()
            domain = str(row["domain"]).casefold()
            identity_tokens = company_identity_tokens(name, domain)
            score = len(identity_tokens & goal_tokens)
            if name in lowered or domain in lowered:
                score += 3
            if score:
                scored.append((score, row))
        # A withdrawn company (docs/takedown.md) is out of the product: its stored postings, pages, and archives are never
        # read back to answer a question, so it is not a company the agent can resolve.
        if scored:
            withdrawn = {str(company_id) for company_id in self.repository.withdrawn_company_ids()}
            scored = [(score, row) for score, row in scored if str(row["id"]) not in withdrawn]
        best = max((score for score, _ in scored), default=0)
        matches = [row for score, row in scored if score == best]
        return [
            CompanyEntity(
                id=row["id"],
                name=row["name"],
                domain=row["domain"],
                careers_url=row.get("careers_url"),
                company_size=cast(
                    Any, cast(dict[str, Any], row.get("metadata") or {}).get("company_size", "unknown")
                ),
                recruiting_scale=float(
                    cast(dict[str, Any], row.get("metadata") or {}).get("recruiting_scale", 0.5)
                ),
                ats_provider=str(row["ats_provider"]) if row.get("ats_provider") else None,
            )
            for row in matches
        ]

    def find_roles(self, company_id: UUID, goal: str, role_id: UUID | None = None) -> list[RoleEntity]:
        # A company can hold hundreds of active roles (Stripe has 521): every one is read, page by page.
        rows = fetch_all_rows(
            lambda: self.client.table("canonical_roles")
            .select(
                "id,company_id,canonical_title,track,role_family,recurrence_key,feature_profile,"
                "company_normalized,location_scope,specialization,scope_status,role_aliases(alias_title)"
            )
            .eq("company_id", str(company_id))
            .eq("active", True),
            key="id",
        )
        # Only in-scope roles are answered about. When nothing in scope matches, the out-of-scope
        # matches come back flagged, so the answer can say why rather than ask which role.
        in_scope = [row for row in rows if row.get("scope_status") == "in_scope"]
        # A role named by id (a role page's question) is that role, if it belongs to this company.
        selected = [row for row in rows if role_id is not None and str(row["id"]) == str(role_id)]
        matched = selected or roles_matching_question(goal, in_scope) or roles_matching_question(goal, rows)
        return [
            RoleEntity(
                id=row["id"],
                company_id=row["company_id"],
                title=row["canonical_title"],
                track=row["track"],
                role_family=row["role_family"],
                recurrence_key=row["recurrence_key"],
                role_competitiveness=float(
                    cast(dict[str, Any], row.get("feature_profile") or {}).get("role_competitiveness", 0.5)
                ),
                portfolio_required=cast(
                    bool | None,
                    cast(dict[str, Any], row.get("feature_profile") or {}).get("portfolio_required"),
                ),
                location_scope=row.get("location_scope"),
                specialization=row.get("specialization"),
                in_product_scope=row.get("scope_status") == "in_scope",
            )
            for row in matched
        ]

    def current_jobs(self, company_id: UUID, role_id: UUID | None) -> list[CurrentJob]:
        # Every posting of the company, not the 100 most recently seen: the current-ness and role filters below run
        # in Python, so a cut before them dropped real current postings (Databricks has 1,043).
        rows = fetch_all_rows(
            lambda: self.client.table("raw_job_observations")
            .select(
                "id,raw_title,apply_url,location,published_at,first_seen_at,last_seen_at,source_url,"
                "observed_at,content_hash,evidence_excerpt,source_reliability,"
                "sources!inner(company_id,last_fetched_at)"
            )
            .eq("sources.company_id", str(company_id))
            .not_.is_("identity_key", "null")
            .order("last_seen_at", desc=True),
            key="id",
        )
        role_row: dict[str, Any] | None = None
        if role_id:
            # bounded: one row, the role by its primary key.
            response = (
                self.client.table("canonical_roles")
                .select("canonical_title,track,company_normalized")
                .eq("id", str(role_id))
                .limit(1)
                .execute()
            )
            title_rows = cast(list[dict[str, Any]], response.data or [])
            role_row = title_rows[0] if title_rows else None
        current_rows = [
            row
            for row in rows
            if cast(dict[str, Any], row.get("sources") or {}).get("last_fetched_at")
            and datetime.fromisoformat(str(row["last_seen_at"]))
            >= datetime.fromisoformat(str(cast(dict[str, Any], row["sources"])["last_fetched_at"]))
        ]
        return [
            self._job(row)
            for row in current_rows
            if not role_row or self._posting_matches_role(role_row, str(row.get("raw_title") or ""))
        ]

    def inspect_career_page(self, company_id: UUID) -> CareerPageInspection | None:
        # bounded: one row, the most trusted career page, with its id breaking a tie on trust score.
        sources = cast(
            list[dict[str, Any]],
            self.client.table("sources")
            .select("id,url")
            .eq("company_id", str(company_id))
            .in_("kind", ["careers_page", "campus_page", "program_page"])
            .order("trust_score", desc=True)
            .order("id")
            .limit(1)
            .execute()
            .data
            or [],
        )
        if not sources:
            return None
        source = sources[0]
        # bounded: one row, the page's newest observation, with its id breaking a tie on observed_at.
        observations = cast(
            list[dict[str, Any]],
            self.client.table("raw_job_observations")
            .select("id,observed_at,content_hash,evidence_excerpt,source_reliability")
            .eq("source_id", str(source["id"]))
            .order("observed_at", desc=True)
            .order("id", desc=True)
            .limit(1)
            .execute()
            .data
            or [],
        )
        if not observations:
            return CareerPageInspection(source_id=source["id"], url=source["url"])
        row = observations[0]
        evidence = self._evidence(
            row,
            "page",
            str(source["url"]),
            str(row.get("evidence_excerpt") or "Stored career-page observation."),
        )
        return CareerPageInspection(
            source_id=source["id"],
            url=source["url"],
            last_checked_at=row["observed_at"],
            content_hash=row["content_hash"],
            relevant_excerpt=row.get("evidence_excerpt"),
            evidence=evidence,
        )

    def role_history(self, role_id: UUID) -> list[RoleHistoryItem]:
        rows = fetch_all_rows(
            lambda: self.client.table("historical_opening_events")
            .select(
                "id,opened_on,opening_window_start,opening_window_end,date_precision,uncertainty_days,"
                "evidence_quote,source_quality,"
                "raw_job_observations!inner(id,observed_at,content_hash,source_url,raw_title,sources(url)),"
                "canonical_roles!inner(recruiting_season)"
            )
            .eq("canonical_role_id", str(role_id))
            .order("opened_on"),
            key="id",
        )
        items: list[RoleHistoryItem] = []
        for row in rows:
            observation = cast(dict[str, Any], row["raw_job_observations"])
            observation_source = cast(dict[str, Any], observation.get("sources") or {})
            source_url = str(observation.get("source_url") or observation_source.get("url") or "")
            opened_on = date.fromisoformat(str(row["opened_on"]))
            season = cast(dict[str, Any], row.get("canonical_roles") or {}).get("recruiting_season")
            items.append(
                RoleHistoryItem(
                    event_id=row["id"],
                    opened_on=opened_on,
                    window_start=row.get("opening_window_start"),
                    window_end=row["opening_window_end"],
                    precision=row["date_precision"],
                    uncertainty_days=row.get("uncertainty_days"),
                    evidence=self._evidence(
                        observation,
                        "history",
                        source_url,
                        str(row["evidence_quote"]),
                        float(row["source_quality"]),
                        evidence_id=str(row["id"]),
                    ),
                    cycle_key=derive_cycle_key(observation.get("raw_title"), season, opened_on),
                )
            )
        return items

    def archives(self, company_id: UUID, role_id: UUID | None) -> list[ArchiveInspection]:
        del role_id
        # Every capture, newest first. The 50 oldest used to stand in for them all, so "inspected N captures"
        # described the company's earliest archive rather than its archive.
        rows = fetch_all_rows(
            lambda: self.client.table("archive_captures")
            .select(
                "id,captured_at,completeness,is_partial,archive_url,evidence_excerpt,content_hash,"
                "raw_job_observations!inner(id,observed_at),sources!inner(company_id)"
            )
            .eq("sources.company_id", str(company_id))
            .order("captured_at", desc=True),
            key="id",
        )
        return [
            ArchiveInspection(
                capture_id=row["id"],
                captured_at=row["captured_at"],
                completeness=row["completeness"],
                is_partial=row["is_partial"],
                evidence=EvidenceRef(
                    id=str(row["id"]),
                    kind="archive",
                    source_url=row["archive_url"],
                    observed_at=cast(dict[str, Any], row["raw_job_observations"])["observed_at"],
                    content_hash=row["content_hash"],
                    summary=row["evidence_excerpt"],
                    reliability=float(row["completeness"]),
                ),
            )
            for row in rows
            if row.get("content_hash")
        ]

    def signals(self, company_id: UUID, role_id: UUID | None) -> list[RecruitingSignalFact]:
        def query() -> Any:
            built = (
                self.client.table("signals")
                .select(
                    "id,kind,observed_at,claimed_event_at,strength,reliability,source_url,evidence_quote,"
                    "raw_job_observations!inner(content_hash)"
                )
                .eq("company_id", str(company_id))
            )
            if role_id:
                built = built.or_(f"canonical_role_id.eq.{role_id},canonical_role_id.is.null")
            return built.order("observed_at", desc=True)

        rows = fetch_all_rows(query, key="id")
        return [
            RecruitingSignalFact(
                signal_id=row["id"],
                signal_type=row["kind"],
                observed_at=row["observed_at"],
                strength=row["strength"],
                reliability=row["reliability"],
                claimed_event_at=row.get("claimed_event_at"),
                evidence=EvidenceRef(
                    id=str(row["id"]),
                    kind="signal",
                    source_url=row["source_url"],
                    observed_at=row["observed_at"],
                    content_hash=cast(dict[str, Any], row["raw_job_observations"])["content_hash"],
                    summary=row["evidence_quote"],
                    reliability=row["reliability"],
                ),
            )
            for row in rows
        ]

    def generate_forecast(self, role_id: UUID, as_of: date) -> ForecastResult:
        # bounded: one row, today's newest forecast for the role, with its id breaking a tie on forecasted_at.
        rows = cast(
            list[dict[str, Any]],
            self.client.table("forecasts")
            .select("*")
            .eq("canonical_role_id", str(role_id))
            .eq("as_of", as_of.isoformat())
            .order("forecasted_at", desc=True)
            .order("id", desc=True)
            .limit(1)
            .execute()
            .data
            or [],
        )
        refused_at = self.repository.forecast_refused_at(role_id)
        # A forecast from before the model last declined the role is history, not an answer (migration 202608140043).
        if rows and forecast_is_current(parse_timestamp(rows[0]["forecasted_at"]) or datetime.min.replace(tzinfo=UTC), refused_at):
            stored = rows[0]
            return self._forecast_result(stored, role_id, as_of, cached=True).model_copy(
                update=basis_weights(cast(list[dict[str, Any]], stored.get("feature_contributions") or []))
            )
        forecast = self.repository.build_current_forecast(role_id, as_of=as_of)
        previous = self.repository.current_forecast_version(role_id)
        if previous is not None and previous.forecast.input_fingerprint == forecast.input_fingerprint:
            # Same inputs as the stored version: reuse it instead of writing a duplicate each day.
            return self._forecast_from_model(previous.id, role_id, as_of, previous.forecast).model_copy(
                update={"cached": True}
            )
        forecast_id = self.repository.save_agent_forecast_version(role_id, forecast, as_of=as_of)
        return self._forecast_from_model(forecast_id, role_id, as_of, forecast)

    def forecast_evidence(self, forecast_id: UUID) -> list[ForecastEvidenceFact]:
        # evidence_id is forecast_evidence's primary key, the view's only unique column (migration 202608140041).
        rows = fetch_all_rows(
            lambda: self.client.table("forecast_provenance").select("*").eq("forecast_id", str(forecast_id)),
            key="evidence_id",
        )
        return [
            ForecastEvidenceFact(
                forecast_id=forecast_id,
                contribution=row["contribution"],
                weight=row["weight"],
                rationale=row["rationale"],
                evidence=EvidenceRef(
                    id=str(
                        row.get("historical_opening_event_id")
                        or row.get("signal_id")
                        or row["observation_id"]
                    ),
                    kind="forecast",
                    source_url=row["source_url"],
                    observed_at=row["observed_at"],
                    content_hash=row["content_hash"],
                    summary=row["rationale"],
                    reliability=float(row["weight"]),
                ),
            )
            for row in rows
        ]

    @staticmethod
    def _posting_matches_role(role: dict[str, Any], raw_title: str) -> bool:
        """A current posting belongs to a role only on identifying words and a stated matching track.

        A shared company name or "at" is not identity, and a posting that shares "software
        engineer" with an internship but states no internship is not that internship's posting.
        """
        company = str(role.get("company_normalized") or "")
        if not identifying_title_tokens(str(role["canonical_title"]), company) & identifying_title_tokens(
            raw_title, company
        ):
            return False
        track = role.get("track")
        return track not in {"internship", "new_grad", "apprenticeship"} or title_level(raw_title) == track

    def _job(self, row: dict[str, Any]) -> CurrentJob:
        reliability = cast(dict[str, Any], row.get("source_reliability") or {}).get("score", 0.7)
        return CurrentJob(
            observation_id=row["id"],
            title=row["raw_title"],
            apply_url=row["apply_url"],
            location=row.get("location"),
            published_at=row.get("published_at"),
            first_seen_at=row["first_seen_at"],
            last_seen_at=row["last_seen_at"],
            evidence=self._evidence(
                row,
                "job",
                str(row["source_url"]),
                str(row.get("evidence_excerpt") or row["raw_title"]),
                float(reliability),
            ),
        )

    @staticmethod
    def _evidence(
        row: dict[str, Any],
        kind: Literal["job", "page", "history", "archive", "signal", "forecast"],
        source_url: str,
        summary: str,
        reliability: float = 0.7,
        *,
        evidence_id: str | None = None,
    ) -> EvidenceRef:
        return EvidenceRef(
            id=evidence_id or str(row["id"]),
            kind=kind,
            source_url=HttpUrl(source_url),
            observed_at=row["observed_at"],
            content_hash=row["content_hash"],
            summary=summary[:1_000],
            reliability=reliability,
        )

    @staticmethod
    def _forecast_result(row: dict[str, Any], role_id: UUID, as_of: date, *, cached: bool) -> ForecastResult:
        return ForecastResult(
            forecast_id=row["id"],
            role_id=role_id,
            as_of=as_of,
            expected_opening_date=row["point_date"],
            interval_start=row["window_start"],
            interval_end=row["window_end"],
            confidence=row["confidence"],
            calibrated_probability=row["calibrated_probability"],
            model_version=row["model_version"],
            history_count=row["history_count"],
            cached=cached,
        )

    @staticmethod
    def _forecast_from_model(
        forecast_id: UUID, role_id: UUID, as_of: date, forecast: Forecast
    ) -> ForecastResult:
        return ForecastResult(
            forecast_id=forecast_id,
            role_id=role_id,
            as_of=as_of,
            expected_opening_date=forecast.point_date,
            interval_start=forecast.window_start,
            interval_end=forecast.window_end,
            confidence=forecast.confidence,
            calibrated_probability=forecast.calibrated_probability,
            model_version=forecast.model_version,
            history_count=forecast.sample_size,
            cached=False,
            **basis_weights(forecast.feature_contributions),
        )


def basis_weights(contributions: Sequence[Any]) -> dict[str, float]:
    """A forecast's date weight from the program's own openings and from comparable programs: its basis.

    Read from the model's own contributions (a Forecast's `feature_contributions`, or the same list as stored on the
    forecast row), exactly as `forecast_basis` sums them in SQL and apps/web/lib/forecast-basis.ts reads them. Empty
    when the forecast carries no date-weighted contribution, so nothing is shown rather than a guess.
    """

    def field(item: Any, name: str) -> Any:
        return item.get(name) if isinstance(item, dict) else getattr(item, name, None)

    own = borrowed = 0.0
    for item in contributions:
        if not field(item, "influences_date"):
            continue
        kind = field(item, "kind")
        weight = float(field(item, "date_weight") or 0.0)
        if kind == "role_history":
            own += weight
        elif kind in ("company_prior", "role_family_prior"):
            borrowed += weight
    if own + borrowed <= 0:
        return {}
    return {"own_history_weight": min(1.0, max(0.0, own)), "borrowed_weight": min(1.0, max(0.0, borrowed))}


def redact_goal(goal: str) -> str:
    """Bound persisted state while removing common direct contact identifiers."""
    text = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "[email]", goal)
    text = re.sub(r"(?<!\d)(?:\+?\d[\d ()-]{7,}\d)(?!\d)", "[phone]", text)
    return text[:1_000]
