"""Which canonical role a question, posting, or signal names: identity words, never the company name.

Titles are the rig corpus's own (2026-09-14): Databricks lists "Director Americas Field Marketing At
Databricks", and 38 of its 2,455 canonical roles repeat their company's name in the title.
"""

from __future__ import annotations

import unittest
from typing import Any
from uuid import NAMESPACE_URL, UUID, uuid5

from firstseen.agent import SupabaseRecruitingKnowledge, roles_matching_question
from firstseen.repository import IntelligenceRepository
from firstseen.role_resolution import identifying_title_tokens, question_tracks, title_level

COMPANY_ID = "00000000-0000-4000-8000-000000000001"


def role(
    title: str,
    track: str = "other",
    company: str = "databricks",
    *,
    location: str = "unspecified",
    specialization: str | None = None,
) -> dict[str, Any]:
    return {
        "id": str(uuid5(NAMESPACE_URL, f"{company}/{title}/{location}/{specialization}")),
        "company_id": COMPANY_ID,
        "active": True,
        "canonical_title": title,
        "normalized_title": title.casefold(),
        "track": track,
        "role_family": "other",
        "recurrence_key": title.casefold().replace(" ", "_"),
        "feature_profile": {},
        "company_normalized": company,
        "scope_status": "in_scope",
        "location_scope": location,
        "specialization": specialization,
        "role_aliases": [],
    }


DATABRICKS = [
    role("Director Americas Field Marketing At Databricks"),
    role("Engineering Manager Databricks Sql Control Plane"),
    role("Intern Early Careers", "internship"),
    role("Phd Genai Research Scientist Intern", "internship"),
    role("Product Management Intern Summer", "internship"),
    role("Software Engineering Intern Start Winter", "internship"),
    role("Associate Product Manager New Grad Start", "new_grad"),
]


def titles(rows: list[dict[str, Any]]) -> set[str]:
    return {str(row["canonical_title"]) for row in rows}


class FakeQuery:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    def select(self, columns: str) -> FakeQuery:
        del columns
        return self

    def eq(self, column: str, value: object) -> FakeQuery:
        self.rows = [row for row in self.rows if str(row.get(column)) == str(value)]
        return self

    def order(self, column: str, *, desc: bool = False) -> FakeQuery:
        self.rows = sorted(self.rows, key=lambda row: str(row.get(column)), reverse=desc)
        return self

    def range(self, start: int, end: int) -> FakeQuery:
        self.rows = self.rows[start : end + 1]
        return self

    def execute(self) -> Any:
        return type("Response", (), {"data": self.rows})()


class FakeClient:
    def __init__(self, rows: list[dict[str, Any]]) -> None:
        self.rows = rows

    def table(self, name: str) -> FakeQuery:
        if name != "canonical_roles":
            raise AssertionError(f"unexpected table {name}")
        return FakeQuery(list(self.rows))


class QuestionRoleMatchingTests(unittest.TestCase):
    def test_the_company_name_in_a_title_never_matches_the_question(self) -> None:
        question = "What's the typical intern timing at Databricks?"

        matched = roles_matching_question(question, DATABRICKS)

        self.assertNotIn("Director Americas Field Marketing At Databricks", titles(matched))
        # No identifying words, one named track with four roles: ambiguous, not guessed.
        self.assertEqual(
            titles(matched),
            {
                "Intern Early Careers",
                "Phd Genai Research Scientist Intern",
                "Product Management Intern Summer",
                "Software Engineering Intern Start Winter",
            },
        )

    def test_the_store_used_by_the_agent_applies_the_same_rule(self) -> None:
        store = SupabaseRecruitingKnowledge.__new__(SupabaseRecruitingKnowledge)
        store.client = FakeClient(DATABRICKS)  # type: ignore[assignment]

        roles = store.find_roles(UUID(COMPANY_ID), "What's the typical intern timing at Databricks?")

        self.assertEqual(len(roles), 4)
        self.assertTrue(all(item.track == "internship" for item in roles))

    def test_without_a_track_or_identifying_words_nothing_resolves(self) -> None:
        self.assertEqual(roles_matching_question("What's the typical timing at Databricks?", DATABRICKS), [])

    def test_a_role_named_by_its_own_words_still_resolves(self) -> None:
        self.assertEqual(
            titles(roles_matching_question("When will Databricks open the Director Americas Field Marketing role?", DATABRICKS)),
            {"Director Americas Field Marketing At Databricks"},
        )
        self.assertEqual(
            titles(roles_matching_question("When will Databricks open its product management internship?", DATABRICKS)),
            {"Product Management Intern Summer"},
        )

    def test_a_named_track_is_a_hard_filter(self) -> None:
        stripe = [
            role("Software Engineer Stripe Tax", company="stripe"),
            role("Software Engineer Intern Summer Or Winter", "internship", company="stripe"),
        ]
        self.assertEqual(
            titles(roles_matching_question("When will Stripe open its software engineer internship?", stripe)),
            {"Software Engineer Intern Summer Or Winter"},
        )
        self.assertEqual(
            titles(roles_matching_question("When does Databricks hire product manager new grads?", DATABRICKS)),
            {"Associate Product Manager New Grad Start"},
        )

    def test_identifying_words_that_match_nothing_resolve_nothing(self) -> None:
        # Falling back to the only internship here would answer about the wrong program.
        self.assertEqual(
            roles_matching_question("When will Databricks open its quantum hardware internship?", DATABRICKS), []
        )

    def test_a_named_track_with_one_role_resolves_to_it(self) -> None:
        rows = [role("Director Americas Field Marketing At Databricks"), role("Product Management Intern Summer", "internship")]
        self.assertEqual(
            titles(roles_matching_question("When does Databricks open internships?", rows)),
            {"Product Management Intern Summer"},
        )

    def test_deliberate_location_splits_stay_ambiguous_until_a_location_is_named(self) -> None:
        # The rig's Cohere roles: one title, split four ways by location scope, a hard identity incompatibility.
        cohere = [
            role("Business Development Representative", company="cohere", location=place)
            for place in ("dubai", "germany", "korea", "toronto")
        ]
        every_split = roles_matching_question("When does Cohere hire business development representatives?", cohere)
        self.assertEqual(sorted(row["location_scope"] for row in every_split), ["dubai", "germany", "korea", "toronto"])
        toronto = roles_matching_question("When does Cohere hire a business development representative in Toronto?", cohere)
        self.assertEqual([row["location_scope"] for row in toronto], ["toronto"])

    def test_specialization_splits_surface_both_until_the_question_names_one(self) -> None:
        # The rig's Figma winter internships: one title, one specialized for infrastructure.
        figma = [
            role("Software Engineer Intern Winter", "internship", company="figma"),
            role("Software Engineer Intern Winter", "internship", company="figma", specialization="infrastructure"),
        ]
        both = roles_matching_question("When will Figma open its winter software engineering internship?", figma)
        self.assertEqual(sorted(str(row["specialization"]) for row in both), ["None", "infrastructure"])
        infrastructure = roles_matching_question("When will Figma open its infrastructure winter internship?", figma)
        self.assertEqual([row["specialization"] for row in infrastructure], ["infrastructure"])


