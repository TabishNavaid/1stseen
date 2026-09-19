"""End-to-end regression: collected evidence must reach forecast generation.

Uses offline adapter fixtures only. No network access and no hand-written role
match, historical event, or forecast rows: every intermediate record below is
derived by the production orchestration path.
"""

import sys
import unittest
from datetime import UTC, date, datetime
from pathlib import Path
from types import SimpleNamespace
from uuid import NAMESPACE_URL, UUID, uuid5

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from firstseen.adapters.base import FetchedDocument, SourceConfig
from firstseen.adapters.registry import AdapterRegistry
from firstseen.adapters.structured import GreenhouseAdapter
from firstseen.adapters.wayback import WaybackAdapter
from firstseen.backtesting import BacktestEvent, collapse_event_cycles
from firstseen.enrichment import EvidenceEnrichmentService
from firstseen.forecasting import (
    HierarchicalCircularForecastModel,
    HistoricalOpening,
    SeasonalityPrior,
)
from firstseen.history import RecurringRoleIdentity
from firstseen.source_ingestion import MemoryObservationStore, SourceIngestionService

FIXTURES = Path(__file__).with_name("fixtures")
COMPANY_ID = UUID("00000000-0000-4000-8000-000000000001")
ARCHIVE_SOURCE_ID = UUID("00000000-0000-4000-8000-000000000701")
BOARD_SOURCE_ID = UUID("00000000-0000-4000-8000-000000000702")
OBSERVED_AT = datetime(2026, 8, 14, 10, tzinfo=UTC)
GREENHOUSE_URL = "https://boards-api.greenhouse.io/v1/boards/fixture/jobs?content=true"


def fixture(name):
    return (FIXTURES / name).read_bytes()


class FakeTransport:
    def __init__(self, responses):
        self.responses = responses

    def get(self, url, *, accept="*/*"):
        body, content_type = self.responses[url]
        return FetchedDocument(url=url, status=200, content_type=content_type, body=body)


def archive_source():
    return SourceConfig(
        id=ARCHIVE_SOURCE_ID,
        company_id=COMPANY_ID,
        company="Fixture Robotics",
        adapter="wayback",
        url="https://careers.fixture.example/students",
        trust_score=0.85,
        options={"include_subpaths": True, "from": 2022, "to": 2024},
    )


def board_source():
    return SourceConfig(
        id=BOARD_SOURCE_ID,
        company_id=COMPANY_ID,
        company="Fixture Robotics",
        adapter="greenhouse",
        url="https://boards.example.test",
        external_key="fixture",
        trust_score=0.95,
    )


def archive_transport():
    adapter = WaybackAdapter()
    configured = archive_source()
    snapshots = {
        "20220801090000": ("wayback_no_role.html", "https://careers.fixture.example/students"),
        "20220910120000": ("wayback_role_2022.html", "https://careers.fixture.example/students"),
        "20220920120000": ("wayback_role_2022_noise.html", "https://careers.fixture.example/students"),
        "20230901090000": ("wayback_no_role.html", "https://careers.fixture.example/students"),
        "20230914100000": (
            "wayback_changed_job_url.html",
            "https://jobs.fixture.example/software-engineering-intern",
        ),
        "20240918100000": ("wayback_role_2024.html", "https://careers.fixture.example/students"),
    }
    responses = {
        adapter.cdx_url(str(configured.url), configured): (
            fixture("wayback_cdx.json"),
            "application/json",
        )
    }
    for timestamp, (name, original) in snapshots.items():
        responses[adapter.archive_url(timestamp, original)] = (fixture(name), "text/html")
    responses[GREENHOUSE_URL] = (fixture("greenhouse.json"), "application/json")
    return FakeTransport(responses)


