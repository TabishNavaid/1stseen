from __future__ import annotations

import unittest
from uuid import UUID

from pydantic import BaseModel

from firstseen.config import Settings
from firstseen.providers import (
    CompletionResult,
    FakeProvider,
    ModelAttempt,
    ModelRoute,
    ModelRouter,
    ModelRoutingError,
    ProviderFailure,
)

RUN_ID = UUID("00000000-0000-4000-8000-000000000901")


class Answer(BaseModel):
    label: str
    score: int


class MemoryTracker:
    def __init__(self) -> None:
        self.attempts: list[ModelAttempt] = []

    def record_model_attempt(self, attempt: ModelAttempt) -> None:
        self.attempts.append(attempt)


def result(provider: str, model: str, content: str = "ok") -> CompletionResult:
    return CompletionResult(
        content=content,
        provider=provider,
        model=model,
        prompt_tokens=12,
        completion_tokens=4,
    )


class ModelRouterTests(unittest.TestCase):
    def router(
        self,
        scripts: dict[tuple[str, str], list[CompletionResult | Exception]],
        routes: list[ModelRoute] | None = None,
    ) -> tuple[ModelRouter, FakeProvider, MemoryTracker]:
        configured = routes or [
            ModelRoute(provider="gemini", model="gemini/primary"),
            ModelRoute(provider="groq", model="groq/fallback"),
            ModelRoute(provider="ollama", model="ollama/local"),
        ]
        backend = FakeProvider(scripts)
        tracker = MemoryTracker()
        router = ModelRouter(
            {capability: configured for capability in ("extract", "classify", "normalize", "reason")},
            backend=backend,
            tracker=tracker,
        )
        return router, backend, tracker

    def test_primary_429_falls_through_to_next_provider(self) -> None:
        router, backend, tracker = self.router(
            {
                ("gemini", "gemini/primary"): [
                    ProviderFailure("rate_limit", "429 rate limit", status_code=429)
                ],
                ("groq", "groq/fallback"): [result("groq", "groq/fallback")],
            }
        )

        completion = router.client("extract", agent_run_id=RUN_ID).complete(
            messages=[{"role": "user", "content": "extract"}]
        )

        self.assertEqual(completion.provider, "groq")
        self.assertEqual(
            backend.calls,
            [("gemini", "gemini/primary"), ("groq", "groq/fallback")],
        )
        self.assertEqual([attempt.success for attempt in tracker.attempts], [False, True])
        self.assertEqual(tracker.attempts[0].failure_kind, "rate_limit")
        self.assertEqual(tracker.attempts[1].agent_run_id, RUN_ID)
        self.assertIn("rate_limit", completion.fallback_reason or "")

    def test_quota_exhaustion_does_not_try_another_model_on_same_provider(self) -> None:
        routes = [
            ModelRoute(provider="gemini", model="gemini/primary"),
            ModelRoute(provider="gemini", model="gemini/secondary"),
            ModelRoute(provider="ollama", model="ollama/local"),
        ]
        router, backend, _ = self.router(
            {
                ("gemini", "gemini/primary"): [
                    ProviderFailure("quota_exhausted", "quota exhausted", status_code=429)
                ],
                ("ollama", "ollama/local"): [result("ollama", "ollama/local")],
            },
            routes,
        )

        completion = router.complete("reason", messages=[])

        self.assertEqual(completion.provider, "ollama")
        self.assertEqual(
            backend.calls,
            [("gemini", "gemini/primary"), ("ollama", "ollama/local")],
        )

    def test_timeout_and_temporary_errors_fall_through(self) -> None:
        router, _, tracker = self.router(
            {
                ("gemini", "gemini/primary"): [TimeoutError("timed out")],
                ("groq", "groq/fallback"): [
                    ProviderFailure("temporary_provider", "service unavailable", status_code=503)
                ],
                ("ollama", "ollama/local"): [result("ollama", "ollama/local")],
            }
        )

        completion = router.complete("classify", messages=[])

        self.assertEqual(completion.provider, "ollama")
        self.assertEqual(
            [attempt.failure_kind for attempt in tracker.attempts],
            ["timeout", "temporary_provider", None],
        )

    def test_invalid_structured_output_falls_through_and_is_validated(self) -> None:
        router, _, tracker = self.router(
            {
                ("gemini", "gemini/primary"): [result("gemini", "gemini/primary", '{"label":"intern"}')],
                ("groq", "groq/fallback"): [result("groq", "groq/fallback", '{"label":"intern","score":97}')],
            }
        )

        completion = router.client("normalize", agent_run_id=RUN_ID).complete(
            messages=[], response_model=Answer
        )

        self.assertEqual(Answer.model_validate_json(completion.content), Answer(label="intern", score=97))
        self.assertEqual(tracker.attempts[0].failure_kind, "invalid_structured_output")
        self.assertTrue(tracker.attempts[1].success)

    def test_unclassified_permanent_error_is_not_retried_or_hidden(self) -> None:
        router, backend, tracker = self.router(
            {
                ("gemini", "gemini/primary"): [RuntimeError("invalid API key")],
            }
        )

        with self.assertRaisesRegex(RuntimeError, "invalid API key"):
            router.complete("reason", messages=[])

        self.assertEqual(backend.calls, [("gemini", "gemini/primary")])
        self.assertEqual(len(tracker.attempts), 1)
        self.assertEqual(tracker.attempts[0].failure_kind, "permanent_provider")

    def test_capability_routes_are_independently_configurable(self) -> None:
        settings = Settings(
            _env_file=None,
            LLM_DEFAULT_ROUTES="ollama/default",
            LLM_EXTRACT_ROUTES="gemini/extractor, groq/extractor-backup",
            LLM_REASON_ROUTES="groq/reasoner",
        )

        self.assertEqual(
            settings.routes_for("extract"),
            ("gemini/extractor", "groq/extractor-backup"),
        )
        self.assertEqual(settings.routes_for("reason"), ("groq/reasoner",))
        self.assertEqual(settings.routes_for("classify"), ("ollama/default",))

    def test_a_capability_with_no_route_is_a_routing_refusal_not_a_programming_error(self) -> None:
        """Model use is opt-in, so an unconfigured capability must reach the callers' fallback.

        Every caller of a capability client already falls back to its deterministic answer on
        ModelRoutingError (scope.RoleScopeClassifier, role_resolution, discovery, agent_intent).
        Raising ValueError instead escaped those handlers: with LLM_MODEL empty on the rig,
        `classify-roles --all` reported 21 failures and status "partial" for 7,666 roles it had
        in fact classified deterministically.
        """
        router = ModelRouter({}, backend=FakeProvider({}), tracker=MemoryTracker())

        with self.assertRaises(ModelRoutingError) as caught:
            router.client("classify").complete(messages=[{"role": "user", "content": "classify"}])

        self.assertEqual(caught.exception.capability, "classify")
        # Nothing was attempted, so no model_usage row claims a provider was tried.
        self.assertEqual(caught.exception.attempts, ())

    def test_blank_api_keys_are_not_sent_as_empty_bearer_tokens(self) -> None:
        """`KEY=` in .env arrives as "", and an empty key makes litellm send `Bearer ` and fail."""
        from firstseen.providers import ModelRoute

        settings = Settings(_env_file=None, LLM_API_KEY="", GEMINI_API_KEY="", GROQ_API_KEY="")

        for model in ("ollama/qwen2.5:7b", "gemini/flash", "groq/llama"):
            with self.subTest(model=model):
                self.assertIsNone(ModelRoute.from_model(model, settings).api_key)
        keyed = Settings(_env_file=None, GROQ_API_KEY="present")
        self.assertEqual(ModelRoute.from_model("groq/llama", keyed).api_key, "present")


