import re
import sys
import unittest
from datetime import UTC, date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from urllib.error import HTTPError
from uuid import NAMESPACE_URL, uuid5

from firstseen.adapters.base import FetchedDocument
from firstseen.adapters.generic import GenericCareerPageAdapter
from firstseen.adapters.registry import AdapterRegistry
from firstseen.discovery import (
    MAX_SITEMAP_SOURCES,
    DiscoverRecruitingSources,
    DnsResult,
    IdentifyCompany,
    _ats_match,
)
from firstseen.providers import ModelRoutingError
from firstseen.source_ingestion import MemoryObservationStore, SourceIngestionService

FIXTURES = Path(__file__).with_name("fixtures")


def fixture(name):
    return (FIXTURES / name).read_bytes()


class FakeDns:
    def resolve(self, domain):
        return DnsResult(addresses=("192.0.2.10",), canonical_name=f"edge.{domain}")


class FakeTransport:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def get(self, url, *, accept="*/*"):
        self.calls.append(url)
        value = self.responses[url]
        if len(value) == 2:
            body, content_type = value
            final_url = url
        else:
            body, content_type, final_url = value
        return FetchedDocument(
            url=final_url,
            status=200,
            content_type=content_type,
            body=body,
        )


class FailingLlm:
    def propose(self, query, attempted_domains):
        raise AssertionError("LLM should not be called for deterministic discovery")


class ProposedIdentity:
    def __init__(self):
        self.calls = 0

    def propose(self, query, attempted_domains):
        self.calls += 1
        return "Fixture Robotics", "fixture-robotics.example"


