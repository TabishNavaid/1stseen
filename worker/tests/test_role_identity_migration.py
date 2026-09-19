"""The re-key that undoes the merges an `unknown` level allowed.

These pin what the split may and may not decide, and that every move is auditable. The transaction
itself lives in migration 202608140034; `test_schema_contract` covers that.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path
from uuid import UUID, uuid4

from firstseen.role_identity_migration import (
    RoleIdentityMigrationService,
    plan_role_identity_splits,
    recurrence_key_for,
)
from firstseen.role_resolution import stated_early_career_types

FIXTURES = Path(__file__).resolve().parent / "fixtures"

ROLE = UUID("00000000-0000-4000-8000-000000000041")
OTHER = UUID("00000000-0000-4000-8000-000000000042")


def observation(role_id: UUID, title: str, *, company: str = "Neuralink", canonical: str = "Software Engineer, Implant", reason: str | None = None) -> dict:
    return {
        "role_id": str(role_id),
        "company": company,
        "company_normalized": company.casefold(),
        "canonical_title": canonical,
        "scope_reason": reason,
        "observation_id": str(uuid4()),
        "raw_title": title,
    }


class RecordingStore:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows
        self.calls: list[dict] = []

    def list_role_identity_candidates(self, company_id):
        del company_id
        return self.rows

    def split_canonical_role(self, **kwargs):
        self.calls.append(kwargs)
        return uuid4()


class StatedTypeSplitTests(unittest.TestCase):
    def test_an_intern_program_is_split_from_the_experienced_postings_it_merged_with(self) -> None:
        """The documented bug: an unmarked "Software Engineer, Implant" absorbed its own intern."""
        rows = [
            observation(ROLE, "Software Engineer, Implant"),
            observation(ROLE, "Software Engineer, Implant"),
            observation(ROLE, "Software Engineer Intern, Implant"),
        ]

        [plan] = plan_role_identity_splits(rows)

        self.assertEqual(plan.keeps.stated_types, frozenset())
        self.assertEqual(len(plan.keeps.observation_ids), 2)
        self.assertEqual([split.stated_types for split in plan.moves], [frozenset({"internship"})])
        self.assertEqual(plan.moves[0].title, "Software Engineer Intern, Implant")

    def test_a_role_whose_titles_all_state_the_same_thing_is_left_alone(self) -> None:
        """Two disciplines at one type is a different merge, and this rule may not decide it."""
        rows = [
            observation(ROLE, "FPGA Engineer Intern (Summer 2027 - Austin)", company="Optiver"),
            observation(ROLE, "Software Engineer Intern (Summer 2027 - Austin)", company="Optiver"),
        ]

        self.assertEqual(plan_role_identity_splits(rows), [])

    def test_two_early_career_types_split_from_each_other(self) -> None:
        rows = [
            observation(ROLE, "Software Engineering Internship (C++ or Python) – Summer 2027", company="Hudson River Trading"),
            observation(ROLE, "Software Engineer (C++ or Python) – 2027 Grads", company="Hudson River Trading"),
        ]

        [plan] = plan_role_identity_splits(rows)

        self.assertEqual(
            sorted({tuple(sorted(split.stated_types)) for split in (plan.keeps, *plan.moves)}),
            [("internship",), ("new_grad",)],
        )

    def test_the_largest_group_keeps_the_role_so_the_least_evidence_moves(self) -> None:
        rows = [observation(ROLE, "Campus Systems Engineer (Intern)", company="Jumptrading") for _ in range(3)]
        rows += [observation(ROLE, "Campus Systems Engineer (Full-Time)", company="Jumptrading")]

        [plan] = plan_role_identity_splits(rows)

        self.assertEqual(plan.keeps.stated_types, frozenset({"internship"}))
        self.assertEqual(len(plan.moves[0].observation_ids), 1)

    def test_roles_are_planned_independently(self) -> None:
        rows = [
            observation(ROLE, "Research Intern - Robotics"),
            observation(ROLE, "Research Engineer - Robotics"),
            observation(OTHER, "Mechanical Engineer", canonical="Mechanical Engineer"),
        ]

        plans = plan_role_identity_splits(rows)

        self.assertEqual([plan.role_id for plan in plans], [ROLE])


class ScrapedTitleTests(unittest.TestCase):
    def test_a_new_role_is_named_without_the_careers_card_furniture(self) -> None:
        """Applied Intuition's anchors run title, location, location and button text together."""
        rows = [
            observation(ROLE, "Research Engineer - Robotics Sunnyvale Sunnyvale Apply", company="Applied Intuition"),
            observation(ROLE, "Research Intern - Robotics Sunnyvale Sunnyvale Apply", company="Applied Intuition"),
        ]

        [plan] = plan_role_identity_splits(rows)

        for split in (plan.keeps, *plan.moves):
            self.assertNotIn("Sunnyvale Sunnyvale", split.title)
            self.assertFalse(split.title.endswith("Apply"))