class PipelineStore(MemoryObservationStore):
    """In-memory system of record implementing collection and enrichment contracts."""

    def __init__(self):
        super().__init__()
        self.role_matches = {}
        self.attributions = {}
        self.canonical_roles = {}
        self.aliases = {}
        self.historical_events = {}
        self.degraded = set()
        self.observation_ids = {}

    def match_confidence_for(self, observation_id):
        if observation_id in self.role_matches:
            return self.role_matches[observation_id].match_confidence
        pair = next((v for (obs, _), v in self.attributions.items() if obs == observation_id), None)
        return pair[1] if pair else 1.0

    # -- collection -----------------------------------------------------
    def upsert_job(self, observation):
        if observation.id is None:
            # Persistence assigns a stable identity, mirroring the unique
            # (source_id, identity_key) constraint in Postgres.
            observation = observation.model_copy(
                update={
                    "id": uuid5(
                        NAMESPACE_URL,
                        f"observation:{observation.source_id}:{observation.identity_key}",
                    )
                }
            )
        status = super().upsert_job(observation)
        self.observation_ids[observation.id] = observation
        return status

    # -- enrichment inputs ----------------------------------------------
    def list_unresolved_observations(self, company_id):
        return sorted(
            (
                item
                for item in self.observation_ids.values()
                if not self.role_match_exists(item.id)
            ),
            key=lambda item: (item.first_seen_at, str(item.id)),
        )

    def list_canonical_roles_for_resolution(self, company_id):
        return [
            role.model_copy(update={"aliases": sorted(self.aliases.get(role.id, set()))})
            for role in self.canonical_roles.values()
        ]

    def role_match_exists(self, observation_id):
        return observation_id in self.role_matches or any(
            obs == observation_id for obs, _ in self.attributions
        )

    def role_evidence_exists(self, observation_id, role_id):
        if observation_id in self.role_matches:
            return self.role_matches[observation_id].canonical_role.id == role_id
        return self.attributions.get((observation_id, role_id)) is not None

    def save_role_resolution(self, resolution):
        self.canonical_roles[resolution.canonical_role.id] = resolution.canonical_role
        self.aliases.setdefault(resolution.canonical_role.id, set()).add(resolution.observed_alias)
        self.role_matches[resolution.observation_id] = resolution

    def list_recurring_roles(self, company_id):
        return [
            RecurringRoleIdentity(
                id=role.id,
                company_id=role.company_id,
                company="Fixture Robotics",
                canonical_title=role.canonical_title,
                track="internship",
                aliases=sorted(self.aliases.get(role.id, set())),
            )
            for role in self.canonical_roles.values()
        ]

    def list_role_observations(self, role_id):
        linked = {
            observation_id
            for observation_id, match in self.role_matches.items()
            if match.canonical_role.id == role_id
        } | {
            obs for (obs, role), _ in self.attributions.items() if role == role_id
        }
        return [
            self.observation_ids[observation_id]
            for observation_id in linked
            if observation_id in self.observation_ids
        ]

    def list_company_archive_captures(self, company_id):
        return sorted(self.archive_captures.values(), key=lambda item: item.captured_at)

    def list_historical_events(self, role_id):
        return [
            event
            for event in self.historical_events.values()
            if event.canonical_role_id == role_id
        ]

    def save_historical_openings(self, events):
        for event in events:
            # Natural key, matching the unique constraint the repository upserts on.
            key = (event.canonical_role_id, event.opened_on, event.observation_id)
            self.historical_events[key] = event

    def link_observation_to_role(self, observation_id, role_id, *, match_confidence, rationale):
        # Keyed by the pair: one archived page is evidence for many roles.
        self.attributions[(observation_id, role_id)] = (role_id, match_confidence, rationale)

    def degraded_source_ids(self, company_id):
        return set(self.degraded)


def collect_and_enrich(*, degraded_archive=False):
    store = PipelineStore()
    transport = archive_transport()
    registry = AdapterRegistry([WaybackAdapter(), GreenhouseAdapter()])
    service = SourceIngestionService(registry, transport, store)
    service.ingest(board_source(), observed_at=OBSERVED_AT)
    service.ingest(archive_source(), observed_at=OBSERVED_AT)
    if degraded_archive:
        store.degraded.add(ARCHIVE_SOURCE_ID)
    summary = EvidenceEnrichmentService(store).enrich_company(COMPANY_ID)
    return store, summary


