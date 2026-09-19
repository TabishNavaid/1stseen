"""robots.txt is read once per origin per run and honoured before every collector request (robots.py, RFC 9309).

Offline only: robots files are fixtures or inline strings, and the transport runs over a fake opener.
"""

import io
import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from firstseen.adapters import GenericCareerPageAdapter, GreenhouseAdapter, SitemapAdapter, SourceConfig
from firstseen.adapters.base import FetchedDocument, UrlLibTransport
from firstseen.adapters.registry import AdapterRegistry
from firstseen.adapters.wayback import WaybackAdapter
from firstseen.config import Settings
from firstseen.robots import (
    COLLECTOR_USER_AGENT,
    ROBOTS_PRODUCT_TOKEN,
    RobotsDisallowedError,
    RobotsFetch,
    RobotsGate,
    RobotsPolicy,
)
from firstseen.security import PublicUrlPolicy
from firstseen.signals import RecruitingSignalIngestionService
from firstseen.source_ingestion import MemoryObservationStore, SourceIngestionService

FIXTURES = Path(__file__).with_name("fixtures")
SEEN_AT = datetime(2026, 9, 17, 8, 0, tzinfo=UTC)
SOURCE_ID = UUID("00000000-0000-4000-8000-000000000301")
COMPANY_ID = UUID("00000000-0000-4000-8000-000000000001")


def fixture_policy(name: str) -> RobotsPolicy:
    return RobotsPolicy.parse((FIXTURES / name).read_text())


def allowed(policy: RobotsPolicy, path: str) -> bool:
    return policy.decide(f"https://careers.example.test{path}")[0]


class RobotsParsingTests(unittest.TestCase):
    def test_the_group_naming_the_collector_wins_over_the_star_group(self):
        policy = fixture_policy("robots_named_group.txt")
        # `User-agent: *` disallows everything, but a group names the collector, so only that group applies.
        self.assertTrue(allowed(policy, "/careers"))
        self.assertTrue(allowed(policy, "/"))
        self.assertFalse(allowed(policy, "/private/benefits"))

    def test_the_product_token_is_matched_case_insensitively_and_without_its_version(self):
        policy = RobotsPolicy.parse("User-agent: 1STSEENEVIDENCEBOT/9.9 (+x)\nDisallow: /jobs\n\nUser-agent: *\nDisallow:\n")
        self.assertFalse(allowed(policy, "/jobs/1"))
        other = RobotsPolicy.parse("User-agent: 1stSeenEvidenceBotter\nDisallow: /\n")
        self.assertTrue(allowed(other, "/jobs/1"), "a longer token is a different crawler")

    def test_the_longest_matching_rule_wins_and_an_equal_allow_beats_disallow(self):
        policy = fixture_policy("robots_named_group.txt")
        self.assertTrue(allowed(policy, "/private/jobs/42"), "Allow /private/jobs/ is longer than Disallow /private/")
        tie = RobotsPolicy.parse("User-agent: *\nDisallow: /page\nAllow: /page\n")
        self.assertTrue(allowed(tie, "/page"))
        order = RobotsPolicy.parse("User-agent: *\nAllow: /a\nDisallow: /a/b\n")
        self.assertFalse(allowed(order, "/a/b/c"), "specificity decides, not file order")

    def test_wildcards_end_anchors_and_queries(self):
        policy = fixture_policy("robots_named_group.txt")
        self.assertFalse(allowed(policy, "/files/guide.pdf"))
        self.assertTrue(allowed(policy, "/files/guide.pdf?download=1"), "$ anchors the end of path and query")
        self.assertFalse(allowed(policy, "/search?q=intern"))
        self.assertTrue(allowed(policy, "/search?page=2"))

    def test_star_groups_are_merged_and_rules_outside_a_group_are_ignored(self):
        policy = fixture_policy("robots_star_group.txt")
        self.assertFalse(allowed(policy, "/jobs/archive/2025"))
        self.assertTrue(allowed(policy, "/jobs/archive/2026/intern"))
        self.assertFalse(allowed(policy, "/internal/tools"))
        self.assertTrue(allowed(policy, "/rules-before-any-user-agent-belong-to-no-group"))

    def test_an_empty_disallow_and_an_empty_file_disallow_nothing(self):
        self.assertTrue(allowed(RobotsPolicy.parse("User-agent: *\nDisallow:\n"), "/anything"))
        self.assertTrue(allowed(RobotsPolicy.parse(""), "/anything"))
        self.assertTrue(allowed(RobotsPolicy.parse("<html><body>Not a robots file</body></html>"), "/jobs"))

    def test_robots_txt_itself_is_always_allowed(self):
        self.assertTrue(allowed(RobotsPolicy.parse("User-agent: *\nDisallow: /\n"), "/robots.txt"))

    def test_non_ascii_paths_are_compared_percent_encoded(self):
        policy = RobotsPolicy.parse("User-agent: *\nDisallow: /karriere/über\nDisallow: /a%2fb\n")
        self.assertFalse(allowed(policy, "/karriere/%C3%BCber-uns"))
        self.assertFalse(allowed(policy, "/a%2Fb"), "escapes compare upper-cased")
        self.assertTrue(allowed(policy, "/a/b"), "an escape is never decoded")

    def test_line_endings_comments_and_a_byte_order_mark(self):
        policy = RobotsPolicy.parse("\ufeffUser-agent: *   # everyone\r\nDisallow: /tmp # scratch\rAllow: /tmp/ok\n")
        self.assertFalse(allowed(policy, "/tmp/x"))
        self.assertTrue(allowed(policy, "/tmp/ok/1"))


