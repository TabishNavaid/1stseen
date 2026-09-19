"""Recruiting-event signals from Reddit's approved OAuth Data API.

The adapter searches posts only, retains no author identity, and emits supporting
community evidence. It never creates job observations or historical openings.
"""

from __future__ import annotations

import base64
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal, Protocol, cast
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from pydantic import BaseModel, Field

from firstseen.config import Settings, get_settings
from firstseen.providers import CompletionClient
from firstseen.security import UNTRUSTED_EVIDENCE_SYSTEM_PROMPT
from firstseen.signals import CommunityEventType, SignalCandidate, SocialSource

_EVENT_PATTERNS: tuple[tuple[CommunityEventType, re.Pattern[str]], ...] = (
    (
        "applications_closed",
        re.compile(
            r"\b(?:applications?|apps?)\s+(?:are\s+|have\s+)?(?:closed|closing)\b|"
            r"\bno longer accepting applications\b",
            re.IGNORECASE,
        ),
    ),
    (
        "applications_opening_soon",
        re.compile(
            r"\b(?:applications?|apps?)\s+(?:will\s+)?open(?:ing)?\s+"
            r"(?:next\s+(?:week|month)|soon|in\s+\d+\s+(?:days?|weeks?))\b|"
            r"\brecruiter\s+(?:said|says|mentioned).{0,80}\bopen",
            re.IGNORECASE,
        ),
    ),
    (
        "applications_opened",
        re.compile(
            r"\b(?:applications?|apps?)\s+(?:are\s+|just\s+|have\s+)?open(?:ed)?\b|"
            r"\b(?:internship|intern|new\s+grad|program).{0,70}\bis\s+live\b",
            re.IGNORECASE,
        ),
    ),
)
_RECRUITING = re.compile(
    r"\b(?:applications?|internships?|intern|new\s+grad|university|campus|recruiter|program)\b",
    re.IGNORECASE,
)
_ROLE = re.compile(
    r"\b(?:software\s+(?:engineer|engineering)|swe|data\s+(?:scientist|science)|"
    r"product\s+manager|machine\s+learning|security|design|finance|business)"
    r"(?:\s+(?:internship|intern|new\s+grad|program))?\b",
    re.IGNORECASE,
)
_EXPLICIT_DATE = re.compile(r"\b(?P<year>20\d{2})-(?P<month>0?[1-9]|1[0-2])-(?P<day>0?[1-9]|[12]\d|3[01])\b")
_RELATIVE = re.compile(r"\b(?:just|today|next\s+(?:week|month)|soon)\b", re.IGNORECASE)


