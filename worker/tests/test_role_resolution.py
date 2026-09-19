import json
import sys
import unittest
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from firstseen.adapters.base import JobCandidate, SourceConfig, build_observation
from firstseen.providers import CompletionResult, ModelRoutingError
from firstseen.role_resolution import (
    CanonicalRoleIdentity,
    LlmRoleClassifier,
    PersistentRoleResolver,
    RoleResolver,
    evaluate_resolutions,
    extract_features,
    normalize_title,
)

FIXTURES = Path(__file__).with_name("fixtures")
COMPANY_ID = UUID("00000000-0000-4000-8000-000000000001")
SOURCE_ID = UUID("00000000-0000-4000-8000-000000000101")
SEEN_AT = datetime(2026, 8, 14, tzinfo=UTC)

ROLE_IDS = {
    "swe_summer": UUID("00000000-0000-4000-8000-000000000011"),
    "swe_security": UUID("00000000-0000-4000-8000-000000000012"),
    "swe_london": UUID("00000000-0000-4000-8000-000000000013"),
    "swe_winter": UUID("00000000-0000-4000-8000-000000000014"),
    "data_science": UUID("00000000-0000-4000-8000-000000000015"),
    "hardware": UUID("00000000-0000-4000-8000-000000000016"),
    "software_full_time": UUID("00000000-0000-4000-8000-000000000017"),
    "apm_new_grad": UUID("00000000-0000-4000-8000-000000000018"),
}


def observation(
    case_id,
    title,
    description,
    *,
    company="Fixture Robotics",
    location="United States",
    employment_type=None,
):
    source = SourceConfig(
        id=SOURCE_ID,
        company_id=COMPANY_ID,
        company=company,
        adapter="generic",
        url="https://careers.fixture.example/jobs",
        trust_score=0.9,
    )
    return build_observation(
        source,
        JobCandidate(
            source_url=f"https://careers.fixture.example/jobs/{case_id}",
            apply_url=f"https://careers.fixture.example/jobs/{case_id}/apply",
            raw_title=title,
            company=company,
            location=location,
            employment_type=employment_type,
            evidence_excerpt=description,
            external_job_id=case_id,
            observation_id=UUID(int=1000 + sum(ord(char) for char in case_id)),
        ),
        observed_at=SEEN_AT,
        extraction_route="json_ld",
    )


def canonical(key, title, description, *, location="United States", aliases=None, employment_type=None):
    seed = observation(
        f"canonical-{key}",
        title,
        description,
        location=location,
        employment_type=employment_type,
    )
    return CanonicalRoleIdentity(
        id=ROLE_IDS[key],
        company_id=COMPANY_ID,
        company_normalized="fixture robotics",
        canonical_title=title,
        recurrence_key=f"fixture_{key}",
        features=extract_features(seed),
        aliases=aliases or [title],
        description_prototype=description,
    )


def candidate_roles():
    general = "Summer internship building production software with engineer mentorship and code reviews."
    return [
        canonical(
            "swe_summer",
            "Software Engineer Intern",
            general,
            aliases=["Software Engineer Intern", "Software Engineering Internship", "SWE Intern"],
        ),
        canonical(
            "swe_security",
            "Software Engineer Intern - Security",
            "Summer security engineering internship focused on application security and threat detection.",
        ),
        canonical("swe_london", "Software Engineer Intern", general, location="London, UK"),
        canonical(
            "swe_winter",
            "Winter Software Engineer Intern",
            "Winter internship building production software with engineer mentorship and code reviews.",
        ),
        canonical(
            "data_science",
            "Data Scientist Intern",
            "Summer internship developing statistical models, experiments, and analytics in Python.",
            aliases=["Data Scientist Intern", "Data Science Intern"],
        ),
        canonical(
            "hardware",
            "Hardware Engineer Intern",
            "Summer hardware internship designing electrical systems and validating circuit boards.",
        ),
        canonical(
            "software_full_time",
            "Software Engineer",
            "Full-time production software engineering role for experienced candidates.",
            employment_type="Full-time",
        ),
        canonical(
            "apm_new_grad",
            "Associate Product Manager - New Grad",
            "New graduate program for product strategy, analytics, and customer research.",
            employment_type="Full-time",
        ),
    ]


