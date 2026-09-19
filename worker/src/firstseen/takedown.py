"""Stopping collection from a source or a company, and withdrawing a company from the product.

docs/takedown.md is the procedure; this module is what its commands run. Every change is one call to
`apply_collection_takedown` (migration 202608140039), which flips `sources.enabled` and, for a withdrawal,
`canonical_roles.active`, and writes an append-only `collection_takedowns` row saying who, when, why, and exactly what
changed, all in one transaction.

- `disable` stops collection from one source or every source of a company. Nothing else changes.
- `withdraw` disables every source of a company and sets every one of its canonical roles `active = false`, which
  removes them from every product read path and from every other role's priors. Nothing is deleted.
- `enable` resumes one source, or lifts a company-wide hold: exactly the sources the hold turned off come back, and a
  withdrawal's roles are listed again.

While a company is held (its latest company-wide action is disable or withdraw), discovery and board registration refuse
to save its sources (`CollectionHeldError`), so re-running discovery cannot turn it back on.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Any, Literal, Protocol
from uuid import UUID

TakedownAction = Literal["disable", "enable", "withdraw"]
# `erase` is written only by the manual erasure step in docs/takedown.md; it holds collection like a withdrawal.
HOLD_ACTIONS = frozenset({"disable", "withdraw", "erase"})
MAX_REASON_BYTES = 2_000
MAX_REQUESTER_BYTES = 200


class TakedownRefused(ValueError):
    """A takedown command that cannot be carried out as asked. Nothing was changed."""

    def __init__(self, reason: str, message: str) -> None:
        self.reason = reason
        super().__init__(message)


class CollectionHeldError(RuntimeError):
    """Raised instead of saving sources for a company whose collection is held or withdrawn."""

    def __init__(self, company: str, hold: dict[str, Any]) -> None:
        self.hold = hold
        state = {"withdraw": "withdrawn", "erase": "withdrawn and erased"}.get(str(hold.get("action")), "disabled")
        super().__init__(
            f"collection for {company} is {state} since {hold.get('recorded_at')}; "
            "lift it with `firstseen sources enable --company` first"
        )


class TakedownStore(Protocol):
    def company_by_domain(self, domain: str) -> dict[str, Any] | None: ...

    def source_with_company(self, source_id: UUID) -> dict[str, Any] | None: ...

    def company_sources(self, company_id: UUID) -> list[dict[str, Any]]: ...

    def company_hold(self, company_id: UUID) -> dict[str, Any] | None: ...

    def takedown_history(self, company_id: UUID) -> list[dict[str, Any]]: ...

    def withdrawal_preview(self, company_id: UUID) -> dict[str, int]: ...

    def apply_collection_takedown(
        self,
        company_id: UUID,
        source_id: UUID | None,
        action: TakedownAction,
        reason: str,
        requested_by: str,
    ) -> dict[str, Any]: ...


def _required_text(value: str | None, name: str, limit: int) -> str:
    text = (value or "").strip()
    if not text:
        raise TakedownRefused(f"{name}_required", f"--{name} is required and was empty. Nothing was changed.")
    if len(text.encode()) > limit:
        raise TakedownRefused(f"{name}_too_long", f"--{name} is longer than {limit} bytes. Nothing was changed.")
    return text


def _describe_sources(rows: list[dict[str, Any]], ids: list[str]) -> list[dict[str, Any]]:
    by_id = {str(row["id"]): row for row in rows}
    return [
        {"id": source_id, "adapter": by_id.get(source_id, {}).get("adapter"), "url": by_id.get(source_id, {}).get("url")}
        for source_id in ids
    ]


@dataclass
class TakedownService:
    store: TakedownStore

    def company(self, domain: str) -> dict[str, Any]:
        row = self.store.company_by_domain(domain.strip().casefold().removeprefix("www."))
        if row is None:
            raise TakedownRefused("unknown_company", f"No company has the domain {domain!r}. Nothing was changed.")
        return row

    def _target(self, company_domain: str | None, source_id: UUID | None) -> tuple[dict[str, Any], UUID | None]:
        if (company_domain is None) == (source_id is None):
            raise TakedownRefused("target_required", "Name exactly one of --company or --source. Nothing was changed.")
        if source_id is None:
            return self.company(str(company_domain)), None
        source = self.store.source_with_company(source_id)
        if source is None:
            raise TakedownRefused("unknown_source", f"No source has the id {source_id}. Nothing was changed.")
        company = dict(source.get("companies") or {})
        company["id"] = source["company_id"]
        return company, source_id

    def _apply(
        self,
        action: TakedownAction,
        company: dict[str, Any],
        source_id: UUID | None,
        reason: str,
        requested_by: str,
    ) -> dict[str, Any]:
        company_id = UUID(str(company["id"]))
        sources = self.store.company_sources(company_id)
        record = self.store.apply_collection_takedown(company_id, source_id, action, reason, requested_by)
        changed = [str(item) for item in record.get("source_ids") or []]
        return {
            "status": "applied",
            "action": action,
            "company": {"id": str(company_id), "name": company.get("name"), "domain": company.get("domain")},
            "scope": "source" if source_id else "company",
            "sources_changed": _describe_sources(sources, changed),
            "roles_changed": len(record.get("role_ids") or []),
            "audit_id": str(record.get("id")),
            "recorded_at": record.get("recorded_at"),
            "reason": record.get("reason"),
            "requested_by": record.get("requested_by"),
        }

    def disable(
        self, *, company_domain: str | None, source_id: UUID | None, reason: str, requested_by: str
    ) -> dict[str, Any]:
        reason = _required_text(reason, "reason", MAX_REASON_BYTES)
        requested_by = _required_text(requested_by, "by", MAX_REQUESTER_BYTES)
        company, source = self._target(company_domain, source_id)
        return self._apply("disable", company, source, reason, requested_by)

    def enable(
        self, *, company_domain: str | None, source_id: UUID | None, reason: str, requested_by: str
    ) -> dict[str, Any]:
        reason = _required_text(reason, "reason", MAX_REASON_BYTES)
        requested_by = _required_text(requested_by, "by", MAX_REQUESTER_BYTES)
        company, source = self._target(company_domain, source_id)
        hold = self.store.company_hold(UUID(str(company["id"])))
        if source is not None and hold is not None:
            raise TakedownRefused(
                "company_held",
                f"{company.get('name')} is {'withdrawn' if hold.get('action') == 'withdraw' else 'disabled'} as a whole "
                f"({hold.get('reason')!r}, {hold.get('recorded_at')}). Lift that first with "
                f"`firstseen sources enable --company {company.get('domain')}`. Nothing was changed.",
            )
        if source is None and hold is None:
            raise TakedownRefused(
                "no_company_hold",
                f"{company.get('name')} has no company-wide hold to lift; enable its sources one at a time with "
                "--source. Nothing was changed.",
            )
        return self._apply("enable", company, source, reason, requested_by)

    def withdraw(self, *, company_domain: str, reason: str, requested_by: str, apply: bool) -> dict[str, Any]:
        reason = _required_text(reason, "reason", MAX_REASON_BYTES)
        company = self.company(company_domain)
        company_id = UUID(str(company["id"]))
        if not apply:
            sources = self.store.company_sources(company_id)
            enabled = [row for row in sources if row.get("enabled")]
            return {
                "status": "planned",
                "applied": False,
                "company": {"id": str(company_id), "name": company.get("name"), "domain": company.get("domain")},
                "already_held": self.store.company_hold(company_id) is not None,
                "sources_to_disable": len(enabled),
                "sources_to_disable_by_adapter": dict(sorted(Counter(str(row.get("adapter")) for row in enabled).items())),
                "sources_already_disabled": len(sources) - len(enabled),
                **self.store.withdrawal_preview(company_id),
                "retained": "Observations, events, forecasts, and follows are kept, unreachable from the product.",
                "next": "Run again with --apply to withdraw.",
            }
        requested_by = _required_text(requested_by, "by", MAX_REQUESTER_BYTES)
        return {**self._apply("withdraw", company, None, reason, requested_by), "applied": True}

    def show(self, company_domain: str) -> dict[str, Any]:
        company = self.company(company_domain)
        company_id = UUID(str(company["id"]))
        hold = self.store.company_hold(company_id)
        return {
            "company": {"id": str(company_id), "name": company.get("name"), "domain": company.get("domain")},
            "held": None if hold is None else {key: hold.get(key) for key in ("action", "reason", "requested_by", "recorded_at")},
            "sources": [
                {"id": str(row["id"]), "adapter": row.get("adapter"), "enabled": bool(row.get("enabled")), "url": row.get("url")}
                for row in self.store.company_sources(company_id)
            ],
            "history": [
                {
                    "recorded_at": row.get("recorded_at"),
                    "action": row.get("action"),
                    "scope": "source" if row.get("source_id") else "company",
                    "source_id": row.get("source_id"),
                    "sources_changed": len(row.get("source_ids") or []),
                    "roles_changed": len(row.get("role_ids") or []),
                    "reason": row.get("reason"),
                    "requested_by": row.get("requested_by"),
                }
                for row in self.store.takedown_history(company_id)
            ],
        }
