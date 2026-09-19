"""Takedowns: stopping collection, withdrawing a company, and what nothing else may undo (docs/takedown.md).

The SQL function that performs each action (migration 202608140039) is exercised against Postgres in a rolled-back
transaction; these tests pin the worker around it: the commands, the discovery guards, and a withdrawn company's evidence
leaving every other role's priors.
"""

from __future__ import annotations

import json
import sys
import unittest
from contextlib import redirect_stdout
from datetime import UTC, date, datetime
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from typing import Any, ClassVar
from unittest.mock import patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pydantic import HttpUrl

from firstseen import cli
from firstseen.agent import SupabaseRecruitingKnowledge
from firstseen.backtesting import BacktestRunner
from firstseen.discovery import DiscoveredSource, DiscoveryEvidence
from firstseen.repository import IntelligenceRepository
from firstseen.takedown import CollectionHeldError, TakedownRefused, TakedownService

COMPANY = "00000000-0000-4000-8000-00000000c001"
OTHER_COMPANY = "00000000-0000-4000-8000-00000000c002"
SOURCE_A = "00000000-0000-4000-8000-00000000c0a1"
SOURCE_B = "00000000-0000-4000-8000-00000000c0b1"


# ----------------------------------------------------------------------------- a small in-memory PostgREST


class Query:
    def __init__(self, client: FakeClient, table: str) -> None:
        self.client = client
        self.name = table
        self.filters: list[Any] = []
        self.mode = "select"
        self.payload: Any = None
        self._order: tuple[str, bool] | None = None
        self._limit: int | None = None
        self._range: tuple[int, int] | None = None
        self._count = False

    def select(self, columns: str, count: Any = None, head: bool | None = None) -> Query:
        self._count = count is not None
        return self

    def insert(self, payload: Any) -> Query:
        self.mode, self.payload = "insert", payload
        return self

    def update(self, payload: Any) -> Query:
        self.mode, self.payload = "update", payload
        return self

    def upsert(self, payload: Any, on_conflict: str | None = None) -> Query:
        self.mode, self.payload = "upsert", payload
        return self

    def eq(self, column: str, value: Any) -> Query:
        self.filters.append(lambda row: str(row.get(column)) == str(value))
        return self

    def is_(self, column: str, value: str) -> Query:
        self.filters.append(lambda row: row.get(column) is None)
        return self

    def in_(self, column: str, values: list[str]) -> Query:
        self.filters.append(lambda row: str(row.get(column)) in {str(item) for item in values})
        return self

    def ilike(self, column: str, value: str) -> Query:
        self.filters.append(lambda row: str(row.get(column)).casefold() == value.casefold())
        return self

    def order(self, column: str, desc: bool = False) -> Query:
        self._order = (column, desc)
        return self

    def limit(self, count: int) -> Query:
        self._limit = count
        return self

    def range(self, start: int, end: int) -> Query:
        self._range = (start, end)
        return self

    def execute(self) -> Any:
        rows = self.client.tables.setdefault(self.name, [])
        matching = [row for row in rows if all(test(row) for test in self.filters)]
        if self.mode == "insert":
            rows.append(dict(self.payload))
            self.client.writes.append((self.name, "insert", dict(self.payload)))
            return type("Response", (), {"data": [self.payload]})()
        if self.mode == "update":
            for row in matching:
                row.update(self.payload)
            self.client.writes.append((self.name, "update", dict(self.payload)))
            return type("Response", (), {"data": matching})()
        if self.mode == "upsert":
            self.client.writes.append((self.name, "upsert", dict(self.payload)))
            return type("Response", (), {"data": [self.payload]})()
        if self._order:
            column, desc = self._order
            matching.sort(key=lambda row: str(row.get(column)), reverse=desc)
        if self._range:
            matching = matching[self._range[0] : self._range[1] + 1]
        if self._limit is not None:
            matching = matching[: self._limit]
        return type("Response", (), {"data": matching, "count": len(matching) if self._count else None})()


class FakeClient:
    def __init__(self, tables: dict[str, list[dict[str, Any]]]) -> None:
        self.tables = tables
        self.writes: list[tuple[str, str, dict[str, Any]]] = []

    def table(self, name: str) -> Query:
        return Query(self, name)


