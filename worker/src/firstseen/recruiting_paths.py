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


# One job posting, not a page that lists them. Discovery registered fifteen of these as recurring page sources --
# ten at IMC, three at Vercel, two at Canonical -- because a job detail page linked from a careers page passes every
# other test for a "related" page: it is on the company's own site, under a recruiting path, and named for a job. A
# single posting is never a source. It is one row of a board we already poll directly, it stops existing when the
# posting closes, and on a listing page its anchor text carries the row's facet columns, which is where titles like
# "Hardware Engineer Intern Intern Technology Amsterdam" come from.
#
# The id is the tell: a trailing run of six or more digits, alone or after a slug (`/careers/4981249`,
# `/careers/jobs/4751729101`, `/careers/software-engineering-intern-summer-27-6181759004`), or a bare UUID as Lever
# and Ashby write one. Six digits and not four, so a cohort year (`/careers/emerging-talent-2026`) is not a posting.
_JOB_ID_SEGMENT = re.compile(r"^(?:[a-z0-9-]*-)?\d{6,}$")
_UUID_SEGMENT = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


# A role named in a posting's own slug. `generic.py` keeps a shorter list of the same idea for admitting anchors;
# this one is for paths and is deliberately wider, and the two are not merged because changing which anchors become
# jobs is a separate change that needs its own measurement.
_ROLE_SLUG_WORDS = frozenset(
    {
        "analyst", "apprentice", "apprenticeship", "architect", "associate", "designer", "developer", "engineer",
        "engineering", "graduate", "intern", "interns", "internship", "internships", "manager", "research",
        "researcher", "scientist", "specialist", "technician", "trader",
    }
)


def single_job_page(url: str) -> bool:
    """Whether this address is one job posting rather than a page listing them.

    Two tests, because the first one alone was less than half the category. Keying on an id in the address found 15
    of the rig's page sources; a rule that does not need one found 17 more it could not see --
    `careers.withwaymo.com/jobs/2027-summer-intern-bs-ms-software-engineer-san-francisco-california-united-states`,
    `hudsonrivertrading.com/hrt-job/hardware-engineer-internship-summer-2027`,
    `optiver.com/join-us/jobs/technology/london/graduate-software-engineer`. Two earlier rules had agreed on 15 and
    I read that as corroboration; both keyed on the id, so it was one test run twice.

    The second test reuses `_POSTING_PARENT_WORDS`, which already existed for the sitemap path and already excludes
    `careers` for exactly this reason: a segment under `jobs` or `hrt-job` is a posting's slug, a segment under
    `careers` may be a listing. The slug must also name a role, which is what separates a posting from a department
    index: `/join-us/jobs/technology` and `/jobs/search` stay listings.
    """
    segments = [item for item in urlparse(url).path.casefold().split("/") if item]
    if not segments:
        return False
    if _JOB_ID_SEGMENT.match(segments[-1]) or _UUID_SEGMENT.match(segments[-1]):
        return True
    if len(segments) < 2:
        return False
    under_postings = any(word in _POSTING_PARENT_WORDS for item in segments[:-1] for word in _words(item))
    return under_postings and any(word in _ROLE_SLUG_WORDS for word in _words(segments[-1]))


def recruiting_host(url: str) -> bool:
    """careers.example.com or jobs.example.com: a host whose labels, other than the registrable domain, name recruiting."""
    labels = (urlparse(url).hostname or "").casefold().split(".")
    return any(_names_recruiting(label) for label in labels[:-2])


def recruiting_page(url: str) -> bool:
    """Whether this address is on a recruiting path at all.

    A single posting is: `/jobs/legal-intern` is as much a recruiting address as `/careers`. Whether it may be a
    *source* is a different question and lives in `page_source_allowed`, which is where `single_job_page` belongs.
    Putting it here conflated the two and claimed a posting was off the recruiting path, which it is not.
    """
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


# Which rule refused a source, so a retirement is explicable six months later and a widening rule can be read off
# the audit row rather than inferred from the date.
REFUSAL_NOT_A_RECRUITING_SITEMAP = "not_a_recruiting_sitemap"
REFUSAL_IN_A_NON_RECRUITING_SECTION = "in_a_non_recruiting_section"
REFUSAL_SINGLE_JOB_POSTING = "a_single_job_posting"
REFUSAL_OFF_THE_RECRUITING_PATH = "off_the_recruiting_path"


def page_source_refusal(adapter: str, url: str) -> str | None:
    """Which rule refuses this source, or None when none does. Non-page adapters are always allowed.

    One definition with a name attached. `page_source_allowed` is this answered as a yes or no, and the name is what
    an audit row carries: measured 2026-10-16, the rules refuse 132 of 439 enabled sources, and "not on a recruiting
    path" and "a single job posting" are different enough findings that collapsing them into one code made the
    132 unreadable.
    """
    if adapter == "sitemap":
        return None if recruiting_sitemap(url) else REFUSAL_NOT_A_RECRUITING_SITEMAP
    if adapter in {"generic", "wayback"}:
        if not_a_posting_page(url):
            return REFUSAL_IN_A_NON_RECRUITING_SECTION
        # A single posting is on a recruiting path and is still not a source, so both tests run here: discovery
        # cannot register one, and collection skips the ones already registered before making a request.
        if single_job_page(url):
            return REFUSAL_SINGLE_JOB_POSTING
        if not recruiting_page(url):
            return REFUSAL_OFF_THE_RECRUITING_PATH
    return None


def page_source_allowed(adapter: str, url: str) -> bool:
    """Whether a source of this adapter may collect this address."""
    return page_source_refusal(adapter, url) is None
