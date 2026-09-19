"""Regression tests for the archive evidence and recruiting-cycle models.

Every case here reproduces a failure mode observed on the live corpus. Fixtures are
sanitized and use reserved `.example` hosts; they demonstrate semantics only and are
never evidence that the real corpus is backtest-ready.
"""

import sys
import unittest
from datetime import UTC, date, datetime
from itertools import pairwise
from pathlib import Path
from uuid import NAMESPACE_URL, UUID, uuid5

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from firstseen.adapters.generic import _is_navigation_phrase
from firstseen.backtesting import BacktestEvent, BacktestRunner, collapse_event_cycles
from firstseen.cycles import ANNUAL_CYCLE_MIN_GAP_DAYS, derive_cycle_key
from firstseen.history import HistoricalOpeningResolver, RecurringRoleIdentity
from firstseen.models import ArchiveCapture

SOURCE_ID = UUID("00000000-0000-4000-8000-000000000701")
COMPANY_ID = UUID("00000000-0000-4000-8000-000000000001")
PAGE_URL = "https://careers.fixture.example/students"


def capture(
    when: datetime,
    *,
    titles: list[str],
    excerpt: str = "Open roles. Apply now to our student programs.",
    status: int = 200,
    partial: bool = False,
    completeness: float = 0.9,
) -> ArchiveCapture:
    stamp = when.strftime("%Y%m%d%H%M%S")
    capture_id = uuid5(NAMESPACE_URL, f"capture:{stamp}")
    return ArchiveCapture(
        id=capture_id,
        observation_id=uuid5(capture_id, "page-observation"),
        source_id=SOURCE_ID,
        original_url=PAGE_URL,
        archive_url=f"https://web.archive.org/web/{stamp}id_/{PAGE_URL}",
        captured_at=when,
        status_code=status,
        change_kind="meaningful_change",
        completeness=completeness,
        is_partial=partial,
        detected_titles=titles,
        evidence_excerpt=excerpt,
    )


def role(title: str, aliases: list[str] | None = None) -> RecurringRoleIdentity:
    return RecurringRoleIdentity(
        id=uuid5(NAMESPACE_URL, f"role:{title}"),
        company_id=COMPANY_ID,
        company="Fixture Robotics",
        canonical_title=title,
        track="internship",
        aliases=aliases or [title],
    )


def resolve(subject: RecurringRoleIdentity, captures: list[ArchiveCapture]):
    return HistoricalOpeningResolver().resolve(subject, captures=captures, observations=[])


def at(year: int, month: int, day: int) -> datetime:
    return datetime(year, month, day, 12, tzinfo=UTC)


def event(event_id: str, opened: date, *, cycle_key: str | None = None, quality: float = 0.9):
    return BacktestEvent(
        event_id,
        "role-swe",
        opened,
        datetime.combine(opened, datetime.min.time(), UTC),
        quality,
        cycle_key=cycle_key,
    )


class ArchiveVisibilityTests(unittest.TestCase):
    """Stage 2: capture time means 'visible by', never 'opened at'."""

    def test_one_page_carries_evidence_for_several_roles(self):
        titles = ["Software Engineer Intern", "Data Science Intern", "Product Manager"]
        captures = [capture(at(2024, 9, 1), titles=titles)]
        for title in titles:
            with self.subTest(title=title):
                events = resolve(role(title), captures)
                self.assertEqual(len(events), 1)
                self.assertEqual(events[0].date_precision, "observed_by")

    def test_one_observation_matches_several_canonical_roles(self):
        titles = ["Software Engineer Intern", "Data Science Intern"]
        captures = [capture(at(2024, 9, 1), titles=titles)]
        observation_ids = {resolve(role(t), captures)[0].observation_id for t in titles}
        # The same archived page observation backs both roles; it is not duplicated.
        self.assertEqual(len(observation_ids), 1)

    def test_continuous_presence_across_captures_is_one_opening(self):
        titles = ["Software Engineer Intern"]
        captures = [
            capture(at(2024, 9, 1), titles=titles),
            capture(at(2024, 10, 1), titles=titles),
            capture(at(2024, 11, 1), titles=titles),
            capture(at(2024, 12, 1), titles=titles),
        ]
        events = resolve(role("Software Engineer Intern"), captures)
        self.assertEqual(len(events), 1, "continued visibility must not repeat the opening")
        self.assertEqual(events[0].opening_window_end, date(2024, 9, 1))

    def test_trustworthy_absent_to_present_produces_bounded(self):
        subject = role("Software Engineer Intern")
        captures = [
            capture(at(2024, 8, 1), titles=["Product Manager"]),
            capture(at(2024, 9, 1), titles=["Software Engineer Intern"]),
        ]
        events = resolve(subject, captures)
        self.assertEqual(len(events), 1)
        self.assertEqual(events[0].date_precision, "bounded")
        self.assertEqual(events[0].opening_window_start, date(2024, 8, 2))
        self.assertEqual(events[0].opening_window_end, date(2024, 9, 1))

    def test_degraded_previous_snapshot_cannot_establish_absence(self):
        subject = role("Software Engineer Intern")
        for label, prior in {
            "partial body": capture(at(2024, 8, 1), titles=[], partial=True),
            "redirect": capture(at(2024, 8, 1), titles=[], status=302),
            "non-recruiting page": capture(
                at(2024, 8, 1), titles=[], excerpt="Cookie preferences and privacy notice."
            ),
        }.items():
            with self.subTest(prior=label):
                events = resolve(
                    subject, [prior, capture(at(2024, 9, 1), titles=["Software Engineer Intern"])]
                )
                self.assertEqual(len(events), 1)
                self.assertEqual(
                    events[0].date_precision,
                    "observed_by",
                    "absence must not be inferred from a degraded snapshot",
                )
                self.assertIsNone(events[0].opening_window_start)

    def test_disappearance_then_reappearance_in_a_later_year(self):
        subject = role("Software Engineer Intern")
        present = ["Software Engineer Intern"]
        captures = [
            capture(at(2024, 9, 1), titles=present),
            capture(at(2024, 12, 1), titles=["Product Manager"]),
            capture(at(2025, 9, 1), titles=present),
        ]
        events = sorted(resolve(subject, captures), key=lambda item: item.opened_on)
        self.assertEqual(len(events), 2, "a genuine reappearance is a second opening")
        self.assertEqual(events[0].closed_on, date(2024, 12, 1))
        self.assertEqual(events[1].opened_on.year, 2025)

    def test_many_roles_on_one_capture_date_do_not_become_identical_cycles(self):
        # Live corpus: 293 roles shared one capture-date set, which looked like
        # synchronized annual recurrence across unrelated roles.
        titles = [f"Engineer Intern {index}" for index in range(5)]
        captures = [
            capture(at(2024, 9, 1), titles=titles),
            capture(at(2024, 10, 1), titles=titles),
            capture(at(2024, 11, 1), titles=titles),
        ]
        for title in titles:
            events = resolve(role(title), captures)
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].date_precision, "observed_by")


