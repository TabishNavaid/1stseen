from __future__ import annotations

import asyncio
import json
import unittest
from collections.abc import Iterator
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from firstseen.agent import (
    ArchiveInspection,
    CareerPageInspection,
    CompanyEntity,
    CurrentJob,
    EvidenceRef,
    ForecastEvidenceFact,
    ForecastResult,
    RecruitingAgent,
    RecruitingAgentState,
    RecruitingSignalFact,
    RecruitingTools,
    RoleEntity,
    RoleHistoryItem,
    redact_goal,
)
from firstseen.agent_api import RecruitingAgentApi
from firstseen.agent_questions import (
    CompanyTimingItem,
    ConfidenceExplanationItem,
    ConfidenceFactorItem,
    ForecastChangeItem,
    ForecastChangeTrigger,
    PreparationItem,
    RoleForecastItem,
    UsefulQuestionResult,
    UsefulQuestionTools,
    _confidence_factor,
)
from firstseen.config import Settings

COMPANY_ID = UUID("00000000-0000-4000-8000-000000000001")
ROLE_ID = UUID("00000000-0000-4000-8000-000000000011")
FORECAST_ID = UUID("00000000-0000-4000-8000-000000000501")
RUN_ID = UUID("00000000-0000-4000-8000-000000000901")
USER_ID = UUID("00000000-0000-4000-8000-000000000001")
NOW = datetime(2026, 8, 14, 10, tzinfo=UTC)
ROOT = Path(__file__).resolve().parents[2]


def evidence(index: int, kind: str, summary: str) -> EvidenceRef:
    return EvidenceRef(
        id=f"00000000-0000-4000-8000-{index:012d}",
        kind=kind,
        source_url="https://careers.northstar.example/students",
        observed_at=NOW,
        content_hash=f"{index:x}"[-1] * 64,
        summary=summary,
        reliability=0.95,
    )


class SeededKnowledgeStore:
    def __init__(self, *, history_count: int = 4) -> None:
        self.history_count = history_count
        self.calls: list[str] = []

    def find_companies(self, goal: str) -> list[CompanyEntity]:
        self.calls.append("discover_company")
        if "northstar" not in goal.casefold():
            return []
        return [
            CompanyEntity(
                id=COMPANY_ID,
                name="Northstar Systems",
                domain="northstar.example",
                careers_url="https://careers.northstar.example/students",
                company_size="enterprise",
                recruiting_scale=0.75,
            )
        ]

    def find_roles(self, company_id: UUID, goal: str) -> list[RoleEntity]:
        self.calls.append("resolve_role")
        del company_id, goal
        return [
            RoleEntity(
                id=ROLE_ID,
                company_id=COMPANY_ID,
                title="Software Engineering Intern",
                track="internship",
                role_family="software_engineering",
                recurrence_key="software_engineering_intern_us",
                role_competitiveness=0.9,
                portfolio_required=True,
            )
        ]

    def current_jobs(self, company_id: UUID, role_id: UUID | None) -> list[CurrentJob]:
        self.calls.append("get_current_jobs")
        del company_id, role_id
        return []

    def inspect_career_page(self, company_id: UUID) -> CareerPageInspection | None:
        self.calls.append("inspect_career_page")
        del company_id
        return None

    def role_history(self, role_id: UUID) -> list[RoleHistoryItem]:
        self.calls.append("get_role_history")
        del role_id
        dates = [(2022, 9, 12), (2023, 9, 8), (2024, 9, 19), (2025, 9, 11)]
        return [
            RoleHistoryItem(
                event_id=UUID(f"00000000-0000-4000-8000-{301 + index:012d}"),
                opened_on=date(year, month, day),
                window_start=date(year, month, day),
                window_end=date(year, month, day),
                precision="exact",
                uncertainty_days=0,
                evidence=evidence(
                    301 + index, "history", f"Applications opened {year}-{month:02d}-{day:02d}."
                ),
            )
            for index, (year, month, day) in enumerate(dates[: self.history_count])
        ]

    def archives(self, company_id: UUID, role_id: UUID | None) -> list[ArchiveInspection]:
        self.calls.append("inspect_archives")
        del company_id, role_id
        return [
            ArchiveInspection(
                capture_id=UUID("00000000-0000-4000-8000-000000000711"),
                captured_at=datetime(2022, 9, 12, 14, tzinfo=UTC),
                completeness=0.9,
                is_partial=False,
                evidence=evidence(711, "archive", "Archived internship page capture."),
            )
        ]

    def signals(self, company_id: UUID, role_id: UUID | None) -> list[RecruitingSignalFact]:
        self.calls.append("get_recruiting_signals")
        del company_id, role_id
        return [
            RecruitingSignalFact(
                signal_id=UUID("00000000-0000-4000-8000-000000000401"),
                signal_type="program_page_change",
                observed_at=datetime(2026, 8, 11, 14, tzinfo=UTC),
                strength=0.7,
                reliability=0.8,
                evidence=evidence(401, "signal", "Student program page changed."),
            )
        ]

    def generate_forecast(self, role_id: UUID, as_of: date) -> ForecastResult:
        self.calls.append("generate_forecast")
        return ForecastResult(
            forecast_id=FORECAST_ID,
            role_id=role_id,
            as_of=as_of,
            expected_opening_date=date(2026, 9, 13),
            interval_start=date(2026, 9, 4),
            interval_end=date(2026, 9, 22),
            confidence=70.8,
            calibrated_probability=0.708,
            model_version="hierarchical-circular-shrinkage-v1",
            history_count=4,
            cached=True,
        )

    def forecast_evidence(self, forecast_id: UUID) -> list[ForecastEvidenceFact]:
        self.calls.append("get_forecast_evidence")
        return [
            ForecastEvidenceFact(
                forecast_id=forecast_id,
                contribution="role_history",
                weight=0.2,
                rationale=f"Source-backed contribution {index}.",
                evidence=evidence(501 + index, "forecast", f"Forecast evidence {index}."),
            )
            for index in range(5)
        ]


