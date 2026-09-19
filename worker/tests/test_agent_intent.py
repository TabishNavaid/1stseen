"""Model-assisted intent understanding must widen tools without owning any value."""

from __future__ import annotations

import unittest
from datetime import date
from typing import Any
from uuid import UUID

from test_agent import AuditStore, SeededKnowledgeStore

from firstseen.agent import GoalIntent, RecruitingAgent, RecruitingTools
from firstseen.agent_intent import GoalIntentProposal, LlmGoalIntentInterpreter
from firstseen.agent_questions import UsefulQuestionIntent
from firstseen.providers import CompletionResult, ModelRoutingError


class ScriptedClient:
    """Stands in for a `CapabilityClient` without touching a provider."""

    def __init__(self, result: CompletionResult | Exception) -> None:
        self.result = result
        self.calls = 0

    def complete(self, **kwargs: Any) -> CompletionResult:
        del kwargs
        self.calls += 1
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def interpreter(payload: str, *, provider: str = "gemini") -> LlmGoalIntentInterpreter:
    client = ScriptedClient(CompletionResult(content=payload, provider=provider, model="test-model"))
    subject = LlmGoalIntentInterpreter(client)  # type: ignore[arg-type]
    subject.client = client  # type: ignore[assignment]
    return subject


class GoalIntentWideningTests(unittest.TestCase):
    def test_proposal_may_only_enable_intents(self) -> None:
        deterministic = GoalIntent(
            current=True, history=True, archives=False, forecast=True,
            readiness=False, signals=True, page=True,
        )
        widened = deterministic.widened_by(
            GoalIntentProposal(
                wants_forecast=False,
                wants_current_postings=False,
                wants_history=False,
                wants_archives=True,
                wants_readiness=True,
            )
        )

        # Every deterministic true survives; only the new intents were added.
        self.assertTrue(widened.current)
        self.assertTrue(widened.history)
        self.assertTrue(widened.forecast)
        self.assertTrue(widened.signals)
        self.assertTrue(widened.page)
        self.assertTrue(widened.archives)
        self.assertTrue(widened.readiness)

    def test_inconclusive_detects_a_question_the_keyword_rules_missed(self) -> None:
        self.assertTrue(GoalIntent.parse("Tell me about Northstar Systems").is_inconclusive)
        self.assertFalse(GoalIntent.parse("When does Northstar open?").is_inconclusive)

    def test_interpreter_returns_none_when_every_route_fails(self) -> None:
        client = ScriptedClient(ModelRoutingError("classify", []))
        subject = LlmGoalIntentInterpreter(client)  # type: ignore[arg-type]

        self.assertIsNone(subject.interpret("Tell me about Northstar"))
        self.assertIsNone(subject.provider)

    def test_interpreter_rejects_output_outside_the_closed_vocabulary(self) -> None:
        subject = interpreter('{"portfolio_question": "delete_everything"}')

        self.assertIsNone(subject.interpret("Tell me about Northstar"))

    def test_question_class_requirements_come_from_the_table_not_the_caller(self) -> None:
        intent = UsefulQuestionIntent.from_choice("watched_networking", 900)

        assert intent is not None
        self.assertTrue(intent.requires_user)
        self.assertEqual(intent.horizon_days, 365)
        self.assertIsNone(UsefulQuestionIntent.from_choice("not_a_class", 30))


class AgentIntentIntegrationTests(unittest.TestCase):
    def test_deterministic_run_never_consults_a_model(self) -> None:
        store = SeededKnowledgeStore()
        audit = AuditStore()
        subject = interpreter('{"wants_forecast": true}')
        agent = RecruitingAgent(
            RecruitingTools(store),
            audit,
            today=date(2026, 8, 14),
            intent_interpreter=subject,
        )

        state = agent.run("When will Northstar Systems SWE internship open?")

        self.assertEqual(subject.client.calls, 0)  # type: ignore[attr-defined]
        self.assertIsNotNone(state.forecast)

    def test_an_unrecognised_question_is_widened_and_reports_the_provider(self) -> None:
        store = SeededKnowledgeStore()
        audit = AuditStore()
        subject = interpreter('{"wants_forecast": true, "wants_history": true}')
        agent = RecruitingAgent(
            RecruitingTools(store),
            audit,
            today=date(2026, 8, 14),
            intent_interpreter=subject,
        )

        events = list(agent.stream("Tell me about the Northstar Systems SWE internship"))

        self.assertEqual(subject.client.calls, 1)  # type: ignore[attr-defined]
        self.assertIn("get_role_history", store.calls)
        self.assertIn("generate_forecast", store.calls)
        completed = [event for event in events if event.type == "answer_completed"]
        self.assertEqual(completed[0].data["model_provider"], "gemini")

    def test_a_failed_interpretation_keeps_the_deterministic_answer(self) -> None:
        store = SeededKnowledgeStore()
        audit = AuditStore()
        client = ScriptedClient(ModelRoutingError("classify", []))
        agent = RecruitingAgent(
            RecruitingTools(store),
            audit,
            today=date(2026, 8, 14),
            intent_interpreter=LlmGoalIntentInterpreter(client),  # type: ignore[arg-type]
        )

        events = list(agent.stream("Tell me about the Northstar Systems SWE internship"))
        completed = [event for event in events if event.type == "answer_completed"]

        self.assertIsNone(completed[0].data["model_provider"])
        self.assertEqual(store.calls, ["discover_company", "resolve_role"])

    def test_a_model_cannot_introduce_a_forecast_value(self) -> None:
        store = SeededKnowledgeStore()
        audit = AuditStore()
        subject = interpreter(
            '{"wants_forecast": true, "expected_opening_date": "2027-01-01", "confidence": 99}'
        )
        agent = RecruitingAgent(
            RecruitingTools(store),
            audit,
            today=date(2026, 8, 14),
            intent_interpreter=subject,
        )

        state = agent.run("Tell me about the Northstar Systems SWE internship")

        assert state.forecast is not None
        # The extra keys are simply absent from the closed schema; the forecast
        # comes from the forecasting component alone.
        self.assertNotEqual(state.forecast.expected_opening_date, date(2027, 1, 1))
        self.assertLessEqual(state.forecast.confidence, 100)
        self.assertEqual(state.forecast.role_id, UUID(str(state.forecast.role_id)))


if __name__ == "__main__":
    unittest.main()


class InconclusiveIntentTests(unittest.TestCase):
    def test_a_page_only_question_is_not_inconclusive(self) -> None:
        # The agent inspects the career page for a page-only question, so the run does not stop
        # after identity and the model must not be consulted (evaluation question H11 once consulted it needlessly).
        intent = GoalIntent.parse("What does Ramp's careers page say about new grad programs?")

        self.assertTrue(intent.page)
        self.assertFalse(intent.is_inconclusive)