class RobotsFetchOutcomeTests(unittest.TestCase):
    """RFC 9309 section 2.3.1: what an unsuccessful robots.txt read means."""

    def test_a_client_error_means_no_restrictions(self):
        for status in (400, 401, 403, 404, 410):
            policy = RobotsPolicy.from_fetch(RobotsFetch(status))
            self.assertFalse(policy.unreachable, status)
            self.assertTrue(allowed(policy, "/jobs"), status)

    def test_a_server_error_a_429_or_no_answer_means_disallow_everything(self):
        for status in (500, 502, 503, 429, None):
            policy = RobotsPolicy.from_fetch(RobotsFetch(status))
            self.assertTrue(policy.unreachable, status)
            self.assertFalse(allowed(policy, "/jobs"), status)

    def test_a_success_is_parsed(self):
        policy = RobotsPolicy.from_fetch(RobotsFetch(200, b"User-agent: *\nDisallow: /jobs\n"))
        self.assertFalse(allowed(policy, "/jobs/1"))
        self.assertTrue(allowed(policy, "/careers"))


class RobotsGateTests(unittest.TestCase):
    def test_robots_txt_is_read_once_per_origin(self):
        fetched: list[str] = []

        def fetch(url: str) -> RobotsFetch:
            fetched.append(url)
            return RobotsFetch(200, b"User-agent: *\nDisallow: /private\n")

        gate = RobotsGate(fetch)
        gate.check("https://careers.example.test/jobs/1")
        gate.check("https://careers.example.test/jobs/2?x=1")
        gate.check("https://CAREERS.example.test/jobs/3")
        gate.check("http://careers.example.test/jobs/4")
        gate.check("https://careers.example.test:8443/jobs/5")
        self.assertEqual(
            fetched,
            [
                "https://careers.example.test/robots.txt",
                "http://careers.example.test/robots.txt",
                "https://careers.example.test:8443/robots.txt",
            ],
        )

    def test_a_refusal_is_typed_and_names_the_rule(self):
        gate = RobotsGate(lambda url: RobotsFetch(200, b"User-agent: *\nDisallow: /private\n"))
        with self.assertRaises(RobotsDisallowedError) as caught:
            gate.check("https://careers.example.test/private/roles")
        self.assertIsInstance(caught.exception, ValueError)
        self.assertEqual(caught.exception.code, "robots_disallowed")
        self.assertEqual(caught.exception.rule, "Disallow: /private")
        self.assertEqual(caught.exception.robots_url, "https://careers.example.test/robots.txt")

    def test_an_unreachable_robots_txt_refuses_the_whole_origin_for_the_run(self):
        calls = []

        def fetch(url: str) -> RobotsFetch:
            calls.append(url)
            return RobotsFetch(503)

        gate = RobotsGate(fetch)
        for path in ("/", "/jobs", "/careers"):
            with self.assertRaises(RobotsDisallowedError) as caught:
                gate.check(f"https://careers.example.test{path}")
            self.assertEqual(caught.exception.code, "robots_unreachable")
            self.assertEqual(caught.exception.status, 503)
        self.assertEqual(len(calls), 1, "an unreachable robots.txt is not re-read within the run")

    def test_the_collector_identifies_with_the_token_it_honours(self):
        self.assertTrue(COLLECTOR_USER_AGENT.startswith(f"{ROBOTS_PRODUCT_TOKEN}/"))