class DiscoveryTests(unittest.TestCase):
    def fixture_transport(self):
        return FakeTransport(
            {
                "https://fixture-robotics.example/": (
                    fixture("discovery_fixture_home.html"),
                    "text/html",
                    "https://www.fixture-robotics.example/",
                ),
                "https://www.fixture-robotics.example/careers": (
                    fixture("discovery_fixture_careers.html"),
                    "text/html",
                ),
                "https://www.fixture-robotics.example/students": (
                    b"<html><title>Students</title></html>",
                    "text/html",
                ),
                "https://www.fixture-robotics.example/robots.txt": (
                    b"User-agent: *\nSitemap: https://www.fixture-robotics.example/recruiting-sitemap.xml\n",
                    "text/plain",
                ),
            }
        )

    def test_discovers_identity_categories_provenance_and_ingestion_configs(self):
        transport = self.fixture_transport()
        identify = IdentifyCompany(transport, dns=FakeDns(), llm=FailingLlm())
        result = DiscoverRecruitingSources(identify, transport).run("fixture-robotics.example")

        self.assertEqual(result.identity.name, "Fixture Robotics")
        self.assertEqual(result.identity.domain, "fixture-robotics.example")
        self.assertEqual(result.identity.ats_provider, "greenhouse")
        self.assertEqual(result.identity.ats_tenant, "fixturerobotics")
        self.assertEqual(str(result.identity.careers_url), "https://www.fixture-robotics.example/careers")
        self.assertEqual(str(result.identity.recruiting_url), "https://www.fixture-robotics.example/students")

        categories = {source.category for source in result.sources}
        self.assertTrue({"careers_page", "campus_page", "ats", "feed", "sitemap"} <= categories)
        self.assertTrue(all(source.evidence for source in result.sources))
        self.assertIn(
            "known_ats_pattern",
            {evidence.method for source in result.sources for evidence in source.evidence},
        )

        configs = result.source_configs()
        greenhouse = next(config for config in configs if config.adapter == "greenhouse")
        self.assertEqual(greenhouse.external_key, "fixturerobotics")
        self.assertEqual(greenhouse.company_id, result.identity.id)
        self.assertEqual(len(configs), len(result.sources))

        career_source = next(source for source in result.sources if source.category == "careers_page")
        direct_result = result.model_copy(update={"sources": [career_source]})
        summaries = SourceIngestionService(
            AdapterRegistry([GenericCareerPageAdapter()]),
            transport,
            MemoryObservationStore(),
        ).ingest_discovery(direct_result, observed_at=datetime(2026, 8, 14, tzinfo=UTC))
        self.assertEqual(len(summaries), 1)
        self.assertEqual(summaries[0].source_id, career_source.id)

    def test_each_company_gets_one_bounded_archive_source_over_its_campus_page(self):
        transport = self.fixture_transport()
        identify = IdentifyCompany(transport, dns=FakeDns(), llm=FailingLlm())
        discover = DiscoverRecruitingSources(identify, transport, today=lambda: date(2026, 9, 14))
        result = discover.run("fixture-robotics.example")

        archives = [source for source in result.sources if source.adapter == "wayback"]
        self.assertEqual(len(archives), 1)
        archive = archives[0]
        campus = next(source for source in result.sources if source.category == "campus_page")
        self.assertEqual(archive.category, "archive")
        self.assertEqual(archive.url, campus.url)
        self.assertNotEqual(archive.id, campus.id)
        self.assertEqual(archive.evidence, campus.evidence)
        self.assertEqual(
            archive.options,
            {"from": 2021, "to": 2026, "max_captures": 45, "max_total_captures": 45, "include_subpaths": False},
        )
        config = next(item for item in result.source_configs() if item.adapter == "wayback")
        self.assertEqual(config.options["from"], 2021)

        repeat = DiscoverRecruitingSources(identify, self.fixture_transport(), today=lambda: date(2026, 9, 14))
        self.assertEqual(
            next(source.id for source in repeat.run("fixture-robotics.example").sources if source.adapter == "wayback"),
            archive.id,
        )

    def test_name_lookup_uses_llm_only_after_deterministic_candidates_fail(self):
        transport = self.fixture_transport()
        resolver = ProposedIdentity()
        identity, _ = IdentifyCompany(transport, dns=FakeDns(), llm=resolver).run("Fixture Robotics, Inc.")
        self.assertEqual(identity.domain, "fixture-robotics.example")
        self.assertEqual(resolver.calls, 1)
        self.assertIn("llm_identity", {item.method for item in identity.evidence})

    def test_representative_ats_patterns_are_extracted_from_observed_links(self):
        cases = [
            (
                "example-dynamics.example",
                "discovery_lever_home.html",
                "Example Dynamics",
                "lever",
                "exampledynamics",
            ),
            (
                "sample-systems.example",
                "discovery_ashby_home.html",
                "Sample Systems",
                "ashby",
                "samplesystems",
            ),
        ]
        for domain, fixture_name, expected_name, provider, tenant in cases:
            with self.subTest(provider=provider):
                base = f"https://{domain}/"
                transport = FakeTransport(
                    {
                        base: (fixture(fixture_name), "text/html"),
                        f"https://{domain}/robots.txt": (b"User-agent: *", "text/plain"),
                    }
                )
                tool = DiscoverRecruitingSources(
                    IdentifyCompany(transport, dns=FakeDns(), llm=FailingLlm()), transport
                )
                result = tool.run(domain)
                self.assertEqual(result.identity.name, expected_name)
                ats = next(source for source in result.sources if source.adapter == provider)
                self.assertEqual(ats.external_key, tenant)

    def test_embedded_greenhouse_boards_take_the_tenant_from_for(self):
        # Virtu's careers page embeds its board; the tenant was once recorded as "embed".
        self.assertEqual(_ats_match("https://boards.greenhouse.io/embed/job_board?for=virtu"), ("greenhouse", "virtu"))
        self.assertEqual(_ats_match("https://boards.greenhouse.io/embed/job_board/js?for=virtu"), ("greenhouse", "virtu"))
        self.assertEqual(
            _ats_match("https://job-boards.greenhouse.io/embed/job_app?for=virtu&token=7001"), ("greenhouse", "virtu")
        )
        self.assertIsNone(_ats_match("https://boards.greenhouse.io/embed/job_app?token=7001"))
        self.assertEqual(_ats_match("https://boards.greenhouse.io/pdtpartners/jobs/42"), ("greenhouse", "pdtpartners"))

    def test_non_web_links_are_skipped_instead_of_failing_discovery(self):
        # Jump Trading's careers page links a mailto: address labelled like a careers page.
        domain = "example-mail.example"
        base = f"https://{domain}/"
        home = (
            b"<html><head><title>Example Mail</title></head><body>"
            b'<a href="mailto:international-careers@example-mail.example">International careers inquiries</a>'
            b'<a href="tel:+15550100">Careers hotline</a>'
            b'<a href="/careers">Careers</a>'
            b'<script src="https://boards.greenhouse.io/embed/job_board/js?for=examplemail"></script>'
            b"</body></html>"
        )
        transport = FakeTransport(
            {
                base: (home, "text/html"),
                f"https://{domain}/robots.txt": (b"User-agent: *", "text/plain"),
                f"https://{domain}/careers": (b"<html><title>Careers</title></html>", "text/html"),
            }
        )
        result = DiscoverRecruitingSources(IdentifyCompany(transport, dns=FakeDns(), llm=FailingLlm()), transport).run(domain)

        self.assertTrue(all(str(source.url).startswith("https://") for source in result.sources))
        greenhouse = [source for source in result.sources if source.adapter == "greenhouse"]
        self.assertEqual([(source.external_key, str(source.url)) for source in greenhouse], [("examplemail", "https://boards.greenhouse.io/examplemail")])

    def test_a_homepage_without_career_links_falls_back_to_the_conventional_careers_path(self):
        # Palantir's homepage renders navigation in script; its careers page links the Lever board.
        domain = "script-nav.example"
        careers = b'<html><title>Careers</title><a href="https://jobs.lever.co/scriptnav">Open roles</a></html>'
        transport = FakeTransport(
            {
                f"https://{domain}/": (b"<html><head><title>Script Nav</title></head><body><div id='app'></div></body></html>", "text/html"),
                f"https://{domain}/robots.txt": (b"User-agent: *", "text/plain"),
                f"https://{domain}/careers": (careers, "text/html", f"https://www.{domain}/careers/"),
                f"https://www.{domain}/careers": (careers, "text/html"),
            }
        )
        result = DiscoverRecruitingSources(
            IdentifyCompany(transport, dns=FakeDns(), llm=FailingLlm()), transport, today=lambda: date(2026, 9, 14)
        ).run(domain)

        careers_page = next(source for source in result.sources if source.category == "careers_page")
        self.assertEqual(str(careers_page.url), f"https://www.{domain}/careers")
        self.assertEqual([evidence.method for evidence in careers_page.evidence], ["conventional_path"])
        self.assertEqual(next(source.external_key for source in result.sources if source.adapter == "lever"), "scriptnav")
        self.assertEqual(next(str(source.url) for source in result.sources if source.adapter == "wayback"), f"https://www.{domain}/careers")

    def test_the_archive_prefers_a_recruiting_page_over_an_off_careers_campus_link(self):
        # Snowflake's "University" link is a training portal; its university recruiting page is under careers.
        domain = "data-cloud.example"
        home = (
            b"<html><head><title>Data Cloud</title></head><body>"
            b'<a href="https://learn.data-cloud.example/en">Data Cloud University</a>'
            b'<a href="https://careers.data-cloud.example/us/en">Careers</a></body></html>'
        )
        careers = b'<html><title>Careers</title><a href="https://careers.data-cloud.example/us/en/university">University recruiting</a></html>'
        transport = FakeTransport(
            {
                f"https://{domain}/": (home, "text/html"),
                f"https://{domain}/robots.txt": (b"User-agent: *", "text/plain"),
                "https://learn.data-cloud.example/en": (b"<html><title>Training</title></html>", "text/html"),
                "https://careers.data-cloud.example/us/en": (careers, "text/html"),
            }
        )
        result = DiscoverRecruitingSources(
            IdentifyCompany(transport, dns=FakeDns(), llm=FailingLlm()), transport, today=lambda: date(2026, 9, 14)
        ).run(domain)

        archive = next(source for source in result.sources if source.adapter == "wayback")
        self.assertEqual(str(archive.url), "https://careers.data-cloud.example/us/en/university")

    def test_a_blog_feed_on_a_careers_host_is_not_a_job_feed(self):
        # Waymo's careers pages link a site-wide blog feed on careers.withwaymo.com; its host alone once
        # made it a job feed, and every post became a posting with an exact date.
        domain = "robo-drive.example"
        careers = (
            b"<html><head><title>Careers</title>"
            b'<link rel="alternate" type="application/rss+xml" href="https://careers.robo-drive.example/blogs/89e712be">'
            b'<link rel="alternate" type="application/rss+xml" href="https://careers.robo-drive.example/jobs/feed">'
            b"</head><body>Join us</body></html>"
        )
        transport = FakeTransport(
            {
                f"https://{domain}/": (
                    b'<html><head><title>Robo Drive</title></head><body><a href="https://careers.robo-drive.example/">Careers</a></body></html>',
                    "text/html",
                ),
                f"https://{domain}/robots.txt": (b"User-agent: *", "text/plain"),
                "https://careers.robo-drive.example/": (careers, "text/html"),
            }
        )
        result = DiscoverRecruitingSources(IdentifyCompany(transport, dns=FakeDns(), llm=FailingLlm()), transport).run(domain)

        feeds = sorted(str(source.url) for source in result.sources if source.category == "feed")
        self.assertEqual(feeds, ["https://careers.robo-drive.example/jobs/feed"])

    def test_many_ats_job_links_collapse_to_one_board_source_per_tenant(self):
        """Real careers pages link one URL per posting, never the board itself.

        Registering each posting URL produced hundreds of duplicate ingestion
        targets for a single tenant, and the Ashby form additionally captured a job
        identifier as the board token.
        """
        domain = "example-grid.example"
        base = f"https://{domain}/"
        transport = FakeTransport(
            {
                base: (fixture("discovery_ats_job_links.html"), "text/html"),
                f"https://{domain}/robots.txt": (b"User-agent: *", "text/plain"),
                f"https://{domain}/careers": (fixture("discovery_ats_job_links.html"), "text/html"),
            }
        )
        result = DiscoverRecruitingSources(
            IdentifyCompany(transport, dns=FakeDns(), llm=FailingLlm()), transport
        ).run(domain)

        greenhouse = [s for s in result.sources if s.adapter == "greenhouse"]
        ashby = [s for s in result.sources if s.adapter == "ashby"]
        self.assertEqual(len(greenhouse), 1, "six postings must collapse to one board")
        self.assertEqual(len(ashby), 1)
        self.assertEqual(greenhouse[0].external_key, "examplegrid")
        self.assertEqual(str(greenhouse[0].url), "https://boards.greenhouse.io/examplegrid")
        # The tenant, not the posting UUID, is the board token.
        self.assertEqual(ashby[0].external_key, "examplegrid")
        self.assertEqual(str(ashby[0].url), "https://jobs.ashbyhq.com/examplegrid")
        for source in result.sources:
            self.assertNotIn("/jobs/", str(source.url))

    def test_stable_ids_make_repeat_discovery_idempotent(self):
        first_transport = self.fixture_transport()
        second_transport = self.fixture_transport()
        first = DiscoverRecruitingSources(
            IdentifyCompany(first_transport, dns=FakeDns()), first_transport
        ).run("fixture-robotics.example")
        second = DiscoverRecruitingSources(
            IdentifyCompany(second_transport, dns=FakeDns()), second_transport
        ).run("fixture-robotics.example")
        self.assertEqual(first.identity.id, second.identity.id)
        self.assertEqual(
            {(source.id, str(source.url)) for source in first.sources},
            {(source.id, str(source.url)) for source in second.sources},
        )


