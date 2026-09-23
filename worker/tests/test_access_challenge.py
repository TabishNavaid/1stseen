"""A site that answers with a bot challenge is refusing, and is recorded as a refusal rather than a failure.

OpenAI, Pinterest and ID.me all answer a collector with Cloudflare's managed challenge: HTTP 403 carrying
`cf-mitigated: challenge`. The block is honoured, and always was. What these tests hold is the classification: the
refusal must not look like a collector that is breaking, because a streak of failed tool calls is what opens and holds
a collection-health alert, and an alert nobody can act on is worse than no alert.

Nothing here permits a retry, a browser, or any attempt to get past a challenge.
"""

from __future__ import annotations

import io
import unittest
from datetime import UTC, datetime
from urllib.error import HTTPError
from uuid import UUID

from firstseen.adapters.base import (
    AccessChallengedError,
    SourceConfig,
    UrlLibTransport,
    access_challenge_diagnostic,
)
from firstseen.config import Settings
from firstseen.security import PublicUrlPolicy
from firstseen.source_ingestion import SourceIngestionService

SEEN_AT = datetime(2026, 9, 23, 8, 0, tzinfo=UTC)
URL = "https://www.fixture.test/careers"


class _Opener:
    """Raises one prepared HTTPError, the way urllib surfaces a 4xx or 5xx response."""

    def __init__(self, status: int, headers: dict[str, str], body: bytes = b"") -> None:
        self.error = HTTPError(URL, status, "fixture", headers, io.BytesIO(body))  # type: ignore[arg-type]

    def open(self, request, timeout=None):
        raise self.error


def transport(status: int, headers: dict[str, str], body: bytes = b"") -> UrlLibTransport:
    settings = Settings(_env_file=None, HTTP_MIN_HOST_INTERVAL_SECONDS=0, ROBOTS_TXT_ENFORCED=False)
    return UrlLibTransport(
        settings,
        url_policy=PublicUrlPolicy(resolver=lambda host, port, type=None: [(2, 1, 6, "", ("93.184.215.14", port))]),
        opener=_Opener(status, headers, body),  # type: ignore[arg-type]
    )


class ChallengeDetectionTests(unittest.TestCase):
    def test_the_header_cloudflare_sets_is_enough(self) -> None:
        with self.assertRaises(AccessChallengedError) as caught:
            transport(403, {"cf-mitigated": "challenge"}).get(URL)
        self.assertEqual(caught.exception.status, 403)
        self.assertEqual(caught.exception.code, "access_challenged")
        self.assertIn("cf-mitigated: challenge", caught.exception.marker)

    def test_a_challenge_page_without_the_header_is_read_from_its_body(self) -> None:
        body = b"<html><body><h1>Verify you are human</h1></body></html>"
        with self.assertRaises(AccessChallengedError) as caught:
            transport(503, {"server": "cloudflare"}, body).get(URL)
        self.assertEqual(caught.exception.status, 503)
        self.assertIn("verify you are human", caught.exception.marker)

    def test_an_ordinary_refusal_is_still_an_http_error(self) -> None:
        """A 403 that is simply "no" must not be reclassified: only a challenge is a challenge."""
        for status, headers, body in (
            (403, {"content-type": "text/html"}, b"<html>Forbidden</html>"),
            (404, {"cf-mitigated": "challenge"}, b""),  # the header is only read on a challenge status
            (500, {}, b"upstream error"),
        ):
            with self.subTest(status=status), self.assertRaises(HTTPError):
                transport(status, headers, body).get(URL)

    def test_the_diagnostic_is_a_warning_naming_what_identified_it(self) -> None:
        refusal = AccessChallengedError(URL, status=403, marker="cf-mitigated: challenge")
        diagnostic = access_challenge_diagnostic(refusal).as_dict()
        self.assertEqual(diagnostic["code"], "access_challenged")
        # A warning, not an error: the site has said no, and no later run recovers anything by retrying.
        self.assertEqual(diagnostic["severity"], "warning")
        self.assertEqual(diagnostic["details"], {"status": 403, "marker": "cf-mitigated: challenge"})


class _ChallengingTransport:
    def get(self, url, *, accept="*/*", max_bytes=None):
        raise AccessChallengedError(url, status=403, marker="cf-mitigated: challenge")


class _StubStore:
    """The refusal is returned before anything is read or written, so nothing here should be called twice."""

    def __init__(self) -> None:
        self.writes: list[str] = []

    def last_document_hash(self, source_id):
        return "previous-hash"

    def __getattr__(self, name):  # any write at all is a failure of the contract
        def record(*args, **kwargs):
            self.writes.append(name)

        return record


class ChallengedCollectionTests(unittest.TestCase):
    def test_a_challenged_source_is_complete_with_a_diagnostic_and_writes_nothing(self) -> None:
        from firstseen.adapters.generic import GenericCareerPageAdapter
        from firstseen.adapters.registry import AdapterRegistry

        store = _StubStore()
        service = SourceIngestionService(
            AdapterRegistry([GenericCareerPageAdapter()]), _ChallengingTransport(), store
        )
        summary = service.ingest(
            SourceConfig(
                id=UUID("00000000-0000-4000-8000-000000000101"),
                company_id=UUID("00000000-0000-4000-8000-000000000001"),
                company="Fixture",
                adapter="generic",
                url=URL,
                trust_score=0.9,
            ),
            observed_at=SEEN_AT,
        )
        # Complete, so the run records a succeeded tool call and the source's failure streak ends.
        self.assertTrue(summary.complete)
        self.assertEqual([item.code for item in summary.diagnostics], ["access_challenged"])
        self.assertEqual((summary.detected, summary.created, summary.changed, summary.unchanged), (0, 0, 0, 0))
        self.assertEqual(summary.document_hash, "")
        self.assertEqual(store.writes, [], "a refused source writes nothing")


class ChallengedSignalTests(unittest.TestCase):
    def test_a_challenged_signal_source_is_skipped_and_keeps_its_previous_state(self) -> None:
        """A challenge leaves signal state alone, so the next read that is served diffs against what was last seen."""
        from firstseen.signals import RecruitingSignalIngestionService

        class _Store:
            def __init__(self) -> None:
                self.saved: list[object] = []

            def get_signal_source_state(self, source_id):
                return None

            def __getattr__(self, name):
                def record(*args, **kwargs):
                    self.saved.append(name)

                return record

        store = _Store()
        summary = RecruitingSignalIngestionService(store, _ChallengingTransport()).ingest(
            SourceConfig(
                id=UUID("00000000-0000-4000-8000-000000000101"),
                company_id=UUID("00000000-0000-4000-8000-000000000001"),
                company="Fixture",
                adapter="generic",
                url=URL,
                trust_score=0.9,
            ),
            observed_at=SEEN_AT,
        )
        self.assertEqual(summary.skipped, "access_challenged")
        self.assertEqual((summary.detected, summary.created, summary.unchanged), (0, 0, 0))
        self.assertEqual(store.saved, [], "a refused source saves no observation and no state")


if __name__ == "__main__":
    unittest.main()
