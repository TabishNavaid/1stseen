"""Which addresses a page-reading source may collect: recruiting paths only.

Generic career pages, sitemaps, and the archives over them read whatever page they are pointed at, so a source
registered on the wrong page is paid for on every run. Discovery once registered Canonical's homepage, its navigation
fragment, Ubuntu's IoT appstore and contact forms, a customer case study, and the docs, knowledge, partners, and blog
sitemaps as recruiting sources: 820 observations and four and a half minutes of collection for one in-scope role.
ATS boards and job feeds are recruiting endpoints by construction and are not judged here.

- A page is recruiting when its path names recruiting ("/careers", "/join-us/internships",
  "/new-graduates-campus-recruiting") or it sits on a recruiting host (careers.abbvie.com, whose listing pages may be
  "/us/en/search-results").
- A section of stories, blog posts, news, events, docs, partners, customers, or contact forms is never one, whatever
  host or path it sits under. Every link on careers.withwaymo.com has "career" in its host, which is how its blog feed
  became job postings, and Optiver's "/join-us/stories/..." is a story about an internship, not a posting of one. The
  section is recognized by a path segment that starts with such a word, except a posting's own slug after "/jobs/" or
  "/job-post/", so "/jobs/legal-intern" stays a posting.
- A sitemap source is a generically named root sitemap (/sitemap.xml, /sitemap_index.xml, /wp-sitemap.xml) or one
  named for recruiting (/sitemap-careers.xml). Coinbase's /sitemap-derivatives-index.xml and Roblox's per-locale game
  catalogues are neither. Inside a sitemap index, recruiting-named children are read first and non-posting children
  (/blog/sitemap.xml) never.
- Inside a urlset, a page is fetched only below a posting segment: "/careers/4981249", "/jobs/site-801",
  "/hrt-job/ai-researcher", "/careers/listing/...". Recruiting vocabulary alone is too loose for a sitemap's pages: on
  2026-09-16 it matched DRW's "/work-at-drw/who-we-are" and "/tags/university-recruiting", AbbVie's "/join-us/life-at-
  abbvie", and 4,990 of Lyft's 92,736 URLs, where posting segments match 0, 1, and 3.
"""

from __future__ import annotations

import re
from urllib.parse import urlparse

_WORD = re.compile(r"[a-z0-9]+")

# Whole words in a host label or path. "intern" never matches "internet": words are compared whole. A few stems also
# match as the start of a word ("jobshub", "careersite"), never as its end ("point72careers" is a social handle).
RECRUITING_WORDS = frozenset(
    {
        "apprentice", "apprentices", "apprenticeship", "apprenticeships", "campus", "career", "careers", "carreira",
        "carreiras", "carriere", "carrieres", "empleo", "empleos", "emploi", "emplois", "grad", "graduate",
        "graduates", "grads", "hiring", "intern", "interns", "internship", "internships", "job", "jobs", "karriere",
        "opening", "openings", "position", "positions", "recruit", "recruiting", "recruitment", "stellen",
        "stellenangebote", "student", "students", "talent", "universities", "university", "vacancies", "vacancy",
    }
)
RECRUITING_STEMS = ("career", "job", "karriere", "recruit")
RECRUITING_PHRASES = ("early career", "early careers", "join us", "join our team", "work with us", "work at", "workwithus", "joinus", "earlycareers")

