"""A person's decision on a role the scope classifier left ambiguous (`firstseen review-scope`).

The classifier abstains rather than guess (scope.py). This is the cheapest real path for the abstentions: list each
ambiguous role with the evidence that made it ambiguous, take a decision, and write it as stated evidence with
provenance (`role_scope_reviews`: who, when, from what, why, and what they were shown). Reclassification keeps the
decision while the role's titles and ATS filing match what was decided on.

Every decision also becomes a labeled case in tests/fixtures/role_resolution_cases.json, so the classifier improves
instead of asking again:

- `--basis titles`: the titles and ATS filing decide the role, so the case expects the decision. The fixture test
  fails until a rule reaches it, and the next role with those titles is decided without review.
- `--basis posting`: the decision needed the posting itself ("Summer Intern" whose description is backend work), so
  the case expects the rules' abstention. The test then fails if a rule starts guessing from titles that cannot
  decide, and the stored decision is what keeps this role from being asked again.

Scraped titles and excerpts are untrusted: rendering strips control and formatting characters so a posting cannot
write terminal escape sequences.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import Any, Literal, Protocol, get_args
from uuid import UUID, uuid4

from pydantic import BaseModel, Field, model_validator

from .scope import (
    DISCIPLINE_PRECEDENCE,
    SCOPE_CLASSIFIER_VERSION,
    SCOPE_EVIDENCE_LIMIT,
    Discipline,
    EarlyCareerType,
    RoleScopeClassification,
    RoleScopeInput,
    ScopeEvidence,
    ScopeReason,
    TitleEvidence,
    classify_role_scope,
    scope_input_fingerprint,
)

ReviewBasis = Literal["titles", "posting"]
REVIEW_BASES: tuple[ReviewBasis, ...] = get_args(ReviewBasis)
OutOfScopeReason = Literal[
    "not_early_career",
    "senior_role",
    "contract_or_temporary",
    "non_technical_function",
    "unlisted_technical_discipline",
    "not_a_role",
]
OUT_OF_SCOPE_REASONS: tuple[OutOfScopeReason, ...] = get_args(OutOfScopeReason)
AMBIGUOUS_REASONS: tuple[ScopeReason, ...] = (
    "alias_conflict",
    "discipline_unknown",
    "function_and_discipline_conflict",
    "seniority_conflict",
    "early_career_type_conflict",
    "design_or_advocacy_boundary",
    "discipline_conflict",
)
# The same wording as the reasons table in docs/role-scope.md.
AMBIGUOUS_REASON_TEXT: dict[str, str] = {
    "alias_conflict": "the role's titles classify differently, usually a resolver merge",
    "discipline_unknown": "early-career, but nothing names the discipline",
    "function_and_discipline_conflict": "a product, design, data-analyst, or manufacturing title beside a function word",
    "seniority_conflict": "early-career evidence and a seniority marker",
    "early_career_type_conflict": "an internship and a full-time program in one title",
    "design_or_advocacy_boundary": "brand, graphic, game, or technical design; developer or designer advocacy",
    "discipline_conflict": "a listed discipline word beside an unlisted role noun",
}
DEFAULT_FIXTURES = Path(__file__).resolve().parents[2] / "tests" / "fixtures" / "role_resolution_cases.json"
SHOWN_TITLE_LIMIT = 40
POSTING_LIMIT = 3
EXCERPT_CHARS = 600


class ScopeReviewError(ValueError):
    """A decision that cannot be recorded; the message says why and what to do."""


class ScopeDecision(BaseModel):
    status: Literal["in_scope", "out_of_scope"]
    reason: ScopeReason
    discipline: Discipline | None = None
    early_career_type: EarlyCareerType | None = None
    basis: ReviewBasis
    note: str = Field(min_length=3, max_length=1_000)
    reviewer: str = Field(min_length=1, max_length=120)

    @model_validator(mode="after")
    def is_a_complete_decision(self) -> ScopeDecision:
        self.note = " ".join(self.note.split())
        self.reviewer = " ".join(self.reviewer.split())
        if len(self.note) < 3 or not self.reviewer:
            raise ValueError("a decision needs a reviewer and a note saying why")
        if self.status == "in_scope":
            if self.reason != "in_scope" or self.discipline is None or self.early_career_type is None:
                raise ValueError("an in-scope decision names a discipline and an early-career type")
        else:
            if self.reason not in OUT_OF_SCOPE_REASONS:
                raise ValueError(f"an out-of-scope decision gives one of: {', '.join(OUT_OF_SCOPE_REASONS)}")
            if self.discipline is not None:
                raise ValueError("an out-of-scope decision names no discipline; say what it is in the note")
        return self


class Posting(BaseModel):
    url: str
    title: str = ""
    excerpt: str = ""


class StoredScopeReview(BaseModel):
    id: UUID
    status: str
    reason: str
    discipline: str | None = None
    early_career_type: str | None = None
    basis: str
    note: str
    reviewer: str
    evidence_fingerprint: str
    decided_at: datetime


class ScopeReviewItem(BaseModel):
    """One role as the reviewer sees it."""

    role_id: UUID
    company: str
    canonical_title: str
    role: RoleScopeInput
    current: RoleScopeClassification
    classified_at: datetime
    postings: list[Posting] = Field(default_factory=list)
    last_review: StoredScopeReview | None = None


class ScopeReviewStore(Protocol):
    def list_scope_review_queue(
        self, company_ids: Sequence[UUID] | None = None, reason: str | None = None
    ) -> list[ScopeReviewItem]: ...

    def get_scope_review_item(self, role_id: UUID) -> ScopeReviewItem | None: ...

    def record_role_scope_review(
        self,
        *,
        review_id: UUID,
        item: ScopeReviewItem,
        decision: ScopeDecision,
        classification: RoleScopeClassification,
        fingerprint: str,
        shown: dict[str, Any],
    ) -> datetime: ...


@dataclass(frozen=True)
class ScopeReviewOutcome:
    review_id: UUID
    role_id: UUID
    decided_at: datetime
    classification: RoleScopeClassification
    fixture_case_id: str
    fixture_expected: dict[str, str | None]
    rules_now: dict[str, str | None]

    @property
    def rules_agree(self) -> bool:
        return self.fixture_expected == self.rules_now

    def as_dict(self) -> dict[str, object]:
        return {
            "review_id": str(self.review_id),
            "role_id": str(self.role_id),
            "decided_at": self.decided_at.isoformat(),
            "status": self.classification.status,
            "reason": self.classification.reason,
            "discipline": self.classification.discipline,
            "early_career_type": self.classification.early_career_type,
            "fixture_case": self.fixture_case_id,
            "fixture_expects": self.fixture_expected,
            "rules_now": self.rules_now,
            "rules_agree": self.rules_agree,
        }


def outcome_of(classification: RoleScopeClassification) -> dict[str, str | None]:
    return {
        "status": classification.status,
        "reason": classification.reason,
        "discipline": classification.discipline,
        "early_career_type": classification.early_career_type,
    }


def title_evidence_of(role: RoleScopeInput) -> tuple[TitleEvidence, ...]:
    if role.title_evidence:
        return role.title_evidence
    return tuple(
        TitleEvidence(title=title, categories=role.categories, employment_types=role.employment_types)
        for title in dict.fromkeys(role.titles)
    )


def per_title_outcomes(role: RoleScopeInput) -> list[tuple[TitleEvidence, RoleScopeClassification]]:
    """How the rules classify each title on its own, with the ATS filing that came with it."""
    return [
        (item, classify_role_scope(RoleScopeInput(titles=(item.title,), title_evidence=(item,))))
        for item in title_evidence_of(role)
        if item.title.strip()
    ]


class ScopeReviewService:
    def __init__(self, store: ScopeReviewStore, fixtures: Path = DEFAULT_FIXTURES) -> None:
        self.store = store
        self.fixtures = fixtures

    def queue(self, company_ids: Sequence[UUID] | None = None, reason: str | None = None) -> list[ScopeReviewItem]:
        items = self.store.list_scope_review_queue(company_ids, reason)
        order = {value: index for index, value in enumerate(AMBIGUOUS_REASONS)}
        return sorted(
            items,
            key=lambda item: (order.get(item.current.reason, len(order)), item.company.casefold(), item.canonical_title, str(item.role_id)),
        )

    def decide(self, role_id: UUID, decision: ScopeDecision) -> ScopeReviewOutcome:
        item = self.store.get_scope_review_item(role_id)
        if item is None:
            raise ScopeReviewError(f"no active canonical role {role_id}")
        current = item.current
        if current.status != "ambiguous" and current.method != "human_review":
            raise ScopeReviewError(
                f"role {role_id} is not awaiting review: the rules classify it {current.status} ({current.reason}). "
                "Change the rules and their labeled cases instead of overriding them one role at a time."
            )
        rules = classify_role_scope(item.role)
        if decision.status == "out_of_scope" and decision.early_career_type is None:
            # An exclusion decides scope, not the program type: "Marketing Intern" is still an internship.
            decision = decision.model_copy(update={"early_career_type": rules.early_career_type})
        if decision.basis == "titles" and rules.reason == "alias_conflict":
            raise ScopeReviewError(
                "these titles classify differently from one another, which is a resolver merge: no rule should decide a "
                "merge from its titles. Record it with --basis posting, and say in the note which title the role really is."
            )
        document = load_fixture_document(self.fixtures)
        review_id = uuid4()
        fingerprint = scope_input_fingerprint(item.role)
        classification = reviewed_classification(decision, current, review_id)
        decided_at = self.store.record_role_scope_review(
            review_id=review_id,
            item=item,
            decision=decision,
            classification=classification,
            fingerprint=fingerprint,
            shown=shown_to_reviewer(item, rules),
        )
        case = fixture_case(item, decision, review_id, decided_at.date(), rules)
        write_fixture_document(self.fixtures, with_case(document, case))
        return ScopeReviewOutcome(
            review_id=review_id,
            role_id=item.role_id,
            decided_at=decided_at,
            classification=classification,
            fixture_case_id=str(case["id"]),
            fixture_expected=case["expected"],
            rules_now=outcome_of(rules),
        )


def reviewed_classification(
    decision: ScopeDecision, current: RoleScopeClassification, review_id: UUID
) -> RoleScopeClassification:
    """The stored outcome: the person's statement first, then the evidence they were shown."""
    statement = ScopeEvidence(
        tier="reviewer", kind="decision", rule=str(review_id), matched=decision.note[:300], field=decision.basis
    )
    shown = [item for item in current.evidence if item.tier != "reviewer"]
    return RoleScopeClassification(
        status=decision.status,
        reason=decision.reason,
        discipline=decision.discipline,
        early_career_type=decision.early_career_type,
        evidence=[statement, *shown][:SCOPE_EVIDENCE_LIMIT],
        method="human_review",
        classifier_version=SCOPE_CLASSIFIER_VERSION,
    )


