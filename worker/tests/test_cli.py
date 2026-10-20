import json
import sys
import unittest
from contextlib import redirect_stdout
from dataclasses import replace
from datetime import timedelta
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from typing import ClassVar
from unittest.mock import patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from firstseen import cli
from firstseen.enrichment_fingerprints import EnrichmentFingerprint


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

    def buffer_model_attempts(self):
        type(self).model_attempts_buffered = True

    def cache_company_roles(self):
        type(self).company_roles_cached = True

    def company_enrichment_fingerprints(self, company_ids):
        return {}

    def company_enrichment_parts(self, company_ids):
        return {}

    def enrichment_noop_keys(self):
        return {}

    def enrichment_noop_state(self):
        return {}, {}

    def save_enrichment_noop_keys(self, keys, *, run_id, parts=None):
        type(self).noop_keys_saved = dict(keys)

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


class IncrementalKeyRepository(Repository):
    """Records every save, so a save-per-company is distinguishable from one save at the end."""

    saves: ClassVar[list[dict[str, str]]] = []
    fingerprints: ClassVar[dict] = {}

    def __init__(self) -> None:
        IncrementalKeyRepository.saves = []

    def company_enrichment_fingerprints(self, company_ids):
        return {company_id: "stable" for company_id in company_ids}

    def company_enrichment_parts(self, company_ids):
        return {
            company_id: EnrichmentFingerprint(fingerprint="stable", parts={"observations": "stable"})
            for company_id in company_ids
        }

    def enrichment_noop_keys(self):
        return {}

    def enrichment_noop_state(self):
        return {}, {}

    def save_enrichment_noop_keys(self, keys, *, run_id, parts=None):
        IncrementalKeyRepository.saves.append(dict(keys))

    def record_tool_call(self, run_id, **kwargs):
        return None


class EnrichmentKeysSurviveAKilledRunTests(unittest.TestCase):
    """A collection run killed at its 45-minute timeout must keep the keys it had already learned.

    The single save after the loop was never reached when the job was killed from outside, so a cancelled run had
    moved every company's fingerprint by enriching it and recorded none of the stabilisation. That destroys
    convergence rather than pausing it, and the skip needs three consecutive completed passes to converge: measured
    on the rig, 0 then 21 then 58 of 58 companies skipped, with the pass going from 165.6 s to 1.1 s. Six of the
    eight collection runs to 2026-10-16 were cancelled, which is why `companies_unchanged` read 0 for weeks.
    """

    def test_a_key_is_saved_as_each_company_stabilises(self) -> None:
        repository = IncrementalKeyRepository()
        companies = [UUID(int=index) for index in range(1, 5)]

        from firstseen.enrichment import EnrichmentSummary

        class Service:
            def enrich_company(self, company_id):
                return EnrichmentSummary(
                    company_id=company_id,
                    observations_considered=0,
                    roles_matched=0,
                    roles_created=0,
                    resolution_failures=0,
                    roles_reconstructed=0,
                    events_persisted=0,
                    reconstruction_failures=0,
                    degraded_capture_sources=0,
                )

        with (
            patch.object(cli, "EvidenceEnrichmentService", lambda *args, **kwargs: Service()),
            patch.object(cli, "worker_fingerprint", lambda settings: "worker"),
            patch.object(cli, "get_settings", lambda: SimpleNamespace()),
            patch.object(cli, "RoleResolver", lambda **kwargs: None),
            patch.object(cli, "RoleScopeService", lambda *args, **kwargs: None),
            patch.object(cli, "RoleScopeClassifier", lambda *args, **kwargs: None),
            patch.object(cli, "LlmRoleClassifier", lambda *args, **kwargs: None),
            patch.object(cli, "LlmScopeClassifier", lambda *args, **kwargs: None),
        ):
            cli._enrich_companies(
                repository, companies, run_id=UUID(int=99), router=SimpleNamespace(client=lambda *a, **k: None)
            )

        # One save per company that stabilised, not one at the end: a run killed after the second company keeps two.
        self.assertGreater(len(IncrementalKeyRepository.saves), 1, "the keys are still saved only once, at the end")
        self.assertEqual(len(IncrementalKeyRepository.saves), len(companies))
        for index, saved in enumerate(IncrementalKeyRepository.saves, start=1):
            self.assertEqual(len(saved), index, "each save carries every key learned so far")


