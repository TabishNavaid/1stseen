"""Interpretable hierarchical forecasting for annual recruiting openings.

Dates are circular temporal events. Role observations receive uncertainty-,
quality-, and recency-aware weights; sparse roles shrink toward company and
role-family seasonal priors. Signals affect confidence, never the date estimate.
No language model participates in numeric forecasting.
"""

from __future__ import annotations

import json
from calendar import isleap
from collections.abc import Iterable
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, timedelta
from hashlib import sha256
from math import atan2, cos, exp, pi, sin, sqrt
from typing import Literal, Protocol, cast

DAYS_IN_CYCLE = 365.2425
MODEL_VERSION = "hierarchical-circular-shrinkage-v2"
METHOD = "uncertainty_weighted_hierarchical_circular_model"
OBSERVED_BY_UNCERTAINTY_DAYS = 90.0

CompanySize = Literal["startup", "small", "medium", "large", "enterprise", "unknown"]
SignalDirection = Literal["support", "contradict"]
ContributionKind = Literal["role_history", "company_prior", "role_family_prior", "signal", "context"]
TemporalKind = Literal["role_history", "company_prior", "role_family_prior"]
DatePrecision = Literal["exact", "bounded", "observed_by"]


def _bounded(value: float, lower: float = 0.0, upper: float = 1.0) -> float:
    return min(upper, max(lower, value))


class InsufficientEvidenceError(ValueError):
    """The evidence cannot support a forecast yet: too little role history and no sourced prior,
    or dates that identify no season. Honest output for callers to report or skip, never a
    failure to retry."""


@dataclass(frozen=True)
class HistoricalOpening:
    opened_on: date
    source_quality: float = 1.0
    uncertainty_days: float | None = 0.0
    evidence_id: str | None = None
    date_precision: DatePrecision = "exact"
    role_match_confidence: float = 1.0

    def __post_init__(self) -> None:
        if not 0 <= self.source_quality <= 1:
            raise ValueError("source_quality must be between 0 and 1")
        if self.uncertainty_days is not None and self.uncertainty_days < 0:
            raise ValueError("uncertainty_days cannot be negative")
        if not 0 <= self.role_match_confidence <= 1:
            raise ValueError("role_match_confidence must be between 0 and 1")
        if self.date_precision == "exact" and self.uncertainty_days != 0:
            raise ValueError("exact openings require zero uncertainty")
        if self.date_precision == "bounded" and not self.uncertainty_days:
            raise ValueError("bounded openings require positive uncertainty")

    @property
    def effective_uncertainty_days(self) -> float:
        if self.date_precision == "observed_by":
            return max(OBSERVED_BY_UNCERTAINTY_DAYS, self.uncertainty_days or 0.0)
        return self.uncertainty_days or 0.0


@dataclass(frozen=True)
class Signal:
    observed_on: date
    strength: float
    reliability: float
    kind: str
    direction: SignalDirection = "support"
    evidence_id: str | None = None

    def __post_init__(self) -> None:
        if not 0 <= self.strength <= 1 or not 0 <= self.reliability <= 1:
            raise ValueError("signal strength and reliability must be between 0 and 1")


