"""Leakage-safe rolling-origin evaluation for opening-window forecasts."""

from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Collection, Iterable, Sequence
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, timedelta
from hashlib import sha256
from statistics import mean, median
from typing import Literal, cast
from uuid import UUID, uuid4

from .cycles import ANNUAL_CYCLE_MIN_GAP_DAYS, group_indices_into_cycles
from .forecasting import (
    CompanySize,
    DatePrecision,
    HierarchicalCircularForecastModel,
    HistoricalOpening,
    OpeningWindowModel,
    SeasonalityPrior,
    Signal,
    SignalDirection,
)

SourceQualityBucket = Literal["low", "medium", "high"]
CYCLE_MERGE_DAYS = 45


def _aware(value: datetime) -> datetime:
    if value.tzinfo is None:
        raise ValueError("availability timestamps must be timezone-aware")
    return value.astimezone(UTC)


@dataclass(frozen=True)
class BacktestRole:
    id: str
    company_id: str
    role_family: str
    company_size: CompanySize = "unknown"
    recruiting_scale: float | None = None
    level: str = "unknown"
    recruiting_season: str = "unknown"

    def __post_init__(self) -> None:
        if not self.id or not self.company_id or not self.role_family:
            raise ValueError("backtest roles require id, company_id, and role_family")
        if self.recruiting_scale is not None and not 0 <= self.recruiting_scale <= 1:
            raise ValueError("recruiting_scale must be between 0 and 1")


