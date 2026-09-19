"""Deterministic company identity and recruiting-source discovery.

The discovery tools deliberately emit the same ``SourceConfig`` objects consumed
by ingestion. LLM help is restricted to proposing an identity when deterministic
signals cannot select one; every source URL still has to be observed over HTTP.
"""

from __future__ import annotations

import json
import re
import socket
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime
from html import unescape as html_unescape
from html.parser import HTMLParser
from typing import Any, Literal, Protocol
from urllib.error import HTTPError
from urllib.parse import parse_qsl, urljoin, urlparse, urlunparse
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import BaseModel, Field, HttpUrl

from .adapters.base import AdapterName, HttpTransport, SourceConfig
from .providers import CompletionClient, CompletionResult, ModelRoutingError, ProviderFailure
from .recruiting_paths import recruiting_page, recruiting_sitemap
from .robots import RobotsDisallowedError

DiscoveryMethod = Literal[
    "input_domain",
    "dns",
    "redirect",
    "structured_metadata",
    "html_link",
    "known_ats_pattern",
    "robots_sitemap",
    "sitemap_probe",
    "feed_link",
    "llm_identity",
    "conventional_path",
]
SourceCategory = Literal[
    "careers_page", "campus_page", "ats", "sitemap", "feed", "related_career_page", "archive"
]

# Bounds for the one Wayback source discovery adds per company.
ARCHIVE_WINDOW_YEARS = 5
ARCHIVE_MAX_CAPTURES = 45
# Sitemaps kept per company. Roblox's robots.txt lists thirty, one per locale and game catalogue, and every
# sitemap source is fetched on every collection and signal run.
MAX_SITEMAP_SOURCES = 5


class DiscoveryEvidence(BaseModel):
    method: DiscoveryMethod
    evidence_url: HttpUrl
    quote: str = Field(min_length=1, max_length=2_000)
    metadata: dict[str, Any] = Field(default_factory=dict)


class DiscoveredSource(BaseModel):
    id: UUID
    company_id: UUID
    url: HttpUrl
    category: SourceCategory
    adapter: AdapterName
    external_key: str | None = None
    trust_score: float = Field(ge=0, le=1)
    evidence: list[DiscoveryEvidence] = Field(min_length=1)
    options: dict[str, Any] = Field(default_factory=dict)

    def as_source_config(self, company: str) -> SourceConfig:
        return SourceConfig(
            id=self.id,
            company_id=self.company_id,
            company=company,
            adapter=self.adapter,
            url=self.url,
            external_key=self.external_key,
            trust_score=self.trust_score,
            options={**self.options, "discovery_category": self.category},
        )


class RejectedSource(BaseModel):
    """An observed ATS board that was not attached, with the board's own response that refuted it."""

    url: HttpUrl
    adapter: AdapterName
    external_key: str | None = None
    reason: str
    evidence: list[DiscoveryEvidence] = Field(min_length=1)


class CompanyIdentity(BaseModel):
    id: UUID
    name: str = Field(min_length=1, max_length=300)
    domain: str = Field(min_length=3, max_length=253)
    official_url: HttpUrl
    careers_url: HttpUrl | None = None
    recruiting_url: HttpUrl | None = None
    ats_provider: str | None = None
    ats_tenant: str | None = None
    evidence: list[DiscoveryEvidence] = Field(min_length=1)


class CompanyDiscoveryResult(BaseModel):
    query: str
    identity: CompanyIdentity
    sources: list[DiscoveredSource]
    rejected_sources: list[RejectedSource] = Field(default_factory=list)

    def source_configs(self) -> list[SourceConfig]:
        return [source.as_source_config(self.identity.name) for source in self.sources]


@dataclass(frozen=True)
class DnsResult:
    addresses: tuple[str, ...] = ()
    canonical_name: str | None = None


class DomainResolver(Protocol):
    def resolve(self, domain: str) -> DnsResult: ...


class SocketDomainResolver:
    def resolve(self, domain: str) -> DnsResult:
        records = socket.getaddrinfo(domain, 443, type=socket.SOCK_STREAM)
        addresses = tuple(sorted({str(record[4][0]) for record in records}))
        canonical = socket.getfqdn(domain)
        return DnsResult(addresses=addresses, canonical_name=canonical if canonical != domain else None)


class IdentityResolver(Protocol):
    def propose(self, query: str, attempted_domains: list[str]) -> tuple[str, str] | None: ...


class _IdentityProposal(BaseModel):
    name: str | None = None
    domain: str | None = None


class LlmIdentityResolver:
    """Low-cost ambiguity resolver; its proposal is verified by deterministic fetching."""

    def __init__(self, client: CompletionClient) -> None:
        self.client = client
        self.last_completion: CompletionResult | None = None

    def propose(self, query: str, attempted_domains: list[str]) -> tuple[str, str] | None:
        response = self.client.complete(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Identify the official company domain only when unambiguous. Return JSON with "
                        "name and domain, or null values. Do not return careers or job-board domains."
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps({"query": query, "attempted_domains": attempted_domains}),
                },
            ],
            response_model=_IdentityProposal,
        )
        self.last_completion = response
        try:
            payload = _IdentityProposal.model_validate_json(response.content)
        except ValueError:
            return None
        name = payload.name
        domain = payload.domain
        if not isinstance(name, str) or not isinstance(domain, str):
            return None
        normalized = _normalize_domain(domain)
        return (name.strip(), normalized) if name.strip() and normalized else None