def repository(tables: dict[str, list[dict[str, Any]]]) -> IntelligenceRepository:
    subject = IntelligenceRepository.__new__(IntelligenceRepository)
    subject.client = FakeClient(tables)  # type: ignore[assignment]
    return subject


def hold(action: str = "withdraw") -> dict[str, Any]:
    return {
        "id": "00000000-0000-4000-8000-00000000d001",
        "company_id": COMPANY,
        "source_id": None,
        "action": action,
        "reason": "Takedown request",
        "requested_by": "fixture",
        "recorded_at": "2026-09-17T10:00:00+00:00",
    }


def discovered(url: str) -> DiscoveredSource:
    return DiscoveredSource(
        id=UUID("00000000-0000-4000-8000-00000000e001"),
        company_id=UUID(COMPANY),
        url=HttpUrl(url),
        category="careers_page",
        adapter="generic",
        trust_score=0.85,
        evidence=[DiscoveryEvidence(method="html_link", evidence_url=HttpUrl(url), quote="Careers")],
    )


# ----------------------------------------------------------------------------- discovery cannot undo a takedown


class DiscoveryRespectsTakedownTests(unittest.TestCase):
    def test_rediscovery_never_turns_a_disabled_source_back_on_and_does_not_run_it(self):
        url = "https://takedown-fixture.example/careers"
        subject = repository(
            {
                "collection_takedowns": [],
                "sources": [{"id": SOURCE_A, "company_id": COMPANY, "url": url, "adapter": "generic", "enabled": False}],
                "source_discovery_evidence": [],
            }
        )
        configs = subject.save_discovered_sources(UUID(COMPANY), "Takedown Fixture", [discovered(url)])
        self.assertEqual(configs, [], "a disabled source is not handed back to be ingested")
        source_writes = [payload for table, _, payload in subject.client.writes if table == "sources"]  # type: ignore[attr-defined]
        self.assertTrue(source_writes)
        self.assertTrue(all("enabled" not in payload for payload in source_writes))
        self.assertFalse(subject.client.tables["sources"][0]["enabled"])  # type: ignore[attr-defined]

    def test_a_new_source_of_an_unheld_company_is_created_enabled(self):
        subject = repository({"collection_takedowns": [], "sources": [], "source_discovery_evidence": []})
        configs = subject.save_discovered_sources(
            UUID(COMPANY), "Takedown Fixture", [discovered("https://takedown-fixture.example/jobs")]
        )
        self.assertEqual(len(configs), 1)
        self.assertTrue(subject.client.tables["sources"][0]["enabled"])  # type: ignore[attr-defined]

    def test_a_held_or_withdrawn_company_gets_no_sources_at_all(self):
        for action in ("disable", "withdraw"):
            subject = repository({"collection_takedowns": [hold(action)], "sources": [], "source_discovery_evidence": []})
            with self.assertRaises(CollectionHeldError):
                subject.save_discovered_sources(
                    UUID(COMPANY), "Takedown Fixture", [discovered("https://takedown-fixture.example/jobs")]
                )
            self.assertEqual(subject.client.writes, [], action)  # type: ignore[attr-defined]

    def test_a_lifted_hold_no_longer_blocks(self):
        lifted = {**hold("withdraw"), "id": "00000000-0000-4000-8000-00000000d002", "action": "enable",
                  "recorded_at": "2026-09-18T10:00:00+00:00"}
        subject = repository({"collection_takedowns": [hold("withdraw"), lifted], "sources": [], "source_discovery_evidence": []})
        self.assertIsNone(subject.company_hold(UUID(COMPANY)))

    def test_a_source_level_disable_is_not_a_company_hold(self):
        source_only = {**hold("disable"), "source_id": SOURCE_A}
        subject = repository({"collection_takedowns": [source_only]})
        self.assertIsNone(subject.company_hold(UUID(COMPANY)))


# ----------------------------------------------------------------------------- a withdrawn company informs no prior


def _role(role_id: str, company: str, *, active: bool = True) -> dict[str, Any]:
    return {
        "id": role_id,
        "company_id": company,
        "role_family": "software_engineering",
        "level": "internship",
        "recruiting_season": "summer",
        "active": active,
        "companies": {"metadata": {}},
    }


