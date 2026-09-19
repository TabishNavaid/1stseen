import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from firstseen.adapters import (
    AshbyAdapter,
    FeedAdapter,
    GenericCareerPageAdapter,
    GreenhouseAdapter,
    LeverAdapter,
    LlmJobExtractor,
    SitemapAdapter,
    SmartRecruitersAdapter,
    SourceConfig,
)
from firstseen.adapters.base import (
    FetchedDocument,
    HostRateLimiter,
    JobCandidate,
    build_observation,
)
from firstseen.adapters.registry import AdapterRegistry
from firstseen.providers import CompletionResult
from firstseen.source_ingestion import MemoryObservationStore, SourceIngestionService

FIXTURES = Path(__file__).with_name("fixtures")
SEEN_AT = datetime(2026, 8, 14, 8, 0, tzinfo=UTC)
SOURCE_ID = UUID("00000000-0000-4000-8000-000000000101")
COMPANY_ID = UUID("00000000-0000-4000-8000-000000000001")


class FakeTransport:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def get(self, url, *, accept="*/*"):
        self.calls.append(url)
        body, content_type = self.responses[url]
        return FetchedDocument(url=url, status=200, content_type=content_type, body=body)


def fixture(name):
    return (FIXTURES / name).read_bytes()


def source(adapter, url, *, external_key=None, options=None):
    return SourceConfig(
        id=SOURCE_ID,
        company_id=COMPANY_ID,
        company="Fixture Robotics",
        adapter=adapter,
        url=url,
        external_key=external_key,
        trust_score=0.9,
        options=options or {},
    )


