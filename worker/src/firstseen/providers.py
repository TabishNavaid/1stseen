"""Capability-based LiteLLM router with cost-conscious, audited fallback."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from time import monotonic
from typing import Any, Literal, Protocol, cast
from uuid import UUID

from pydantic import BaseModel, ValidationError

from .config import Settings, get_settings

Capability = Literal["extract", "classify", "normalize", "reason"]
ProviderName = Literal["gemini", "groq", "ollama"]
FailureKind = Literal[
    "rate_limit",
    "quota_exhausted",
    "temporary_provider",
    "timeout",
    "invalid_structured_output",
    "permanent_provider",
]


class CompletionClient(Protocol):
    def complete(
        self,
        *,
        messages: list[dict[str, str]],
        response_format: dict[str, Any] | None = None,
        response_model: type[BaseModel] | None = None,
    ) -> CompletionResult: ...


class ModelBackend(Protocol):
    def complete(
        self,
        route: ModelRoute,
        *,
        messages: list[dict[str, str]],
        response_format: dict[str, Any] | None,
        timeout_seconds: int,
    ) -> CompletionResult: ...


class ModelAttemptTracker(Protocol):
    def record_model_attempt(self, attempt: ModelAttempt) -> None: ...


@dataclass(frozen=True)
class CompletionResult:
    content: str
    provider: str
    model: str
    prompt_tokens: int = 0
    completion_tokens: int = 0
    estimated_cost_usd: float = 0.0
    capability: Capability | None = None
    latency_ms: int = 0
    fallback_reason: str | None = None


@dataclass(frozen=True)
class ModelRoute:
    provider: ProviderName
    model: str
    api_base: str | None = None
    api_key: str | None = field(default=None, repr=False)

    @classmethod
    def from_model(cls, model: str, settings: Settings) -> ModelRoute:
        prefix = model.split("/", 1)[0].casefold()
        if prefix not in {"gemini", "groq", "ollama"}:
            raise ValueError(
                f"Unsupported model route {model!r}; use a gemini/, groq/, or ollama/ LiteLLM model string"
            )
        provider = cast(ProviderName, prefix)
        # A blank variable (`LLM_API_KEY=` in a copied .env.example) arrives as "". Passed on,
        # litellm sends `Authorization: Bearer ` with nothing after it, which the HTTP client
        # refuses, so every local Ollama call failed before reaching the model.
        api_key = {
            "gemini": settings.gemini_api_key,
            "groq": settings.groq_api_key,
            "ollama": settings.llm_api_key,
        }[provider] or None
        ollama_base = settings.ollama_api_base or settings.llm_api_base
        api_base = str(ollama_base).rstrip("/") if provider == "ollama" and ollama_base else None
        return cls(provider=provider, model=model, api_base=api_base, api_key=api_key)


class ModelAttempt(BaseModel):
    provider: ProviderName
    model: str
    capability: Capability
    latency_ms: int
    prompt_tokens: int = 0
    completion_tokens: int = 0
    estimated_cost_usd: float = 0
    success: bool
    failure_kind: FailureKind | None = None
    fallback_reason: str | None = None
    agent_run_id: UUID | None = None
    tool_call_id: UUID | None = None


class ProviderFailure(RuntimeError):
    def __init__(self, kind: FailureKind, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.kind = kind
        self.status_code = status_code


class ModelRoutingError(RuntimeError):
    def __init__(self, capability: Capability, attempts: list[ModelAttempt]) -> None:
        super().__init__(f"All configured model routes failed for capability {capability}")
        self.capability = capability
        self.attempts = tuple(attempts)


def _failure_kind(exc: Exception) -> FailureKind | None:
    if isinstance(exc, ProviderFailure):
        return exc.kind
    if isinstance(exc, TimeoutError):
        return "timeout"
    status = getattr(exc, "status_code", None)
    name = type(exc).__name__.casefold()
    message = str(exc).casefold()
    if "timeout" in name or "timed out" in message:
        return "timeout"
    if status == 429 or "ratelimit" in name or "rate limit" in message:
        if "quota" in message or "resource_exhausted" in message:
            return "quota_exhausted"
        return "rate_limit"
    if status and 500 <= int(status) <= 599:
        return "temporary_provider"
    if any(marker in name for marker in ("serviceunavailable", "apiconnection", "internalserver")):
        return "temporary_provider"
    if any(marker in message for marker in ("temporarily unavailable", "connection reset", "try again")):
        return "temporary_provider"
    return None


def _structured_response_format(model: type[BaseModel]) -> dict[str, Any]:
    """The JSON schema sent for schema-constrained decoding.

    Every property is listed as required, at the root and in every nested definition, and
    nullable fields stay nullable. Constrained decoders omit fields a schema does not require:
    for GoalIntentProposal, whose fields all have defaults, Ollama returned no intent flags at
    all, so every proposal validated as "no intents". Extra keys are
    not forbidden here, because hosted providers differ on `additionalProperties`; validation
    already drops them.
    """
    schema = model.model_json_schema()
    for node in (schema, *schema.get("$defs", {}).values()):
        if isinstance(node, dict) and isinstance(node.get("properties"), dict):
            node["required"] = list(node["properties"])
    return {
        "type": "json_schema",
        "json_schema": {
            "name": model.__name__,
            "schema": schema,
            "strict": True,
        },
    }


class LiteLLMBackend:
    def complete(
        self,
        route: ModelRoute,
        *,
        messages: list[dict[str, str]],
        response_format: dict[str, Any] | None,
        timeout_seconds: int,
    ) -> CompletionResult:
        try:
            import litellm
            from litellm import completion
        except ImportError as exc:  # pragma: no cover - optional runtime dependency failure
            raise RuntimeError("Install the worker package before using model providers") from exc
        # A failed call otherwise prints a help banner to stdout, which every CLI command reserves for its JSON summary:
        # with no model server reachable, 405 banners preceded the current-jobs summary and made it unparseable.
        litellm.suppress_debug_info = True
        response = completion(
            model=route.model,
            api_base=route.api_base,
            api_key=route.api_key,
            messages=messages,
            response_format=response_format,
            temperature=0,
            timeout=timeout_seconds,
            num_retries=0,
        )
        usage = getattr(response, "usage", None)
        hidden = getattr(response, "_hidden_params", {}) or {}
        return CompletionResult(
            content=response.choices[0].message.content or "",
            provider=route.provider,
            model=route.model,
            prompt_tokens=int(getattr(usage, "prompt_tokens", 0) or 0),
            completion_tokens=int(getattr(usage, "completion_tokens", 0) or 0),
            estimated_cost_usd=float(hidden.get("response_cost", 0) or 0),
        )


class ModelRouter:
    def __init__(
        self,
        routes: dict[Capability, list[ModelRoute]],
        *,
        backend: ModelBackend | None = None,
        tracker: ModelAttemptTracker | None = None,
        timeout_seconds: int = 30,
    ) -> None:
        self.routes = routes
        self.backend = backend or LiteLLMBackend()
        self.tracker = tracker
        self.timeout_seconds = timeout_seconds

    @classmethod
    def from_settings(
        cls,
        settings: Settings | None = None,
        *,
        tracker: ModelAttemptTracker | None = None,
        backend: ModelBackend | None = None,
    ) -> ModelRouter:
        configured = settings or get_settings()
        capabilities: tuple[Capability, ...] = ("extract", "classify", "normalize", "reason")
        routes = {
            capability: [
                ModelRoute.from_model(model, configured) for model in configured.routes_for(capability)
            ]
            for capability in capabilities
        }
        return cls(
            routes,
            backend=backend,
            tracker=tracker,
            timeout_seconds=configured.llm_timeout_seconds,
        )

    def client(
        self,
        capability: Capability,
        *,
        agent_run_id: UUID | None = None,
        tool_call_id: UUID | None = None,
    ) -> CapabilityClient:
        return CapabilityClient(
            self,
            capability,
            agent_run_id=agent_run_id,
            tool_call_id=tool_call_id,
        )

    def complete(
        self,
        capability: Capability,
        *,
        messages: list[dict[str, str]],
        response_format: dict[str, Any] | None = None,
        response_model: type[BaseModel] | None = None,
        agent_run_id: UUID | None = None,
        tool_call_id: UUID | None = None,
    ) -> CompletionResult:
        completion, _ = self._run(
            capability,
            messages=messages,
            response_format=_structured_response_format(response_model)
            if response_model
            else response_format,
            response_model=response_model,
            agent_run_id=agent_run_id,
            tool_call_id=tool_call_id,
        )
        return completion

    def _run(
        self,
        capability: Capability,
        *,
        messages: list[dict[str, str]],
        response_format: dict[str, Any] | None,
        response_model: type[BaseModel] | None,
        agent_run_id: UUID | None,
        tool_call_id: UUID | None,
    ) -> tuple[CompletionResult, list[ModelAttempt]]:
        configured_routes = self.routes.get(capability, [])
        if not configured_routes:
            # No route for this capability is a routing refusal, not a programming error. Model use is
            # opt-in and every caller already falls back to its deterministic answer on ModelRoutingError;
            # raising ValueError instead made an unconfigured deployment look like a partial failure
            # (`classify-roles --all`: 21 failures, status "partial", with LLM_MODEL empty).
            raise ModelRoutingError(capability, [])
        attempts: list[ModelAttempt] = []
        blocked_providers: set[ProviderName] = set()
        fallback_reason: str | None = None
        for route in configured_routes:
            if route.provider in blocked_providers:
                continue
            started = monotonic()
            try:
                result = self.backend.complete(
                    route,
                    messages=messages,
                    response_format=response_format,
                    timeout_seconds=self.timeout_seconds,
                )
                latency_ms = max(0, round((monotonic() - started) * 1_000))
                if response_model:
                    try:
                        validated = response_model.model_validate_json(result.content)
                    except (ValidationError, ValueError) as exc:
                        structured_kind: FailureKind = "invalid_structured_output"
                        reason = f"{structured_kind}: {type(exc).__name__}"
                        attempt = self._attempt(
                            route,
                            capability,
                            latency_ms,
                            result,
                            success=False,
                            failure_kind=structured_kind,
                            fallback_reason=reason,
                            agent_run_id=agent_run_id,
                            tool_call_id=tool_call_id,
                        )
                        self._track(attempt)
                        attempts.append(attempt)
                        fallback_reason = reason
                        continue
                    result = replace(result, content=validated.model_dump_json())
                result = replace(
                    result,
                    capability=capability,
                    latency_ms=latency_ms,
                    fallback_reason=fallback_reason,
                )
                attempt = self._attempt(
                    route,
                    capability,
                    latency_ms,
                    result,
                    success=True,
                    failure_kind=None,
                    fallback_reason=fallback_reason,
                    agent_run_id=agent_run_id,
                    tool_call_id=tool_call_id,
                )
                self._track(attempt)
                attempts.append(attempt)
                return result, attempts
            except Exception as exc:
                kind = _failure_kind(exc)
                if kind is None:
                    latency_ms = max(0, round((monotonic() - started) * 1_000))
                    attempt = ModelAttempt(
                        provider=route.provider,
                        model=route.model,
                        capability=capability,
                        latency_ms=latency_ms,
                        success=False,
                        failure_kind="permanent_provider",
                        fallback_reason=f"permanent_provider: {type(exc).__name__}",
                        agent_run_id=agent_run_id,
                        tool_call_id=tool_call_id,
                    )
                    self._track(attempt)
                    attempts.append(attempt)
                    raise
                latency_ms = max(0, round((monotonic() - started) * 1_000))
                reason = f"{kind}: {type(exc).__name__}"
                attempt = ModelAttempt(
                    provider=route.provider,
                    model=route.model,
                    capability=capability,
                    latency_ms=latency_ms,
                    success=False,
                    failure_kind=kind,
                    fallback_reason=reason,
                    agent_run_id=agent_run_id,
                    tool_call_id=tool_call_id,
                )
                self._track(attempt)
                attempts.append(attempt)
                fallback_reason = reason
                if kind in {"rate_limit", "quota_exhausted"}:
                    blocked_providers.add(route.provider)
        raise ModelRoutingError(capability, attempts)

    @staticmethod
    def _attempt(
        route: ModelRoute,
        capability: Capability,
        latency_ms: int,
        result: CompletionResult,
        *,
        success: bool,
        failure_kind: FailureKind | None,
        fallback_reason: str | None,
        agent_run_id: UUID | None,
        tool_call_id: UUID | None,
    ) -> ModelAttempt:
        return ModelAttempt(
            provider=route.provider,
            model=route.model,
            capability=capability,
            latency_ms=latency_ms,
            prompt_tokens=result.prompt_tokens,
            completion_tokens=result.completion_tokens,
            estimated_cost_usd=result.estimated_cost_usd,
            success=success,
            failure_kind=failure_kind,
            fallback_reason=fallback_reason,
            agent_run_id=agent_run_id,
            tool_call_id=tool_call_id,
        )

    def _track(self, attempt: ModelAttempt) -> None:
        if self.tracker:
            self.tracker.record_model_attempt(attempt)


class CapabilityClient:
    def __init__(
        self,
        router: ModelRouter,
        capability: Capability,
        *,
        agent_run_id: UUID | None = None,
        tool_call_id: UUID | None = None,
    ) -> None:
        self.router = router
        self.capability = capability
        self.agent_run_id = agent_run_id
        self.tool_call_id = tool_call_id

    def complete(
        self,
        *,
        messages: list[dict[str, str]],
        response_format: dict[str, Any] | None = None,
        response_model: type[BaseModel] | None = None,
    ) -> CompletionResult:
        return self.router.complete(
            self.capability,
            messages=messages,
            response_format=response_format,
            response_model=response_model,
            agent_run_id=self.agent_run_id,
            tool_call_id=self.tool_call_id,
        )


class FakeProvider:
    """Deterministic scripted backend for routing and validation tests."""

    def __init__(self, scripts: dict[tuple[str, str], list[CompletionResult | Exception]]) -> None:
        self.scripts = {key: list(values) for key, values in scripts.items()}
        self.calls: list[tuple[str, str]] = []

    def complete(
        self,
        route: ModelRoute,
        *,
        messages: list[dict[str, str]],
        response_format: dict[str, Any] | None,
        timeout_seconds: int,
    ) -> CompletionResult:
        del messages, response_format, timeout_seconds
        key = (route.provider, route.model)
        self.calls.append(key)
        values = self.scripts.get(key, [])
        if not values:
            raise AssertionError(f"No scripted fake response for {key}")
        value = values.pop(0)
        if isinstance(value, Exception):
            raise value
        return value