def shown_to_reviewer(item: ScopeReviewItem, rules: RoleScopeClassification) -> dict[str, Any]:
    return {
        "classification": item.current.model_dump(mode="json"),
        "rules": outcome_of(rules),
        "titles": [
            {**_evidence_json(evidence), "rules": outcome_of(outcome)}
            for evidence, outcome in per_title_outcomes(item.role)[:SHOWN_TITLE_LIMIT]
        ],
        "postings": [posting.url for posting in item.postings[:POSTING_LIMIT]],
        "previous_review": str(item.last_review.id) if item.last_review else None,
    }


def _evidence_json(item: TitleEvidence) -> dict[str, Any]:
    value: dict[str, Any] = {"title": item.title}
    if item.categories:
        value["categories"] = [category.model_dump(exclude_none=True) for category in item.categories]
    if item.employment_types:
        value["employment_types"] = list(item.employment_types)
    return value


def _slug(value: str, limit: int) -> str:
    folded = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "_", folded).strip("_")[:limit].strip("_") or "role"


def fixture_case(
    item: ScopeReviewItem, decision: ScopeDecision, review_id: UUID, decided_on: date, rules: RoleScopeClassification
) -> dict[str, Any]:
    decided = {
        "status": decision.status,
        "reason": decision.reason,
        "discipline": decision.discipline,
        "early_career_type": decision.early_career_type,
    }
    evidence = title_evidence_of(item.role)
    case: dict[str, Any] = {
        "id": f"review_{_slug(item.company, 24)}_{_slug(item.canonical_title, 40)}_{item.role_id.hex[:8]}",
        "titles": [entry.title for entry in evidence],
    }
    if any(entry.categories or entry.employment_types for entry in evidence):
        case["title_evidence"] = [_evidence_json(entry) for entry in evidence]
    if decision.basis == "titles":
        case["expected"] = decided
        case["note"] = f"Reviewed {decided_on.isoformat()} by {decision.reviewer}, from the titles: {decision.note}"
    else:
        case["expected"] = outcome_of(rules)
        case["note"] = (
            f"Reviewed {decided_on.isoformat()} by {decision.reviewer}, from the posting: {decision.note} "
            "The titles alone do not decide it, so the rules keep sending it to review."
        )
    case["review"] = {
        "role_id": str(item.role_id),
        "review_id": str(review_id),
        "company": item.company,
        "decided": decided,
        "basis": decision.basis,
        "reviewer": decision.reviewer,
        "decided_on": decided_on.isoformat(),
    }
    return case


