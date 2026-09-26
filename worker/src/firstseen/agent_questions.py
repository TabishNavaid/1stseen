"""Typed indexed-query tools for useful RecruitingAgent question classes."""

from __future__ import annotations

import calendar
import re
from collections import defaultdict
from datetime import date, timedelta
from functools import partial
from statistics import median
from typing import Any, Literal, Protocol, cast
from uuid import UUID

from pydantic import BaseModel, Field

from .cycles import derive_cycle_key, group_indices_into_cycles
from .forecast_currency import forecast_is_current, parse_timestamp
from .repository import fetch_all_rows

QuestionClass = Literal[
    "upcoming_openings",
    "prepare_now",
    "forecast_change",
    "confidence_explanation",
    "watched_networking",
    "earliest_companies",
    "referral_ready",
]


def _current(row: dict[str, Any]) -> bool:
    """Whether a forecast row, with its role's forecast_refused_at embedded, is newer than the role's last refusal."""
    role = cast(dict[str, Any], row.get("canonical_roles") or {})
    forecasted_at = parse_timestamp(row.get("forecasted_at"))
    return forecasted_at is None or forecast_is_current(forecasted_at, parse_timestamp(role.get("forecast_refused_at")))


def _in_product(role: dict[str, Any]) -> bool:
    """Only an active, in-scope role is answered about: a retired or withdrawn one is not (migration 202608140036)."""
    return role.get("scope_status") == "in_scope" and role.get("active") is True


# An id list sent as an IN() filter is split so each request stays well inside URL limits.
_ID_CHUNK = 100


def _chunks(values: list[str], size: int = _ID_CHUNK) -> list[list[str]]:
    return [values[index : index + size] for index in range(0, len(values), size)]


def _read_in(
    client: Any, table: str, columns: str, column: str, values: list[str], *, key: str = "id"
) -> list[dict[str, Any]]:
    """Every row whose `column` is in `values`: the id list chunked, each chunk paged over the table's key."""
    rows: list[dict[str, Any]] = []
    for chunk in _chunks(values):
        rows += fetch_all_rows(
            partial(lambda ids: client.table(table).select(columns).in_(column, ids), chunk), key=key
        )
    return rows


def confidence_phrase(value: float) -> str:
    """How an answer writes forecasting.py's score, as apps/web/lib/confidence.ts does: never with a percent sign."""
    return f"confidence score {round(value)} of 100"


def basis_phrase(own_weight: float | None, borrowed_weight: float | None) -> str | None:
    """Whether the window rests mainly on the program's own openings, as apps/web/lib/forecast-basis.ts says it."""
    own = own_weight or 0.0
    borrowed = borrowed_weight or 0.0
    if own + borrowed <= 0:
        return None
    share = own / (own + borrowed)
    if share >= 0.5:
        return f"based mainly on this program's own openings ({round(share * 100)}% of the weight)"
    return f"timing borrowed mainly from comparable programs ({round((1 - share) * 100)}% of the weight)"


def forecast_phrase(item: RoleForecastItem) -> str:
    """A forecast as its window with the expected date inside it, its score, and its basis. Never a bare date."""
    window = (
        f"window {item.interval_start:%B %-d} to {item.interval_end:%B %-d, %Y}, "
        f"expected {item.expected_opening_date:%B %-d, %Y}"
    )
    parts = [window, confidence_phrase(item.confidence)]
    basis = basis_phrase(item.own_history_weight, item.borrowed_weight)
    if basis:
        parts.append(basis)
    return "; ".join(parts)


class RoleForecastItem(BaseModel):
    company_id: UUID
    company: str
    role_id: UUID
    role: str
    track: Literal["internship", "new_grad", "apprenticeship"]
    forecast_id: UUID
    expected_opening_date: date
    interval_start: date
    interval_end: date
    confidence: float = Field(ge=0, le=100)
    as_of: date
    model_version: str
    # The forecast's persisted date weight from the program's own openings and from comparable programs: its basis.
    own_history_weight: float | None = Field(default=None, ge=0, le=1)
    borrowed_weight: float | None = Field(default=None, ge=0, le=1)


class PreparationItem(BaseModel):
    company: str
    role_id: UUID
    role: str
    action: Literal["resume", "networking", "referral", "portfolio", "monitoring"]
    due_on: date
    forecast_id: UUID
    reason: str