class RetirementRepository(Repository):
    """Enough of the repository for retirement: the enabled sources and their refusal streaks."""

    disabled: ClassVar[list[tuple[str, str]]] = []

    def __init__(self) -> None:
        RetirementRepository.disabled = []

    def list_source_configs(self, company=None):
        from firstseen.adapters.base import SourceConfig

        def source(index, url):
            return SourceConfig(
                id=UUID(int=index), company_id=UUID(int=900), company="Fixture",
                adapter="generic", url=url, trust_score=0.9,
            )

        # One refused page, and nine the rules allow, so the refused fraction is a tenth.
        return [source(1, "https://vercel.com/passport")] + [
            source(index, f"https://fixture{index}.example/careers") for index in range(2, 11)
        ]

    def source_refusal_streaks(self, days=30):
        return [{"source_id": str(UUID(int=1)), "consecutive_refusals": 5, "rule": None, "last_attempt": None}]


class RetirementTests(unittest.TestCase):
    """Retirement is the rules acting on themselves, which is why it is not 132 stored disables.

    A refusal is a live decision re-evaluated every run; a disable is a stored one that sticks. Converting the 132
    sources the rules refuse today into stored disables would freeze today's rules into the database, and when the
    rules widen again -- September 112, October 132 -- the stored ones would not follow.
    """

    def _run(self, **kwargs):
        from firstseen import cli as module

        captured = StringIO()
        with (
            patch.object(module.IntelligenceRepository, "from_settings", lambda settings: RetirementRepository()),
            patch.object(module, "get_settings", lambda: SimpleNamespace()),
            patch.object(module, "TakedownService", lambda repository: SimpleNamespace(
                disable=lambda **call: RetirementRepository.disabled.append((str(call["source_id"]), call["reason"])))),
            redirect_stdout(captured),
        ):
            code = module.retire_refused_sources(**kwargs)
        return code, json.loads(captured.getvalue())

    def test_the_first_run_reports_and_changes_nothing(self) -> None:
        code, report = self._run(min_refusals=3, max_fraction=0.10, apply=False, by="tester")
        self.assertEqual(code, 0)
        self.assertEqual(report["status"], "reported")
        self.assertFalse(report["applied"])
        self.assertEqual(report["candidates"], 1)
        self.assertEqual(report["by_rule"], {"off_the_recruiting_path": 1})
        self.assertEqual(RetirementRepository.disabled, [], "a report retired something")
        # Every candidate is listed, grouped by rule and then company: a backlog is cleared by reading it, and 104
        # of 438 is an accumulated past rather than a rule change, so counts alone are not enough to judge it.
        grouped = report["by_rule_and_company"]
        self.assertEqual(list(grouped), ["off_the_recruiting_path"])
        self.assertEqual(list(grouped["off_the_recruiting_path"]), ["Fixture"])
        listed = [row for companies in grouped.values() for rows in companies.values() for row in rows]
        self.assertEqual(len(listed), report["candidates"], "the list is truncated against its own count")
        self.assertEqual(listed[0]["url"], "https://vercel.com/passport")
        self.assertEqual(listed[0]["consecutive_refusals"], 5)

    def test_the_audit_reason_names_the_rule(self) -> None:
        code, report = self._run(min_refusals=3, max_fraction=0.50, apply=True, by="tester")
        self.assertEqual(code, 0)
        self.assertEqual(report["retired"], 1)
        self.assertEqual(len(RetirementRepository.disabled), 1)
        _, reason = RetirementRepository.disabled[0]
        self.assertIn("off_the_recruiting_path", reason)
        self.assertIn("5 consecutive", reason)

    def test_too_large_a_fraction_stops_rather_than_proceeding(self) -> None:
        """A bad rule must not be able to quietly empty the source list."""
        code, report = self._run(min_refusals=3, max_fraction=0.05, apply=True, by="tester")
        self.assertEqual(code, 1)
        self.assertEqual(report["status"], "refused")
        self.assertEqual(report["reason"], "too_large_a_fraction")
        self.assertFalse(report["applied"])
        self.assertEqual(RetirementRepository.disabled, [], "the guard let a retirement through")

    def test_a_source_whose_address_was_fixed_is_not_retired_on_an_old_attempt(self) -> None:
        """The rule is named from the address now, not from a diagnostic a past run recorded."""

        class Fixed(RetirementRepository):
            def list_source_configs(self, company=None):
                from firstseen.adapters.base import SourceConfig

                return [SourceConfig(id=UUID(int=1), company_id=UUID(int=900), company="Fixture",
                                     adapter="generic", url="https://fixture.example/careers", trust_score=0.9)]

        from firstseen import cli as module

        captured = StringIO()
        with (
            patch.object(module.IntelligenceRepository, "from_settings", lambda settings: Fixed()),
            patch.object(module, "get_settings", lambda: SimpleNamespace()),
            patch.object(module, "TakedownService", lambda repository: SimpleNamespace(
                disable=lambda **call: RetirementRepository.disabled.append((str(call["source_id"]), call["reason"])))),
            redirect_stdout(captured),
        ):
            module.retire_refused_sources(min_refusals=3, max_fraction=0.9, apply=True, by="tester")
        self.assertEqual(json.loads(captured.getvalue())["candidates"], 0)
        self.assertEqual(RetirementRepository.disabled, [])


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