class AuditStore:
    def __init__(self) -> None:
        self.tool_calls: list[str] = []
        self.states: list[RecruitingAgentState] = []
        self.status: str | None = None

    def start_agent_run(self, **kwargs: object) -> UUID:
        self.start_payload = kwargs
        return RUN_ID

    def record_tool_call(self, run_id: UUID, **kwargs: Any) -> UUID:
        del run_id
        self.tool_calls.append(str(kwargs["tool_name"]))
        self.last_tool_payload = kwargs
        return UUID(f"00000000-0000-4000-8000-{len(self.tool_calls):012d}")

    def save_recruiting_agent_state(self, run_id: UUID, state: RecruitingAgentState) -> None:
        del run_id
        self.states.append(state.model_copy(deep=True))

    def finish_agent_run(self, run_id: UUID, *, status: str, error: dict[str, Any] | None = None) -> None:
        del run_id, error
        self.status = status


def agent(store: SeededKnowledgeStore, audit: AuditStore) -> RecruitingAgent:
    return RecruitingAgent(RecruitingTools(store), audit, today=date(2026, 8, 14))


class UsefulQuestionStore:
    def __init__(self) -> None:
        self.calls: list[str] = []

    def upcoming_openings(self, as_of: date, horizon_days: int) -> UsefulQuestionResult:
        self.calls.append("upcoming_openings")
        return UsefulQuestionResult(
            question_class="upcoming_openings",
            as_of=as_of,
            summary=f"1 internship forecast overlaps the next {horizon_days} days.",
            items=[
                RoleForecastItem(
                    company_id=COMPANY_ID,
                    company="Northstar Systems",
                    role_id=ROLE_ID,
                    role="Software Engineering Intern",
                    track="internship",
                    forecast_id=FORECAST_ID,
                    expected_opening_date=date(2026, 9, 13),
                    interval_start=date(2026, 9, 4),
                    interval_end=date(2026, 9, 22),
                    confidence=70.8,
                    as_of=as_of,
                    model_version="hierarchical-circular-shrinkage-v1",
                )
            ],
        )

    def preparation_priorities(self, as_of: date, horizon_days: int, user_id: UUID) -> UsefulQuestionResult:
        self.calls.append("preparation_priorities")
        del horizon_days, user_id
        return self._preparation("prepare_now", "resume", date(2026, 8, 20), as_of)

    def forecast_change(self, role_id: UUID, as_of: date) -> UsefulQuestionResult:
        self.calls.append("forecast_change")
        return UsefulQuestionResult(
            question_class="forecast_change",
            as_of=as_of,
            summary="The forecast changed after one persisted program-page signal.",
            items=[
                ForecastChangeItem(
                    role_id=role_id,
                    role="Software Engineering Intern",
                    company="Northstar Systems",
                    before_forecast_id=UUID("00000000-0000-4000-8000-000000000500"),
                    after_forecast_id=FORECAST_ID,
                    expected_date_before=date(2026, 9, 15),
                    expected_date_after=date(2026, 9, 13),
                    confidence_before=68.0,
                    confidence_after=70.8,
                    confidence_delta=2.8,
                    point_date_delta_days=-2,
                    interval_start_delta_days=-1,
                    interval_end_delta_days=-2,
                    trigger_signal_ids=(UUID("00000000-0000-4000-8000-000000000401"),),
                    trigger_signals=(
                        ForecastChangeTrigger(
                            signal_id=UUID("00000000-0000-4000-8000-000000000401"),
                            signal_type="program_page_change",
                            observed_at=date(2026, 8, 11),
                            strength=0.7,
                            reliability=0.8,
                            evidence_snippet="Student programs page changed.",
                        ),
                    ),
                    reasons=("confidence_threshold_crossed",),
                )
            ],
        )

    def confidence_explanation(self, role_id: UUID, as_of: date) -> UsefulQuestionResult:
        self.calls.append("confidence_explanation")
        return UsefulQuestionResult(
            question_class="confidence_explanation",
            as_of=as_of,
            summary="The forecast's confidence score 54 of 100 is held back most by role history and evidence recency.",
            items=[
                ConfidenceExplanationItem(
                    role_id=role_id,
                    role="Software Engineering Intern",
                    company="Northstar Systems",
                    forecast_id=FORECAST_ID,
                    confidence=54.0,
                    history_count=2,
                    interval_width_days=35,
                    factors=(
                        ConfidenceFactorItem(
                            name="role_history_strength",
                            value=0.42,
                            effect="limits",
                            explanation="Only two sourced role cycles are available.",
                        ),
                        ConfidenceFactorItem(
                            name="evidence_recency",
                            value=0.48,
                            effect="limits",
                            explanation="The latest cycle is not recent.",
                        ),
                    ),
                    model_version="hierarchical-circular-shrinkage-v1",
                )
            ],
        )

    def watched_networking(self, as_of: date, user_id: UUID) -> UsefulQuestionResult:
        self.calls.append("watched_networking")
        del user_id
        return self._preparation("watched_networking", "networking", date(2026, 8, 22), as_of)

    def earliest_companies(self, as_of: date) -> UsefulQuestionResult:
        self.calls.append("earliest_companies")
        return UsefulQuestionResult(
            question_class="earliest_companies",
            as_of=as_of,
            summary="Ranked 1 company with at least two sourced cycles.",
            items=[
                CompanyTimingItem(
                    company_id=COMPANY_ID,
                    company="Northstar Systems",
                    typical_opening_month=9,
                    typical_opening_day=12,
                    historical_cycle_count=4,
                    earliest_observed_date=date(2022, 9, 12),
                )
            ],
        )

    def referral_ready(self, as_of: date, horizon_days: int, user_id: UUID) -> UsefulQuestionResult:
        self.calls.append("referral_ready")
        del horizon_days, user_id
        return self._preparation("referral_ready", "referral", date(2026, 8, 28), as_of)

    @staticmethod
    def _preparation(question_class: str, action: str, due_on: date, as_of: date) -> UsefulQuestionResult:
        return UsefulQuestionResult(
            question_class=question_class,
            as_of=as_of,
            summary="1 watched role has a preparation deadline soon.",
            items=[
                PreparationItem(
                    company="Northstar Systems",
                    role_id=ROLE_ID,
                    role="Software Engineering Intern",
                    action=action,
                    due_on=due_on,
                    forecast_id=FORECAST_ID,
                    reason="Fixed lead time before the prediction interval.",
                )
            ],
        )


