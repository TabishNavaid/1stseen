"""A day passing is not a new forecast; new evidence is.

`as_of` is a forecast input, so a role's input fingerprint changed every midnight and regeneration stored a new
version, and about 101 `forecast_evidence` rows, for every in-scope role every day. These tests hold the line that
replaces it: a recompute is a new stored version only when something a reader can see has changed, at the precision
they see it.

They are the measurement, not a description of it. If a precision here is loosened until the comparison stops firing,
one of them fails.
"""

from __future__ import annotations

import unittest
from datetime import date, timedelta
from pathlib import Path

from firstseen.forecasting import (
    BASIS_SHARE_DISPLAYED_DECIMALS,
    CONFIDENCE_DISPLAYED_DECIMALS,
    FACTOR_DISPLAYED_DECIMALS,
    PROBABILITY_DISPLAYED_DECIMALS,
    HistoricalOpening,
    SeasonalityPrior,
    Signal,
    displayed_forecast_identity,
    forecast_opening_window,
)

HISTORY = [
    HistoricalOpening(date(2022, 9, 11), 0.9, evidence_id="history-2022"),
    HistoricalOpening(date(2023, 9, 15), 1.0, evidence_id="history-2023"),
    HistoricalOpening(date(2024, 9, 8), 1.0, evidence_id="history-2024"),
    HistoricalOpening(date(2025, 9, 13), 1.0, evidence_id="history-2025"),
]
PRIOR = SeasonalityPrior(
    "company internship season",
    9,
    12,
    spread_days=13,
    effective_sample_size=8,
    quality=0.9,
    evidence_ids=("company-prior-1",),
)


def forecast(history, as_of: date, signals=()):
    return forecast_opening_window(history, signals, as_of=as_of, company_prior=PRIOR)


class DisplayedIdentityTests(unittest.TestCase):
    def test_a_day_passing_with_the_same_evidence_is_not_a_new_version(self) -> None:
        """The whole point: same openings, as_of one day later, nothing a reader sees moves."""
        today = date(2026, 6, 1)
        first = forecast(HISTORY, today)
        second = forecast(HISTORY, today + timedelta(days=1))
        # The raw fingerprint differs, which is exactly why it could not be the test.
        self.assertNotEqual(first.input_fingerprint, second.input_fingerprint)
        self.assertEqual(displayed_forecast_identity(first), displayed_forecast_identity(second))

    def test_it_holds_for_several_days_when_no_signal_is_decaying(self) -> None:
        """Measured, not assumed: with four openings and a prior, the displayed set survives fifteen days.

        What ends it is `evidence_recency`, which the drawer shows to one decimal and which decays on a two-cycle
        scale: around day fifteen it crosses a tenth and the role legitimately stores a version. So this asserts
        fourteen, one inside the measured band. A change here means the model's decay or the drawer's precision moved.
        It was five days while the drawer showed a hundredth.
        """
        start = date(2026, 6, 1)
        baseline = displayed_forecast_identity(forecast(HISTORY, start))
        for offset in range(1, 15):
            with self.subTest(day=offset):
                self.assertEqual(
                    baseline, displayed_forecast_identity(forecast(HISTORY, start + timedelta(days=offset)))
                )

    def test_a_role_with_a_fresh_signal_holds_for_a_week_rather_than_a_day(self) -> None:
        """The limit this used to record, and where it moved to.

        Signal recency decays on a 45-day scale, about 0.018 a day. Against a shown hundredth that was a different
        number every morning, so a role carrying a recent signal stored a version every day and the watchlist reported
        a change that no reader could feel. Against a shown tenth it takes about a week, which is measured here as
        seven; this asserts six, one inside the band. The saving now reaches these roles too, not only settled ones.
        """
        today = date(2026, 6, 1)
        signals = (Signal(date(2026, 5, 28), 0.6, 0.9, kind="ats_posting_opened", evidence_id="signal-1"),)
        baseline = displayed_forecast_identity(forecast(HISTORY, today, signals))
        for offset in range(1, 7):
            with self.subTest(day=offset):
                self.assertEqual(
                    baseline, displayed_forecast_identity(forecast(HISTORY, today + timedelta(days=offset), signals))
                )
        # It still moves eventually: a comparison that never fires would have built nothing.
        self.assertNotEqual(
            baseline, displayed_forecast_identity(forecast(HISTORY, today + timedelta(days=21), signals))
        )

    def test_a_new_opening_is_a_new_version(self) -> None:
        """A comparison that never fires would have built nothing: real evidence must still version."""
        today = date(2026, 6, 1)
        before = forecast(HISTORY, today)
        after = forecast([*HISTORY, HistoricalOpening(date(2026, 3, 2), 1.0, evidence_id="history-2026")], today)
        self.assertNotEqual(displayed_forecast_identity(before), displayed_forecast_identity(after))

    def test_a_new_signal_is_a_new_version(self) -> None:
        today = date(2026, 6, 1)
        before = forecast(HISTORY, today)
        after = forecast(
            HISTORY,
            today,
            signals=(Signal(date(2026, 5, 28), 0.6, 0.9, kind="ats_posting_opened", evidence_id="signal-1"),),
        )
        self.assertNotEqual(displayed_forecast_identity(before), displayed_forecast_identity(after))

    def test_the_window_moving_when_as_of_passes_the_date_is_a_new_version(self) -> None:
        """as_of legitimately changes the answer once: the next occurrence becomes next year's."""
        window = forecast(HISTORY, date(2026, 6, 1))
        after = forecast(HISTORY, window.point_date + timedelta(days=1))
        self.assertNotEqual(displayed_forecast_identity(window), displayed_forecast_identity(after))
        self.assertGreater(after.point_date, window.point_date)

    def test_sample_size_does_not_move_on_its_own(self) -> None:
        """Measured separately, because a sample size that grew every run would be a second churn source.

        Here it is only the count of openings the model used, so with the same openings it cannot move. If it moves in
        production while the corpus records no new cycle, that is events being created for cycles already stored, and
        it belongs in its own investigation rather than hidden behind this comparison.
        """
        start = date(2026, 6, 1)
        sizes = {forecast(HISTORY, start + timedelta(days=offset)).sample_size for offset in range(14)}
        self.assertEqual(sizes, {len(HISTORY)})