def _two_days_apart():
    """The same evidence forecast a day apart: different fingerprints, identical to a reader."""
    from datetime import date as _date

    from firstseen.forecasting import HistoricalOpening, SeasonalityPrior, forecast_opening_window

    history = [
        HistoricalOpening(_date(2022, 9, 11), 0.9, evidence_id="h22"),
        HistoricalOpening(_date(2023, 9, 15), 1.0, evidence_id="h23"),
        HistoricalOpening(_date(2024, 9, 8), 1.0, evidence_id="h24"),
        HistoricalOpening(_date(2025, 9, 13), 1.0, evidence_id="h25"),
    ]
    prior = SeasonalityPrior(
        "season", 9, 12, spread_days=13, effective_sample_size=8, quality=0.9, evidence_ids=("p1",)
    )
    today = forecast_opening_window(history, as_of=_date(2026, 6, 1), company_prior=prior)
    tomorrow = forecast_opening_window(history, as_of=_date(2026, 6, 2), company_prior=prior)
    return today, tomorrow


STORED_TODAY, RECOMPUTED_TOMORROW = _two_days_apart()
STORED_ID = UUID("00000000-0000-4000-8000-0000000009f1")


class UnchangedDisplayRepository(ManyRoleForecastRepository):
    """A role whose recompute differs only in what no reader sees."""

    role_count = 3
    verified: ClassVar[list] = []

    def build_current_forecast(self, role_id, *, as_of, dataset=None):
        return RECOMPUTED_TOMORROW

    def current_forecast_version(self, role_id):
        return SimpleNamespace(id=STORED_ID, forecast=STORED_TODAY)

    def latest_forecast_version(self, role_id):
        return SimpleNamespace(id=STORED_ID, forecast=STORED_TODAY)

    def mark_forecasts_verified(self, forecast_ids, *, at):
        type(self).verified = list(forecast_ids)
        return len(type(self).verified)


class ChangedDisplayRepository(UnchangedDisplayRepository):
    """A role whose window actually moved."""

    def current_forecast_version(self, role_id):
        moved = replace(STORED_TODAY, point_date=STORED_TODAY.point_date + timedelta(days=30))
        return SimpleNamespace(id=STORED_ID, forecast=moved)

    def latest_forecast_version(self, role_id):
        return self.current_forecast_version(role_id)


