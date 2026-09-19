"""Small dependency-free ASGI streaming API for RecruitingAgent."""

from __future__ import annotations

import json
from collections import deque
from collections.abc import Awaitable, Callable
from datetime import UTC, date, datetime
from hashlib import sha256
from hmac import compare_digest
from http import HTTPStatus
from importlib.metadata import PackageNotFoundError
from importlib.metadata import version as package_version
from time import monotonic
from typing import Any, Literal, Protocol
from uuid import UUID

from pydantic import BaseModel, Field, ValidationError, model_validator

from .agent import RecruitingAgent, RecruitingTools, SupabaseRecruitingKnowledge
from .agent_intent import LlmGoalIntentInterpreter
from .agent_questions import SupabasePortfolioQueries, UsefulQuestionTools
from .backtesting import BacktestRunner, ForecastReplayResult
from .config import Settings, get_settings
from .providers import ModelRouter
from .readiness import (
    ApplicationReadinessPlanner,
    ReadinessContext,
    ReadinessForecast,
    SupabaseReadinessPlanStore,
)
from .repository import IntelligenceRepository

Scope = dict[str, Any]
Message = dict[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]

AGENT_ROUTES = frozenset(
    {"/v1/recruiting/query", "/v1/forecast-replay", "/v1/readiness-plan"}
)
HEALTH_ROUTE = "/healthz"

try:
    PACKAGE_VERSION = package_version("firstseen-intelligence")
except PackageNotFoundError:  # pragma: no cover - only when running from a source tree
    PACKAGE_VERSION = "unknown"


class TokenRateLimiter:
    """Fixed per-token request ceiling over a sliding one-minute window.

    In-process and per-instance by design: the service is deployed with a small
    `max-instances`, so the real ceiling is this limit times the instance count.
    That is a cost guard against a leaked token, not a distributed quota; a
    shared counter would need Redis, which is not added without a
    measured requirement.

    Tokens are keyed by digest, never stored in the clear, and idle keys are
    dropped so the map cannot grow without bound.
    """

    def __init__(self, limit_per_minute: int, *, clock: Callable[[], float] = monotonic) -> None:
        self._limit = limit_per_minute
        self._clock = clock
        self._hits: dict[str, deque[float]] = {}

    def check(self, token: str) -> tuple[bool, int]:
        """Return (allowed, retry_after_seconds)."""
        now = self._clock()
        cutoff = now - 60.0
        key = sha256(token.encode()).hexdigest()

        for stale_key in [k for k, v in self._hits.items() if not v or v[-1] <= cutoff]:
            if stale_key != key:
                del self._hits[stale_key]

        window = self._hits.setdefault(key, deque())
        while window and window[0] <= cutoff:
            window.popleft()
        if len(window) >= self._limit:
            return False, max(1, int(window[0] + 60.0 - now) + 1)
        window.append(now)
        return True, 0


class AgentFactory(Protocol):
    def __call__(self) -> RecruitingAgent: ...


class RecruitingQuestion(BaseModel):
    question: str = Field(min_length=3, max_length=2_000)
    user_id: UUID | None = None
    # The web Worker sends "guest" only for a signed-out visitor it has rate-limited.
    audience: Literal["member", "guest"] = "member"
    context_company: str | None = Field(default=None, min_length=1, max_length=300)
    context_role: str | None = Field(default=None, min_length=1, max_length=500)
    # The role page's own role, so the agent resolves that program even when another shares its title.
    context_role_id: UUID | None = None

    @model_validator(mode="after")
    def guests_carry_no_user(self) -> RecruitingQuestion:
        if self.audience == "guest" and self.user_id is not None:
            raise ValueError("a guest question carries no user identity")
        return self


class ForecastReplayRequest(BaseModel):
    role_id: UUID
    target_year: int = Field(ge=1900, le=2200)
    forecast_cutoff: date


class ReadinessPlanRequest(BaseModel):
    role_id: UUID
    user_id: UUID


