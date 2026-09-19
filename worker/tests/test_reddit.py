from __future__ import annotations

import json
import unittest
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

from test_signals import MemorySignalStore, Transport

from firstseen.adapters.base import SourceConfig
from firstseen.adapters.reddit import (
    RedditApiError,
    RedditDataApiClient,
    RedditHttpResponse,
    RedditSignalAdapter,
)
from firstseen.config import Settings
from firstseen.providers import CompletionResult
from firstseen.signals import RecruitingSignalIngestionService

FIXTURE = Path(__file__).parent / "fixtures" / "reddit_search.json"
SEEN = datetime(2026, 8, 14, 12, tzinfo=UTC)
COMPANY_ID = UUID("00000000-0000-4000-8000-000000000001")
SOURCE_ID = UUID("00000000-0000-4000-8000-000000000201")


class ApiTransport:
    def __init__(self, search_body: bytes) -> None:
        self.search_body = search_body
        self.requests: list[tuple[str, str, Mapping[str, str], bytes | None]] = []

    def request(
        self,
        url: str,
        *,
        method: str,
        headers: Mapping[str, str],
        body: bytes | None = None,
    ) -> RedditHttpResponse:
        self.requests.append((url, method, headers, body))
        if url.endswith("/api/v1/access_token"):
            return RedditHttpResponse(200, b'{"access_token":"fixture-token"}', {})
        return RedditHttpResponse(
            200,
            self.search_body,
            {"x-ratelimit-remaining": "99", "x-ratelimit-reset": "60"},
        )


class RateLimitedTransport(ApiTransport):
    def request(
        self,
        url: str,
        *,
        method: str,
        headers: Mapping[str, str],
        body: bytes | None = None,
    ) -> RedditHttpResponse:
        if url.endswith("/api/v1/access_token"):
            return super().request(url, method=method, headers=headers, body=body)
        self.requests.append((url, method, headers, body))
        return RedditHttpResponse(429, b'{"message":"Too Many Requests"}', {})


class FakeCompletionClient:
    def __init__(self, content: dict[str, object]) -> None:
        self.content = content
        self.calls = 0

    def complete(self, **kwargs: object) -> CompletionResult:
        self.calls += 1
        self.response_model = kwargs.get("response_model")
        return CompletionResult(json.dumps(self.content), "fake", "fake")


def settings() -> Settings:
    return Settings(
        _env_file=None,
        REDDIT_API_ENABLED=True,
        REDDIT_CLIENT_ID="fixture-client",
        REDDIT_CLIENT_SECRET="fixture-secret",
        REDDIT_USER_AGENT="python:1stseen-fixture:v0.11 (by /u/fixture_account)",
        REDDIT_COMMUNITIES="csMajors",
    )


def adapter(*, llm: FakeCompletionClient | None = None) -> tuple[RedditSignalAdapter, ApiTransport]:
    transport = ApiTransport(FIXTURE.read_bytes())
    client = RedditDataApiClient(settings(), transport)
    return RedditSignalAdapter(client, communities=("csMajors",), llm=llm), transport