class WeakWordTests(unittest.TestCase):
    def test_conversational_words_do_not_pick_a_role(self) -> None:
        # Before, "people" alone resolved this to Samsara's People Analytics AI Engineer.
        samsara = [
            role("People Analytics AI Engineer", company="samsara"),
            role("Software Engineer Intern London", "internship", company="samsara"),
        ]
        self.assertEqual(roles_matching_question("Is it too soon to reach out to people at Samsara?", samsara), [])

    def test_inflections_of_the_same_work_match_on_every_word(self) -> None:
        rows = [
            role("Software Engineering Intern Start Winter", "internship"),
            role("Software Development Intern", "internship"),
        ]
        self.assertEqual(
            titles(roles_matching_question("When will Databricks open its software engineer internship?", rows)),
            {"Software Engineering Intern Start Winter"},
        )


class IdentityWordTests(unittest.TestCase):
    def test_company_names_function_words_and_track_words_are_not_identity(self) -> None:
        self.assertEqual(
            identifying_title_tokens("Director Americas Field Marketing At Databricks", "Databricks"),
            {"director", "americas", "field", "marketing"},
        )
        self.assertEqual(identifying_title_tokens("What's the typical intern timing at Databricks?", "databricks"), set())

    def test_question_tracks_are_explicit_words_only(self) -> None:
        self.assertEqual(question_tracks("What's the typical intern timing?"), {"internship"})
        self.assertEqual(question_tracks("Any co-op roles?"), {"internship"})
        self.assertEqual(question_tracks("When do new grads get offers?"), {"new_grad"})
        self.assertEqual(question_tracks("Is Databricks hiring?"), set())

    def test_title_level_reads_the_title_alone(self) -> None:
        self.assertEqual(title_level("Software Engineer Intern (Summer 2027)"), "internship")
        self.assertEqual(title_level("Senior Software Engineer, Stripe Tax"), "full_time")
        self.assertEqual(title_level("Graduate Hardware Engineer"), "new_grad")
        self.assertEqual(title_level("Software Engineer, Stripe Tax"), "unknown")


class CurrentPostingMatchingTests(unittest.TestCase):
    match = staticmethod(SupabaseRecruitingKnowledge._posting_matches_role)

    def test_a_posting_needs_identity_words_and_the_role_track(self) -> None:
        intern = role("Software Engineer Intern Summer Or Winter", "internship", company="stripe")
        self.assertTrue(self.match(intern, "Software Engineer Intern (Summer 2027)"))
        self.assertFalse(self.match(intern, "Senior Software Engineer, Stripe Tax"))
        self.assertFalse(self.match(intern, "Software Engineer, Stripe Tax"))

    def test_a_shared_company_name_is_not_a_matching_posting(self) -> None:
        manager = role("Engineering Manager Databricks Sql Control Plane")
        self.assertFalse(self.match(manager, "Director, Americas Field Marketing at Databricks"))
        self.assertTrue(self.match(manager, "Engineering Manager, Databricks SQL"))

    def test_graduate_titles_count_for_new_grad_roles(self) -> None:
        graduate = role("Graduate Hardware Engineer", "new_grad", company="imc")
        self.assertTrue(self.match(graduate, "Graduate Hardware Engineer - Chicago"))


class SignalRoleResolutionTests(unittest.TestCase):
    def repository(self, rows: list[dict[str, Any]]) -> IntelligenceRepository:
        subject = IntelligenceRepository.__new__(IntelligenceRepository)
        subject.client = FakeClient(rows)  # type: ignore[assignment]
        return subject

    def test_a_company_name_does_not_complete_a_title_match(self) -> None:
        researcher = role("Figma Researcher", company="figma")
        self.assertIsNone(
            self.repository([researcher]).resolve_signal_role(UUID(COMPANY_ID), "Figma is hiring a UX researcher for Weave")
        )

    def test_a_title_named_in_full_still_resolves(self) -> None:
        designer = role("Product Designer Figma Weave Tel Aviv Israel", company="figma")
        self.assertEqual(
            self.repository([designer]).resolve_signal_role(
                UUID(COMPANY_ID), "New role: Product Designer, Figma Weave (Tel Aviv, Israel)"
            ),
            UUID(designer["id"]),
        )


if __name__ == "__main__":
    unittest.main()