@dataclass(frozen=True)
class BacktestEvent:
    """An opening plus the instant at which 1stSeen could first use its evidence."""

    id: str
    role_id: str
    opened_on: date
    available_at: datetime
    source_quality: float
    uncertainty_days: float | None = 0.0
    observation_id: str | None = None
    date_precision: DatePrecision = "exact"
    observation_available_at: datetime | None = None
    role_match_confidence: float = 1.0
    role_match_available_at: datetime | None = None
    opening_window_start: date | None = None
    opening_window_end: date | None = None
    # Explicit cohort stated by the source, e.g. "fall-2026". None means the source
    # did not identify a cohort, so distinctness from a nearby opening is unproven.
    cycle_key: str | None = None

    def __post_init__(self) -> None:
        if not self.id or not self.role_id:
            raise ValueError("backtest events require stable ids")
        _aware(self.available_at)
        if self.observation_available_at is not None:
            _aware(self.observation_available_at)
        if self.role_match_available_at is not None:
            _aware(self.role_match_available_at)
        if not 0 <= self.source_quality <= 1:
            raise ValueError("source_quality must be between 0 and 1")
        if self.uncertainty_days is not None and self.uncertainty_days < 0:
            raise ValueError("uncertainty_days cannot be negative")
        if not 0 <= self.role_match_confidence <= 1:
            raise ValueError("role_match_confidence must be between 0 and 1")
        HistoricalOpening(
            self.opened_on,
            self.source_quality,
            self.uncertainty_days,
            self.id,
            self.date_precision,
            self.role_match_confidence,
        )
        if self.opening_window_start and self.opening_window_start > self.opened_on:
            raise ValueError("opening_window_start cannot be after opened_on")
        if self.opening_window_end and self.opening_window_end < self.opened_on:
            raise ValueError("opening_window_end cannot be before opened_on")

    @property
    def effective_available_at(self) -> datetime:
        return max(
            _aware(self.available_at),
            _aware(self.observation_available_at or self.available_at),
            _aware(self.role_match_available_at or self.available_at),
        )

    @property
    def scoring_interval(self) -> tuple[date, date] | None:
        if self.date_precision == "observed_by":
            return None
        if self.date_precision == "exact":
            return self.opened_on, self.opened_on
        if self.opening_window_start and self.opening_window_end:
            return self.opening_window_start, self.opening_window_end
        half = int((self.uncertainty_days or 0) // 2)
        start = self.opened_on - timedelta(days=half)
        return start, start + timedelta(days=int(self.uncertainty_days or 0))

    def as_opening(self) -> HistoricalOpening:
        return HistoricalOpening(
            self.opened_on,
            source_quality=self.source_quality,
            uncertainty_days=self.uncertainty_days,
            evidence_id=self.id,
            date_precision=self.date_precision,
            role_match_confidence=self.role_match_confidence,
        )


@dataclass(frozen=True)
class BacktestSignal:
    id: str
    role_id: str
    observed_on: date
    available_at: datetime
    strength: float
    reliability: float
    kind: str
    direction: SignalDirection = "support"
    observation_available_at: datetime | None = None

    def __post_init__(self) -> None:
        if not self.id or not self.role_id or not self.kind:
            raise ValueError("backtest signals require id, role_id, and kind")
        _aware(self.available_at)
        if self.observation_available_at is not None:
            _aware(self.observation_available_at)
        if not 0 <= self.strength <= 1 or not 0 <= self.reliability <= 1:
            raise ValueError("signal strength and reliability must be between 0 and 1")

    @property
    def effective_available_at(self) -> datetime:
        return max(_aware(self.available_at), _aware(self.observation_available_at or self.available_at))

    def as_signal(self) -> Signal:
        return Signal(
            self.observed_on,
            self.strength,
            self.reliability,
            self.kind,
            self.direction,
            self.id,
        )


@dataclass(frozen=True)
class AggregateMetrics:
    case_count: int
    median_absolute_error_days: float | None
    mean_absolute_error_days: float | None
    interval_coverage: float | None
    average_interval_width_days: float | None


@dataclass(frozen=True)
class CalibrationBucket:
    label: str
    lower_bound: float
    upper_bound: float
    case_count: int
    average_confidence: float
    empirical_interval_coverage: float
    calibration_gap: float


@dataclass(frozen=True)
class GroupMetrics:
    group: str
    metrics: AggregateMetrics


@dataclass(frozen=True)
class BacktestCase:
    role_id: str
    target_event_id: str
    target_year: int
    forecast_cutoff: date
    actual_opened_on: date
    actual_interval_start: date
    actual_interval_end: date
    target_date_precision: DatePrecision
    expected_opening_date: date
    interval_start: date
    interval_end: date
    confidence: float
    absolute_error_days: int
    inside_interval: bool
    interval_width_days: int
    history_observations: int
    target_source_quality: float
    source_quality_bucket: SourceQualityBucket
    company_prior_observations: int
    role_family_prior_observations: int
    model_version: str
    input_fingerprint: str
    input_event_ids: tuple[str, ...]
    input_signal_ids: tuple[str, ...]
    latest_input_available_at: datetime


@dataclass(frozen=True)
class ReplayEvidence:
    id: str
    kind: Literal["role_history", "company_prior", "role_family_prior", "signal"]
    evidence_on: date
    available_at: datetime
    source_quality: float
    uncertainty_days: float | None


@dataclass(frozen=True)
class ForecastReplayResult:
    schema_version: str
    role_id: str
    target_event_id: str
    target_year: int
    forecast_cutoff: date
    forecasted_at: datetime
    evidence: tuple[ReplayEvidence, ...]
    expected_opening_date: date
    interval_start: date
    interval_end: date
    confidence: float
    actual_opened_on: date
    actual_interval_start: date
    actual_interval_end: date
    target_date_precision: DatePrecision
    absolute_error_days: int
    inside_interval: bool
    model_version: str
    input_fingerprint: str
    # The replayed forecast's date weight from the program's own openings and from comparable programs: its basis, as
    # the product shows it for every forecast (apps/web/lib/forecast-basis.ts). Summed from the model's contributions.
    own_history_weight: float = 0.0
    borrowed_weight: float = 0.0

    def __post_init__(self) -> None:
        if self.forecast_cutoff >= self.actual_opened_on:
            raise ValueError("replay cutoff must be before the held-out opening")
        if self.target_event_id in {item.id for item in self.evidence}:
            raise ValueError("held-out target cannot appear in replay evidence")
        if any(item.evidence_on > self.forecast_cutoff for item in self.evidence):
            raise ValueError("replay evidence date exceeds forecast cutoff")
        if any(_aware(item.available_at).date() > self.forecast_cutoff for item in self.evidence):
            raise ValueError("replay evidence availability exceeds forecast cutoff")
        if not self.actual_interval_start <= self.actual_opened_on <= self.actual_interval_end:
            raise ValueError("actual opening must lie inside its uncertainty interval")
        if self.target_date_precision == "observed_by":
            raise ValueError("observed-by targets cannot be quantitatively replayed")

    def to_dict(self) -> dict[str, object]:
        return cast(dict[str, object], _jsonable(asdict(self)))


@dataclass(frozen=True)
class SkippedTarget:
    role_id: str
    target_event_id: str
    target_year: int
    forecast_cutoff: date
    reason: str


@dataclass(frozen=True)
class BacktestRun:
    id: UUID
    schema_version: str
    model_version: str
    model_versions: tuple[str, ...]
    cutoff_days: int
    from_year: int | None
    to_year: int | None
    started_at: datetime
    finished_at: datetime
    dataset_fingerprint: str
    target_count: int
    completed_cases: int
    skipped_cases: int
    metrics: AggregateMetrics
    confidence_calibration: tuple[CalibrationBucket, ...]
    performance_by_history: tuple[GroupMetrics, ...]
    performance_by_source_quality: tuple[GroupMetrics, ...]
    cases: tuple[BacktestCase, ...]
    skipped_targets: tuple[SkippedTarget, ...]
    confidence_evaluation_target: str = "observed_opening_inside_prediction_interval"
    # Cycles of roles outside the product's scope are not targets; they still inform priors.
    out_of_scope_targets_excluded: int = 0

    def to_dict(self) -> dict[str, object]:
        return cast(dict[str, object], _jsonable(asdict(self)))

    def to_json(self, *, indent: int | None = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, sort_keys=True)


def _jsonable(value: object) -> object:
    if isinstance(value, (date, datetime, UUID)):
        return value.isoformat() if not isinstance(value, UUID) else str(value)
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(item) for item in value]
    return value