@dataclass(frozen=True)
class SeasonalityPrior:
    """A sourced company or role-family seasonal estimate.

    ``spread_days`` is the historical predictive standard deviation. Effective
    sample size is capped by the model so a broad prior cannot overwhelm direct
    role history.
    """

    name: str
    center_month: int
    center_day: int
    spread_days: float
    effective_sample_size: float
    quality: float = 0.8
    evidence_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        date(2000, self.center_month, self.center_day)
        if self.spread_days <= 0:
            raise ValueError("prior spread_days must be positive")
        if self.effective_sample_size <= 0:
            raise ValueError("prior effective_sample_size must be positive")
        if not 0 <= self.quality <= 1:
            raise ValueError("prior quality must be between 0 and 1")
        if not self.evidence_ids:
            raise ValueError("seasonality priors require sourced evidence IDs")

    @property
    def cycle_day(self) -> float:
        return _cycle_day(date(2000, self.center_month, self.center_day))

    @classmethod
    def from_history(
        cls,
        name: str,
        history: Iterable[HistoricalOpening],
    ) -> SeasonalityPrior:
        openings = sorted(
            history,
            key=lambda item: (
                item.opened_on,
                item.evidence_id or "",
                item.source_quality,
                item.effective_uncertainty_days,
                item.role_match_confidence,
            ),
        )
        if not openings:
            raise ValueError("A seasonality prior requires historical events")
        weights = [
            max(0.01, item.source_quality * item.role_match_confidence)
            / (1 + (item.effective_uncertainty_days / 21) ** 2)
            for item in openings
        ]
        center = _weighted_center([_cycle_day(item.opened_on) for item in openings], weights)
        distances = [_circular_distance(_cycle_day(item.opened_on), center) for item in openings]
        measurement_variance = sum(
            (item.effective_uncertainty_days**2) / 12 for item in openings
        )
        variance = sum(
            weight * distance**2 for weight, distance in zip(weights, distances, strict=True)
        ) / sum(weights) + measurement_variance / len(openings)
        reference = _date_for_cycle_day(2000, center)
        return cls(
            name=name,
            center_month=reference.month,
            center_day=reference.day,
            spread_days=max(7.0, sqrt(variance)),
            effective_sample_size=sum(weights),
            quality=sum(
                item.source_quality * item.role_match_confidence for item in openings
            )
            / len(openings),
            evidence_ids=tuple(sorted(item.evidence_id for item in openings if item.evidence_id)),
        )


@dataclass(frozen=True)
class ForecastContribution:
    name: str
    kind: ContributionKind
    date_weight: float
    confidence_effect: float
    influences_date: bool
    rationale: str
    evidence_id: str | None = None
    evidence_ids: tuple[str, ...] = ()
    evidence_date: date | None = None


@dataclass(frozen=True)
class Forecast:
    point_date: date
    window_start: date
    window_end: date
    confidence: float
    calibrated_probability: float
    confidence_factors: dict[str, float]
    feature_contributions: tuple[ForecastContribution, ...]
    method: str
    model_version: str
    forecasted_at: datetime
    sample_size: int
    prior_effective_sample_size: float
    prediction_interval_coverage: float
    input_fingerprint: str

    @property
    def expected_opening_date(self) -> date:
        return self.point_date

    @property
    def prediction_interval_start(self) -> date:
        return self.window_start

    @property
    def prediction_interval_end(self) -> date:
        return self.window_end

    def to_dict(self) -> dict[str, object]:
        payload = asdict(self)
        for key in ("point_date", "window_start", "window_end"):
            payload[key] = payload[key].isoformat()
        payload["forecasted_at"] = self.forecasted_at.isoformat()
        contributions: list[dict[str, object]] = []
        for item in self.feature_contributions:
            contribution = asdict(item)
            if item.evidence_date:
                contribution["evidence_date"] = item.evidence_date.isoformat()
            contributions.append(contribution)
        payload["feature_contributions"] = contributions
        payload.update(
            {
                "expected_opening_date": payload["point_date"],
                "prediction_interval_start": payload["window_start"],
                "prediction_interval_end": payload["window_end"],
            }
        )
        return payload


class OpeningWindowModel(Protocol):
    model_version: str

    def forecast(
        self,
        history: Iterable[HistoricalOpening],
        signals: Iterable[Signal],
        *,
        as_of: date,
        company_prior: SeasonalityPrior | None = None,
        role_family_prior: SeasonalityPrior | None = None,
        company_size: CompanySize = "unknown",
        recruiting_scale: float | None = None,
        forecasted_at: datetime | None = None,
    ) -> Forecast: ...


@dataclass(frozen=True)
class _TemporalComponent:
    name: str
    kind: TemporalKind
    cycle_day: float
    weight: float
    spread_days: float
    evidence_id: str | None = None
    evidence_ids: tuple[str, ...] = ()
    evidence_date: date | None = None


def _cycle_day(value: date) -> float:
    days_in_year = 366 if isleap(value.year) else 365
    return ((value.timetuple().tm_yday - 1) / days_in_year) * DAYS_IN_CYCLE