class RecruitingAgentApi:
    def __init__(
        self,
        agent_factory: AgentFactory | None = None,
        *,
        settings: Settings | None = None,
        clock: Callable[[], float] = monotonic,
    ) -> None:
        self.settings = settings or get_settings()
        self.agent_factory = agent_factory or self._production_agent
        self.rate_limiter = TokenRateLimiter(
            self.settings.agent_api_rate_limit_per_minute, clock=clock
        )

    def _production_agent(self) -> RecruitingAgent:
        repository = IntelligenceRepository.from_settings(self.settings)
        return RecruitingAgent(
            RecruitingTools(
                SupabaseRecruitingKnowledge(repository),
                readiness_store=SupabaseReadinessPlanStore(repository.client),
            ),
            repository,
            useful_tools=UsefulQuestionTools(SupabasePortfolioQueries(repository.client)),
            intent_interpreter=self._intent_interpreter(repository),
        )

    def _intent_interpreter(
        self, repository: IntelligenceRepository
    ) -> LlmGoalIntentInterpreter | None:
        """Explicit opt-in only, so the agent stays deterministic by default."""
        if not self.settings.agent_intent_llm_enabled:
            return None
        router = ModelRouter.from_settings(self.settings, tracker=repository)
        return LlmGoalIntentInterpreter(router.client("classify"))

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            return
        path = scope.get("path")

        # Liveness/startup probe. Deliberately before the auth and routing checks:
        # Cloud Run has no credential to present, and a probe that touched Supabase
        # would let a database outage stop the revision from ever becoming ready.
        # It reads no configuration and opens no connection.
        if path == HEALTH_ROUTE:
            if scope.get("method") not in {"GET", "HEAD"}:
                await self._json(
                    send, HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method_not_allowed"}
                )
                return
            await self._json(send, HTTPStatus.OK, {"status": "ok", "version": PACKAGE_VERSION})
            return

        if path not in AGENT_ROUTES:
            await self._json(send, HTTPStatus.NOT_FOUND, {"error": "not_found"})
            return
        if scope.get("method") != "POST":
            await self._json(send, HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method_not_allowed"})
            return
        if not self._authorized(scope):
            await self._json(send, HTTPStatus.UNAUTHORIZED, {"error": "unauthorized"})
            return

        # Counted only after the token is known good, so an unauthenticated flood
        # cannot populate the map.
        allowed, retry_after = self.rate_limiter.check(self._presented_token(scope))
        if not allowed:
            await self._json(
                send,
                HTTPStatus.TOO_MANY_REQUESTS,
                {"error": "rate_limited"},
                headers=[(b"retry-after", str(retry_after).encode())],
            )
            return

        # Per-request, not instance state: the app object is shared across every
        # concurrent request on the instance.
        started = False

        async def tracking_send(message: Message) -> None:
            nonlocal started
            if message.get("type") == "http.response.start":
                started = True
            await send(message)

        try:
            await self._dispatch(path, receive, tracking_send)
        except Exception:  # noqa: BLE001 - a public ingress returns a fixed body, never a trace
            # Nothing derived from the exception reaches the client: an upstream
            # message could carry a connection string, a row, or SQL. The worker's
            # own audit trail records failures with redaction.
            if started:
                await send({"type": "http.response.body", "body": b"", "more_body": False})
            else:
                await self._json(
                    send, HTTPStatus.INTERNAL_SERVER_ERROR, {"error": "internal_error"}
                )
            return

    async def _dispatch(self, path: str, receive: Receive, send: Send) -> None:
        if path == "/v1/forecast-replay":
            await self._replay(receive, send)
            return
        if path == "/v1/readiness-plan":
            await self._readiness_plan(receive, send)
            return
        try:
            body = await self._body(receive)
            request = RecruitingQuestion.model_validate_json(body)
        except (ValidationError, ValueError, json.JSONDecodeError):
            await self._json(send, HTTPStatus.BAD_REQUEST, {"error": "invalid_question"})
            return
        await send(
            {
                "type": "http.response.start",
                "status": HTTPStatus.OK,
                "headers": [
                    (b"content-type", b"text/event-stream; charset=utf-8"),
                    (b"cache-control", b"no-cache, no-transform"),
                    (b"x-accel-buffering", b"no"),
                ],
            }
        )
        agent = self.agent_factory()
        goal = request.question
        if request.context_company or request.context_role:
            goal += "\nSelected role context: " + " — ".join(
                value for value in (request.context_company, request.context_role) if value
            )
        for event in agent.stream(
            goal, user_id=request.user_id, audience=request.audience, role_id=request.context_role_id
        ):
            payload = f"event: {event.type}\ndata: {event.model_dump_json()}\n\n".encode()
            await send({"type": "http.response.body", "body": payload, "more_body": True})
        await send({"type": "http.response.body", "body": b"", "more_body": False})

    async def _replay(self, receive: Receive, send: Send) -> None:
        try:
            body = await self._body(receive)
            request = ForecastReplayRequest.model_validate_json(body)
        except (ValidationError, ValueError, json.JSONDecodeError):
            await self._json(send, HTTPStatus.BAD_REQUEST, {"error": "invalid_replay"})
            return
        try:
            repository = IntelligenceRepository.from_settings(self.settings)
            roles, events, signals = repository.load_backtest_dataset()
            result: ForecastReplayResult = BacktestRunner().replay(
                roles,
                events,
                signals,
                role_id=str(request.role_id),
                target_year=request.target_year,
                forecast_cutoff=request.forecast_cutoff,
            )
        except ValueError as exc:
            # A refused replay is honest output, not a failure: the leak-safe
            # eligibility rules genuinely admit no evidence for this case. The
            # reason is a fixed message written by `BacktestRunner`, so it is safe
            # to return verbatim and lets the UI explain the skip in user language.
            await self._json(
                send,
                HTTPStatus.UNPROCESSABLE_ENTITY,
                {"error": "replay_not_evaluable", "reason": str(exc)[:300]},
            )
            return
        await self._json(send, HTTPStatus.OK, result.to_dict())

    async def _readiness_plan(self, receive: Receive, send: Send) -> None:
        """Materialise the deterministic work-back plan for one followed role.

        Dates come from `readiness.py` applied to the latest stored forecast; the
        endpoint never recalculates a forecast and refuses when the caller does
        not actually follow the role.
        """
        try:
            body = await self._body(receive)
            request = ReadinessPlanRequest.model_validate_json(body)
        except (ValidationError, ValueError, json.JSONDecodeError):
            await self._json(send, HTTPStatus.BAD_REQUEST, {"error": "invalid_readiness_request"})
            return
        repository = IntelligenceRepository.from_settings(self.settings)
        if request.user_id not in set(repository.list_role_watchers(request.role_id)):
            await self._json(send, HTTPStatus.FORBIDDEN, {"error": "role_not_followed"})
            return
        version = repository.current_forecast_version(request.role_id)
        if version is None:
            await self._json(
                send,
                HTTPStatus.UNPROCESSABLE_ENTITY,
                {
                    "error": "no_forecast",
                    "reason": (
                        "Readiness dates are worked back from a prediction interval. "
                        "This role has no stored forecast yet."
                    ),
                },
            )
            return
        forecast = version.forecast
        as_of = datetime.now(UTC).date()
        if forecast.window_end < as_of:
            await self._json(
                send,
                HTTPStatus.UNPROCESSABLE_ENTITY,
                {
                    "error": "interval_elapsed",
                    "reason": "The stored prediction interval has already passed.",
                },
            )
            return
        context = repository.readiness_context_for_role(request.role_id)
        plan = ApplicationReadinessPlanner().plan(
            ReadinessForecast(
                forecast_id=version.id,
                role_id=request.role_id,
                as_of=as_of,
                expected_opening_date=forecast.point_date,
                interval_start=forecast.window_start,
                interval_end=forecast.window_end,
                confidence=forecast.confidence,
            ),
            ReadinessContext(**context) if context else ReadinessContext(),
        )
        SupabaseReadinessPlanStore(repository.client).save_for_user(request.user_id, plan)
        await self._json(send, HTTPStatus.OK, plan.model_dump(mode="json"))

    def _authorized(self, scope: Scope) -> bool:
        expected = self.settings.agent_api_bearer_token
        if not expected:
            return (
                self.settings.environment != "production"
                and self.settings.allow_unauthenticated_agent_dev
            )
        return compare_digest(self._authorization_header(scope), f"Bearer {expected}")

    @staticmethod
    def _authorization_header(scope: Scope) -> str:
        headers = {key.lower(): value for key, value in scope.get("headers", [])}
        return headers.get(b"authorization", b"").decode(errors="replace")

    def _presented_token(self, scope: Scope) -> str:
        """Rate-limit key. Only ever hashed, never logged or returned."""
        header = self._authorization_header(scope)
        prefix = "Bearer "
        if header.startswith(prefix):
            return header[len(prefix) :]
        # The local-development bypass presents no token; one shared bucket is
        # still better than no ceiling.
        return "unauthenticated-dev-bypass"

    @staticmethod
    async def _body(receive: Receive) -> bytes:
        body = bytearray()
        while True:
            message = await receive()
            if message.get("type") != "http.request":
                continue
            body.extend(message.get("body", b""))
            if len(body) > 16_384:
                raise ValueError("request too large")
            if not message.get("more_body", False):
                return bytes(body)

    @staticmethod
    async def _json(
        send: Send,
        status: HTTPStatus,
        payload: dict[str, Any],
        *,
        headers: list[tuple[bytes, bytes]] | None = None,
    ) -> None:
        body = json.dumps(payload).encode()
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"content-length", str(len(body)).encode()),
                    *(headers or []),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body, "more_body": False})


app = RecruitingAgentApi()
