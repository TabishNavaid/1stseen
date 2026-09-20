"""Batched enrichment (enrichment_session.py) decides and writes exactly what the per-item path does.

A company's enrichment used to reach the database once or more for every observation and every role. The session reads
the company's evidence once, folds each decision into memory as the database applies it, and writes in bulk. These tests
run both paths over the same collected evidence, against an in-memory database with Postgres's upsert semantics, and
require the same rows at the end; then they pin the fold's own rules, the one-at-a-time replay when a bulk write is
refused, and that the session's requests do not grow with the number of observations.
"""

from __future__ import annotations

import sys
import unittest
from copy import deepcopy
from datetime import timedelta
from hashlib import sha256
from pathlib import Path
from typing import Any, cast
from uuid import NAMESPACE_URL, UUID, uuid5

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from test_pipeline_integration import (
    COMPANY_ID,
    OBSERVED_AT,
    PipelineStore,
    archive_source,
    archive_transport,
    board_source,
)

from firstseen.adapters.registry import AdapterRegistry
from firstseen.adapters.structured import GreenhouseAdapter
from firstseen.adapters.wayback import WaybackAdapter
from firstseen.enrichment import EnrichmentStore, EvidenceEnrichmentService
from firstseen.enrichment_session import CompanyEnrichmentSession
from firstseen.history import RecurringRoleIdentity
from firstseen.models import ArchiveCapture, HistoricalOpeningEvent, JobObservation
from firstseen.repository import IntelligenceRepository, write_chunks
from firstseen.role_resolution import (
    CanonicalRoleIdentity,
    RoleResolution,
    RoleResolver,
    normalize_title,
)
from firstseen.source_ingestion import SourceIngestionService

Repo = IntelligenceRepository


class Refused(Exception):
    """What the in-memory database raises where Postgres would refuse a statement."""


class MemoryDatabase:
    """The five relations enrichment reads and writes, with Postgres's upsert and uniqueness rules."""

    def __init__(self) -> None:
        self.observations: dict[str, dict[str, Any]] = {}
        self.source_company: dict[str, str] = {}
        self.captures: list[ArchiveCapture] = []
        self.roles: dict[str, dict[str, Any]] = {}
        self.aliases: dict[str, dict[str, Any]] = {}
        self.matches: dict[tuple[str, str], dict[str, Any]] = {}
        self.events: dict[tuple[str, str, str], dict[str, Any]] = {}
        self._ids = 0

    def new_id(self) -> str:
        self._ids += 1
        return str(uuid5(NAMESPACE_URL, f"memory-row:{self._ids}"))

    def upsert_role(self, row: dict[str, Any]) -> None:
        stored = self.roles.get(row["id"])
        self.roles[row["id"]] = {**stored, **row} if stored else {**row, "active": True}

    def insert_alias(self, row: dict[str, Any]) -> None:
        if any(
            item["canonical_role_id"] == row["canonical_role_id"] and item["normalized_alias"] == row["normalized_alias"]
            for item in self.aliases.values()
        ):
            raise Refused("duplicate key value violates unique constraint on (role, normalized alias)")
        alias_id = self.new_id()
        self.aliases[alias_id] = {**row, "id": alias_id}

    def upsert_match(self, row: dict[str, Any]) -> None:
        key = (row["observation_id"], row["canonical_role_id"])
        self.matches[key] = {**self.matches.get(key, {}), **row}

    def upsert_events(self, rows: list[dict[str, Any]]) -> None:
        keys = [(row["canonical_role_id"], row["opened_on"], row["observation_id"]) for row in rows]
        if len(set(keys)) != len(keys):
            raise Refused("ON CONFLICT DO UPDATE command cannot affect row a second time")
        for key, row in zip(keys, rows, strict=True):
            stored = self.events.get(key)
            self.events[key] = {**stored, **row} if stored else {**row, "id": self.new_id()}

    def snapshot(self) -> dict[str, Any]:
        """Every derived row, with generated ids left out, as the scratch-stack comparison takes it."""
        return {
            "roles": deepcopy(self.roles),
            "aliases": {
                (row["canonical_role_id"], row["normalized_alias"]): {k: v for k, v in row.items() if k != "id"}
                for row in self.aliases.values()
            },
            "matches": deepcopy(self.matches),
            "events": {key: {k: v for k, v in row.items() if k != "id"} for key, row in self.events.items()},
        }