class _Response:
    def __init__(self, url: str, body: bytes, status: int = 200, content_type: str = "text/html") -> None:
        self.url = url
        self.status = status
        self.headers = {"content-type": content_type}
        self._body = io.BytesIO(body)

    def read(self, limit: int = -1) -> bytes:
        return self._body.read(limit)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _Opener:
    """Answers from a table: bytes for a 200, an int for an HTTP error, an exception to raise."""

    def __init__(self, answers):
        self.answers = answers
        self.requested: list[str] = []

    def open(self, request, timeout=None):
        url = request.full_url
        self.requested.append(url)
        assert request.get_header("User-agent") == COLLECTOR_USER_AGENT
        answer = self.answers[url]
        if isinstance(answer, BaseException):
            raise answer
        if isinstance(answer, int):
            raise HTTPError(url, answer, "fixture", {}, io.BytesIO())
        return _Response(url, answer)


def public_policy() -> PublicUrlPolicy:
    return PublicUrlPolicy(resolver=lambda host, port, type=None: [(2, 1, 6, "", ("93.184.215.14", port))])


def transport(answers, *, enforced: bool = True) -> tuple[UrlLibTransport, _Opener]:
    opener = _Opener(answers)
    settings = Settings(_env_file=None, HTTP_MIN_HOST_INTERVAL_SECONDS=0, ROBOTS_TXT_ENFORCED=enforced)
    return UrlLibTransport(settings, url_policy=public_policy(), opener=opener), opener  # type: ignore[arg-type]


class TransportRobotsTests(unittest.TestCase):
    def test_off_by_default_collection_is_exactly_as_before_and_reads_no_robots_txt(self):
        self.assertFalse(Settings(_env_file=None).robots_txt_enforced)
        collector, opener = transport(
            {"https://careers.example.test/private/roles": b"<html>roles</html>"}, enforced=False
        )
        self.assertIsNone(collector.robots)
        self.assertEqual(collector.get("https://careers.example.test/private/roles").status, 200)
        self.assertEqual(opener.requested, ["https://careers.example.test/private/roles"])

    def test_every_request_is_checked_and_robots_txt_is_read_first_and_once(self):
        collector, opener = transport(
            {
                "https://careers.example.test/robots.txt": b"User-agent: *\nDisallow: /private\n",
                "https://careers.example.test/jobs": b"<html>jobs</html>",
                "https://careers.example.test/jobs/2": b"<html>job</html>",
            }
        )
        collector.get("https://careers.example.test/jobs")
        collector.get("https://careers.example.test/jobs/2")
        with self.assertRaises(RobotsDisallowedError):
            collector.get("https://careers.example.test/private/roles")
        self.assertEqual(
            opener.requested,
            [
                "https://careers.example.test/robots.txt",
                "https://careers.example.test/jobs",
                "https://careers.example.test/jobs/2",
            ],
            "the disallowed URL is never requested",
        )

    def test_a_missing_robots_txt_allows_and_a_failing_one_refuses(self):
        collector, _ = transport(
            {
                "https://open.example.test/robots.txt": 404,
                "https://open.example.test/jobs": b"<html></html>",
                "https://down.example.test/robots.txt": 503,
                "https://gone.example.test/robots.txt": URLError("connection refused"),
                "https://slow.example.test/robots.txt": TimeoutError("timed out"),
            }
        )
        self.assertEqual(collector.get("https://open.example.test/jobs").status, 200)
        for host, status in (("down", 503), ("gone", None), ("slow", None)):
            with self.assertRaises(RobotsDisallowedError) as caught:
                collector.get(f"https://{host}.example.test/jobs")
            self.assertEqual(caught.exception.code, "robots_unreachable")
            self.assertEqual(caught.exception.status, status)

    def test_a_private_address_is_refused_before_robots_txt_is_read(self):
        opener = _Opener({})
        settings = Settings(_env_file=None, HTTP_MIN_HOST_INTERVAL_SECONDS=0, ROBOTS_TXT_ENFORCED=True)
        private = PublicUrlPolicy(resolver=lambda host, port, type=None: [(2, 1, 6, "", ("10.0.0.5", port))])
        collector = UrlLibTransport(settings, url_policy=private, opener=opener)  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            collector.get("https://intranet.example.test/jobs")
        self.assertEqual(opener.requested, [])


class RobotsTransport:
    """A fixture transport that applies a robots.txt table before serving, as UrlLibTransport does."""

    def __init__(self, responses, robots):
        self.responses = responses
        self.gate = RobotsGate(lambda url: robots.get(url, RobotsFetch(404)))
        self.calls: list[str] = []

    def get(self, url, *, accept="*/*"):
        self.gate.check(url)
        self.calls.append(url)
        body, content_type = self.responses[url]
        return FetchedDocument(url=url, status=200, content_type=content_type, body=body)


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


