from __future__ import annotations

import unittest
from datetime import UTC, date, datetime
from uuid import UUID, uuid4

from firstseen.adapters.base import FetchedDocument, SourceConfig
from firstseen.forecasting import HistoricalOpening, Signal, forecast_opening_window
from firstseen.repository import bounded_utf8
from firstseen.signals import (
    AtsRoleFamilySignalDetector,
    CompanyPageSignalAdapter,
    ForecastChange,
    RecruitingSignal,
    RecruitingSignalIngestionService,
    SignalForecastVersionService,
    SignalSourceState,
    StoredForecastVersion,
    _normalized_page_text,
)

COMPANY_ID = UUID("00000000-0000-4000-8000-000000000001")
ROLE_ID = UUID("00000000-0000-4000-8000-000000000011")
SOURCE_ID = UUID("00000000-0000-4000-8000-000000000101")
SEEN = datetime(2026, 8, 14, 10, tzinfo=UTC)


class Transport:
    def __init__(self, responses: dict[str, tuple[bytes, str]]) -> None:
        self.responses = responses

    def get(self, url: str, *, accept: str = "*/*") -> FetchedDocument:
        del accept
        body, content_type = self.responses[url]
        return FetchedDocument(url, 200, content_type, body)


def source(adapter: str, url: str, **options: object) -> SourceConfig:
    return SourceConfig(
        id=SOURCE_ID,
        company_id=COMPANY_ID,
        company="Fixture Robotics",
        adapter=adapter,
        url=url,
        trust_score=0.9,
        options=options,
    )


class MemorySignalStore:
    def __init__(self) -> None:
        self.states: dict[UUID, SignalSourceState] = {}
        self.signals: dict[str, RecruitingSignal] = {}
        self.observations = 0
        self.observation_ids: dict[tuple[UUID, str], UUID] = {}

    def get_signal_source_state(self, source_id: UUID) -> SignalSourceState | None:
        return self.states.get(source_id)

    def save_signal_source_state(self, state: SignalSourceState) -> None:
        self.states[state.source_id] = state

    def save_signal_observation(self, source: SourceConfig, **kwargs: object) -> UUID:
        # The real store (repository.save_signal_observation) returns the existing row when one already holds this
        # source and content hash, and inserts only when none does. The fake counted every call, which hid that a page
        # serving the same content with different bytes was writing a new observation every run.
        key = (source.id, str(kwargs.get("document_hash")))
        if key in self.observation_ids:
            return self.observation_ids[key]
        self.observations += 1
        self.observation_ids[key] = UUID(f"00000000-0000-4000-8000-{self.observations:012d}")
        return self.observation_ids[key]

    def resolve_signal_role(self, company_id: UUID, evidence: str) -> UUID | None:
        del company_id
        return ROLE_ID if "software engineer" in evidence.casefold() else None

    def list_company_role_ids(self, company_id: UUID) -> list[UUID]:
        del company_id
        return [ROLE_ID]

    def upsert_recruiting_signal(self, signal: RecruitingSignal) -> bool:
        if signal.identity_key in self.signals:
            return False
        self.signals[signal.identity_key] = signal
        return True


class UnchangedPageWritesNoObservationTests(unittest.TestCase):
    """A page whose bytes moved but whose content did not must not store an observation.

    `save_signal_observation` writes a row when it finds none on (source_id, content_hash). Keyed on the raw response
    hash, a rendered-at comment or reordered lines counted as new content, so a signals run wrote an observation for a
    page it had just decided was unchanged -- and every such row moved the company's enrichment fingerprint, which is
    why no company was ever skipped. The observation is keyed on the same hash the detector compares.
    """

    def test_byte_churn_on_an_unchanged_page_is_one_observation_not_three(self) -> None:
        url = "https://careers.fixture.example/students"
        body = b"<main>\n<h1>Student programs</h1>\n<p>Applications open in the autumn.</p>\n"
        pages = [
            body + b"<!-- rendered 06:00:02Z -->\n</main>",
            body + b"<!-- rendered 18:00:07Z -->\n</main>",
            b"<main>\n<p>Applications open in the autumn.</p>\n<h1>Student programs</h1>\n</main>",
        ]
        transport = Transport({url: (pages[0], "text/html")})
        store = MemorySignalStore()
        service = RecruitingSignalIngestionService(store, transport)
        for page in pages:
            transport.responses[url] = (page, "text/html")
            summary = service.ingest(source("generic", url), observed_at=SEEN)
            self.assertEqual(summary.detected, 0, "the page never meaningfully changed")
        self.assertEqual(store.observations, 1, "one observation for a page that never changed, not one per run")


