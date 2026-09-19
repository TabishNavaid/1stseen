"""Split canonical roles that merged two programs, and record every move.

`role_resolution` treated an `unknown` level as compatible with every level, so an unmarked
"Research Engineer" absorbed "Research Intern". A title-stated early-career type is now a hard
identity incompatibility (`stated_early_career_types`), which means roles created before that rule
have to be re-keyed: this is the explicit re-resolution migration, with its audit, that a resolver
version change requires, rather than letting a later ingestion run silently redecide them.

The split is deliberately conservative and does only what the new rule can justify:

* A role is split only when the titles it was observed under state more than one early-career type.
  Merges of a different kind — two disciplines at the same type, a specialization split, senior
  beside junior — are left exactly as they are, and reported, because this rule cannot decide them.
* The largest group keeps the existing role id, so its forecasts, backtest cases, digest items and
  follows stay where they are and only the evidence that never belonged to it moves out.
* Each other group becomes a new role, unclassified, so `firstseen classify-roles` decides its scope
  from its own titles instead of inheriting a judgement made about a different program.
* Nothing is deleted. A role left with no evidence is retired (`active = false`, `superseded_by`),
  never dropped, because its stored forecasts record what was predicted from the evidence as it
  stood.

Every move goes through `split_canonical_role` (migration 202608140034), one transaction per split,
which refuses a split whose observations no longer belong to the role it was computed from.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Protocol
from uuid import UUID

from .adapters.generic import clean_static_anchor_title
from .role_resolution import RESOLVER_VERSION, normalize_title, stated_early_career_types
from .scope import EarlyCareerType

#: The resolver that produced the roles this pass re-keys.
SUPERSEDED_RESOLVER_VERSION = "hybrid-role-resolver-v1"


class RoleIdentityStore(Protocol):
    def list_role_identity_candidates(self, company_id: UUID | None) -> list[dict[str, Any]]: ...

    def split_canonical_role(
        self,
        *,
        source_role_id: UUID,
        canonical_title: str,
        normalized_title: str,
        level: str,
        recurrence_key: str,
        observation_ids: list[UUID],
        stated_types: list[str],
        reason: str,
        resolver_version_from: str,
        resolver_version_to: str,
        source_canonical_title: str | None,
        source_normalized_title: str | None,
        source_level: str | None,
    ) -> UUID: ...


#: The resolver's level for each early-career type a title can state.
_LEVEL_FOR_TYPE: dict[EarlyCareerType, str] = {
    "internship": "internship",
    "co_op": "internship",
    "apprenticeship": "apprenticeship",
    "new_grad": "new_grad",
    "graduate_program": "new_grad",
    "rotational": "new_grad",
}


def _level_for(types: frozenset[EarlyCareerType]) -> str:
    """The stored level a group of stated types maps to; `unknown` when it states none."""
    for kind in ("internship", "co_op", "apprenticeship", "graduate_program", "new_grad", "rotational"):
        if kind in types:
            return _LEVEL_FOR_TYPE[kind]
    return "unknown"


def recurrence_key_for(company_normalized: str, title: str, types: frozenset[EarlyCareerType]) -> str:
    """A stable key for a split-out program: its normalized title plus what its titles state."""
    parts = [company_normalized, normalize_title(title), *sorted(types)]
    key = re.sub(r"[^a-z0-9]+", "_", " ".join(parts).casefold()).strip("_")
    return re.sub(r"_+", "_", key) or "role"


@dataclass
class RoleSplit:
    """One group of a merged role's observations, and the program it becomes."""

    stated_types: frozenset[EarlyCareerType]
    observation_ids: list[UUID]
    titles: list[str]

    @property
    def title(self) -> str:
        """The group's most common title, longest first on a tie, so the name is the fullest one."""
        counts: dict[str, int] = defaultdict(int)
        for title in self.titles:
            counts[clean_static_anchor_title(title)] += 1
        return max(sorted(counts), key=lambda item: (counts[item], len(item)))


@dataclass
class RoleIdentityPlan:
    """What a re-resolution would do to one canonical role."""

    role_id: UUID
    company: str
    canonical_title: str
    keeps: RoleSplit
    moves: list[RoleSplit]


@dataclass
class RoleIdentitySummary:
    roles_examined: int = 0
    roles_split: int = 0
    roles_created: int = 0
    observations_moved: int = 0
    failures: int = 0
    unsplit_merges: int = 0
    by_company: dict[str, int] = field(default_factory=lambda: defaultdict(int))

    def as_dict(self) -> dict[str, object]:
        return {
            "roles_examined": self.roles_examined,
            "roles_split": self.roles_split,
            "roles_created": self.roles_created,
            "observations_moved": self.observations_moved,
            "unsplit_merges": self.unsplit_merges,
            "failures": self.failures,
            "by_company": dict(sorted(self.by_company.items())),
        }


