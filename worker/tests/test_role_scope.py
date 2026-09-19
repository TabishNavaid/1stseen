"""Product scope: early-career technical roles, decided from titles, then ATS categories, then seniority.

The labeled cases live in fixtures/role_resolution_cases.json under "scope". The model tests use a
scripted completion client that returns fixed text; no provider is called.
"""

from __future__ import annotations

import json
import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from firstseen.adapters.base import JobCandidate, SourceConfig, build_observation
from firstseen.inference import DeterministicFirstInferencePolicy
from firstseen.models import AtsCategories, JobObservation
from firstseen.providers import CompletionResult, ModelRoutingError
from firstseen.role_resolution import CanonicalRoleIdentity, RoleResolver
from firstseen.scope import (
    LlmScopeClassifier,
    RoleScopeClassification,
    RoleScopeClassifier,
    RoleScopeInput,
    RoleScopeService,
    ScopeEvidence,
    StoredRoleScope,
    TitleEvidence,
    _fold,
    classify_role_scope,
)
from firstseen.security import UNTRUSTED_EVIDENCE_SYSTEM_PROMPT

FIXTURES = Path(__file__).with_name("fixtures")
COMPANY_ID = UUID("00000000-0000-4000-8000-000000000001")
SOURCE_ID = UUID("00000000-0000-4000-8000-000000000101")
SEEN = datetime(2026, 9, 14, tzinfo=UTC)


def scope_cases() -> list[dict[str, Any]]:
    return list(json.loads((FIXTURES / "role_resolution_cases.json").read_text())["scope"])


def role_input(case: dict[str, Any]) -> RoleScopeInput:
    """A labeled case as classifier input. Cases recorded by `firstseen review-scope` keep ATS evidence per title."""
    return RoleScopeInput(
        titles=tuple(case["titles"]),
        categories=tuple(AtsCategories(**item) for item in case.get("categories", [])),
        employment_types=tuple(case.get("employment_types", [])),
        title_evidence=tuple(
            TitleEvidence(
                title=item["title"],
                categories=tuple(AtsCategories(**category) for category in item.get("categories", [])),
                employment_types=tuple(item.get("employment_types", [])),
            )
            for item in case.get("title_evidence", [])
        ),
    )


def case_source_text(case: dict[str, Any]) -> str:
    per_title = case.get("title_evidence", [])
    return " ".join(
        [
            *case["titles"],
            *(str(value) for item in case.get("categories", []) for value in item.values()),
            *case.get("employment_types", []),
            *(str(value) for item in per_title for category in item.get("categories", []) for value in category.values()),
            *(value for item in per_title for value in item.get("employment_types", [])),
        ]
    )


class ScopeFixtureTests(unittest.TestCase):
    def test_every_labeled_case(self) -> None:
        cases = scope_cases()
        failures = []
        for case in cases:
            result = classify_role_scope(role_input(case))
            actual = {
                "status": result.status,
                "reason": result.reason,
                "discipline": result.discipline,
                "early_career_type": result.early_career_type,
            }
            if actual != case["expected"]:
                reviewed = case.get("review")
                learn = (
                    f" (a reviewer decided it from the {reviewed['basis']} on {reviewed['decided_on']}; teach a rule)"
                    if reviewed
                    else ""
                )
                failures.append(f"{case['id']}: expected {case['expected']}, got {actual}{learn}")
        self.assertGreaterEqual(len(cases), 60)
        self.assertEqual(failures, [], "\n".join(failures))

    def test_decisions_cite_the_evidence_they_rest_on(self) -> None:
        for case in scope_cases():
            result = classify_role_scope(role_input(case))
            kinds = {item.kind for item in result.evidence}
            with self.subTest(case=case["id"]):
                if result.status == "in_scope":
                    self.assertIn("early_career", kinds)
                    self.assertEqual(result.evidence[0].kind, "early_career")
                    self.assertTrue(any(item.kind == "discipline" and item.rule for item in result.evidence))
                elif result.reason != "not_early_career":
                    self.assertTrue(result.evidence, "every exclusion except absence names what it matched")
                source_text = _fold(case_source_text(case))
                for item in result.evidence:
                    self.assertIn(f" {item.matched} ", source_text, "evidence quotes the folded source text")

    def test_titles_decide_before_ats_categories(self) -> None:
        # A software title in a sales department is software; the department only speaks when the
        # title says nothing about the discipline.
        filed_under_sales = RoleScopeInput(
            titles=("Software Engineer Intern",), categories=(AtsCategories(department="Sales"),)
        )
        result = classify_role_scope(filed_under_sales)
        self.assertEqual((result.status, result.discipline), ("in_scope", "software_engineering"))
        self.assertTrue(all(item.tier == "title" for item in result.evidence))

    def test_ats_evidence_stays_with_the_title_that_carried_it(self) -> None:
        # Neuralink: "Software Engineer Intern, Robotics" and "Software Engineer, Robotics" were merged into
        # one role. Pooled, the intern posting's employment type made both aliases internships.
        merged = RoleScopeInput(
            titles=("Software Engineer Intern, Robotics", "Software Engineer, Robotics"),
            title_evidence=(
                TitleEvidence(title="Software Engineer Intern, Robotics", employment_types=("Intern",)),
                TitleEvidence(title="Software Engineer, Robotics", employment_types=("Full-time",)),
            ),
        )
        self.assertEqual((classify_role_scope(merged).status, classify_role_scope(merged).reason), ("ambiguous", "alias_conflict"))

        own = RoleScopeInput(
            titles=("Software Developer",),
            title_evidence=(TitleEvidence(title="Software Developer", categories=(AtsCategories(experience_level="internship"),)),),
        )
        self.assertEqual(
            (classify_role_scope(own).status, classify_role_scope(own).early_career_type), ("in_scope", "internship")
        )

    def test_a_senior_ats_level_conflicts_with_an_internship_title(self) -> None:
        result = classify_role_scope(
            RoleScopeInput(titles=("Software Engineer Intern",), categories=(AtsCategories(experience_level="mid_senior_level"),))
        )
        self.assertEqual((result.status, result.reason), ("ambiguous", "seniority_conflict"))