def load_fixture_document(path: Path) -> dict[str, Any]:
    """Read the labeled cases, refusing before any write when the file is missing or malformed."""
    try:
        document = json.loads(path.read_text())
    except FileNotFoundError as error:
        raise ScopeReviewError(
            f"the labeled cases are not at {path}; run from a checkout, or pass --fixtures. Nothing was recorded."
        ) from error
    except ValueError as error:
        raise ScopeReviewError(f"{path} is not valid JSON ({error}). Nothing was recorded.") from error
    if not isinstance(document, dict) or not isinstance(document.get("scope"), list):
        raise ScopeReviewError(f"{path} has no \"scope\" case list. Nothing was recorded.")
    return document


def with_case(document: dict[str, Any], case: dict[str, Any]) -> dict[str, Any]:
    """Add the case, replacing an earlier review of the same role so a changed decision is not labeled twice."""
    role_id = case["review"]["role_id"]
    kept = [
        existing
        for existing in document["scope"]
        if not (isinstance(existing.get("review"), dict) and existing["review"].get("role_id") == role_id)
        and existing.get("id") != case["id"]
    ]
    return {**document, "scope": [*kept, case]}


def write_fixture_document(path: Path, document: dict[str, Any]) -> None:
    temporary = path.with_name(f".{path.name}.tmp")
    temporary.write_text(json.dumps(document, indent=1, ensure_ascii=False) + "\n")
    temporary.replace(path)