class ForecastChangeTrigger(BaseModel):
    signal_id: UUID
    signal_type: str
    observed_at: date
    strength: float = Field(ge=0, le=1)
    reliability: float = Field(ge=0, le=1)
    evidence_snippet: str


class ForecastChangeItem(BaseModel):
    role_id: UUID
    role: str
    company: str
    before_forecast_id: UUID
    after_forecast_id: UUID
    expected_date_before: date
    expected_date_after: date
    confidence_before: float = Field(ge=0, le=100)
    confidence_after: float = Field(ge=0, le=100)
    confidence_delta: float
    point_date_delta_days: int
    interval_start_delta_days: int
    interval_end_delta_days: int
    trigger_signal_ids: tuple[UUID, ...]
    trigger_signals: tuple[ForecastChangeTrigger, ...]
    reasons: tuple[str, ...]


class ConfidenceFactorItem(BaseModel):
    name: str
    value: float
    effect: Literal["supports", "limits", "neutral"]
    explanation: str


class ConfidenceExplanationItem(BaseModel):
    role_id: UUID
    role: str
    company: str
    forecast_id: UUID
    confidence: float = Field(ge=0, le=100)
    history_count: int = Field(ge=0)
    interval_width_days: int = Field(ge=0)
    factors: tuple[ConfidenceFactorItem, ...]
    model_version: str


class CompanyTimingItem(BaseModel):
    company_id: UUID
    company: str
    typical_opening_month: int = Field(ge=1, le=12)
    typical_opening_day: int = Field(ge=1, le=31)
    historical_cycle_count: int = Field(ge=1)
    earliest_observed_date: date


class UsefulQuestionResult(BaseModel):
    question_class: QuestionClass
    as_of: date
    summary: str
    items: list[
        RoleForecastItem
        | PreparationItem
        | ForecastChangeItem
        | ConfidenceExplanationItem
        | CompanyTimingItem
    ] = Field(default_factory=list)
    stale_role_count: int = Field(default=0, ge=0)
    limitations: tuple[str, ...] = ()


class UsefulQuestionIntent(BaseModel):
    question_class: QuestionClass
    horizon_days: int = Field(default=30, ge=1, le=365)
    requires_role: bool = False
    requires_user: bool = False

    @classmethod
    def parse(cls, goal: str) -> UsefulQuestionIntent | None:
        lowered = goal.casefold()
        horizon = _horizon_days(lowered)
        if "forecast" in lowered and "change" in lowered and "why" in lowered:
            return cls(question_class="forecast_change", requires_role=True)
        if "confidence" in lowered and "why" in lowered:
            return cls(question_class="confidence_explanation", requires_role=True)
        # "Which companies open earliest?" asks the same as "What companies historically recruit earliest?"; it used to
        # need the word "historically", and without it fell through to company matching.
        if (
            "compan" in lowered
            and any(term in lowered for term in ("earliest", "first", "soonest"))
            and any(term in lowered for term in ("historically", "open", "recruit", "post", "hire", "hiring"))
        ):
            return cls(question_class="earliest_companies")
        if "watched" in lowered and "network" in lowered:
            return cls(question_class="watched_networking", requires_user=True)
        if "referral" in lowered and any(term in lowered for term in ("soon", "ready", "should have")):
            return cls(question_class="referral_ready", horizon_days=horizon, requires_user=True)
        # "When will <a program> open, and what should I prepare?" is about one program: the forecast path answers it
        # and plans preparation for that program. The watchlist-wide question is the one that asks no "when ... open".
        asks_when_it_opens = "when" in lowered and "open" in lowered
        if not asks_when_it_opens and any(
            phrase in lowered
            for phrase in ("what should i be preparing", "what should i prepare", "preparing for right now")
        ):
            return cls(question_class="prepare_now", horizon_days=horizon, requires_user=True)
        if "internship" in lowered and "next" in lowered and "days" in lowered:
            return cls(question_class="upcoming_openings", horizon_days=horizon)
        return None

    @classmethod
    def from_choice(cls, question_class: str, horizon_days: int) -> UsefulQuestionIntent | None:
        """Build an intent from a closed-vocabulary interpretation.

        The role/user requirements come from this table, never from the caller,
        so an interpretation can select a question class but cannot relax the
        identity requirements that keep watchlist answers user-scoped.
        """
        requirements: dict[str, tuple[bool, bool]] = {
            # question_class: (requires_role, requires_user)
            "upcoming_openings": (False, False),
            "prepare_now": (False, True),
            "forecast_change": (True, False),
            "confidence_explanation": (True, False),
            "watched_networking": (False, True),
            "earliest_companies": (False, False),
            "referral_ready": (False, True),
        }
        requirement = requirements.get(question_class)
        if requirement is None:
            return None
        requires_role, requires_user = requirement
        return cls(
            question_class=cast(QuestionClass, question_class),
            horizon_days=max(1, min(365, horizon_days)),
            requires_role=requires_role,
            requires_user=requires_user,
        )