def posting(case_id: str, title: str, *, company: str, location: str | None, description: str) -> JobObservation:
    source = SourceConfig(
        id=SOURCE_ID,
        company_id=COMPANY_ID,
        company=company,
        adapter="greenhouse",
        url="https://boards.example.test",
        trust_score=0.9,
        options={},
    )
    observed = build_observation(
        source,
        JobCandidate(
            source_url=f"https://boards.example.test/jobs/{case_id}",
            apply_url=f"https://boards.example.test/jobs/{case_id}/apply",
            raw_title=title,
            company=company,
            location=location,
            external_job_id=case_id,
            evidence_excerpt=description,
        ),
        observed_at=SEEN,
        extraction_route="structured_endpoint",
    )
    return observed.model_copy(update={"id": uuid5(NAMESPACE_URL, f"posting:{case_id}")})


def resolve_in_order(postings: list[JobObservation]) -> list[CanonicalRoleIdentity]:
    resolver = RoleResolver()
    roles: dict[UUID, CanonicalRoleIdentity] = {}
    for item in postings:
        resolution = resolver.resolve(company_id=COMPANY_ID, observation=item, candidates=list(roles.values()))
        roles[resolution.canonical_role.id] = resolution.canonical_role
    return list(roles.values())


class DeliberateSplitTests(unittest.TestCase):
    def test_location_splits_stay_separate_roles_and_classify_alike(self) -> None:
        roles = resolve_in_order(
            [
                posting(
                    f"bdr-{place}",
                    "Business Development Representative",
                    company="Cohere",
                    location=place,
                    description="Build pipeline for enterprise security customers.",
                )
                for place in ("Dubai", "Germany", "Korea", "Toronto")
            ]
        )

        self.assertEqual(sorted(role.features.location_scope for role in roles), ["dubai", "germany", "korea", "toronto"])
        results = {classify_role_scope(RoleScopeInput(titles=tuple(role.aliases))).reason for role in roles}
        self.assertEqual(results, {"not_early_career"})

    def test_specialization_splits_stay_separate_roles_and_classify_alike(self) -> None:
        # Each posting creates its own identity, as on the rig; the specialization is part of the
        # identity signature, and classification must neither merge nor relabel the two.
        roles = [
            RoleResolver().resolve(company_id=COMPANY_ID, observation=item, candidates=[]).canonical_role
            for item in [
                posting(
                    "figma-winter",
                    "Software Engineer Intern (Winter 2027)",
                    company="Figma",
                    location=None,
                    description="Winter internship building product features in the editor.",
                ),
                posting(
                    "figma-winter-infrastructure",
                    "Software Engineer Intern (Winter 2027)",
                    company="Figma",
                    location=None,
                    description="Winter internship on infrastructure and distributed systems.",
                ),
            ]
        ]

        self.assertEqual(sorted(str(role.features.specialization) for role in roles), ["None", "infrastructure"])
        self.assertEqual(len({role.id for role in roles}), 2)
        for role in roles:
            result = classify_role_scope(RoleScopeInput(titles=(role.canonical_title, *role.aliases)))
            self.assertEqual(
                (result.status, result.discipline, result.early_career_type),
                ("in_scope", "software_engineering", "internship"),
            )