class RecruitingCycleIdentityTests(unittest.TestCase):
    """Stage 4: sample_size counts cohorts, not requisition publications."""

    def test_same_year_reposts_are_one_cycle(self):
        events = [
            event("feb", date(2026, 2, 3)),
            event("may", date(2026, 5, 12)),
            event("aug", date(2026, 8, 20)),
        ]
        self.assertEqual(len(collapse_event_cycles(events)), 1)

    def test_evergreen_requisition_refreshes_do_not_inflate_history(self):
        # Live corpus: an evergreen backend role published 8 times across 2021-2026
        # reported sample_size=8 and escaped the sparse-history confidence caps.
        raw = [
            date(2021, 10, 21), date(2022, 12, 20), date(2023, 6, 1), date(2024, 9, 17),
            date(2025, 5, 6), date(2025, 7, 25), date(2025, 12, 3), date(2026, 1, 29),
        ]
        collapsed = collapse_event_cycles([event(str(d), d) for d in raw])
        self.assertLess(len(collapsed), len(raw))
        for earlier, later in pairwise(collapsed):
            self.assertGreaterEqual(
                (later.opened_on - earlier.opened_on).days,
                ANNUAL_CYCLE_MIN_GAP_DAYS,
                "cycles must be an annual distance apart without cohort evidence",
            )

    def test_explicit_cohort_progression_is_three_cycles(self):
        events = [
            event("s24", date(2023, 9, 1), cycle_key="summer-2024"),
            event("s25", date(2024, 9, 1), cycle_key="summer-2025"),
            event("s26", date(2025, 9, 1), cycle_key="summer-2026"),
        ]
        self.assertEqual(len(collapse_event_cycles(events)), 3)

    def test_same_cohort_reposted_months_apart_stays_one_cycle(self):
        events = [
            event("first", date(2025, 9, 1), cycle_key="fall-2026"),
            event("repost", date(2026, 1, 15), cycle_key="fall-2026"),
        ]
        self.assertEqual(len(collapse_event_cycles(events)), 1)

    def test_cycle_key_requires_a_source_stated_year(self):
        self.assertEqual(derive_cycle_key("SWE Intern (Fall 2026)", "fall", date(2025, 9, 1)), "fall-2026")
        self.assertEqual(derive_cycle_key("SWE Intern 2027", "summer", date(2026, 1, 1)), "summer-2027")
        # A season alone repeats every year and is not a cohort.
        self.assertIsNone(derive_cycle_key("Software Engineer Intern", "fall", date(2026, 9, 1)))
        # The publication year must never be used to invent a cohort.
        self.assertIsNone(derive_cycle_key("Backend Engineer", None, date(2026, 3, 1)))

    def test_held_out_cohort_cannot_leak_through_a_late_repost(self):
        runner = BacktestRunner()
        target = event("target", date(2026, 9, 1), cycle_key="fall-2026")
        repost = event("repost-of-target", date(2026, 2, 1), cycle_key="fall-2026")
        unrelated = event("prior-cycle", date(2025, 9, 1), cycle_key="fall-2025")
        self.assertFalse(runner._known_event(repost, date(2026, 6, 1), target))
        self.assertTrue(runner._known_event(unrelated, date(2026, 6, 1), target))


class ArchiveExtractionNoiseTests(unittest.TestCase):
    """Stage 3: page furniture must never become a canonical role."""

    def test_navigation_blog_and_marketing_titles_are_rejected(self):
        for title in [
            "See Open Positions",
            "Learn more about our associate networks",
            "Making Spark Accessible My Databricks Journey",
            "The Journey From Intern To New Grad",
            "Become A Stripe Intern",
            "GitLab 18.8 release notes",
            "Students",
            "Careers",
            "Join us",
            "Why Databricks",
            "Life at Figma",
        ]:
            with self.subTest(title=title):
                self.assertTrue(_is_navigation_phrase(title))

    def test_real_requisition_titles_are_kept(self):
        for title in [
            "Software Engineer Intern",
            "Data Science Intern (Summer 2026)",
            "Associate Product Manager, New Grad",
            "Machine Learning Intern/Co-op (Winter 2027)",
            "Professional Services Intern – Global Customer Services (Fall 2026)",
        ]:
            with self.subTest(title=title):
                self.assertFalse(_is_navigation_phrase(title))


if __name__ == "__main__":
    unittest.main()