class PipelineIntegrationTests(unittest.TestCase):
    def test_collected_evidence_becomes_role_matches_and_opening_history(self):
        store, summary = collect_and_enrich()

        self.assertTrue(store.observation_ids, "collection produced no observations")
        self.assertTrue(store.archive_captures, "collection produced no archive captures")
        self.assertTrue(summary.complete)
        self.assertTrue(store.role_matches, "no observation_role_matches were derived")
        self.assertTrue(store.canonical_roles, "no canonical role identity was derived")
        self.assertTrue(store.historical_events, "no historical_opening_events were derived")

        # Every derived event keeps a mandatory observation link and provenance.
        for event in store.historical_events.values():
            self.assertIsNotNone(event.observation_id)
            self.assertGreaterEqual(len(event.provenance), 1)
            self.assertTrue(event.uncertainty_reason)
            self.assertIn(event.date_precision, {"exact", "bounded", "observed_by"})

        # Every event's observation carries a persisted role match, which is the
        # precondition the backtest/forecast loader enforces.
        for event in store.historical_events.values():
            # The loader requires evidence for this exact observation/role pair.
            self.assertTrue(
                store.role_evidence_exists(event.observation_id, event.canonical_role_id),
                "a historical event has no persisted role evidence for its own role",
            )

        # Archived page anchors never become canonical roles of their own.
        for role in store.canonical_roles.values():
            self.assertNotIn("archived recruiting page", role.canonical_title.casefold())

    def test_bounded_uncertainty_is_preserved_and_not_flattened_to_exact(self):
        store, _ = collect_and_enrich()
        precisions = {event.date_precision for event in store.historical_events.values()}
        self.assertIn("bounded", precisions, "archive absence/presence produced no bounded event")
        for event in store.historical_events.values():
            if event.date_precision == "bounded":
                self.assertIsNotNone(event.opening_window_start)
                self.assertGreater(event.uncertainty_days, 0)
                self.assertLessEqual(event.opening_window_start, event.opened_on)
                self.assertGreaterEqual(event.opening_window_end, event.opened_on)
            if event.date_precision == "observed_by":
                self.assertIsNone(event.opening_window_start)

    def test_derived_history_produces_a_statistical_forecast(self):
        store, _ = collect_and_enrich()
        openings = [
            HistoricalOpening(
                opened_on=event.opened_on,
                source_quality=event.source_quality,
                uncertainty_days=event.uncertainty_days,
                evidence_id=str(event.observation_id),
                date_precision=event.date_precision,
                role_match_confidence=store.match_confidence_for(event.observation_id),
            )
            for event in store.historical_events.values()
        ]
        self.assertGreaterEqual(len(openings), 2)
        prior = (
            SeasonalityPrior.from_history("company seasonality", openings)
            if len(openings) < 3
            else None
        )
        forecast = HierarchicalCircularForecastModel().forecast(
            openings,
            (),
            as_of=date(2026, 8, 14),
            company_prior=prior,
        )
        self.assertGreater(forecast.window_end, forecast.window_start)
        self.assertLessEqual(forecast.window_start, forecast.point_date)
        self.assertGreaterEqual(forecast.confidence, 0)
        self.assertLessEqual(forecast.calibrated_probability, 0.92)
        self.assertEqual(forecast.sample_size, len(openings))
        self.assertTrue(forecast.input_fingerprint)

    def test_derived_events_satisfy_the_leakage_safe_loader_contract(self):
        store, _ = collect_and_enrich()
        # Availability mirrors production: the event row, its linked observation, and
        # the role match each carry their own timestamp, and admission uses the max.
        event_available = datetime(2026, 1, 5, tzinfo=UTC)
        observation_available = datetime(2026, 3, 9, tzinfo=UTC)
        match_available = datetime(2026, 6, 21, tzinfo=UTC)
        events = [
            BacktestEvent(
                id=str(event.id),
                role_id=str(event.canonical_role_id),
                opened_on=event.opened_on,
                available_at=event_available,
                source_quality=event.source_quality,
                uncertainty_days=event.uncertainty_days,
                observation_id=str(event.observation_id),
                date_precision=event.date_precision,
                observation_available_at=observation_available,
                role_match_confidence=store.match_confidence_for(event.observation_id),
                role_match_available_at=match_available,
                opening_window_start=event.opening_window_start,
                opening_window_end=event.opening_window_end,
            )
            for event in store.historical_events.values()
        ]
        self.assertTrue(events)
        for event in events:
            self.assertEqual(event.effective_available_at, match_available)
            # Null uncertainty on one-sided evidence must never become numeric zero.
            if event.date_precision == "observed_by":
                self.assertIsNone(event.uncertainty_days)
                self.assertIsNone(event.scoring_interval)
        self.assertEqual(
            len(collapse_event_cycles(events)),
            len({(item.role_id, item.opened_on.year) for item in events}),
        )

    def test_role_match_confidence_propagates_into_forecast_weighting(self):
        store, _ = collect_and_enrich()
        events = list(store.historical_events.values())

        def forecast_with(confidence):
            openings = [
                HistoricalOpening(
                    opened_on=event.opened_on,
                    source_quality=event.source_quality,
                    uncertainty_days=event.uncertainty_days,
                    evidence_id=str(event.observation_id),
                    date_precision=event.date_precision,
                    role_match_confidence=confidence,
                )
                for event in events
            ]
            return HierarchicalCircularForecastModel().forecast(
                openings,
                (),
                as_of=date(2026, 8, 14),
                company_prior=SeasonalityPrior.from_history("company seasonality", openings)
                if len(openings) < 3
                else None,
            )

        confident = forecast_with(1.0)
        uncertain = forecast_with(0.4)
        self.assertGreater(
            confident.confidence_factors["source_quality"],
            uncertain.confidence_factors["source_quality"],
        )
        self.assertNotEqual(confident.input_fingerprint, uncertain.input_fingerprint)

    def test_reruns_are_idempotent_and_create_no_duplicates(self):
        store, first = collect_and_enrich()
        roles_before = dict(store.canonical_roles)
        matches_before = dict(store.role_matches)
        events_before = dict(store.historical_events)

        second = EvidenceEnrichmentService(store).enrich_company(COMPANY_ID)

        self.assertEqual(second.observations_considered, 0)
        self.assertEqual(second.roles_created, 0)
        self.assertEqual(second.roles_matched, 0)
        self.assertEqual(store.canonical_roles.keys(), roles_before.keys())
        self.assertEqual(store.role_matches.keys(), matches_before.keys())
        self.assertEqual(store.historical_events.keys(), events_before.keys())
        self.assertGreater(first.observations_considered, 0)

    def test_degraded_archive_collection_cannot_manufacture_bounded_dates(self):
        degraded_store, summary = collect_and_enrich(degraded_archive=True)
        precisions = {
            event.date_precision for event in degraded_store.historical_events.values()
        }
        self.assertNotIn(
            "bounded",
            precisions,
            "a degraded archive pass must not prove absence and produce a bounded window",
        )
        self.assertEqual(summary.degraded_capture_sources, 1)
        self.assertIn(
            "degraded_archive_absence_suppressed",
            {item.code for item in summary.diagnostics},
        )

    def test_partial_enrichment_failure_retains_other_roles(self):
        store, _ = collect_and_enrich()
        failing_role = next(iter(store.canonical_roles))
        original = store.list_role_observations

        def explode(role_id):
            if role_id == failing_role:
                raise RuntimeError("fixture reconstruction failure")
            return original(role_id)

        store.list_role_observations = explode
        store.historical_events.clear()
        summary = EvidenceEnrichmentService(store).enrich_company(COMPANY_ID)

        self.assertEqual(summary.reconstruction_failures, 1)
        self.assertFalse(summary.complete)
        self.assertIn(
            "historical_reconstruction_failed",
            {item.code for item in summary.diagnostics},
        )


