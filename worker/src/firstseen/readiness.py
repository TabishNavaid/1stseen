"""Deterministic, explainable work-back planning for forecasted openings."""

from __future__ import annotations

from datetime import date, timedelta
from math import ceil
from typing import Any, Literal, Protocol
from uuid import UUID

from pydantic import BaseModel, Field, model_validator

CompanySize = Literal["startup", "small", "medium", "large", "enterprise", "unknown"]
MilestoneKind = Literal[
    "networking",
    "referral_contacts",
    "resume_ready",
    "portfolio_ready",
    "high_alert",
]

POLICY_VERSION = "readiness-workback-v1"


class ReadinessForecast(BaseModel):
    forecast_id: UUID | None = None
    role_id: UUID
    as_of: date
    expected_opening_date: date
    interval_start: date
    interval_end: date
    confidence: float = Field(ge=0, le=100)

    @model_validator(mode="after")
    def dates_are_ordered(self) -> ReadinessForecast:
        if not self.interval_start <= self.expected_opening_date <= self.interval_end:
            raise ValueError("expected opening date must be inside the prediction interval")
        if self.interval_end < self.as_of:
            raise ValueError("cannot create a readiness plan for an expired forecast interval")
        return self


class ReadinessContext(BaseModel):
    company_size: CompanySize = "unknown"
    recruiting_scale: float = Field(default=0.5, ge=0, le=1)
    role_competitiveness: float = Field(default=0.5, ge=0, le=1)
    role_family: str = Field(default="unknown", min_length=1)
    portfolio_required: bool | None = None


class MilestonePolicy(BaseModel):
    kind: MilestoneKind
    title: str
    base_lead_days: int = Field(ge=0)
    minimum_lead_days: int = Field(ge=0)


class ReadinessPolicy(BaseModel):
    version: str = POLICY_VERSION
    maximum_adjustment_days: int = Field(default=35, ge=0)
    minimum_adjustment_days: int = Field(default=-10, le=0)
    uncertainty_baseline_days: int = Field(default=14, ge=0)
    size_adjustments: dict[str, int] = Field(
        default_factory=lambda: {
            "startup": -7,
            "small": -3,
            "medium": 0,
            "large": 5,
            "enterprise": 9,
            "unknown": 0,
        }
    )
    portfolio_role_families: frozenset[str] = frozenset(
        {
            "software_engineering",
            "data_science",
            "machine_learning",
            "design",
            "product_design",
            "game_development",
        }
    )
    milestones: tuple[MilestonePolicy, ...] = (
        MilestonePolicy(
            kind="networking",
            title="Start targeted networking",
            base_lead_days=63,
            minimum_lead_days=28,
        ),
        MilestonePolicy(
            kind="referral_contacts",
            title="Identify potential referral contacts",
            base_lead_days=49,
            minimum_lead_days=21,
        ),
        MilestonePolicy(
            kind="portfolio_ready",
            title="Make portfolio and relevant projects review-ready",
            base_lead_days=35,
            minimum_lead_days=14,
        ),
        MilestonePolicy(
            kind="resume_ready",
            title="Finalize the role-specific resume",
            base_lead_days=28,
            minimum_lead_days=14,
        ),
        MilestonePolicy(
            kind="high_alert",
            title="Begin high-alert opening monitoring",
            base_lead_days=7,
            minimum_lead_days=3,
        ),
    )


class LeadTimeAdjustment(BaseModel):
    factor: Literal[
        "company_size",
        "recruiting_scale",
        "role_competitiveness",
        "forecast_interval_width",
        "forecast_confidence",
    ]
    days: int
    explanation: str


class ReadinessMilestone(BaseModel):
    kind: MilestoneKind
    title: str
    due_on: date
    ideal_due_on: date
    lead_days: int = Field(ge=0)
    is_immediate: bool
    rationale: str
    adjustments: tuple[LeadTimeAdjustment, ...]


class ReadinessPlan(BaseModel):
    role_id: UUID
    based_on_forecast_id: UUID | None
    policy_version: str
    generated_on: date
    expected_opening_date: date
    interval_start: date
    interval_end: date
    context: ReadinessContext
    total_adjustment_days: int
    milestones: tuple[ReadinessMilestone, ...]