class ScriptedCompletionClient:
    """Returns fixed text in place of a model; records how often it was asked."""

    def __init__(self, content: str | Exception) -> None:
        self.content = content
        self.calls = 0
        self.messages: list[dict[str, str]] = []

    def complete(self, *, messages: list[dict[str, str]], response_format: Any = None, response_model: Any = None) -> CompletionResult:
        del response_format, response_model
        self.calls += 1
        self.messages = messages
        if isinstance(self.content, Exception):
            raise self.content
        return CompletionResult(content=self.content, provider="scripted", model="scripted-scope")


RESEARCH_INTERN = RoleScopeInput(
    titles=("Research Intern (Winter 2026)",),
    description_excerpt="You will train large language models for retrieval and evaluate them.",
)


class ScopeModelGateTests(unittest.TestCase):
    def test_the_policy_escalates_only_an_unknown_discipline(self) -> None:
        decide = DeterministicFirstInferencePolicy.decide_scope_classification
        self.assertEqual(decide(status="in_scope", reason="in_scope", llm_enabled=True).action, "not_required")
        boundary = decide(status="ambiguous", reason="design_or_advocacy_boundary", llm_enabled=True)
        self.assertEqual((boundary.action, boundary.reason), ("not_required", "not_discipline_ambiguity"))
        self.assertEqual(decide(status="ambiguous", reason="discipline_unknown", llm_enabled=False).action, "suppressed")
        escalated = decide(status="ambiguous", reason="discipline_unknown", llm_enabled=True)
        self.assertEqual((escalated.action, escalated.llm_escalated), ("escalated", True))

    def test_decided_roles_and_conflicts_never_reach_a_model(self) -> None:
        client = ScriptedCompletionClient(AssertionError("the model must not be consulted"))
        classifier = RoleScopeClassifier(LlmScopeClassifier(client))
        for title in ("Software Engineer Intern", "Brand Designer Intern", "Senior Software Engineer", "Software Engineer - New Grad & Intern"):
            classifier.classify(RoleScopeInput(titles=(title,)))
        self.assertEqual(client.calls, 0)

    def test_a_quoted_listed_discipline_is_a_suggestion_that_leaves_the_role_for_review(self) -> None:
        client = ScriptedCompletionClient(json.dumps({"discipline": "machine_learning", "quote": "train large language models"}))

        result, decision = RoleScopeClassifier(LlmScopeClassifier(client)).classify(RESEARCH_INTERN)

        self.assertEqual(decision.action, "escalated")
        self.assertEqual((result.status, result.reason, result.discipline, result.early_career_type), ("ambiguous", "discipline_unknown", None, "internship"))
        self.assertEqual(result.evidence[-1].rule, "machine_learning")
        self.assertEqual(result.method, "model_assisted")
        self.assertEqual((result.evidence[-1].tier, result.evidence[-1].matched), ("model", "train large language models"))
        self.assertIn(UNTRUSTED_EVIDENCE_SYSTEM_PROMPT, client.messages[0]["content"])
        self.assertIn("evidence", json.loads(client.messages[1]["content"]))

    def test_anything_short_of_a_verbatim_quote_leaves_the_role_ambiguous(self) -> None:
        for content in (
            json.dumps({"discipline": "machine_learning", "quote": "builds recommendation systems"}),
            json.dumps({"discipline": "abstain", "quote": ""}),
            json.dumps({"discipline": "marketing", "quote": "Research Intern"}),
            "not json",
            ModelRoutingError("classify", []),
        ):
            with self.subTest(content=str(content)[:40]):
                result, _ = RoleScopeClassifier(LlmScopeClassifier(ScriptedCompletionClient(content))).classify(RESEARCH_INTERN)
                self.assertEqual((result.status, result.reason, result.method), ("ambiguous", "discipline_unknown", "deterministic"))

    def test_without_a_model_the_bucket_stays_reviewable(self) -> None:
        result, decision = RoleScopeClassifier().classify(RESEARCH_INTERN)
        self.assertEqual((result.status, decision.action, decision.reason), ("ambiguous", "suppressed", "model_not_configured"))