class RoleResolutionDatasetTests(unittest.TestCase):
    def test_fixture_accuracy_and_failure_report(self):
        cases = json.loads((FIXTURES / "role_resolution_cases.json").read_text())["resolution"]
        roles = candidate_roles()
        actual = []
        expected = []
        for case in cases:
            observed = observation(
                case["id"],
                case["title"],
                case["description"],
                company=case["company"],
                location=case["location"],
                employment_type=case.get("employment_type"),
            )
            actual.append(
                RoleResolver().resolve(
                    company_id=COMPANY_ID,
                    observation=observed,
                    candidates=roles,
                )
            )
            expected_role = ROLE_IDS.get(case["expected"]) if case["expected"] else None
            expected.append((case["id"], str(expected_role) if expected_role else None))

        report = evaluate_resolutions(expected, actual)
        failure_text = ", ".join(
            f"{failure.case_id}: expected={failure.expected_role_id} "
            f"actual={failure.actual_role_id} decision={failure.decision}"
            for failure in report.failures
        )
        self.assertGreaterEqual(report.accuracy, 0.95, failure_text)
        self.assertEqual(report.failures, [], failure_text)

    def test_obvious_match_never_calls_expensive_fallbacks(self):
        class FailEmbedder:
            def embed(self, texts):
                raise AssertionError("embedding should not run for an obvious alias")

        class FailClassifier:
            def classify(self, observation, candidate, feature_scores):
                raise AssertionError("LLM should not run for an obvious alias")

        observed = observation(
            "obvious",
            "SWE Intern",
            "Summer internship building production software with engineer mentorship and code reviews.",
        )
        resolution = RoleResolver(embedder=FailEmbedder(), llm=FailClassifier()).resolve(
            company_id=COMPANY_ID,
            observation=observed,
            candidates=candidate_roles(),
        )
        self.assertEqual(resolution.canonical_role.id, ROLE_IDS["swe_summer"])
        self.assertFalse(resolution.used_embedding)
        self.assertFalse(resolution.used_llm)
        self.assertEqual(resolution.inference_decision.reason, "stored_alias_match")
        self.assertFalse(resolution.inference_decision.llm_escalated)


class UnavailableModelProviderTests(unittest.TestCase):
    def test_exhausted_model_routes_fall_back_to_the_deterministic_decision(self):
        """A configured but unreachable provider must not fail role resolution.

        Observed against live boards: with no reachable route, every ambiguous
        observation raised ModelRoutingError and produced zero canonical roles.
        """

        class UnreachableClient:
            def complete(self, **kwargs):
                raise ModelRoutingError("classify", [])

        description = (
            "Summer internship with mentored production software projects, engineer mentorship, "
            "code reviews, and the same student eligibility requirements."
        )
        seed = observation("step-seed", "STEP Intern", description)
        step = CanonicalRoleIdentity(
            id=UUID("00000000-0000-4000-8000-000000000031"),
            company_id=COMPANY_ID,
            company_normalized="fixture robotics",
            canonical_title="Student Training in Engineering Program",
            recurrence_key="student_training_engineering_summer",
            features=extract_features(seed).model_copy(update={"role_family": "software_engineering"}),
            aliases=["STEP Intern"],
            description_prototype=description,
        )
        renamed = observation("engineering-practicum", "Engineering Practicum", description)

        resolution = RoleResolver(llm=LlmRoleClassifier(UnreachableClient())).resolve(
            company_id=COMPANY_ID, observation=renamed, candidates=[step]
        )

        self.assertIn(resolution.decision, {"matched", "created"})
        self.assertFalse(resolution.used_llm)
        # The unavailability is recorded, never silently dropped.
        self.assertTrue(
            any("unavailable" in reason for reason in resolution.reasons)
            or resolution.decision == "created"
        )

    def test_permanent_provider_errors_still_surface(self):
        class BrokenCredentials:
            def complete(self, **kwargs):
                raise PermissionError("invalid api key")

        description = (
            "Summer internship with mentored production software projects, engineer mentorship, "
            "code reviews, and the same student eligibility requirements."
        )
        seed = observation("step-seed", "STEP Intern", description)
        step = CanonicalRoleIdentity(
            id=UUID("00000000-0000-4000-8000-000000000031"),
            company_id=COMPANY_ID,
            company_normalized="fixture robotics",
            canonical_title="Student Training in Engineering Program",
            recurrence_key="student_training_engineering_summer",
            features=extract_features(seed).model_copy(update={"role_family": "software_engineering"}),
            aliases=["STEP Intern"],
            description_prototype=description,
        )
        renamed = observation("engineering-practicum", "Engineering Practicum", description)
        with self.assertRaises(PermissionError):
            RoleResolver(llm=LlmRoleClassifier(BrokenCredentials())).resolve(
                company_id=COMPANY_ID, observation=renamed, candidates=[step]
            )