@dataclass
class _Page:
    url: str
    html: str
    links: list[tuple[str, str, str, str]]
    head_links: list[tuple[str, str, str, str]]
    title: str | None
    site_name: str | None
    canonical: str | None
    organization_name: str | None


class _LinkParser(HTMLParser):
    """Anchors and <link> elements, kept apart.

    A <link> is a feed, a stylesheet, or an oEmbed endpoint, never a page to follow: HRT's jobs-plugin
    stylesheet and Old Mission's oEmbed endpoints once became careers pages because their addresses
    contain "jobs" and "campus".
    """

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str, str, str]] = []
        self.head_links: list[tuple[str, str, str, str]] = []
        self.title_parts: list[str] = []
        self.in_title = False
        self._anchor: dict[str, str] | None = None
        self._anchor_text: list[str] = []
        self.site_name: str | None = None
        self.canonical: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {key.casefold(): value or "" for key, value in attrs}
        if tag.casefold() == "title":
            self.in_title = True
        elif tag.casefold() == "a" and values.get("href"):
            self._anchor = values
            self._anchor_text = []
        elif tag.casefold() == "link" and values.get("href"):
            rel = values.get("rel", "").casefold()
            link_type = values.get("type", "").casefold()
            self.head_links.append((values["href"], values.get("title", ""), rel, link_type))
            if "canonical" in rel:
                self.canonical = values["href"]
        elif tag.casefold() == "meta":
            key = (values.get("property") or values.get("name") or "").casefold()
            if key == "og:site_name" and values.get("content"):
                self.site_name = values["content"].strip()

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title_parts.append(data)
        if self._anchor is not None:
            self._anchor_text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() == "title":
            self.in_title = False
        elif tag.casefold() == "a" and self._anchor is not None:
            self.links.append(
                (
                    self._anchor["href"],
                    " ".join("".join(self._anchor_text).split()),
                    self._anchor.get("rel", "").casefold(),
                    self._anchor.get("type", "").casefold(),
                )
            )
            self._anchor = None
            self._anchor_text = []


def _normalize_domain(value: str) -> str:
    candidate = value.strip().casefold()
    if "://" not in candidate:
        candidate = f"https://{candidate}"
    host = (urlparse(candidate).hostname or "").removeprefix("www.")
    return host.strip(".")


def _http_url(value: str) -> HttpUrl:
    return HttpUrl(value)


def _is_web_url(value: str) -> bool:
    """Only http(s) links can be sources. One mailto: link once discarded a whole company's discovery."""
    parsed = urlparse(value)
    return parsed.scheme in {"http", "https"} and bool(parsed.hostname)


def _same_site(url: str, domain: str) -> bool:
    host = _normalize_domain(url)
    return host == domain or host.endswith(f".{domain}")


_CAREERS_URL_PART = re.compile(
    r"(?:^|[./-])(?:careers?|jobs?|join|work|talent|recruit\w*|students?|university|campus|early-?careers?"
    r"|internships?|graduates?)(?:[./-]|$)"
)


def _careers_like(url: str) -> bool:
    """Whether a URL's host or path names recruiting, as a careers subdomain or a careers path does."""
    parsed = urlparse(url)
    return bool(_CAREERS_URL_PART.search((parsed.hostname or "").casefold()) or _CAREERS_URL_PART.search(parsed.path.casefold()))


# Dated blog posts, taxonomy archives, and WordPress API endpoints. Old Mission's homepage links six
# "Visit Us on Campus!" career-fair posts under /2026/09/04/; each became a campus page and its comment
# feed a job feed.
_POST_OR_ARCHIVE_PATH = re.compile(r"^/(?:(?:19|20)\d{2}/\d{2}/|(?:tag|category|author)/|wp-json/)")


def _post_or_archive(url: str) -> bool:
    return bool(_POST_OR_ARCHIVE_PATH.search(urlparse(url).path.casefold()))


def _not_a_page(url: str) -> bool:
    """Whether a link can never be a recruiting page, however it is labelled."""
    return _post_or_archive(url) or urlparse(url).path.casefold().rstrip("/").endswith("/feed")


def _names_a_cycle(url: str) -> bool:
    """Whether a URL's path names a year, as one cycle's posting does ("/job-post/2025-summer-internship")."""
    return bool(re.search(r"(?<!\d)(?:19|20)\d{2}(?!\d)", urlparse(url).path))


def _path_depth(url: str) -> int:
    return len([part for part in urlparse(url).path.split("/") if part])