def _aggregate(cases: Sequence[BacktestCase]) -> AggregateMetrics:
    if not cases:
        return AggregateMetrics(0, None, None, None, None)
    errors = [item.absolute_error_days for item in cases]
    return AggregateMetrics(
        case_count=len(cases),
        median_absolute_error_days=round(float(median(errors)), 2),
        mean_absolute_error_days=round(mean(errors), 2),
        interval_coverage=round(mean(item.inside_interval for item in cases), 4),
        average_interval_width_days=round(mean(item.interval_width_days for item in cases), 2),
    )


def _source_bucket(quality: float) -> SourceQualityBucket:
    if quality < 0.60:
        return "low"
    if quality < 0.85:
        return "medium"
    return "high"


def _history_bucket(count: int) -> str:
    return str(count) if count < 4 else "4+"


def compatible_prior_role(target: BacktestRole, candidate: BacktestRole) -> bool:
    """Require known, matching recruiting populations before pooling seasonal evidence."""
    if target.level == "unknown" or candidate.level == "unknown" or target.level != candidate.level:
        return False
    return not (
        target.recruiting_season == "unknown"
        or candidate.recruiting_season == "unknown"
        or target.recruiting_season != candidate.recruiting_season
    )


def collapse_event_cycles(events: Iterable[BacktestEvent]) -> list[BacktestEvent]:
    """Reduce raw opening events to one representative per recruiting cycle.

    The model's `sample_size` is a count of cohorts, not requisition publications.
    Events sharing an explicit source-stated cohort collapse together however far
    apart they were published; events with no stated cohort collapse unless they are
    an annual distance apart, so same-year reposts and evergreen requisition
    refreshes cannot inflate history. See `cycles.CYCLE_IDENTITY_VERSION`.
    """
    grouped: dict[str, list[BacktestEvent]] = defaultdict(list)
    for event in events:
        grouped[event.role_id].append(event)
    collapsed: list[BacktestEvent] = []
    for role_events in grouped.values():
        ordered = sorted(role_events, key=lambda item: (item.opened_on, item.id))
        assignments = group_indices_into_cycles(
            [(item.opened_on, item.cycle_key) for item in ordered]
        )
        clusters: dict[int, list[BacktestEvent]] = defaultdict(list)
        for cycle, event in zip(assignments, ordered, strict=True):
            clusters[cycle].append(event)
        for cluster in clusters.values():
            # A cycle is dated by when it first opened. Clusters can now span months,
            # so the strongest-evidence record is only used to break ties on that
            # earliest date; it must not drag the cycle date later.
            earliest = min(item.opened_on for item in cluster)
            collapsed.append(
                min(
                    (item for item in cluster if item.opened_on == earliest),
                    key=_event_preference,
                )
            )
    return sorted(collapsed, key=lambda item: (item.opened_on, item.id))