def _evidence(role_id: str, years_and_days: list[tuple[int, int, int]], prefix: str) -> dict[str, list[dict[str, Any]]]:
    observations, matches, events = [], [], []
    for index, (year, month, day) in enumerate(years_and_days):
        observation = f"{prefix}{index:011d}"
        available = datetime(year, month, day, 12, tzinfo=UTC).isoformat()
        observations.append({"id": observation, "observed_at": available, "raw_title": "Software Engineering Intern"})
        matches.append({"observation_id": observation, "canonical_role_id": role_id, "match_confidence": 0.95,
                        "created_at": available})
        events.append({
            "id": f"{prefix[:-1]}e{index:011d}", "canonical_role_id": role_id, "observation_id": observation,
            "opened_on": date(year, month, day).isoformat(), "source_quality": 0.95, "opening_window_start": None,
            "opening_window_end": None, "uncertainty_days": 0, "date_precision": "exact", "available_at": available,
        })
    return {"raw_job_observations": observations, "observation_role_matches": matches,
            "historical_opening_events": events}


def _dataset_tables(*, withdrawn_present: bool) -> dict[str, list[dict[str, Any]]]:
    target = "00000000-0000-4000-8000-00000000f001"
    sibling = "00000000-0000-4000-8000-00000000f002"  # same company, compatible population: a company-prior donor
    withdrawn = "00000000-0000-4000-8000-00000000f003"  # the withdrawn company's role, same family: a family donor
    tables: dict[str, list[dict[str, Any]]] = {
        "canonical_roles": [_role(target, OTHER_COMPANY), _role(sibling, OTHER_COMPANY)],
        "raw_job_observations": [], "observation_role_matches": [], "historical_opening_events": [], "signals": [],
    }
    for role_id, days, prefix in (
        (target, [(2024, 9, 3)], "00000000-0000-4000-8000-a"),
        (sibling, [(2023, 9, 10), (2024, 9, 12), (2025, 9, 8)], "00000000-0000-4000-8000-b"),
    ):
        for name, rows in _evidence(role_id, days, prefix).items():
            tables[name].extend(rows)
    if withdrawn_present:
        tables["canonical_roles"].append(_role(withdrawn, COMPANY, active=False))
        for name, rows in _evidence(withdrawn, [(2023, 1, 20), (2024, 1, 22), (2025, 1, 18)], "00000000-0000-4000-8000-c").items():
            tables[name].extend(rows)
        tables["signals"].append({
            "id": "00000000-0000-4000-8000-00000000a501", "company_id": COMPANY, "canonical_role_id": withdrawn,
            "observation_id": "00000000-0000-4000-8000-c00000000000", "observed_at": "2025-01-10T00:00:00+00:00",
            "available_at": "2025-01-10T00:00:00+00:00", "strength": 0.2, "reliability": 0.8, "kind": "careers_page_change",
            "metadata": {},
        })
    return tables


class WithdrawnEvidenceLeavesPriorsTests(unittest.TestCase):
    def test_an_inactive_roles_openings_and_signals_are_not_loaded(self):
        roles, events, signals = repository(_dataset_tables(withdrawn_present=True)).load_backtest_dataset()
        role_ids = {role.id for role in roles}
        self.assertNotIn("00000000-0000-4000-8000-00000000f003", role_ids)
        self.assertTrue(all(event.role_id in role_ids for event in events))
        self.assertTrue(all(signal.role_id in role_ids for signal in signals))
        # The runner refuses a dataset whose events name a role it does not know; this one is consistent.
        BacktestRunner().run(roles, events, signals, cutoff_days=60)

    def test_a_withdrawn_company_moves_no_other_roles_forecast(self):
        as_of = date(2026, 6, 1)
        role = UUID("00000000-0000-4000-8000-00000000f001")
        with_withdrawn = repository(_dataset_tables(withdrawn_present=True)).build_current_forecast(role, as_of=as_of)
        without = repository(_dataset_tables(withdrawn_present=False)).build_current_forecast(role, as_of=as_of)
        for field in ("point_date", "window_start", "window_end", "confidence", "sample_size"):
            self.assertEqual(getattr(with_withdrawn, field), getattr(without, field), field)