if __name__ == "__main__":
    unittest.main()


class PaginationTests(unittest.TestCase):
    """PostgREST caps rows per response and reports no error when it truncates."""

    def test_evidence_reads_page_past_the_row_cap(self):
        from firstseen.repository import fetch_all_rows

        total = 2_468  # the number of observations silently dropped in a live run
        calls = []

        class Query:
            def __init__(self, rows):
                self.rows = rows
                self.orders = []

            def order(self, column):
                self.orders.append(column)
                return self

            def range(self, start, end):
                calls.append((start, end, tuple(self.orders)))
                # A server that caps at 1000 returns at most that many rows.
                page = self.rows[start : min(end + 1, start + 1000)]
                return SimpleNamespace(execute=lambda: SimpleNamespace(data=page))

        rows = [{"id": index} for index in range(total)]
        fetched = fetch_all_rows(lambda: Query(rows), key="id")

        self.assertEqual(len(fetched), total, "evidence loading must not stop at the row cap")
        self.assertEqual([row["id"] for row in fetched], list(range(total)))
        self.assertGreater(len(calls), 1, "a result beyond one page requires more than one request")
        self.assertTrue(all(orders == ("id",) for _, _, orders in calls), "every page is ordered by the unique key")

    def test_only_an_empty_page_ends_pagination(self):
        """A server whose max_rows is below the page size answers short pages; they are not the end."""
        from firstseen.repository import fetch_all_rows

        rows = [{"id": index} for index in range(1_250)]
        requests = []

        def build():
            def ranged(start, end):
                requests.append((start, end))
                return SimpleNamespace(execute=lambda: SimpleNamespace(data=rows[start : min(end + 1, start + 500)]))

            query = SimpleNamespace(range=ranged)
            query.order = lambda column: query
            return query

        self.assertEqual(len(fetch_all_rows(build, key="id")), 1_250)
        self.assertEqual([start for start, _ in requests], [0, 500, 1000, 1250])

    def test_a_composite_key_orders_by_every_column(self):
        from firstseen.repository import fetch_all_rows

        orders = []

        def build():
            query = SimpleNamespace(range=lambda start, end: SimpleNamespace(execute=lambda: SimpleNamespace(data=[])))
            query.order = lambda column: orders.append(column) or query
            return query

        fetch_all_rows(build, key=("observation_id", "canonical_role_id"))
        self.assertEqual(orders, ["observation_id", "canonical_role_id"])
