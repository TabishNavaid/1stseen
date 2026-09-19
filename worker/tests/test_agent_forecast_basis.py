"""The agent's forecast carries its basis to the product: the persisted weight from the program's own openings and
from comparable programs, never a value the agent computes, and nothing when the weights were not read."""

from __future__ import annotations

import unittest
from datetime import date
from uuid import UUID

from firstseen.agent import ForecastResult, RecruitingAgent, RecruitingAgentState

ROLE = UUID("00000000-0000-4000-8000-0000000000c3")
FORECAST = UUID("00000000-0000-4000-8000-0000000000f4")


def _forecast(**weights: float) -> ForecastResult:
    return ForecastResult(
        forecast_id=FORECAST,
        role_id=ROLE,
        as_of=date(2026, 9, 17),
        expected_opening_date=date(2027, 9, 6),
        interval_start=date(2027, 8, 5),
        interval_end=date(2027, 10, 8),
        confidence=56.0,
        calibrated_probability=0.56,
        model_version="hierarchical-circular-shrinkage-v2",
        history_count=1,
        cached=True,
        **weights,
    )


class AgentForecastBasisTest(unittest.TestCase):
    def _data(self, result: ForecastResult) -> dict[str, object]:
        state = RecruitingAgentState(goal="When does this program open?")
        data = RecruitingAgent._observable_tool_data(
            "generate_forecast", result, state, evidence_before=0, duration_ms=4
        )
        forecast = data["forecast"]
        assert isinstance(forecast, dict)
        return forecast

    def test_the_stream_carries_the_persisted_weights(self) -> None:
        forecast = self._data(_forecast(own_history_weight=0.36, borrowed_weight=0.64))
        self.assertEqual(forecast["own_history_weight"], 0.36)
        self.assertEqual(forecast["borrowed_weight"], 0.64)

    def test_no_weights_means_no_basis_rather_than_a_guess(self) -> None:
        forecast = self._data(_forecast())
        self.assertNotIn("own_history_weight", forecast)
        self.assertNotIn("borrowed_weight", forecast)


if __name__ == "__main__":
    unittest.main()
