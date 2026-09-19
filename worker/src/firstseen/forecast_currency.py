"""Which stored forecast is current (migration 202608140043).

Forecasts are immutable versions. When forecast regeneration finds a role it can no longer forecast (the model raises
InsufficientEvidenceError), it records the refusal on the role, and every earlier version becomes history: a forecast is
current only when it is newer than the role's last refusal. The SQL read paths (forecast_role_states, forecast_basis)
and the web app (apps/web/lib/forecast-gap.ts) apply the same rule.
"""

from __future__ import annotations

from datetime import UTC, datetime


def _aware(value: datetime) -> datetime:
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def forecast_is_current(forecasted_at: datetime, refused_at: datetime | None) -> bool:
    return refused_at is None or _aware(forecasted_at) > _aware(refused_at)


def parse_timestamp(value: object) -> datetime | None:
    if value in (None, ""):
        return None
    return _aware(datetime.fromisoformat(str(value)))
