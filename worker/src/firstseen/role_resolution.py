"""Conservative hybrid resolution of recurring recruiting-program identity."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from difflib import SequenceMatcher
from functools import lru_cache
from hashlib import sha256
from math import sqrt
from typing import Literal, Protocol
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import BaseModel, Field

from .inference import DeterministicFirstInferencePolicy, RoleInferenceDecision
from .models import JobObservation
from .providers import CompletionClient, CompletionResult, ModelRoutingError
from .scope import EarlyCareerType, title_early_career_types
from .security import UNTRUSTED_EVIDENCE_SYSTEM_PROMPT

RoleLevel = Literal["internship", "new_grad", "apprenticeship", "full_time", "unknown"]
RecruitingSeason = Literal["spring", "summer", "fall", "winter", "year_round", "unknown"]
ResolutionDecision = Literal["matched", "created"]

# v2 (2026-09-17): a title-stated early-career type is a hard identity incompatibility, read through
# the scope classifier's own title rules. Roles created under v1 are re-keyed by
# `firstseen re-resolve-roles` and migration 202608140034, never silently redecided by an ingestion run.
RESOLVER_VERSION = "hybrid-role-resolver-v2"


class RoleFeatures(BaseModel):
    normalized_title: str
    level: RoleLevel
    role_family: str
    specialization: str | None = None
    recruiting_season: RecruitingSeason
    location_scope: str
    description_fingerprint: str


class CanonicalRoleIdentity(BaseModel):
    id: UUID
    company_id: UUID
    company_normalized: str
    canonical_title: str
    recurrence_key: str
    features: RoleFeatures
    aliases: list[str] = Field(default_factory=list)
    description_prototype: str = ""
    description_embedding: list[float] | None = None


class MatchEvidence(BaseModel):
    kind: str
    value: float | str | bool | None
    detail: str


class RoleResolution(BaseModel):
    observation_id: UUID
    canonical_role: CanonicalRoleIdentity
    observed_alias: str
    decision: ResolutionDecision
    match_confidence: float = Field(ge=0, le=1)
    feature_scores: dict[str, float]
    reasons: list[str] = Field(min_length=1)
    evidence: list[MatchEvidence] = Field(min_length=1)
    used_embedding: bool = False
    used_llm: bool = False
    inference_decision: RoleInferenceDecision
    resolver_version: str = RESOLVER_VERSION


class EmbeddingClient(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...


class RoleResolutionStore(Protocol):
    def role_match_exists(self, observation_id: UUID) -> bool: ...

    def save_role_resolution(self, resolution: RoleResolution) -> None: ...


@dataclass(frozen=True)
class EvaluationFailure:
    case_id: str
    expected_role_id: str | None
    actual_role_id: str
    decision: str


@dataclass(frozen=True)
class EvaluationReport:
    total: int
    correct: int
    accuracy: float
    failures: list[EvaluationFailure]


@dataclass
class _ScoredCandidate:
    role: CanonicalRoleIdentity
    score: float
    feature_scores: dict[str, float]
    reasons: list[str]
    evidence: list[MatchEvidence]
    hard_reject: str | None = None
    used_embedding: bool = False
    used_llm: bool = False


def normalize_company(value: str) -> str:
    words = re.findall(r"[a-z0-9]+", value.casefold())
    suffixes = {"inc", "incorporated", "llc", "ltd", "limited", "corp", "corporation", "company", "co"}
    return " ".join(word for word in words if word not in suffixes)


def _slug(value: str) -> str:
    return "_".join(re.findall(r"[a-z0-9]+", value.casefold()))


# Resolution scores every observation against every compatible role of its company, so the same titles and descriptions
# are read thousands of times in one pass. The three readings below are pure functions of their text and return values
# nothing can change (a string and frozensets), so each is cached: a decision is the same, only computed once.
@lru_cache(maxsize=65_536)
def normalize_title(value: str) -> str:
    title = value.casefold()
    # Archived and static pages expose anchor text as the title; the call to action
    # is never part of the program name.
    title = re.sub(r"^\s*apply\s+(?:for|to|now\s+for)\s+", " ", title)
    title = re.sub(r"\b(?:19|20)\d{2}\b", " ", title)
    title = re.sub(r"\b(?:university|campus|early career|students?)\b", " ", title)
    title = re.sub(r"\bswe\b", "software engineer", title)
    title = re.sub(r"\bsoftware engineering internships?\b", "software engineer intern", title)
    title = re.sub(r"\bsoftware engineer internships?\b", "software engineer intern", title)
    title = re.sub(r"\binternships?\b", "intern", title)
    title = re.sub(r"\bnew[- ]grad(?:uate)?\b", "new grad", title)
    title = re.sub(r"[^a-z0-9+]+", " ", title)
    return " ".join(title.split())


def _level(title: str, employment_type: str | None, description: str) -> RoleLevel:
    text = f"{title} {employment_type or ''} {description[:2_000]}".casefold()
    if re.search(r"\b(intern|internship|co-op|coop)\b", text):
        return "internship"
    if re.search(r"\b(apprentice|apprenticeship)\b", text):
        return "apprenticeship"
    if re.search(r"\b(new grad|new graduate|graduate program|entry[- ]level|university graduate)\b", text):
        return "new_grad"
    if re.search(r"\b(senior|staff|principal|manager|director|lead)\b", text) or (
        employment_type and "full" in employment_type.casefold()
    ):
        return "full_time"
    return "unknown"


# Words that appear in questions and titles whichever program they mean: function words, the
# vocabulary of asking about recruiting and of conversation ("too soon to reach out to people"),
# and generic role nouns. Track words (intern, new grad) are matched separately as a hard filter,
# never as identifying overlap.
_NON_IDENTIFYING_WORDS = frozenset(
    {
    "a", "about", "an", "and", "any", "anyone", "anything", "application", "applications", "apply",
    "are", "as", "at", "be", "been", "best", "bet", "but", "by", "can", "career", "careers", "chance",
    "chances", "co", "companies", "company", "competitive", "coop", "coops", "could", "current",
    "currently", "deadline", "deadlines", "deal", "did", "do", "does", "early", "expect", "expected",
    "eye", "for", "forecast", "from", "get", "give", "going", "good", "grad", "grads", "graduate",
    "graduates", "had", "has", "have", "hear", "heard", "hire", "hiring", "historical", "history",
    "how", "i", "if", "in", "intern", "interns", "internship", "internships", "into", "is", "it", "its",
    "job", "jobs", "keep", "know", "last", "lately", "like", "likely", "look", "looking", "many", "me",
    "month", "more", "movement", "much", "my", "need", "new", "news", "next", "now", "odds", "of", "on",
    "op", "open", "opened", "opening", "openings", "opens", "ops", "or", "our", "out", "people", "plan",
    "position", "positions", "posted", "posting", "postings", "predict", "prediction", "prepare",
    "preparing", "program", "programs", "reach", "ready", "recruiting", "role", "roles", "rundown", "s",
    "season", "should", "show", "so", "someone", "soon", "start", "starts", "team", "teams", "tell",
    "than", "that", "the", "their", "them", "then", "there", "these", "they", "think", "thinking",
    "this", "those", "time", "timing", "to", "too", "track", "tracking", "typical", "typically",
    "unspecified", "update", "updates", "us", "usually", "was", "we", "were", "what", "whats", "when",
    "where", "which", "who", "why", "will", "window", "with", "worth", "worthwhile", "would", "year",
    "years", "you", "your",
    }
)

# Inflections that name the same work, so "software engineering internship" matches "Software
# Engineer Intern" on both words rather than on "software" alone.
_IDENTITY_EQUIVALENTS = {
    "analysts": "analyst",
    "designers": "designer",
    "developers": "developer",
    "engineering": "engineer",
    "engineers": "engineer",
    "managers": "manager",
    "representatives": "representative",
    "researchers": "researcher",
    "scientists": "scientist",
}


def identifying_title_tokens(text: str, company: str = "") -> frozenset[str]:
    """Title tokens that can tell one program from another at the same company.

    The company's own name never counts. Once the company is resolved its name is in the question
    and in every title that repeats it, so "What's the typical intern timing at Databricks?" once
    matched "Director Americas Field Marketing At Databricks" on "at" and "databricks" alone.
    Function words, question vocabulary, and generic role nouns are excluded for the same reason.
    """
    company_tokens = set(normalize_company(company).split())
    tokens = {_IDENTITY_EQUIVALENTS.get(token, token) for token in normalize_title(text).split()}
    return frozenset(tokens - _NON_IDENTIFYING_WORDS - company_tokens)


def question_tracks(text: str) -> frozenset[str]:
    """Early-career tracks a question names explicitly; empty when it names none."""
    lowered = text.casefold()
    tracks: set[str] = set()
    if re.search(r"\b(?:interns?|internships?|co-?ops?)\b", lowered):
        tracks.add("internship")
    if re.search(r"\b(?:new[- ]grads?|new graduates?|graduate programs?|grad programs?|entry[- ]level)\b", lowered):
        tracks.add("new_grad")
    if re.search(r"\bapprentice(?:s|ships?)?\b", lowered):
        tracks.add("apprenticeship")
    return frozenset(tracks)


def title_level(title: str) -> RoleLevel:
    """The level a posting title states by itself, with no description to widen it.

    "Graduate Hardware Engineer" is how quant and UK employers title new-grad roles, so a bare
    "graduate" counts here once the intern and seniority markers have had their say.
    """
    level = _level(title, None, "")
    if level == "unknown" and re.search(r"\bgraduates?\b", title.casefold()):
        return "new_grad"
    return level


@lru_cache(maxsize=65_536)
def stated_early_career_types(title: str) -> frozenset[EarlyCareerType]:
    """The early-career types a title states by itself, ignoring any description.

    `_level` also reads the employment type and 2,000 characters of description, which is how an
    unmarked "Research Engineer" came out `unknown` and merged with "Research Intern": an unknown
    level was compatible with every level. This reads the title only, through the scope classifier's
    own rules, so a stated type is evidence and an absent one is not a wildcard — and so identity and
    scope cannot disagree about what a title says.
    """
    return title_early_career_types(title)


def _stated_types_label(types: frozenset[EarlyCareerType]) -> str:
    return ", ".join(sorted(types)) if types else "none stated"


def _role_family(title: str) -> str:
    text = normalize_title(title)
    families = [
        ("machine_learning", ("machine learning", "ml engineer", "artificial intelligence")),
        ("data_science", ("data scientist", "data science")),
        ("data_engineering", ("data engineer",)),
        (
            "software_engineering",
            ("software engineer", "software developer", "full stack", "frontend", "backend"),
        ),
        ("hardware_engineering", ("hardware engineer", "electrical engineer", "silicon")),
        ("mechanical_engineering", ("mechanical engineer", "robotics engineer")),
        ("product_management", ("product manager", "apm")),
        ("product_design", ("product designer", "ux designer", "user experience")),
        ("finance", ("financial analyst", "finance")),
        ("consulting", ("consultant", "consulting")),
    ]
    for family, markers in families:
        if any(marker in text for marker in markers):
            return family
    return "other"


def _specialization(title: str, description: str) -> str | None:
    text = f"{normalize_title(title)} {description[:1_000].casefold()}"
    specializations = [
        ("security", ("security", "cyber")),
        ("infrastructure", ("infrastructure", "distributed systems", "cloud platform")),
        ("frontend", ("frontend", "front end", "web ui")),
        ("backend", ("backend", "back end", "server-side")),
        ("mobile", ("ios", "android", "mobile")),
        ("machine_learning", ("machine learning", " ml ", "artificial intelligence")),
        ("embedded", ("embedded", "firmware")),
    ]
    for specialization, markers in specializations:
        if any(marker in f" {text} " for marker in markers):
            return specialization
    return None


def _season(title: str, description: str) -> RecruitingSeason:
    text = f"{title} {description[:2_000]}".casefold()
    for season in ("spring", "summer", "fall", "winter"):
        if re.search(rf"\b{season}\b", text):
            return season  # type: ignore[return-value]
    if re.search(r"\b(year[- ]round|rolling)\b", text):
        return "year_round"
    return "unknown"


def _location_scope(value: str | None) -> str:
    if not value:
        return "unspecified"
    text = " ".join(re.findall(r"[a-z0-9]+", value.casefold()))
    if "remote" in text:
        return "remote"
    if any(marker in text for marker in ("united states", " usa ", " us ", "nationwide")):
        return "united_states"
    if any(marker in text for marker in ("multiple", "various", "global", "worldwide")):
        return "multi_location"
    return text


@lru_cache(maxsize=4_096)
def _description_tokens(value: str) -> frozenset[str]:
    stop = {
        "and",
        "the",
        "with",
        "for",
        "our",
        "you",
        "will",
        "are",
        "this",
        "that",
        "from",
        "job",
        "role",
        "team",
        "company",
        "equal",
        "opportunity",
        "employer",
        "apply",
    }
    return frozenset(
        token
        for token in re.findall(r"[a-z0-9]+", value.casefold())
        if len(token) > 2 and token not in stop and not re.fullmatch(r"(?:19|20)\d{2}", token)
    )


def _jaccard(left: frozenset[str], right: frozenset[str]) -> float:
    if not left or not right:
        return 0.5
    return len(left.intersection(right)) / len(left.union(right))


def _cosine(left: list[float], right: list[float]) -> float:
    if not left or len(left) != len(right):
        return 0.0
    denominator = sqrt(sum(value * value for value in left)) * sqrt(sum(value * value for value in right))
    if denominator == 0:
        return 0.0
    return max(0.0, min(1.0, sum(a * b for a, b in zip(left, right, strict=True)) / denominator))


def extract_features(observation: JobObservation) -> RoleFeatures:
    normalized = normalize_title(observation.raw_title)
    description = observation.evidence_excerpt
    tokens = sorted(_description_tokens(description))
    return RoleFeatures(
        normalized_title=normalized,
        level=_level(normalized, observation.employment_type, description),
        role_family=_role_family(normalized),
        specialization=_specialization(normalized, description),
        recruiting_season=_season(observation.raw_title, description),
        location_scope=_location_scope(observation.location),
        description_fingerprint=sha256(" ".join(tokens).encode()).hexdigest(),
    )


class _RoleProgramDecision(BaseModel):
    same_program: bool
    reason: str = Field(min_length=1, max_length=1_000)


class LlmRoleClassifier:
    def __init__(self, client: CompletionClient) -> None:
        self.client = client
        self.last_completion: CompletionResult | None = None

    def classify(
        self,
        observation: JobObservation,
        candidate: CanonicalRoleIdentity,
        feature_scores: dict[str, float],
    ) -> tuple[bool, str] | None:
        result = self.client.complete(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Decide whether two records are the same recurring recruiting program, not merely "
                        "similar jobs. Return JSON: same_program boolean and reason string. Treat different "
                        "levels, role families, specializations, seasons, or location-specific programs as "
                        f"different. {UNTRUSTED_EVIDENCE_SYSTEM_PROMPT}"
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "observation": {
                                "title": observation.raw_title,
                                "location": observation.location,
                                "employment_type": observation.employment_type,
                                "description": observation.evidence_excerpt[:4_000],
                            },
                            "candidate": candidate.model_dump(mode="json", exclude={"description_embedding"}),
                            "deterministic_scores": feature_scores,
                        }
                    ),
                },
            ],
            response_model=_RoleProgramDecision,
        )
        self.last_completion = result
        try:
            payload = _RoleProgramDecision.model_validate_json(result.content)
        except ValueError:
            return None
        return payload.same_program, payload.reason


class RoleResolver:
    def __init__(
        self,
        *,
        embedder: EmbeddingClient | None = None,
        llm: LlmRoleClassifier | None = None,
        match_threshold: float = 0.72,
        inference_policy: DeterministicFirstInferencePolicy | None = None,
    ) -> None:
        self.embedder = embedder
        self.llm = llm
        self.match_threshold = match_threshold
        self.inference_policy = inference_policy or DeterministicFirstInferencePolicy()

    def resolve(
        self,
        *,
        company_id: UUID,
        observation: JobObservation,
        candidates: list[CanonicalRoleIdentity],
    ) -> RoleResolution:
        if observation.id is None:
            raise ValueError("Role resolution requires a persisted observation id")
        company_normalized = normalize_company(observation.company)
        features = extract_features(observation)
        eligible = [
            candidate
            for candidate in candidates
            if candidate.company_id == company_id and candidate.company_normalized == company_normalized
        ]
        scored = [self._score(observation, features, candidate) for candidate in eligible]
        viable = [item for item in scored if item.hard_reject is None]
        viable.sort(key=lambda item: item.score, reverse=True)

        if viable:
            self._add_embedding_if_useful(observation, viable)
            viable.sort(key=lambda item: item.score, reverse=True)
            best_before_model = viable[0]
            runner_up_before_model = viable[1] if len(viable) > 1 else None
            deterministic_margin = (
                best_before_model.score - runner_up_before_model.score if runner_up_before_model else 1.0
            )
            inference_decision = self.inference_policy.decide_role_resolution(
                best_score=best_before_model.score,
                margin=deterministic_margin,
                exact_alias=bool(best_before_model.feature_scores.get("alias_exact")),
                has_compatible_candidate=True,
                llm_enabled=self.llm is not None,
            )
            self._add_llm_if_ambiguous(observation, viable, inference_decision)
            viable.sort(key=lambda item: item.score, reverse=True)
        else:
            inference_decision = self.inference_policy.decide_role_resolution(
                best_score=0,
                margin=1,
                exact_alias=False,
                has_compatible_candidate=False,
                llm_enabled=self.llm is not None,
            )

        best = viable[0] if viable else None
        runner_up = viable[1] if len(viable) > 1 else None
        margin = best.score - runner_up.score if best and runner_up else 1.0
        if best and best.score >= self.match_threshold and margin >= 0.06:
            role = best.role.model_copy(
                update={
                    "aliases": list(dict.fromkeys([*best.role.aliases, observation.raw_title])),
                }
            )
            return RoleResolution(
                observation_id=observation.id,
                canonical_role=role,
                observed_alias=observation.raw_title,
                decision="matched",
                match_confidence=round(best.score, 4),
                feature_scores=best.feature_scores,
                reasons=best.reasons,
                evidence=best.evidence,
                used_embedding=best.used_embedding,
                used_llm=best.used_llm,
                inference_decision=inference_decision,
            )
        return self._create_role(
            company_id,
            company_normalized,
            observation,
            features,
            scored,
            inference_decision,
        )

    def _score(
        self,
        observation: JobObservation,
        features: RoleFeatures,
        candidate: CanonicalRoleIdentity,
    ) -> _ScoredCandidate:
        candidate_features = candidate.features
        normalized_aliases = {normalize_title(alias) for alias in candidate.aliases}
        normalized_aliases.add(candidate_features.normalized_title)
        explicit_alias = features.normalized_title in normalized_aliases
        if (
            features.level != "unknown"
            and candidate_features.level != "unknown"
            and (features.level != candidate_features.level)
        ):
            return self._rejected(
                candidate, f"level mismatch: {features.level} vs {candidate_features.level}"
            )
        # A title-stated early-career type is a hard identity incompatibility, exactly as an explicit
        # specialization is below: a stated type is evidence, and an absent one is not a wildcard.
        # Without this, 52 merges across 18 companies joined different programs — 31 of them an
        # early-career program with experienced postings, which hid the program from the product
        # entirely, because a merged role is ambiguous and ambiguous roles are never surfaced or
        # forecast. There is deliberately no persisted-alias escape here: every
        # one of those merges had already recorded its aliases.
        stated = stated_early_career_types(features.normalized_title)
        # Every title this role has been observed under, because an alias is a name the program
        # really carried: a program renamed from "STEP Intern" to "Student Training in Engineering
        # Program" still states an internship, and a later "Engineering Practicum" belongs to it.
        candidate_stated = frozenset(
            kind
            for title in (candidate.canonical_title, *candidate.aliases)
            for kind in stated_early_career_types(title)
        )
        if stated != candidate_stated:
            return self._rejected(
                candidate,
                "title-stated early-career type differs: "
                f"{_stated_types_label(stated)} vs {_stated_types_label(candidate_stated)}",
            )
        if (
            features.role_family != "other"
            and candidate_features.role_family != "other"
            and (features.role_family != candidate_features.role_family)
        ):
            return self._rejected(
                candidate,
                f"role-family mismatch: {features.role_family} vs {candidate_features.role_family}",
            )
        if (
            features.specialization
            and candidate_features.specialization
            and features.specialization != candidate_features.specialization
        ):
            return self._rejected(
                candidate,
                f"specialization mismatch: {features.specialization} vs {candidate_features.specialization}",
            )
        if bool(features.specialization) != bool(candidate_features.specialization) and not explicit_alias:
            return self._rejected(
                candidate, "specialization scope differs without a persisted explicit alias"
            )
        if (
            features.recruiting_season != "unknown"
            and candidate_features.recruiting_season != "unknown"
            and features.recruiting_season != candidate_features.recruiting_season
        ):
            return self._rejected(
                candidate,
                "recruiting-season mismatch",
            )

        location_similarity = self._location_similarity(
            features.location_scope, candidate_features.location_scope
        )
        broad_locations = {"unspecified", "multi_location", "united_states"}
        if (
            features.location_scope not in broad_locations
            and candidate_features.location_scope not in broad_locations
            and features.location_scope != candidate_features.location_scope
            and location_similarity < 0.5
        ):
            return self._rejected(candidate, "location-specific programs have incompatible scopes")

        alias_exact = float(features.normalized_title in normalized_aliases)
        title_similarity = max(
            SequenceMatcher(None, features.normalized_title, alias).ratio() for alias in normalized_aliases
        )
        description_similarity = _jaccard(
            _description_tokens(observation.evidence_excerpt),
            _description_tokens(candidate.description_prototype),
        )
        season_similarity = (
            1.0
            if "unknown" in {features.recruiting_season, candidate_features.recruiting_season}
            else float(features.recruiting_season == candidate_features.recruiting_season)
        )
        specialization_similarity = (
            1.0
            if features.specialization == candidate_features.specialization
            else 0.65
            if None in {features.specialization, candidate_features.specialization}
            else 0.0
        )
        feature_scores = {
            "title": round(title_similarity, 4),
            "description": round(description_similarity, 4),
            "location": round(location_similarity, 4),
            "season": round(season_similarity, 4),
            "specialization": round(specialization_similarity, 4),
            "alias_exact": alias_exact,
            "family_compatible": 1.0,
            "level_compatible": 1.0,
        }
        score = (
            0.30 * title_similarity
            + 0.25 * description_similarity
            + 0.15 * location_similarity
            + 0.10 * season_similarity
            + 0.10 * specialization_similarity
            + 0.10 * alias_exact
        )
        reasons = [
            f"level={features.level} and family={features.role_family} are compatible",
            f"normalized-title similarity={title_similarity:.3f}",
            f"description similarity={description_similarity:.3f}",
            f"location compatibility={location_similarity:.3f}",
        ]
        evidence = [
            MatchEvidence(kind=key, value=value, detail=f"Deterministic {key} feature")
            for key, value in feature_scores.items()
        ]
        return _ScoredCandidate(candidate, score, feature_scores, reasons, evidence)

    @staticmethod
    def _rejected(candidate: CanonicalRoleIdentity, reason: str) -> _ScoredCandidate:
        return _ScoredCandidate(
            role=candidate,
            score=0.0,
            feature_scores={"hard_compatibility": 0.0},
            reasons=[reason],
            evidence=[MatchEvidence(kind="hard_reject", value=False, detail=reason)],
            hard_reject=reason,
        )

    @staticmethod
    def _location_similarity(left: str, right: str) -> float:
        if left == right:
            return 1.0
        if "unspecified" in {left, right} or "multi_location" in {left, right}:
            return 0.75
        if {left, right} == {"remote", "united_states"}:
            return 0.45
        return SequenceMatcher(None, left, right).ratio() * 0.5

    def _add_embedding_if_useful(
        self,
        observation: JobObservation,
        candidates: list[_ScoredCandidate],
    ) -> None:
        if not self.embedder or not candidates or not (0.52 <= candidates[0].score <= 0.82):
            return
        best = candidates[0]
        if not observation.evidence_excerpt or not best.role.description_prototype:
            return
        vectors = self.embedder.embed(
            [observation.evidence_excerpt[:8_000], best.role.description_prototype[:8_000]]
        )
        if len(vectors) != 2:
            return
        similarity = _cosine(vectors[0], vectors[1])
        best.score = 0.85 * best.score + 0.15 * similarity
        best.feature_scores["embedding"] = round(similarity, 4)
        best.reasons.append(f"description embedding similarity={similarity:.3f}")
        best.evidence.append(
            MatchEvidence(
                kind="embedding",
                value=round(similarity, 4),
                detail="Used only for an ambiguous deterministic match",
            )
        )
        best.used_embedding = True

    def _add_llm_if_ambiguous(
        self,
        observation: JobObservation,
        candidates: list[_ScoredCandidate],
        inference_decision: RoleInferenceDecision,
    ) -> None:
        if not self.llm or not candidates or not inference_decision.llm_escalated:
            return
        best = candidates[0]
        try:
            classification = self.llm.classify(observation, best.role, best.feature_scores)
        except ModelRoutingError:
            # Every configured route failed for an allowed fallback reason, so no
            # model evidence exists. Structured classification is one optional
            # feature, never match confidence, so resolution continues on the
            # deterministic score with the gap recorded rather than hidden.
            # Permanent provider errors are not routing errors and still surface.
            best.reasons.append("structured ambiguity classification unavailable: no model route succeeded")
            best.evidence.append(
                MatchEvidence(
                    kind="llm_structured_match_unavailable",
                    value=None,
                    detail="No configured model route produced a classification; deterministic score retained.",
                )
            )
            return
        if classification is None:
            return
        same_program, reason = classification
        best.score = min(1.0, best.score + 0.08) if same_program else max(0.0, best.score - 0.30)
        best.feature_scores["llm_structured_match"] = 1.0 if same_program else 0.0
        best.reasons.append(f"structured ambiguity classification: {reason}")
        best.evidence.append(
            MatchEvidence(
                kind="llm_structured_match",
                value=same_program,
                detail=reason,
            )
        )
        best.used_llm = True

    def _create_role(
        self,
        company_id: UUID,
        company_normalized: str,
        observation: JobObservation,
        features: RoleFeatures,
        scored: list[_ScoredCandidate],
        inference_decision: RoleInferenceDecision,
    ) -> RoleResolution:
        canonical_title = self._display_title(features, observation.raw_title)
        signature = "|".join(
            [
                str(company_id),
                features.role_family,
                features.level,
                features.specialization or "general",
                features.recruiting_season,
                features.location_scope,
                features.normalized_title,
            ]
        )
        role_id = uuid5(NAMESPACE_URL, f"canonical-role:{signature}")
        recurrence_key = _slug(
            "_".join(
                [
                    features.role_family,
                    features.level,
                    features.specialization or "general",
                    features.recruiting_season,
                    features.location_scope,
                    sha256(features.normalized_title.encode()).hexdigest()[:8],
                ]
            )
        )
        rejected_reasons = [item.hard_reject for item in scored if item.hard_reject]
        reasons = [
            "No existing canonical role cleared the deterministic match threshold and separation margin."
        ]
        if rejected_reasons:
            reasons.append("Hard incompatibilities: " + "; ".join(rejected_reasons[:3]))
        role = CanonicalRoleIdentity(
            id=role_id,
            company_id=company_id,
            company_normalized=company_normalized,
            canonical_title=canonical_title,
            recurrence_key=recurrence_key,
            features=features,
            aliases=[observation.raw_title],
            description_prototype=observation.evidence_excerpt[:8_000],
        )
        best_existing_score = max((item.score for item in scored), default=0.0)
        return RoleResolution(
            observation_id=observation.id,  # type: ignore[arg-type]
            canonical_role=role,
            observed_alias=observation.raw_title,
            decision="created",
            match_confidence=round(max(0.5, 1.0 - best_existing_score), 4),
            feature_scores={
                "new_identity": 1.0,
                "best_existing_score": round(best_existing_score, 4),
            },
            reasons=reasons,
            evidence=[
                MatchEvidence(
                    kind="new_identity",
                    value=True,
                    detail="Created conservatively instead of merging an insufficiently supported match",
                )
            ],
            inference_decision=inference_decision,
        )

    @staticmethod
    def _display_title(features: RoleFeatures, observed_title: str = "") -> str:
        """Build a display title, never an empty one.

        Normalization strips years and cohort words, so a posting titled only
        "Students" or "2026" normalizes to nothing. An empty canonical title is
        rejected downstream by the recurring-role record, so the observed title is
        retained verbatim in that case.
        """
        words = features.normalized_title.split()
        display = " ".join(
            word.upper() if word in {"ai", "ml", "ux", "ui"} else word.capitalize() for word in words
        )
        return display or " ".join(observed_title.split()) or "Untitled Role"


class PersistentRoleResolver:
    """Skip observations already resolved and persist new identity decisions."""

    def __init__(self, resolver: RoleResolver, store: RoleResolutionStore) -> None:
        self.resolver = resolver
        self.store = store

    def resolve_new(
        self,
        *,
        company_id: UUID,
        observation: JobObservation,
        candidates: list[CanonicalRoleIdentity],
    ) -> RoleResolution | None:
        if observation.id is None:
            raise ValueError("Role resolution requires a persisted observation id")
        if self.store.role_match_exists(observation.id):
            return None
        resolution = self.resolver.resolve(
            company_id=company_id,
            observation=observation,
            candidates=candidates,
        )
        self.store.save_role_resolution(resolution)
        return resolution


def evaluate_resolutions(
    expected: list[tuple[str, str | None]],
    actual: list[RoleResolution],
) -> EvaluationReport:
    if len(expected) != len(actual):
        raise ValueError("Expected and actual resolution counts must match")
    failures: list[EvaluationFailure] = []
    for (case_id, expected_role_id), resolution in zip(expected, actual, strict=True):
        actual_role_id = str(resolution.canonical_role.id)
        expected_created = expected_role_id is None
        correct = (
            resolution.decision == "created"
            if expected_created
            else resolution.decision == "matched" and actual_role_id == expected_role_id
        )
        if not correct:
            failures.append(
                EvaluationFailure(
                    case_id=case_id,
                    expected_role_id=expected_role_id,
                    actual_role_id=actual_role_id,
                    decision=resolution.decision,
                )
            )
    correct_count = len(expected) - len(failures)
    return EvaluationReport(
        total=len(expected),
        correct=correct_count,
        accuracy=correct_count / len(expected) if expected else 1.0,
        failures=failures,
    )