# A path segment starting with one of these words is a section that holds no postings.
NOT_A_POSTING_WORDS = frozenset(
    {
        "article", "articles", "benefits", "blog", "blogs", "contact", "cookie", "cookies", "customers", "developers",
        "doc", "docs", "documentation", "event", "events", "faq", "faqs", "help", "insights", "investor", "investors",
        "knowledge", "legal", "news", "newsroom", "partner", "partners", "podcast", "podcasts", "post", "posts",
        "press", "pricing", "privacy", "stories", "story", "terms", "webinar", "webinars",
        # Taxonomy archives: DRW's "/tags/university-recruiting".
        "author", "authors", "categories", "category", "tag", "tags",
    }
)
# A segment naming postings, below which a sitemap page may be one.
POSTING_WORDS = frozenset(
    {"career", "careers", "opening", "openings", "position", "positions", "requisition", "requisitions", "vacancy", "vacancies"}
)
# A segment after one of these is a posting's slug, whatever words it starts with.
_POSTING_PARENT_WORDS = frozenset({"job", "jobs", "position", "positions", "opening", "openings", "vacancy", "vacancies"})
# Dated posts, taxonomy archives, and API endpoints (as discovery rejects them).
_POST_OR_ARCHIVE_PATH = re.compile(r"^/(?:(?:19|20)\d{2}/\d{2}/|(?:tag|category|author)/|wp-json/)")
# /sitemap.xml, /sitemap_index.xml, /sitemap/sitemap.xml (Stripe), /sitemaps/main.xml (Replit): a root file whose
# name says nothing but "sitemap".
_ROOT_SITEMAP = re.compile(r"^(?:/sitemaps?)?/[a-z0-9_-]+\.xml$")
_GENERIC_SITEMAP_WORDS = frozenset({"sitemap", "sitemaps", "sitemapindex", "index", "tree", "root", "main", "wp", "pages", "xml"})



def _words(text: str) -> list[str]:
    return _WORD.findall(text.casefold())


def _names_recruiting(text: str) -> bool:
    words = _words(text)
    joined = " ".join(words)
    return any(word in RECRUITING_WORDS or word.startswith(RECRUITING_STEMS) for word in words) or any(
        f" {phrase} " in f" {joined} " or phrase in words for phrase in RECRUITING_PHRASES
    )


def not_a_posting_page(url: str) -> bool:
    """A page in a stories, blog, news, events, docs, legal, or contact section, or a dated post."""
    path = urlparse(url).path.casefold()
    if _POST_OR_ARCHIVE_PATH.search(path):
        return True
    parent: list[str] = []
    for segment in (item for item in path.split("/") if item):
        words = _words(segment)
        if words and words[0] in NOT_A_POSTING_WORDS and not _POSTING_PARENT_WORDS.intersection(parent):
            return True
        parent = words
    return False


def recruiting_host(url: str) -> bool:
    """careers.example.com or jobs.example.com: a host whose labels, other than the registrable domain, name recruiting."""
    labels = (urlparse(url).hostname or "").casefold().split(".")
    return any(_names_recruiting(label) for label in labels[:-2])


def recruiting_page(url: str) -> bool:
    """Whether a generic career page or an archive of one may be collected."""
    if not_a_posting_page(url):
        return False
    return recruiting_host(url) or _names_recruiting(urlparse(url).path)


def _posting_segment(segment: str) -> bool:
    return any(word in POSTING_WORDS or word.startswith("job") for word in _words(segment))


def sitemap_job_page(url: str) -> bool:
    """Whether a page listed in a sitemap is fetched: it sits below a segment naming postings, on any host."""
    if not_a_posting_page(url):
        return False
    segments = [segment for segment in urlparse(url).path.casefold().split("/") if segment]
    return any(_posting_segment(segment) for segment in segments[:-1])


def recruiting_sitemap(url: str) -> bool:
    """Whether a sitemap source may be collected: a root sitemap or one named for recruiting, never a non-posting one."""
    path = urlparse(url).path.casefold()
    if not_a_posting_page(url):
        return False
    if _names_recruiting(path):
        return True
    generic_name = all(word in _GENERIC_SITEMAP_WORDS or word.isdigit() for word in _words(path))
    return bool(_ROOT_SITEMAP.match(path)) and generic_name


def sitemap_children(urls: list[str]) -> list[str]:
    """Child sitemaps worth reading, recruiting-named first, in their listed order otherwise."""
    kept = [url for url in urls if not not_a_posting_page(url)]
    return sorted(kept, key=lambda url: not _names_recruiting(urlparse(url).path))


PAGE_ADAPTERS = frozenset({"generic", "sitemap", "wayback"})


def page_source_allowed(adapter: str, url: str) -> bool:
    """Whether a source of this adapter may collect this address. Non-page adapters are always allowed."""
    if adapter == "sitemap":
        return recruiting_sitemap(url)
    if adapter in {"generic", "wayback"}:
        return recruiting_page(url)
    return True