def _cycle_angle(cycle_day: float) -> float:
    return 2 * pi * (cycle_day / DAYS_IN_CYCLE)


def _weighted_center(cycle_days: list[float], weights: list[float]) -> float:
    weighted_sin = sum(
        weight * sin(_cycle_angle(cycle_day)) for cycle_day, weight in zip(cycle_days, weights, strict=True)
    )
    weighted_cos = sum(
        weight * cos(_cycle_angle(cycle_day)) for cycle_day, weight in zip(cycle_days, weights, strict=True)
    )
    if abs(weighted_sin) < 1e-12 and abs(weighted_cos) < 1e-12:
        raise InsufficientEvidenceError("Temporal evidence has no identifiable annual center")
    angle = atan2(weighted_sin, weighted_cos) % (2 * pi)
    return angle * DAYS_IN_CYCLE / (2 * pi)


def _circular_distance(left: float, right: float) -> float:
    delta = abs(left - right) % DAYS_IN_CYCLE
    return min(delta, DAYS_IN_CYCLE - delta)


def _date_for_cycle_day(year: int, cycle_day: float) -> date:
    days_in_year = 366 if isleap(year) else 365
    day_index = round((cycle_day % DAYS_IN_CYCLE) / DAYS_IN_CYCLE * days_in_year)
    return date(year, 1, 1) + timedelta(days=day_index % days_in_year)


def _next_occurrence(as_of: date, cycle_day: float) -> date:
    candidate = _date_for_cycle_day(as_of.year, cycle_day)
    return candidate if candidate >= as_of else _date_for_cycle_day(as_of.year + 1, cycle_day)


def _company_scale(company_size: CompanySize, recruiting_scale: float | None) -> float:
    size_score = {
        "startup": 0.20,
        "small": 0.35,
        "medium": 0.55,
        "large": 0.75,
        "enterprise": 0.90,
        "unknown": 0.50,
    }[company_size]
    if recruiting_scale is None:
        return size_score
    if not 0 <= recruiting_scale <= 1:
        raise ValueError("recruiting_scale must be between 0 and 1")
    return (size_score + recruiting_scale) / 2