class VerifiedInsteadOfDuplicatedTests(unittest.TestCase):
    """`as_of` is a forecast input, so the clock alone used to store a version a day for every role.

    66,560 forecast_evidence rows in 24 hours against 658 in-scope roles, measured on 2026-09-24. A recompute that a
    reader could not tell apart is now recorded on the row that exists instead of duplicating it.
    """

    def setUp(self):
        UnchangedDisplayRepository.saved_forecasts = 0
        UnchangedDisplayRepository.verified = []
        ChangedDisplayRepository.saved_forecasts = 0
        ChangedDisplayRepository.verified = []

    def test_an_identical_recompute_stores_nothing_and_is_recorded_as_verified(self):
        out = StringIO()
        with patch.object(cli, "IntelligenceRepository", UnchangedDisplayRepository), redirect_stdout(out):
            cli.regenerate_changed_forecasts()

        self.assertEqual(UnchangedDisplayRepository.saved_forecasts, 0, "a day passing is not a new version")
        # Every role's stored forecast is recorded as checked, in one batched write rather than one call per role.
        self.assertEqual(UnchangedDisplayRepository.verified, [STORED_ID] * UnchangedDisplayRepository.role_count)
        summary = json.loads(out.getvalue())
        self.assertEqual(summary["unchanged_displayed_forecasts"], UnchangedDisplayRepository.role_count)
        self.assertEqual(summary["forecasts_verified"], UnchangedDisplayRepository.role_count)
        self.assertEqual(summary["forecasts_regenerated"], 0)

    def test_a_forecast_whose_window_moved_is_still_stored(self):
        out = StringIO()
        with patch.object(cli, "IntelligenceRepository", ChangedDisplayRepository), redirect_stdout(out):
            cli.regenerate_changed_forecasts()

        self.assertEqual(ChangedDisplayRepository.saved_forecasts, ChangedDisplayRepository.role_count)
        self.assertEqual(ChangedDisplayRepository.verified, [], "a stored version carries its own verification")
        self.assertEqual(json.loads(out.getvalue())["unchanged_displayed_forecasts"], 0)


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
        run_ingestion.assert_called_once_with(None, collection="historical", max_seconds=None)

    @patch.object(cli, "IntelligenceRepository", Repository)
    def test_ingestion_enriches_the_companies_it_collected(self):
        # Collection alone cannot produce a forecast, so the same pass must derive
        # the canonical-role and historical-event records forecasting depends on.
        with (
            patch.object(cli, "_enrich_companies", return_value=([], 0, 0, {}, 0)) as enrich,
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

    def get(self, url, *, accept="*/*", max_bytes=None):
        from firstseen.adapters.base import FetchedDocument

        type(self).requested.append(url)
        type(self).max_bytes = max_bytes
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
        # The board's metadata names the company; the postings endpoint is what collection fetches every run, so its
        # size is what a per-source read limit has to cover (SpaceX's board is far past the 10 MB cap).
        self.assertEqual(
            BoardTransport.requested,
            [
                "https://boards-api.greenhouse.io/v1/boards/fixtureco",
                "https://boards-api.greenhouse.io/v1/boards/fixtureco/jobs?content=true",
            ],
        )
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


class TextTrimLoopTests(unittest.TestCase):
    """The trim calls until nothing is left or its budget is spent, and says which happened.

    Measuring never stops it: one run died inside the measurement before shortening anything.

    PostgREST connects under an eight-second statement timeout, so one call shortens a chunk: the first scheduled run
    to call the unchunked version failed with 57014 and changed nothing. A run that stops early is not a failure, since
    every call is idempotent and the next run continues.
    """

    class TrimRepository:
        """Reports work remaining for the first few calls, then none."""

        def __init__(self, rounds: int) -> None:
            self.rounds = rounds
            self.calls = 0
            self.byte_calls = 0

        @classmethod
        def from_settings(cls, settings):
            return cls(3)

        def corpus_text_sizes(self):
            self.byte_calls += 1
            text = 9_000_000 if self.byte_calls == 1 else 2_000_000
            return [
                {
                    "table_name": "raw_job_observations", "heap_bytes": 1_000_000, "toast_bytes": text,
                    "index_bytes": 500_000, "total_bytes": 1_500_000 + text,
                    "database_bytes": 300_000_000 + self.byte_calls,
                }
            ]

        def trim_out_of_scope_text(self, *, keep=300, limit=200):
            self.calls += 1
            left = max(0, self.rounds - self.calls)
            return {
                "observations": 200 if left else 7, "roles": 200 if left else 3, "events": 200 if left else 1,
                "remaining_observations": left, "remaining_roles": 0, "remaining_events": 0,
            }

    def run_trim(self, repository, **kwargs):
        with patch.object(cli.IntelligenceRepository, "from_settings", staticmethod(lambda settings: repository)), \
             redirect_stdout(StringIO()) as output:
            code = cli.run_text_trim(300, **kwargs)
        return code, json.loads(output.getvalue())

    def test_it_calls_until_nothing_is_left(self):
        repository = self.TrimRepository(3)
        code, payload = self.run_trim(repository)
        self.assertEqual(code, 0)
        self.assertEqual(repository.calls, 3)
        self.assertTrue(payload["finished"])
        self.assertEqual(payload["shortened"], {"observations": 407, "roles": 403, "events": 401})
        # A table's long text is its TOAST table, and that is what shortening the text moves.
        self.assertEqual(payload["before_mb"]["raw_job_observations"]["text"], 9.0)
        self.assertEqual(payload["after_mb"]["raw_job_observations"]["text"], 2.0)
        self.assertIn("trim_seconds", payload)

    def test_a_measurement_that_fails_does_not_stop_the_trim(self):
        """The 16:05 UTC run on 2026-09-20 died inside the measurement, before shortening anything, twice over."""

        class NoSizes(self.TrimRepository):
            def corpus_text_sizes(self):
                raise RuntimeError("summing the text does not finish in eight seconds")

        repository = NoSizes(3)
        code, payload = self.run_trim(repository)
        self.assertEqual(code, 0)
        self.assertEqual(repository.calls, 3, "the trim still ran to completion")
        self.assertTrue(payload["finished"])
        self.assertEqual(payload["before_mb"], {}, "and says it could not measure rather than pretending")

    def test_a_spent_budget_stops_it_and_says_what_is_left(self):
        repository = self.TrimRepository(500)
        code, payload = self.run_trim(repository, max_seconds=0.0)
        self.assertEqual(code, 0, "stopping early is not a failure")
        self.assertEqual(repository.calls, 0)
        self.assertFalse(payload["finished"])

    def test_the_two_size_readings_are_the_ends_not_every_call(self):
        repository = self.TrimRepository(3)
        self.run_trim(repository)
        self.assertEqual(repository.byte_calls, 2)


class DeterministicRunTests(unittest.TestCase):
    """A collection run states whether any model answered it.

    GitHub Actions configures no provider, so every extraction and classification is deterministic. That is the normal
    deployment, and a run that says nothing about it leaves a reader to infer it from an absence.
    """

    @patch.object(cli, "IntelligenceRepository", Repository)
    def test_the_summary_carries_the_model_state(self):
        with patch.object(sys, "argv", ["firstseen", "ingest", "--all"]), redirect_stdout(StringIO()) as output:
            self.assertEqual(cli.main(), 0)
        summary = json.loads(output.getvalue())
        self.assertIn("models", summary)
        self.assertEqual(summary["models"]["attempts"], 0)
        self.assertTrue(summary["models"]["deterministic_only"])
        self.assertIn("deterministic", summary["models"]["note"])


class HistoricalSliceRepository(Repository):
    """Three Wayback sources with different last-fetch times, plus two current sources that must be left alone."""

    ingested: ClassVar[list[str]] = []

    def list_source_configs(self, company):
        def source(number, adapter):
            return SimpleNamespace(
                id=UUID(f"00000000-0000-4000-8000-0000000009{number:02d}"),
                company_id=UUID(f"00000000-0000-4000-8000-0000000001{number:02d}"),
                adapter=adapter,
            )

        return [source(1, "wayback"), source(2, "greenhouse"), source(3, "wayback"), source(4, "wayback")]

    def source_fetch_times(self):
        from datetime import UTC, datetime

        return {
            UUID("00000000-0000-4000-8000-000000000901"): datetime(2026, 9, 18, tzinfo=UTC),
            UUID("00000000-0000-4000-8000-000000000903"): None,
            UUID("00000000-0000-4000-8000-000000000904"): datetime(2026, 9, 10, tzinfo=UTC),
        }

    def record_tool_call(self, run_id, **kwargs):
        return None


class HistoricalRotationTests(unittest.TestCase):
    """The weekly historical run takes the least recently collected sources first and stops when its budget is spent.

    One archived company took 497 s on hosted, so the 50 configured Wayback sources cannot all run in one 90-minute
    job. Ordering by last fetch makes consecutive runs rotate through every company with no cursor to keep, and the
    sources left over are reported rather than counted as failures.
    """

    def ingest(self, max_seconds, clock):
        HistoricalSliceRepository.ingested = []

        class Service:
            def __init__(self, *args, **kwargs):
                pass

            def ingest(self, source, *, observed_at):
                HistoricalSliceRepository.ingested.append(str(source.id)[-3:])
                return SimpleNamespace(
                    detected=0, created=0, changed=0, unchanged=0, complete=True, diagnostics=[],
                    page_unchanged=False, document_hash="a" * 64,
                )

        with (
            patch.object(cli, "IntelligenceRepository", HistoricalSliceRepository),
            patch.object(cli, "SourceIngestionService", Service),
            patch.object(cli, "_enrich_companies", lambda *args, **kwargs: ([], 0, 0, {}, 0)),
            patch.object(cli.time, "monotonic", side_effect=clock),
            redirect_stdout(StringIO()) as output,
        ):
            code = cli.run_ingestion(None, collection="historical", max_seconds=max_seconds)
        return code, json.loads(output.getvalue())

    def test_the_least_recently_collected_wayback_sources_run_first(self):
        _, payload = self.ingest(None, lambda: 0.0)
        # Never fetched first, then oldest fetch, then newest. The Greenhouse source is not a historical source.
        self.assertEqual(HistoricalSliceRepository.ingested, ["903", "904", "901"])
        self.assertEqual(payload["sources"], 3)
        self.assertEqual(payload["sources_deferred_to_next_run"], 0)

    def test_the_budget_leaves_the_rest_for_the_next_run_without_failing(self):
        # The clock passes the budget after the first source, so the second is never started.
        seconds = iter([0.0, 0.0])  # the run starts, the first source is inside the budget, then time is up
        _, payload = self.ingest(5.0, lambda: next(seconds, 10.0))
        self.assertEqual(HistoricalSliceRepository.ingested, ["903"])
        self.assertEqual(payload["sources"], 1)
        self.assertEqual(payload["sources_deferred_to_next_run"], 2)
        self.assertEqual(payload["status"], "succeeded", "sources left for next week are not a failure")