class RedditSignalAdapterTests(unittest.TestCase):
    def test_rate_limit_is_not_retried_or_bypassed(self) -> None:
        transport = RateLimitedTransport(FIXTURE.read_bytes())
        subject = RedditSignalAdapter(RedditDataApiClient(settings(), transport), communities=("csMajors",))

        with self.assertRaisesRegex(RedditApiError, "HTTP 429"):
            subject.collect("Google")

        self.assertEqual(len(transport.requests), 2)

    def test_clear_claims_are_deterministic_and_require_zero_model_calls(self) -> None:
        fake = FakeCompletionClient({"relevant": False})
        subject, transport = adapter(llm=fake)

        candidates = subject.collect("Google")

        self.assertEqual(len(candidates), 3)
        self.assertEqual(fake.calls, 0)
        self.assertEqual(
            {candidate.community_event_type for candidate in candidates},
            {"applications_opened", "applications_closed", "applications_opening_soon"},
        )
        future = next(item for item in candidates if item.community_event_type == "applications_opening_soon")
        self.assertIsNone(future.claimed_event_at)
        self.assertEqual(future.claimed_date_text, "next month")
        self.assertEqual(future.claimed_date_precision, "relative_unresolved")
        opened = next(item for item in candidates if item.community_event_type == "applications_opened")
        self.assertEqual(opened.claimed_event_at, opened.source_published_at)
        self.assertTrue(all(item.extraction_method == "structured_endpoint" for item in candidates))
        self.assertEqual(transport.requests[0][1], "POST")
        self.assertIn("oauth.reddit.com/r/csMajors/search", transport.requests[1][0])
        self.assertNotIn("author", " ".join(item.evidence_snippet for item in candidates).casefold())

    def test_likely_but_ambiguous_text_uses_validated_model_extraction(self) -> None:
        payload = {
            "data": {
                "children": [
                    {
                        "data": {
                            "id": "ambiguous",
                            "title": "Google SWE internship window dropped",
                            "selftext": "The Google application window dropped this morning.",
                            "permalink": "/r/csMajors/comments/ambiguous/google_window/",
                            "subreddit": "csMajors",
                            "created_utc": 1786698000,
                        }
                    }
                ]
            }
        }
        fake = FakeCompletionClient(
            {
                "relevant": True,
                "event_type": "applications_opened",
                "possible_role": "SWE internship",
                "claimed_date_text": None,
                "evidence_snippet": "The Google application window dropped this morning.",
            }
        )
        transport = ApiTransport(json.dumps(payload).encode())
        subject = RedditSignalAdapter(
            RedditDataApiClient(settings(), transport), communities=("csMajors",), llm=fake
        )

        candidates = subject.collect("Google")

        self.assertEqual(fake.calls, 1)
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].extraction_method, "llm")

    def test_model_quote_must_be_an_exact_post_substring(self) -> None:
        fake = FakeCompletionClient(
            {
                "relevant": True,
                "event_type": "applications_opened",
                "possible_role": "SWE internship",
                "claimed_date_text": None,
                "evidence_snippet": "Fabricated quote not present in the post",
            }
        )
        payload = json.loads(FIXTURE.read_text())
        payload["data"]["children"] = [
            {
                "data": {
                    "id": "ambiguous",
                    "title": "Google internship application rumor",
                    "selftext": "People are discussing the Google internship window.",
                    "permalink": "/r/csMajors/comments/ambiguous/google_window/",
                    "subreddit": "csMajors",
                    "created_utc": 1786698000,
                }
            }
        ]
        transport = ApiTransport(json.dumps(payload).encode())
        subject = RedditSignalAdapter(
            RedditDataApiClient(settings(), transport), communities=("csMajors",), llm=fake
        )

        self.assertEqual(subject.collect("Google"), ())
        self.assertEqual(fake.calls, 1)

    def test_persistence_caps_authority_and_marks_supporting_only(self) -> None:
        subject, _ = adapter()
        store = MemorySignalStore()
        source = SourceConfig(
            id=SOURCE_ID,
            company_id=COMPANY_ID,
            company="Google",
            adapter="reddit",
            url="https://oauth.reddit.com/r/csMajors/search",
            trust_score=0.9,
        )

        summary = RecruitingSignalIngestionService(store, Transport({})).ingest_social(
            source, subject, observed_at=SEEN
        )

        self.assertEqual(summary.created, 3)
        self.assertTrue(store.signals)
        self.assertTrue(all(item.source_reliability == 0.45 for item in store.signals.values()))
        self.assertTrue(all(item.signal_strength == 0.30 for item in store.signals.values()))
        self.assertTrue(all(item.evidence_semantics == "supporting_only" for item in store.signals.values()))
        self.assertTrue(all(item.observed_at == SEEN for item in store.signals.values()))
        self.assertTrue(all(item.source_published_at != SEEN for item in store.signals.values()))


class RedditConfigurationTests(unittest.TestCase):
    def test_live_collection_requires_credentials_and_descriptive_user_agent(self) -> None:
        with self.assertRaisesRegex(ValueError, "REDDIT_CLIENT_ID"):
            Settings(_env_file=None, REDDIT_API_ENABLED=True)
        with self.assertRaisesRegex(ValueError, "by /u/"):
            Settings(
                _env_file=None,
                REDDIT_API_ENABLED=True,
                REDDIT_CLIENT_ID="id",
                REDDIT_CLIENT_SECRET="secret",
                REDDIT_USER_AGENT="generic-bot",
            )
        with self.assertRaisesRegex(ValueError, "explicit community allowlist"):
            Settings(
                _env_file=None,
                REDDIT_API_ENABLED=True,
                REDDIT_CLIENT_ID="id",
                REDDIT_CLIENT_SECRET="secret",
                REDDIT_USER_AGENT="python:firstseen:v0.11 (by /u/fixture_account)",
            )
        with self.assertRaisesRegex(ValueError, "requires REDDIT_API_ENABLED"):
            Settings(_env_file=None, REDDIT_LLM_EXTRACTION_ENABLED=True)


if __name__ == "__main__":
    unittest.main()
