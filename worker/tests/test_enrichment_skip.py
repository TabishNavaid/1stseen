"""A company is skipped only when its inputs are exactly those of its last pass that changed nothing.

The rule (enrichment_fingerprints.py): after a complete pass, if the database's fingerprint of the company's inputs is
the one taken before it, the pass changed nothing and its key is kept; a later run skips the company while the key
still matches. These tests drive the enrichment loop with a fake service and pin every way a company must be enriched.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from typing import Any, ClassVar
from unittest.mock import patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from postgrest.exceptions import APIError

from firstseen import cli
from firstseen.config import Settings
from firstseen.enrichment import EnrichmentSummary
from firstseen.enrichment_fingerprints import UNCHANGED_RESULT, skip_key, worker_fingerprint

STEADY, CHANGING, FAILING = UUID(int=1), UUID(int=2), UUID(int=3)
RUN = UUID(int=99)


def summary(company_id: UUID, *, complete: bool = True) -> EnrichmentSummary:
    return EnrichmentSummary(
        company_id=company_id,
        observations_considered=0,
        roles_matched=0,
        roles_created=0,
        resolution_failures=0 if complete else 1,
        roles_reconstructed=0,
        events_persisted=0,
        reconstruction_failures=0,
        degraded_capture_sources=0,
    )


class Repository:
    """Fingerprints per company that a pass may move, the stored no-op keys, and every tool call."""

    def __init__(self, keys: dict[str, str] | None = None) -> None:
        self.fingerprints = {STEADY: "steady", CHANGING: "changing-1", FAILING: "failing"}
        self.keys = dict(keys or {})
        self.calls: list[dict[str, Any]] = []

    def company_enrichment_fingerprints(self, company_ids: list[UUID]) -> dict[UUID, str]:
        return {company: self.fingerprints[company] for company in company_ids}

    def enrichment_noop_keys(self) -> dict[str, str]:
        return dict(self.keys)

    def save_enrichment_noop_keys(self, keys: dict[str, str], *, run_id: UUID) -> None:
        self.keys = dict(keys)

    def record_tool_call(self, run_id: UUID, **call: Any) -> UUID:
        self.calls.append(call)
        return UUID(int=len(self.calls))


class Service:
    """Enriches like the real service would: CHANGING's pass moves its inputs, FAILING's pass is incomplete."""

    enriched: ClassVar[list[UUID]] = []

    def __init__(self, repository: Repository, **_: Any) -> None:
        self.repository = repository

    def enrich_company(self, company_id: UUID) -> EnrichmentSummary:
        Service.enriched.append(company_id)
        if company_id == CHANGING:
            self.repository.fingerprints[CHANGING] += "+"
        return summary(company_id, complete=company_id != FAILING)


class Router:
    def client(self, capability: str, *, agent_run_id: UUID) -> Any:
        return None


def enrich(repository: Repository, *, force: bool = False) -> tuple[list[UUID], int]:
    Service.enriched = []
    with patch.object(cli, "EvidenceEnrichmentService", Service), patch.object(cli, "get_settings", lambda: SETTINGS):
        _, failures, unchanged = cli._enrich_companies(
            repository,  # type: ignore[arg-type]
            [STEADY, CHANGING, FAILING],
            run_id=RUN,
            router=Router(),  # type: ignore[arg-type]
            force=force,
        )
    assert failures == 0
    return list(Service.enriched), unchanged


SETTINGS = Settings(_env_file=None)


class EnrichmentSkipTests(unittest.TestCase):
    def test_only_a_company_whose_complete_pass_changed_nothing_is_skipped_next_time(self) -> None:
        repository = Repository()
        self.assertEqual(enrich(repository), ([STEADY, CHANGING, FAILING], 0), "nothing is known on the first run")
        self.assertEqual(set(repository.keys), {str(STEADY)}, "a pass that moved its inputs, or failed, keeps no key")

        enriched, unchanged = enrich(repository)
        self.assertEqual((enriched, unchanged), ([CHANGING, FAILING], 1))
        skipped = [call for call in repository.calls if call["output_redacted"] == {"result": UNCHANGED_RESULT}]
        self.assertEqual([call["input_redacted"]["company_id"] for call in skipped], [str(STEADY)])

    def test_new_evidence_brings_a_skipped_company_back(self) -> None:
        repository = Repository()
        enrich(repository)
        repository.fingerprints[STEADY] = "steady-with-a-new-posting"
        self.assertIn(STEADY, enrich(repository)[0])

    def test_a_company_that_changed_nothing_after_changing_is_skipped_from_then_on(self) -> None:
        repository = Repository()
        enrich(repository)
        Service_enrich = Service.enrich_company

        def settle(self: Service, company_id: UUID) -> EnrichmentSummary:
            Service.enriched.append(company_id)
            return summary(company_id, complete=company_id != FAILING)

        with patch.object(Service, "enrich_company", settle):
            enrich(repository)
        self.assertIn(str(CHANGING), repository.keys)
        with patch.object(Service, "enrich_company", Service_enrich):
            self.assertEqual(enrich(repository)[0], [FAILING])

    def test_a_different_worker_or_force_enriches_everything(self) -> None:
        repository = Repository()
        enrich(repository)
        self.assertEqual(enrich(repository, force=True)[0], [STEADY, CHANGING, FAILING])
        repository.keys = {str(STEADY): skip_key("steady", "another-worker")}
        self.assertIn(STEADY, enrich(repository)[0])


    def test_a_database_without_the_fingerprint_function_enriches_everything_and_fails_nothing(self) -> None:
        class Unmigrated(Repository):
            def company_enrichment_fingerprints(self, company_ids: list[UUID]) -> dict[UUID, str]:
                raise APIError({"message": "Could not find the function", "code": "PGRST202"})

        repository = Unmigrated({str(STEADY): skip_key("steady", worker_fingerprint(SETTINGS))})
        self.assertEqual(enrich(repository), ([STEADY, CHANGING, FAILING], 0))


class WorkerFingerprintTests(unittest.TestCase):
    def test_model_configuration_changes_it_and_key_values_never_enter_it(self) -> None:
        base = worker_fingerprint(Settings(_env_file=None))
        with_key = worker_fingerprint(Settings(_env_file=None, GEMINI_API_KEY="secret-one"))
        other_key = worker_fingerprint(Settings(_env_file=None, GEMINI_API_KEY="secret-two"))
        routes = worker_fingerprint(Settings(_env_file=None, LLM_CLASSIFY_ROUTES="groq/some-model"))
        self.assertNotEqual(base, with_key, "configuring a provider enriches every company once")
        self.assertEqual(with_key, other_key, "which key is configured does not matter, only that one is")
        self.assertNotEqual(base, routes)
        self.assertEqual(base, worker_fingerprint(Settings(_env_file=None)))


if __name__ == "__main__":
    unittest.main()
