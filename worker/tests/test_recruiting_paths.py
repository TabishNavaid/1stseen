"""Page sources collect recruiting paths only (recruiting_paths.py). Every address below is a rig source's shape."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from test_adapters import SEEN_AT, FakeTransport, source

from firstseen.adapters import GenericCareerPageAdapter, SitemapAdapter
from firstseen.adapters.registry import AdapterRegistry
from firstseen.adapters.wayback import WaybackAdapter
from firstseen.recruiting_paths import (
    page_source_allowed,
    recruiting_page,
    recruiting_sitemap,
    sitemap_children,
    sitemap_job_page,
)
from firstseen.source_ingestion import MemoryObservationStore, SourceIngestionService


class RecruitingPageTests(unittest.TestCase):
    def test_recruiting_paths_and_hosts_are_collected(self) -> None:
        for url in (
            "https://www.appliedintuition.com/careers",
            "https://akunacapital.com/work-with-us/early-careers",
            "https://www.belvederetrading.com/new-graduates-campus-recruiting",
            "https://www.imc.com/us/careers/students-graduates",
            "https://dvtrading.co/job-post/2025-summer-internship-it",
            "https://www.hudsonrivertrading.com/hrt-job/hardware-engineer-internship-summer-2027",
            "https://id.me/jobshub?utm_source=nav_menu_interior",
            "https://careers.abbvie.com/",
            "https://careers.snowflake.com/us/en/search-results",
            "https://university.gitlab.com/",
            "https://www.optiver.com/join-us/jobs/technology/london/graduate-software-engineer",
        ):
            with self.subTest(url=url):
                self.assertTrue(recruiting_page(url))

    def test_pages_off_a_recruiting_path_are_not(self) -> None:
        for url in (
            # Canonical: the homepage, the navigation fragment, and Ubuntu's IoT product and contact pages.
            "https://canonical.com/",
            "https://canonical.com/navigation",
            "https://ubuntu.com/internet-of-things/appstore",
            "https://ubuntu.com/internet-of-things/contact-us?product=management",
            # "intern" is a whole word: "internet" is not one.
            "https://datascience.uchicago.edu/research/internet-innovation",
            "https://www.notion.com/customers/ramp",
            "https://learn.snowflake.com/en",
            "https://twitter.com/point72careers",
            "https://www.hudsonrivertrading.com/offices",
        ):
            with self.subTest(url=url):
                self.assertFalse(recruiting_page(url))

    def test_story_blog_news_and_benefit_sections_are_not_postings_even_on_recruiting_paths(self) -> None:
        for url in (
            "https://www.optiver.com/join-us/stories/nicks-experience-as-a-2x-trading-intern-at-optiver",
            "https://point72.com/blog/2026-summer-intern-spotlight-first-impressions",
            "https://careers.withwaymo.com/blog/riding-with-waymo",
            "https://careers.withwaymo.com/benefits",
            "https://www.bosch.com/careers/why-bosch/benefits",
            "https://cohere.com/blog/cohere-university-of-waterloo-announcement",
            "https://example.com/2026/09/04/visit-us-on-campus",
        ):
            with self.subTest(url=url):
                self.assertFalse(recruiting_page(url))
        # A posting's own slug after /jobs/ may start with any word.
        self.assertTrue(recruiting_page("https://example.com/careers/jobs/events-coordinator-intern"))
        self.assertTrue(recruiting_page("https://example.com/jobs/legal-intern"))


class RecruitingSitemapTests(unittest.TestCase):
    def test_root_and_recruiting_sitemaps_are_collected(self) -> None:
        for url in (
            "https://canonical.com/sitemap.xml",
            "https://fiverings.com/sitemap_index.xml",
            "https://shield.ai/wp-sitemap.xml",
            "https://stripe.com/sitemap/sitemap.xml",
            "https://replit.com/sitemaps/main.xml",
            "https://www.coinbase.com/sitemap-careers.xml",
            "https://scale.com/careers/sitemap.xml",
        ):
            with self.subTest(url=url):
                self.assertTrue(recruiting_sitemap(url))

    def test_section_topic_and_catalogue_sitemaps_are_not(self) -> None:
        for url in (
            "https://canonical.com/microk8s/docs/sitemap.xml",
            "https://canonical.com/knowledge/sitemap.xml",
            "https://canonical.com/partners/sitemap.xml",
            "https://canonical.com/blog/sitemap.xml",
            "https://ramp.com/sitemap/per-diem-calculator.xml",
            "https://www.coinbase.com/sitemap-derivatives-index.xml",
            "https://www.roblox.com/sitemap-de.xml",
            "https://sitemaps.notion.com/sitemap-categories.xml",
            "https://www.veeva.com/sitemap.rss",
        ):
            with self.subTest(url=url):
                self.assertFalse(recruiting_sitemap(url))

    def test_children_put_recruiting_first_and_drop_sections(self) -> None:
        children = [
            "https://example.com/page-sitemap.xml",
            "https://example.com/blog/sitemap.xml",
            "https://example.com/job-sitemap.xml",
            "https://example.com/sitemap-2.xml",
        ]
        self.assertEqual(
            sitemap_children(children),
            ["https://example.com/job-sitemap.xml", "https://example.com/page-sitemap.xml", "https://example.com/sitemap-2.xml"],
        )

    def test_a_sitemap_page_is_fetched_only_below_a_posting_segment(self) -> None:
        for url in (
            "https://careers.example.test/jobs/site-801",
            "https://canonical.com/careers/4981249",
            "https://www.hudsonrivertrading.com/hrt-job/algorithm-developer-quant-research-trading-2027-grads/",
            "https://stripe.com/careers/listing/aeo-and-geo-marketing-manager/7844214",
            "https://www.coinbase.com/careers/positions/8175471",
        ):
            with self.subTest(url=url):
                self.assertTrue(sitemap_job_page(url))
        for url in (
            "https://careers.example.test/about",
            "https://www.optiver.com/join-us/stories/day-in-the-life-quant-trader-intern",
            # Recruiting landing pages, a taxonomy archive, and a news story are not postings (DRW, AbbVie).
            "https://drw.com/work-at-drw/who-we-are",
            "https://drw.com/tags/university-recruiting/page/1",
            "https://drw.com/convexity/updates/viceroy-hotel-chicago-races-toward-september-opening-date",
            "https://www.abbvie.com/join-us/life-at-abbvie/well-being-in-the-workplace",
            "https://www.lyft.com/careers",
            "https://www.bosch.com/careers/why-bosch/benefits/",
        ):
            with self.subTest(url=url):
                self.assertFalse(sitemap_job_page(url))

    def test_the_sitemap_bound_is_spent_on_recruiting_children(self) -> None:
        index = (
            b'<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            b"<sitemap><loc>https://www.fixture.test/blog/sitemap.xml</loc></sitemap>"
            b"<sitemap><loc>https://www.fixture.test/product-sitemap.xml</loc></sitemap>"
            b"<sitemap><loc>https://www.fixture.test/careers-sitemap.xml</loc></sitemap>"
            b"</sitemapindex>"
        )
        careers = (
            b'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            b"<url><loc>https://www.fixture.test/about</loc></url></urlset>"
        )
        transport = FakeTransport(
            {
                "https://www.fixture.test/sitemap_index.xml": (index, "application/xml"),
                "https://www.fixture.test/careers-sitemap.xml": (careers, "application/xml"),
            }
        )
        SitemapAdapter().collect(
            source("sitemap", "https://www.fixture.test/sitemap_index.xml", options={"max_sitemaps": 2}), transport, observed_at=SEEN_AT
        )
        self.assertEqual(transport.calls, ["https://www.fixture.test/sitemap_index.xml", "https://www.fixture.test/careers-sitemap.xml"])


class IngestionTests(unittest.TestCase):
    def test_a_page_source_off_a_recruiting_path_is_skipped_before_any_request_or_write(self) -> None:
        transport = FakeTransport({})
        store = MemoryObservationStore()
        service = SourceIngestionService(AdapterRegistry([GenericCareerPageAdapter(), SitemapAdapter(), WaybackAdapter()]), transport, store)

        for adapter, url in (
            ("generic", "https://ubuntu.com/internet-of-things/appstore"),
            ("sitemap", "https://canonical.com/microk8s/docs/sitemap.xml"),
            ("wayback", "https://www.notion.com/customers/ramp"),
        ):
            with self.subTest(adapter=adapter):
                summary = service.ingest(source(adapter, url), observed_at=SEEN_AT)
                self.assertTrue(summary.complete, "a deliberate skip is not a degraded source")
                self.assertEqual([item.code for item in summary.diagnostics], ["source_not_on_recruiting_path"])
                self.assertEqual(summary.detected, 0)

        self.assertEqual(transport.calls, [])
        self.assertEqual((store.fetches, store.jobs, store.inference_decisions), ([], {}, []))

    def test_boards_and_feeds_are_not_judged_by_path(self) -> None:
        self.assertTrue(page_source_allowed("greenhouse", "https://boards.greenhouse.io/canonical"))
        self.assertTrue(page_source_allowed("rss", "https://canonical.com/careers/feed"))


if __name__ == "__main__":
    unittest.main()