def useful_agent(
    knowledge: SeededKnowledgeStore, portfolio: UsefulQuestionStore, audit: AuditStore
) -> RecruitingAgent:
    return RecruitingAgent(
        RecruitingTools(knowledge),
        audit,
        today=date(2026, 8, 14),
        useful_tools=UsefulQuestionTools(portfolio),
    )


class RecruitingAgentTests(unittest.TestCase):
    def test_persisted_goal_redaction_removes_contact_identifiers(self) -> None:
        redacted = redact_goal("Email me at student@example.com or call +1 (212) 555-0199 about Northstar.")
        self.assertNotIn("student@example.com", redacted)
        self.assertNotIn("555-0199", redacted)
        self.assertIn("[email]", redacted)
        self.assertIn("[phone]", redacted)

    def test_seeded_forecast_and_readiness_question_runs_end_to_end(self) -> None:
        seed = (ROOT / "supabase/seed.sql").read_text()
        self.assertIn(str(COMPANY_ID), seed)
        self.assertIn(str(ROLE_ID), seed)
        self.assertIn(str(FORECAST_ID), seed)
        store = SeededKnowledgeStore()
        audit = AuditStore()

        events = list(
            agent(store, audit).stream(
                "When will Northstar Systems SWE internship open, and when should I prepare my resume and referral?"
            )
        )

        completed = events[-1]
        state = completed.data["state"]
        self.assertEqual(completed.type, "answer_completed")
        self.assertEqual(completed.data["tool_count"], 7)
        self.assertEqual(completed.data["evidence_count"], 10)
        self.assertGreaterEqual(completed.data["source_count"], 1)
        self.assertGreaterEqual(completed.data["duration_ms"], 0)
        self.assertTrue(completed.data["forecast_generated"])
        self.assertIsNone(completed.data["model_provider"])
        self.assertIn("September 13, 2026", completed.data["answer"])
        self.assertIn("confidence score 71 of 100", completed.data["answer"])
        self.assertIn("prediction interval, expected", completed.data["answer"])
        self.assertNotRegex(completed.data["answer"], r"\d%\s*confidence|confidence[^.]{0,20}\d%")
        # Confidence is never presented as calibrated.
        self.assertNotIn("calibrated confidence", completed.data["answer"])
        self.assertIsNone(audit.start_payload["initiated_by"])
        self.assertEqual(state["forecast"]["confidence"], 70.8)
        self.assertEqual(len(state["readiness_plan"]["milestones"]), 5)
        self.assertEqual(state["readiness_plan"]["policy_version"], "readiness-workback-v1")
        self.assertEqual(
            {item["kind"] for item in state["readiness_plan"]["milestones"]},
            {"networking", "referral_contacts", "resume_ready", "portfolio_ready", "high_alert"},
        )
        self.assertTrue(all(item["adjustments"] for item in state["readiness_plan"]["milestones"]))
        self.assertEqual(audit.status, "succeeded")
        self.assertEqual(len(audit.tool_calls), 7)
        self.assertNotIn("get_current_jobs", store.calls)
        self.assertNotIn("inspect_career_page", store.calls)
        self.assertNotIn("inspect_archives", store.calls)
        self.assertTrue(any(event.message == "Checked 4 recorded openings across 4 recruiting cycles." for event in events))
        forecast_event = next(
            event for event in events if event.type == "tool_completed" and event.tool == "generate_forecast"
        )
        self.assertEqual(forecast_event.data["execution_kind"], "statistical_model")
        self.assertEqual(forecast_event.data["forecast"]["confidence"], 70.8)
        self.assertIn("duration_ms", forecast_event.data)
        serialized = " ".join(event.model_dump_json() for event in events)
        self.assertNotIn("chain_of_thought", serialized)
        self.assertNotIn("reasoning", serialized.casefold())

    def test_sparse_history_causes_archive_escalation(self) -> None:
        store = SeededKnowledgeStore(history_count=1)
        audit = AuditStore()

        result = agent(store, audit).run("When will Northstar Systems SWE internship open?")

        self.assertIn("inspect_archives", store.calls)
        self.assertIsNotNone(result.forecast)

    def test_history_only_goal_avoids_forecast_and_signal_tools(self) -> None:
        store = SeededKnowledgeStore()
        audit = AuditStore()

        result = agent(store, audit).run("Show the historical cycles for Northstar Systems SWE internship")

        self.assertEqual(store.calls, ["discover_company", "resolve_role", "get_role_history"])
        self.assertIsNone(result.forecast)


