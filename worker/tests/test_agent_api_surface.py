"""HTTP-surface contract for the public agent ingress.

The service is deployed behind `--allow-unauthenticated` on Cloud Run, so the
bearer token plus `FIRSTSEEN_ENV=production` *is* the auth boundary. These tests
assert the properties that boundary depends on.
"""

from __future__ import annotations

import asyncio
import json
import unittest
from collections.abc import Iterator
from typing import Any
from unittest import mock

from firstseen import agent_api
from firstseen.agent_api import AGENT_ROUTES, PACKAGE_VERSION, RecruitingAgentApi, TokenRateLimiter
from firstseen.config import Settings


class NoRepository:
    """Constructing a repository is the failure: the probe must not open storage."""

    @staticmethod
    def from_settings(*args: Any, **kwargs: Any) -> Any:  # pragma: no cover - only on a bug
        raise AssertionError("the health endpoint must not construct a repository")

    def __init__(self, *args: Any, **kwargs: Any) -> None:  # pragma: no cover - only on a bug
        raise AssertionError("the health endpoint must not construct a repository")


def call(
    api: RecruitingAgentApi,
    *,
    path: str,
    method: str = "POST",
    body: bytes = b"{}",
    headers: list[tuple[bytes, bytes]] | None = None,
) -> list[dict[str, Any]]:
    requests: Iterator[dict[str, Any]] = iter(
        [{"type": "http.request", "body": body, "more_body": False}]
    )
    responses: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return next(requests)

    async def send(message: dict[str, Any]) -> None:
        responses.append(message)

    asyncio.run(
        api(
            {"type": "http", "method": method, "path": path, "headers": headers or []},
            receive,
            send,
        )
    )
    return responses


def body_of(responses: list[dict[str, Any]]) -> str:
    return b"".join(item.get("body", b"") for item in responses[1:]).decode()


def unreachable_agent() -> Any:  # pragma: no cover - invoked only on a bug
    raise AssertionError("the agent must not be constructed for a rejected request")


class HealthEndpointTests(unittest.TestCase):
    """`/health` is the Cloud Run startup probe and the outside health check: no auth, no database."""

    def setUp(self) -> None:
        """Make any storage access during a probe an outright failure."""
        patch = mock.patch.object(agent_api, "IntelligenceRepository", NoRepository)
        patch.start()
        self.addCleanup(patch.stop)

    def subject(self) -> RecruitingAgentApi:
        # The default factory is the production one, so a probe that fell through
        # to routing would build a repository and trip NoRepository.
        return RecruitingAgentApi(
            settings=Settings(_env_file=None, FIRSTSEEN_ENV="production", AGENT_API_BEARER_TOKEN="fixture-token"),
        )

    def test_health_requires_no_bearer_token(self) -> None:
        responses = call(self.subject(), path="/health", method="GET")

        self.assertEqual(responses[0]["status"], 200)
        self.assertEqual(
            json.loads(body_of(responses)), {"status": "ok", "version": PACKAGE_VERSION}
        )

    def test_health_rejects_a_wrong_token_by_ignoring_it_entirely(self) -> None:
        """A probe never presents credentials; a bad one must not turn into a 401."""
        responses = call(
            self.subject(),
            path="/health",
            method="GET",
            headers=[(b"authorization", b"Bearer not-the-token")],
        )

        self.assertEqual(responses[0]["status"], 200)

    def test_health_reports_the_installed_package_version(self) -> None:
        payload = json.loads(body_of(call(self.subject(), path="/health", method="GET")))

        self.assertEqual(payload["status"], "ok")
        self.assertNotEqual(payload["version"], "unknown")

    def test_health_refuses_a_write_method(self) -> None:
        responses = call(self.subject(), path="/health", method="POST")

        self.assertEqual(responses[0]["status"], 405)


