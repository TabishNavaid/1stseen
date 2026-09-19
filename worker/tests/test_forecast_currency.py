"""A stored forecast is current only when it is newer than the role's last refusal (migration 202608140043)."""

from __future__ import annotations

import unittest
from datetime import UTC, datetime

from firstseen.forecast_currency import forecast_is_current, parse_timestamp


class ForecastCurrencyTest(unittest.TestCase):
    def test_a_forecast_older_than_the_refusal_is_history(self) -> None:
        forecasted = datetime(2026, 9, 14, 19, 44, tzinfo=UTC)
        self.assertTrue(forecast_is_current(forecasted, None))
        self.assertFalse(forecast_is_current(forecasted, datetime(2026, 9, 18, 11, 0, tzinfo=UTC)))
        self.assertTrue(forecast_is_current(datetime(2026, 9, 19, tzinfo=UTC), datetime(2026, 9, 18, 11, 0, tzinfo=UTC)))

    def test_postgrest_timestamps_parse_with_their_offset(self) -> None:
        self.assertEqual(parse_timestamp("2026-09-18T11:00:00+00:00"), datetime(2026, 9, 18, 11, 0, tzinfo=UTC))
        self.assertEqual(parse_timestamp("2026-09-18T11:00:00Z"), datetime(2026, 9, 18, 11, 0, tzinfo=UTC))
        self.assertIsNone(parse_timestamp(None))


if __name__ == "__main__":
    unittest.main()