class RedditApiError(RuntimeError):
    """A supported API request failed; callers must not bypass the failure."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class RedditHttpResponse:
    status: int
    body: bytes
    headers: Mapping[str, str]


class RedditTransport(Protocol):
    def request(
        self,
        url: str,
        *,
        method: str,
        headers: Mapping[str, str],
        body: bytes | None = None,
    ) -> RedditHttpResponse: ...


class UrlLibRedditTransport:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or get_settings()

    def request(
        self,
        url: str,
        *,
        method: str,
        headers: Mapping[str, str],
        body: bytes | None = None,
    ) -> RedditHttpResponse:
        try:
            request = Request(url, data=body, headers=dict(headers), method=method)
            with urlopen(request, timeout=self.settings.http_timeout_seconds) as response:
                payload = response.read(self.settings.max_source_bytes)
                return RedditHttpResponse(response.status, payload, dict(response.headers.items()))
        except HTTPError as exc:
            raise RedditApiError(f"Reddit Data API returned HTTP {exc.code}", status_code=exc.code) from exc


@dataclass(frozen=True)
class RedditPost:
    post_id: str
    title: str
    body: str
    permalink: str
    community: str
    published_at: datetime

    @property
    def text(self) -> str:
        return "\n".join(part for part in (self.title.strip(), self.body.strip()) if part)[:8_192]

    @property
    def source_url(self) -> str:
        return f"https://www.reddit.com{self.permalink}"


class RedditClaimExtraction(BaseModel):
    relevant: bool
    event_type: CommunityEventType | None = None
    possible_role: str | None = Field(default=None, max_length=200)
    claimed_date_text: str | None = Field(default=None, max_length=200)
    evidence_snippet: str | None = Field(default=None, max_length=1_000)


class RedditDataApiClient:
    """Minimal application-only OAuth client with no retries or quota workarounds."""

    def __init__(self, settings: Settings, transport: RedditTransport | None = None) -> None:
        if not settings.reddit_api_enabled:
            raise ValueError("Reddit API collection is disabled")
        self.settings = settings
        self.transport = transport or UrlLibRedditTransport(settings)
        self._token: str | None = None

    def search(self, query: str, *, community: str | None = None) -> tuple[RedditPost, ...]:
        token = self._token or self._authenticate()
        endpoint = "https://oauth.reddit.com"
        if community:
            endpoint += f"/r/{community}/search"
        params = urlencode(
            {
                "q": query,
                "restrict_sr": "1" if community else "0",
                "sort": "new",
                "type": "link",
                "limit": self.settings.reddit_search_limit,
                "raw_json": "1",
            }
        )
        response = self.transport.request(
            f"{endpoint}?{params}",
            method="GET",
            headers={
                "Authorization": f"Bearer {token}",
                "User-Agent": cast(str, self.settings.reddit_user_agent),
                "Accept": "application/json",
            },
        )
        self._require_success(response)
        remaining = response.headers.get("x-ratelimit-remaining")
        if remaining is not None and float(remaining) <= 0:
            raise RedditApiError("Reddit Data API rate limit exhausted", status_code=429)
        return self._parse_posts(response.body)

    def _authenticate(self) -> str:
        credentials = f"{self.settings.reddit_client_id}:{self.settings.reddit_client_secret}"
        authorization = base64.b64encode(credentials.encode()).decode()
        response = self.transport.request(
            "https://www.reddit.com/api/v1/access_token",
            method="POST",
            headers={
                "Authorization": f"Basic {authorization}",
                "User-Agent": cast(str, self.settings.reddit_user_agent),
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body=urlencode({"grant_type": "client_credentials"}).encode(),
        )
        self._require_success(response)
        payload = json.loads(response.body)
        token = payload.get("access_token")
        if not isinstance(token, str) or not token:
            raise RedditApiError("Reddit OAuth response did not contain an access token")
        self._token = token
        return token

    @staticmethod
    def _require_success(response: RedditHttpResponse) -> None:
        if response.status < 200 or response.status >= 300:
            raise RedditApiError(
                f"Reddit Data API returned HTTP {response.status}", status_code=response.status
            )

    @staticmethod
    def _parse_posts(body: bytes) -> tuple[RedditPost, ...]:
        payload = json.loads(body)
        children = payload.get("data", {}).get("children", [])
        posts: list[RedditPost] = []
        for child in children:
            data = child.get("data", {}) if isinstance(child, dict) else {}
            try:
                timestamp = datetime.fromtimestamp(float(data["created_utc"]), tz=UTC)
                posts.append(
                    RedditPost(
                        post_id=str(data["id"]),
                        title=str(data.get("title") or ""),
                        body=str(data.get("selftext") or ""),
                        permalink=str(data["permalink"]),
                        community=str(data.get("subreddit") or ""),
                        published_at=timestamp,
                    )
                )
            except (KeyError, TypeError, ValueError, OverflowError):
                continue
        return tuple(posts)


class RedditSignalAdapter:
    """Deterministic-first adapter for a configured company and community allowlist."""

    source_name: SocialSource = "reddit"

    def __init__(
        self,
        client: RedditDataApiClient,
        *,
        communities: Sequence[str],
        company_aliases: Sequence[str] = (),
        llm: CompletionClient | None = None,
    ) -> None:
        self.client = client
        self.communities = tuple(dict.fromkeys(communities))
        self.company_aliases = tuple(company_aliases)
        self.llm = llm

    def collect(self, company: str, *, since: datetime | None = None) -> Sequence[SignalCandidate]:
        aliases = tuple(dict.fromkeys((company, *self.company_aliases)))
        query = f'("{company}" AND (intern OR internship OR "new grad" OR applications))'
        posts: dict[str, RedditPost] = {}
        if not self.communities:
            raise ValueError("Reddit collection requires an explicit community allowlist")
        for community in self.communities:
            for post in self.client.search(query, community=community):
                if (since is None or post.published_at > since) and post.post_id not in posts:
                    posts[post.post_id] = post
        candidates: list[SignalCandidate] = []
        for post in posts.values():
            candidate = self._extract(post, aliases)
            if candidate:
                candidates.append(candidate)
        return tuple(candidates)

    def _extract(self, post: RedditPost, aliases: Sequence[str]) -> SignalCandidate | None:
        text = post.text
        if not _RECRUITING.search(text) or not any(_mentions(text, alias) for alias in aliases):
            return None
        event_type = next((kind for kind, pattern in _EVENT_PATTERNS if pattern.search(text)), None)
        role = _ROLE.search(text)
        claimed_at, date_text, precision = _claimed_date(text, post.published_at, event_type)
        method: Literal["structured_endpoint", "llm"] = "structured_endpoint"
        snippet = _bounded_snippet(text, event_type)
        if event_type is None:
            extraction = self._llm_extract(text, aliases)
            if not extraction:
                return None
            event_type = extraction.event_type
            date_text = extraction.claimed_date_text
            snippet = extraction.evidence_snippet or snippet
            method = "llm"
            claimed_at, _, precision = _claimed_date(date_text or "", post.published_at, event_type)
        if event_type is None:
            return None
        role_text = role.group(0) if role else None
        if role_text and role_text.casefold() not in snippet.casefold():
            snippet = f"{snippet} · Possible role: {role_text}"[:8_192]
        return SignalCandidate(
            "community_recruiting_discussion",
            post.source_url,
            snippet,
            method,
            claimed_event_at=claimed_at,
            source_published_at=post.published_at,
            community_event_type=event_type,
            claimed_date_text=date_text,
            claimed_date_precision=precision,
            strength=0.30,
        )

    def _llm_extract(self, text: str, aliases: Sequence[str]) -> RedditClaimExtraction | None:
        if self.llm is None:
            return None
        result = self.llm.complete(
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Classify only whether this Reddit post claims recruiting applications opened, "
                        "closed, or will open soon. Copy a short exact evidence substring. Do not infer "
                        f"dates, authority, reliability, or confidence. {UNTRUSTED_EVIDENCE_SYSTEM_PROMPT}"
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {"company_aliases": list(aliases), "untrusted_post_text": text[:4_000]}
                    ),
                },
            ],
            response_model=RedditClaimExtraction,
        )
        extraction = RedditClaimExtraction.model_validate_json(result.content)
        if not extraction.relevant or not extraction.event_type or not extraction.evidence_snippet:
            return None
        if extraction.evidence_snippet not in text:
            return None
        return extraction


def _mentions(text: str, alias: str) -> bool:
    return bool(re.search(rf"(?<!\w){re.escape(alias)}(?!\w)", text, re.IGNORECASE))


def _claimed_date(
    text: str,
    post_time: datetime,
    event_type: CommunityEventType | None,
) -> tuple[
    datetime | None, str | None, Literal["explicit", "relative_to_post", "relative_unresolved", "unknown"]
]:
    explicit = _EXPLICIT_DATE.search(text)
    if explicit:
        try:
            value = datetime(
                int(explicit.group("year")),
                int(explicit.group("month")),
                int(explicit.group("day")),
                tzinfo=UTC,
            )
            return value, explicit.group(0), "explicit"
        except ValueError:
            pass
    relative = _RELATIVE.search(text)
    if relative:
        phrase = relative.group(0)
        if phrase.casefold() in {"just", "today"} and event_type == "applications_opened":
            return post_time, phrase, "relative_to_post"
        return None, phrase, "relative_unresolved"
    return None, None, "unknown"


def _bounded_snippet(text: str, event_type: CommunityEventType | None) -> str:
    normalized = " ".join(text.split())
    if event_type:
        pattern = next(pattern for kind, pattern in _EVENT_PATTERNS if kind == event_type)
        match = pattern.search(normalized)
        if match:
            start = max(0, match.start() - 180)
            end = min(len(normalized), match.end() + 180)
            return normalized[start:end][:1_000]
    return normalized[:1_000]