def _canonical_url(value: str, base: str | None = None) -> str:
    parsed = urlparse(urljoin(base or value, value))
    scheme = parsed.scheme.casefold() or "https"
    hostname = (parsed.hostname or "").casefold()
    netloc = hostname
    if parsed.port and not (
        (scheme == "https" and parsed.port == 443) or (scheme == "http" and parsed.port == 80)
    ):
        netloc = f"{hostname}:{parsed.port}"
    path = re.sub(r"/{2,}", "/", parsed.path or "/")
    if path != "/":
        path = path.rstrip("/")
    return urlunparse((scheme, netloc, path, "", parsed.query, ""))


def _domain_candidates(query: str) -> list[str]:
    explicit = _input_domain(query)
    if explicit:
        return [explicit]
    words = re.findall(r"[a-z0-9]+", query.casefold())
    if not words:
        return []
    joined = "".join(words)
    hyphenated = "-".join(words)
    return list(dict.fromkeys([f"{joined}.com", f"{hyphenated}.com"]))


def _organization_name(html: str) -> str | None:
    scripts = re.findall(
        r"<script[^>]+type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>",
        html,
        flags=re.IGNORECASE | re.DOTALL,
    )
    for raw in scripts:
        try:
            value: Any = json.loads(raw)
        except json.JSONDecodeError:
            continue
        entries = value if isinstance(value, list) else [value]
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            graph = entry.get("@graph")
            if isinstance(graph, list):
                entries.extend(graph)
            entry_type = entry.get("@type")
            types = entry_type if isinstance(entry_type, list) else [entry_type]
            if any(str(item).casefold() in {"organization", "corporation"} for item in types):
                name = entry.get("name")
                if isinstance(name, str) and name.strip():
                    # Script content is not entity-decoded by the HTML parser.
                    return html_unescape(name).strip()
    return None


def _parse_page(url: str, html: str) -> _Page:
    parser = _LinkParser()
    parser.feed(html)
    title = " ".join("".join(parser.title_parts).split()) or None
    return _Page(
        url=url,
        html=html,
        links=parser.links,
        head_links=parser.head_links,
        title=title,
        site_name=parser.site_name,
        canonical=urljoin(url, parser.canonical) if parser.canonical else None,
        organization_name=_organization_name(html),
    )


def _display_name(domain: str) -> str:
    stem = domain.split(".")[0].replace("-", " ")
    return " ".join(word.capitalize() for word in stem.split())


def identity_key(value: str) -> str:
    """A name reduced to its letters and digits, for comparing names written differently."""
    return re.sub(r"[^a-z0-9]", "", value.casefold())


# How many of a board's postings must name the company before an unlinked Ashby or Lever board is accepted as
# theirs. Those two APIs publish no board name, so the postings are the only thing the ATS itself says about whose
# board it is; one mention could be a customer or a competitor, so several are required.
BOARD_POSTINGS_NAMING_COMPANY = 3


def postings_naming_company(
    adapter: AdapterName, text: str, company_name: str, domain: str
) -> tuple[int, int, str]:
    """How many of a board's postings name this company, how many were read, and one posting title that does.

    Only the company's full name and its domain label count, matched as whole words. A first word does not: "Physical"
    would accept any board that mentions physical work, and the point of this check is to refuse a board that is
    somebody else's.
    """
    labels = {company_name.strip(), domain.split(".")[-2] if "." in domain else domain} - {""}
    pattern = re.compile("|".join(rf"\b{re.escape(label)}\b" for label in sorted(labels)), re.IGNORECASE)
    postings = _board_postings(adapter, text)
    naming, quote = 0, ""
    for posting in postings:
        if pattern.search(_posting_words(posting)):
            naming += 1
            if not quote:
                quote = str(posting.get("title") or posting.get("text") or "").strip()[:200]
    return naming, len(postings), quote


def _posting_words(posting: Any) -> str:
    """A posting's words, with its links and identifiers left out.

    Every posting carries its own board URL, which holds the tenant: counting that would make the check circular and
    accept any tenant spelled like the company. `greenhouse/purestorage` is Everpure's board, and its postings say
    Everpure; only what a posting *says* may confirm whose board it is.
    """
    if isinstance(posting, str):
        return "" if posting.strip().lower().startswith(("http://", "https://", "www.")) else posting
    if isinstance(posting, dict):
        return " ".join(
            _posting_words(value)
            for key, value in posting.items()
            if not re.search(r"url|link|href|\bid\b|^id$|slug|path", str(key), re.IGNORECASE)
        )
    if isinstance(posting, list):
        return " ".join(_posting_words(item) for item in posting)
    return ""


def _board_postings(adapter: AdapterName, text: str) -> list[dict[str, Any]]:
    """The postings in one board API response, for the two APIs that publish no board name of their own."""
    try:
        payload = json.loads(text)
    except ValueError:
        return []
    if adapter == "ashby" and isinstance(payload, dict):
        jobs = payload.get("jobs")
        return [job for job in jobs if isinstance(job, dict)] if isinstance(jobs, list) else []
    if adapter == "lever" and isinstance(payload, list):
        return [job for job in payload if isinstance(job, dict)]
    return []


def board_names_company(board_name: str, company_name: str, domain: str) -> bool:
    """Whether an ATS board's own name names this company: its full name, first word, or domain label."""
    labels = domain.split(".")
    accepted = {
        identity_key(company_name),
        identity_key(company_name.split()[0]) if company_name.split() else "",
        identity_key(labels[-2] if len(labels) > 1 else domain),
    } - {""}
    board_key = identity_key(board_name)
    return board_key in accepted or any(key in board_key for key in accepted if len(key) >= 4)


