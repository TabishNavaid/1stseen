import json
import sys
import unittest
from contextlib import redirect_stdout
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from typing import ClassVar
from unittest.mock import patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from firstseen import cli


class Repository:
    requested_company = "unset"
    finished_status = None
    metrics_run_id = None
    saved_backtest = None
    checkpoint_saved = None

    @classmethod
    def from_settings(cls, settings):
        return cls()

    def list_source_configs(self, company):
        type(self).requested_company = company
        return []

    def start_agent_run(self, **kwargs):
        return UUID("00000000-0000-4000-8000-000000000901")

    def finish_agent_run(self, run_id, *, status, error=None):
        type(self).finished_status = status

    def list_inference_metrics(self, run_id=None):
        type(self).metrics_run_id = run_id
        return []

    dataset_loads = 0
    watchlist_scans = 0

    def load_backtest_dataset(self):
        type(self).dataset_loads += 1
        return [], [], []

    def watchers_by_role(self):
        type(self).watchlist_scans += 1
        return {}

    def save_backtest_run(self, run):
        type(self).saved_backtest = run

    def collection_checkpoint(self, pipeline):
        return None

    def changed_role_ids_since(self, since):
        return []

    def in_scope_role_ids(self):
        # Fakes treat every changed role as in scope unless a test says otherwise.
        return set(self.changed_role_ids_since(None))

    def save_collection_checkpoint(self, pipeline, **kwargs):
        type(self).checkpoint_saved = (pipeline, kwargs)


COMPANY_ID = UUID("00000000-0000-4000-8000-000000000001")


class EnrichmentRepository(Repository):
    """Reports one configured company so enrichment scope can be asserted."""

    def list_source_configs(self, company):
        type(self).requested_company = company
        return [SimpleNamespace(id=UUID("00000000-0000-4000-8000-000000000101"), company_id=COMPANY_ID)]

    def record_tool_call(self, run_id, **kwargs):
        return None


def enrichment_summary():
    from firstseen.enrichment import EnrichmentSummary

    return EnrichmentSummary(
        company_id=COMPANY_ID,
        observations_considered=3,
        roles_matched=1,
        roles_created=1,
        resolution_failures=0,
        roles_reconstructed=1,
        events_persisted=2,
        reconstruction_failures=0,
        degraded_capture_sources=0,
    )


class PartialForecastRepository(Repository):
    saved_forecasts = 0
    tool_statuses: ClassVar[list[str]] = []
    forecast_datasets: ClassVar[list[object]] = []

    def changed_role_ids_since(self, since):
        return [
            UUID("00000000-0000-4000-8000-000000000911"),
            UUID("00000000-0000-4000-8000-000000000912"),
        ]

    def build_current_forecast(self, role_id, *, as_of, dataset=None):
        type(self).forecast_datasets.append(dataset)
        if str(role_id).endswith("912"):
            raise RuntimeError("fixture forecast failure")
        return SimpleNamespace(input_fingerprint="a" * 64)

    def latest_forecast_version(self, role_id):
        return None

    def current_forecast_version(self, role_id):
        return None

    def record_forecast_refusal(self, role_id, *, reason, at):
        type(self).refusals = [*getattr(type(self), "refusals", []), (role_id, reason)]

    def save_agent_forecast_version(self, role_id, forecast, **kwargs):
        type(self).saved_forecasts += 1

    def record_tool_call(self, run_id, *, status, **kwargs):
        type(self).tool_statuses.append(status)


class ManyRoleForecastRepository(Repository):
    """Reports several changed roles so per-role re-reads become visible."""

    role_count = 5
    saved_forecasts = 0

    def changed_role_ids_since(self, since):
        return [
            UUID(f"00000000-0000-4000-8000-00000000092{index}")
            for index in range(type(self).role_count)
        ]

    def build_current_forecast(self, role_id, *, as_of, dataset=None):
        return SimpleNamespace(input_fingerprint="b" * 64)

    def latest_forecast_version(self, role_id):
        return None

    def current_forecast_version(self, role_id):
        return None

    def record_forecast_refusal(self, role_id, *, reason, at):
        type(self).refusals = [*getattr(type(self), "refusals", []), (role_id, reason)]

    def save_agent_forecast_version(self, role_id, forecast, **kwargs):
        type(self).saved_forecasts += 1
        return UUID("00000000-0000-4000-8000-000000000991")

    def record_tool_call(self, run_id, **kwargs):
        return None