class AdapterTests(unittest.TestCase):
    def test_greenhouse_uses_first_published_but_never_updated_at(self):
        url = "https://boards-api.greenhouse.io/v1/boards/fixture/jobs?content=true"
        result = GreenhouseAdapter().collect(
            source("greenhouse", "https://boards.example.test", external_key="fixture"),
            FakeTransport({url: (fixture("greenhouse.json"), "application/json")}),
            observed_at=SEEN_AT,
        )
        by_title = {item.raw_title: item for item in result.observations}

        # `first_published` is the board's own first-publication timestamp.
        published = by_title["Software Engineering Intern"]
        self.assertEqual(published.published_at, datetime(2024, 9, 12, 18, 30, tzinfo=UTC))
        self.assertEqual(published.source_reliability["published_date_field"], "first_published")
        self.assertEqual(published.first_seen_at, SEEN_AT)
        self.assertNotEqual(published.published_at, published.first_seen_at)

        # `updated_at` moves on every edit and must never become a publication date.
        unpublished = by_title["Data Science Intern"]
        self.assertIsNone(unpublished.published_at)
        self.assertIsNone(unpublished.source_reliability["published_date_field"])
        self.assertFalse(unpublished.source_reliability["published_date_available"])

        # Departments are kept as how the board files the posting; a job without one has none.
        self.assertEqual(published.ats_categories.department, "Software Engineering")
        self.assertIsNone(unpublished.ats_categories)

    def test_invalid_structured_job_url_does_not_discard_valid_sibling(self):
        url = "https://boards-api.greenhouse.io/v1/boards/fixture/jobs?content=true"
        result = GreenhouseAdapter().collect(
            source("greenhouse", "https://boards.example.test", external_key="fixture"),
            FakeTransport({url: (fixture("greenhouse_mixed_urls.json"), "application/json")}),
            observed_at=SEEN_AT,
        )
        self.assertTrue(result.complete)
        self.assertEqual([item.raw_title for item in result.observations], ["Software Engineering Intern"])
        self.assertIn("invalid_job_candidate_skipped", {item.code for item in result.diagnostics})

    def test_lever_preserves_explicit_created_at(self):
        url = "https://api.lever.co/v0/postings/fixture?mode=json"
        result = LeverAdapter().collect(
            source("lever", "https://jobs.example.test", external_key="fixture"),
            FakeTransport({url: (fixture("lever.json"), "application/json")}),
            observed_at=SEEN_AT,
        )
        self.assertEqual(result.observations[0].published_at, datetime(2026, 8, 11, tzinfo=UTC))
        self.assertNotEqual(result.observations[0].published_at, result.observations[0].first_seen_at)
        categories = result.observations[0].ats_categories
        self.assertEqual((categories.department, categories.team), ("Engineering", "Backend"))

    def test_ashby_uses_published_at_and_apply_url(self):
        url = "https://api.ashbyhq.com/posting-api/job-board/fixture"
        job = (
            AshbyAdapter()
            .collect(
                source("ashby", "https://jobs.example.test", external_key="fixture"),
                FakeTransport({url: (fixture("ashby.json"), "application/json")}),
                observed_at=SEEN_AT,
            )
            .observations[0]
        )
        self.assertEqual(str(job.apply_url), "https://apply.example.test/ash-301")
        self.assertEqual(job.published_at, datetime(2026, 8, 9, 12, tzinfo=UTC))
        self.assertEqual((job.ats_categories.department, job.ats_categories.team), ("Engineering", "Data Science"))

    def test_smartrecruiters_normalizes_location_and_employment(self):
        url = "https://api.smartrecruiters.com/v1/companies/fixture/postings?limit=100"
        job = (
            SmartRecruitersAdapter()
            .collect(
                source("smartrecruiters", "https://jobs.example.test", external_key="fixture"),
                FakeTransport({url: (fixture("smartrecruiters.json"), "application/json")}),
                observed_at=SEEN_AT,
            )
            .observations[0]
        )
        self.assertEqual(job.location, "New York, NY, US")
        self.assertEqual(job.employment_type, "Full-time")
        categories = job.ats_categories
        self.assertEqual(
            (categories.department, categories.function, categories.experience_level),
            ("Product", "Product Management", "entry_level"),
        )

    def test_smartrecruiters_reports_truncated_result_instead_of_silent_success(self):
        url = "https://api.smartrecruiters.com/v1/companies/fixture/postings?limit=100"
        result = SmartRecruitersAdapter().collect(
            source("smartrecruiters", "https://jobs.example.test", external_key="fixture"),
            FakeTransport({url: (fixture("smartrecruiters_truncated.json"), "application/json")}),
            observed_at=SEEN_AT,
        )
        self.assertFalse(result.complete)
        self.assertEqual(len(result.observations), 1)
        self.assertIn("structured_page_truncated", {item.code for item in result.diagnostics})

    def test_generic_prefers_jobposting_jsonld(self):
        url = "https://careers.example.test/jobs"
        result = GenericCareerPageAdapter().collect(
            source("generic", url),
            FakeTransport({url: (fixture("career_jsonld.html"), "text/html")}),
            observed_at=SEEN_AT,
        )
        self.assertEqual(result.extraction_route, "json_ld")
        self.assertEqual(len(result.observations), 1)
        self.assertEqual(result.observations[0].published_at, datetime(2026, 8, 7, tzinfo=UTC))

    def test_generic_embedded_and_static_routes(self):
        embedded_url = "https://careers.example.test/embedded"
        static_url = "https://careers.example.test/static"
        adapter = GenericCareerPageAdapter()
        embedded = adapter.collect(
            source("generic", embedded_url),
            FakeTransport({embedded_url: (fixture("career_embedded.html"), "text/html")}),
            observed_at=SEEN_AT,
        )
        static = adapter.collect(
            source("generic", static_url),
            FakeTransport({static_url: (fixture("career_static.html"), "text/html")}),
            observed_at=SEEN_AT,
        )
        self.assertEqual(embedded.extraction_route, "embedded_data")
        self.assertEqual(static.extraction_route, "static_html")
        self.assertIsNone(static.observations[0].published_at)

    def test_static_html_ignores_navigation_and_collapses_tracking_duplicates(self):
        url = "https://careers.example.test/careers"
        store = MemoryObservationStore()
        summary = SourceIngestionService(
            AdapterRegistry([GenericCareerPageAdapter()]),
            FakeTransport({url: (fixture("career_navigation_noise.html"), "text/html")}),
            store,
        ).ingest(source("generic", url), observed_at=SEEN_AT)

        self.assertEqual(summary.detected, 1)
        self.assertEqual(len(store.jobs), 1)
        self.assertIn("duplicate_observation_collapsed", {item.code for item in summary.diagnostics})
        # Call-to-action copy observed on live careers pages must never become a job.
        titles = {job.raw_title for job in store.jobs.values()}
        self.assertEqual(titles, {"Software Engineer Intern"})
        for phrase in ("See open positions", "Learn more", "Explore"):
            self.assertFalse(
                any(title.startswith(phrase) for title in titles),
                f"navigation phrase {phrase!r} was extracted as a job title",
            )

    def test_rss_uses_pubdate_but_not_first_seen(self):
        url = "https://jobs.example.test/feed.xml"
        job = (
            FeedAdapter()
            .collect(
                source("rss", url),
                FakeTransport({url: (fixture("jobs.rss"), "application/rss+xml")}),
                observed_at=SEEN_AT,
            )
            .observations[0]
        )
        self.assertEqual(job.published_at, datetime(2026, 8, 6, 14, tzinfo=UTC))
        self.assertEqual(job.first_seen_at, SEEN_AT)

    def test_atom_uses_published_not_updated(self):
        url = "https://jobs.example.test/feed.atom"
        job = (
            FeedAdapter()
            .collect(
                source("rss", url),
                FakeTransport({url: (fixture("jobs.atom"), "application/atom+xml")}),
                observed_at=SEEN_AT,
            )
            .observations[0]
        )
        self.assertEqual(job.published_at, datetime(2026, 8, 5, 10, tzinfo=UTC))

    def test_atom_prefers_alternate_html_link_and_resolves_relative_url(self):
        url = "https://jobs.example.test/feed.atom"
        job = FeedAdapter().collect(
            source("rss", url),
            FakeTransport({url: (fixture("feed_alternate_link.atom"), "application/atom+xml")}),
            observed_at=SEEN_AT,
        ).observations[0]
        self.assertEqual(str(job.apply_url), "https://jobs.example.test/jobs/data-engineering-intern")

    def test_malformed_feed_is_degraded_not_a_valid_empty_feed(self):
        url = "https://jobs.example.test/feed.xml"
        result = FeedAdapter().collect(
            source("rss", url),
            FakeTransport({url: (fixture("feed_malformed.xml"), "application/xml")}),
            observed_at=SEEN_AT,
        )
        self.assertFalse(result.complete)
        self.assertEqual(result.diagnostics[0].code, "invalid_feed_xml")

    def test_malformed_structured_response_is_degraded_and_retried(self):
        url = "https://boards-api.greenhouse.io/v1/boards/fixture/jobs?content=true"
        configured = source("greenhouse", "https://boards.example.test", external_key="fixture")
        transport = FakeTransport({url: (b"<html>temporary gateway page</html>", "text/html")})
        store = MemoryObservationStore()
        service = SourceIngestionService(AdapterRegistry([GreenhouseAdapter()]), transport, store)

        first = service.ingest(configured, observed_at=SEEN_AT)
        second = service.ingest(configured, observed_at=SEEN_AT)

        self.assertFalse(first.complete)
        self.assertFalse(second.page_unchanged)
        self.assertNotIn(configured.id, store.document_hashes)
        self.assertEqual(transport.calls, [url, url])
        self.assertIn("invalid_json_response", {item.code for item in first.diagnostics})

    def test_generic_gates_browser_and_llm_fallbacks(self):
        url = "https://careers.example.test/dynamic"

        class Browser:
            def render(self, render_url):
                return FetchedDocument(render_url, 200, "text/html", fixture("career_jsonld.html"))

        browser_result = GenericCareerPageAdapter(browser=Browser()).collect(
            source("generic", url, options={"allow_browser": True}),
            FakeTransport({url: (b"<html><body>Loading</body></html>", "text/html")}),
            observed_at=SEEN_AT,
        )
        self.assertEqual(browser_result.extraction_route, "playwright")

        class Llm:
            def extract(self, html, *, source_url, company):
                return [
                    JobCandidate(
                        source_url=f"{source_url}/jobs/llm-1",
                        apply_url=f"{source_url}/jobs/llm-1",
                        raw_title="Compiler Engineering Intern",
                        company=company,
                        published_at=None,
                    )
                ]

        llm_result = GenericCareerPageAdapter(llm=Llm()).collect(
            source("generic", url, options={"allow_llm": True}),
            FakeTransport({url: (b"<html><body>Opaque job application</body></html>", "text/html")}),
            observed_at=SEEN_AT,
        )
        self.assertEqual(llm_result.extraction_route, "llm")
        self.assertIsNone(llm_result.observations[0].published_at)

    def test_sitemap_fetches_job_pages_and_never_uses_lastmod_as_published(self):
        sitemap_url = "https://careers.example.test/sitemap.xml"
        job_url = "https://careers.example.test/jobs/site-801"
        transport = FakeTransport(
            {
                sitemap_url: (fixture("sitemap.xml"), "application/xml"),
                job_url: (fixture("sitemap_job.html"), "text/html"),
            }
        )
        job = (
            SitemapAdapter()
            .collect(source("sitemap", sitemap_url), transport, observed_at=SEEN_AT)
            .observations[0]
        )
        self.assertIsNone(job.published_at)
        self.assertNotIn("https://careers.example.test/about", transport.calls)

    def test_sitemap_cycle_and_child_failure_preserve_successful_work(self):
        sitemap_url = "https://careers.example.test/cycle.xml"
        jobs_sitemap_url = "https://careers.example.test/jobs.xml"
        job_url = "https://careers.example.test/jobs/site-801"
        result = SitemapAdapter().collect(
            source("sitemap", sitemap_url, options={"max_sitemaps": 5}),
            FakeTransport(
                {
                    sitemap_url: (fixture("sitemap_cycle.xml"), "application/xml"),
                    jobs_sitemap_url: (fixture("sitemap.xml"), "application/xml"),
                    job_url: (fixture("sitemap_job.html"), "text/html"),
                }
            ),
            observed_at=SEEN_AT,
        )
        codes = {item.code for item in result.diagnostics}
        self.assertEqual(len(result.observations), 1)
        self.assertFalse(result.complete)
        self.assertIn("sitemap_cycle_skipped", codes)
        self.assertIn("sitemap_collection_failed", codes)

    def test_future_publication_date_is_not_accepted_as_exact_evidence(self):
        configured = source("generic", "https://careers.example.test/jobs")
        observation = build_observation(
            configured,
            JobCandidate(
                source_url="https://careers.example.test/jobs/future",
                apply_url="https://careers.example.test/jobs/future",
                raw_title="Future Intern",
                company="Fixture Robotics",
                published_at=datetime(2026, 8, 15, tzinfo=UTC),
            ),
            observed_at=SEEN_AT,
            extraction_route="json_ld",
        )
        self.assertIsNone(observation.published_at)
        self.assertEqual(observation.source_reliability["published_date_rejected"], "after_first_seen")

    def test_access_interstitial_does_not_trigger_browser_circumvention(self):
        url = "https://careers.example.test/jobs"

        class Browser:
            def render(self, render_url):
                raise AssertionError(f"browser must not render access challenge: {render_url}")

        result = GenericCareerPageAdapter(browser=Browser()).collect(
            source("generic", url, options={"allow_browser": True, "allow_llm": True}),
            FakeTransport({url: (b"<html>Verify you are human</html>", "text/html")}),
            observed_at=SEEN_AT,
        )
        self.assertFalse(result.complete)
        self.assertEqual(result.diagnostics[0].code, "access_interstitial_detected")

    def test_per_host_rate_limiter_paces_only_same_origin(self):
        now = [10.0]
        delays = []

        def sleep_for(delay):
            delays.append(delay)
            now[0] += delay

        limiter = HostRateLimiter(0.5, clock=lambda: now[0], sleeper=sleep_for)
        limiter.wait("https://jobs.example.test/a")
        limiter.wait("https://jobs.example.test/b")
        limiter.wait("https://other.example.test/a")
        self.assertEqual(delays, [0.5])

    def test_page_hash_skips_reprocessing_and_touches_last_seen(self):
        url = "https://careers.example.test/jobs"
        configured = source("generic", url)
        store = MemoryObservationStore()
        service = SourceIngestionService(
            AdapterRegistry([GenericCareerPageAdapter()]),
            FakeTransport({url: (fixture("career_jsonld.html"), "text/html")}),
            store,
        )
        first = service.ingest(configured, observed_at=SEEN_AT)
        second_seen = datetime(2026, 8, 15, 8, 0, tzinfo=UTC)
        second = service.ingest(configured, observed_at=second_seen)
        stored = next(iter(store.jobs.values()))
        self.assertEqual(first.created, 1)
        self.assertTrue(second.page_unchanged)
        self.assertEqual(second.unchanged, 1)
        self.assertEqual(stored.first_seen_at, SEEN_AT)
        self.assertEqual(stored.last_seen_at, second_seen)

    def test_changed_content_updates_hash_but_preserves_first_seen(self):
        url = "https://careers.example.test/jobs"
        configured = source("generic", url)
        store = MemoryObservationStore()
        transport = FakeTransport({url: (fixture("career_jsonld.html"), "text/html")})
        service = SourceIngestionService(AdapterRegistry([GenericCareerPageAdapter()]), transport, store)
        service.ingest(configured, observed_at=SEEN_AT)
        previous = next(iter(store.jobs.values()))
        transport.responses[url] = (
            fixture("career_jsonld.html").replace(
                b"Machine Learning Intern", b"Machine Learning Research Intern"
            ),
            "text/html",
        )
        changed_at = datetime(2026, 8, 16, 8, 0, tzinfo=UTC)
        summary = service.ingest(configured, observed_at=changed_at)
        current = next(iter(store.jobs.values()))
        self.assertEqual(summary.changed, 1)
        self.assertNotEqual(current.content_hash, previous.content_hash)
        self.assertEqual(current.first_seen_at, SEEN_AT)
        self.assertEqual(current.last_seen_at, changed_at)

    def test_llm_published_date_requires_exact_page_quote(self):
        class Client:
            def complete(self, **kwargs):
                return CompletionResult(
                    content='{"jobs":[{"title":"AI Intern","source_url":"/jobs/ai",'
                    '"apply_url":"/jobs/ai","published_at":"2026-08-01",'
                    '"published_date_quote":"Published August 1"}]}',
                    provider="fixture",
                    model="fixture-model",
                    prompt_tokens=10,
                    completion_tokens=10,
                    estimated_cost_usd=0,
                )

        candidates = LlmJobExtractor(Client()).extract(
            "<html><body>AI Intern opening</body></html>",
            source_url="https://careers.example.test",
            company="Fixture Robotics",
        )
        self.assertIsNone(candidates[0].published_at)


if __name__ == "__main__":
    unittest.main()