class PrecisionTests(unittest.TestCase):
    def test_the_raw_values_really_do_drift_every_day(self) -> None:
        """Evidence for the comment: without rounding, one day changes the factors and the probability.

        This is what made the old fingerprint useless, and it is why the set is the displayed values. If this ever
        stops being true, the rounding could be tightened.
        """
        today = date(2026, 6, 1)
        first = forecast(HISTORY, today)
        second = forecast(HISTORY, today + timedelta(days=1))
        self.assertNotEqual(first.confidence_factors, second.confidence_factors)
        drift = abs(first.calibrated_probability - second.calibrated_probability)
        self.assertGreater(drift, 0.0, "a day with no new evidence still moved the raw probability")
        # And it drifts far below what the product prints, which is why 3 decimals is enough to be honest.
        self.assertLess(drift, 0.0005)


class TheyMirrorTheWebLayerTests(unittest.TestCase):
    """The comparison must round exactly as the product prints, and this fails when one side moves without the other.

    Rounding harder than the page displays means the page shows a number that changed while the stored version claims
    it did not. Rounding softer than the page displays means storing a version a reader cannot tell apart. Either way
    the two have to be edited together, so the constants are checked against the files that print the numbers.
    """

    WEB = Path(__file__).resolve().parents[2] / "apps/web"

    def test_the_probability_and_factor_decimals_match_what_the_pages_print(self) -> None:
        role_page = (self.WEB / "components/role-intelligence-page.tsx").read_text()
        drawer = (self.WEB / "components/evidence-drawer.tsx").read_text()
        data = (self.WEB / "lib/real-data.ts").read_text()
        self.assertIn(f"calibratedProbability.toFixed({PROBABILITY_DISPLAYED_DECIMALS})", role_page)
        # Both surfaces format a factor the same way, in the loader that feeds them.
        self.assertIn(f"Number(value).toFixed({FACTOR_DISPLAYED_DECIMALS})", data)
        self.assertIn("confidenceFactors.map", drawer + role_page)

    def test_the_basis_share_is_a_whole_percent_and_confidence_a_whole_score(self) -> None:
        basis = (self.WEB / "lib/forecast-basis.ts").read_text()
        self.assertEqual(BASIS_SHARE_DISPLAYED_DECIMALS, 0)
        self.assertIn("Math.round(presentation.share(basis) * 100)", basis)
        self.assertEqual(CONFIDENCE_DISPLAYED_DECIMALS, 0, "the score is shown as a whole number out of 100")


if __name__ == "__main__":
    unittest.main()
