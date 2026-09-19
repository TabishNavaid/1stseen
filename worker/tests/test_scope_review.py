"""A person's scope decision on an ambiguous role: stated evidence with provenance, kept on reclassification, and fed
back into the labeled cases (`firstseen review-scope`)."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from datetime import UTC, datetime
from io import StringIO
from pathlib import Path
from typing import Any
from unittest.mock import patch
from uuid import NAMESPACE_URL, UUID, uuid5

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from firstseen import cli
from firstseen.models import AtsCategories
from firstseen.scope import (
    RoleScopeClassification,
    RoleScopeInput,
    RoleScopeService,
    ScopeEvidence,
    StoredRoleScope,
    TitleEvidence,
    classify_role_scope,
    scope_input_fingerprint,
)
from firstseen.scope_review import (
    Posting,
    ScopeDecision,
    ScopeReviewError,
    ScopeReviewItem,
    ScopeReviewService,
    StoredScopeReview,
    printable,
    render_queue,
    render_review_item,
)

LISTED_AT = datetime(2026, 9, 16, 12, 0, tzinfo=UTC)
DECIDED_AT = datetime(2026, 9, 16, 13, 0, tzinfo=UTC)
SUGGESTION = ScopeEvidence(tier="model", kind="discipline", rule="software_engineering", matched="backend services", field="model_quote")


def item_for(role: RoleScopeInput, *, company: str = "Fixture Robotics", evidence: list[ScopeEvidence] | None = None) -> ScopeReviewItem:
    rules = classify_role_scope(role)
    current = rules.model_copy(update={"evidence": [*rules.evidence, *(evidence or [])]})
    return ScopeReviewItem(
        role_id=uuid5(NAMESPACE_URL, f"role:{'|'.join(role.titles)}"),
        company=company,
        canonical_title=role.titles[0],
        role=role,
        current=current,
        classified_at=LISTED_AT,
        postings=[Posting(url="https://jobs.example-ats.test/fixture/1", title=role.titles[0], excerpt="Build backend services.")],
    )


def decision(**overrides: Any) -> ScopeDecision:
    values: dict[str, Any] = {
        "status": "in_scope",
        "reason": "in_scope",
        "discipline": "software_engineering",
        "early_career_type": "internship",
        "basis": "posting",
        "note": "The posting is backend services work on the platform team.",
        "reviewer": "Fixture Reviewer",
    }
    return ScopeDecision(**{**values, **overrides})


class MemoryReviewStore:
    def __init__(self, items: list[ScopeReviewItem]) -> None:
        self.items = {item.role_id: item for item in items}
        self.records: list[dict[str, Any]] = []

    def list_scope_review_queue(self, company_ids: Any = None, reason: str | None = None) -> list[ScopeReviewItem]:
        del company_ids
        return [item for item in self.items.values() if item.current.status == "ambiguous" and reason in (None, item.current.reason)]

    def get_scope_review_item(self, role_id: UUID) -> ScopeReviewItem | None:
        return self.items.get(role_id)

    def record_role_scope_review(self, **record: Any) -> datetime:
        item: ScopeReviewItem = record["item"]
        if self.items[item.role_id].classified_at != item.classified_at:
            raise ScopeReviewError("role changed since it was listed")
        self.records.append(record)
        decided: ScopeDecision = record["decision"]
        self.items[item.role_id] = item.model_copy(
            update={
                "current": record["classification"],
                "classified_at": DECIDED_AT,
                "last_review": StoredScopeReview(
                    id=record["review_id"],
                    status=decided.status,
                    reason=decided.reason,
                    discipline=decided.discipline,
                    early_career_type=decided.early_career_type,
                    basis=decided.basis,
                    note=decided.note,
                    reviewer=decided.reviewer,
                    evidence_fingerprint=record["fingerprint"],
                    decided_at=DECIDED_AT,
                ),
            }
        )
        return DECIDED_AT


class FixtureFile:
    """A copy-shaped labeled-cases file in a temporary directory."""

    def __init__(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "role_resolution_cases.json"
        document = {
            "resolution": [],
            "scope": [
                {
                    "id": "hand_labeled_estagio",
                    "titles": ["Estágio em Engenharia de Software"],
                    "expected": {"status": "in_scope", "reason": "in_scope", "discipline": "software_engineering", "early_career_type": "internship"},
                }
            ],
        }
        self.path.write_text(json.dumps(document, indent=1, ensure_ascii=False) + "\n")

    def cases(self) -> list[dict[str, Any]]:
        return list(json.loads(self.path.read_text())["scope"])

    def close(self) -> None:
        self.directory.cleanup()


class ScopeDecisionTests(unittest.TestCase):
    def test_an_in_scope_decision_names_a_discipline_and_a_type(self) -> None:
        with self.assertRaises(ValueError):
            decision(discipline=None)
        with self.assertRaises(ValueError):
            decision(early_career_type=None)

    def test_an_out_of_scope_decision_gives_an_exclusion_reason_and_no_discipline(self) -> None:
        self.assertEqual(decision(status="out_of_scope", reason="non_technical_function", discipline=None).reason, "non_technical_function")
        with self.assertRaises(ValueError):
            decision(status="out_of_scope", reason="discipline_unknown", discipline=None)
        with self.assertRaises(ValueError):
            decision(status="out_of_scope", reason="senior_role")

    def test_a_decision_needs_a_reviewer_and_a_reason_in_words(self) -> None:
        with self.assertRaises(ValueError):
            decision(reviewer="   ")
        with self.assertRaises(ValueError):
            decision(note="  ok   ")
        self.assertEqual(decision(note="  Backend\n work  ").note, "Backend work")


class ScopeReviewServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixtures = FixtureFile()
        self.addCleanup(self.fixtures.close)

    def test_a_decision_is_stored_as_stated_evidence_with_what_the_reviewer_was_shown(self) -> None:
        item = item_for(RoleScopeInput(titles=("Summer Intern",)), evidence=[SUGGESTION])
        store = MemoryReviewStore([item])

        outcome = ScopeReviewService(store, self.fixtures.path).decide(item.role_id, decision())

        [record] = store.records
        classification: RoleScopeClassification = record["classification"]
        self.assertEqual((classification.status, classification.discipline, classification.method), ("in_scope", "software_engineering", "human_review"))
        statement = classification.evidence[0]
        self.assertEqual((statement.tier, statement.kind, statement.rule, statement.field), ("reviewer", "decision", str(record["review_id"]), "posting"))
        self.assertEqual(statement.matched, "The posting is backend services work on the platform team.")
        self.assertIn(SUGGESTION, classification.evidence, "the suggestion the reviewer saw stays beside the decision")
        self.assertEqual(record["fingerprint"], scope_input_fingerprint(item.role))
        shown = record["shown"]
        self.assertEqual(shown["classification"]["reason"], "discipline_unknown")
        self.assertEqual(shown["titles"][0]["title"], "Summer Intern")
        self.assertEqual(shown["postings"], ["https://jobs.example-ats.test/fixture/1"])
        self.assertEqual(outcome.decided_at, DECIDED_AT)

    def test_a_decision_from_the_posting_labels_the_titles_as_undecidable(self) -> None:
        item = item_for(RoleScopeInput(titles=("Summer Intern",)))
        outcome = ScopeReviewService(MemoryReviewStore([item]), self.fixtures.path).decide(item.role_id, decision())

        case = self.fixtures.cases()[-1]
        self.assertEqual(case["expected"], {"status": "ambiguous", "reason": "discipline_unknown", "discipline": None, "early_career_type": "internship"})
        self.assertEqual(case["review"]["decided"]["status"], "in_scope")
        self.assertEqual((case["review"]["basis"], case["review"]["reviewer"], case["review"]["decided_on"]), ("posting", "Fixture Reviewer", "2026-09-16"))
        self.assertIn("titles alone do not decide it", case["note"])
        self.assertTrue(outcome.rules_agree, "the rules already abstain, which is what the case asks of them")

    def test_a_decision_from_the_titles_is_a_labeled_case_the_rules_must_learn(self) -> None:
        role = RoleScopeInput(
            titles=("Scenario Engineer - New Grad (2027)",),
            title_evidence=(TitleEvidence(title="Scenario Engineer - New Grad (2027)", categories=(AtsCategories(department="Simulation"),), employment_types=("FullTime",)),),
        )
        item = item_for(role)
        outcome = ScopeReviewService(MemoryReviewStore([item]), self.fixtures.path).decide(
            item.role_id, decision(basis="titles", early_career_type="new_grad", note="Scenario engineers write simulation software.")
        )

        case = self.fixtures.cases()[-1]
        self.assertEqual(case["expected"], {"status": "in_scope", "reason": "in_scope", "discipline": "software_engineering", "early_career_type": "new_grad"})
        self.assertEqual(case["title_evidence"], [{"title": "Scenario Engineer - New Grad (2027)", "categories": [{"department": "Simulation"}], "employment_types": ["FullTime"]}])
        self.assertTrue(case["id"].startswith("review_fixture_robotics_scenario_engineer_new_grad_2027_"))
        self.assertFalse(outcome.rules_agree)
        self.assertEqual(outcome.rules_now["reason"], "discipline_unknown")

    def test_a_merge_cannot_be_decided_from_its_titles(self) -> None:
        item = item_for(RoleScopeInput(titles=("Research Intern - Reinforcement Learning", "Research Engineer - Reinforcement Learning")))
        self.assertEqual(item.current.reason, "alias_conflict")
        store = MemoryReviewStore([item])
        before = self.fixtures.path.read_text()

        with self.assertRaisesRegex(ScopeReviewError, "resolver merge"):
            ScopeReviewService(store, self.fixtures.path).decide(item.role_id, decision(basis="titles", discipline="machine_learning"))

        self.assertEqual(store.records, [])
        self.assertEqual(self.fixtures.path.read_text(), before)
        ScopeReviewService(store, self.fixtures.path).decide(item.role_id, decision(discipline="machine_learning"))
        self.assertEqual(self.fixtures.cases()[-1]["expected"]["reason"], "alias_conflict")

    def test_a_role_the_rules_decide_is_not_overridden_one_role_at_a_time(self) -> None:
        item = item_for(RoleScopeInput(titles=("Software Engineer Intern",)))
        store = MemoryReviewStore([item])
        with self.assertRaisesRegex(ScopeReviewError, "not awaiting review"):
            ScopeReviewService(store, self.fixtures.path).decide(item.role_id, decision(basis="titles"))
        self.assertEqual(store.records, [])

    def test_nothing_is_recorded_when_the_labeled_cases_cannot_be_written(self) -> None:
        item = item_for(RoleScopeInput(titles=("Summer Intern",)))
        store = MemoryReviewStore([item])
        with self.assertRaisesRegex(ScopeReviewError, "Nothing was recorded"):
            ScopeReviewService(store, self.fixtures.path.with_name("missing.json")).decide(item.role_id, decision())
        self.fixtures.path.write_text('{"resolution": []}\n')
        with self.assertRaisesRegex(ScopeReviewError, "Nothing was recorded"):
            ScopeReviewService(store, self.fixtures.path).decide(item.role_id, decision())
        self.assertEqual(store.records, [])

    def test_a_role_changed_since_listing_is_refused_and_labels_nothing(self) -> None:
        item = item_for(RoleScopeInput(titles=("Summer Intern",)))
        store = MemoryReviewStore([item.model_copy(update={"classified_at": DECIDED_AT})])
        stale = ScopeReviewService(store, self.fixtures.path)
        with patch.object(store, "get_scope_review_item", return_value=item), self.assertRaisesRegex(ScopeReviewError, "changed"):
            stale.decide(item.role_id, decision())
        self.assertEqual(len(self.fixtures.cases()), 1)

    def test_deciding_a_role_again_replaces_its_labeled_case_and_keeps_the_file_format(self) -> None:
        item = item_for(RoleScopeInput(titles=("Estágio de Verão",)))
        store = MemoryReviewStore([item])
        service = ScopeReviewService(store, self.fixtures.path)

        service.decide(item.role_id, decision())
        second = service.decide(
            item.role_id, decision(status="out_of_scope", reason="non_technical_function", discipline=None, note="Marketing operations, on a reread.")
        )

        reviewed = [case for case in self.fixtures.cases() if case.get("review", {}).get("role_id") == str(item.role_id)]
        self.assertEqual(len(reviewed), 1)
        self.assertEqual(store.records[-1]["decision"].early_career_type, "internship", "an exclusion keeps the program type the rules found")
        self.assertEqual(reviewed[0]["review"]["review_id"], str(second.review_id))
        self.assertEqual(reviewed[0]["review"]["decided"]["reason"], "non_technical_function")
        second_record = store.records[-1]["classification"]
        self.assertEqual([entry.tier for entry in second_record.evidence].count("reviewer"), 1, "an earlier statement is not stacked")
        text = self.fixtures.path.read_text()
        self.assertEqual(text, json.dumps(json.loads(text), indent=1, ensure_ascii=False) + "\n")
        self.assertIn("Estágio de Verão", text)
        self.assertEqual(self.fixtures.cases()[0]["id"], "hand_labeled_estagio", "hand-labeled cases are untouched")

    def test_the_queue_orders_merges_first_then_unknown_disciplines(self) -> None:
        unknown = item_for(RoleScopeInput(titles=("Summer Intern",)), company="Alpha")
        merge = item_for(RoleScopeInput(titles=("Research Intern - Robotics", "Research Engineer - Robotics")), company="Zulu")
        decided = item_for(RoleScopeInput(titles=("Software Engineer Intern",)))
        queue = ScopeReviewService(MemoryReviewStore([unknown, decided, merge])).queue()
        self.assertEqual([item.current.reason for item in queue], ["alias_conflict", "discipline_unknown"])


class ReclassificationTests(unittest.TestCase):
    class Store:
        def __init__(self, stored: StoredRoleScope) -> None:
            self.stored = stored
            self.saved: list[RoleScopeClassification] = []

        def list_role_scope_inputs(self, company_id: UUID | None = None) -> list[StoredRoleScope]:
            del company_id
            return [self.stored]

        def role_description_excerpt(self, role_id: UUID) -> str:
            return ""

        def save_role_scope(self, role_id: UUID, classification: RoleScopeClassification) -> None:
            self.saved.append(classification)
            self.stored = self.stored.model_copy(update={"current": classification})

    def reviewed(self, role: RoleScopeInput, fingerprint_of: RoleScopeInput) -> StoredRoleScope:
        human = RoleScopeClassification(
            status="in_scope",
            reason="in_scope",
            discipline="software_engineering",
            early_career_type="internship",
            evidence=[ScopeEvidence(tier="reviewer", kind="decision", rule=str(uuid5(NAMESPACE_URL, "review")), matched="Backend work.", field="posting")],
            method="human_review",
        )
        return StoredRoleScope(
            role_id=uuid5(NAMESPACE_URL, "role:summer-intern"), role=role, current=human, reviewed_fingerprint=scope_input_fingerprint(fingerprint_of)
        )

    def test_a_person_s_decision_survives_reclassification_while_the_evidence_is_unchanged(self) -> None:
        role = RoleScopeInput(titles=("Summer Intern",))
        store = self.Store(self.reviewed(role, role))

        summary = RoleScopeService(store).classify()

        self.assertEqual((summary.written, summary.unchanged, summary.human_reviewed), (0, 1, 1))
        self.assertEqual(summary.by_status["in_scope"], 1)

    def test_a_new_title_returns_the_role_to_the_rules(self) -> None:
        decided_on = RoleScopeInput(titles=("Summer Intern",))
        grown = RoleScopeInput(titles=("Summer Intern", "Summer Intern - Marketing"))
        store = self.Store(self.reviewed(grown, decided_on))

        summary = RoleScopeService(store).classify()

        self.assertEqual((summary.written, summary.human_reviewed), (1, 0))
        self.assertEqual((store.saved[0].method, store.saved[0].status), ("deterministic", "ambiguous"))

    def test_the_fingerprint_ignores_order_but_not_filing(self) -> None:
        first = TitleEvidence(title="Summer Intern", categories=(AtsCategories(department="Engineering"), AtsCategories(team="Platform")))
        second = TitleEvidence(title="Intern, Summer", employment_types=("Intern", "FullTime"))
        reordered = TitleEvidence(title="Intern, Summer", employment_types=("FullTime", "Intern"))
        swapped = TitleEvidence(title="Summer Intern", categories=(AtsCategories(team="Platform"), AtsCategories(department="Engineering")))
        fingerprint = scope_input_fingerprint(RoleScopeInput(titles=("Summer Intern", "Intern, Summer"), title_evidence=(first, second)))
        self.assertEqual(fingerprint, scope_input_fingerprint(RoleScopeInput(titles=("Intern, Summer", "Summer Intern"), title_evidence=(reordered, swapped))))
        refiled = TitleEvidence(title="Summer Intern", categories=(AtsCategories(department="Marketing"),))
        self.assertNotEqual(fingerprint, scope_input_fingerprint(RoleScopeInput(titles=("Summer Intern", "Intern, Summer"), title_evidence=(refiled, second))))
        self.assertRegex(fingerprint, "^[0-9a-f]{64}$")


class RenderingTests(unittest.TestCase):
    def test_scraped_text_cannot_write_terminal_control_sequences(self) -> None:
        hostile = "Intern\x1b[2J\x1b]8;;https://evil.test\x07 \u202eevil\u200b\r\nnext"
        rendered = printable(hostile)
        self.assertNotRegex(rendered, "[\x00-\x1f\x7f-\x9f\u202e\u200b]")
        self.assertEqual(printable("x" * 50, 10), "xxxxxxxxx…")
        item = item_for(RoleScopeInput(titles=(hostile,)), company="Evil\x1b[31m Corp")
        self.assertNotIn("\x1b", render_review_item(item, 1, 1))

    def test_a_merge_shows_how_each_title_classifies_alone_and_the_suggestion_is_labeled(self) -> None:
        merge = item_for(
            RoleScopeInput(titles=("Research Intern - Reinforcement Learning", "Research Engineer - Reinforcement Learning")),
            evidence=[SUGGESTION],
        )
        merge = merge.model_copy(
            update={
                "last_review": StoredScopeReview(
                    id=uuid5(NAMESPACE_URL, "earlier"), status="in_scope", reason="in_scope", discipline="machine_learning",
                    early_career_type="internship", basis="posting", note="RL research internship.", reviewer="Fixture Reviewer",
                    evidence_fingerprint="0" * 64, decided_at=DECIDED_AT,
                )
            }
        )
        text = render_review_item(merge, 1, 2)
        self.assertIn('"Research Intern - Reinforcement Learning" -> in_scope (in_scope) machine_learning / internship', text)
        self.assertIn('"Research Engineer - Reinforcement Learning" -> out_of_scope (not_early_career)', text)
        self.assertIn('model suggestion (not a decision): software_engineering, quoting "backend services"', text)
        self.assertIn("earlier decision: in_scope (in_scope) machine_learning / internship by Fixture Reviewer on 2026-09-16", text)
        self.assertIn("the titles or ATS filing changed since, so it is asked again", text)
        self.assertIn("posting: https://jobs.example-ats.test/fixture/1", text)
        self.assertIn(f"firstseen review-scope decide {merge.role_id}", text)

    def test_the_queue_header_counts_every_reason_and_says_what_was_cut(self) -> None:
        items = [item_for(RoleScopeInput(titles=(title,))) for title in ("Summer Intern", "Research Intern", "Winter Intern")]
        text = render_queue(items, 2)
        self.assertTrue(text.startswith("3 roles await scope review: discipline_unknown 3. Showing 2;"))
        self.assertIn("[2/2]", text)
        self.assertEqual(render_queue([], 20), "No roles await scope review.")


class CommandTests(unittest.TestCase):
    def run_decide(self, *arguments: str, environment: dict[str, str] | None = None) -> tuple[int, str]:
        argv = ["firstseen", "review-scope", "decide", str(uuid5(NAMESPACE_URL, "role")), *arguments]
        errors = StringIO()
        with patch.object(sys, "argv", argv), patch.dict(os.environ, environment or {}), redirect_stderr(errors), patch.object(
            cli.IntelligenceRepository, "from_settings", side_effect=AssertionError("no database before the decision is valid")
        ):
            if environment is None:
                os.environ.pop("FIRSTSEEN_REVIEWER", None)
            return cli.main(), errors.getvalue()

    def test_an_incomplete_decision_is_refused_before_touching_the_database(self) -> None:
        code, errors = self.run_decide("--in-scope", "--basis", "posting", "--note", "Backend work.", "--reviewer", "Fixture Reviewer")
        self.assertEqual(code, 2)
        self.assertIn("names a discipline and an early-career type", errors)
        self.assertIn("Nothing was recorded", errors)

    def test_a_decision_needs_a_named_reviewer(self) -> None:
        code, errors = self.run_decide("--out-of-scope", "non_technical_function", "--basis", "titles", "--note", "Sales operations.")
        self.assertEqual(code, 2)
        self.assertIn("name who is deciding with --reviewer or FIRSTSEEN_REVIEWER", errors)


if __name__ == "__main__":
    unittest.main()