class PortfolioQueryStore(Protocol):
    def upcoming_openings(self, as_of: date, horizon_days: int) -> UsefulQuestionResult: ...

    def preparation_priorities(
        self, as_of: date, horizon_days: int, user_id: UUID
    ) -> UsefulQuestionResult: ...

    def forecast_change(self, role_id: UUID, as_of: date) -> UsefulQuestionResult: ...

    def confidence_explanation(self, role_id: UUID, as_of: date) -> UsefulQuestionResult: ...

    def watched_networking(self, as_of: date, user_id: UUID) -> UsefulQuestionResult: ...

    def earliest_companies(self, as_of: date) -> UsefulQuestionResult: ...

    def referral_ready(self, as_of: date, horizon_days: int, user_id: UUID) -> UsefulQuestionResult: ...


class UsefulQuestionTools:
    def __init__(self, store: PortfolioQueryStore) -> None:
        self.store = store

    def answer(
        self,
        intent: UsefulQuestionIntent,
        *,
        as_of: date,
        user_id: UUID | None,
        role_id: UUID | None,
    ) -> UsefulQuestionResult:
        if intent.requires_user and user_id is None:
            return UsefulQuestionResult(
                question_class=intent.question_class,
                as_of=as_of,
                summary="This question needs a signed-in watchlist before it can be answered.",
                limitations=("No user identity was available for the watchlist query.",),
            )
        if intent.requires_role and role_id is None:
            return UsefulQuestionResult(
                question_class=intent.question_class,
                as_of=as_of,
                summary="I could not resolve one recurring role for this explanation.",
                limitations=("The question did not resolve to one canonical recurring role.",),
            )
        if intent.question_class == "upcoming_openings":
            return self.store.upcoming_openings(as_of, intent.horizon_days)
        if intent.question_class == "prepare_now":
            return self.store.preparation_priorities(as_of, intent.horizon_days, cast(UUID, user_id))
        if intent.question_class == "forecast_change":
            return self.store.forecast_change(cast(UUID, role_id), as_of)
        if intent.question_class == "confidence_explanation":
            return self.store.confidence_explanation(cast(UUID, role_id), as_of)
        if intent.question_class == "watched_networking":
            return self.store.watched_networking(as_of, cast(UUID, user_id))
        if intent.question_class == "earliest_companies":
            return self.store.earliest_companies(as_of)
        return self.store.referral_ready(as_of, intent.horizon_days, cast(UUID, user_id))


def _verified_on(row: dict[str, Any]) -> date | None:
    """The day this forecast was last recomputed and confirmed, changed or not.

    Freshness is this, not the row's age. `as_of` is a forecast input, so a forecast used to be rewritten every night
    whether or not anything had been learned, and a seven-day window on the row's own date happened to work because of
    it. Now an identical recompute updates `last_verified_at` instead of storing a duplicate (migration 202608140053),
    so measuring the row's age would call a forecast confirmed this morning stale. A row written before that column
    existed falls back to when it was written, which is what a backfill would have set it to.
    """
    stamp = parse_timestamp(row.get("last_verified_at")) or parse_timestamp(row.get("forecasted_at"))
    return stamp.date() if stamp else None


