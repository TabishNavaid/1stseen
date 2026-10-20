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
from firstseen.enrichment_fingerprints import (
    UNCHANGED_RESULT,
    UNKNOWN_COMPONENT,
    WORKER_COMPONENT,
    EnrichmentFingerprint,
    changed_components,
    skip_key,
    worker_fingerprint,
)

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
    """Fingerprints per company that a pass may move, the stored no-op keys and parts, and every tool call."""

    def __init__(self, keys: dict[str, str] | None = None) -> None:
        self.fingerprints = {STEADY: "steady", CHANGING: "changing-1", FAILING: "failing"}
        # The components the fingerprint is built from, which is what lets a run name what moved. The combined
        # fingerprint above stays the authority for the skip, exactly as the database's is.
        self.parts: dict[UUID, dict[str, str]] = {
            STEADY: {"observations": "o-steady", "fetches": "f-steady"},
            CHANGING: {"observations": "o-changing-1", "fetches": "f-changing"},
            FAILING: {"observations": "o-failing", "fetches": "f-failing"},
        }
        self.keys = dict(keys or {})
        self.stored_parts: dict[str, dict[str, str]] = {}
        self.calls: list[dict[str, Any]] = []

    def company_enrichment_fingerprints(self, company_ids: list[UUID]) -> dict[UUID, str]:
        return {company: self.fingerprints[company] for company in company_ids}

    def company_enrichment_parts(self, company_ids: list[UUID]) -> dict[UUID, EnrichmentFingerprint]:
        # Routed through the combined read so a database missing the function still raises from one place.
        combined = self.company_enrichment_fingerprints(company_ids)
        return {
            company: EnrichmentFingerprint(fingerprint=fingerprint, parts=dict(self.parts.get(company, {})))
            for company, fingerprint in combined.items()
        }

    def enrichment_noop_keys(self) -> dict[str, str]:
        return dict(self.keys)

    def enrichment_noop_state(self) -> tuple[dict[str, str], dict[str, dict[str, str]]]:
        return dict(self.keys), {company: dict(row) for company, row in self.stored_parts.items()}

    def save_enrichment_noop_keys(
        self,
        keys: dict[str, str],
        *,
        run_id: UUID,
        parts: dict[str, dict[str, str]] | None = None,
    ) -> None:
        self.keys = dict(keys)
        if parts is not None:
            self.stored_parts = {company: dict(row) for company, row in parts.items()}

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
            self.repository.parts[CHANGING]["observations"] += "+"
        return summary(company_id, complete=company_id != FAILING)


class Router:
    def client(self, capability: str, *, agent_run_id: UUID) -> Any:
        return None


def run(repository: Repository, *, force: bool = False) -> tuple[list[UUID], int, dict[str, int], int]:
    """One enrichment pass: who was enriched, how many were skipped, what moved, and how many held no key."""
    Service.enriched = []
    with patch.object(cli, "EvidenceEnrichmentService", Service), patch.object(cli, "get_settings", lambda: SETTINGS):
        _, failures, unchanged, moved, never_converged = cli._enrich_companies(
            repository,  # type: ignore[arg-type]
            [STEADY, CHANGING, FAILING],
            run_id=RUN,
            router=Router(),  # type: ignore[arg-type]
            force=force,
        )
    assert failures == 0
    return list(Service.enriched), unchanged, moved, never_converged


def enrich(repository: Repository, *, force: bool = False) -> tuple[list[UUID], int]:
    enriched, unchanged, _, _ = run(repository, force=force)
    return enriched, unchanged


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