_TITLE_SEPARATOR = re.compile(r"\s+[|–—·:-]\s+|\s*\|\s*")


def _identity_name(page: _Page, domain: str) -> str | None:
    """The page's own name for the company, when one of its names spells the domain.

    AbbVie's site metadata names a department ("Pharmaceutical Research & Development"); only the last
    segment of its title says "AbbVie". A name that spells the domain ("AbbVie" at abbvie.com, "Shield AI"
    at shield.ai) is chosen first, then one that begins with it ("Scale AI" at scale.com). None means no
    name spells it, and the structured name is used as before.
    """
    labels = domain.split(".")
    stem = identity_key(labels[-2] if len(labels) > 1 else domain)
    names = [
        html_unescape(value).strip()
        for value in (page.organization_name, page.site_name, *_TITLE_SEPARATOR.split(page.title or ""))
        if value and value.strip()
    ]
    spelled = [name for name in names if identity_key(name) in {stem, identity_key(domain)}]
    if spelled:
        return next((name for name in spelled if name != name.casefold()), spelled[0])
    if len(stem) >= 4:
        return next((name for name in names if identity_key(name).startswith(stem)), None)
    return None


def _fetch_failure(exc: Exception) -> str:
    if isinstance(exc, RobotsDisallowedError):
        return exc.code
    return f"HTTP {exc.code}" if isinstance(exc, HTTPError) else type(exc).__name__


def _input_domain(query: str) -> str | None:
    raw = query.strip()
    if not raw or re.search(r"\s", raw):
        return None
    domain = _normalize_domain(raw)
    if re.fullmatch(r"(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}", domain):
        return domain
    return None


_ATS_BOARD_URLS: dict[AdapterName, str] = {
    "greenhouse": "https://boards.greenhouse.io/{tenant}",
    "lever": "https://jobs.lever.co/{tenant}",
    "ashby": "https://jobs.ashbyhq.com/{tenant}",
    "smartrecruiters": "https://careers.smartrecruiters.com/{tenant}",
}

# Each ATS's public endpoint for one board, asked only to refute a board discovery observed.
_ATS_BOARD_CHECKS: dict[AdapterName, str] = {
    "greenhouse": "https://boards-api.greenhouse.io/v1/boards/{tenant}",
    "lever": "https://api.lever.co/v0/postings/{tenant}?mode=json&limit=1",
    "ashby": "https://api.ashbyhq.com/posting-api/job-board/{tenant}",
}


_ATS_TENANT = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,99}")
# Lever, Ashby, and SmartRecruiters tenants may contain dots. Anything else, such as Belvedere's
# "belvederetrading&quot" from an entity-escaped embed, is not a tenant.
_BOARD_TENANT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}")


def _ats_match(url: str) -> tuple[AdapterName, str] | None:
    parsed = urlparse(url)
    host = (parsed.hostname or "").casefold()
    parts = [part for part in parsed.path.split("/") if part]
    if host in {"boards.greenhouse.io", "job-boards.greenhouse.io", "boards-api.greenhouse.io"} and parts:
        if parts[0] == "embed":
            # Embedded boards name the tenant in `for=` (/embed/job_board?for=virtu). The path
            # segment is the widget, not a tenant; without `for=` there is no tenant to record.
            tenant = next((value for key, value in parse_qsl(parsed.query) if key == "for"), "")
        else:
            tenant = parts[2] if host == "boards-api.greenhouse.io" and len(parts) > 2 else parts[0]
        return ("greenhouse", tenant) if _ATS_TENANT.fullmatch(tenant) else None
    match: tuple[AdapterName, str] | None = None
    if host in {"jobs.lever.co", "api.lever.co"} and parts:
        match = "lever", parts[2] if host == "api.lever.co" and len(parts) > 2 else parts[0]
    elif host in {"jobs.ashbyhq.com", "api.ashbyhq.com"} and parts:
        # The public board path is /<tenant>[/<job-id>]; only the API form nests the
        # tenant last under /posting-api/job-board/<tenant>. Taking the final segment
        # for a board URL would capture a job identifier instead of the tenant.
        match = "ashby", parts[-1] if host == "api.ashbyhq.com" else parts[0]
    elif host in {"careers.smartrecruiters.com", "jobs.smartrecruiters.com"} and parts:
        match = "smartrecruiters", parts[0]
    return match if match and _BOARD_TENANT.fullmatch(match[1]) else None


def _ats_board_url(adapter: AdapterName, tenant: str) -> str:
    """Collapse any observed ATS URL to its board.

    A careers page links one URL per posting. Registering each as a source would
    create hundreds of duplicate ingestion targets for a single tenant and make
    repeated discovery non-idempotent, so every observation of a tenant resolves
    to the same canonical board.
    """
    template = _ATS_BOARD_URLS.get(adapter)
    return template.format(tenant=tenant) if template else ""