class PreloadFailureRepository(ManyRoleForecastRepository):
    """Fails the shared preload so the fallback path can be asserted."""

    tool_names: ClassVar[list[str]] = []

    def load_backtest_dataset(self):
        raise RuntimeError("fixture preload failure")

    def record_tool_call(self, run_id, **kwargs):
        type(self).tool_names.append(kwargs["tool_name"])


class PreloadFallbackTests(unittest.TestCase):
    def setUp(self):
        PreloadFailureRepository.tool_names.clear()
        PreloadFailureRepository.saved_forecasts = 0
        PreloadFailureRepository.finished_status = None

    def test_a_failed_preload_still_finishes_and_audits_the_run(self):
        # Preloading is an optimisation. A transient read failure must not abort
        # the pass or leave the agent run stuck in "running".
        with patch.object(cli, "IntelligenceRepository", PreloadFailureRepository), redirect_stdout(
            StringIO()
        ):
            cli.regenerate_changed_forecasts()

        self.assertIn("forecast.preload_shared_evidence", PreloadFailureRepository.tool_names)
        self.assertEqual(PreloadFailureRepository.saved_forecasts, 5)
        self.assertIsNotNone(PreloadFailureRepository.finished_status)


class ForecastRegenerationCostTests(unittest.TestCase):
    """Regeneration cost must not scale with the number of changed roles.

    The evidence set and the watchlist are identical for every role in one pass,
    so reading them per role re-fetched every role, observation, match, event,
    and signal N times.
    """

    def setUp(self):
        ManyRoleForecastRepository.dataset_loads = 0
        ManyRoleForecastRepository.watchlist_scans = 0
        ManyRoleForecastRepository.saved_forecasts = 0

    def test_evidence_and_watchlist_are_read_once_for_many_roles(self):
        with patch.object(cli, "IntelligenceRepository", ManyRoleForecastRepository), redirect_stdout(StringIO()):
            cli.regenerate_changed_forecasts()

        self.assertEqual(ManyRoleForecastRepository.saved_forecasts, 5)
        self.assertEqual(ManyRoleForecastRepository.dataset_loads, 1)
        self.assertEqual(ManyRoleForecastRepository.watchlist_scans, 1)

    def test_no_changed_roles_reads_nothing(self):
        with patch.object(cli, "IntelligenceRepository", Repository), redirect_stdout(StringIO()):
            cli.regenerate_changed_forecasts()

        self.assertEqual(Repository.dataset_loads, 0)
        self.assertEqual(Repository.watchlist_scans, 0)

    def test_the_preloaded_dataset_reaches_the_forecast_call(self):
        with patch.object(cli, "IntelligenceRepository", PartialForecastRepository), redirect_stdout(StringIO()):
            cli.regenerate_changed_forecasts()

        # Every role must receive the shared dataset, never None (which would
        # silently fall back to a per-role re-read).
        self.assertTrue(PartialForecastRepository.forecast_datasets)
        self.assertTrue(
            all(item is not None for item in PartialForecastRepository.forecast_datasets)
        )