if __name__ == "__main__":
    unittest.main()


class SiteWideFeedTests(unittest.TestCase):
    """A feed linked from the careers page is not necessarily a recruiting feed."""

    def test_site_wide_release_feed_is_not_registered_as_a_recruiting_source(self):
        # Observed live: a release-notes feed linked in every page head was ingested
        # as job postings, turning publication dates into exact opening events.
        domain = "example-forge.example"
        base = f"https://{domain}/"
        home = (
            b'<!doctype html><html><head><title>Example Forge</title>'
            b'<link rel="alternate" type="application/atom+xml" href="/releases.xml" title="Releases">'
            b'</head><body><a href="/jobs">Careers</a></body></html>'
        )
        jobs = (
            b'<!doctype html><html><head><title>Example Forge Jobs</title>'
            b'<link rel="alternate" type="application/atom+xml" href="/releases.xml" title="Releases">'
            b'<link rel="alternate" type="application/rss+xml" href="/jobs.rss" title="Careers feed">'
            b'</head><body><a href="/jobs/engineer">Software Engineer Intern</a></body></html>'
        )
        transport = FakeTransport(
            {
                base: (home, "text/html"),
                f"https://{domain}/robots.txt": (b"User-agent: *", "text/plain"),
                f"https://{domain}/jobs": (jobs, "text/html"),
            }
        )
        result = DiscoverRecruitingSources(
            IdentifyCompany(transport, dns=FakeDns(), llm=FailingLlm()), transport
        ).run(domain)

        feeds = {str(source.url) for source in result.sources if source.adapter == "rss"}
        self.assertNotIn(f"https://{domain}/releases.xml", feeds)
        self.assertIn(f"https://{domain}/jobs.rss", feeds)