class ApplyTests(unittest.TestCase):
    def test_nothing_is_written_without_apply(self) -> None:
        store = RecordingStore([observation(ROLE, "Software Engineer, Implant"), observation(ROLE, "Software Engineer Intern, Implant")])

        summary, plans = RoleIdentityMigrationService(store).run(None, apply=False)

        self.assertEqual(store.calls, [])
        self.assertEqual(summary.roles_split, 1)
        self.assertEqual(summary.roles_created, 1)
        self.assertEqual(len(plans), 1)

    def test_applying_moves_only_the_split_group_and_names_the_versions(self) -> None:
        store = RecordingStore(
            [
                observation(ROLE, "Software Engineer, Implant"),
                observation(ROLE, "Software Engineer, Implant"),
                observation(ROLE, "Software Engineer Intern, Implant"),
            ]
        )

        summary, _ = RoleIdentityMigrationService(store).run(None, apply=True)

        self.assertEqual(summary.failures, 0)
        self.assertEqual(len(store.calls), 1)
        call = store.calls[0]
        self.assertEqual(call["source_role_id"], ROLE)
        self.assertEqual(len(call["observation_ids"]), 1)
        self.assertEqual(call["stated_types"], ["internship"])
        self.assertEqual(call["level"], "internship")
        self.assertEqual(call["resolver_version_from"], "hybrid-role-resolver-v1")
        self.assertEqual(call["resolver_version_to"], "hybrid-role-resolver-v2")
        self.assertIn("early-career type", call["reason"])

    def test_the_role_that_keeps_the_id_is_renamed_when_its_name_states_what_left_it(self) -> None:
        """"Research Engineer, Self-Driving" holding only interns would be a lie on the role page."""
        store = RecordingStore(
            [
                observation(ROLE, "Research Intern - Self-Driving", canonical="Research Engineer - Self-Driving"),
                observation(ROLE, "Research Intern - Self-Driving", canonical="Research Engineer - Self-Driving"),
                observation(ROLE, "Research Engineer - Self-Driving", canonical="Research Engineer - Self-Driving"),
            ]
        )

        RoleIdentityMigrationService(store).run(None, apply=True)

        call = store.calls[0]
        self.assertEqual(call["source_canonical_title"], "Research Intern - Self-Driving")
        self.assertEqual(call["source_level"], "internship")

    def test_a_correctly_named_role_is_not_renamed(self) -> None:
        store = RecordingStore(
            [
                observation(ROLE, "Software Engineer, Implant"),
                observation(ROLE, "Software Engineer, Implant"),
                observation(ROLE, "Software Engineer Intern, Implant"),
            ]
        )

        RoleIdentityMigrationService(store).run(None, apply=True)

        self.assertIsNone(store.calls[0]["source_canonical_title"])
        self.assertIsNone(store.calls[0]["source_level"])

    def test_one_failing_split_does_not_stop_the_others(self) -> None:
        class Failing(RecordingStore):
            def split_canonical_role(self, **kwargs):
                self.calls.append(kwargs)
                raise RuntimeError("the role changed since it was planned")

        store = Failing([observation(ROLE, "Software Engineer, Implant"), observation(ROLE, "Software Engineer Intern, Implant")])

        summary, _ = RoleIdentityMigrationService(store).run(None, apply=True)

        self.assertEqual(summary.failures, 1)
        self.assertEqual(summary.roles_created, 0)

    def test_merges_this_rule_cannot_decide_are_counted_not_hidden(self) -> None:
        store = RecordingStore(
            [
                observation(OTHER, "FPGA Engineer Intern (Summer 2027)", company="Optiver", canonical="Fpga Engineer Intern", reason="alias_conflict"),
                observation(OTHER, "Software Engineer Intern (Summer 2027)", company="Optiver", canonical="Fpga Engineer Intern", reason="alias_conflict"),
            ]
        )

        summary, _ = RoleIdentityMigrationService(store).run(None, apply=False)

        self.assertEqual(summary.roles_split, 0)
        self.assertEqual(summary.unsplit_merges, 1)