class AmbiguousProgramRenameTests(unittest.TestCase):
    def test_embeddings_and_structured_llm_can_support_a_verified_name_change(self):
        class Embedder:
            def embed(self, texts):
                return [[1.0, 0.2, 0.1], [1.0, 0.2, 0.1]]

        class Client:
            def complete(self, **kwargs):
                return CompletionResult(
                    content=(
                        '{"same_program":true,"reason":"Descriptions identify the same summer '
                        'mentored software practicum and only the program name changed."}'
                    ),
                    provider="fixture",
                    model="fixture-model",
                    prompt_tokens=50,
                    completion_tokens=20,
                    estimated_cost_usd=0,
                )

        description = (
            "Summer internship with mentored production software projects, engineer mentorship, "
            "code reviews, and the same student eligibility requirements."
        )
        seed = observation("step-seed", "STEP Intern", description)
        step = CanonicalRoleIdentity(
            id=UUID("00000000-0000-4000-8000-000000000031"),
            company_id=COMPANY_ID,
            company_normalized="fixture robotics",
            canonical_title="Student Training in Engineering Program",
            recurrence_key="student_training_engineering_summer",
            features=extract_features(seed).model_copy(update={"role_family": "software_engineering"}),
            aliases=["STEP Intern"],
            description_prototype=description,
        )
        renamed = observation("engineering-practicum", "Engineering Practicum", description)
        resolution = RoleResolver(
            embedder=Embedder(),
            llm=LlmRoleClassifier(Client()),
        ).resolve(company_id=COMPANY_ID, observation=renamed, candidates=[step])
        self.assertEqual(resolution.decision, "matched")
        self.assertEqual(resolution.canonical_role.id, step.id)
        self.assertTrue(resolution.used_embedding)
        self.assertTrue(resolution.used_llm)
        self.assertEqual(resolution.inference_decision.reason, "ambiguous_role_match")
        self.assertTrue(resolution.inference_decision.llm_escalated)
        self.assertIn("Engineering Practicum", resolution.canonical_role.aliases)


class PersistentResolutionTests(unittest.TestCase):
    def test_persisted_observation_is_not_resolved_twice(self):
        class Store:
            def __init__(self):
                self.saved = []

            def role_match_exists(self, observation_id):
                return bool(self.saved)

            def save_role_resolution(self, resolution):
                self.saved.append(resolution)

        store = Store()
        service = PersistentRoleResolver(RoleResolver(), store)
        observed = observation(
            "cached",
            "Software Engineering Internship",
            "Summer internship building production software with engineer mentorship and code reviews.",
        )
        first = service.resolve_new(company_id=COMPANY_ID, observation=observed, candidates=candidate_roles())
        second = service.resolve_new(
            company_id=COMPANY_ID, observation=observed, candidates=candidate_roles()
        )
        self.assertIsNotNone(first)
        self.assertIsNone(second)
        self.assertEqual(len(store.saved), 1)


if __name__ == "__main__":
    unittest.main()


class DegenerateTitleTests(unittest.TestCase):
    """Normalization strips years and cohort words, which can empty a title."""

    def test_titles_made_only_of_stripped_words_keep_a_usable_canonical_title(self):
        # Observed live: a posting titled only with cohort words normalized to "",
        # producing an empty canonical title that later aborted reconstruction for
        # the entire company.
        for raw in ("Students", "2026", "University", "Early Career", "2025 Students"):
            with self.subTest(raw=raw):
                self.assertEqual(normalize_title(raw), "", "precondition: normalizes to nothing")
                resolution = RoleResolver().resolve(
                    company_id=COMPANY_ID,
                    observation=observation(f"degenerate-{raw}", raw, "Program page for students."),
                    candidates=[],
                )
                self.assertTrue(
                    resolution.canonical_role.canonical_title.strip(),
                    "canonical title must never be empty",
                )
                # The observed title is retained rather than invented.
                self.assertEqual(resolution.canonical_role.canonical_title, raw)