class CliTests(unittest.TestCase):
    def setUp(self):
        Repository.requested_company = "unset"
        Repository.finished_status = None
        Repository.metrics_run_id = None
        Repository.saved_backtest = None
        Repository.checkpoint_saved = None
        PartialForecastRepository.saved_forecasts = 0
        PartialForecastRepository.forecast_datasets.clear()
        for repo in (Repository, PartialForecastRepository):
            repo.dataset_loads = 0
            repo.watchlist_scans = 0
        PartialForecastRepository.tool_statuses = []
        PartialForecastRepository.checkpoint_saved = None

    @patch.object(cli, "IntelligenceRepository", Repository)
    def test_ingest_one_company(self):
        with patch.object(sys, "argv", ["firstseen", "ingest", "--company", "fixture.example"]):
            self.assertEqual(cli.main(), 0)
        self.assertEqual(Repository.requested_company, "fixture.example")
        self.assertEqual(Repository.finished_status, "succeeded")

    @patch.object(cli, "IntelligenceRepository", Repository)
    def test_ingest_all_companies(self):
        with patch.object(sys, "argv", ["firstseen", "ingest", "--all"]):
            self.assertEqual(cli.main(), 0)
        self.assertIsNone(Repository.requested_company)

    @patch.object(cli, "run_ingestion", return_value=0)
    def test_ingest_collection_mode_is_explicit(self, run_ingestion):
        with patch.object(
            sys,
            "argv",
            ["firstseen", "ingest", "--all", "--collection", "historical"],
        ):
            self.assertEqual(cli.main(), 0)
        run_ingestion.assert_called_once_with(None, collection="historical")

    @patch.object(cli, "IntelligenceRepository", Repository)
    def test_ingestion_enriches_the_companies_it_collected(self):
        # Collection alone cannot produce a forecast, so the same pass must derive
        # the canonical-role and historical-event records forecasting depends on.
        with (
            patch.object(cli, "_enrich_companies", return_value=([], 0)) as enrich,
            patch.object(sys, "argv", ["firstseen", "ingest", "--all"]),
            redirect_stdout(StringIO()) as output,
        ):
            self.assertEqual(cli.main(), 0)
        enrich.assert_called_once()
        self.assertIn("enrichment", json.loads(output.getvalue()))

    @patch.object(cli, "IntelligenceRepository", EnrichmentRepository)
    def test_enrich_command_reports_derived_records_without_recollecting(self):
        service = SimpleNamespace(enrich_company=lambda company_id: enrichment_summary())
        with (
            patch.object(cli, "EvidenceEnrichmentService", return_value=service),
            patch.object(sys, "argv", ["firstseen", "enrich", "--all"]),
            redirect_stdout(StringIO()) as output,
        ):
            self.assertEqual(cli.main(), 0)
        payload = json.loads(output.getvalue())
        self.assertEqual(payload["status"], "succeeded")
        self.assertEqual(payload["roles_created"], 1)
        self.assertEqual(payload["historical_events_persisted"], 2)
        self.assertEqual(payload["failures"], 0)

    @patch.object(cli, "run_discovery", return_value=0)
    def test_discover_company_can_chain_into_ingestion(self, run_discovery):
        with patch.object(
            sys,
            "argv",
            ["firstseen", "discover", "--company", "fixture.example", "--ingest"],
        ):
            self.assertEqual(cli.main(), 0)
        run_discovery.assert_called_once_with("fixture.example", ingest=True)

    @patch.object(cli, "IntelligenceRepository", Repository)
    def test_metrics_can_be_filtered_to_an_agent_run(self):
        run_id = "00000000-0000-4000-8000-000000000901"
        with patch.object(sys, "argv", ["firstseen", "metrics", "--run-id", run_id]):
            self.assertEqual(cli.main(), 0)
        self.assertEqual(Repository.metrics_run_id, UUID(run_id))

    @patch.object(cli, "IntelligenceRepository", Repository)
    def test_backtest_emits_machine_readable_json_and_persists_run(self):
        output = StringIO()
        with (
            patch.object(
                sys, "argv", ["firstseen", "backtest", "--cutoff-days", "45", "--from-year", "2023"]
            ),
            redirect_stdout(output),
        ):
            self.assertEqual(cli.main(), 0)
        self.assertIsNotNone(Repository.saved_backtest)
        self.assertEqual(Repository.saved_backtest.cutoff_days, 45)
        self.assertEqual(Repository.saved_backtest.schema_version, "backtest-run-v2")
        self.assertEqual(Repository.saved_backtest.from_year, 2023)
        self.assertIn('"completed_cases": 0', output.getvalue())

    @patch.object(cli, "IntelligenceRepository", Repository)
    def test_signal_ingestion_can_process_all_configured_companies(self):
        output = StringIO()
        with patch.object(sys, "argv", ["firstseen", "signals", "--all"]), redirect_stdout(output):
            self.assertEqual(cli.main(), 0)
        self.assertIsNone(Repository.requested_company)
        self.assertEqual(Repository.finished_status, "succeeded")
        self.assertIn('"signals_created": 0', output.getvalue())

    @patch.object(cli, "IntelligenceRepository", Repository)
    def test_forecast_regeneration_advances_cursor_after_clean_noop(self):
        output = StringIO()
        with patch.object(sys, "argv", ["firstseen", "regenerate-forecasts"]), redirect_stdout(output):
            self.assertEqual(cli.main(), 0)
        self.assertEqual(Repository.finished_status, "succeeded")
        self.assertEqual(Repository.checkpoint_saved[0], "forecast_regeneration")
        self.assertIn('"cursor_advanced": true', output.getvalue())

    @patch.object(cli, "IntelligenceRepository", PartialForecastRepository)
    def test_forecast_regeneration_keeps_successes_and_retries_partial_failures(self):
        output = StringIO()
        with patch.object(sys, "argv", ["firstseen", "regenerate-forecasts"]), redirect_stdout(output):
            self.assertEqual(cli.main(), 0)
        self.assertEqual(PartialForecastRepository.saved_forecasts, 1)
        self.assertEqual(PartialForecastRepository.tool_statuses, ["succeeded", "failed"])
        self.assertEqual(PartialForecastRepository.finished_status, "partial")
        self.assertIsNone(PartialForecastRepository.checkpoint_saved)
        self.assertIn('"cursor_advanced": false', output.getvalue())