class ProductionAuthBoundaryTests(unittest.TestCase):
    def production(self) -> RecruitingAgentApi:
        return RecruitingAgentApi(
            unreachable_agent,
            settings=Settings(_env_file=None, FIRSTSEEN_ENV="production", AGENT_API_BEARER_TOKEN="fixture-token"),
        )

    def test_every_agent_route_401s_without_a_token(self) -> None:
        for path in sorted(AGENT_ROUTES):
            with self.subTest(path=path):
                responses = call(self.production(), path=path)

                self.assertEqual(responses[0]["status"], 401)
                self.assertEqual(json.loads(body_of(responses)), {"error": "unauthorized"})

    def test_every_agent_route_401s_with_a_wrong_token(self) -> None:
        for path in sorted(AGENT_ROUTES):
            with self.subTest(path=path):
                responses = call(
                    self.production(),
                    path=path,
                    headers=[(b"authorization", b"Bearer wrong-token")],
                )

                self.assertEqual(responses[0]["status"], 401)

    def test_a_valid_token_prefix_is_not_enough(self) -> None:
        """Guards against a prefix or truncation comparison."""
        for header in (b"Bearer fixture", b"Bearer fixture-token-extra", b"fixture-token"):
            with self.subTest(header=header):
                responses = call(
                    self.production(),
                    path="/v1/readiness-plan",
                    headers=[(b"authorization", header)],
                )

                self.assertEqual(responses[0]["status"], 401)

    def test_production_refuses_the_unauthenticated_development_bypass(self) -> None:
        with self.assertRaisesRegex(ValueError, "cannot be enabled in production"):
            Settings(
                _env_file=None,
                FIRSTSEEN_ENV="production",
                AGENT_API_BEARER_TOKEN="fixture-token",
                ALLOW_UNAUTHENTICATED_AGENT_DEV=True,
            )

    def test_production_requires_a_bearer_token_to_exist_at_all(self) -> None:
        with self.assertRaisesRegex(ValueError, "AGENT_API_BEARER_TOKEN is required in production"):
            Settings(_env_file=None, FIRSTSEEN_ENV="production")

    def test_unknown_paths_do_not_reveal_whether_a_route_exists(self) -> None:
        responses = call(self.production(), path="/v1/does-not-exist")

        self.assertEqual(responses[0]["status"], 404)
        self.assertEqual(json.loads(body_of(responses)), {"error": "not_found"})


class ErrorDisclosureTests(unittest.TestCase):
    """A public ingress returns fixed bodies: no env, trace, prompt, or SQL."""

    def test_an_upstream_failure_returns_a_fixed_body(self) -> None:
        leak = (
            "psycopg2.ProgrammingError: SELECT * FROM raw_job_observations WHERE id='x' -- "
            "SUPABASE_SERVICE_ROLE_KEY=sb_secret_live_abcdef123456 "
            "postgres://postgres:hunter2@db.abcdefghijkl.supabase.co:5432/postgres"
        )

        def explode() -> Any:
            raise RuntimeError(leak)

        api = RecruitingAgentApi(
            explode,
            settings=Settings(_env_file=None, FIRSTSEEN_ENV="production", AGENT_API_BEARER_TOKEN="fixture-token"),
        )
        responses = call(
            api,
            path="/v1/recruiting/query",
            body=json.dumps({"question": "When does Northstar open?"}).encode(),
            headers=[(b"authorization", b"Bearer fixture-token")],
        )

        rendered = repr(responses)
        for secret in (
            "sb_secret_live_abcdef123456",
            "hunter2",
            "supabase.co",
            "raw_job_observations",
            "SELECT",
            "psycopg2",
            "Traceback",
            "SUPABASE_SERVICE_ROLE_KEY",
        ):
            self.assertNotIn(secret, rendered)

    def test_a_failure_before_the_response_starts_returns_a_bare_500(self) -> None:
        """The non-streaming routes can still fail with nothing sent yet."""

        def explode(*args: Any, **kwargs: Any) -> Any:
            raise RuntimeError("relation \"watchlist_items\" does not exist")

        api = RecruitingAgentApi(
            unreachable_agent,
            settings=Settings(_env_file=None, FIRSTSEEN_ENV="production", AGENT_API_BEARER_TOKEN="fixture-token"),
        )
        with mock.patch.object(agent_api.IntelligenceRepository, "from_settings", explode):
            responses = call(
                api,
                path="/v1/readiness-plan",
                body=json.dumps(
                    {
                        "role_id": "11111111-1111-4111-8111-111111111111",
                        "user_id": "22222222-2222-4222-8222-222222222222",
                    }
                ).encode(),
                headers=[(b"authorization", b"Bearer fixture-token")],
            )

        self.assertEqual(responses[0]["status"], 500)
        self.assertEqual(json.loads(body_of(responses)), {"error": "internal_error"})
        self.assertNotIn("watchlist_items", repr(responses))

    def test_a_malformed_body_is_rejected_without_echoing_it(self) -> None:
        api = RecruitingAgentApi(
            unreachable_agent,
            settings=Settings(_env_file=None, FIRSTSEEN_ENV="production", AGENT_API_BEARER_TOKEN="fixture-token"),
        )
        responses = call(
            api,
            path="/v1/forecast-replay",
            body=b'{"role_id": "not-a-uuid", "secret_marker": "ZZPROBEZZ"}',
            headers=[(b"authorization", b"Bearer fixture-token")],
        )

        self.assertEqual(responses[0]["status"], 400)
        self.assertEqual(json.loads(body_of(responses)), {"error": "invalid_replay"})
        self.assertNotIn("ZZPROBEZZ", repr(responses))