class RecurrenceKeyTests(unittest.TestCase):
    def test_a_key_is_stable_lowercase_and_states_the_type(self) -> None:
        key = recurrence_key_for("neuralink", "Software Engineer Intern, Implant", frozenset({"internship"}))

        self.assertRegex(key, r"^[a-z0-9]+(_[a-z0-9]+)*$")
        self.assertIn("internship", key)
        self.assertEqual(
            key, recurrence_key_for("neuralink", "Software Engineer Intern, Implant", frozenset({"internship"}))
        )

    def test_two_types_of_one_program_get_different_keys(self) -> None:
        intern = recurrence_key_for("hrt", "Software Engineer", frozenset({"internship"}))
        grad = recurrence_key_for("hrt", "Software Engineer", frozenset({"new_grad"}))

        self.assertNotEqual(intern, grad)


class StatedTypeReadingTests(unittest.TestCase):
    def test_identity_and_scope_read_a_title_the_same_way(self) -> None:
        """One definition: the resolver asks the scope classifier rather than keeping its own list."""
        for title, expected in [
            ("Research Intern", {"internship"}),
            ("Research Engineer", set()),
            ("Junior Linux Kernel Engineer", {"new_grad"}),
            ("Design Verification (DV) Engineer - 2027 Grads", {"new_grad"}),
            ("Graduate Hardware Engineer", {"graduate_program"}),
            ("Software Engineering Internship", {"internship"}),
        ]:
            with self.subTest(title=title):
                self.assertEqual(set(stated_early_career_types(title)), expected)


class LabeledMergeTests(unittest.TestCase):
    """The 52 merges the v1 resolver made across a stated early-career type, as the rig held them, so none of them can come back.

    Each case is a canonical role the v1 resolver built, with the titles it was observed under.
    `split` means their stated early-career types disagree, so the current rules keep them apart;
    `kept` means they agree and the merge is of a kind this rule may not decide — two disciplines at
    one type, a specialization split — which is recorded so a later change to it is deliberate.
    """

    @classmethod
    def setUpClass(cls) -> None:
        cls.cases = json.loads((FIXTURES / "role_resolution_cases.json").read_text())["identity_merges"]

    def test_the_labelled_merges_are_all_still_there(self) -> None:
        outcomes = [case["outcome"] for case in self.cases]
        self.assertEqual(len(self.cases), 62)
        self.assertEqual(outcomes.count("split"), 43)
        self.assertEqual(outcomes.count("kept"), 19)

    def test_a_split_case_groups_titles_exactly_as_it_was_labelled(self) -> None:
        for case in self.cases:
            if case["outcome"] != "split":
                continue
            with self.subTest(case=case["id"], merged_as=case["merged_as"]):
                for group in case["groups"]:
                    stated = {
                        kind for title in group["titles"] for kind in stated_early_career_types(title)
                    }
                    self.assertEqual(
                        sorted(stated),
                        group["stated_types"],
                        f"{case['company']}: {group['titles']}",
                    )
                # The groups must stay distinguishable, which is what keeps them separate programs.
                readings = [tuple(group["stated_types"]) for group in case["groups"]]
                self.assertEqual(len(set(readings)), len(readings), f"{case['company']}: {case['merged_as']}")

    def test_a_split_case_would_be_planned_as_a_split_today(self) -> None:
        for case in self.cases:
            if case["outcome"] != "split":
                continue
            rows = [
                observation(ROLE, title, company=case["company"], canonical=case["merged_as"])
                for group in case["groups"]
                for title in group["titles"]
            ]
            with self.subTest(case=case["id"], merged_as=case["merged_as"]):
                plans = plan_role_identity_splits(rows)
                self.assertEqual(len(plans), 1)
                self.assertEqual(len(plans[0].moves), len(case["groups"]) - 1)

    def test_a_kept_case_still_reads_as_one_program_and_is_left_alone(self) -> None:
        """This rule may not split a merge it cannot explain; those wait for a rule that can."""
        for case in self.cases:
            if case["outcome"] != "kept":
                continue
            [group] = case["groups"]
            rows = [
                observation(ROLE, title, company=case["company"], canonical=case["merged_as"])
                for title in group["titles"]
            ]
            with self.subTest(case=case["id"], merged_as=case["merged_as"]):
                self.assertEqual(plan_role_identity_splits(rows), [], f"{case['company']}: {group['titles']}")


if __name__ == "__main__":
    unittest.main()