def plan_role_identity_splits(rows: list[dict[str, Any]]) -> list[RoleIdentityPlan]:
    """Group each role's observations by what their titles state, and keep the roles that disagree.

    `rows` are the role's observations: `role_id`, `company`, `canonical_title`, `company_normalized`,
    `observation_id` and `raw_title`. A role whose observations all state the same thing is not a
    merge this rule can see, and is left alone.
    """
    by_role: dict[UUID, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_role[UUID(str(row["role_id"]))].append(row)

    plans: list[RoleIdentityPlan] = []
    for role_id, observations in by_role.items():
        groups: dict[frozenset[EarlyCareerType], RoleSplit] = {}
        for row in observations:
            title = str(row["raw_title"] or "")
            types = stated_early_career_types(title)
            group = groups.setdefault(types, RoleSplit(stated_types=types, observation_ids=[], titles=[]))
            group.observation_ids.append(UUID(str(row["observation_id"])))
            group.titles.append(title)
        if len(groups) < 2:
            continue
        # The largest group keeps the role id, so the least evidence moves. Ties break on the group
        # that states a type, then on the sorted type names, so the choice is deterministic.
        ordered = sorted(
            groups.values(),
            key=lambda item: (-len(item.observation_ids), not item.stated_types, sorted(item.stated_types)),
        )
        plans.append(
            RoleIdentityPlan(
                role_id=role_id,
                company=str(observations[0]["company"]),
                canonical_title=str(observations[0]["canonical_title"]),
                keeps=ordered[0],
                moves=ordered[1:],
            )
        )
    return sorted(plans, key=lambda item: (item.company, item.canonical_title, str(item.role_id)))


class RoleIdentityMigrationService:
    """Apply the planned splits, one transaction each, and report what it could not decide."""

    def __init__(self, store: RoleIdentityStore) -> None:
        self.store = store

    def run(self, company_id: UUID | None = None, *, apply: bool = False) -> tuple[RoleIdentitySummary, list[RoleIdentityPlan]]:
        rows = self.store.list_role_identity_candidates(company_id)
        summary = RoleIdentitySummary()
        summary.roles_examined = len({str(row["role_id"]) for row in rows})
        plans = plan_role_identity_splits(rows)
        merged_reasons = {str(row["role_id"]) for row in rows if row.get("scope_reason") == "alias_conflict"}
        summary.unsplit_merges = len(merged_reasons - {str(plan.role_id) for plan in plans})

        for plan in plans:
            summary.roles_split += 1
            summary.by_company[plan.company] += 1
            if not apply:
                summary.roles_created += len(plan.moves)
                summary.observations_moved += sum(len(split.observation_ids) for split in plan.moves)
                continue
            # The role that keeps the id can be left named for the program that left it — "Research
            # Engineer, Self-Driving" holding only interns. Rename it to what its own evidence says.
            rename = stated_early_career_types(plan.canonical_title) != plan.keeps.stated_types
            source_title = plan.keeps.title if rename else None
            for index, split in enumerate(plan.moves):
                try:
                    company_normalized = str(
                        next(row for row in rows if str(row["role_id"]) == str(plan.role_id))["company_normalized"]
                    )
                    self.store.split_canonical_role(
                        # Renamed once, on the first split, so a later one cannot rename it again.
                        source_canonical_title=source_title if index == 0 else None,
                        source_normalized_title=normalize_title(source_title) if source_title and index == 0 else None,
                        source_level=_level_for(plan.keeps.stated_types) if rename and index == 0 else None,
                        source_role_id=plan.role_id,
                        canonical_title=split.title,
                        normalized_title=normalize_title(split.title),
                        level=_level_for(split.stated_types),
                        recurrence_key=recurrence_key_for(company_normalized, split.title, split.stated_types),
                        observation_ids=split.observation_ids,
                        stated_types=sorted(split.stated_types),
                        reason=(
                            "title-stated early-career type differs from the rest of the role: "
                            f"{', '.join(sorted(split.stated_types)) or 'none stated'}"
                        ),
                        resolver_version_from=SUPERSEDED_RESOLVER_VERSION,
                        resolver_version_to=RESOLVER_VERSION,
                    )
                    summary.roles_created += 1
                    summary.observations_moved += len(split.observation_ids)
                except Exception:  # noqa: BLE001 - roles split independently; the count is reported
                    summary.failures += 1
        return summary, plans