class UsefulQuestionIntegrationTests(unittest.TestCase):
    def test_confidence_factor_direction_handles_contradiction_as_inverse(self) -> None:
        self.assertEqual(_confidence_factor("signal_contradiction", 0).effect, "supports")
        self.assertEqual(_confidence_factor("signal_contradiction", 0.8).effect, "limits")
        self.assertEqual(_confidence_factor("role_history_strength", 0.4).effect, "limits")

    def test_global_question_classes_return_structured_and_human_answers(self) -> None:
        cases = (
            (
                "What internships are likely to open in the next 30 days?",
                "upcoming_openings",
                "upcoming_openings",
                None,
            ),
            (
                "What should I be preparing for right now?",
                "prepare_now",
                "preparation_priorities",
                USER_ID,
            ),
            (
                "Which watched roles should I start networking for this month?",
                "watched_networking",
                "watched_networking",
                USER_ID,
            ),
            (
                "What companies historically recruit earliest?",
                "earliest_companies",
                "earliest_companies",
                None,
            ),
            (
                "Show me roles where I should have a referral ready soon.",
                "referral_ready",
                "referral_ready",
                USER_ID,
            ),
        )
        for question, question_class, expected_call, user_id in cases:
            with self.subTest(question=question):
                knowledge = SeededKnowledgeStore()
                portfolio = UsefulQuestionStore()
                audit = AuditStore()

                state = useful_agent(knowledge, portfolio, audit).run(question, user_id=user_id)

                self.assertIsNotNone(state.structured_result)
                self.assertEqual(state.structured_result.question_class, question_class)
                self.assertTrue(state.structured_result.items)
                self.assertTrue(state.final_answer)
                self.assertIn(expected_call, portfolio.calls)
                self.assertEqual(knowledge.calls, [])
                self.assertEqual(audit.tool_calls, ["recruiting_agent.answer_portfolio_question"])

    def test_role_explanation_questions_resolve_role_then_query_lineage(self) -> None:
        cases = (
            (
                "Why did the Northstar Systems SWE intern forecast change?",
                "forecast_change",
                "forecast_change",
                "confidence +2.8 points",
            ),
            (
                "Why is your confidence for Northstar Systems SWE intern only 54%?",
                "confidence_explanation",
                "confidence_explanation",
                "confidence score 54 of 100",
            ),
        )
        for question, question_class, expected_call, answer_fragment in cases:
            with self.subTest(question=question):
                knowledge = SeededKnowledgeStore()
                portfolio = UsefulQuestionStore()
                audit = AuditStore()

                state = useful_agent(knowledge, portfolio, audit).run(question)

                self.assertEqual(state.structured_result.question_class, question_class)
                self.assertEqual(knowledge.calls, ["discover_company", "resolve_role"])
                self.assertEqual(portfolio.calls, [expected_call])
                self.assertIn(answer_fragment, state.final_answer)
                self.assertNotIn("generate_forecast", knowledge.calls)

    def test_watchlist_question_without_user_returns_explicit_limitation(self) -> None:
        state = useful_agent(SeededKnowledgeStore(), UsefulQuestionStore(), AuditStore()).run(
            "Which watched roles should I start networking for this month?"
        )

        self.assertFalse(state.structured_result.items)
        self.assertIn("signed-in watchlist", state.final_answer)
        self.assertIn("No user identity", state.unresolved_questions[0])

    def test_a_guest_forecast_question_gets_the_forecast_but_never_a_readiness_plan(self) -> None:
        store = SeededKnowledgeStore()
        audit = AuditStore()

        state = agent(store, audit).run(
            "When will Northstar Systems SWE internship open, and when should I prepare my resume and referral?",
            audience="guest",
        )

        self.assertEqual(state.audience, "guest")
        self.assertIsNotNone(state.forecast)
        self.assertIsNone(state.readiness_plan)
        self.assertNotIn("create_readiness_plan", audit.tool_calls)
        self.assertIsNone(audit.start_payload["initiated_by"])
        self.assertIn("preparation plan needs an account", state.final_answer)
        self.assertNotIn("Work-back plan", state.final_answer)
        self.assertEqual(audit.states[-1].audience, "guest")

    def test_a_member_run_records_who_started_it(self) -> None:
        audit = AuditStore()
        user_id = UUID("00000000-0000-4000-8000-00000000abcd")

        agent(SeededKnowledgeStore(), audit).run("When will Northstar Systems SWE internship open?", user_id=user_id)

        self.assertEqual(audit.start_payload["initiated_by"], user_id)

    def test_a_guest_question_cannot_carry_a_user_identity(self) -> None:
        audit = AuditStore()

        with self.assertRaises(ValueError):
            agent(SeededKnowledgeStore(), audit).run(
                "When will Northstar Systems SWE internship open?",
                user_id=UUID("00000000-0000-4000-8000-00000000abcd"),
                audience="guest",
            )

        self.assertFalse(hasattr(audit, "start_payload"))

    def test_a_guest_watchlist_question_is_refused_like_any_unscoped_one(self) -> None:
        state = useful_agent(SeededKnowledgeStore(), UsefulQuestionStore(), AuditStore()).run(
            "Which watched roles should I start networking for this month?", audience="guest"
        )

        self.assertFalse(state.structured_result.items)
        self.assertIn("signed-in watchlist", state.final_answer)