class HierarchicalCircularForecastModel:
    """Uncertainty-weighted circular mean with sparse-data prior shrinkage."""

    model_version = MODEL_VERSION

    @staticmethod
    def _prior_multiplier(role_cycles: int) -> float:
        return {0: 1.0, 1: 0.80, 2: 0.55, 3: 0.25}.get(role_cycles, 0.10)

    @staticmethod
    def _confidence_cap(role_cycles: int, effective_role_weight: float) -> float:
        if role_cycles == 0 or effective_role_weight <= 0.50:
            return 0.48
        if effective_role_weight <= 1.25:
            return 0.56
        if effective_role_weight <= 2.25:
            return 0.69
        if effective_role_weight <= 3.25:
            return 0.82
        return 0.92

    def _components(
        self,
        openings: list[HistoricalOpening],
        *,
        as_of: date,
        company_prior: SeasonalityPrior | None,
        role_family_prior: SeasonalityPrior | None,
    ) -> list[_TemporalComponent]:
        components: list[_TemporalComponent] = []
        for index, opening in enumerate(openings, start=1):
            age_years = max(0.0, (as_of - opening.opened_on).days / DAYS_IN_CYCLE)
            recency_weight = 0.86**age_years
            effective_uncertainty = opening.effective_uncertainty_days
            uncertainty_factor = 1 / (1 + (effective_uncertainty / 21) ** 2)
            identity_quality = opening.source_quality * opening.role_match_confidence
            weight = recency_weight * max(0.01, identity_quality) * uncertainty_factor
            measurement_std = effective_uncertainty / sqrt(12)
            components.append(
                _TemporalComponent(
                    name=f"role opening {index}",
                    kind="role_history",
                    cycle_day=_cycle_day(opening.opened_on),
                    weight=weight,
                    spread_days=sqrt(4**2 + measurement_std**2),
                    evidence_id=opening.evidence_id,
                    evidence_ids=(opening.evidence_id,) if opening.evidence_id else (),
                    evidence_date=opening.opened_on,
                )
            )
        multiplier = self._prior_multiplier(len(openings))
        for prior, kind, cap in (
            (company_prior, "company_prior", 3.0),
            (role_family_prior, "role_family_prior", 2.5),
        ):
            if prior:
                components.append(
                    _TemporalComponent(
                        name=prior.name,
                        kind=cast(TemporalKind, kind),
                        cycle_day=prior.cycle_day,
                        weight=(
                            multiplier
                            * min(cap, prior.effective_sample_size)
                            * max(0.05, prior.quality)
                            * max(0.10, exp(-prior.spread_days / 45))
                        ),
                        spread_days=prior.spread_days,
                        evidence_id=prior.evidence_ids[0] if prior.evidence_ids else None,
                        evidence_ids=prior.evidence_ids,
                    )
                )
        return components

    @staticmethod
    def _deduplicate_signals(signals: Iterable[Signal]) -> list[Signal]:
        unique: dict[str, Signal] = {}
        anonymous: set[tuple[object, ...]] = set()
        results: list[Signal] = []
        for signal in sorted(
            signals,
            key=lambda item: (
                item.observed_on,
                item.evidence_id or "",
                item.kind,
                item.direction,
                item.strength,
                item.reliability,
            ),
        ):
            semantics = (
                signal.observed_on,
                signal.kind,
                signal.direction,
                signal.strength,
                signal.reliability,
            )
            if signal.evidence_id:
                previous = unique.get(signal.evidence_id)
                if previous and (
                    previous.observed_on,
                    previous.kind,
                    previous.direction,
                    previous.strength,
                    previous.reliability,
                ) != semantics:
                    raise ValueError("A signal evidence ID cannot carry conflicting semantics")
                if previous:
                    continue
                unique[signal.evidence_id] = signal
            elif semantics in anonymous:
                continue
            else:
                anonymous.add(semantics)
            results.append(signal)
        return results

    @staticmethod
    def _signal_factors(
        signals: list[Signal], as_of: date
    ) -> tuple[float, float, float, list[ForecastContribution]]:
        positive = negative = 0.0
        contributions: list[ForecastContribution] = []
        for signal in signals:
            if signal.observed_on > as_of:
                continue
            recency = exp(-max(0, (as_of - signal.observed_on).days) / 45)
            term = signal.strength * signal.reliability * recency
            if signal.direction == "support":
                positive += term
                effect = term
            else:
                negative += term
                effect = -term
            contributions.append(
                ForecastContribution(
                    name=signal.kind,
                    kind="signal",
                    date_weight=0,
                    confidence_effect=round(effect, 4),
                    influences_date=False,
                    rationale=(
                        "Recent reliable signal supports recurrence confidence but cannot move the date."
                        if effect >= 0
                        else "Contradictory signal lowers confidence but cannot move the date."
                    ),
                    evidence_id=signal.evidence_id,
                    evidence_date=signal.observed_on,
                )
            )
        support = 1 - exp(-positive)
        contradiction = 1 - exp(-negative)
        if positive and negative:
            conflict = 2 * min(positive, negative) / (positive + negative)
        else:
            conflict = 0.0
        return support, contradiction, conflict, contributions

    def forecast(
        self,
        history: Iterable[HistoricalOpening],
        signals: Iterable[Signal] = (),
        *,
        as_of: date,
        company_prior: SeasonalityPrior | None = None,
        role_family_prior: SeasonalityPrior | None = None,
        company_size: CompanySize = "unknown",
        recruiting_scale: float | None = None,
        forecasted_at: datetime | None = None,
    ) -> Forecast:
        openings = sorted(
            history,
            key=lambda item: (
                item.opened_on,
                item.evidence_id or "",
                item.source_quality,
                item.effective_uncertainty_days,
                item.role_match_confidence,
            ),
        )
        signal_items = self._deduplicate_signals(signals)
        if any(item.opened_on > as_of for item in openings):
            raise ValueError("Historical evidence cannot be dated after as_of")
        if 0 < len(openings) < 3 and not (company_prior or role_family_prior):
            raise InsufficientEvidenceError("Sparse role history requires a sourced company or role-family seasonal prior")
        components = self._components(
            openings,
            as_of=as_of,
            company_prior=company_prior,
            role_family_prior=role_family_prior,
        )
        if not components:
            raise InsufficientEvidenceError(
                "Forecasting requires role history or a sourced company/role-family seasonal prior"
            )

        weights = [component.weight for component in components]
        center = _weighted_center([component.cycle_day for component in components], weights)
        total_weight = sum(weights)
        variance = (
            sum(
                component.weight
                * (component.spread_days**2 + _circular_distance(component.cycle_day, center) ** 2)
                for component in components
            )
            / total_weight
        )
        predictive_std = sqrt(variance * (1 + 1 / max(1.0, total_weight)))
        scarcity_floor = {0: 42, 1: 32, 2: 22, 3: 12}.get(len(openings), 7)
        scale = _company_scale(company_size, recruiting_scale)
        scale_adjusted_floor = scarcity_floor * (1.05 - 0.10 * scale)
        half_width = min(90, max(round(scale_adjusted_floor), round(1.282 * predictive_std)))

        point = _next_occurrence(as_of, center)
        role_components = [item for item in components if item.kind == "role_history"]
        role_weight = sum(item.weight for item in role_components)
        role_spread = (
            sqrt(
                sum(
                    item.weight * _circular_distance(item.cycle_day, center) ** 2
                    for item in role_components
                )
                / role_weight
            )
            if role_weight
            else predictive_std
        )
        average_quality = (
            sum(item.source_quality * item.role_match_confidence for item in openings) / len(openings)
            if openings
            else sum(prior.quality for prior in (company_prior, role_family_prior) if prior)
            / sum(prior is not None for prior in (company_prior, role_family_prior))
        )
        average_uncertainty = (
            sum(item.effective_uncertainty_days for item in openings) / len(openings)
            if openings
            else predictive_std
        )
        latest_evidence = max((item.opened_on for item in openings), default=None)
        recency = (
            exp(-max(0, (as_of - latest_evidence).days) / (2 * DAYS_IN_CYCLE)) if latest_evidence else 0.35
        )
        prior_effective_n = sum(
            prior.effective_sample_size for prior in (company_prior, role_family_prior) if prior
        )
        support, contradiction, conflict, signal_contributions = self._signal_factors(signal_items, as_of)

        factors = {
            "role_history_strength": 1 - exp(-role_weight / 3),
            "prior_support": 1 - exp(-prior_effective_n / 4),
            "cycle_consistency": exp(-role_spread / 24),
            "source_quality": average_quality,
            "evidence_recency": recency,
            "event_uncertainty_precision": exp(-average_uncertainty / 30),
            "interval_precision": exp(-half_width / 45),
            "company_recruiting_scale": scale,
            "current_signal_support": support,
            "signal_contradiction": contradiction,
            "signal_conflict": conflict,
        }
        factors = {key: round(_bounded(value), 4) for key, value in factors.items()}
        raw_score = (
            0.22 * factors["role_history_strength"]
            + 0.12 * factors["prior_support"]
            + 0.18 * factors["cycle_consistency"]
            + 0.14 * factors["source_quality"]
            + 0.10 * factors["evidence_recency"]
            + 0.08 * factors["event_uncertainty_precision"]
            + 0.08 * factors["interval_precision"]
            + 0.08 * factors["company_recruiting_scale"]
            + 0.08 * factors["current_signal_support"]
            - 0.10 * factors["signal_contradiction"]
            - 0.06 * factors["signal_conflict"]
        )
        calibrated = 0.08 + 0.84 * _bounded(raw_score)
        sparse_cap = self._confidence_cap(len(openings), role_weight)
        probability = min(sparse_cap, max(0.05, calibrated))

        contributions: list[ForecastContribution] = []
        for component in components:
            normalized_weight = component.weight / total_weight
            contributions.append(
                ForecastContribution(
                    name=component.name,
                    kind=component.kind,
                    date_weight=round(normalized_weight, 4),
                    confidence_effect=round(normalized_weight * exp(-component.spread_days / 30), 4),
                    influences_date=True,
                    rationale=(
                        "Direct role opening weighted by source quality, recency, and date uncertainty."
                        if component.kind == "role_history"
                        else "Sparse-data seasonal prior contributes through capped hierarchical shrinkage."
                    ),
                    evidence_id=component.evidence_id,
                    evidence_ids=component.evidence_ids,
                    evidence_date=component.evidence_date,
                )
            )
        contributions.extend(signal_contributions)
        contributions.append(
            ForecastContribution(
                name="company recruiting scale",
                kind="context",
                date_weight=0,
                confidence_effect=round(0.08 * scale, 4),
                influences_date=False,
                rationale="Recruiting scale affects repeatability confidence, not the expected date.",
            )
        )

        timestamp = forecasted_at or datetime.combine(as_of, datetime.min.time(), UTC)
        if timestamp.tzinfo is None:
            raise ValueError("forecasted_at must be timezone-aware")
        fingerprint_payload = {
            "model_version": self.model_version,
            "as_of": as_of.isoformat(),
            "history": [
                {
                    "opened_on": item.opened_on.isoformat(),
                    "source_quality": item.source_quality,
                    "uncertainty_days": item.uncertainty_days,
                    "evidence_id": item.evidence_id,
                    "date_precision": item.date_precision,
                    "role_match_confidence": item.role_match_confidence,
                }
                for item in openings
            ],
            "company_prior": asdict(company_prior) if company_prior else None,
            "role_family_prior": asdict(role_family_prior) if role_family_prior else None,
            "signals": [
                {
                    "observed_on": item.observed_on.isoformat(),
                    "strength": item.strength,
                    "reliability": item.reliability,
                    "kind": item.kind,
                    "direction": item.direction,
                    "evidence_id": item.evidence_id,
                }
                for item in signal_items
            ],
            "company_size": company_size,
            "recruiting_scale": recruiting_scale,
        }
        input_fingerprint = sha256(
            json.dumps(fingerprint_payload, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()
        return Forecast(
            point_date=point,
            window_start=point - timedelta(days=half_width),
            window_end=point + timedelta(days=half_width),
            confidence=round(probability * 100, 1),
            calibrated_probability=round(probability, 4),
            confidence_factors=factors,
            feature_contributions=tuple(contributions),
            method=METHOD,
            model_version=self.model_version,
            forecasted_at=timestamp,
            sample_size=len(openings),
            prior_effective_sample_size=round(prior_effective_n, 2),
            prediction_interval_coverage=0.80,
            input_fingerprint=input_fingerprint,
        )


# The precision at which the product shows each forecast value, and therefore the precision at which a recompute
# counts as a change. These mirror the web layer and must be changed with it, never ahead of it: if the comparison
# rounds harder than the page displays, the page shows a number that moved while the stored version says it did not.
#
#   CONFIDENCE_DISPLAYED_DECIMALS        the score out of 100 (apps/web/lib/confidence.ts, shown as "48 / 100")
#   PROBABILITY_DISPLAYED_DECIMALS       role-intelligence-page.tsx, toFixed(2)
#   FACTOR_DISPLAYED_DECIMALS            evidence-drawer.tsx and role-intelligence-page.tsx, toFixed(1)
#   BASIS_SHARE_DISPLAYED_DECIMALS       forecast-basis.ts, Math.round(share * 100), so a whole percent
#   PRIOR_SAMPLE_DISPLAYED_DECIMALS      as stored; priors do not decay with as_of, so this cannot drift on its own
#
# Rounding harder widens the band between stored versions. Measured on four openings and a company prior at the
# earlier values (probability to a thousandth, factors to a hundredth): a settled role stored a version every five
# days, a sparse one every nine, and a role carrying a signal from the last few weeks every day, because signal
# recency decays about 0.018 a day against a shown hundredth. The factors are shown to a tenth now, which is about
# five and a half days of that decay, so the every-day case should become an every-few-days one; the displayed
# precision was cut because three decimals on a probability built from four cycles claims more than the evidence
# carries, and the quieter change feed follows from that rather than the other way round.
CONFIDENCE_DISPLAYED_DECIMALS = 0
PROBABILITY_DISPLAYED_DECIMALS = 2
FACTOR_DISPLAYED_DECIMALS = 1
BASIS_SHARE_DISPLAYED_DECIMALS = 0
PRIOR_SAMPLE_DISPLAYED_DECIMALS = 2


def displayed_forecast_identity(forecast: Forecast) -> tuple[object, ...]:
    """Everything a reader of this forecast can see, at the precision they see it.

    Regeneration stores a new version only when this changes. It compares the displayed values rather than the raw
    ones because `as_of` is a forecast input: `evidence_recency` decays on a two-cycle scale and signal recency on a
    45-day one, so the four-decimal factors and the unrounded probability differ every night even when nothing was
    learned. Versioning on those stored a new forecast and about 101 `forecast_evidence` rows per in-scope role per
    day (measured 2026-09-24: 66,560 rows against 658 roles), which was most of the database's growth.

    The precisions below are the web layer's, and they are a contract with it. `role-intelligence-page.tsx` renders
    the probability with `toFixed(3)` and each confidence factor with `toFixed(2)`, `forecast-basis.ts` rounds the
    basis share to a whole percent, and confidence is shown as a whole score out of 100. Change one of those and
    change this with it, or the product will show a number that moved while the stored version says it did not.

    `model_version` and `method` are not displayed; they are here because a model change must version by contract.
    Left out: the input fingerprint (a hash, and it carries `as_of`), `forecasted_at`, and the interval coverage,
    which is a constant. The raw date weights are out too, but the basis share they drive is in.
    """
    own = sum(item.date_weight for item in forecast.feature_contributions if item.kind == "role_history")
    borrowed = sum(
        item.date_weight
        for item in forecast.feature_contributions
        if item.kind in ("company_prior", "role_family_prior")
    )
    # The same two sums migration 202608140040 takes, so the chip's percent and this agree.
    weighted = own + borrowed
    evidence_ids: set[str] = set()
    for item in forecast.feature_contributions:
        if item.evidence_id:
            evidence_ids.add(item.evidence_id)
        evidence_ids.update(item.evidence_ids)
    shares = (
        (
            round(own / weighted * 100, BASIS_SHARE_DISPLAYED_DECIMALS),
            round(borrowed / weighted * 100, BASIS_SHARE_DISPLAYED_DECIMALS),
        )
        if weighted
        else None
    )
    return (
        forecast.point_date,
        forecast.window_start,
        forecast.window_end,
        round(forecast.confidence, CONFIDENCE_DISPLAYED_DECIMALS),
        round(forecast.calibrated_probability, PROBABILITY_DISPLAYED_DECIMALS),
        tuple(
            sorted(
                (key, round(value, FACTOR_DISPLAYED_DECIMALS))
                for key, value in forecast.confidence_factors.items()
            )
        ),
        shares,
        forecast.sample_size,
        round(forecast.prior_effective_sample_size, PRIOR_SAMPLE_DISPLAYED_DECIMALS),
        forecast.method,
        forecast.model_version,
        tuple(sorted(evidence_ids)),
    )


def forecast_opening_window(
    history: Iterable[HistoricalOpening],
    signals: Iterable[Signal] = (),
    *,
    as_of: date,
    company_prior: SeasonalityPrior | None = None,
    role_family_prior: SeasonalityPrior | None = None,
    company_size: CompanySize = "unknown",
    recruiting_scale: float | None = None,
    forecasted_at: datetime | None = None,
    model: OpeningWindowModel | None = None,
) -> Forecast:
    """Compatibility entrypoint for the replaceable statistical model boundary."""
    engine = model or HierarchicalCircularForecastModel()
    return engine.forecast(
        history,
        signals,
        as_of=as_of,
        company_prior=company_prior,
        role_family_prior=role_family_prior,
        company_size=company_size,
        recruiting_scale=recruiting_scale,
        forecasted_at=forecasted_at,
    )