class SupabasePortfolioQueries:
    """Indexed database questions; never performs fresh network collection."""

    forecast_freshness_days = 7

    def __init__(self, client: Any) -> None:
        self.client = client

    def upcoming_openings(self, as_of: date, horizon_days: int) -> UsefulQuestionResult:
        forecasts, stale = self._latest_forecasts(as_of)
        end = as_of + timedelta(days=horizon_days)
        items = [
            item
            for item in forecasts
            if item.track == "internship"
            and item.interval_start <= end
            and item.interval_end >= as_of
            and item.expected_opening_date <= end
        ]
        items.sort(key=lambda item: (item.expected_opening_date, -item.confidence, item.company, item.role))
        limitation = (
            (
                f"{stale} role(s) were excluded because their latest forecast was more than "
                f"{self.forecast_freshness_days} days old."
            )
            if stale
            else None
        )
        summary = (
            f"{len(items)} internship forecast(s) have opening windows overlapping the next "
            f"{horizon_days} days."
        )
        return UsefulQuestionResult(
            question_class="upcoming_openings",
            as_of=as_of,
            summary=summary,
            items=cast(Any, items),
            stale_role_count=stale,
            limitations=(limitation,) if limitation else (),
        )

    def preparation_priorities(self, as_of: date, horizon_days: int, user_id: UUID) -> UsefulQuestionResult:
        watched = self._watched_role_ids(user_id)
        items = self._workback_items(as_of, horizon_days, watched, user_id, overdue_days=14)
        plural = "" if len(items) == 1 else "s"
        summary = f"{len(items)} prep step{plural} for the programs you watch are due now or soon."
        return UsefulQuestionResult(
            question_class="prepare_now",
            as_of=as_of,
            summary=summary,
            items=cast(Any, items),
            limitations=() if watched else ("The watchlist is empty.",),
        )

    def forecast_change(self, role_id: UUID, as_of: date) -> UsefulQuestionResult:
        # This role's own changes. The 50 newest changes across every role used to be read and scanned for this one,
        # so a role whose last change was older than 50 others' said it had never changed.
        forecast_ids = [
            str(row["id"])
            for row in fetch_all_rows(
                lambda: self.client.table("forecasts").select("id").eq("canonical_role_id", str(role_id)), key="id"
            )
        ]
        change_rows = _read_in(self.client, "forecast_changes", "*", "after_forecast_id", forecast_ids)
        change_rows.sort(key=lambda row: (str(row["created_at"]), str(row["id"])), reverse=True)
        for row in change_rows:
            before = self._forecast_row(UUID(str(row["before_forecast_id"])))
            after = self._forecast_row(UUID(str(row["after_forecast_id"])))
            if not before or not after or str(after["canonical_role_id"]) != str(role_id):
                continue
            role, company = self._role_company(role_id)
            trigger_ids = tuple(UUID(str(value)) for value in row["trigger_signal_ids"])
            signal_rows = _read_in(
                self.client,
                "signals",
                "id,kind,observed_at,strength,reliability,evidence_quote",
                "id",
                [str(value) for value in trigger_ids],
            )
            triggers = tuple(
                ForecastChangeTrigger(
                    signal_id=value["id"],
                    signal_type=value["kind"],
                    observed_at=date.fromisoformat(str(value["observed_at"])[:10]),
                    strength=value["strength"],
                    reliability=value["reliability"],
                    evidence_snippet=str(value["evidence_quote"])[:500],
                )
                for value in signal_rows
            )
            item = ForecastChangeItem(
                role_id=role_id,
                role=role,
                company=company,
                before_forecast_id=row["before_forecast_id"],
                after_forecast_id=row["after_forecast_id"],
                expected_date_before=before["point_date"],
                expected_date_after=after["point_date"],
                confidence_before=before["confidence"],
                confidence_after=after["confidence"],
                confidence_delta=row["confidence_delta"],
                point_date_delta_days=row["point_date_delta_days"],
                interval_start_delta_days=row["interval_start_delta_days"],
                interval_end_delta_days=row["interval_end_delta_days"],
                trigger_signal_ids=trigger_ids,
                trigger_signals=triggers,
                reasons=tuple(str(value) for value in row["reasons"]),
            )
            movement = (
                f"expected date moved {item.point_date_delta_days:+d} day(s) and confidence moved "
                f"{item.confidence_delta:+.1f} points"
            )
            signal_types = ", ".join(sorted({trigger.signal_type for trigger in triggers}))
            return UsefulQuestionResult(
                question_class="forecast_change",
                as_of=as_of,
                summary=(
                    f"The latest {company} {role} forecast changed because of "
                    f"{len(item.trigger_signal_ids)} persisted signal(s)"
                    f"{f' ({signal_types})' if signal_types else ''}: {movement}."
                ),
                items=[item],
            )
        return UsefulQuestionResult(
            question_class="forecast_change",
            as_of=as_of,
            summary="No persisted forecast change was found for this role.",
            limitations=("There is no before/after forecast lineage to explain.",),
        )

    def confidence_explanation(self, role_id: UUID, as_of: date) -> UsefulQuestionResult:
        # bounded: one row, the role's latest forecast, with its id breaking a tie on as_of and forecasted_at.
        rows = cast(
            list[dict[str, Any]],
            self.client.table("forecasts")
            .select("*,canonical_roles!inner(forecast_refused_at)")
            .eq("canonical_role_id", str(role_id))
            .order("as_of", desc=True)
            .order("forecasted_at", desc=True)
            .order("id", desc=True)
            .limit(1)
            .execute()
            .data
            or [],
        )
        # A forecast from before the model last declined the role is history (migration 202608140043).
        if rows and not _current(rows[0]):
            rows = []
        if not rows:
            return UsefulQuestionResult(
                question_class="confidence_explanation",
                as_of=as_of,
                summary="No current statistical forecast exists for this role.",
                limitations=("Confidence cannot be explained without a forecast record.",),
            )
        row = rows[0]
        role, company = self._role_company(role_id)
        factors = tuple(
            _confidence_factor(str(name), float(value))
            for name, value in cast(dict[str, Any], row["confidence_factors"]).items()
        )
        limiting = sorted((factor for factor in factors if factor.effect == "limits"), key=lambda x: x.value)
        item = ConfidenceExplanationItem(
            role_id=role_id,
            role=role,
            company=company,
            forecast_id=row["id"],
            confidence=row["confidence"],
            history_count=row["history_count"],
            interval_width_days=(
                date.fromisoformat(str(row["window_end"])) - date.fromisoformat(str(row["window_start"]))
            ).days,
            factors=factors,
            model_version=row["model_version"],
        )
        reason = ", ".join(factor.name.replace("_", " ") for factor in limiting[:3])
        summary = (
            f"The forecast's {confidence_phrase(item.confidence)} is held back most by {reason}."
            if reason
            else f"The forecast's {confidence_phrase(item.confidence)}; no factor is below the limiting threshold."
        )
        return UsefulQuestionResult(
            question_class="confidence_explanation", as_of=as_of, summary=summary, items=[item]
        )

    def watched_networking(self, as_of: date, user_id: UUID) -> UsefulQuestionResult:
        watched = self._watched_role_ids(user_id)
        month_end = date(as_of.year, as_of.month, calendar.monthrange(as_of.year, as_of.month)[1])
        items = [
            item
            for item in self._workback_items(as_of, (month_end - as_of).days, watched, user_id)
            if item.action == "networking" and as_of <= item.due_on <= month_end
        ]
        return UsefulQuestionResult(
            question_class="watched_networking",
            as_of=as_of,
            summary=f"{len(items)} watched role(s) reach their networking deadline this month.",
            items=cast(Any, items),
            limitations=() if watched else ("The watchlist is empty.",),
        )

    def earliest_companies(self, as_of: date) -> UsefulQuestionResult:
        """Companies ranked by when their programs typically open, counted in recruiting cycles.

        Read every dated opening of an in-scope, active role, paged: the answer used to rank from the first 1,000 of
        9,383 events. Collapse each role's openings into recruiting cycles exactly as forecasting does (cycles.py:
        postings naming the same cohort are one cycle, and unkeyed openings less than 300 days apart are one), so a
        repost is never counted as a year. Only exact and bounded openings say when a program opened; an archive
        capture that merely saw it (observed_by) is left out rather than promoted to an opening date.
        """
        rows = fetch_all_rows(
            lambda: self.client.table("historical_opening_events")
            .select(
                "id,canonical_role_id,opened_on,"
                "raw_job_observations!inner(raw_title),"
                "canonical_roles!inner(company_id,recruiting_season,scope_status,active,companies!inner(name))"
            )
            .eq("canonical_roles.scope_status", "in_scope")
            .eq("canonical_roles.active", True)
            .in_("date_precision", ["exact", "bounded"]),
            key="id",
        )
        openings_by_role: dict[str, list[tuple[date, str, str | None]]] = defaultdict(list)
        company_of: dict[str, tuple[UUID, str]] = {}
        for row in rows:
            role = cast(dict[str, Any], row["canonical_roles"])
            if not _in_product(role):
                continue
            role_id = str(row["canonical_role_id"])
            opened_on = date.fromisoformat(str(row["opened_on"]))
            title = str(cast(dict[str, Any], row.get("raw_job_observations") or {}).get("raw_title") or "")
            cohort = derive_cycle_key(title, str(role.get("recruiting_season") or "unknown"), opened_on)
            openings_by_role[role_id].append((opened_on, str(row["id"]), cohort))
            company_of[role_id] = (UUID(str(role["company_id"])), str(cast(dict[str, Any], role["companies"])["name"]))

        cycle_dates: dict[tuple[UUID, str], list[date]] = defaultdict(list)
        for role_id, openings in openings_by_role.items():
            ordered = sorted(openings)
            assignments = group_indices_into_cycles([(opened_on, cohort) for opened_on, _, cohort in ordered])
            first_opening: dict[int, date] = {}
            for cycle, (opened_on, _, _) in zip(assignments, ordered, strict=True):
                first_opening[cycle] = min(first_opening.get(cycle, opened_on), opened_on)
            cycle_dates[company_of[role_id]].extend(first_opening.values())

        items: list[CompanyTimingItem] = []
        for (company_id, company_name), dates in cycle_dates.items():
            if len(dates) < 2:
                continue
            typical_day = round(median(value.timetuple().tm_yday for value in dates))
            reference = date(2024, 1, 1) + timedelta(days=min(365, typical_day - 1))
            items.append(
                CompanyTimingItem(
                    company_id=company_id,
                    company=company_name,
                    typical_opening_month=reference.month,
                    typical_opening_day=reference.day,
                    historical_cycle_count=len(dates),
                    earliest_observed_date=min(dates),
                )
            )
        items.sort(key=lambda item: (item.typical_opening_month, item.typical_opening_day, item.company))
        return UsefulQuestionResult(
            question_class="earliest_companies",
            as_of=as_of,
            summary=f"Ranked {len(items)} companies with at least two recorded recruiting cycles across their programs.",
            items=cast(Any, items),
            limitations=(
                "Calendar-year ranking is shown; recruiting seasons that cross New Year require contextual comparison.",
                "Counted in recruiting cycles, not postings: reposts of one cohort count once.",
                (
                    "Only openings with an exact or bounded date count. A date an archive merely saw a program by "
                    "does not say when it opened."
                ),
            ),
        )

    def referral_ready(self, as_of: date, horizon_days: int, user_id: UUID) -> UsefulQuestionResult:
        watched = self._watched_role_ids(user_id)
        items = [
            item
            for item in self._workback_items(as_of, horizon_days, watched, user_id)
            if item.action == "referral"
        ]
        return UsefulQuestionResult(
            question_class="referral_ready",
            as_of=as_of,
            summary=f"{len(items)} watched role(s) need a referral ready within {horizon_days} days.",
            items=cast(Any, items),
            limitations=() if watched else ("The watchlist is empty.",),
        )

    def _latest_forecasts(
        self, as_of: date, role_ids: set[UUID] | None = None
    ) -> tuple[list[RoleForecastItem], int]:
        columns = (
            "id,canonical_role_id,as_of,point_date,window_start,window_end,confidence,model_version,forecasted_at,"
            "last_verified_at,"
            "canonical_roles!inner(canonical_title,track,company_id,scope_status,active,forecast_refused_at,"
            "companies!inner(name))"
        )
        # Every forecast version up to as_of, paged: there are hundreds, and the latest per role is chosen below.
        if role_ids is None:
            rows = fetch_all_rows(
                lambda: self.client.table("forecasts").select(columns).lte("as_of", as_of.isoformat()), key="id"
            )
        else:
            if not role_ids:
                return [], 0
            rows = _read_in(self.client, "forecasts", columns, "canonical_role_id", [str(value) for value in role_ids])
            rows = [row for row in rows if str(row["as_of"]) <= as_of.isoformat()]
        # Newest first, as the query used to order it, with the id as the tiebreak it lacked.
        rows.sort(key=lambda row: (str(row["as_of"]), str(row.get("forecasted_at") or ""), str(row["id"])), reverse=True)
        seen: set[UUID] = set()
        items: list[RoleForecastItem] = []
        stale = 0
        for row in rows:
            role_id = UUID(str(row["canonical_role_id"]))
            if role_id in seen:
                continue
            seen.add(role_id)
            if not _current(row):
                # The model has declined the role since this, its latest forecast: it has no current forecast.
                continue
            # The forecast's own as_of is what the item reports; freshness is when it was last confirmed.
            forecast_as_of = date.fromisoformat(str(row["as_of"]))
            verified_on = _verified_on(row)
            if verified_on is None or (as_of - verified_on).days > self.forecast_freshness_days:
                stale += 1
                continue
            role = cast(dict[str, Any], row["canonical_roles"])
            if not _in_product(role):
                continue
            company = cast(dict[str, Any], role["companies"])
            items.append(
                RoleForecastItem(
                    company_id=role["company_id"],
                    company=company["name"],
                    role_id=role_id,
                    role=role["canonical_title"],
                    track=cast(Any, role["track"]),
                    forecast_id=row["id"],
                    expected_opening_date=row["point_date"],
                    interval_start=row["window_start"],
                    interval_end=row["window_end"],
                    confidence=row["confidence"],
                    as_of=forecast_as_of,
                    model_version=row["model_version"],
                )
            )
        return self._with_basis(items), stale

    def _with_basis(self, items: list[RoleForecastItem]) -> list[RoleForecastItem]:
        """Each forecast's basis, summed in SQL from the model's own weights (forecast_basis_for_forecasts)."""
        weights: dict[str, tuple[float, float]] = {}
        ids = [str(item.forecast_id) for item in items]
        for chunk in _chunks(ids, 1000):
            # bounded: the function takes at most 1000 forecast ids and returns one row per id.
            rows = cast(
                list[dict[str, Any]],
                self.client.rpc("forecast_basis_for_forecasts", {"p_forecast_ids": chunk}).execute().data or [],
            )
            for row in rows:
                weights[str(row["forecast_id"])] = (float(row["own_weight"]), float(row["borrowed_weight"]))
        return [
            item.model_copy(
                update={
                    "own_history_weight": min(1.0, max(0.0, weights[str(item.forecast_id)][0])),
                    "borrowed_weight": min(1.0, max(0.0, weights[str(item.forecast_id)][1])),
                }
            )
            if str(item.forecast_id) in weights
            else item
            for item in items
        ]

    def _workback_items(
        self,
        as_of: date,
        horizon_days: int,
        role_ids: set[UUID],
        user_id: UUID,
        *,
        overdue_days: int = 0,
    ) -> list[PreparationItem]:
        if not role_ids:
            return []
        end = as_of + timedelta(days=max(0, horizon_days))
        rows: list[dict[str, Any]] = []
        for chunk in _chunks([str(value) for value in role_ids]):
            rows += fetch_all_rows(
                partial(
                    lambda ids: self.client.table("readiness_milestones")
                    .select(
                        "id,canonical_role_id,forecast_id,kind,due_on,rationale,"
                        "forecasts!inner(as_of,forecasted_at,last_verified_at),"
                        "canonical_roles!inner(canonical_title,scope_status,active,companies!inner(name))"
                    )
                    .eq("user_id", str(user_id))
                    .in_("canonical_role_id", ids)
                    .gte("due_on", (as_of - timedelta(days=overdue_days)).isoformat())
                    .lte("due_on", end.isoformat()),
                    chunk,
                ),
                key="id",
            )
        action_by_kind = {
            "resume_ready": "resume",
            "networking": "networking",
            "referral_contacts": "referral",
            "portfolio_ready": "portfolio",
            "high_alert": "monitoring",
        }
        items: list[PreparationItem] = []
        for row in rows:
            action = action_by_kind.get(str(row["kind"]))
            forecast_row = cast(dict[str, Any], row["forecasts"])
            verified_on = _verified_on(forecast_row)
            if action is None or verified_on is None or (as_of - verified_on).days > self.forecast_freshness_days:
                continue
            role = cast(dict[str, Any], row["canonical_roles"])
            if not _in_product(role):
                continue
            company = cast(dict[str, Any], role["companies"])
            items.append(
                PreparationItem(
                    company=company["name"],
                    role_id=row["canonical_role_id"],
                    role=role["canonical_title"],
                    action=cast(Any, action),
                    due_on=row["due_on"],
                    forecast_id=row["forecast_id"],
                    reason=row["rationale"],
                )
            )
        items.sort(key=lambda item: (item.due_on, item.company, item.role, item.action))
        return items

    def _watched_role_ids(self, user_id: UUID) -> set[UUID]:
        rows = fetch_all_rows(
            lambda: self.client.table("watchlist_items")
            .select("target_type,company_id,canonical_role_id,role_family,track")
            .eq("user_id", str(user_id)),
            key="id",
        )
        direct = {
            UUID(str(row["canonical_role_id"]))
            for row in rows
            if row["target_type"] == "canonical_role" and row.get("canonical_role_id")
        }
        companies = {
            UUID(str(row["company_id"]))
            for row in rows
            if row["target_type"] == "company" and row.get("company_id")
        }
        families = {
            str(row["role_family"])
            for row in rows
            if row["target_type"] == "role_family" and row.get("role_family")
        }
        tracks = {str(row["track"]) for row in rows if row["target_type"] == "track" and row.get("track")}
        if not companies and not families and not tracks:
            return direct
        role_rows = fetch_all_rows(
            lambda: self.client.table("canonical_roles")
            .select("id,company_id,role_family,track")
            .eq("active", True)
            .eq("scope_status", "in_scope"),
            key="id",
        )
        return direct | {
            UUID(str(row["id"]))
            for row in role_rows
            if UUID(str(row["company_id"])) in companies
            or str(row["role_family"]) in families
            or str(row["track"]) in tracks
        }

    def _forecast_row(self, forecast_id: UUID) -> dict[str, Any] | None:
        # bounded: one row, the forecast by its primary key.
        rows = cast(
            list[dict[str, Any]],
            self.client.table("forecasts").select("*").eq("id", str(forecast_id)).limit(1).execute().data
            or [],
        )
        return rows[0] if rows else None

    def _role_company(self, role_id: UUID) -> tuple[str, str]:
        # bounded: one row, the role by its primary key.
        rows = cast(
            list[dict[str, Any]],
            self.client.table("canonical_roles")
            .select("canonical_title,companies!inner(name)")
            .eq("id", str(role_id))
            .limit(1)
            .execute()
            .data
            or [],
        )
        if not rows:
            return "Unknown role", "Unknown company"
        return str(rows[0]["canonical_title"]), str(cast(dict[str, Any], rows[0]["companies"])["name"])