class ApplicationReadinessPlanner:
    """Fixed-policy planner; no model or language-model calls are permitted."""

    def __init__(self, policy: ReadinessPolicy | None = None) -> None:
        self.policy = policy or ReadinessPolicy()

    def plan(self, forecast: ReadinessForecast, context: ReadinessContext) -> ReadinessPlan:
        adjustments = self._adjustments(forecast, context)
        raw_adjustment = sum(item.days for item in adjustments)
        total_adjustment = min(
            self.policy.maximum_adjustment_days,
            max(self.policy.minimum_adjustment_days, raw_adjustment),
        )
        portfolio_required = (
            context.portfolio_required
            if context.portfolio_required is not None
            else context.role_family in self.policy.portfolio_role_families
        )
        milestones: list[ReadinessMilestone] = []
        for item in self.policy.milestones:
            if item.kind == "portfolio_ready" and not portfolio_required:
                continue
            lead_days = max(item.minimum_lead_days, item.base_lead_days + total_adjustment)
            ideal_due_on = forecast.interval_start - timedelta(days=lead_days)
            is_immediate = ideal_due_on < forecast.as_of
            due_on = forecast.as_of if is_immediate else ideal_due_on
            timing_note = (
                f"The ideal date was {ideal_due_on.isoformat()}, which has passed, so this is due now."
                if is_immediate
                else f"This places the milestone {lead_days} days before the interval starts."
            )
            milestones.append(
                ReadinessMilestone(
                    kind=item.kind,
                    title=item.title,
                    due_on=due_on,
                    ideal_due_on=ideal_due_on,
                    lead_days=lead_days,
                    is_immediate=is_immediate,
                    rationale=(
                        f"Policy base: {item.base_lead_days} days; explainable factor adjustment: "
                        f"{total_adjustment:+d} days. {timing_note}"
                    ),
                    adjustments=adjustments,
                )
            )
        milestones.sort(key=lambda item: (item.due_on, -item.lead_days, item.kind))
        return ReadinessPlan(
            role_id=forecast.role_id,
            based_on_forecast_id=forecast.forecast_id,
            policy_version=self.policy.version,
            generated_on=forecast.as_of,
            expected_opening_date=forecast.expected_opening_date,
            interval_start=forecast.interval_start,
            interval_end=forecast.interval_end,
            context=context,
            total_adjustment_days=total_adjustment,
            milestones=tuple(milestones),
        )

    def _adjustments(
        self, forecast: ReadinessForecast, context: ReadinessContext
    ) -> tuple[LeadTimeAdjustment, ...]:
        interval_width = (forecast.interval_end - forecast.interval_start).days
        size_days = self.policy.size_adjustments[context.company_size]
        scale_days = round((context.recruiting_scale - 0.5) * 14)
        competition_days = round((context.role_competitiveness - 0.5) * 18)
        uncertainty_days = min(
            18,
            ceil(max(0, interval_width - self.policy.uncertainty_baseline_days) / 7) * 3,
        )
        confidence_days = min(16, ceil(max(0.0, 70 - forecast.confidence) / 5) * 2)
        return (
            LeadTimeAdjustment(
                factor="company_size",
                days=size_days,
                explanation=(
                    f"{context.company_size.title()} company policy changes lead time by {size_days:+d} days."
                ),
            ),
            LeadTimeAdjustment(
                factor="recruiting_scale",
                days=scale_days,
                explanation=(
                    f"Recruiting-scale score {context.recruiting_scale:.2f} changes lead time by "
                    f"{scale_days:+d} days."
                ),
            ),
            LeadTimeAdjustment(
                factor="role_competitiveness",
                days=competition_days,
                explanation=(
                    f"Role-competitiveness score {context.role_competitiveness:.2f} changes lead time by "
                    f"{competition_days:+d} days."
                ),
            ),
            LeadTimeAdjustment(
                factor="forecast_interval_width",
                days=uncertainty_days,
                explanation=(
                    f"The {interval_width}-day prediction interval adds {uncertainty_days} days so a "
                    "wider window starts preparation earlier."
                ),
            ),
            LeadTimeAdjustment(
                factor="forecast_confidence",
                days=confidence_days,
                explanation=(
                    # A confidence score is never written as a percentage (apps/web/lib/confidence.ts).
                    f"A confidence score of {forecast.confidence:.0f} of 100 adds {confidence_days} days when it is "
                    "below the policy baseline of 70."
                ),
            ),
        )


class ReadinessPlanStore(Protocol):
    def save_for_user(self, user_id: UUID, plan: ReadinessPlan) -> None: ...


class SupabaseReadinessPlanStore:
    """Persists versioned planner output for authenticated watchlist views."""

    def __init__(self, client: Any) -> None:
        self.client = client

    def save_for_user(self, user_id: UUID, plan: ReadinessPlan) -> None:
        if plan.based_on_forecast_id is None:
            return
        rows = [
            {
                "user_id": str(user_id),
                "canonical_role_id": str(plan.role_id),
                "forecast_id": str(plan.based_on_forecast_id),
                "kind": milestone.kind,
                "due_on": milestone.due_on.isoformat(),
                "ideal_due_on": milestone.ideal_due_on.isoformat(),
                "lead_days": milestone.lead_days,
                "policy_version": plan.policy_version,
                "rationale": milestone.rationale,
                "adjustments": [item.model_dump(mode="json") for item in milestone.adjustments],
                "window_start": plan.interval_start.isoformat(),
                "window_end": plan.interval_end.isoformat(),
            }
            for milestone in plan.milestones
        ]
        if rows:
            self.client.table("readiness_milestones").upsert(
                rows,
                on_conflict="user_id,forecast_id,kind,policy_version",
            ).execute()