class MemoryRepository:
    """The repository's per-item methods and the reads and bulk writes a session uses, over a MemoryDatabase.

    The per-item methods follow IntelligenceRepository's statement by statement, with its own payload builders, so the
    per-item path here is the reference the session must reproduce. Every method counts as one request.
    """

    def __init__(self, db: MemoryDatabase, *, sessions: bool) -> None:
        self.db = db
        self.sessions = sessions
        self.requests = 0

    def __getattribute__(self, name: str) -> Any:
        attribute = object.__getattribute__(self, name)
        if callable(attribute) and not name.startswith("_") and name not in {"enrichment_session", "unresolved_among", "unresolved_rows"}:
            object.__setattr__(self, "requests", object.__getattribute__(self, "requests") + 1)
        return attribute

    def __getattr__(self, name: str) -> Any:
        if name == "enrichment_session" and object.__getattribute__(self, "sessions"):
            return lambda company_id: CompanyEnrichmentSession(cast(Repo, self), company_id)
        raise AttributeError(name)

    # -- reads shared by both paths -----------------------------------------------------------------------------

    def _source_ids(self, company_id: UUID) -> list[str]:
        return sorted(source for source, company in self.db.source_company.items() if company == str(company_id))

    def company_source_ids(self, company_id: UUID) -> list[str]:
        return self._source_ids(company_id)

    def company_observation_rows(self, source_ids: list[str], *, with_excerpt: bool = True) -> list[dict[str, Any]]:
        rows = [deepcopy(row) for _, row in sorted(self.db.observations.items()) if row["source_id"] in source_ids]
        if not with_excerpt:
            # As PostgREST does when the column is not selected: the key is absent, not empty.
            for row in rows:
                row.pop("evidence_excerpt", None)
        return rows

    def observation_excerpts(self, observation_ids: list[str]) -> dict[str, str]:
        self.excerpts_requested = sorted({*getattr(self, "excerpts_requested", set()), *observation_ids})
        return {
            str(item): str(self.db.observations[item].get("evidence_excerpt") or "")
            for item in observation_ids
            if item in self.db.observations
        }

    def observation_matches_for_sources(self, source_ids: list[str]) -> list[dict[str, Any]]:
        return [
            {"observation_id": obs, "canonical_role_id": role, "is_primary": row["is_primary"]}
            for (obs, role), row in sorted(self.db.matches.items())
            if self.db.observations.get(obs, {}).get("source_id") in source_ids
        ]

    def unresolved_among(self, rows: list[dict[str, Any]], matches: list[dict[str, Any]]) -> list[JobObservation]:
        return Repo.unresolved_among(rows, matches)

    def unresolved_rows(self, rows: list[dict[str, Any]], matches: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return Repo.unresolved_rows(rows, matches)

    def _company_roles(self, company_id: UUID) -> list[dict[str, Any]]:
        return [deepcopy(row) for _, row in sorted(self.db.roles.items()) if row["company_id"] == str(company_id)]

    def resolution_role_rows(self, company_id: UUID) -> list[dict[str, Any]]:
        return self._company_roles(company_id)

    def alias_rows_for_company(self, company_id: UUID) -> list[dict[str, Any]]:
        roles = {row["id"] for row in self._company_roles(company_id)}
        return [deepcopy(row) for _, row in sorted(self.db.aliases.items()) if row["canonical_role_id"] in roles]

    def role_matches_for_company(self, company_id: UUID) -> list[dict[str, Any]]:
        roles = {row["id"] for row in self._company_roles(company_id)}
        return [
            {"observation_id": obs, "canonical_role_id": role}
            for (obs, role) in sorted(self.db.matches)
            if role in roles
        ]

    def event_rows_for_company(self, company_id: UUID) -> list[dict[str, Any]]:
        roles = {row["id"] for row in self._company_roles(company_id)}
        return sorted(
            (deepcopy(row) for row in self.db.events.values() if row["canonical_role_id"] in roles),
            key=lambda row: row["id"],
        )

    def observation_rows_by_id(self, observation_ids: list[str]) -> list[dict[str, Any]]:
        return [deepcopy(self.db.observations[item]) for item in observation_ids if item in self.db.observations]

    def archive_captures_for_sources(self, source_ids: list[str]) -> list[ArchiveCapture]:
        captures = [item for item in self.db.captures if str(item.source_id) in source_ids]
        return sorted(captures, key=lambda item: (item.captured_at, str(item.id)))

    def degraded_among(self, source_ids: list[str]) -> set[UUID]:
        del source_ids
        return set()

    def list_recurring_roles(self, company_id: UUID) -> list[RecurringRoleIdentity]:
        return [
            RecurringRoleIdentity(
                id=UUID(row["id"]),
                company_id=UUID(row["company_id"]),
                company="Fixture Robotics",
                canonical_title=row["canonical_title"],
                track=row["track"],
                aliases=[a["alias_title"] for _, a in sorted(self.db.aliases.items()) if a["canonical_role_id"] == row["id"]],
            )
            for row in self._company_roles(company_id)
            if row["active"] and row["canonical_title"].strip()
        ]

    # -- bulk writes (a session's) -----------------------------------------------------------------------------

    def upsert_rows(self, table: str, rows: list[dict[str, Any]], *, on_conflict: str) -> None:
        for chunk in write_chunks(rows):
            keys = [tuple(row[column] for column in on_conflict.split(",")) for row in chunk]
            if len(set(keys)) != len(keys):
                raise Refused("ON CONFLICT DO UPDATE command cannot affect row a second time")
            if table == "canonical_roles":
                for row in chunk:
                    self.db.upsert_role(row)
            elif table == "role_aliases":
                for row in chunk:
                    self.db.aliases[row["id"]] = {**self.db.aliases[row["id"]], **row}
            elif table == "observation_role_matches":
                for row in chunk:
                    self.db.upsert_match(row)
            elif table == "historical_opening_events":
                self.db.upsert_events(chunk)
            else:
                raise AssertionError(f"unexpected upsert into {table} on {on_conflict}")

    def insert_rows(self, table: str, rows: list[dict[str, Any]]) -> None:
        if table != "role_aliases":
            raise AssertionError(f"unexpected insert into {table}")
        for row in rows:
            self.db.insert_alias(row)

    # -- the per-item path, as IntelligenceRepository writes it --------------------------------------------------

    def list_unresolved_observations(self, company_id: UUID) -> list[JobObservation]:
        source_ids = self._source_ids(company_id)
        return Repo.unresolved_among(
            self.company_observation_rows(source_ids), self.observation_matches_for_sources(source_ids)
        )

    def list_canonical_roles_for_resolution(self, company_id: UUID) -> list[CanonicalRoleIdentity]:
        return [
            Repo.resolution_identity(
                row,
                [a["alias_title"] for _, a in sorted(self.db.aliases.items()) if a["canonical_role_id"] == row["id"] and a["alias_title"]],
            )
            for row in self._company_roles(company_id)
            if row["active"]
        ]

    def role_match_exists(self, observation_id: UUID) -> bool:
        return any(obs == str(observation_id) for obs, _ in self.db.matches)

    def save_role_resolution(self, resolution: RoleResolution) -> None:
        self.db.upsert_role(Repo.role_payload(resolution))
        row = self.db.observations.get(str(resolution.observation_id))
        if row is None:
            raise RuntimeError("Cannot persist a role alias without its observation")
        seen = {"first_seen_at": row["first_seen_at"], "last_seen_at": row["last_seen_at"]}
        role_id = str(resolution.canonical_role.id)
        existing = next(
            (
                alias
                for alias in self.db.aliases.values()
                if alias["canonical_role_id"] == role_id and alias["normalized_alias"] == normalize_title(resolution.observed_alias)
            ),
            None,
        )
        if existing is not None:
            existing.update(Repo.alias_update_payload(resolution, seen, existing.get("match_confidence", 0)))
        else:
            self.db.insert_alias(Repo.alias_insert_payload(resolution, seen))
        self.db.upsert_match(Repo.match_payload(resolution))

    def list_role_observations(self, role_id: UUID) -> list[JobObservation]:
        observations = [
            observation
            for (obs, role) in self.db.matches
            if role == str(role_id)
            and obs in self.db.observations
            and (observation := Repo._observation_from_row(self.db.observations[obs])) is not None
        ]
        return sorted(observations, key=lambda item: (item.first_seen_at, str(item.id)))

    def list_company_archive_captures(self, company_id: UUID) -> list[ArchiveCapture]:
        return self.archive_captures_for_sources(self._source_ids(company_id))

    def list_historical_events(self, role_id: UUID) -> list[HistoricalOpeningEvent]:
        rows = sorted((row for row in self.db.events.values() if row["canonical_role_id"] == str(role_id)), key=lambda r: r["id"])
        return Repo.events_from_rows(deepcopy(rows))

    def save_historical_openings(self, events: list[HistoricalOpeningEvent]) -> None:
        # As the repository does: a stored event keeps the quote it was created with.
        stored = {
            key: str(row["evidence_quote"])
            for key, row in self.db.events.items()
            if row.get("evidence_quote")
        }
        self.db.upsert_events(Repo.event_payloads(events, stored))

    def role_evidence_exists(self, observation_id: UUID, role_id: UUID) -> bool:
        return (str(observation_id), str(role_id)) in self.db.matches

    def link_observation_to_role(
        self, observation_id: UUID, role_id: UUID, *, match_confidence: float, rationale: str
    ) -> None:
        self.db.upsert_match(
            Repo.link_payload(observation_id, role_id, match_confidence=match_confidence, rationale=rationale)
        )

    def degraded_source_ids(self, company_id: UUID) -> set[UUID]:
        return self.degraded_among(self._source_ids(company_id))


def collected_evidence(extra_cycles: int = 0) -> MemoryDatabase:
    """The pipeline fixtures' collected postings and archive pages, plus later cycles of each posting.

    A later cycle repeats a posting a year on under a differently cased title, so it resolves into the same role and
    moves that alias's title and last sighting, as a renamed program does.
    """
    collected = PipelineStore()
    service = SourceIngestionService(AdapterRegistry([WaybackAdapter(), GreenhouseAdapter()]), archive_transport(), collected)
    service.ingest(board_source(), observed_at=OBSERVED_AT)
    service.ingest(archive_source(), observed_at=OBSERVED_AT)
    db = MemoryDatabase()
    for source in (board_source(), archive_source()):
        db.source_company[str(source.id)] = str(source.company_id)
    observations = list(collected.observation_ids.values())
    postings = [item for item in observations if not item.source_reliability.get("page_level_evidence")]
    for cycle in range(1, extra_cycles + 1):
        for posting in postings:
            key = sha256(f"{posting.identity_key}:{cycle}".encode()).hexdigest()
            observations.append(
                posting.model_copy(
                    update={
                        "id": uuid5(NAMESPACE_URL, f"observation:{key}"),
                        "identity_key": key,
                        "content_hash": sha256(f"{posting.content_hash}:{cycle}".encode()).hexdigest(),
                        "raw_title": posting.raw_title.upper() if cycle % 2 else posting.raw_title.lower(),
                        "first_seen_at": posting.first_seen_at + timedelta(days=365 * cycle),
                        "last_seen_at": posting.last_seen_at + timedelta(days=365 * cycle),
                    }
                )
            )
    for observation in observations:
        db.observations[str(observation.id)] = Repo._job_payload(observation)
    db.captures = list(collected.archive_captures.values())
    return db


def enrich(db: MemoryDatabase, *, sessions: bool) -> tuple[MemoryRepository, Any]:
    repository = MemoryRepository(db, sessions=sessions)
    summary = EvidenceEnrichmentService(cast(EnrichmentStore, repository)).enrich_company(COMPANY_ID)
    return repository, summary


class BatchedEnrichmentEquivalenceTests(unittest.TestCase):
    def test_the_session_writes_the_same_rows_and_counts_as_the_per_item_path(self) -> None:
        reference_db, batched_db = collected_evidence(extra_cycles=2), collected_evidence(extra_cycles=2)
        _, reference = enrich(reference_db, sessions=False)
        _, batched = enrich(batched_db, sessions=True)

        self.assertTrue(reference.complete and batched.complete)
        self.assertGreater(reference.roles_matched, 0, "later cycles matched their programs")
        self.assertGreater(reference.events_persisted, 0)
        self.assertTrue(
            any(not row["is_primary"] for row in reference_db.matches.values()), "archive pages were attributed"
        )
        self.assertEqual(reference.as_dict(), batched.as_dict())
        self.assertEqual(reference_db.snapshot(), batched_db.snapshot())

    def test_a_second_pass_changes_nothing_on_either_path(self) -> None:
        reference_db, batched_db = collected_evidence(extra_cycles=1), collected_evidence(extra_cycles=1)
        enrich(reference_db, sessions=False)
        enrich(batched_db, sessions=True)
        _, reference = enrich(reference_db, sessions=False)
        _, batched = enrich(batched_db, sessions=True)
        self.assertEqual(reference.observations_considered, 0)
        self.assertEqual(reference.as_dict(), batched.as_dict())
        self.assertEqual(reference_db.snapshot(), batched_db.snapshot())

    def test_a_stored_event_keeps_the_quote_it_was_created_with(self) -> None:
        """An opening is evidenced by what was visible when it was established, on both paths.

        Reconstruction rebuilds a role's whole history every pass. Re-deriving each quote rewrote an opening dated
        2025 with text its posting carried in 2026, and made every pass read the text of every observation of every
        role, which was the largest part of what enrichment downloaded.
        """
        for sessions in (False, True):
            db = collected_evidence(extra_cycles=1)
            enrich(db, sessions=sessions)
            first = {key: row["evidence_quote"] for key, row in db.events.items()}
            self.assertTrue(any(first.values()), "the fixtures evidence their openings")

            # The postings are rewritten, as a company editing its own pages rewrites them.
            for row in db.observations.values():
                if row.get("evidence_excerpt"):
                    row["evidence_excerpt"] = "Rewritten long after the opening was established."
            enrich(db, sessions=sessions)

            after = {key: row["evidence_quote"] for key, row in db.events.items()}
            self.assertEqual(first, {key: after[key] for key in first}, f"sessions={sessions}")
            self.assertNotIn("Rewritten long after", " ".join(after.values()), f"sessions={sessions}")

    def test_a_pass_reads_the_text_of_the_postings_whose_text_it_needs_and_no_others(self) -> None:
        """The excerpts are three fifths of what enrichment downloads, and a settled company needs few of them.

        A first pass resolves every posting and records every opening, so it reads all of their text. A second pass
        resolves nothing and every stored opening keeps its quote, so it reads only the postings a role has no opening
        of its own for: several postings of one cycle merge into a single opening, and the ones merged away keep a role
        match without ever carrying an event. Their text is not needed either, but which candidates survive the merge
        is only known after it, so they are read. On hosted that is 16.7 MB of the 73.7 MB of stored posting text.
        """
        db = collected_evidence(extra_cycles=1)
        first, _ = enrich(db, sessions=True)
        self.assertTrue(getattr(first, "excerpts_requested", []), "a first pass reads the text it resolves and quotes")

        second, summary = enrich(db, sessions=True)
        self.assertEqual(summary.observations_considered, 0)
        read_again = set(getattr(second, "excerpts_requested", []))
        evidenced = {key[1] for key in db.events}
        self.assertTrue(read_again, "the postings merged away from a cycle are read")
        self.assertEqual(
            read_again & evidenced, set(), "a posting whose opening is stored keeps its quote and is not read again"
        )
        self.assertLess(len(read_again), len(db.observations), "and the rest of the company's text is left alone")

    def test_a_created_role_that_exists_inactive_stays_inactive_and_out_of_the_candidates(self) -> None:
        def seeded() -> MemoryDatabase:
            db = collected_evidence(extra_cycles=2)
            postings = [
                observation
                for row in db.observations.values()
                if (observation := Repo._observation_from_row(row)) is not None
                and not observation.source_reliability.get("page_level_evidence")
            ]
            # The earliest posting creates the company's first role; that role's id already exists, switched off.
            first = min(postings, key=lambda item: (item.first_seen_at, str(item.id)))
            created = RoleResolver().resolve(company_id=COMPANY_ID, observation=first, candidates=[])
            payload = Repo.role_payload(created)
            db.roles[payload["id"]] = {**payload, "canonical_title": "Retired Program", "active": False}
            return db

        reference_db, batched_db = seeded(), seeded()
        _, reference = enrich(reference_db, sessions=False)
        _, batched = enrich(batched_db, sessions=True)
        self.assertEqual(reference.as_dict(), batched.as_dict())
        self.assertEqual(reference_db.snapshot(), batched_db.snapshot())
        self.assertIn(False, {row["active"] for row in batched_db.roles.values()})

    def test_the_sessions_requests_do_not_grow_with_observations(self) -> None:
        requests = []
        for cycles in (1, 4):
            repository, summary = enrich(collected_evidence(extra_cycles=cycles), sessions=True)
            requests.append((summary.observations_considered, repository.requests))
        (few, few_requests), (many, many_requests) = requests
        self.assertGreater(many, few)
        self.assertEqual(few_requests, many_requests)
        per_item, _ = enrich(collected_evidence(extra_cycles=4), sessions=False)
        self.assertGreater(per_item.requests, 5 * many_requests)


class SessionFoldTests(unittest.TestCase):
    def test_a_posting_attributed_to_a_role_before_it_was_resolved_is_left_alone_on_both_paths(self) -> None:
        def seeded() -> MemoryDatabase:
            db = collected_evidence(extra_cycles=1)
            enrich(db, sessions=False)
            # Forget one posting's own resolution, leaving only an archive attribution of it to that role.
            (observation_id, role_id), _ = next(
                (key, row)
                for key, row in sorted(db.matches.items())
                if row["is_primary"] and not db.observations[key[0]]["source_reliability"].get("page_level_evidence")
            )
            db.matches[(observation_id, role_id)] = Repo.link_payload(
                UUID(observation_id), UUID(role_id), match_confidence=0.75, rationale="attributed"
            )
            return db

        reference_db, batched_db = seeded(), seeded()
        _, reference = enrich(reference_db, sessions=False)
        _, batched = enrich(batched_db, sessions=True)
        self.assertEqual(reference.observations_considered, 1, "the attributed posting is listed as unresolved")
        self.assertEqual(reference.roles_matched + reference.roles_created, 0, "and then left alone")
        self.assertEqual(reference.as_dict(), batched.as_dict())
        self.assertEqual(reference_db.snapshot(), batched_db.snapshot())

    def test_an_attribution_made_in_this_pass_counts_as_existing_evidence(self) -> None:
        repository = MemoryRepository(collected_evidence(), sessions=True)
        session = CompanyEnrichmentSession(cast(Repo, repository), COMPANY_ID)
        observation, role = UUID(int=11), UUID(int=12)
        self.assertFalse(session.role_evidence_exists(observation, role))
        session.link_observation_to_role(observation, role, match_confidence=0.75, rationale="attributed")
        self.assertTrue(session.role_evidence_exists(observation, role))

    def test_an_alias_keeps_its_first_sighting_and_highest_confidence_and_takes_the_latest_title(self) -> None:
        db = collected_evidence(extra_cycles=2)
        enrich(db, sessions=True)
        grouped: dict[tuple[str, str], list[dict[str, Any]]] = {}
        for row in db.matches.values():
            if not row["is_primary"]:
                continue
            observation = db.observations[row["observation_id"]]
            key = (row["canonical_role_id"], normalize_title(observation["raw_title"]))
            grouped.setdefault(key, []).append({**row, "seen": observation})
        repeated = {key: rows for key, rows in grouped.items() if len(rows) > 1}
        self.assertTrue(repeated, "some alias was sighted more than once")
        aliases = {(a["canonical_role_id"], a["normalized_alias"]): a for a in db.aliases.values()}
        for key, rows in repeated.items():
            ordered = sorted(rows, key=lambda row: (row["seen"]["first_seen_at"], row["observation_id"]))
            alias = aliases[key]
            self.assertEqual(alias["first_observation_id"], ordered[0]["observation_id"])
            self.assertEqual(alias["last_observation_id"], ordered[-1]["observation_id"])
            self.assertEqual(alias["alias_title"], ordered[-1]["seen"]["raw_title"])
            self.assertEqual(alias["match_confidence"], max(row["match_confidence"] for row in rows))

    def test_a_session_refuses_another_company_and_resolution_after_history_began(self) -> None:
        repository = MemoryRepository(collected_evidence(), sessions=True)
        session = CompanyEnrichmentSession(cast(Repo, repository), COMPANY_ID)
        with self.assertRaises(ValueError):
            session.list_unresolved_observations(UUID(int=7))
        session.list_historical_events(UUID(int=8))
        observation = session.list_unresolved_observations(COMPANY_ID)[0]
        resolution = RoleResolver().resolve(company_id=COMPANY_ID, observation=observation, candidates=[])
        with self.assertRaises(RuntimeError):
            session.save_role_resolution(resolution)


class RefusedBulkWriteTests(unittest.TestCase):
    def test_a_refused_bulk_write_is_replayed_one_decision_at_a_time_and_only_the_bad_one_fails(self) -> None:
        reference_db, batched_db = collected_evidence(extra_cycles=1), collected_evidence(extra_cycles=1)
        _, reference = enrich(reference_db, sessions=False)
        doomed = min(str(obs) for (obs, _), row in reference_db.matches.items() if row["is_primary"])

        class Refusing(MemoryRepository):
            def upsert_rows(self, table: str, rows: list[dict[str, Any]], *, on_conflict: str) -> None:
                if table == "observation_role_matches" and any(row["is_primary"] for row in rows):
                    raise Refused("bulk match write refused")
                super().upsert_rows(table, rows, on_conflict=on_conflict)

            def save_role_resolution(self, resolution: RoleResolution) -> None:
                if str(resolution.observation_id) == doomed:
                    raise Refused("this one row is refused")
                super().save_role_resolution(resolution)

        repository = Refusing(batched_db, sessions=True)
        summary = EvidenceEnrichmentService(cast(EnrichmentStore, repository)).enrich_company(COMPANY_ID)

        self.assertEqual(summary.resolution_failures, 1)
        self.assertEqual(
            [item.details for item in summary.diagnostics if item.code == "role_resolution_failed"],
            [{"observation_id": doomed}],
        )
        self.assertEqual(summary.roles_matched + summary.roles_created, reference.roles_matched + reference.roles_created - 1)
        self.assertNotIn(doomed, {obs for obs, _ in batched_db.matches if batched_db.matches[(obs, _)]["is_primary"]})
        others = {key: row for key, row in reference_db.matches.items() if row["is_primary"] and key[0] != doomed}
        self.assertTrue(others)
        for key in others:
            self.assertIn(key, batched_db.matches)

    def test_a_role_whose_events_the_database_refuses_fails_alone(self) -> None:
        db = collected_evidence(extra_cycles=1)

        class RefusingEvents(MemoryRepository):
            refused_role: str | None = None

            def upsert_rows(self, table: str, rows: list[dict[str, Any]], *, on_conflict: str) -> None:
                if table == "historical_opening_events":
                    raise Refused("bulk event write refused")
                super().upsert_rows(table, rows, on_conflict=on_conflict)

            def save_historical_openings(self, events: list[HistoricalOpeningEvent]) -> None:
                role = str(events[0].canonical_role_id)
                if RefusingEvents.refused_role is None:
                    RefusingEvents.refused_role = role
                if role == RefusingEvents.refused_role:
                    raise Refused("this role's events are refused")
                super().save_historical_openings(events)

        reference_db = collected_evidence(extra_cycles=1)
        _, reference = enrich(reference_db, sessions=False)
        repository = RefusingEvents(db, sessions=True)
        summary = EvidenceEnrichmentService(cast(EnrichmentStore, repository)).enrich_company(COMPANY_ID)

        refused = RefusingEvents.refused_role
        self.assertIsNotNone(refused)
        self.assertEqual(summary.reconstruction_failures, 1)
        self.assertEqual(summary.roles_reconstructed, reference.roles_reconstructed - 1)
        self.assertEqual(
            summary.events_persisted,
            reference.events_persisted - sum(1 for row in reference_db.events.values() if row["canonical_role_id"] == refused),
        )
        self.assertFalse(any(row["canonical_role_id"] == refused for row in db.events.values()))
        self.assertTrue(any(row["canonical_role_id"] != refused for row in db.events.values()))


class WriteChunkTests(unittest.TestCase):
    def test_rows_are_grouped_by_their_columns_in_order_and_bounded(self) -> None:
        rows = [{"id": index, "a": 1} for index in range(1_200)] + [{"id": "x", "a": 1, "b": 2}, {"id": "y", "a": 2}]
        chunks = write_chunks(rows)
        self.assertEqual([len(chunk) for chunk in chunks], [500, 500, 201, 1])
        self.assertEqual([row["id"] for row in chunks[2]][-1], "y")
        self.assertEqual(chunks[3], [{"id": "x", "a": 1, "b": 2}])
        for chunk in chunks:
            self.assertEqual(len({frozenset(row) for row in chunk}), 1)

    def test_a_chunk_stops_before_about_two_megabytes(self) -> None:
        rows = [{"id": index, "text": "x" * 300_000} for index in range(10)]
        self.assertEqual([len(chunk) for chunk in write_chunks(rows)], [6, 4])


if __name__ == "__main__":
    unittest.main()