class CollectionRobotsTests(unittest.TestCase):
    """A refused URL is a typed diagnostic: never a crash, never a silent drop."""

    def test_a_source_whose_own_address_is_disallowed_is_skipped_with_its_reason(self):
        configured = source("generic", "https://careers.example.test/careers/jobs")
        store = MemoryObservationStore()
        robots = {"https://careers.example.test/robots.txt": RobotsFetch(200, b"User-agent: *\nDisallow: /careers\n")}
        summary = SourceIngestionService(
            AdapterRegistry([GenericCareerPageAdapter()]), RobotsTransport({}, robots), store
        ).ingest(configured, observed_at=SEEN_AT)
        self.assertTrue(summary.complete, "a rule is a deliberate skip, not a degraded pass")
        self.assertEqual([item.code for item in summary.diagnostics], ["robots_disallowed"])
        self.assertEqual(summary.diagnostics[0].details["rule"], "Disallow: /careers")
        self.assertEqual(store.fetches, [], "nothing was fetched, so nothing is recorded as fetched")

    def test_an_ats_api_host_is_subject_to_its_own_robots_txt(self):
        configured = source("greenhouse", "https://boards.greenhouse.io/fixture", external_key="fixture")
        robots = {"https://boards-api.greenhouse.io/robots.txt": RobotsFetch(503)}
        summary = SourceIngestionService(
            AdapterRegistry([GreenhouseAdapter()]), RobotsTransport({}, robots), MemoryObservationStore()
        ).ingest(configured, observed_at=SEEN_AT)
        self.assertFalse(summary.complete, "an unreachable robots.txt leaves the source partial, to retry next run")
        self.assertEqual([item.code for item in summary.diagnostics], ["robots_unreachable"])
        self.assertEqual(summary.diagnostics[0].severity, "error")

    def test_a_disallowed_sitemap_page_is_skipped_and_its_siblings_are_kept(self):
        sitemap_url = "https://careers.example.test/sitemap.xml"
        job_url = "https://careers.example.test/jobs/site-801"
        sitemap = (
            b'<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'
            b"<url><loc>https://careers.example.test/jobs/site-801</loc></url>"
            b"<url><loc>https://careers.example.test/jobs/internal/site-900</loc></url></urlset>"
        )
        robots = {
            "https://careers.example.test/robots.txt": RobotsFetch(200, b"User-agent: *\nDisallow: /jobs/internal/\n")
        }
        collector = RobotsTransport(
            {
                sitemap_url: (sitemap, "application/xml"),
                job_url: ((FIXTURES / "sitemap_job.html").read_bytes(), "text/html"),
            },
            robots,
        )
        result = SitemapAdapter().collect(source("sitemap", sitemap_url), collector, observed_at=SEEN_AT)
        self.assertEqual(len(result.observations), 1)
        self.assertTrue(result.complete)
        refused = [item for item in result.diagnostics if item.code == "robots_disallowed"]
        self.assertEqual([item.url for item in refused], ["https://careers.example.test/jobs/internal/site-900"])
        self.assertNotIn("https://careers.example.test/jobs/internal/site-900", collector.calls)

    def test_a_disallowed_archive_index_and_snapshot_are_recorded_and_the_pass_is_partial(self):
        adapter = WaybackAdapter()
        configured = source(
            "wayback", "https://careers.example.test/students", options={"from": 2024, "to": 2024}
        )
        robots = {"https://web.archive.org/robots.txt": RobotsFetch(200, b"User-agent: *\nDisallow: /\n")}
        result = adapter.collect(configured, RobotsTransport({}, robots), observed_at=SEEN_AT)
        codes = [item.code for item in result.diagnostics]
        self.assertIn("robots_disallowed", codes)
        self.assertIn("cdx_target_collection_failed", codes)
        self.assertFalse(result.complete)

    def test_a_signal_source_robots_txt_disallows_is_skipped_without_touching_its_state(self):
        class Store:
            def get_signal_source_state(self, source_id):
                return None

            def save_signal_observation(self, *args, **kwargs):  # pragma: no cover - must not be reached
                raise AssertionError("a skipped source records no observation")

            def save_signal_source_state(self, state):  # pragma: no cover - must not be reached
                raise AssertionError("a skipped source keeps its previous state")

        robots = {"https://careers.example.test/robots.txt": RobotsFetch(200, b"User-agent: *\nDisallow: /\n")}
        summary = RecruitingSignalIngestionService(Store(), RobotsTransport({}, robots)).ingest(  # type: ignore[arg-type]
            source("generic", "https://careers.example.test/careers"), observed_at=SEEN_AT
        )
        self.assertEqual(summary.skipped, "robots_disallowed")
        self.assertEqual(summary.created, 0)


if __name__ == "__main__":
    unittest.main()