async def invoke_api(api: RecruitingAgentApi, payload: bytes, token: str) -> list[dict[str, Any]]:
    requests: Iterator[dict[str, Any]] = iter([{"type": "http.request", "body": payload, "more_body": False}])
    responses: list[dict[str, Any]] = []

    async def receive() -> dict[str, Any]:
        return next(requests)

    async def send(message: dict[str, Any]) -> None:
        responses.append(message)

    await api(
        {
            "type": "http",
            "method": "POST",
            "path": "/v1/recruiting/query",
            "headers": [(b"authorization", f"Bearer {token}".encode())],
        },
        receive,
        send,
    )
    return responses


class RecruitingAgentApiTests(unittest.TestCase):
    def test_api_uses_explicit_selected_role_context_for_this_role_question(self) -> None:
        knowledge = SeededKnowledgeStore()
        portfolio = UsefulQuestionStore()
        audit = AuditStore()
        subject = RecruitingAgentApi(
            lambda: useful_agent(knowledge, portfolio, audit),
            settings=Settings(_env_file=None, AGENT_API_BEARER_TOKEN="fixture-token"),
        )
        responses = asyncio.run(
            invoke_api(
                subject,
                json.dumps(
                    {
                        "question": "Why is confidence for this role only 54%?",
                        "context_company": "Northstar Systems",
                        "context_role": "Software Engineering Intern",
                    }
                ).encode(),
                "fixture-token",
            )
        )

        body = b"".join(item.get("body", b"") for item in responses[1:]).decode()
        self.assertIn("confidence score 54 of 100", body)
        self.assertNotIn("% confidence", body)
        self.assertEqual(portfolio.calls, ["confidence_explanation"])

    def test_api_streams_safe_observable_progress(self) -> None:
        store = SeededKnowledgeStore()
        audit = AuditStore()
        subject = RecruitingAgentApi(
            lambda: agent(store, audit),
            settings=Settings(_env_file=None, AGENT_API_BEARER_TOKEN="fixture-token"),
        )
        responses = asyncio.run(
            invoke_api(
                subject,
                json.dumps({"question": "When will Northstar Systems SWE internship open?"}).encode(),
                "fixture-token",
            )
        )

        self.assertEqual(responses[0]["status"], 200)
        body = b"".join(item.get("body", b"") for item in responses[1:]).decode()
        self.assertIn("event: tool_completed", body)
        self.assertIn("event: answer_completed", body)
        self.assertNotIn("chain_of_thought", body)
        self.assertNotIn("private_reasoning", body)

    def test_api_rejects_invalid_auth_before_running_agent(self) -> None:
        audit = AuditStore()
        subject = RecruitingAgentApi(
            lambda: agent(SeededKnowledgeStore(), audit),
            settings=Settings(_env_file=None, AGENT_API_BEARER_TOKEN="fixture-token"),
        )

        responses = asyncio.run(
            invoke_api(subject, b'{"question":"When does Northstar open?"}', "wrong-token")
        )

        self.assertEqual(responses[0]["status"], 401)
        self.assertFalse(hasattr(audit, "start_payload"))

    def test_api_answers_a_guest_without_a_readiness_plan(self) -> None:
        store = SeededKnowledgeStore()
        audit = AuditStore()
        subject = RecruitingAgentApi(
            lambda: agent(store, audit),
            settings=Settings(_env_file=None, AGENT_API_BEARER_TOKEN="fixture-token"),
        )
        question = "When will Northstar Systems SWE internship open, and when should I prepare my resume?"

        responses = asyncio.run(
            invoke_api(subject, json.dumps({"question": question, "audience": "guest"}).encode(), "fixture-token")
        )

        self.assertEqual(responses[0]["status"], 200)
        body = b"".join(item.get("body", b"") for item in responses[1:]).decode()
        self.assertIn("event: answer_completed", body)
        self.assertNotIn("create_readiness_plan", audit.tool_calls)
        self.assertIsNone(audit.start_payload["initiated_by"])

    def test_api_refuses_a_guest_question_that_names_a_user(self) -> None:
        audit = AuditStore()
        subject = RecruitingAgentApi(
            lambda: agent(SeededKnowledgeStore(), audit),
            settings=Settings(_env_file=None, AGENT_API_BEARER_TOKEN="fixture-token"),
        )
        payload = {
            "question": "When does Northstar open?",
            "audience": "guest",
            "user_id": "00000000-0000-4000-8000-00000000abcd",
        }

        responses = asyncio.run(invoke_api(subject, json.dumps(payload).encode(), "fixture-token"))

        self.assertEqual(responses[0]["status"], 400)
        self.assertFalse(hasattr(audit, "start_payload"))