class RateLimitTests(unittest.TestCase):
    def test_requests_beyond_the_per_token_ceiling_are_refused(self) -> None:
        now = [1_000.0]
        api = RecruitingAgentApi(
            unreachable_agent,
            settings=Settings(
                _env_file=None,
                FIRSTSEEN_ENV="production",
                AGENT_API_BEARER_TOKEN="fixture-token",
                AGENT_API_RATE_LIMIT_PER_MINUTE=3,
            ),
            clock=lambda: now[0],
        )
        auth = [(b"authorization", b"Bearer fixture-token")]

        statuses = [
            call(api, path="/v1/forecast-replay", body=b"{}", headers=auth)[0]["status"]
            for _ in range(4)
        ]

        # The first three are admitted and fail validation on their empty body;
        # the fourth never reaches the handler.
        self.assertEqual(statuses, [400, 400, 400, 429])

    def test_a_refusal_tells_the_caller_when_to_retry(self) -> None:
        now = [1_000.0]
        api = RecruitingAgentApi(
            unreachable_agent,
            settings=Settings(
                _env_file=None,
                FIRSTSEEN_ENV="production",
                AGENT_API_BEARER_TOKEN="fixture-token",
                AGENT_API_RATE_LIMIT_PER_MINUTE=1,
            ),
            clock=lambda: now[0],
        )
        auth = [(b"authorization", b"Bearer fixture-token")]
        call(api, path="/v1/forecast-replay", headers=auth)

        refused = call(api, path="/v1/forecast-replay", headers=auth)

        self.assertEqual(refused[0]["status"], 429)
        self.assertEqual(json.loads(body_of(refused)), {"error": "rate_limited"})
        self.assertIn((b"retry-after", b"61"), refused[0]["headers"])

    def test_the_window_reopens_once_it_has_elapsed(self) -> None:
        now = [1_000.0]
        api = RecruitingAgentApi(
            unreachable_agent,
            settings=Settings(
                _env_file=None,
                FIRSTSEEN_ENV="production",
                AGENT_API_BEARER_TOKEN="fixture-token",
                AGENT_API_RATE_LIMIT_PER_MINUTE=1,
            ),
            clock=lambda: now[0],
        )
        auth = [(b"authorization", b"Bearer fixture-token")]
        call(api, path="/v1/forecast-replay", headers=auth)
        self.assertEqual(call(api, path="/v1/forecast-replay", headers=auth)[0]["status"], 429)

        now[0] += 61.0

        self.assertEqual(call(api, path="/v1/forecast-replay", headers=auth)[0]["status"], 400)

    def test_an_unauthorized_flood_never_enters_the_limiter(self) -> None:
        """Counting before auth would let anyone evict or fill the map."""
        api = RecruitingAgentApi(
            unreachable_agent,
            settings=Settings(
                _env_file=None,
                FIRSTSEEN_ENV="production",
                AGENT_API_BEARER_TOKEN="fixture-token",
                AGENT_API_RATE_LIMIT_PER_MINUTE=2,
            ),
        )
        for _ in range(10):
            call(
                api,
                path="/v1/forecast-replay",
                headers=[(b"authorization", b"Bearer wrong-token")],
            )

        self.assertEqual(api.rate_limiter._hits, {})

    def test_the_limiter_never_retains_the_token_in_the_clear(self) -> None:
        limiter = TokenRateLimiter(5, clock=lambda: 0.0)
        limiter.check("super-secret-token")

        self.assertNotIn("super-secret-token", repr(limiter._hits))
        self.assertNotIn("super-secret-token", list(limiter._hits))

    def test_health_is_never_rate_limited(self) -> None:
        api = RecruitingAgentApi(
            unreachable_agent,
            settings=Settings(
                _env_file=None,
                FIRSTSEEN_ENV="production",
                AGENT_API_BEARER_TOKEN="fixture-token",
                AGENT_API_RATE_LIMIT_PER_MINUTE=1,
            ),
        )

        statuses = [call(api, path="/health", method="GET")[0]["status"] for _ in range(5)]

        self.assertEqual(statuses, [200] * 5)

    def test_idle_tokens_are_evicted_so_the_map_stays_bounded(self) -> None:
        now = [0.0]
        limiter = TokenRateLimiter(10, clock=lambda: now[0])
        for index in range(50):
            now[0] += 1.0
            limiter.check(f"token-{index}")

        now[0] += 3_600.0
        limiter.check("token-current")

        self.assertEqual(len(limiter._hits), 1)


if __name__ == "__main__":
    unittest.main()