def _horizon_days(goal: str) -> int:
    match = re.search(r"\bnext\s+(\d{1,3})\s+days?\b", goal)
    return min(365, max(1, int(match.group(1)))) if match else 30


def _confidence_factor(name: str, value: float) -> ConfidenceFactorItem:
    effect: Literal["supports", "limits", "neutral"]
    if name in {"signal_contradiction", "signal_conflict"}:
        if value <= 0.25:
            effect = "supports"
        elif value > 0.45:
            effect = "limits"
        else:
            effect = "neutral"
    elif value < 0.55:
        effect = "limits"
    elif value >= 0.75:
        effect = "supports"
    else:
        effect = "neutral"
    explanations = {
        "role_history_strength": "Amount and quality of role-specific historical evidence.",
        "prior_support": "Support borrowed from sourced company and role-family seasonality.",
        "cycle_consistency": "Consistency of opening dates across observed annual cycles.",
        "source_quality": "Reliability of the sources behind the opening evidence.",
        "evidence_recency": "How recently the historical pattern was observed.",
        "event_uncertainty_precision": "Precision of reconstructed historical opening dates.",
        "interval_precision": "How narrow the statistically generated prediction interval is.",
        "current_signal_support": "Recent supporting recruiting signals; signals do not move the date.",
        "signal_contradiction": "Degree to which current signals contradict recurrence evidence.",
        "signal_conflict": "Degree of disagreement among current signals.",
    }
    return ConfidenceFactorItem(
        name=name,
        value=value,
        effect=effect,
        explanation=explanations.get(name, "Versioned statistical confidence factor."),
    )