if __name__ == "__main__":
    unittest.main()


class LongArchiveKnowledgeStore(SeededKnowledgeStore):
    """An archive capture whose stored page text is far longer than an evidence summary allows."""

    def archives(self, company_id: UUID, role_id: UUID | None) -> list[ArchiveInspection]:
        captures = super().archives(company_id, role_id)
        long_text = "Databricks University archived page " + "word " * 1_200
        return [capture.model_copy(update={"evidence": evidence(712, "archive", long_text)}) for capture in captures]


class EvidenceSummaryBoundTests(unittest.TestCase):
    def test_an_over_long_summary_is_bounded_instead_of_rejected(self) -> None:
        bounded = evidence(713, "archive", "x" * 5_000)

        self.assertLessEqual(len(bounded.summary), 1_000)
        self.assertTrue(bounded.summary.endswith("…"))

    def test_a_long_archive_capture_no_longer_ends_the_agent_run(self) -> None:
        # inspect_archives once raised a validation error on a long Databricks archive capture and
        # the whole run failed. Sparse history escalates to archives, so this reaches that tool.
        store = LongArchiveKnowledgeStore(history_count=1)
        audit = AuditStore()

        result = agent(store, audit).run("When will Northstar Systems SWE internship open?")

        self.assertIn("inspect_archives", store.calls)
        self.assertIsNotNone(result.forecast)
        archive = next(item for item in result.evidence if item.kind == "archive")
        self.assertLessEqual(len(archive.summary), 1_000)


