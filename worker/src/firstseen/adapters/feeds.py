"""RSS/Atom feed and XML sitemap adapters."""

from __future__ import annotations

from datetime import datetime
from typing import Any
from urllib.parse import urldefrag
from xml.etree import ElementTree

from firstseen.inference import PageInferenceDecision
from firstseen.models import JobObservation
from firstseen.recruiting_paths import sitemap_children, sitemap_job_page
from firstseen.robots import RobotsDisallowedError
from firstseen.security import parse_untrusted_xml

from .base import (
    AdapterResult,
    CollectionDiagnostic,
    ExtractionRoute,
    HttpTransport,
    JobCandidate,
    SourceAdapter,
    SourceConfig,
    build_observations,
    robots_diagnostic,
)
from .common import absolute_url, parse_published_datetime, strip_html
from .generic import GenericCareerPageAdapter
from .structured import composite_document_hash


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _child_text(element: ElementTree.Element, name: str) -> str | None:
    for child in element:
        if _local_name(child.tag) == name and child.text:
            return child.text.strip()
    return None


class FeedAdapter(SourceAdapter):
    name = "rss"

    def collect(
        self,
        source: SourceConfig,
        transport: HttpTransport,
        *,
        observed_at: datetime,
        previous_document_hash: str | None = None,
    ) -> AdapterResult:
        document = transport.get(
            str(source.url), accept="application/rss+xml,application/atom+xml,application/xml"
        )
        if previous_document_hash == document.content_hash:
            return AdapterResult([], document.content_hash, "structured_endpoint", len(document.body), True)
        try:
            root = parse_untrusted_xml(document.body)
        except (ElementTree.ParseError, ValueError):
            return AdapterResult(
                [],
                document.content_hash,
                "structured_endpoint",
                len(document.body),
                complete=False,
                diagnostics=[
                    CollectionDiagnostic(
                        "invalid_feed_xml",
                        "The recruiting feed was not safe, well-formed XML.",
                        "error",
                        document.url,
                    )
                ],
            )
        root_kind = _local_name(root.tag).casefold()
        if root_kind not in {"rss", "feed", "rdf"}:
            return AdapterResult(
                [],
                document.content_hash,
                "structured_endpoint",
                len(document.body),
                complete=False,
                diagnostics=[
                    CollectionDiagnostic(
                        "unsupported_feed_root",
                        "The XML document was not a supported RSS or Atom feed.",
                        "error",
                        document.url,
                        {"root": root_kind[:100]},
                    )
                ],
            )
        candidates: list[JobCandidate] = []
        entries = 0
        for entry in root.iter():
            kind = _local_name(entry.tag)
            if kind not in {"item", "entry"}:
                continue
            entries += 1
            title = _child_text(entry, "title")
            link = _child_text(entry, "link")
            if not link:
                links = [
                    child
                    for child in entry
                    if _local_name(child.tag) == "link" and child.attrib.get("href")
                ]
                preferred = next(
                    (
                        child
                        for child in links
                        if child.attrib.get("rel", "alternate") in {"", "alternate"}
                        and child.attrib.get("type", "text/html") in {"", "text/html"}
                    ),
                    links[0] if links else None,
                )
                link = preferred.attrib["href"] if preferred is not None else None
            link = absolute_url(document.url, link)
            if not title or not link:
                continue
            published_raw = _child_text(entry, "pubDate") or _child_text(entry, "published")
            # Atom `updated` is deliberately not treated as publication time.
            summary = _child_text(entry, "description") or _child_text(entry, "summary") or ""
            external_id = _child_text(entry, "guid") or _child_text(entry, "id")
            candidates.append(
                JobCandidate(
                    source_url=link,
                    apply_url=link,
                    raw_title=title,
                    company=source.company,
                    published_at=parse_published_datetime(published_raw),
                    external_job_id=external_id,
                    evidence_excerpt=strip_html(summary),
                    reliability={
                        "feed_format": _local_name(root.tag),
                        "published_date_field": "pubDate/published" if published_raw else None,
                    },
                )
            )
        diagnostics: list[CollectionDiagnostic] = []
        observations, normalization_diagnostics = build_observations(
            source,
            candidates,
            observed_at=observed_at,
            extraction_route="structured_endpoint",
        )
        diagnostics.extend(normalization_diagnostics)
        if entries > len(candidates):
            diagnostics.append(
                CollectionDiagnostic(
                    "malformed_feed_entries_skipped",
                    f"Skipped {entries - len(candidates)} feed entries missing a title or usable link.",
                    "warning" if candidates else "error",
                    document.url,
                    {"entries": entries, "accepted": len(candidates)},
                )
            )
        return AdapterResult(
            observations,
            document.content_hash,
            "structured_endpoint",
            len(document.body),
            complete=not bool(entries and not observations),
            diagnostics=diagnostics,
        )