class RegistrationRepository(Repository):
    saved_sources: ClassVar[list] = []
    tool_statuses: ClassVar[list] = []

    def company_by_domain(self, domain):
        if domain != "fixture-co.example":
            return None
        return {"id": str(COMPANY_ID), "name": "Fixture Co", "domain": "fixture-co.example"}

    held = None

    def company_hold(self, company_id):
        return type(self).held

    def save_discovered_sources(self, company_id, company_name, sources):
        type(self).saved_sources.extend(sources)
        return [source.as_source_config(company_name) for source in sources]

    def record_tool_call(self, run_id, **kwargs):
        type(self).tool_statuses.append(kwargs["status"])


class BoardTransport:
    requested: ClassVar[list] = []
    body = b'{"name": "Fixture Co", "content": ""}'
    status = 200

    def __init__(self, settings):
        pass

    def get(self, url, *, accept="*/*"):
        from firstseen.adapters.base import FetchedDocument

        type(self).requested.append(url)
        return FetchedDocument(url=url, status=type(self).status, content_type="application/json", body=type(self).body)


@patch.object(cli, "IntelligenceRepository", RegistrationRepository)
@patch.object(cli, "UrlLibTransport", BoardTransport)
class AtsBoardRegistrationTests(unittest.TestCase):
    def setUp(self):
        RegistrationRepository.saved_sources = []
        RegistrationRepository.tool_statuses = []
        BoardTransport.requested = []
        BoardTransport.body = b'{"name": "Fixture Co", "content": ""}'
        BoardTransport.status = 200

    def run_cli(self, *args):
        with patch.object(sys, "argv", ["firstseen", "register-ats-board", *args]), redirect_stdout(StringIO()) as output:
            code = cli.main()
        return code, json.loads(output.getvalue())

    def test_a_board_whose_official_metadata_names_the_company_is_registered_with_provenance(self):
        code, payload = self.run_cli("--company", "fixture-co.example", "--tenant", "fixtureco")

        self.assertEqual(code, 0)
        self.assertEqual(payload["status"], "registered")
        self.assertEqual(BoardTransport.requested, ["https://boards-api.greenhouse.io/v1/boards/fixtureco"])
        (source,) = RegistrationRepository.saved_sources
        self.assertEqual((source.adapter, source.category, source.external_key), ("greenhouse", "ats", "fixtureco"))
        self.assertEqual(source.evidence[0].method, "structured_metadata")
        self.assertIn("Fixture Co", source.evidence[0].quote)
        self.assertEqual(RegistrationRepository.tool_statuses, ["succeeded"])

    def test_a_board_that_names_another_company_is_refused_and_nothing_is_saved(self):
        BoardTransport.body = b'{"name": "Unrelated Holdings", "content": ""}'

        code, payload = self.run_cli("--company", "fixture-co.example", "--tenant", "fixtureco")

        self.assertEqual(code, 1)
        self.assertEqual(payload["reason"], "board_name_mismatch")
        self.assertEqual(RegistrationRepository.saved_sources, [])
        self.assertEqual(RegistrationRepository.tool_statuses, ["failed"])

    def test_a_missing_board_is_refused(self):
        BoardTransport.status = 404
        BoardTransport.body = b"{}"

        code, payload = self.run_cli("--company", "fixture-co.example", "--tenant", "fixtureco")

        self.assertEqual((code, payload["reason"]), (1, "board_not_found"))
        self.assertEqual(RegistrationRepository.saved_sources, [])

    def test_a_malformed_tenant_is_refused_before_any_request(self):
        code, payload = self.run_cli("--company", "fixture-co.example", "--tenant", "../../evil")

        self.assertEqual((code, payload["reason"]), (1, "invalid_tenant"))
        self.assertEqual(BoardTransport.requested, [])

    def test_a_company_whose_collection_is_held_is_refused_before_any_request(self):
        RegistrationRepository.held = {"action": "withdraw", "reason": "Takedown request"}
        try:
            code, payload = self.run_cli("--company", "fixture-co.example", "--tenant", "fixtureco")
        finally:
            RegistrationRepository.held = None

        self.assertEqual((code, payload["reason"]), (1, "company_collection_held"))
        self.assertEqual(BoardTransport.requested, [])
        self.assertEqual(RegistrationRepository.saved_sources, [])

    def test_an_undiscovered_company_is_refused(self):
        code, payload = self.run_cli("--company", "unknown.example", "--tenant", "fixtureco")

        self.assertEqual((code, payload["reason"]), (1, "unknown_company"))
        self.assertEqual(BoardTransport.requested, [])