class FollowCoverageTests(unittest.TestCase):
    def test_a_withdrawn_role_is_covered_by_no_follow(self):
        subject = repository(
            {
                "watchlist_items": [{"user_id": "00000000-0000-4000-8000-0000000000a1", "target_type": "company",
                                     "company_id": COMPANY}],
                "canonical_roles": [
                    {"id": "00000000-0000-4000-8000-00000000f010", "company_id": COMPANY, "role_family": "data",
                     "track": "internship", "scope_status": "in_scope", "active": False},
                    {"id": "00000000-0000-4000-8000-00000000f011", "company_id": COMPANY, "role_family": "data",
                     "track": "internship", "scope_status": "in_scope", "active": True},
                ],
            }
        )
        self.assertEqual(list(subject.watchers_by_role()), [UUID("00000000-0000-4000-8000-00000000f011")])
        self.assertEqual(subject.list_role_watchers(UUID("00000000-0000-4000-8000-00000000f010")), [])


class AgentCompanyResolutionTests(unittest.TestCase):
    def test_the_agent_cannot_resolve_a_withdrawn_company_but_can_a_disabled_one(self):
        companies = [
            {"id": COMPANY, "name": "Takedown Fixture", "domain": "takedown-fixture.example", "metadata": {}},
            {"id": OTHER_COMPANY, "name": "Takedown Fixture Labs", "domain": "takedown-labs.example", "metadata": {}},
        ]
        withdrawn = repository({"companies": companies, "collection_takedowns": [hold("withdraw")]})
        found = SupabaseRecruitingKnowledge(withdrawn).find_companies("When does Takedown Fixture open internships?")
        self.assertNotIn(COMPANY, [str(item.id) for item in found])
        disabled = repository({"companies": companies, "collection_takedowns": [hold("disable")]})
        found = SupabaseRecruitingKnowledge(disabled).find_companies("When does Takedown Fixture open internships?")
        self.assertIn(COMPANY, [str(item.id) for item in found], "a collection stop alone keeps the company answerable")


# ----------------------------------------------------------------------------- the commands


class Store:
    """The TakedownStore surface, recording every call; `apply_collection_takedown` stands in for the SQL function."""

    held: dict[str, Any] | None = None
    applied: ClassVar[list[tuple[Any, ...]]] = []

    def __init__(self) -> None:
        Store.applied = []
        Store.regenerated = []

    def company_by_domain(self, domain: str) -> dict[str, Any] | None:
        return {"id": COMPANY, "name": "Takedown Fixture", "domain": domain} if domain == "takedown-fixture.example" else None

    def source_with_company(self, source_id: UUID) -> dict[str, Any] | None:
        if str(source_id) != SOURCE_A:
            return None
        return {"id": SOURCE_A, "company_id": COMPANY, "adapter": "generic", "enabled": True,
                "url": "https://takedown-fixture.example/careers",
                "companies": {"name": "Takedown Fixture", "domain": "takedown-fixture.example"}}

    def company_sources(self, company_id: UUID) -> list[dict[str, Any]]:
        return [
            {"id": SOURCE_A, "adapter": "generic", "enabled": True, "url": "https://takedown-fixture.example/careers"},
            {"id": SOURCE_B, "adapter": "greenhouse", "enabled": True, "url": "https://boards.greenhouse.io/fixture"},
        ]

    def company_hold(self, company_id: UUID) -> dict[str, Any] | None:
        return self.held

    def takedown_history(self, company_id: UUID) -> list[dict[str, Any]]:
        return []

    def withdrawal_preview(self, company_id: UUID) -> dict[str, int]:
        return {"roles_to_deactivate": 12, "in_scope_roles_to_deactivate": 3, "users_following_them": 1,
                "observations_retained": 40, "other_forecasts_to_regenerate": 1}

    # What the re-forecast after a withdrawal reads and writes.
    regenerated: ClassVar[list[tuple[str, str, str | None]]] = []
    citing = UUID("00000000-0000-4000-8000-00000000f100")

    def roles_whose_latest_forecast_cites(self, company_id: UUID) -> list[UUID]:
        return [self.citing]

    def start_agent_run(self, **kwargs: Any) -> UUID:
        return UUID("00000000-0000-4000-8000-00000000d100")

    def finish_agent_run(self, run_id: UUID, *, status: str, error: Any = None) -> None:
        pass

    def record_tool_call(self, run_id: UUID, **kwargs: Any) -> None:
        pass

    def load_backtest_dataset(self) -> tuple[list[Any], list[Any], list[Any]]:
        return [], [], []

    def watchers_by_role(self) -> dict[UUID, list[UUID]]:
        return {}

    def build_current_forecast(self, role_id: UUID, *, as_of: date, dataset: Any = None) -> Any:
        return SimpleNamespace(input_fingerprint="without-the-withdrawn-company", window_end=date(2027, 1, 1))

    def latest_forecast_version(self, role_id: UUID) -> Any:
        return SimpleNamespace(id=UUID("00000000-0000-4000-8000-00000000f1ff"),
                               forecast=SimpleNamespace(input_fingerprint="with-it"))

    def current_forecast_version(self, role_id: UUID) -> Any:
        return self.latest_forecast_version(role_id)

    def record_forecast_refusal(self, role_id: UUID, *, reason: str, at: Any) -> None:
        self.refusals = [*getattr(self, "refusals", []), role_id]

    def save_agent_forecast_version(self, role_id, forecast, *, as_of, supersedes_id, recomputation_reason) -> UUID:
        Store.regenerated.append((str(role_id), recomputation_reason, supersedes_id and str(supersedes_id)))
        return UUID("00000000-0000-4000-8000-00000000f200")

    def apply_collection_takedown(self, company_id, source_id, action, reason, requested_by) -> dict[str, Any]:
        Store.applied.append((str(company_id), source_id and str(source_id), action, reason, requested_by))
        changed = [SOURCE_A] if source_id else [SOURCE_A, SOURCE_B]
        return {"id": "00000000-0000-4000-8000-00000000d009", "recorded_at": "2026-09-17T11:00:00+00:00",
                "source_ids": changed, "role_ids": ["r"] * (12 if action == "withdraw" else 0),
                "reason": reason, "requested_by": requested_by}