class StatusTransport(FakeTransport):
    """A FakeTransport whose response may carry an HTTP status, or be an exception to raise."""

    def get(self, url, *, accept="*/*"):
        value = self.responses.get(url)
        if isinstance(value, Exception):
            self.calls.append(url)
            raise value
        if isinstance(value, tuple) and len(value) == 4:
            self.calls.append(url)
            body, content_type, final_url, status = value
            return FetchedDocument(url=final_url, status=status, content_type=content_type, body=body)
        return super().get(url, accept=accept)


def discover(transport, domain, llm=None):
    identify = IdentifyCompany(transport, dns=FakeDns(), llm=llm or FailingLlm())
    return DiscoverRecruitingSources(identify, transport, today=lambda: date(2026, 9, 14)).run(domain)


class RefusedSourceTests(unittest.TestCase):
    """What discovery attached in the second company expansion and should not have, each reduced to its shape."""

    def test_an_entity_escaped_embed_does_not_add_a_second_tenant(self):
        # Belvedere embeds its Lever board in JSON inside an attribute; "&quot;" became a second tenant.
        domain = "options-desk.example"
        home = (
            b"<html><head><title>Options Desk</title></head><body>"
            b'<a href="https://jobs.lever.co/optionsdesk">Open Positions</a>'
            b'<div data-config="{&quot;jobs&quot;:&quot;https://jobs.lever.co/optionsdesk&quot;}"></div>'
            b"</body></html>"
        )
        transport = StatusTransport(
            {
                f"https://{domain}/": (home, "text/html"),
                f"https://{domain}/robots.txt": (b"User-agent: *", "text/plain"),
            }
        )
        result = discover(transport, domain)

        self.assertEqual(
            [(source.adapter, source.external_key) for source in result.sources if source.category == "ats"],
            [("lever", "optionsdesk")],
        )
        self.assertIsNone(_ats_match("https://jobs.lever.co/optionsdesk&quot"))

    def test_blog_posts_their_feeds_and_link_elements_are_not_recruiting_pages(self):
        # Old Mission's homepage links career-fair posts, each with a comment feed and oEmbed endpoints, and
        # HRT's loads a jobs-plugin stylesheet. None is a careers page, a campus page, or a job feed.
        domain = "market-maker.example"
        site = f"https://www.{domain}"
        post = f"{site}/2026/09/04/visit-us-on-campus-mit-career-fair-2026"
        home = (
            f"<html><head><title>Market Maker: Home</title>"
            f'<link rel="stylesheet" href="{site}/wp-content/plugins/mm-jobs/style.min.css?ver=5">'
            f'<link rel="alternate" type="application/json+oembed" href="{site}/wp-json/oembed/1.0/embed?url=%2Fcampus">'
            f"</head><body>"
            f'<a href="{post}/">Visit Us on Campus! – MIT</a>'
            f'<a href="{site}/tag/campus-visit/">Campus Visit</a>'
            f"</body></html>"
        ).encode()
        post_page = (
            f'<html><head><link rel="alternate" type="application/rss+xml" '
            f'title="Market Maker » Visit Us on Campus! Comments Feed" href="{post}/feed/"></head></html>'
        ).encode()
        transport = StatusTransport(
            {
                f"https://{domain}/": (home, "text/html", f"{site}/"),
                f"{site}/careers": (b"<html><title>Careers - Market Maker</title></html>", "text/html", f"{site}/careers/"),
                f"{site}/robots.txt": (b"User-agent: *", "text/plain"),
                post: (post_page, "text/html"),
            }
        )
        result = discover(transport, domain)

        self.assertEqual(
            sorted((source.category, str(source.url)) for source in result.sources),
            [("archive", f"{site}/careers"), ("careers_page", f"{site}/careers")],
        )
        self.assertEqual(
            [evidence.method for source in result.sources for evidence in source.evidence],
            ["conventional_path", "conventional_path"],
        )
        self.assertNotIn(post, transport.calls)
        feeds = DiscoverRecruitingSources(IdentifyCompany(transport, dns=FakeDns()), transport)
        self.assertFalse(feeds._is_job_feed("Market Maker » Careers Comments Feed", f"{site}/careers/feed"))
        self.assertFalse(feeds._is_job_feed("Feed", f"{post}/feed"))
        self.assertTrue(feeds._is_job_feed("Job openings", f"{site}/careers/feed"))

    def test_international_is_not_an_internship(self):
        # "International Convention" once made Commure's events page its campus page.
        domain = "health-ops.example"
        home = (
            b"<html><head><title>Health Ops</title></head><body>"
            b'<a href="/events/innovation-summit">Customer Story: Summit at the International Convention Center</a>'
            b'<a href="/careers">Careers</a></body></html>'
        )
        careers = b'<html><title>Careers</title><a href="/students/internships">Internships</a></html>'
        transport = StatusTransport(
            {
                f"https://{domain}/": (home, "text/html"),
                f"https://{domain}/careers": (careers, "text/html"),
                f"https://{domain}/robots.txt": (b"User-agent: *", "text/plain"),
            }
        )
        result = discover(transport, domain)

        self.assertEqual(
            sorted((source.category, str(source.url)) for source in result.sources if source.adapter == "generic"),
            [("careers_page", f"https://{domain}/careers"), ("related_career_page", f"https://{domain}/students/internships")],
        )

    def test_the_archive_is_a_recurring_landing_page_not_one_cycles_posting(self):
        # DV Trading's careers page links its 2025 internship postings, and AbbVie's homepage links a learning
        # article under its careers path before its careers host.
        domain = "prop-desk.example"
        home = (
            b"<html><head><title>Prop Desk</title></head><body>"
            b'<a href="/join-us/life/learning-and-development">Learning and Development</a>'
            b'<a href="https://careers.prop-desk.example/">Browse jobs</a></body></html>'
        )
        careers = b'<html><a href="/job-post/2025-summer-internship-software-developer">2025 Summer Internship</a></html>'
        transport = StatusTransport(
            {
                f"https://{domain}/": (home, "text/html"),
                "https://careers.prop-desk.example/": (careers, "text/html"),
                f"https://{domain}/robots.txt": (b"User-agent: *", "text/plain"),
            }
        )
        result = discover(transport, domain)

        self.assertIn(
            "https://careers.prop-desk.example/job-post/2025-summer-internship-software-developer",
            [str(source.url) for source in result.sources if source.category == "related_career_page"],
        )
        archive = next(source for source in result.sources if source.adapter == "wayback")
        self.assertEqual(str(archive.url), "https://careers.prop-desk.example/")

    def test_a_board_its_own_endpoint_refutes_is_not_attached(self):
        # Shield AI's careers page links a subsidiary's Greenhouse board, whose metadata names the subsidiary,
        # and Commure's embeds an Ashby board that answers 404. A board that cannot be checked stays attached.
        domain = "sky-autonomy.example"
        careers = (
            b"<html><title>Careers</title>"
            b'<a href="https://jobs.lever.co/skyautonomy">Open Roles</a>'
            b'<a href="https://job-boards.greenhouse.io/skyautonomy">Engineering roles</a>'
            b'<a href="https://job-boards.greenhouse.io/aerosimtechnology">AeroSim Roles</a>'
            b'<script src="https://jobs.ashbyhq.com/skyautonomy-legacy/embed"></script></html>'
        )
        ashby_check = "https://api.ashbyhq.com/posting-api/job-board/skyautonomy-legacy"
        transport = StatusTransport(
            {
                f"https://{domain}/": (
                    b'<html><head><title>Autonomous Aircraft | Sky Autonomy</title></head><body><a href="/careers">Careers</a></body></html>',
                    "text/html",
                ),
                f"https://{domain}/careers": (careers, "text/html"),
                f"https://{domain}/robots.txt": (b"User-agent: *", "text/plain"),
                "https://boards-api.greenhouse.io/v1/boards/skyautonomy": (b'{"name": "Sky Autonomy"}', "application/json"),
                "https://boards-api.greenhouse.io/v1/boards/aerosimtechnology": (b'{"name": "AeroSim Technology"}', "application/json"),
                ashby_check: HTTPError(ashby_check, 404, "Not Found", None, None),
            }
        )
        result = discover(transport, domain)

        self.assertEqual(result.identity.name, "Sky Autonomy")
        self.assertEqual(
            sorted((source.adapter, source.external_key) for source in result.sources if source.category == "ats"),
            [("greenhouse", "skyautonomy"), ("lever", "skyautonomy")],
        )
        self.assertEqual(
            sorted((source.external_key, source.reason) for source in result.rejected_sources),
            [("aerosimtechnology", "board_name_mismatch"), ("skyautonomy-legacy", "board_not_found")],
        )
        mismatch = next(source for source in result.rejected_sources if source.reason == "board_name_mismatch")
        self.assertEqual({evidence.method for evidence in mismatch.evidence[:-1]}, {"known_ats_pattern"})
        self.assertEqual(mismatch.evidence[-1].metadata, {"board_name": "AeroSim Technology"})
        self.assertIn("https://api.lever.co/v0/postings/skyautonomy?mode=json&limit=1", transport.calls)

    def test_the_company_name_is_the_one_that_spells_its_domain(self):
        cases = [
            # AbbVie: a department in og:site_name, double-escaped; the company in the title's last segment.
            (
                "pharma-co.example",
                (
                    b'<meta property="og:site_name" content="Pharmaceutical Research &amp;amp; Development">'
                    b"<title>Pharmaceutical Research &amp; Development | PharmaCo</title>"
                ),
                "PharmaCo",
            ),
            # Shield AI: the top-level domain is part of the name.
            ("drone.ai", b'<meta property="og:site_name" content="Drone AI"><title>Defense | Drone AI</title>', "Drone AI"),
            # Scale AI at scale.com: a name that begins with the domain is kept whole.
            (
                "labelwork.example",
                b'<script type="application/ld+json">{"@type": "Organization", "name": "Labelwork AI"}</script>',
                "Labelwork AI",
            ),
            # Old Mission at oldmissioncapital.com: no name spells the domain, so the structured name stands.
            (
                "old-harbor-capital.example",
                b'<script type="application/ld+json">{"@type": "Organization", "name": "Old Harbor &amp; Co"}</script>',
                "Old Harbor & Co",
            ),
        ]
        for domain, head, expected in cases:
            with self.subTest(domain=domain):
                transport = StatusTransport({f"https://{domain}/": (b"<html><head>" + head + b"</head></html>", "text/html")})
                identity, _ = IdentifyCompany(transport, dns=FakeDns(), llm=FailingLlm()).run(domain)
                self.assertEqual(identity.name, expected)

    def test_a_redirect_within_the_company_site_keeps_its_domain(self):
        # epicgames.com redirects to store.epicgames.com; ziphq.com to zip.com is another domain.
        transport = StatusTransport(
            {
                "https://game-studio.example/": (
                    b"<html><head><title>Game Studio Store | Official Site</title></head></html>",
                    "text/html",
                    "https://store.game-studio.example/",
                ),
                "https://old-name.example/": (
                    b"<html><head><title>New Name</title></head></html>",
                    "text/html",
                    "https://new-name.example/",
                ),
            }
        )
        identify = IdentifyCompany(transport, dns=FakeDns(), llm=FailingLlm())

        studio, _ = identify.run("game-studio.example")
        self.assertEqual((studio.domain, str(studio.official_url)), ("game-studio.example", "https://store.game-studio.example/"))
        self.assertEqual(studio.id, uuid5(NAMESPACE_URL, "company:https://game-studio.example"))
        self.assertIn("game-studio.example redirected to store.game-studio.example", [item.quote for item in studio.evidence])
        renamed, _ = identify.run("old-name.example")
        self.assertEqual(renamed.domain, "new-name.example")

    def test_a_model_outage_does_not_hide_why_the_domain_failed(self):
        # rubrik.com answers the crawler with 403; the report once said only that model routes failed.
        class UnavailableModel:
            def propose(self, query, attempted_domains):
                raise ModelRoutingError("reason", [])

        blocked = "https://walled.example/"
        transport = StatusTransport({blocked: HTTPError(blocked, 403, "Forbidden", None, None)})
        with self.assertRaisesRegex(LookupError, r"walled\.example: HTTP 403; identity model unavailable: ModelRoutingError"):
            IdentifyCompany(transport, dns=FakeDns(), llm=UnavailableModel()).run("walled.example")

    def test_robots_sitemaps_skip_catalogues_and_are_bounded(self):
        # Roblox's robots.txt lists thirty sitemaps, one per locale and per game catalogue; Canonical's lists its docs,
        # knowledge, partners, and blog sitemaps. Only root and recruiting sitemaps are recruiting sources.
        domain = "play-world.example"
        robots = "User-agent: *\n" + "".join(
            f"Sitemap: https://www.{domain}/sitemap-games-{locale}.xml\nSitemap: https://www.{domain}/sitemap-{locale}.xml\n"
            for locale in ("ar", "de", "es", "fr", "it", "ja", "ko", "pt")
        )
        robots += "".join(f"Sitemap: https://www.{domain}/{path}\n" for path in ("docs/sitemap.xml", "blog/sitemap.xml", "partners/sitemap.xml"))
        robots += "".join(f"Sitemap: https://www.{domain}/sitemap-{index}.xml\n" for index in range(1, 7))
        robots += f"Sitemap: https://www.{domain}/careers-sitemap.xml\n"
        transport = StatusTransport(
            {
                f"https://{domain}/": (b"<html><head><title>Play World</title></head></html>", "text/html"),
                f"https://{domain}/robots.txt": (robots.encode(), "text/plain"),
            }
        )
        result = discover(transport, domain)

        sitemaps = [source for source in result.sources if source.category == "sitemap"]
        urls = [str(source.url) for source in sitemaps]
        self.assertEqual(len(urls), MAX_SITEMAP_SOURCES)
        self.assertIn(f"https://www.{domain}/careers-sitemap.xml", urls, "a careers sitemap is kept first")
        self.assertFalse([url for url in urls if not re.search(r"/(?:sitemap-\d|careers-sitemap)", url)])
        self.assertEqual({source.evidence[0].metadata["sitemaps_listed"] for source in sitemaps}, {7})

    def test_links_off_a_recruiting_path_are_not_registered_whatever_they_say(self):
        # Canonical's "Careers" menu linked its homepage and navigation fragment, its careers page linked Ubuntu's IoT
        # appstore as "Students", and its robots.txt listed docs and partners sitemaps. Each was collected every run.
        domain = "distro.example"
        home = (
            b"<html><head><title>Distro</title></head><body>"
            b'<a href="/">Careers at Distro</a><a href="/navigation">Careers</a><a href="/careers">Work at Distro careers</a>'
            b"</body></html>"
        )
        careers = (
            b"<html><title>Careers</title>"
            b'<a href="/internet-of-things/appstore">Students build on the appstore</a>'
            b'<a href="/careers/early-careers">Early careers</a>'
            b'<a href="/careers/stories/graduate-journey">A graduate story</a>'
            b"</html>"
        )
        robots = "".join(f"Sitemap: https://{domain}/{path}\n" for path in ("sitemap.xml", "microk8s/docs/sitemap.xml", "partners/sitemap.xml"))
        transport = StatusTransport(
            {
                f"https://{domain}/": (home, "text/html"),
                f"https://{domain}/careers": (careers, "text/html"),
                f"https://{domain}/robots.txt": (robots.encode(), "text/plain"),
            }
        )
        result = discover(transport, domain)

        self.assertEqual(
            sorted((source.category, str(source.url)) for source in result.sources if source.adapter in {"generic", "sitemap"}),
            [
                ("careers_page", f"https://{domain}/careers"),
                ("related_career_page", f"https://{domain}/careers/early-careers"),
                ("sitemap", f"https://{domain}/sitemap.xml"),
            ],
        )

    def test_related_pages_stay_on_the_company_site_or_the_linking_page_host(self):
        # Belvedere's campus page links a Canva design and Bosch's careers pages link LinkedIn share buttons.
        # Waymo's careers host is careers.withwaymo.com, and the pages it links are kept.
        domain = "desk-trading.example"
        home = b'<html><head><title>Desk Trading</title></head><body><a href="https://careers.desk-jobs.example/">Careers</a></body></html>'
        careers = (
            b"<html><title>Careers</title>"
            b'<a href="/early-careers">Early careers</a>'
            b'<a href="https://www.desk-trading.example/students">Students</a>'
            b'<a href="https://www.canva.com/design/DAG/view">INTERNSHIP FREQUENTLY ASKED QUESTIONS</a>'
            b'<a href="https://linkedin.com/shareArticle?url=https://careers.desk-jobs.example/internships">Share internships</a>'
            b"</html>"
        )
        transport = StatusTransport(
            {
                f"https://{domain}/": (home, "text/html"),
                "https://careers.desk-jobs.example/": (careers, "text/html"),
                f"https://{domain}/robots.txt": (b"User-agent: *", "text/plain"),
            }
        )
        result = discover(transport, domain)

        self.assertEqual(
            sorted(str(source.url) for source in result.sources if source.category == "related_career_page"),
            ["https://careers.desk-jobs.example/early-careers", "https://www.desk-trading.example/students"],
        )


class MalformedUrlTests(unittest.TestCase):
    """A URL-shaped string a page happens to contain cannot end the company's discovery.

    twilio.com's homepage scripts held one with an unbalanced "[", which the standard library refuses outright
    ("Invalid IPv6 URL"). Discovery crashed there on 2026-09-19 and saved nothing for the company.
    """

    def test_a_string_that_cannot_be_parsed_is_not_a_url(self):
        from firstseen.discovery import _canonical_url, _is_web_url

        for value in ("https://[example", "http://[::1", "https://ho[st/careers", "//[bad]]/x"):
            self.assertEqual(_canonical_url(value), "", value)
            self.assertEqual(_canonical_url(value, "https://example.test/"), "", value)
            self.assertFalse(_is_web_url(_canonical_url(value)), value)

    def test_ordinary_urls_are_unaffected(self):
        from firstseen.discovery import _canonical_url

        self.assertEqual(_canonical_url("/careers", "https://example.test/x"), "https://example.test/careers")
        self.assertEqual(_canonical_url("https://boards.greenhouse.io/acme/"), "https://boards.greenhouse.io/acme")