class RecruitingSignalTests(unittest.TestCase):
    def test_company_program_page_requires_change_then_emits_bounded_signal(self) -> None:
        url = "https://careers.fixture.example/students"
        transport = Transport({url: (b"<main>Student programs overview</main>", "text/html")})
        store = MemorySignalStore()
        service = RecruitingSignalIngestionService(store, transport)

        baseline = service.ingest(source("generic", url), observed_at=SEEN)
        self.assertEqual(baseline.detected, 0)
        transport.responses[url] = (
            b"<main>Student programs overview</main><p>Software Engineer internship applications open soon.</p>",
            "text/html",
        )
        changed = service.ingest(source("generic", url), observed_at=datetime(2026, 8, 15, 10, tzinfo=UTC))
        signal = next(iter(store.signals.values()))

        self.assertEqual(changed.created, 1)
        self.assertEqual(signal.signal_type, "internship_program_page_changed")
        self.assertEqual(signal.canonical_role_id, ROLE_ID)
        self.assertEqual(signal.signal_strength, 0.68)
        self.assertEqual(signal.source_reliability, 0.9)
        self.assertIsNone(signal.claimed_event_at)
        self.assertEqual(signal.extraction_method, "static_html")
        self.assertLessEqual(len(signal.evidence_snippet), 8_192)
        unchanged = service.ingest(source("generic", url), observed_at=datetime(2026, 8, 16, 10, tzinfo=UTC))
        self.assertEqual(unchanged.detected, 0)
        self.assertEqual(len(store.signals), 1)

    def test_feed_uses_published_but_never_atom_updated_as_claimed_time(self) -> None:
        url = "https://fixture.example/recruiting.atom"
        initial = b"""<feed xmlns='http://www.w3.org/2005/Atom'><entry><id>old</id><title>Company news</title><link href='https://fixture.example/old'/></entry></feed>"""
        changed = b"""<feed xmlns='http://www.w3.org/2005/Atom'>
          <entry><id>new</id><title>University recruiting applications</title>
          <link href='https://fixture.example/interns'/><updated>2026-08-15T09:00:00Z</updated>
          <summary>Meet our internship recruiting team.</summary></entry></feed>"""
        transport = Transport({url: (initial, "application/atom+xml")})
        store = MemorySignalStore()
        service = RecruitingSignalIngestionService(store, transport)
        service.ingest(source("rss", url), observed_at=SEEN)
        transport.responses[url] = (changed, "application/atom+xml")

        result = service.ingest(source("rss", url), observed_at=datetime(2026, 8, 15, 10, tzinfo=UTC))
        signal = next(iter(store.signals.values()))
        self.assertEqual(result.created, 1)
        self.assertEqual(signal.signal_type, "company_recruiting_blog_post")
        self.assertIsNone(signal.claimed_event_at)
        self.assertEqual(signal.source_url.host, "fixture.example")

    def test_sitemap_emits_only_new_recruiting_urls_after_baseline(self) -> None:
        url = "https://fixture.example/sitemap.xml"
        before = b"<urlset><url><loc>https://fixture.example/about</loc></url></urlset>"
        after = b"""<urlset><url><loc>https://fixture.example/about</loc></url>
          <url><loc>https://fixture.example/careers/software-internship</loc></url></urlset>"""
        transport = Transport({url: (before, "application/xml")})
        store = MemorySignalStore()
        service = RecruitingSignalIngestionService(store, transport)
        service.ingest(source("sitemap", url), observed_at=SEEN)
        transport.responses[url] = (after, "application/xml")

        result = service.ingest(source("sitemap", url), observed_at=datetime(2026, 8, 15, 10, tzinfo=UTC))
        signal = next(iter(store.signals.values()))
        self.assertEqual(result.created, 1)
        self.assertEqual(signal.signal_type, "new_relevant_sitemap_url")
        self.assertNotIn("lastmod", signal.evidence_snippet)

    def test_ats_detector_and_social_boundary_do_not_require_an_llm(self) -> None:
        signals = AtsRoleFamilySignalDetector().detect(
            source_url="https://jobs.fixture.example",
            previous_families=["design"],
            current_families=["design", "software engineering"],
        )
        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0].signal_type, "new_ats_role_family_appearing")
        self.assertIn("software engineering", signals[0].evidence_snippet)

    def test_company_page_classification_covers_career_and_university_updates(self) -> None:
        configured = source("generic", "https://fixture.example/careers")
        self.assertEqual(
            CompanyPageSignalAdapter._type(configured, "Careers and hiring applications"),
            "career_page_changed",
        )
        self.assertEqual(
            CompanyPageSignalAdapter._type(configured, "University recruiting calendar"),
            "university_recruiting_page_update",
        )


