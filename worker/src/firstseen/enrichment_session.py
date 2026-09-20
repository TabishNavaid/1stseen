"""One company's enrichment against evidence read once, with its decisions written in bulk.

EvidenceEnrichmentService (enrichment.py) resolves each unresolved observation against the company's current roles,
then reconstructs every role's opening history. Run against the repository directly, each step read and wrote per item:
a fresh read of every candidate role and five requests per role decision (the role, the observation's dates, the alias
check, the alias, the match), and four or more per role in reconstruction. From a runner a region away from the
database every request is a round trip, and a full pass ran at about 1.35 observations a second.

A session implements the same EnrichmentStore contract for one company. It reads the company's observations, matches,
roles, aliases, and events once and answers every lookup from memory. Each write is folded into that memory exactly as
the database applies it (an upsert merges into the stored role, an alias keeps its first sighting and its highest
confidence), so the next decision sees what it would have read back, and each write waits for flush_resolutions() or
flush_history() to send it in bulk. The decisions are the per-item path's, and the requests no longer grow with the
number of observations: a company costs a few paged reads and a few bulk writes.

If the database refuses a bulk write, the stage's writes are replayed one decision at a time through the repository's
own per-item methods, so a row the database rejects fails only its own decision, as it always did.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any
from uuid import UUID

from .history import RecurringRoleIdentity
from .models import ArchiveCapture, HistoricalOpeningEvent, JobObservation
from .role_resolution import CanonicalRoleIdentity, RoleResolution, normalize_title

if TYPE_CHECKING:
    from .repository import IntelligenceRepository

MATCH_KEY = "observation_id,canonical_role_id"
# The alias columns save_role_resolution writes; an alias already stored is rewritten with them and its id.
_ALIAS_COLUMNS = (
    "canonical_role_id",
    "alias_title",
    "normalized_alias",
    "first_observation_id",
    "last_observation_id",
    "first_seen_at",
    "last_seen_at",
    "match_confidence",
    "match_evidence",
    "resolver_version",
)


@dataclass
class _RoleHistory:
    """One role's reconstruction writes, kept together so a refused bulk write can be replayed role by role."""

    events: list[HistoricalOpeningEvent] = field(default_factory=list)
    links: list[tuple[UUID, UUID, float, str]] = field(default_factory=list)