class TakedownServiceTests(unittest.TestCase):
    def test_a_reason_and_an_operator_are_required(self):
        service = TakedownService(Store())
        with self.assertRaises(TakedownRefused) as caught:
            service.disable(company_domain="takedown-fixture.example", source_id=None, reason="  ", requested_by="x")
        self.assertEqual(caught.exception.reason, "reason_required")
        with self.assertRaises(TakedownRefused) as caught:
            service.disable(company_domain="takedown-fixture.example", source_id=None, reason="Asked", requested_by="")
        self.assertEqual(caught.exception.reason, "by_required")
        self.assertEqual(Store.applied, [])

    def test_one_source_of_a_held_company_cannot_be_resumed_on_its_own(self):
        store = Store()
        store.held = hold("withdraw")
        with self.assertRaises(TakedownRefused) as caught:
            TakedownService(store).enable(
                company_domain=None, source_id=UUID(SOURCE_A), reason="Resume", requested_by="fixture"
            )
        self.assertEqual(caught.exception.reason, "company_held")
        self.assertEqual(Store.applied, [])

    def test_lifting_a_company_with_no_hold_is_refused(self):
        with self.assertRaises(TakedownRefused) as caught:
            TakedownService(Store()).enable(
                company_domain="takedown-fixture.example", source_id=None, reason="Resume", requested_by="fixture"
            )
        self.assertEqual(caught.exception.reason, "no_company_hold")

    def test_an_unknown_company_or_source_is_refused(self):
        service = TakedownService(Store())
        for kwargs in ({"company_domain": "unknown.example", "source_id": None},
                       {"company_domain": None, "source_id": UUID("00000000-0000-4000-8000-00000000ffff")}):
            with self.assertRaises(TakedownRefused):
                service.disable(reason="Asked", requested_by="fixture", **kwargs)  # type: ignore[arg-type]
        self.assertEqual(Store.applied, [])


def run_cli(*args: str) -> tuple[int, dict[str, Any]]:
    with patch.object(sys, "argv", ["firstseen", *args]), redirect_stdout(StringIO()) as output:
        code = cli.main()
    return code, json.loads(output.getvalue())


class StoreRepository(Store):
    @classmethod
    def from_settings(cls, settings: Any = None) -> StoreRepository:
        return cls()