class CompanyPageChangeTests(unittest.TestCase):
    """Only added recruiting lines are evidence; reordering, removal, and noise are not."""

    URL = "https://careers.fixture.example/students"
    OVERVIEW = "<p>Student programs overview</p>"
    OPENING = "<p>Software Engineer internship applications open soon.</p>"

    def ingest_twice(self, before: str, after: str) -> tuple[int, int, MemorySignalStore]:
        transport = Transport({self.URL: (before.encode(), "text/html")})
        store = MemorySignalStore()
        service = RecruitingSignalIngestionService(store, transport)
        baseline = service.ingest(source("generic", self.URL), observed_at=SEEN)
        self.assertEqual(baseline.detected, 0)
        transport.responses[self.URL] = (after.encode(), "text/html")
        later = service.ingest(source("generic", self.URL), observed_at=datetime(2026, 8, 15, 10, tzinfo=UTC))
        return later.detected, later.created, store

    def test_reordered_content_is_not_a_change(self) -> None:
        # Ramp's careers page serves the same lines in a new order on every request; the old
        # fallback sentence turned that into a signal that raised confidence on four roles.
        detected, created, store = self.ingest_twice(
            f"<main>{self.OVERVIEW}{self.OPENING}</main>", f"<main>{self.OPENING}{self.OVERVIEW}</main>"
        )
        self.assertEqual((detected, created, store.signals), (0, 0, {}))

    def test_removed_recruiting_material_is_not_evidence_of_activity(self) -> None:
        detected, created, _ = self.ingest_twice(
            f"<main>{self.OVERVIEW}{self.OPENING}</main>", f"<main>{self.OVERVIEW}</main>"
        )
        self.assertEqual((detected, created), (0, 0))

    def test_added_material_without_recruiting_terms_is_not_a_signal(self) -> None:
        detected, created, _ = self.ingest_twice(
            f"<main>{self.OVERVIEW}</main>", f"<main>{self.OVERVIEW}<p>Our offices are in Lisbon.</p></main>"
        )
        self.assertEqual((detected, created), (0, 0))

    def test_added_recruiting_line_is_quoted_verbatim(self) -> None:
        detected, created, store = self.ingest_twice(
            f"<main>{self.OVERVIEW}</main>",
            f"<main>{self.OVERVIEW}<p>Our offices are in Lisbon.</p>{self.OPENING}</main>",
        )
        self.assertEqual((detected, created), (1, 1))
        signal = next(iter(store.signals.values()))
        self.assertEqual(signal.evidence_snippet, "Software Engineer internship applications open soon.")

    def test_stored_text_is_exactly_what_the_page_diff_compares(self) -> None:
        # Control characters are removed and the byte bound falls on a line boundary, so saving
        # the state (bounded_utf8) cannot change the text and later diffs cannot see a lost tail
        # as newly added.
        lines = "".join(f"<p>採用情報 学生インターン {index}\x00</p>" for index in range(4_000))
        text = _normalized_page_text(f"<main>{lines}</main>")
        self.assertLessEqual(len(text.encode()), 65_536)
        self.assertNotIn("\x00", text)
        self.assertEqual(bounded_utf8(text, 65_536), text)
        self.assertTrue(text.splitlines()[-1].endswith(tuple("0123456789")))