class IdentifyCompany:
    """Resolve official identity from a domain/name with optional LLM ambiguity help."""

    def __init__(
        self,
        transport: HttpTransport,
        dns: DomainResolver | None = None,
        llm: IdentityResolver | None = None,
    ) -> None:
        self.transport = transport
        self.dns = dns or SocketDomainResolver()
        self.llm = llm

    def run(self, query: str) -> tuple[CompanyIdentity, _Page]:
        attempted: list[str] = []
        failures: list[str] = []
        llm_proposal: tuple[str, str] | None = None
        candidates = _domain_candidates(query)
        while candidates:
            domain = candidates.pop(0)
            if domain in attempted:
                continue
            attempted.append(domain)
            dns_evidence: DnsResult | None = None
            try:
                dns_evidence = self.dns.resolve(domain)
                document = self.transport.get(f"https://{domain}/", accept="text/html,application/xhtml+xml")
            except (OSError, ValueError, KeyError) as exc:
                failures.append(f"{domain}: {_fetch_failure(exc)}")
                continue
            final_url = _canonical_url(document.url)
            landed = _normalize_domain(final_url)
            # A redirect within the company's own site (epicgames.com to store.epicgames.com) keeps the
            # domain that was asked for; a redirect to another domain (ziphq.com to zip.com) moves it.
            final_domain = domain if landed.endswith(f".{domain}") else landed
            page = _parse_page(final_url, document.text)
            name = (
                _identity_name(page, final_domain)
                or page.organization_name
                or page.site_name
                or (llm_proposal and llm_proposal[0])
            )
            name = html_unescape(str(name or _display_name(final_domain))).strip()
            explicit_domain = _input_domain(query) is not None
            query_tokens = set(re.findall(r"[a-z0-9]+", query.casefold()))
            identity_tokens = set(re.findall(r"[a-z0-9]+", name.casefold()))
            if not explicit_domain and not query_tokens.intersection(identity_tokens):
                failures.append(f"{domain}: its name {name!r} does not match the query")
                continue
            evidence = [
                DiscoveryEvidence(
                    method="input_domain" if explicit_domain else "structured_metadata",
                    evidence_url=_http_url(final_url),
                    quote=(page.organization_name or page.site_name or page.title or name)[:2_000],
                    metadata={"input": query},
                )
            ]
            if dns_evidence and (dns_evidence.addresses or dns_evidence.canonical_name):
                evidence.append(
                    DiscoveryEvidence(
                        method="dns",
                        evidence_url=_http_url(final_url),
                        quote=f"Resolved {domain}",
                        metadata={
                            "addresses": list(dns_evidence.addresses),
                            "canonical_name": dns_evidence.canonical_name,
                        },
                    )
                )
            if landed != domain:
                evidence.append(
                    DiscoveryEvidence(
                        method="redirect",
                        evidence_url=_http_url(final_url),
                        quote=f"{domain} redirected to {landed}",
                    )
                )
            if llm_proposal and domain == llm_proposal[1]:
                evidence.append(
                    DiscoveryEvidence(
                        method="llm_identity",
                        evidence_url=_http_url(final_url),
                        quote=f"LLM proposed {llm_proposal[0]} at {domain}; HTTP evidence verified it",
                    )
                )
            company_id = uuid5(NAMESPACE_URL, f"company:https://{final_domain}")
            return CompanyIdentity(
                id=company_id,
                name=name,
                domain=final_domain,
                official_url=_http_url(final_url),
                evidence=evidence,
            ), page
        if self.llm and llm_proposal is None:
            try:
                llm_proposal = self.llm.propose(query, attempted)
            except (ModelRoutingError, ProviderFailure) as exc:
                # The model only helps choose a domain. Its outage once replaced the real reason
                # (rubrik.com answers HTTP 403) with "All configured model routes failed".
                failures.append(f"identity model unavailable: {type(exc).__name__}")
            else:
                if llm_proposal and llm_proposal[1] not in attempted:
                    candidates.append(llm_proposal[1])
                    return self.run_with_proposal(query, attempted, llm_proposal)
        detail = "; ".join(failures) or "no candidate domain"
        raise LookupError(f"Could not verify an official company identity for {query!r}: {detail}")

    def run_with_proposal(
        self,
        query: str,
        attempted: list[str],
        proposal: tuple[str, str],
    ) -> tuple[CompanyIdentity, _Page]:
        resolver = IdentifyCompany(self.transport, self.dns, None)
        identity, page = resolver.run(proposal[1])
        proposed_tokens = set(re.findall(r"[a-z0-9]+", proposal[0].casefold()))
        observed_tokens = set(re.findall(r"[a-z0-9]+", identity.name.casefold()))
        if not proposed_tokens.intersection(observed_tokens):
            raise LookupError(
                f"Proposed company {proposal[0]!r} did not match identity metadata at {proposal[1]!r}"
            )
        identity = identity.model_copy(
            update={
                "evidence": [
                    *identity.evidence,
                    DiscoveryEvidence(
                        method="llm_identity",
                        evidence_url=identity.official_url,
                        quote=f"LLM proposed {proposal[0]} at {proposal[1]}; HTTP evidence verified it",
                        metadata={"query": query, "attempted_domains": attempted},
                    ),
                ],
            }
        )
        return identity, page

    __call__ = run