class InsufficientForecastStore(SeededKnowledgeStore):
    def generate_forecast(self, role_id: UUID, as_of: date) -> ForecastResult:
        from firstseen.forecasting import InsufficientEvidenceError

        self.calls.append("generate_forecast")
        raise InsufficientEvidenceError("Sparse role history requires a sourced company or role-family seasonal prior")


class InsufficientEvidenceAgentTests(unittest.TestCase):
    def test_a_role_without_enough_history_gets_an_honest_answer_not_a_failed_run(self) -> None:
        store = InsufficientForecastStore()
        audit = AuditStore()

        events = list(agent(store, audit).stream("When will Northstar Systems SWE internship open?"))

        completed = [event for event in events if event.type == "answer_completed"]
        self.assertEqual(len(completed), 1)
        self.assertEqual(store.calls.count("generate_forecast"), 1)
        state = completed[0].data["state"]
        self.assertIsNone(state["forecast"])
        self.assertTrue(any("not enough recorded history" in item.lower() for item in state["unresolved_questions"]))



class ResolvedRoleWithoutQuestionTests(unittest.TestCase):
    def test_a_role_with_nothing_asked_of_it_gets_guidance_not_a_bare_heading(self) -> None:
        store = SeededKnowledgeStore()

        events = list(agent(store, AuditStore()).stream("Tell me about the Northstar Systems software engineering intern."))

        completed = [event for event in events if event.type == "answer_completed"]
        self.assertEqual(len(completed), 1)
        answer = completed[0].data["answer"]
        self.assertFalse(answer.rstrip().endswith(":"), answer)
        self.assertIn("did not ask for anything I can answer from stored evidence", answer)



class SplitRoleStore(SeededKnowledgeStore):
    def find_roles(self, company_id: UUID, goal: str) -> list[RoleEntity]:
        self.calls.append("resolve_role")
        del company_id, goal
        return [
            RoleEntity(
                id=UUID(f"00000000-0000-4000-8000-00000000002{index}"),
                company_id=COMPANY_ID,
                title="Business Development Representative",
                track="other",
                role_family="sales",
                recurrence_key=f"bdr_{place}",
                location_scope=place,
            )
            for index, place in enumerate(("toronto", "dubai"))
        ]