class SitemapAdapter(SourceAdapter):
    name = "sitemap"

    def __init__(self, generic: GenericCareerPageAdapter | None = None) -> None:
        self.generic = generic or GenericCareerPageAdapter()

    def collect(
        self,
        source: SourceConfig,
        transport: HttpTransport,
        *,
        observed_at: datetime,
        previous_document_hash: str | None = None,
    ) -> AdapterResult:
        documents: list[bytes] = []
        diagnostics: list[CollectionDiagnostic] = []
        max_pages = _bounded_option(source.options, "max_pages", 25, 1, 100, diagnostics)
        max_sitemaps = _bounded_option(source.options, "max_sitemaps", 5, 1, 25, diagnostics)
        max_depth = _bounded_option(source.options, "max_sitemap_depth", 2, 0, 3, diagnostics)
        urls = self._job_urls(
            str(source.url),
            source,
            transport,
            documents,
            diagnostics,
            visited=set(),
            depth=0,
            max_depth=max_depth,
            max_sitemaps=max_sitemaps,
        )
        unique_urls = list(dict.fromkeys(urldefrag(url)[0] for url in urls if url))
        if len(unique_urls) > max_pages:
            diagnostics.append(
                CollectionDiagnostic(
                    "job_page_limit_reached",
                    f"Limited sitemap job-page inspection to {max_pages} URLs.",
                    details={"discovered": len(unique_urls), "limit": max_pages},
                )
            )
        observations: list[JobObservation] = []
        routes: list[ExtractionRoute] = []
        decisions: list[PageInferenceDecision] = []
        child_failures = 0
        for url in unique_urls[:max_pages]:
            try:
                document = transport.get(url, accept="text/html,application/xhtml+xml")
                candidates, route, extracted_documents, decision = self.generic.extract_document(
                    document, source
                )
            except RobotsDisallowedError as refusal:
                # Skipped before any request, with its reason; only an unreachable robots.txt makes the pass partial.
                diagnostics.append(robots_diagnostic(refusal))
                continue
            except Exception as exc:  # noqa: BLE001 - one child must not discard successful pages
                child_failures += 1
                diagnostics.append(
                    CollectionDiagnostic(
                        "job_page_collection_failed",
                        "A sitemap job page could not be collected or parsed.",
                        "error",
                        url,
                        {"error_type": type(exc).__name__},
                    )
                )
                continue
            documents.extend(extracted_documents)
            routes.append(route)
            decisions.append(decision)
            normalized, normalization_diagnostics = build_observations(
                source,
                candidates,
                observed_at=observed_at,
                extraction_route=route,
            )
            observations.extend(normalized)
            diagnostics.extend(normalization_diagnostics)
        route = self._most_expensive_route(routes)
        document_hash = composite_document_hash(documents)
        complete = bool(documents) and child_failures == 0 and not any(
            item.severity == "error" for item in diagnostics
        )
        if previous_document_hash == document_hash and complete:
            return AdapterResult(
                [],
                document_hash,
                route,
                sum(map(len, documents)),
                True,
                diagnostics=diagnostics,
            )
        return AdapterResult(
            observations,
            document_hash,
            route,
            sum(map(len, documents)),
            inference_decisions=decisions,
            complete=complete,
            diagnostics=diagnostics,
        )

    def _job_urls(
        self,
        url: str,
        source: SourceConfig,
        transport: HttpTransport,
        documents: list[bytes],
        diagnostics: list[CollectionDiagnostic],
        *,
        visited: set[str],
        depth: int,
        max_depth: int,
        max_sitemaps: int,
    ) -> list[str]:
        normalized_url = urldefrag(url)[0]
        if normalized_url in visited:
            diagnostics.append(
                CollectionDiagnostic(
                    "sitemap_cycle_skipped",
                    "Skipped a sitemap URL that was already visited.",
                    url=normalized_url,
                )
            )
            return []
        if len(visited) >= max_sitemaps:
            diagnostics.append(
                CollectionDiagnostic(
                    "sitemap_limit_reached",
                    f"Stopped after {max_sitemaps} sitemap documents.",
                    url=normalized_url,
                    details={"limit": max_sitemaps},
                )
            )
            return []
        visited.add(normalized_url)
        try:
            document = transport.get(normalized_url, accept="application/xml,text/xml")
            documents.append(document.body)
            root = parse_untrusted_xml(document.body)
        except RobotsDisallowedError as refusal:
            diagnostics.append(robots_diagnostic(refusal))
            return []
        except Exception as exc:  # noqa: BLE001 - nested sitemap failures are isolated and diagnosed
            diagnostics.append(
                CollectionDiagnostic(
                    "sitemap_collection_failed",
                    "A sitemap document could not be collected or parsed.",
                    "error",
                    normalized_url,
                    {"error_type": type(exc).__name__, "depth": depth},
                )
            )
            return []
        locations = [
            child.text.strip() for child in root.iter() if _local_name(child.tag) == "loc" and child.text
        ]
        if _local_name(root.tag) == "sitemapindex":
            # Recruiting-named children first, so the sitemap bound is spent on them; non-posting children never.
            locations = sitemap_children(locations)
            if depth >= max_depth:
                diagnostics.append(
                    CollectionDiagnostic(
                        "sitemap_depth_limit_reached",
                        f"Stopped nested sitemap traversal at depth {max_depth}.",
                        url=normalized_url,
                        details={"limit": max_depth},
                    )
                )
                return []
            nested: list[str] = []
            for child_url in locations:
                nested.extend(
                    self._job_urls(
                        child_url,
                        source,
                        transport,
                        documents,
                        diagnostics,
                        visited=visited,
                        depth=depth + 1,
                        max_depth=max_depth,
                        max_sitemaps=max_sitemaps,
                    )
                )
            return nested
        if _local_name(root.tag) != "urlset":
            diagnostics.append(
                CollectionDiagnostic(
                    "unsupported_sitemap_root",
                    "The XML root was not urlset or sitemapindex.",
                    "error",
                    normalized_url,
                    {"root": _local_name(root.tag)[:100]},
                )
            )
            return []
        explicit_pattern = str(source.options.get("job_url_contains", ""))
        if explicit_pattern:
            return [url for url in locations if explicit_pattern in url]
        return [url for url in locations if sitemap_job_page(url)]

    @staticmethod
    def _most_expensive_route(routes: list[ExtractionRoute]) -> ExtractionRoute:
        order: list[ExtractionRoute] = [
            "structured_endpoint",
            "json_ld",
            "embedded_data",
            "static_html",
            "playwright",
            "llm",
        ]
        return max(routes, key=order.index) if routes else "static_html"


def _bounded_option(
    options: dict[str, Any],
    key: str,
    default: int,
    minimum: int,
    maximum: int,
    diagnostics: list[CollectionDiagnostic],
) -> int:
    raw = options.get(key, default)
    try:
        parsed = int(raw)
    except (TypeError, ValueError):
        parsed = default
        diagnostics.append(
            CollectionDiagnostic(
                "invalid_source_option",
                f"Ignored invalid {key!r}; using {default}.",
                details={"option": key, "default": default},
            )
        )
    bounded = min(maximum, max(minimum, parsed))
    if bounded != parsed:
        diagnostics.append(
            CollectionDiagnostic(
                "source_option_clamped",
                f"Clamped {key!r} to the supported range.",
                details={"option": key, "value": parsed, "bounded": bounded},
            )
        )
    return bounded