class DiscoverRecruitingSources:
    """Discover categorized, provenanced recruiting sources ready for ingestion."""

    _career_terms = ("career", "jobs", "join us", "join-us", "opportunities", "work with us")
    # "intern" must end there or go on as "interns" or "internship": "International Convention" once made
    # Commure's events page its campus page.
    _campus_label = re.compile(r"campus|student|graduate|university|early[\s_-]?careers?|intern(?:s|ships?)?(?![a-z])")
    _non_job_feed = re.compile(
        r"(?:^|[/_.-])(?:blogs?|news|press|stories|insights|articles|posts|updates|podcasts?|events?)(?:[/_.-]|$)"
    )

    def _is_job_feed(self, text: str, url: str) -> bool:
        """A feed is a job feed only by its link text or path, never by its host.

        Every feed linked from careers.withwaymo.com has "career" in its host. Its blog feed passed on
        that alone, and 318 blog posts became job observations with exact publication dates. A post's own
        feed is never one either: Old Mission's career-fair posts each link a comment feed, and "career"
        in the post's address once passed them.
        """
        path = urlparse(url).path.casefold()
        if self._non_job_feed.search(path) or re.search(r"\b(?:blogs?|news|press|stories)\b", text.casefold()):
            return False
        if _post_or_archive(url) or re.search(r"\bcomments?\b", text.casefold()):
            return False
        label = f"{text} {path}".casefold()
        return any(term in label for term in (*self._career_terms, "recruit"))

    def __init__(
        self,
        identity_tool: IdentifyCompany,
        transport: HttpTransport,
        *,
        today: Callable[[], date] = lambda: datetime.now(UTC).date(),
    ) -> None:
        self.identity_tool = identity_tool
        self.transport = transport
        self.today = today

    def _refuted_board(
        self, source: DiscoveredSource, identity: CompanyIdentity
    ) -> tuple[str, DiscoveryEvidence] | None:
        """Why an observed board must not be attached, when the ATS's own endpoint says so.

        Shield AI's careers page links the Greenhouse board of Aechelon Technology, whose metadata names
        Aechelon, and Commure's embeds an Ashby board that answers 404. Only a response refutes a board:
        an endpoint that cannot be reached leaves an observed board attached.
        """
        template = _ATS_BOARD_CHECKS.get(source.adapter)
        if template is None or not source.external_key:
            return None
        check_url = template.format(tenant=source.external_key)
        text = ""
        try:
            document = self.transport.get(check_url, accept="application/json")
            status, text = document.status, document.text
        except HTTPError as exc:
            status = exc.code
        except (OSError, ValueError, KeyError):
            return None
        if status in {404, 410}:
            return "board_not_found", DiscoveryEvidence(
                method="structured_metadata", evidence_url=_http_url(check_url), quote=f"{check_url} answered HTTP {status}"
            )
        if source.adapter != "greenhouse" or status >= 400:
            return None
        try:
            board_name = str(json.loads(text).get("name") or "").strip()
        except (ValueError, AttributeError):
            return None
        if board_name and not board_names_company(board_name, identity.name, identity.domain):
            return "board_name_mismatch", DiscoveryEvidence(
                method="structured_metadata",
                evidence_url=_http_url(check_url),
                quote=f'Greenhouse board metadata at {check_url} names the board "{board_name}"',
                metadata={"board_name": board_name},
            )
        return None

    def run(self, query: str) -> CompanyDiscoveryResult:
        identity, homepage = self.identity_tool.run(query)
        found: dict[str, DiscoveredSource] = {}

        def add(
            url: str,
            category: SourceCategory,
            adapter: AdapterName,
            evidence: DiscoveryEvidence,
            *,
            external_key: str | None = None,
            trust_score: float,
        ) -> None:
            normalized = _canonical_url(url, homepage.url)
            existing = found.get(normalized)
            if existing:
                if evidence not in existing.evidence:
                    existing.evidence.append(evidence)
                return
            found[normalized] = DiscoveredSource(
                id=uuid5(identity.id, normalized),
                company_id=identity.id,
                url=_http_url(normalized),
                category=category,
                adapter=adapter,
                external_key=external_key,
                trust_score=trust_score,
                evidence=[evidence],
            )

        def add_ats(adapter: AdapterName, tenant: str, absolute: str, page: _Page, quote: str) -> None:
            add(
                _ats_board_url(adapter, tenant) or absolute,
                "ats",
                adapter,
                DiscoveryEvidence(method="known_ats_pattern", evidence_url=_http_url(page.url), quote=quote),
                external_key=tenant,
                trust_score=0.95,
            )

        def add_embedded_ats_urls(page: _Page) -> None:
            # Entities are decoded first: Belvedere embeds its board in JSON inside an attribute, and the
            # "&quot;" after the URL once became part of a second Lever tenant.
            urls = re.findall(r"https?://[a-zA-Z0-9._~:/?#\[\]@!$&'()*+,;=%-]+", html_unescape(page.html))
            for raw_url in urls:
                absolute = _canonical_url(raw_url.rstrip("'),;."), page.url)
                ats_match = _ats_match(absolute)
                if ats_match:
                    add_ats(*ats_match, absolute, page, f"Embedded ATS URL {absolute}")

        def add_feed_links(page: _Page) -> None:
            # A site-wide feed link appears in the head of every page, including the careers page, so
            # being linked from there is not recruiting evidence. Without this the company blog or
            # release feed is ingested as job postings, and its entry dates become exact historical
            # openings on a regular publishing cadence.
            for href, text, rel, link_type in [*page.head_links, *page.links]:
                absolute = _canonical_url(href, page.url)
                if (
                    _is_web_url(absolute)
                    and "alternate" in rel
                    and link_type in {"application/rss+xml", "application/atom+xml"}
                    and self._is_job_feed(text, absolute)
                ):
                    add(
                        absolute,
                        "feed",
                        "rss",
                        DiscoveryEvidence(method="feed_link", evidence_url=_http_url(page.url), quote=f"Feed link {href}"),
                        trust_score=0.85,
                    )

        candidate_pages: list[tuple[str, SourceCategory, str]] = []
        for href, text, _rel, _link_type in homepage.links:
            absolute = _canonical_url(href, homepage.url)
            if not _is_web_url(absolute):
                continue  # mailto:, tel:, and javascript: links are not sources
            label = f"{text} {href}".casefold()
            ats_match = _ats_match(absolute)
            if ats_match:
                add_ats(*ats_match, absolute, homepage, f"{text or href} -> {absolute}")
            elif _not_a_page(absolute) or not recruiting_page(absolute):
                # A dated post, an archive, an API endpoint, or a page off a recruiting path, however its link reads:
                # Canonical's "Careers" menu once registered its homepage and its navigation fragment.
                continue
            elif self._campus_label.search(label):
                candidate_pages.append((absolute, "campus_page", text or href))
            elif any(term in label for term in self._career_terms):
                candidate_pages.append((absolute, "careers_page", text or href))
        add_feed_links(homepage)
        add_embedded_ats_urls(homepage)

        conventional_urls: set[str] = set()
        if not any(category in {"careers_page", "campus_page"} for _, category, _ in candidate_pages):
            # Some homepages render their navigation in script, so the HTML links no careers page
            # (Palantir, Neuralink). The conventional path is tried and kept only when it answers on
            # the company's own site; ATS links on that page are then observed as usual.
            for path in ("/careers", "/jobs"):
                try:
                    document = self.transport.get(urljoin(homepage.url, path), accept="text/html,application/xhtml+xml")
                except (OSError, ValueError, KeyError):
                    continue
                final = _canonical_url(document.url)
                if document.status < 400 and _same_site(final, identity.domain):
                    conventional_urls.add(final)
                    candidate_pages.append((final, "careers_page", f"Conventional careers path {path}"))
                    break

        for page_url, category, quote in list(dict.fromkeys(candidate_pages))[:12]:
            conventional = page_url in conventional_urls
            add(
                page_url,
                category,
                "generic",
                DiscoveryEvidence(
                    method="conventional_path" if conventional else "html_link",
                    evidence_url=_http_url(page_url if conventional else homepage.url),
                    quote=quote,
                ),
                trust_score=0.85 if category == "careers_page" else 0.8,
            )
            try:
                document = self.transport.get(page_url, accept="text/html,application/xhtml+xml")
            except (OSError, ValueError, KeyError):
                continue
            page = _parse_page(_canonical_url(document.url), document.text)
            for href, text, _rel, _link_type in page.links:
                absolute = _canonical_url(href, page.url)
                if not _is_web_url(absolute):
                    continue
                ats_match = _ats_match(absolute)
                if ats_match:
                    add_ats(*ats_match, absolute, page, f"{text or href} -> {absolute}")
                elif (
                    not _not_a_page(absolute)
                    and recruiting_page(absolute)
                    # A related page stays on the company's site or on the host of the page linking it (Waymo's
                    # careers.withwaymo.com): a Canva design on Belvedere's campus page, Bosch's LinkedIn share
                    # buttons, and Optiver's map links are not recruiting sources.
                    and (_same_site(absolute, identity.domain) or _normalize_domain(absolute) == _normalize_domain(page.url))
                    and self._campus_label.search(f"{text} {href}".casefold())
                ):
                    add(
                        absolute,
                        "related_career_page",
                        "generic",
                        DiscoveryEvidence(
                            method="html_link", evidence_url=_http_url(page.url), quote=text or href
                        ),
                        trust_score=0.75,
                    )
            add_feed_links(page)
            add_embedded_ats_urls(page)

        rejected: list[RejectedSource] = []
        for key, source in list(found.items()):
            refutation = self._refuted_board(source, identity) if source.category == "ats" else None
            if refutation is None:
                continue
            reason, response = refutation
            del found[key]
            rejected.append(
                RejectedSource(
                    url=source.url,
                    adapter=source.adapter,
                    external_key=source.external_key,
                    reason=reason,
                    evidence=[*source.evidence, response],
                )
            )

        # One bounded Wayback source per company, over the page most likely to show its annual programs
        # across years. Without it a newly discovered company gets no historical evidence at all, and
        # history is what forecasts are built from. Its provenance is the evidence that discovered the
        # page it archives. It shares that page's URL but is a different adapter, so it is keyed and
        # identified separately. In order of preference:
        # - a page on a careers host or path: "Snowflake University" links a training portal on
        #   learn.snowflake.com, while its university recruiting page sits under careers.snowflake.com;
        # - a page whose address names no year: DV Trading's "/job-post/2025-summer-internship-..." is one
        #   cycle's posting and cannot show the next cycle;
        # - a campus page, then a page linked from a careers page, then the careers page;
        # - the shallower page: AbbVie's careers host root over a learning-and-development article.
        archive_rank = {"campus_page": 0, "related_career_page": 1, "careers_page": 2}
        archive_target = min(
            (source for source in found.values() if source.category in archive_rank),
            key=lambda source: (
                not _careers_like(str(source.url)),
                _names_a_cycle(str(source.url)),
                archive_rank[source.category],
                _path_depth(str(source.url)),
            ),
            default=None,
        )
        if archive_target is not None:
            this_year = self.today().year
            archive_key = f"wayback:{archive_target.url}"
            found[archive_key] = DiscoveredSource(
                id=uuid5(identity.id, archive_key),
                company_id=identity.id,
                url=archive_target.url,
                category="archive",
                adapter="wayback",
                trust_score=archive_target.trust_score,
                evidence=list(archive_target.evidence),
                options={
                    "from": this_year - ARCHIVE_WINDOW_YEARS,
                    "to": this_year,
                    "max_captures": ARCHIVE_MAX_CAPTURES,
                    "max_total_captures": ARCHIVE_MAX_CAPTURES,
                    "include_subpaths": False,
                },
            )

        robots_url = urljoin(str(identity.official_url), "/robots.txt")
        try:
            robots = self.transport.get(robots_url, accept="text/plain")
            listed: list[tuple[str, str]] = []
            for match in re.finditer(r"^\s*Sitemap:\s*(\S+)", robots.text, re.IGNORECASE | re.MULTILINE):
                sitemap_url = _canonical_url(match.group(1), robots.url)
                # A root or recruiting sitemap only: Canonical's docs, knowledge, partners, and blog sitemaps, Ramp's
                # eighteen topic sitemaps, and Roblox's per-locale game catalogues are not.
                if _is_web_url(sitemap_url) and recruiting_sitemap(sitemap_url):
                    listed.append((sitemap_url, match.group(0).strip()))
            # A careers sitemap first, then robots.txt order, up to the bound.
            for sitemap_url, quote in sorted(listed, key=lambda item: not _careers_like(item[0]))[:MAX_SITEMAP_SOURCES]:
                add(
                    sitemap_url,
                    "sitemap",
                    "sitemap",
                    DiscoveryEvidence(
                        method="robots_sitemap",
                        evidence_url=_http_url(robots.url),
                        quote=quote,
                        metadata={"sitemaps_listed": len(listed)},
                    ),
                    trust_score=0.9,
                )
        except (OSError, ValueError, KeyError):
            pass

        sitemap_probe = urljoin(str(identity.official_url), "/sitemap.xml")
        if not any(source.category == "sitemap" for source in found.values()):
            try:
                sitemap = self.transport.get(sitemap_probe, accept="application/xml,text/xml")
                if (
                    sitemap.status < 400
                    and recruiting_sitemap(sitemap.url)
                    and re.search(r"<(?:\w+:)?(?:urlset|sitemapindex)\b", sitemap.text)
                ):
                    add(
                        sitemap.url,
                        "sitemap",
                        "sitemap",
                        DiscoveryEvidence(
                            method="sitemap_probe",
                            evidence_url=_http_url(sitemap.url),
                            quote="Valid sitemap XML root",
                        ),
                        trust_score=0.85,
                    )
            except (OSError, ValueError, KeyError):
                pass

        sources = sorted(found.values(), key=lambda source: (source.category, str(source.url)))
        careers = next((source.url for source in sources if source.category == "careers_page"), None)
        recruiting = next((source.url for source in sources if source.category == "campus_page"), None)
        company_key = identity_key(f"{identity.name}{identity.domain}")
        ats_sources = [source for source in sources if source.category == "ats"]

        def ats_identity_score(source: DiscoveredSource) -> tuple[int, float]:
            tenant = source.external_key
            normalized_tenant = identity_key(tenant) if tenant else ""
            return (int(bool(normalized_tenant) and normalized_tenant in company_key), source.trust_score)

        ats_source = max(
            ats_sources,
            key=ats_identity_score,
            default=None,
        )
        careers = careers or (ats_source.url if ats_source else None)
        identity = identity.model_copy(
            update={
                "careers_url": careers,
                "recruiting_url": recruiting,
                "ats_provider": ats_source.adapter if ats_source else None,
                "ats_tenant": ats_source.external_key if ats_source else None,
            }
        )
        return CompanyDiscoveryResult(query=query, identity=identity, sources=sources, rejected_sources=rejected)

    __call__ = run