@patch.object(cli, "IntelligenceRepository", StoreRepository)
class TakedownCommandTests(unittest.TestCase):
    def setUp(self) -> None:
        StoreRepository.held = None

    def test_disabling_a_company_records_who_and_why_and_lists_what_stopped(self):
        code, payload = run_cli("sources", "disable", "--company", "takedown-fixture.example",
                                "--reason", "Email from the company, 17 Sept", "--by", "Tabish")
        self.assertEqual(code, 0)
        self.assertEqual(Store.applied, [(COMPANY, None, "disable", "Email from the company, 17 Sept", "Tabish")])
        self.assertEqual(payload["scope"], "company")
        self.assertEqual({item["adapter"] for item in payload["sources_changed"]}, {"generic", "greenhouse"})

    def test_one_source_is_disabled_by_id(self):
        code, payload = run_cli("sources", "disable", "--source", SOURCE_A, "--reason", "Asked", "--by", "Tabish")
        self.assertEqual(code, 0)
        self.assertEqual(Store.applied[0][1:3], (SOURCE_A, "disable"))
        self.assertEqual(payload["scope"], "source")

    def test_the_operator_defaults_to_firstseen_reviewer(self):
        with patch.dict("os.environ", {"FIRSTSEEN_REVIEWER": "Reviewer Name"}):
            code, _ = run_cli("sources", "disable", "--company", "takedown-fixture.example", "--reason", "Asked")
        self.assertEqual(code, 0)
        self.assertEqual(Store.applied[0][4], "Reviewer Name")

    def test_withdraw_company_is_a_dry_run_that_writes_nothing_without_apply(self):
        code, payload = run_cli("withdraw-company", "takedown-fixture.example", "--reason", "Takedown request")
        self.assertEqual(code, 0)
        self.assertEqual(Store.applied, [])
        self.assertEqual(payload["status"], "planned")
        self.assertEqual(payload["sources_to_disable"], 2)
        self.assertEqual(payload["in_scope_roles_to_deactivate"], 3)
        self.assertEqual(payload["other_forecasts_to_regenerate"], 1)
        self.assertIn("kept", payload["retained"])
        self.assertEqual(Store.regenerated, [], "a dry run re-forecasts nothing")

    def test_withdraw_company_applies_with_apply(self):
        code, payload = run_cli("withdraw-company", "takedown-fixture.example", "--reason", "Takedown request",
                                "--by", "Tabish", "--apply")
        self.assertEqual(code, 0)
        self.assertEqual(Store.applied, [(COMPANY, None, "withdraw", "Takedown request", "Tabish")])
        self.assertEqual((payload["status"], payload["roles_changed"]), ("applied", 12))
        # Another role whose latest forecast cited the company gets a new version without it; the old one is kept.
        self.assertEqual(
            Store.regenerated,
            [("00000000-0000-4000-8000-00000000f100", "company_withdrawn", "00000000-0000-4000-8000-00000000f1ff")],
        )
        self.assertEqual(payload["regeneration"]["forecasts_regenerated"], 1)
        self.assertEqual(payload["regeneration"]["still_citing_withdrawn_company"], [])

    def test_a_refusal_exits_non_zero_and_changes_nothing(self):
        code, payload = run_cli("sources", "enable", "--company", "takedown-fixture.example", "--reason", "x", "--by", "y")
        self.assertEqual((code, payload["status"], payload["reason"]), (1, "refused", "no_company_hold"))
        self.assertEqual(Store.applied, [])


class HeldDiscoveryRepository(StoreRepository):
    def company_by_query(self, query: str) -> dict[str, Any] | None:
        return self.company_by_domain(query)


@patch.object(cli, "IntelligenceRepository", HeldDiscoveryRepository)
class HeldDiscoveryCommandTests(unittest.TestCase):
    def test_discovery_of_a_held_company_is_refused_before_any_request(self):
        HeldDiscoveryRepository.held = hold("withdraw")
        with patch.object(cli, "UrlLibTransport") as transport:
            code, payload = run_cli("discover", "--company", "takedown-fixture.example")
        self.assertEqual((code, payload["reason"]), (1, "company_collection_held"))
        transport.assert_not_called()


if __name__ == "__main__":
    unittest.main()