if __name__ == "__main__":
    unittest.main()


class InsufficientEvidenceForecastRepository(Repository):
    saved_forecasts = 0
    tool_outputs: ClassVar[list[tuple[str, object]]] = []

    def changed_role_ids_since(self, since):
        return [
            UUID("00000000-0000-4000-8000-000000000921"),
            UUID("00000000-0000-4000-8000-000000000922"),
        ]

    def build_current_forecast(self, role_id, *, as_of, dataset=None):
        if str(role_id).endswith("922"):
            from firstseen.forecasting import InsufficientEvidenceError

            raise InsufficientEvidenceError("Sparse role history requires a sourced company or role-family seasonal prior")
        return SimpleNamespace(input_fingerprint="b" * 64)

    def latest_forecast_version(self, role_id):
        return None

    def current_forecast_version(self, role_id):
        return None

    def record_forecast_refusal(self, role_id, *, reason, at):
        type(self).refusals = [*getattr(type(self), "refusals", []), (role_id, reason)]

    def save_agent_forecast_version(self, role_id, forecast, **kwargs):
        type(self).saved_forecasts += 1

    def record_tool_call(self, run_id, *, status, output_redacted=None, **kwargs):
        type(self).tool_outputs.append((status, output_redacted))


class InsufficientEvidenceRegenerationTests(unittest.TestCase):
    def setUp(self):
        InsufficientEvidenceForecastRepository.saved_forecasts = 0
        InsufficientEvidenceForecastRepository.tool_outputs.clear()
        InsufficientEvidenceForecastRepository.finished_status = None
        InsufficientEvidenceForecastRepository.checkpoint_saved = None

    def test_insufficient_evidence_is_a_skip_that_lets_the_cursor_advance(self):
        # On the rebuilt local corpus 2,413 of 2,455 roles raised this, every pass counted each as a
        # failure, and the cursor never advanced.
        output = StringIO()
        with patch.object(cli, "IntelligenceRepository", InsufficientEvidenceForecastRepository), patch.object(
            sys, "argv", ["firstseen", "regenerate-forecasts"]
        ), redirect_stdout(output):
            self.assertEqual(cli.main(), 0)

        repository = InsufficientEvidenceForecastRepository
        self.assertEqual(repository.saved_forecasts, 1)
        self.assertEqual([status for status, _ in repository.tool_outputs], ["succeeded", "succeeded"])
        self.assertEqual(repository.tool_outputs[1][1]["result"], "insufficient_evidence")
        self.assertEqual(repository.finished_status, "succeeded")
        self.assertIsNotNone(repository.checkpoint_saved)
        self.assertIn('"cursor_advanced": true', output.getvalue())
        self.assertIn('"insufficient_evidence": 1', output.getvalue())
        # The refusal is recorded on the role, so a forecast it held before is no longer shown as current.
        self.assertEqual(
            repository.refusals,
            [(UUID("00000000-0000-4000-8000-000000000922"), "Sparse role history requires a sourced company or role-family seasonal prior")],
        )