class MemoryForecastStore:
    def __init__(self, before: StoredForecastVersion) -> None:
        self.current = before
        self.changes: list[ForecastChange] = []
        self.saved: list[StoredForecastVersion] = [before]

    def latest_forecast_version(self, role_id: UUID) -> StoredForecastVersion | None:
        del role_id
        return self.current

    def save_signal_forecast_version(
        self,
        role_id: UUID,
        forecast: object,
        *,
        supersedes_id: UUID | None,
        trigger_signal_ids: list[UUID] | tuple[UUID, ...],
    ) -> StoredForecastVersion:
        del supersedes_id, trigger_signal_ids
        version = StoredForecastVersion(uuid4(), role_id, forecast)  # type: ignore[arg-type]
        self.current = version
        self.saved.append(version)
        return version

    def save_forecast_change(self, change: ForecastChange) -> None:
        self.changes.append(change)


class SignalForecastVersionTests(unittest.TestCase):
    def test_signal_changes_confidence_not_date_and_persists_before_after(self) -> None:
        history = [
            HistoricalOpening(date(year, 9, day), 0.95, evidence_id=f"event-{year}")
            for year, day in [(2022, 8), (2023, 12), (2024, 9), (2025, 11)]
        ]
        before_forecast = forecast_opening_window(history, as_of=date(2026, 8, 14))
        after_forecast = forecast_opening_window(
            history,
            [Signal(date(2026, 8, 14), 0.9, 0.95, "internship_program_page_changed")],
            as_of=date(2026, 8, 14),
        )
        before = StoredForecastVersion(uuid4(), ROLE_ID, before_forecast)
        store = MemoryForecastStore(before)
        trigger_id = uuid4()

        change = SignalForecastVersionService(store).persist_recomputed(
            ROLE_ID, after_forecast, trigger_signal_ids=(trigger_id,)
        )

        self.assertIsNotNone(change)
        assert change is not None
        self.assertEqual(len(store.saved), 2)
        self.assertEqual(change.before_forecast_id, before.id)
        self.assertEqual(change.after_forecast_id, store.saved[-1].id)
        self.assertEqual(before_forecast.point_date, after_forecast.point_date)
        self.assertGreater(change.confidence_delta, 0)
        self.assertTrue(change.material)
        self.assertEqual(change.reasons, ("confidence_threshold_crossed",))


class SignalVersionIdempotencyTests(unittest.TestCase):
    history = tuple(
        HistoricalOpening(date(year, 9, day), 0.95, evidence_id=f"event-{year}")
        for year, day in [(2022, 8), (2023, 12), (2024, 9), (2025, 11)]
    )

    def test_a_weak_signal_versions_the_forecast_without_a_material_change(self) -> None:
        before_forecast = forecast_opening_window(self.history, as_of=date(2026, 8, 14))
        after_forecast = forecast_opening_window(
            self.history,
            [Signal(date(2026, 8, 14), 0.05, 0.1, "internship_program_page_changed")],
            as_of=date(2026, 8, 14),
        )
        store = MemoryForecastStore(StoredForecastVersion(uuid4(), ROLE_ID, before_forecast))
        service = SignalForecastVersionService(store)

        change = service.persist_recomputed(ROLE_ID, after_forecast, trigger_signal_ids=(uuid4(),))

        assert change is not None
        self.assertEqual(service.last_outcome, "inserted")
        self.assertLess(abs(change.confidence_delta), 1)
        self.assertFalse(change.material)
        self.assertEqual(change.reasons, ())

    def test_a_rerun_with_identical_inputs_writes_no_version_and_no_change(self) -> None:
        before_forecast = forecast_opening_window(self.history, as_of=date(2026, 8, 14))
        after_forecast = forecast_opening_window(
            self.history,
            [Signal(date(2026, 8, 14), 0.9, 0.95, "internship_program_page_changed")],
            as_of=date(2026, 8, 14),
        )
        store = MemoryForecastStore(StoredForecastVersion(uuid4(), ROLE_ID, before_forecast))
        service = SignalForecastVersionService(store)
        trigger = (uuid4(),)

        service.persist_recomputed(ROLE_ID, after_forecast, trigger_signal_ids=trigger)
        versions, changes = len(store.saved), len(store.changes)
        again = service.persist_recomputed(ROLE_ID, after_forecast, trigger_signal_ids=trigger)

        self.assertIsNone(again)
        self.assertEqual(service.last_outcome, "unchanged")
        self.assertEqual(len(store.saved), versions)
        self.assertEqual(len(store.changes), changes)