class WhatMovedTests(unittest.TestCase):
    """A run says which component of the fingerprint moved, so nobody has to reason about which cause it was.

    This is the gap that cost 2026-10-20: four completed collection runs each reported companies_unchanged = 0 of 80
    and the record could not distinguish a new posting from a sitemap emitting a diagnostic again.
    """

    def settled(self, repository: Repository) -> None:
        """Run until every company that can hold a key holds one, so the next run has something to compare against."""
        for _ in range(3):
            run(repository)

    def test_a_run_names_the_component_that_moved_and_counts_the_companies(self) -> None:
        repository = Repository()
        self.settled(repository)
        self.assertIn(str(STEADY), repository.keys, "STEADY converged, so it has parts stored beside its key")

        # Nothing about STEADY's content changed. One of its sources merely reported a different fetch status, which
        # is the `fetches` component, and the combined fingerprint moves with it.
        repository.parts[STEADY]["fetches"] = "f-steady-after-a-failed-sitemap"
        repository.fingerprints[STEADY] = "steady-but-one-source-flapped"

        enriched, unchanged, moved, never_converged = run(repository)
        self.assertIn(STEADY, enriched, "the company is re-enriched, which is what the fingerprint asked for")
        self.assertEqual(unchanged, 0)
        self.assertEqual(moved, {"fetches": 1}, "the run names the component rather than only the company count")
        # CHANGING moves its own inputs every pass and FAILING never completes one, so neither ever holds a key.
        # STEADY is not among them: it held one, so its re-enrichment is a change and not a first pass.
        self.assertEqual(never_converged, 2)

        # And the company's own audit record carries it, not just the run total.
        last = [call for call in repository.calls if call["input_redacted"]["company_id"] == str(STEADY)][-1]
        self.assertEqual(last["output_redacted"]["inputs_changed"], ["fetches"])

    def test_a_real_content_change_is_named_as_observations(self) -> None:
        repository = Repository()
        self.settled(repository)
        repository.parts[STEADY]["observations"] = "o-steady-with-a-new-posting"
        repository.fingerprints[STEADY] = "steady-with-a-new-posting"
        self.assertEqual(run(repository)[2], {"observations": 1})

    def test_both_components_are_named_when_both_moved(self) -> None:
        repository = Repository()
        self.settled(repository)
        repository.parts[STEADY] = {"observations": "o-new", "fetches": "f-new"}
        repository.fingerprints[STEADY] = "steady-moved-twice"
        self.assertEqual(run(repository)[2], {"fetches": 1, "observations": 1})

    def test_a_company_with_no_stored_key_is_never_converged_rather_than_changed(self) -> None:
        repository = Repository()
        enriched, unchanged, moved, never_converged = run(repository)
        self.assertEqual(enriched, [STEADY, CHANGING, FAILING])
        self.assertEqual((unchanged, moved), (0, {}), "a first pass is not eighty changes")
        self.assertEqual(never_converged, 3)

    def test_the_worker_is_named_when_its_own_part_is_all_that_moved(self) -> None:
        repository = Repository()
        self.settled(repository)
        # The components the database reports are identical; only the key differs, which leaves the worker's own
        # source and model configuration as the only thing it can have been.
        repository.keys[str(STEADY)] = skip_key("steady", "a-different-worker")
        self.assertEqual(run(repository)[2], {WORKER_COMPONENT: 1})

    def test_a_database_without_the_parts_says_unknown_rather_than_guessing(self) -> None:
        repository = Repository()
        self.settled(repository)
        # Migration 202608140059 is not applied for this company: the fingerprint still decides the skip, and the
        # explanation is absent. CHANGING keeps its components so the fixture's own pass still works.
        repository.parts = {CHANGING: dict(repository.parts[CHANGING])}
        repository.fingerprints[STEADY] = "steady-moved-somehow"
        self.assertEqual(run(repository)[2], {UNKNOWN_COMPONENT: 1})


class ChangedComponentsTests(unittest.TestCase):
    def test_a_component_that_appears_or_disappears_is_named(self) -> None:
        self.assertEqual(changed_components({"a": "1"}, {"a": "1"}), ())
        self.assertEqual(changed_components({"a": "1"}, {"a": "2"}), ("a",))
        self.assertEqual(changed_components({"a": "1"}, {"a": "1", "b": "2"}), ("b",))
        self.assertEqual(changed_components({"a": "1", "b": "2"}, {"a": "1"}), ("b",))
        self.assertEqual(changed_components({"b": "1", "a": "9"}, {"b": "2", "a": "8"}), ("a", "b"))


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
