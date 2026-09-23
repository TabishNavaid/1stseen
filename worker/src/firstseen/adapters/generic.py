"""Deterministic career-page extraction with explicitly gated expensive fallbacks."""

from __future__ import annotations

import json
import re
from datetime import datetime
from typing import Protocol
from urllib.parse import urljoin, urlparse

from pydantic import BaseModel, Field

from firstseen.config import Settings, get_settings
from firstseen.inference import DeterministicFirstInferencePolicy, PageInferenceDecision
from firstseen.providers import CompletionClient, CompletionResult
from firstseen.security import UNTRUSTED_EVIDENCE_SYSTEM_PROMPT, PublicUrlPolicy, UnsafeUrlError

from .base import (
    AdapterResult,
    CollectionDiagnostic,
    ExtractionRoute,
    FetchedDocument,
    HttpTransport,
    JobCandidate,
    SourceAdapter,
    SourceConfig,
    access_interstitial_marker,
    build_observations,
)
from .common import (
    StructuredHtmlParser,
    absolute_url,
    iter_json_nodes,
    location_text,
    parse_json_scripts,
    parse_published_datetime,
    strip_html,
)


class BrowserRenderer(Protocol):
    def render(self, url: str) -> FetchedDocument: ...


class PlaywrightRenderer:
    """Lazy optional browser route; never imported unless a source enables it."""

    def __init__(
        self,
        url_policy: PublicUrlPolicy | None = None,
        *,
        settings: Settings | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.url_policy = url_policy or PublicUrlPolicy()

    def render(self, url: str) -> FetchedDocument:
        try:
            from playwright.sync_api import sync_playwright  # type: ignore[import-not-found]
        except ImportError as exc:  # pragma: no cover - optional dependency
            raise RuntimeError("Install `firstseen-intelligence[browser]` for Playwright fallback") from exc
        self.url_policy.validate(url)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            try:
                context = browser.new_context()
                page = context.new_page()

                def protect_request(route: object) -> None:
                    try:
                        request_url = str(route.request.url)  # type: ignore[attr-defined]
                        self.url_policy.validate(request_url)
                    except UnsafeUrlError:
                        route.abort("blockedbyclient")  # type: ignore[attr-defined]
                    else:
                        route.continue_()  # type: ignore[attr-defined]

                page.route("**/*", protect_request)
                response = page.goto(
                    url,
                    wait_until="domcontentloaded",
                    timeout=self.settings.browser_timeout_seconds * 1_000,
                )
                page.wait_for_timeout(750)
                body = page.content().encode()
                if len(body) > self.settings.max_source_bytes:
                    raise ValueError("browser_response_too_large")
                return FetchedDocument(
                    url=page.url,
                    status=response.status if response else 200,
                    content_type="text/html; charset=utf-8",
                    body=body,
                )
            finally:
                browser.close()


class _ExtractedJob(BaseModel):
    title: str | None = None
    source_url: str | None = None
    apply_url: str | None = None
    location: str | None = None
    employment_type: str | None = None
    published_at: str | None = None
    published_date_quote: str | None = None
    external_job_id: str | None = None
    evidence_quote: str | None = None


class _ExtractedJobs(BaseModel):
    jobs: list[_ExtractedJob] = Field(default_factory=list)


class LlmJobExtractor:
    def __init__(self, client: CompletionClient) -> None:
        self.client = client
        self.last_completion: CompletionResult | None = None

    def extract(self, html: str, *, source_url: str, company: str) -> list[JobCandidate]:
        prompt = json.dumps(
            {
                "task": (
                    "Extract job postings only when explicitly present. Each item may contain title, "
                    "source_url, apply_url, location, employment_type, published_at, "
                    "published_date_quote, external_job_id, and evidence_quote. Never infer a date. "
                    "A publication-date quote must be an exact substring of untrusted_html."
                ),
                "configured_company": company,
                "page_url": source_url,
                "untrusted_html": html[:20_000],
            }
        )
        result = self.client.complete(
            messages=[
                {"role": "system", "content": UNTRUSTED_EVIDENCE_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
            response_model=_ExtractedJobs,
        )
        self.last_completion = result
        payload = _ExtractedJobs.model_validate_json(result.content)
        candidates: list[JobCandidate] = []
        for item in payload.jobs:
            title = item.title
            apply_url = absolute_url(source_url, item.apply_url or item.source_url)
            job_url = absolute_url(source_url, item.source_url or apply_url)
            if not title or not apply_url or not job_url:
                continue
            if item.evidence_quote and item.evidence_quote not in html:
                continue
            date_quote = item.published_date_quote
            published_at = None
            if date_quote and str(date_quote) in html:
                published_at = parse_published_datetime(item.published_at)
            candidates.append(
                JobCandidate(
                    source_url=job_url,
                    apply_url=apply_url,
                    raw_title=title,
                    company=company,
                    location=item.location,
                    employment_type=item.employment_type,
                    published_at=published_at,
                    external_job_id=item.external_job_id,
                    evidence_excerpt=item.evidence_quote or "",
                    reliability={
                        "determinism": "llm_fallback_validated",
                        "published_date_quote_verified": bool(published_at),
                        "model": result.model,
                    },
                )
            )
        return candidates



# A careers card renders its title, then its location, then its button, all inside one anchor, so the
# anchor's text is the three run together. On Applied Intuition's board the location appears twice:
# "Software Engineer Sunnyvale Sunnyvale Apply". That title never matches the same program on the
# company's ATS board, so the page source records it as a second canonical role.

# Button and link text that a card puts after its title.
_CARD_CALL_TO_ACTION = re.compile(
    r"[\s\-–—,|·]*\b(?:apply(?: now)?|read more|learn more|view (?:job|role|details|opening)|"
    r"see (?:more|details)|more info(?:rmation)?|details)\b\s*$",
    re.IGNORECASE,
)
# Words that are part of a job's title, never part of its location or its card furniture.
_TITLE_WORDS = frozenset(
    {
        "intern", "interns", "internship", "internships", "co", "op", "coop", "grad", "grads",
        "graduate", "graduates", "apprentice", "apprenticeship", "engineer", "engineering",
        "developer", "analyst", "scientist", "designer", "manager", "associate", "specialist",
        "researcher", "research", "trader", "trading", "consultant", "technician", "architect",
    }
)


def clean_static_anchor_title(text: str) -> str:
    """Drop the card furniture a careers-page anchor runs together with its title.

    Two things are removed, in order, and only from the end:

    1. A trailing call-to-action, which is a closed list of button labels.
    2. A repeated run of one to three words and everything after it — a card that prints its
       location twice marks where its title ended. The run is only treated as furniture when
       neither copy contains a title word, so "Trader Intern Intern Trading Amsterdam" keeps its
       "Intern" and is left exactly as it was found.

    Anything it cannot explain it leaves alone: a title is evidence, and a wrong trim would invent
    a program that was never posted.
    """
    cleaned = _CARD_CALL_TO_ACTION.sub("", " ".join(text.split())).strip()
    words = cleaned.split(" ")
    folded = [word.strip(",.;:|-–—").casefold() for word in words]
    for size in (3, 2, 1):
        for start in range(len(words) - 2 * size + 1):
            first = folded[start : start + size]
            second = folded[start + size : start + 2 * size]
            if not all(first) or first != second:
                continue
            if any(word in _TITLE_WORDS for word in first):
                continue
            # Everything from the first copy on is the card's own metadata.
            head = " ".join(words[:start]).strip(" ,;:|-–—·")
            return head if head else cleaned
    return cleaned


class GenericCareerPageAdapter(SourceAdapter):
    name = "generic"

    def __init__(
        self,
        *,
        browser: BrowserRenderer | None = None,
        llm: LlmJobExtractor | None = None,
        inference_policy: DeterministicFirstInferencePolicy | None = None,
    ) -> None:
        self.browser = browser
        self.llm = llm
        self.inference_policy = inference_policy or DeterministicFirstInferencePolicy()

    def collect(
        self,
        source: SourceConfig,
        transport: HttpTransport,
        *,
        observed_at: datetime,
        previous_document_hash: str | None = None,
    ) -> AdapterResult:
        document = transport.get(str(source.url), accept="text/html,application/xhtml+xml")
        if document.content_type and not any(
            item in document.content_type.casefold() for item in ("html", "xhtml")
        ):
            return AdapterResult(
                [],
                document.content_hash,
                "static_html",
                len(document.body),
                complete=False,
                diagnostics=[
                    CollectionDiagnostic(
                        "unexpected_content_type",
                        "The career-page source did not return HTML.",
                        "error",
                        document.url,
                        {"content_type": document.content_type[:200]},
                    )
                ],
            )
        interstitial = access_interstitial_marker(document.text)
        if interstitial:
            return AdapterResult(
                [],
                document.content_hash,
                "static_html",
                len(document.body),
                complete=False,
                diagnostics=[
                    CollectionDiagnostic(
                        "access_interstitial_detected",
                        "The source returned an access or verification interstitial; no fallback was attempted.",
                        "error",
                        document.url,
                        {"marker": interstitial},
                    )
                ],
            )
        if previous_document_hash == document.content_hash and not source.options.get("allow_browser"):
            decision = self.inference_policy.summarize_result(
                source_id=source.id,
                source_url=document.url,
                route="static_html",
                unchanged=True,
                jobs=0,
            )
            return AdapterResult(
                [],
                document.content_hash,
                "static_html",
                len(document.body),
                True,
                inference_decisions=[decision],
            )
        candidates, route, documents, decision = self.extract_document(document, source)

        from .structured import composite_document_hash

        document_hash = composite_document_hash(documents)
        if previous_document_hash == document_hash:
            unchanged_decision = self.inference_policy.summarize_result(
                source_id=source.id,
                source_url=document.url,
                route=route,
                unchanged=True,
                jobs=0,
            )
            return AdapterResult(
                [],
                document_hash,
                route,
                sum(map(len, documents)),
                True,
                inference_decisions=[unchanged_decision],
            )

        observations, diagnostics = build_observations(
            source, candidates, observed_at=observed_at, extraction_route=route
        )
        return AdapterResult(
            observations,
            document_hash,
            route,
            sum(map(len, documents)),
            inference_decisions=[decision],
            complete=not bool(candidates and not observations),
            diagnostics=diagnostics,
        )

    def extract_document(
        self, document: FetchedDocument, source: SourceConfig
    ) -> tuple[list[JobCandidate], ExtractionRoute, list[bytes], PageInferenceDecision]:
        candidates, route = self.parse_document(document, source)
        documents = [document.body]
        fallback_document = document
        if not candidates and source.options.get("allow_browser") and self.browser:
            fallback_document = self.browser.render(document.url)
            documents.append(fallback_document.body)
            candidates, _deterministic_route = self.parse_document(fallback_document, source)
            route = "playwright"
        should_escalate, reason, details = self.inference_policy.should_escalate(
            fallback_document.text,
            deterministic_job_count=len(candidates),
            llm_enabled=bool(source.options.get("allow_llm") and self.llm),
        )
        if should_escalate and self.llm:
            candidates = self.llm.extract(
                fallback_document.text,
                source_url=fallback_document.url,
                company=source.company,
            )
            route = "llm"
            completion = getattr(self.llm, "last_completion", None)
            decision = PageInferenceDecision(
                source_id=source.id,
                source_url=fallback_document.url,
                action="escalated",
                reason=reason,
                page_changed=True,
                deterministic_route="static_html",
                deterministic_job_count=0,
                llm_escalated=True,
                model_extraction_succeeded=bool(candidates),
                model_fallback_used=bool(completion and completion.fallback_reason),
                details=details,
            )
        else:
            decision = PageInferenceDecision(
                source_id=source.id,
                source_url=fallback_document.url,
                action="not_required" if candidates else "suppressed",
                reason=(
                    self.inference_policy.deterministic_reason(route, len(candidates))
                    if candidates
                    else reason
                ),
                page_changed=True,
                deterministic_route=route,
                deterministic_job_count=len(candidates),
                details=details,
            )
        return candidates, route, documents, decision

    def parse_document(
        self, document: FetchedDocument, source: SourceConfig
    ) -> tuple[list[JobCandidate], ExtractionRoute]:
        candidates = self._json_ld(document, source)
        if candidates:
            return candidates, "json_ld"
        candidates = self._embedded_json(document, source)
        if candidates:
            return candidates, "embedded_data"
        return self._static_html(document, source), "static_html"

    def _json_ld(self, document: FetchedDocument, source: SourceConfig) -> list[JobCandidate]:
        results: list[JobCandidate] = []
        for payload in parse_json_scripts(document.text, "application/ld+json"):
            for node in iter_json_nodes(payload):
                kinds = node.get("@type")
                is_job = kinds == "JobPosting" or isinstance(kinds, list) and "JobPosting" in kinds
                if not is_job:
                    continue
                title = node.get("title") or node.get("name")
                source_url = absolute_url(document.url, node.get("url") or node.get("sameAs"))
                apply_url = absolute_url(document.url, node.get("applicationContact") or source_url)
                if isinstance(node.get("applicationContact"), dict):
                    apply_url = (
                        absolute_url(document.url, node["applicationContact"].get("url")) or source_url
                    )
                if not title or not source_url or not apply_url:
                    continue
                organization = node.get("hiringOrganization") or {}
                results.append(
                    JobCandidate(
                        source_url=source_url,
                        apply_url=apply_url,
                        raw_title=str(title),
                        company=str(organization.get("name") or source.company),
                        location=location_text(
                            node.get("jobLocation") or node.get("applicantLocationRequirements")
                        ),
                        employment_type=location_text(node.get("employmentType")),
                        published_at=parse_published_datetime(node.get("datePosted")),
                        external_job_id=str(node.get("identifier", {}).get("value"))
                        if isinstance(node.get("identifier"), dict) and node["identifier"].get("value")
                        else None,
                        evidence_excerpt=strip_html(str(node.get("description") or "")),
                        reliability={
                            "schema": "JobPosting",
                            "published_date_field": "datePosted" if node.get("datePosted") else None,
                        },
                    )
                )
        return results
    def _embedded_json(self, document: FetchedDocument, source: SourceConfig) -> list[JobCandidate]:
        results: list[JobCandidate] = []
        for script_type in ("application/json", "application/ld+json; charset=utf-8"):
            for payload in parse_json_scripts(document.text, script_type):
                for node in iter_json_nodes(payload):
                    title = node.get("title") or node.get("jobTitle")
                    apply_url = absolute_url(
                        document.url,
                        node.get("applyUrl")
                        or node.get("apply_url")
                        or node.get("jobUrl")
                        or node.get("url"),
                    )
                    if not title or not apply_url:
                        continue
                    results.append(
                        JobCandidate(
                            source_url=absolute_url(document.url, node.get("jobUrl") or node.get("url"))
                            or apply_url,
                            apply_url=apply_url,
                            raw_title=str(title),
                            company=str(node.get("company") or node.get("companyName") or source.company),
                            location=location_text(node.get("location")),
                            employment_type=node.get("employmentType") or node.get("commitment"),
                            published_at=parse_published_datetime(
                                node.get("publishedAt") or node.get("datePosted")
                            ),
                            external_job_id=str(node.get("id")) if node.get("id") else None,
                            evidence_excerpt=strip_html(str(node.get("description") or "")),
                            reliability={"schema": "embedded_json"},
                        )
                    )
        return results

    def _static_html(self, document: FetchedDocument, source: SourceConfig) -> list[JobCandidate]:
        parser = StructuredHtmlParser()
        parser.feed(document.text)
        results: list[JobCandidate] = []
        seen: set[str] = set()
        job_title_terms = (
            "intern",
            "engineer",
            "developer",
            "analyst",
            "scientist",
            "designer",
            "manager",
            "associate",
            "specialist",
        )
        job_path_terms = ("/job/", "/jobs/", "/position", "/opening", "/vacanc")
        navigation_labels = {
            "jobs",
            "careers",
            "open roles",
            "apply",
            "view all jobs",
            "job alerts",
            "talent community",
            "privacy policy",
            "learn more",
        }
        for href, text in parser.anchors:
            url = urljoin(document.url, href)
            normalized = clean_static_anchor_title(text)
            parsed_url = urlparse(url)
            title = normalized.casefold()
            path = parsed_url.path.casefold()
            if parsed_url.scheme not in {"http", "https"}:
                continue
            if len(normalized) < 4 or title in navigation_labels or _is_navigation_phrase(title):
                continue
            looks_like_job = any(term in path for term in job_path_terms) or any(
                term in title for term in job_title_terms
            )
            if not looks_like_job or url in seen:
                continue
            seen.add(url)
            results.append(
                JobCandidate(
                    source_url=url,
                    apply_url=url,
                    raw_title=normalized,
                    company=source.company,
                    published_at=None,
                    evidence_excerpt=normalized,
                    reliability={"schema": "static_anchor", "published_date_available": False},
                )
            )
        return results


_NAVIGATION_PREFIX = re.compile(
    r"^(?:see|view|browse|explore|discover|learn|read|find|search|check out|meet|join|"
    r"why|how|what|our|about|introducing|announcing|welcome|inside|life at)\b",
    re.IGNORECASE,
)
# Whole-phrase page furniture that is never a requisition title.
_NAVIGATION_EXACT = frozenset(
    {
        "jobs", "careers", "career", "open roles", "open positions", "all jobs", "all roles",
        "apply", "apply now", "view all jobs", "job alerts", "talent community",
        "privacy policy", "cookie policy", "terms", "learn more", "students", "student",
        "join us", "join our team", "work with us", "life at", "culture", "benefits",
        "diversity", "blog", "news", "newsroom", "press", "engineering blog", "sign in",
        "log in", "back to jobs", "search jobs", "openings", "opportunities",
    }
)
# Article / release / marketing shapes seen on real archived careers pages.
_EDITORIAL_MARKERS = re.compile(
    r"\b(release notes|changelog|blog|webinar|podcast|newsletter|case study|whitepaper|"
    r"ebook|announcement|press release|report|guide|tutorial|roadmap|version \d)\b",
    re.IGNORECASE,
)


_PROSE_MARKERS = re.compile(
    r"(^|\s)(my|your|our|we|us|become|becoming|journey|meet|inside|from\s+\w+\s+to|"
    r"in\s+the|at\s+the|with\s+the|behind)(\s|$)",
    re.IGNORECASE,
)


def _is_navigation_phrase(title: str) -> bool:
    """Reject anchor text that is page furniture, not a requisition title.

    Archived careers pages mix navigation, marketing copy, and article titles with
    real job links. Each of these shapes was observed creating a bogus canonical
    role in the live corpus. Job titles do not open with a call to action, are not
    bare section labels, and are not article headlines.
    """
    compact = " ".join(title.split()).strip().strip(":-–—").casefold()
    if not compact or compact in _NAVIGATION_EXACT:
        return True
    if _NAVIGATION_PREFIX.match(compact):
        return True
    if _EDITORIAL_MARKERS.search(compact):
        return True
    # A role noun can appear inside an article headline ("Become a Stripe Intern",
    # "The Journey From Intern To New Grad"), so narrative phrasing is rejected too.
    if _PROSE_MARKERS.search(compact):
        return True
    # Requisition titles are short noun phrases; prose sentences are not.
    return len(compact.split()) > 12 or compact.endswith((".", "!", "?"))