if __name__ == "__main__":
    unittest.main()


class _NestedProposal(BaseModel):
    wants: bool = False
    note: str | None = None


class _OuterProposal(BaseModel):
    inner: _NestedProposal
    tags: list[str] = []


class StructuredSchemaContractTests(unittest.TestCase):
    """Schema-constrained decoders omit fields a schema does not require.

    The intent evaluation found Ollama returning only `{"portfolio_question": "none", "horizon_days": 30}` for
    GoalIntentProposal, whose fields all have defaults, so every intent proposal validated as
    "no intents". Every property must be listed as required, at every level; nullable fields stay
    nullable. (Extra keys are not forbidden in the schema, because hosted providers differ on
    `additionalProperties`; validation already drops them.)
    """

    def test_every_property_is_required_at_every_level(self) -> None:
        from firstseen.providers import _structured_response_format

        schema = _structured_response_format(_OuterProposal)["json_schema"]["schema"]

        self.assertEqual(schema["required"], ["inner", "tags"])
        self.assertEqual(schema["$defs"]["_NestedProposal"]["required"], ["wants", "note"])

    def test_required_fields_still_accept_null_where_the_model_allows_it(self) -> None:
        payload = '{"inner": {"wants": false, "note": null}, "tags": []}'

        self.assertIsNone(_OuterProposal.model_validate_json(payload).inner.note)

    def test_the_intent_and_identity_schemas_no_longer_let_a_decoder_drop_fields(self) -> None:
        from firstseen.agent_intent import GoalIntentProposal
        from firstseen.discovery import _IdentityProposal
        from firstseen.providers import _structured_response_format

        for model in (GoalIntentProposal, _IdentityProposal):
            schema = _structured_response_format(model)["json_schema"]["schema"]
            self.assertEqual(schema["required"], list(schema["properties"]), model.__name__)