class RefusedThenForecastRepository(InsufficientEvidenceForecastRepository):
    """A role declined after its last version, now forecast again from the same inputs as that version."""

    def changed_role_ids_since(self, since):
        return [UUID("00000000-0000-4000-8000-000000000921")]

    def latest_forecast_version(self, role_id):
        return SimpleNamespace(id=UUID("00000000-0000-4000-8000-00000000f921"), forecast=SimpleNamespace(input_fingerprint="b" * 64))


class ForecastAfterRefusalTests(unittest.TestCase):
    def test_the_same_inputs_as_a_superseded_version_still_make_the_role_current_again(self):
        RefusedThenForecastRepository.saved_forecasts = 0
        RefusedThenForecastRepository.tool_outputs = []
        output = StringIO()
        with patch.object(cli, "IntelligenceRepository", RefusedThenForecastRepository), patch.object(
            sys, "argv", ["firstseen", "regenerate-forecasts"]
        ), redirect_stdout(output):
            self.assertEqual(cli.main(), 0)
        # current_forecast_version is None (declined since), so an unchanged fingerprint is not "unchanged".
        self.assertEqual(RefusedThenForecastRepository.saved_forecasts, 1)
        self.assertIn('"unchanged_input_fingerprints": 0', output.getvalue())


class ScopedForecastRepository(ManyRoleForecastRepository):
    """Three changed roles, one of them in scope."""

    role_count = 3

    def in_scope_role_ids(self):
        return {UUID("00000000-0000-4000-8000-000000000920")}


class RegenerationScopeTests(unittest.TestCase):
    def setUp(self):
        ScopedForecastRepository.saved_forecasts = 0

    def test_only_in_scope_roles_are_forecast_and_the_rest_are_counted(self):
        output = StringIO()
        with patch.object(cli, "IntelligenceRepository", ScopedForecastRepository), redirect_stdout(output):
            cli.regenerate_changed_forecasts()

        text = output.getvalue()
        summary = json.loads(text[text.index("{") :])
        self.assertEqual(
            (summary["roles_changed"], summary["out_of_scope_skipped"], summary["forecasts_regenerated"]), (3, 2, 1)
        )
        self.assertEqual(ScopedForecastRepository.saved_forecasts, 1)