class CompanyEnrichmentSession:
    """EnrichmentStore for one company: reads once, answers from memory, writes in bulk."""

    def __init__(self, repository: IntelligenceRepository, company_id: UUID) -> None:
        self.repository = repository
        self.company_id = company_id
        self._source_ids = repository.company_source_ids(company_id)
        # Without their evidence excerpts: those average 3,041 bytes on hosted and are about three fifths of what
        # enriching one company downloads. Only two decisions read one -- resolving an observation, and quoting an
        # opening the first time it is recorded -- so they are read for those observations and no others.
        self._observation_rows = {
            str(row["id"]): row
            for row in repository.company_observation_rows(self._source_ids, with_excerpt=False)
        }
        self._excerpts_read: set[str] = set()
        self._observation_matches = repository.observation_matches_for_sources(self._source_ids)
        # Any match, primary or an archive attribution, marks an observation as already resolved (role_match_exists).
        self._matched_observations = {str(row["observation_id"]) for row in self._observation_matches}

        # Resolution: the company's roles and aliases, read on first use, and the writes waiting for a flush.
        self._roles: dict[str, dict[str, Any]] | None = None
        self._aliases: dict[tuple[str, str], dict[str, Any]] = {}
        self._aliases_by_role: dict[str, list[tuple[str, str]]] = defaultdict(list)
        self._identities: dict[str, CanonicalRoleIdentity] = {}
        self._candidates: list[CanonicalRoleIdentity] | None = None
        self._resolutions: list[RoleResolution] = []
        self._role_writes: dict[str, dict[str, Any]] = {}
        self._alias_writes: dict[tuple[str, str], None] = {}
        self._match_writes: list[dict[str, Any]] = []
        # Aliases inserted by a flush have ids this session never learns, so it takes no decision after one.
        self._resolutions_flushed = False

        # Reconstruction: read on first use, after the resolutions it depends on are written.
        self._role_observation_ids: dict[str, list[str]] | None = None
        self._evidence_pairs: set[tuple[str, str]] = set()
        self._event_rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
        self._history: dict[str, _RoleHistory] = {}

    def _require(self, company_id: UUID) -> None:
        if company_id != self.company_id:
            raise ValueError("an enrichment session serves only the company it was opened for")

    # -- role resolution ------------------------------------------------------------------------------------------

    def list_unresolved_observations(self, company_id: UUID) -> list[JobObservation]:
        self._require(company_id)
        rows = list(self._observation_rows.values())
        # Resolving a posting reads its text; a posting already resolved is not resolved again.
        self._hydrate_excerpts([str(row["id"]) for row in self.repository.unresolved_rows(rows, self._observation_matches)])
        return self.repository.unresolved_among(rows, self._observation_matches)

    def _hydrate_excerpts(self, observation_ids: Iterable[str]) -> None:
        """Read the evidence excerpt of each of these observations, once per session, in one request."""
        missing = sorted({
            observation_id
            for observation_id in observation_ids
            if observation_id not in self._excerpts_read and observation_id in self._observation_rows
        })
        if not missing:
            return
        self._excerpts_read.update(missing)
        excerpts = self.repository.observation_excerpts(missing)
        for observation_id in missing:
            self._observation_rows[observation_id]["evidence_excerpt"] = excerpts.get(observation_id, "")

    def list_canonical_roles_for_resolution(self, company_id: UUID) -> list[CanonicalRoleIdentity]:
        self._require(company_id)
        if self._candidates is None:
            roles = self._load_roles()
            # In id order, as the paged read returns them: the resolver breaks a tie in score by candidate order.
            self._candidates = [self._identity(role_id) for role_id in sorted(roles) if roles[role_id]["active"]]
        return list(self._candidates)

    def role_match_exists(self, observation_id: UUID) -> bool:
        return str(observation_id) in self._matched_observations

    def save_role_resolution(self, resolution: RoleResolution) -> None:
        """Fold one decision into memory as save_role_resolution writes it, and queue its writes."""
        from .repository import IntelligenceRepository

        if self._resolutions_flushed or self._role_observation_ids is not None:
            raise RuntimeError("this session's role decisions were written; open a new session for more")
        roles = self._load_roles()
        payload = IntelligenceRepository.role_payload(resolution)
        role_id = str(payload["id"])
        stored = roles.get(role_id)
        # An upsert on id: a stored role keeps every column the payload does not name (whether it is active among
        # them), and a new one takes the table's defaults.
        roles[role_id] = {**stored, **payload} if stored is not None else {**payload, "active": True}
        self._role_writes[role_id] = {**self._role_writes.get(role_id, {}), **payload}
        self._identities.pop(role_id, None)
        self._candidates = None

        row = self._observation_rows.get(str(resolution.observation_id))
        if row is None:
            raise RuntimeError("Cannot persist a role alias without its observation")
        seen = {"first_seen_at": row["first_seen_at"], "last_seen_at": row["last_seen_at"]}
        key = (role_id, normalize_title(resolution.observed_alias))
        alias = self._aliases.get(key)
        if alias is None:
            self._aliases[key] = IntelligenceRepository.alias_insert_payload(resolution, seen)
            self._aliases_by_role[role_id].append(key)
        else:
            alias.update(
                IntelligenceRepository.alias_update_payload(resolution, seen, alias.get("match_confidence", 0))
            )
        self._alias_writes[key] = None
        self._match_writes.append(IntelligenceRepository.match_payload(resolution))
        self._matched_observations.add(str(resolution.observation_id))
        self._resolutions.append(resolution)

    def flush_resolutions(self) -> list[tuple[RoleResolution, Exception]]:
        """Write every queued decision in bulk: roles, then aliases, then matches. Returns the decisions that failed.

        On a refused request every decision is written again one at a time by save_role_resolution, which reads the
        rows as they now stand, so what the bulk requests wrote before the refusal is completed rather than duplicated.
        """
        resolutions = self._resolutions
        self._resolutions_flushed = True
        if not resolutions and not self._role_writes:
            return []
        aliases = [self._aliases[key] for key in self._alias_writes]
        try:
            self.repository.upsert_rows("canonical_roles", list(self._role_writes.values()), on_conflict="id")
            self.repository.insert_rows(
                "role_aliases", [{column: alias[column] for column in _ALIAS_COLUMNS} for alias in aliases if "id" not in alias]
            )
            self.repository.upsert_rows(
                "role_aliases",
                [{"id": alias["id"], **{column: alias[column] for column in _ALIAS_COLUMNS}} for alias in aliases if "id" in alias],
                on_conflict="id",
            )
            self.repository.upsert_rows("observation_role_matches", self._match_writes, on_conflict=MATCH_KEY)
            failed: list[tuple[RoleResolution, Exception]] = []
        except Exception:  # noqa: BLE001 - replayed one decision at a time, each failing on its own
            failed = []
            for resolution in resolutions:
                try:
                    self.repository.save_role_resolution(resolution)
                except Exception as exc:  # noqa: BLE001 - decisions persist independently
                    failed.append((resolution, exc))
        self._resolutions = []
        self._role_writes = {}
        self._alias_writes = {}
        self._match_writes = []
        return failed

    def _load_roles(self) -> dict[str, dict[str, Any]]:
        if self._roles is None:
            self._roles = {str(row["id"]): row for row in self.repository.resolution_role_rows(self.company_id)}
            for alias in self.repository.alias_rows_for_company(self.company_id):
                key = (str(alias["canonical_role_id"]), str(alias["normalized_alias"]))
                self._aliases[key] = alias
                self._aliases_by_role[key[0]].append(key)
        return self._roles

    def _identity(self, role_id: str) -> CanonicalRoleIdentity:
        from .repository import IntelligenceRepository

        identity = self._identities.get(role_id)
        if identity is None:
            roles = self._load_roles()
            titles = [str(self._aliases[key]["alias_title"]) for key in self._aliases_by_role.get(role_id, [])]
            identity = IntelligenceRepository.resolution_identity(roles[role_id], [title for title in titles if title])
            self._identities[role_id] = identity
        return identity

    # -- historical reconstruction ----------------------------------------------------------------------------------

    def list_recurring_roles(self, company_id: UUID) -> list[RecurringRoleIdentity]:
        self._require(company_id)
        return self.repository.list_recurring_roles(company_id)

    def list_company_archive_captures(self, company_id: UUID) -> list[ArchiveCapture]:
        self._require(company_id)
        return self.repository.archive_captures_for_sources(self._source_ids)

    def degraded_source_ids(self, company_id: UUID) -> set[UUID]:
        self._require(company_id)
        return self.repository.degraded_among(self._source_ids)

    def list_role_observations(self, role_id: UUID) -> list[JobObservation]:
        from .repository import IntelligenceRepository

        observation_ids = self._load_history().get(str(role_id), [])
        observations = [
            observation
            for observation_id in observation_ids
            if (row := self._observation_rows.get(observation_id)) is not None
            and (observation := IntelligenceRepository._observation_from_row(row)) is not None
        ]
        return sorted(observations, key=lambda item: (item.first_seen_at, str(item.id)))

    def list_historical_events(self, role_id: UUID) -> list[HistoricalOpeningEvent]:
        from .repository import IntelligenceRepository

        self._load_history()
        return IntelligenceRepository.events_from_rows(self._event_rows.get(str(role_id), []))

    def role_evidence_exists(self, observation_id: UUID, role_id: UUID) -> bool:
        self._load_history()
        return (str(observation_id), str(role_id)) in self._evidence_pairs

    def save_historical_openings(self, events: list[HistoricalOpeningEvent]) -> None:
        for event in events:
            self._history.setdefault(str(event.canonical_role_id), _RoleHistory()).events.append(event)

    def link_observation_to_role(
        self,
        observation_id: UUID,
        role_id: UUID,
        *,
        match_confidence: float,
        rationale: str,
    ) -> None:
        self._load_history()
        self._evidence_pairs.add((str(observation_id), str(role_id)))
        self._history.setdefault(str(role_id), _RoleHistory()).links.append(
            (observation_id, role_id, match_confidence, rationale)
        )

    def flush_history(self) -> list[tuple[UUID, int, Exception]]:
        """Write every queued event and attribution in bulk. Returns each role that failed, with its event count.

        On a refused request each role's writes are sent again as the per-item path sent them: its events in one
        upsert, then each attribution the database does not already hold.
        """
        from .repository import IntelligenceRepository

        history = self._history
        self._history = {}
        if not history:
            return []
        try:
            self.repository.upsert_rows(
                "historical_opening_events",
                IntelligenceRepository.event_payloads(
                    [event for item in history.values() for event in item.events], self._stored_quotes()
                ),
                on_conflict=IntelligenceRepository.EVENT_KEY,
            )
            self.repository.upsert_rows(
                "observation_role_matches",
                [
                    IntelligenceRepository.link_payload(
                        observation_id, role_id, match_confidence=confidence, rationale=rationale
                    )
                    for item in history.values()
                    for observation_id, role_id, confidence, rationale in item.links
                ],
                on_conflict=MATCH_KEY,
            )
            return []
        except Exception:  # noqa: BLE001 - replayed role by role, each failing on its own
            failed: list[tuple[UUID, int, Exception]] = []
            for role_id, item in history.items():
                try:
                    self.repository.save_historical_openings(item.events)
                    for observation_id, linked_role, confidence, rationale in item.links:
                        if not self.repository.role_evidence_exists(observation_id, linked_role):
                            self.repository.link_observation_to_role(
                                observation_id, linked_role, match_confidence=confidence, rationale=rationale
                            )
                except Exception as exc:  # noqa: BLE001 - roles persist independently
                    failed.append((UUID(role_id), len(item.events), exc))
            return failed

    def _stored_quotes(self) -> dict[tuple[str, str, str], str]:
        """The quote each stored event was created with, from the events this session already read."""
        return {
            (str(row["canonical_role_id"]), str(row["opened_on"]), str(row["observation_id"])): str(row["evidence_quote"])
            for rows in self._event_rows.values()
            for row in rows
            if row.get("evidence_quote") and row.get("observation_id")
        }

    def _load_history(self) -> dict[str, list[str]]:
        if self._role_observation_ids is None:
            if self._resolutions or self._role_writes:
                raise RuntimeError("flush role resolutions before reconstructing history from them")
            by_role: dict[str, list[str]] = defaultdict(list)
            for row in self.repository.role_matches_for_company(self.company_id):
                observation_id, role_id = str(row["observation_id"]), str(row["canonical_role_id"])
                by_role[role_id].append(observation_id)
                self._evidence_pairs.add((observation_id, role_id))
            # A role's matches can name an observation from another company's source; those are read by id.
            missing = sorted({item for ids in by_role.values() for item in ids} - set(self._observation_rows))
            for row in self.repository.observation_rows_by_id(missing):
                self._observation_rows[str(row["id"])] = row
            for row in self.repository.event_rows_for_company(self.company_id):
                self._event_rows[str(row["canonical_role_id"])].append(row)
            self._role_observation_ids = dict(by_role)
            # Reconstruction quotes an observation only in an event it creates, and an event it already created keeps
            # the quote it has (repository.event_payloads). So the text needed is that of the observations this
            # company's roles have no event for yet -- in one request, not one per role.
            evidenced = {
                (str(row["canonical_role_id"]), str(row["observation_id"]))
                for rows in self._event_rows.values()
                for row in rows
                if row.get("observation_id")
            }
            self._hydrate_excerpts(
                observation_id
                for role_id, ids in by_role.items()
                for observation_id in ids
                if (role_id, observation_id) not in evidenced
            )
        return self._role_observation_ids