class SharedTitleStore(SeededKnowledgeStore):
    """Two programs at one company with the same title, as 61 of the rig's 341 in-scope roles are."""

    def find_roles(self, company_id: UUID, goal: str, role_id: UUID | None = None) -> list[RoleEntity]:
        base = super().find_roles(company_id, goal)[0]
        roles = [
            base.model_copy(update={"id": UUID(f"00000000-0000-4000-8000-00000000006{index}"), "specialization": label})
            for index, label in enumerate(("infrastructure", None))
        ]
        return [role for role in roles if role.id == role_id] if role_id else roles


class SharedTitleTests(unittest.TestCase):
    def test_a_shared_title_is_ambiguous_without_the_role_page_id(self) -> None:
        store = SharedTitleStore()

        state = agent(store, AuditStore()).run("When will Northstar Systems Software Engineering Intern open?")

        self.assertEqual(len(state.role_candidates), 2)
        self.assertNotIn("generate_forecast", store.calls)

    def test_the_role_page_id_resolves_the_one_program_and_forecasts_it(self) -> None:
        store = SharedTitleStore()
        selected = UUID("00000000-0000-4000-8000-000000000061")

        state = agent(store, AuditStore()).run(
            "When will Northstar Systems Software Engineering Intern open?", role_id=selected, audience="guest"
        )

        role = state.resolved_entities["role"]
        self.assertIsInstance(role, RoleEntity)
        self.assertEqual(role.id, selected)
        self.assertIn("generate_forecast", store.calls)
        self.assertIsNotNone(state.forecast)
        self.assertIsNone(state.readiness_plan)


class AmbiguousRoleAnswerTests(unittest.TestCase):
    def test_an_ambiguous_question_names_the_candidates_and_their_splits(self) -> None:
        store = SplitRoleStore()

        events = list(agent(store, AuditStore()).stream("When will Northstar Systems hire business development representatives?"))

        completed = [event for event in events if event.type == "answer_completed"]
        self.assertEqual(len(completed), 1)
        answer = completed[0].data["answer"]
        self.assertIn("matches 2 of its recurring programs", answer)
        self.assertIn("Business Development Representative (toronto)", answer)
        self.assertIn("Business Development Representative (dubai)", answer)
        self.assertNotIn("generate_forecast", store.calls)
        self.assertEqual(len(completed[0].data["state"]["role_candidates"]), 2)

    def test_a_split_label_is_shown_only_where_it_separates_a_shared_title(self) -> None:
        candidates = [
            RoleEntity(
                id=UUID(f"00000000-0000-4000-8000-00000000004{index}"),
                company_id=COMPANY_ID,
                title=title,
                track="internship",
                role_family="product_management",
                recurrence_key=f"candidate_{index}",
                specialization=specialization,
            )
            for index, (title, specialization) in enumerate(
                [("Product Management Intern", "infrastructure"), ("Research Scientist Intern", "security")]
            )
        ]
        company = SeededKnowledgeStore().find_companies("northstar")[0]

        answer = RecruitingAgent._candidate_answer(company, candidates)

        self.assertIn("Product Management Intern; Research Scientist Intern.", answer)
        self.assertNotIn("infrastructure", answer)



class OutOfScopeRoleStore(SeededKnowledgeStore):
    def find_roles(self, company_id: UUID, goal: str) -> list[RoleEntity]:
        self.calls.append("resolve_role")
        del company_id, goal
        return [
            RoleEntity(
                id=UUID("00000000-0000-4000-8000-000000000031"),
                company_id=COMPANY_ID,
                title="Director Americas Field Marketing",
                track="other",
                role_family="other",
                recurrence_key="director_americas_field_marketing",
                in_product_scope=False,
            )
        ]


class OutOfScopeAnswerTests(unittest.TestCase):
    def test_a_role_outside_scope_is_named_and_never_forecast(self) -> None:
        store = OutOfScopeRoleStore()

        events = list(
            agent(store, AuditStore()).stream("When will Northstar Systems open the Director Americas Field Marketing role?")
        )

        completed = [event for event in events if event.type == "answer_completed"]
        self.assertEqual(len(completed), 1)
        state = completed[0].data["state"]
        self.assertIn("outside 1stSeen's scope", completed[0].data["answer"])
        self.assertNotIn("generate_forecast", store.calls)
        self.assertIsNone(state["forecast"])
        self.assertEqual([role["title"] for role in state["out_of_scope_roles"]], ["Director Americas Field Marketing"])