if __name__ == "__main__":
    unittest.main()


class SitemapChildFailureTests(unittest.TestCase):
    """One unreadable child of a sitemap index does not cost the whole source.

    Dropbox's index lists ten children, and one of them answers with an HTML page. Refusing it is right -- it carries a
    doctype, and `parse_untrusted_xml` refuses those -- but the refusal used to end the source, discarding nine
    siblings including two with 370 KB of URLs between them. On 2026-09-20 that failed Dropbox's signals three runs in
    a row and opened an ops alert. Collection has isolated a child like this from the start (adapters/feeds.py).
    """

    INDEX = "https://fixture.example/sitemapindex.xml"
    GOOD = "https://fixture.example/careers/sitemap.xml"
    HTML = "https://fixture.example/business/sitemap.xml"

    def transport(self, *, html_child: bool = True) -> Transport:
        index = (
            f"<sitemapindex><sitemap><loc>{self.HTML}</loc></sitemap>"
            f"<sitemap><loc>{self.GOOD}</loc></sitemap></sitemapindex>"
        ).encode()
        responses = {
            self.INDEX: (index, "application/xml"),
            self.GOOD: (
                b"<urlset><url><loc>https://fixture.example/careers/software-internship</loc></url></urlset>",
                "application/xml",
            ),
        }
        if html_child:
            responses[self.HTML] = (b"<!DOCTYPE html>\n<html><body>Not a sitemap</body></html>", "text/html")
        return Transport(responses)

    def ingest(self, transport: Transport):
        store = MemorySignalStore()
        service = RecruitingSignalIngestionService(store, transport)
        first = service.ingest(source("sitemap", self.INDEX, emit_initial_signals=True), observed_at=SEEN)
        return store, first

    def test_the_readable_children_still_produce_their_signals(self) -> None:
        store, summary = self.ingest(self.transport())
        self.assertEqual(summary.created, 1, "the sibling's recruiting URL is still found")
        self.assertEqual(list(summary.unreadable_children), [self.HTML], "and the one that failed is reported")
        signal = next(iter(store.signals.values()))
        self.assertEqual(signal.signal_type, "new_relevant_sitemap_url")

    def test_a_child_that_answers_nothing_at_all_is_skipped_the_same_way(self) -> None:
        # The child is missing from the transport, so fetching it raises KeyError: any failure, not only a parse one.
        _, summary = self.ingest(self.transport(html_child=False))
        self.assertEqual(summary.created, 1)
        self.assertEqual(list(summary.unreadable_children), [self.HTML])

    def test_a_source_whose_own_document_cannot_be_read_still_fails(self) -> None:
        # A source that cannot be read at all has nothing to diff, so it must not look like a quiet success.
        transport = Transport({})
        store = MemorySignalStore()
        service = RecruitingSignalIngestionService(store, transport)
        with self.assertRaises(KeyError):
            service.ingest(source("sitemap", self.INDEX), observed_at=SEEN)