class MemoryScopeStore:
    def __init__(self, roles: list[StoredRoleScope], *, excerpts: dict[UUID, str] | None = None, fail_saves: bool = False) -> None:
        self.roles = roles
        self.saved: dict[UUID, RoleScopeClassification] = {}
        self.excerpts = excerpts or {}
        self.fail_saves = fail_saves
        self.saves = 0

    def list_role_scope_inputs(self, company_id: UUID | None = None) -> list[StoredRoleScope]:
        del company_id
        return [role.model_copy(update={"current": self.saved.get(role.role_id, role.current)}) for role in self.roles]

    def role_description_excerpt(self, role_id: UUID) -> str:
        return self.excerpts.get(role_id, "")

    def save_role_scope(self, role_id: UUID, classification: RoleScopeClassification) -> None:
        if self.fail_saves:
            raise RuntimeError("write refused")
        self.saves += 1
        self.saved[role_id] = classification


def stored(title: str) -> StoredRoleScope:
    return StoredRoleScope(role_id=uuid5(NAMESPACE_URL, f"role:{title}"), role=RoleScopeInput(titles=(title,)))


class RoleScopeServiceTests(unittest.TestCase):
    def test_a_rerun_writes_nothing_and_the_summary_counts_each_bucket(self) -> None:
        store = MemoryScopeStore([stored("Software Engineer Intern"), stored("Senior Software Engineer"), stored("Research Intern")])
        service = RoleScopeService(store)

        first = service.classify()
        second = service.classify()

        self.assertEqual((first.roles, first.written, first.unchanged), (3, 3, 0))
        self.assertEqual((second.written, second.unchanged, store.saves), (0, 3, 3))
        self.assertEqual(dict(first.by_status), {"in_scope": 1, "out_of_scope": 1, "ambiguous": 1})
        self.assertEqual(first.as_dict()["in_scope_by_discipline"], {"software_engineering": 1})

    def test_a_verified_model_answer_is_not_requested_again(self) -> None:
        role = stored("Research Intern (Winter 2026)")
        store = MemoryScopeStore([role], excerpts={role.role_id: RESEARCH_INTERN.description_excerpt})
        answering = ScriptedCompletionClient(json.dumps({"discipline": "machine_learning", "quote": "train large language models"}))

        first = RoleScopeService(store, RoleScopeClassifier(LlmScopeClassifier(answering))).classify()
        refusing = ScriptedCompletionClient(AssertionError("an unchanged verified answer must not be re-asked"))
        second = RoleScopeService(store, RoleScopeClassifier(LlmScopeClassifier(refusing))).classify()

        self.assertEqual((first.model_escalations, first.model_assisted, first.written), (1, 1, 1))
        self.assertEqual((second.model_escalations, second.unchanged, refusing.calls), (0, 1, 0))
        self.assertEqual((store.saved[role.role_id].method, store.saved[role.role_id].status), ("model_assisted", "ambiguous"))

    def test_a_model_decision_stored_before_suggestions_is_replaced_by_a_suggestion(self) -> None:
        role = stored("Research Intern (Winter 2026)")
        deterministic = classify_role_scope(role.role)
        decided = deterministic.model_copy(
            update={
                "status": "in_scope",
                "reason": "in_scope",
                "discipline": "machine_learning",
                "method": "model_assisted",
                "evidence": [*deterministic.evidence, ScopeEvidence(tier="model", kind="discipline", rule="machine_learning", matched="Research Intern", field="model_quote")],
            }
        )
        store = MemoryScopeStore([role.model_copy(update={"current": decided})])
        answering = ScriptedCompletionClient(json.dumps({"discipline": "machine_learning", "quote": "Research Intern"}))

        summary = RoleScopeService(store, RoleScopeClassifier(LlmScopeClassifier(answering))).classify()

        self.assertEqual((summary.written, answering.calls), (1, 1))
        self.assertEqual((store.saved[role.role_id].status, store.saved[role.role_id].discipline), ("ambiguous", None))

    def test_a_failed_write_is_counted_not_raised(self) -> None:
        summary = RoleScopeService(MemoryScopeStore([stored("Software Engineer Intern")], fail_saves=True)).classify()
        self.assertEqual((summary.roles, summary.failures, summary.written), (1, 1, 0))


if __name__ == "__main__":
    unittest.main()