def _same_cycle_as_target(event: BacktestEvent, target: BacktestEvent) -> bool:
    """Exclude every representation of the held-out cohort, not just nearby dates.

    A repost of the target cohort published months later is still the held-out
    outcome, so proximity alone is not a safe exclusion rule.
    """
    if event.role_id != target.role_id:
        return False
    if event.cycle_key is not None and target.cycle_key is not None:
        return event.cycle_key == target.cycle_key
    if event.cycle_key != target.cycle_key:
        # One side names a cohort and the other does not; fall back to proximity so
        # an unlabelled repost of the same cohort cannot leak in.
        return abs((event.opened_on - target.opened_on).days) < ANNUAL_CYCLE_MIN_GAP_DAYS
    return abs((event.opened_on - target.opened_on).days) < ANNUAL_CYCLE_MIN_GAP_DAYS


def _event_preference(item: BacktestEvent) -> tuple[object, ...]:
    return (
        -{"exact": 2, "bounded": 1, "observed_by": 0}[item.date_precision],
        -item.role_match_confidence,
        -item.source_quality,
        item.uncertainty_days if item.uncertainty_days is not None else float("inf"),
        item.effective_available_at,
        item.id,
    )


def _group_metrics(cases: Sequence[BacktestCase], key: str) -> tuple[GroupMetrics, ...]:
    grouped: dict[str, list[BacktestCase]] = defaultdict(list)
    for case in cases:
        group = _history_bucket(case.history_observations) if key == "history" else case.source_quality_bucket
        grouped[group].append(case)
    order = ["0", "1", "2", "3", "4+"] if key == "history" else ["low", "medium", "high"]
    return tuple(GroupMetrics(group, _aggregate(grouped[group])) for group in order)


def _calibration(cases: Sequence[BacktestCase]) -> tuple[CalibrationBucket, ...]:
    buckets: dict[int, list[BacktestCase]] = defaultdict(list)
    for case in cases:
        index = min(4, int((case.confidence / 100) * 5))
        buckets[index].append(case)
    result: list[CalibrationBucket] = []
    for index in range(5):
        items = buckets[index]
        if not items:
            continue
        lower = index * 0.20
        upper = (index + 1) * 0.20
        average_confidence = mean(item.confidence / 100 for item in items)
        coverage = mean(item.inside_interval for item in items)
        result.append(
            CalibrationBucket(
                label=f"{int(lower * 100)}-{int(upper * 100)}%",
                lower_bound=lower,
                upper_bound=upper,
                case_count=len(items),
                average_confidence=round(average_confidence, 4),
                empirical_interval_coverage=round(coverage, 4),
                calibration_gap=round(coverage - average_confidence, 4),
            )
        )
    return tuple(result)