def printable(value: object, limit: int | None = None) -> str:
    """Scraped text as inert terminal output: control and formatting characters (escape sequences, bidi overrides)
    become spaces, and whitespace runs collapse."""
    text = "".join(" " if unicodedata.category(character).startswith("C") else character for character in str(value))
    text = " ".join(text.split())
    return text if limit is None or len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _outcome_text(classification: RoleScopeClassification | StoredScopeReview) -> str:
    parts = [classification.status, f"({classification.reason})"]
    if classification.discipline or classification.early_career_type:
        parts.append(f"{classification.discipline or 'no discipline'} / {classification.early_career_type or 'no type'}")
    return " ".join(parts)


def _evidence_text(evidence: Sequence[ScopeEvidence]) -> str:
    return "; ".join(
        f"{item.kind} {item.rule} \"{printable(item.matched, 80)}\" ({item.tier})" for item in evidence
    ) or "nothing matched"


def render_review_item(item: ScopeReviewItem, position: int, total: int) -> str:
    current = item.current
    lines = [
        f"[{position}/{total}] {item.role_id}",
        f"  {printable(item.company, 80)}: {printable(item.canonical_title, 160)}",
        f"  ambiguous: {current.reason}, {AMBIGUOUS_REASON_TEXT.get(current.reason, 'see docs/role-scope.md')}",
        "  titles, each as the rules classify it alone:",
    ]
    outcomes = per_title_outcomes(item.role)
    for evidence, outcome in outcomes[:SHOWN_TITLE_LIMIT]:
        filing: list[str] = []
        for category in evidence.categories[:3]:
            filing.extend(f"{key} \"{printable(value, 60)}\"" for key, value in category.model_dump(exclude_none=True).items())
        if evidence.employment_types:
            filing.append("employment " + ", ".join(f"\"{printable(value, 40)}\"" for value in evidence.employment_types))
        lines.append(f"    - \"{printable(evidence.title, 160)}\" -> {_outcome_text(outcome)}")
        if filing:
            lines.append(f"        filed as: {'; '.join(filing)}")
        lines.append(f"        evidence: {_evidence_text([entry for entry in outcome.evidence if entry.tier != 'model'])}")
    if len(outcomes) > SHOWN_TITLE_LIMIT:
        lines.append(f"    ... and {len(outcomes) - SHOWN_TITLE_LIMIT} more titles")
    suggestions = [entry for entry in current.evidence if entry.tier == "model"]
    for suggestion in suggestions:
        lines.append(
            f"  model suggestion (not a decision): {suggestion.rule}, quoting \"{printable(suggestion.matched, 160)}\""
        )
    if item.last_review is not None:
        review = item.last_review
        lines.append(
            f"  earlier decision: {_outcome_text(review)} by {printable(review.reviewer, 60)} on "
            f"{review.decided_at.date().isoformat()}, from the {review.basis}: \"{printable(review.note, 200)}\""
        )
        if current.method != "human_review":
            lines.append("    the titles or ATS filing changed since, so it is asked again")
    for posting in item.postings[:POSTING_LIMIT]:
        lines.append(f"  posting: {printable(posting.url, 300)}")
        if posting.excerpt:
            lines.append(f"    \"{printable(posting.excerpt, EXCERPT_CHARS)}\"")
    lines.append(
        "  decide: firstseen review-scope decide "
        f"{item.role_id} (--in-scope --discipline D --type T | --out-of-scope REASON) --basis titles|posting --note \"why\""
    )
    return "\n".join(lines)


def render_queue(items: Sequence[ScopeReviewItem], limit: int) -> str:
    if not items:
        return "No roles await scope review."
    by_reason: dict[str, int] = {}
    for item in items:
        by_reason[item.current.reason] = by_reason.get(item.current.reason, 0) + 1
    shown = items[:limit]
    header = [
        f"{len(items)} roles await scope review: "
        + ", ".join(f"{reason} {count}" for reason, count in by_reason.items())
        + (f". Showing {len(shown)}; pass --limit or --reason for more." if len(shown) < len(items) else "."),
        f"Disciplines: {', '.join(DISCIPLINE_PRECEDENCE)}.",
        f"Out-of-scope reasons: {', '.join(OUT_OF_SCOPE_REASONS)}.",
        "Scraped titles and excerpts below are untrusted evidence, shown as text.",
    ]
    return "\n\n".join(["\n".join(header), *(render_review_item(item, index + 1, len(shown)) for index, item in enumerate(shown))])