class BacktestRunner:
    """Evaluate each historical cycle using a strict rolling information cutoff."""

    def __init__(self, model: OpeningWindowModel | None = None) -> None:
        self.model = model or HierarchicalCircularForecastModel()

    @staticmethod
    def _known_event(event: BacktestEvent, cutoff: date, target: BacktestEvent) -> bool:
        # Both constraints matter: availability blocks late discoveries, while the
        # event date blocks corrupt metadata from making future facts look known.
        return (
            event.id != target.id
            and not _same_cycle_as_target(event, target)
            and event.opened_on <= cutoff
            and event.effective_available_at.date() <= cutoff
        )

    @staticmethod
    def _known_signal(signal: BacktestSignal, cutoff: date) -> bool:
        return signal.observed_on <= cutoff and signal.effective_available_at.date() <= cutoff

    @staticmethod
    def _one_event_per_cycle(events: Iterable[BacktestEvent]) -> list[BacktestEvent]:
        return collapse_event_cycles(events)

    def run(
        self,
        roles: Iterable[BacktestRole],
        events: Iterable[BacktestEvent],
        signals: Iterable[BacktestSignal] = (),
        *,
        cutoff_days: int = 60,
        from_year: int | None = None,
        to_year: int | None = None,
        run_id: UUID | None = None,
        started_at: datetime | None = None,
        target_role_ids: Collection[str] | None = None,
    ) -> BacktestRun:
        if cutoff_days < 1:
            raise ValueError("cutoff_days must be positive")
        if from_year is not None and to_year is not None and from_year > to_year:
            raise ValueError("from_year cannot be after to_year")
        role_map = {role.id: role for role in roles}
        event_items = sorted(events, key=lambda item: (item.opened_on, item.id))
        signal_items = sorted(signals, key=lambda item: (item.observed_on, item.id))
        unknown_roles = {item.role_id for item in event_items} - role_map.keys()
        if unknown_roles:
            raise ValueError(f"events reference unknown roles: {sorted(unknown_roles)}")
        unknown_signal_roles = {item.role_id for item in signal_items} - role_map.keys()
        if unknown_signal_roles:
            raise ValueError(f"signals reference unknown roles: {sorted(unknown_signal_roles)}")

        in_years = [
            item
            for item in self._one_event_per_cycle(event_items)
            if (from_year is None or item.opened_on.year >= from_year)
            and (to_year is None or item.opened_on.year <= to_year)
        ]
        # Only in-scope roles are evaluated as targets. Every event, in scope or not, still stays in
        # the dataset the model reconstructs its company and role-family priors from.
        targets = [item for item in in_years if target_role_ids is None or item.role_id in target_role_ids]
        begun = _aware(started_at or datetime.now(UTC))
        cases: list[BacktestCase] = []
        skipped: list[SkippedTarget] = []

        for target in targets:
            role = role_map[target.role_id]
            target_interval = target.scoring_interval
            cutoff_anchor = target_interval[0] if target_interval else target.opened_on
            cutoff = cutoff_anchor - timedelta(days=cutoff_days)
            if target_interval is None:
                skipped.append(
                    SkippedTarget(
                        role.id,
                        target.id,
                        target.opened_on.year,
                        cutoff,
                        "held-out opening is observed-by only and has no scoreable actual interval",
                    )
                )
                continue
            known_events = self._one_event_per_cycle(
                item for item in event_items if self._known_event(item, cutoff, target)
            )
            history_events = [item for item in known_events if item.role_id == role.id]
            company_events = [
                item
                for item in known_events
                if item.role_id != role.id
                and role_map[item.role_id].company_id == role.company_id
                and compatible_prior_role(role, role_map[item.role_id])
            ]
            family_events = [
                item
                for item in known_events
                if item.role_id != role.id
                and role_map[item.role_id].company_id != role.company_id
                and role_map[item.role_id].role_family == role.role_family
                and compatible_prior_role(role, role_map[item.role_id])
            ]
            known_signals = [
                item for item in signal_items if item.role_id == role.id and self._known_signal(item, cutoff)
            ]

            company_prior = self._prior("company seasonality", company_events)
            family_prior = self._prior("role-family seasonality", family_events)
            if not history_events and not company_prior and not family_prior:
                skipped.append(
                    SkippedTarget(
                        role.id,
                        target.id,
                        target.opened_on.year,
                        cutoff,
                        "no temporal evidence was available by the forecast cutoff",
                    )
                )
                continue
            if 0 < len(history_events) < 3 and not company_prior and not family_prior:
                skipped.append(
                    SkippedTarget(
                        role.id,
                        target.id,
                        target.opened_on.year,
                        cutoff,
                        "sparse role history had no sourced company or role-family prior",
                    )
                )
                continue

            forecast = self.model.forecast(
                [item.as_opening() for item in history_events],
                [item.as_signal() for item in known_signals],
                as_of=cutoff,
                company_prior=company_prior,
                role_family_prior=family_prior,
                company_size=role.company_size,
                recruiting_scale=role.recruiting_scale,
                # Date-granularity cutoffs include the full UTC calendar day.
                forecasted_at=datetime.combine(cutoff + timedelta(days=1), datetime.min.time(), UTC),
            )
            input_events = sorted(
                {item.id: item for item in history_events + company_events + family_events}.values(),
                key=lambda item: item.id,
            )
            available_times = [item.effective_available_at for item in input_events] + [
                item.effective_available_at for item in known_signals
            ]
            cases.append(
                BacktestCase(
                    role_id=role.id,
                    target_event_id=target.id,
                    target_year=target.opened_on.year,
                    forecast_cutoff=cutoff,
                    actual_opened_on=target.opened_on,
                    actual_interval_start=target_interval[0],
                    actual_interval_end=target_interval[1],
                    target_date_precision=target.date_precision,
                    expected_opening_date=forecast.point_date,
                    interval_start=forecast.window_start,
                    interval_end=forecast.window_end,
                    confidence=forecast.confidence,
                    absolute_error_days=_distance_to_interval(forecast.point_date, target_interval),
                    inside_interval=_intervals_overlap(
                        (forecast.window_start, forecast.window_end), target_interval
                    ),
                    interval_width_days=(forecast.window_end - forecast.window_start).days,
                    history_observations=len(history_events),
                    target_source_quality=target.source_quality,
                    source_quality_bucket=_source_bucket(target.source_quality),
                    company_prior_observations=len(company_events),
                    role_family_prior_observations=len(family_events),
                    model_version=forecast.model_version,
                    input_fingerprint=forecast.input_fingerprint,
                    input_event_ids=tuple(item.id for item in input_events),
                    input_signal_ids=tuple(item.id for item in known_signals),
                    latest_input_available_at=max(available_times),
                )
            )

        finished = datetime.now(UTC)
        fingerprint = self._dataset_fingerprint(
            role_map.values(), event_items, signal_items, cutoff_days, from_year, to_year
        )
        versions = tuple(sorted({case.model_version for case in cases} | {self.model.model_version}))
        return BacktestRun(
            id=run_id or uuid4(),
            schema_version="backtest-run-v2",
            model_version=self.model.model_version,
            model_versions=versions,
            cutoff_days=cutoff_days,
            from_year=from_year,
            to_year=to_year,
            started_at=begun,
            finished_at=finished,
            dataset_fingerprint=fingerprint,
            target_count=len(targets),
            completed_cases=len(cases),
            skipped_cases=len(skipped),
            metrics=_aggregate(cases),
            confidence_calibration=_calibration(cases),
            performance_by_history=_group_metrics(cases, "history"),
            performance_by_source_quality=_group_metrics(cases, "source"),
            cases=tuple(cases),
            skipped_targets=tuple(skipped),
            out_of_scope_targets_excluded=len(in_years) - len(targets),
        )

    def replay(
        self,
        roles: Iterable[BacktestRole],
        events: Iterable[BacktestEvent],
        signals: Iterable[BacktestSignal] = (),
        *,
        role_id: str,
        target_year: int,
        forecast_cutoff: date,
    ) -> ForecastReplayResult:
        """Recreate one historical forecast without exposing post-cutoff evidence to the model."""
        role_map = {role.id: role for role in roles}
        role = role_map.get(role_id)
        if role is None:
            raise ValueError(f"unknown replay role {role_id}")
        event_items = sorted(events, key=lambda item: (item.opened_on, item.id))
        signal_items = sorted(signals, key=lambda item: (item.observed_on, item.id))
        target_candidates = [
            item
            for item in self._one_event_per_cycle(
                item for item in event_items if item.role_id == role_id
            )
            if item.opened_on.year == target_year
        ]
        if len(target_candidates) != 1:
            raise ValueError("replay requires exactly one target role/year cycle")
        target = target_candidates[0]
        if forecast_cutoff >= target.opened_on:
            raise ValueError("replay cutoff must be before the held-out opening")
        target_interval = target.scoring_interval
        if target_interval is None:
            raise ValueError("observed-by target has no scoreable actual interval")

        known_events = self._one_event_per_cycle(
            item for item in event_items if self._known_event(item, forecast_cutoff, target)
        )
        history_events = [item for item in known_events if item.role_id == role.id]
        company_events = [
            item
            for item in known_events
            if item.role_id != role.id and role_map[item.role_id].company_id == role.company_id
            and compatible_prior_role(role, role_map[item.role_id])
        ]
        family_events = [
            item
            for item in known_events
            if item.role_id != role.id
            and role_map[item.role_id].company_id != role.company_id
            and role_map[item.role_id].role_family == role.role_family
            and compatible_prior_role(role, role_map[item.role_id])
        ]
        known_signals = [
            item
            for item in signal_items
            if item.role_id == role.id and self._known_signal(item, forecast_cutoff)
        ]
        company_prior = self._prior("company seasonality", company_events)
        family_prior = self._prior("role-family seasonality", family_events)
        if not history_events and not company_prior and not family_prior:
            raise ValueError("no temporal evidence was available by the replay cutoff")
        if 0 < len(history_events) < 3 and not company_prior and not family_prior:
            raise ValueError("sparse role history had no sourced company or role-family prior")

        forecasted_at = datetime.combine(
            forecast_cutoff + timedelta(days=1), datetime.min.time(), UTC
        )
        forecast = self.model.forecast(
            [item.as_opening() for item in history_events],
            [item.as_signal() for item in known_signals],
            as_of=forecast_cutoff,
            company_prior=company_prior,
            role_family_prior=family_prior,
            company_size=role.company_size,
            recruiting_scale=role.recruiting_scale,
            forecasted_at=forecasted_at,
        )
        evidence = tuple(
            [
                ReplayEvidence(
                    item.id,
                    "role_history",
                    item.opened_on,
                    item.effective_available_at,
                    item.source_quality,
                    item.uncertainty_days,
                )
                for item in history_events
            ]
            + [
                ReplayEvidence(
                    item.id,
                    "company_prior",
                    item.opened_on,
                    item.effective_available_at,
                    item.source_quality,
                    item.uncertainty_days,
                )
                for item in company_events
            ]
            + [
                ReplayEvidence(
                    item.id,
                    "role_family_prior",
                    item.opened_on,
                    item.effective_available_at,
                    item.source_quality,
                    item.uncertainty_days,
                )
                for item in family_events
            ]
            + [
                ReplayEvidence(
                    item.id,
                    "signal",
                    item.observed_on,
                    item.effective_available_at,
                    item.reliability,
                    0.0,
                )
                for item in known_signals
            ]
        )
        own_weight = sum(
            item.date_weight for item in forecast.feature_contributions if item.influences_date and item.kind == "role_history"
        )
        borrowed_weight = sum(
            item.date_weight
            for item in forecast.feature_contributions
            if item.influences_date and item.kind in ("company_prior", "role_family_prior")
        )
        return ForecastReplayResult(
            schema_version="forecast-replay-v2",
            role_id=role.id,
            target_event_id=target.id,
            target_year=target_year,
            forecast_cutoff=forecast_cutoff,
            forecasted_at=forecasted_at,
            evidence=evidence,
            expected_opening_date=forecast.point_date,
            interval_start=forecast.window_start,
            interval_end=forecast.window_end,
            confidence=forecast.confidence,
            actual_opened_on=target.opened_on,
            actual_interval_start=target_interval[0],
            actual_interval_end=target_interval[1],
            target_date_precision=target.date_precision,
            absolute_error_days=_distance_to_interval(forecast.point_date, target_interval),
            inside_interval=_intervals_overlap(
                (forecast.window_start, forecast.window_end), target_interval
            ),
            model_version=forecast.model_version,
            input_fingerprint=forecast.input_fingerprint,
            own_history_weight=round(own_weight, 6),
            borrowed_weight=round(borrowed_weight, 6),
        )

    @staticmethod
    def _prior(name: str, events: Sequence[BacktestEvent]) -> SeasonalityPrior | None:
        return SeasonalityPrior.from_history(name, [item.as_opening() for item in events]) if events else None

    def _dataset_fingerprint(
        self,
        roles: Iterable[BacktestRole],
        events: Sequence[BacktestEvent],
        signals: Sequence[BacktestSignal],
        cutoff_days: int,
        from_year: int | None,
        to_year: int | None,
    ) -> str:
        payload = {
            "model_version": self.model.model_version,
            "cutoff_days": cutoff_days,
            "from_year": from_year,
            "to_year": to_year,
            "roles": [asdict(item) for item in sorted(roles, key=lambda item: item.id)],
            "events": [asdict(item) for item in events],
            "signals": [asdict(item) for item in signals],
        }
        return sha256(
            json.dumps(_jsonable(payload), sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()


def _distance_to_interval(point: date, interval: tuple[date, date]) -> int:
    if point < interval[0]:
        return (interval[0] - point).days
    if point > interval[1]:
        return (point - interval[1]).days
    return 0


def _intervals_overlap(left: tuple[date, date], right: tuple[date, date]) -> bool:
    return max(left[0], right[0]) <= min(left[1], right[1])
