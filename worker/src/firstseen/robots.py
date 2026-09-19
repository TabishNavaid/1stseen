"""robots.txt, read once per origin per run and honoured before every collector request (RFC 9309).

Every collector request goes through `adapters.base.UrlLibTransport.get`, which asks `RobotsGate.check` after the
public-address policy and before the request. That covers current jobs, archive history, signals, discovery, and
board registration alike, and the official ATS API hosts and the Wayback Machine are subject to their own robots.txt
the same way as a company's site.

Enforcement is switched by `ROBOTS_TXT_ENFORCED` (config.py) and is off by default: with it off, collection behaves
exactly as it did before and robots.txt is never read. docs/takedown.md records what turning it on was measured to skip.

The rule:

- robots.txt is read from the origin (scheme, host, and port) of the URL about to be fetched, once per origin per run,
  because one transport is one run. The read goes through the same public-address policy, per-host pacing, and
  timeout as any request, and at most `ROBOTS_MAX_BYTES` are read (RFC 9309 asks for at least 500 KiB).
- A 2xx response is parsed. The rules of every group naming the collector's product token (`ROBOTS_PRODUCT_TOKEN`,
  compared case-insensitively) apply; when no group names it, the rules of every `*` group; when neither exists,
  nothing is disallowed.
- The longest matching pattern wins, and an Allow and a Disallow of equal length resolve to Allow. `*` matches any run
  of characters and a trailing `$` anchors the end. Patterns are matched against the path and query. An empty
  `Disallow:` disallows nothing. `Crawl-delay`, `Sitemap`, and other lines are not rules and are ignored here.
- Any other 4xx means robots.txt is unavailable, and nothing is disallowed (RFC 9309, section 2.3.1.3). A 3xx the
  redirect limit left unresolved is treated the same way.
- A 5xx, a 429, a timeout, a network failure, or an address the public-address policy refuses means robots.txt is
  unreachable, and the whole origin is treated as disallowed for the rest of the run (section 2.3.1.4). A 429 is a
  request to slow down, so it is not read as permission.
- `/robots.txt` itself is always allowed.

A refused URL raises `RobotsDisallowedError` before any request is made. It is a `ValueError`, like
`security.UnsafeUrlError`, so every existing per-URL error path isolates it; callers that report diagnostics turn it
into a typed `robots_disallowed` or `robots_unreachable` diagnostic rather than a failure.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from functools import lru_cache
from threading import Lock
from typing import Literal
from urllib.parse import quote, urlsplit

ROBOTS_PRODUCT_TOKEN = "1stSeenEvidenceBot"
COLLECTOR_USER_AGENT = f"{ROBOTS_PRODUCT_TOKEN}/0.2 (+recruiting-research)"
ROBOTS_MAX_BYTES = 512 * 1024

RobotsRefusalCode = Literal["robots_disallowed", "robots_unreachable"]


class RobotsDisallowedError(ValueError):
    """Raised before a collector requests a URL that its origin's robots.txt does not allow."""

    def __init__(
        self,
        url: str,
        *,
        code: RobotsRefusalCode,
        robots_url: str,
        rule: str | None = None,
        status: int | None = None,
    ) -> None:
        self.url = url
        self.code: RobotsRefusalCode = code
        self.robots_url = robots_url
        self.rule = rule
        self.status = status
        if code == "robots_disallowed":
            detail = f"disallowed by {rule!r}" if rule else "disallowed"
        else:
            detail = f"robots.txt unreachable (HTTP {status})" if status else "robots.txt unreachable"
        super().__init__(f"{code}: {detail}")

    def details(self) -> dict[str, object]:
        return {"robots_url": self.robots_url, "rule": self.rule, "robots_status": self.status}


@dataclass(frozen=True)
class RobotsFetch:
    """What reading one robots.txt returned: a status and body, or no status when it could not be reached."""

    status: int | None
    body: bytes = b""


RobotsFetcher = Callable[[str], RobotsFetch]

_PERCENT_ESCAPE = re.compile(r"%([0-9a-fA-F]{2})")
_RECORD = re.compile(r"^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$")


def _normalize(path: str) -> str:
    """Percent-encode non-ASCII characters as UTF-8 and upper-case existing escapes (RFC 9309, section 2.2.2).

    Escapes are never decoded: `/%62az` and `/baz` are different paths to robots.txt.
    """
    encoded = "".join(character if ord(character) < 128 else quote(character, safe="") for character in path)
    return _PERCENT_ESCAPE.sub(lambda match: f"%{match.group(1).upper()}", encoded)


def match_target(url: str) -> str:
    """The part of a URL robots.txt rules are matched against: its path and query."""
    parts = urlsplit(url)
    target = parts.path or "/"
    if parts.query:
        target = f"{target}?{parts.query}"
    return _normalize(target)


@lru_cache(maxsize=4_096)
def _pattern(pattern: str) -> re.Pattern[str]:
    anchored = pattern.endswith("$")
    body = pattern[:-1] if anchored else pattern
    expression = ".*".join(re.escape(part) for part in body.split("*"))
    return re.compile(expression + (r"\Z" if anchored else ""), re.DOTALL)


@dataclass(frozen=True)
class RobotsRule:
    allow: bool
    pattern: str

    @property
    def specificity(self) -> int:
        return len(self.pattern.encode())

    def matches(self, target: str) -> bool:
        return _pattern(self.pattern).match(target) is not None

    def __str__(self) -> str:
        return f"{'Allow' if self.allow else 'Disallow'}: {self.pattern}"


def _agent_token(value: str) -> str:
    """`1stSeenEvidenceBot/0.2 (+...)` names the product token `1stseenevidencebot`."""
    return re.split(r"[/\s]", value.strip(), maxsplit=1)[0].casefold()


def parse_groups(text: str) -> list[tuple[tuple[str, ...], tuple[RobotsRule, ...]]]:
    """Groups of (user agents, rules) in file order.

    A group is one or more `User-agent` lines and the rules after them. A `User-agent` line that follows a rule starts a
    new group; any other record (Sitemap, Crawl-delay) neither ends a group nor belongs to one. Rules before the first
    `User-agent` line belong to no group and are ignored.
    """
    groups: list[tuple[tuple[str, ...], tuple[RobotsRule, ...]]] = []
    agents: list[str] = []
    rules: list[RobotsRule] = []
    seen_rule = False
    for raw in text.removeprefix("\ufeff").splitlines():
        match = _RECORD.match(raw.split("#", 1)[0])
        if not match:
            continue
        key, value = match.group(1).casefold(), match.group(2)
        if key == "user-agent":
            if seen_rule:
                groups.append((tuple(agents), tuple(rules)))
                agents, rules, seen_rule = [], [], False
            agents.append(value)
        elif key in {"allow", "disallow"} and agents:
            seen_rule = True
            if value:
                rules.append(RobotsRule(allow=key == "allow", pattern=_normalize(value)))
    if agents:
        groups.append((tuple(agents), tuple(rules)))
    return groups


@dataclass(frozen=True)
class RobotsPolicy:
    """What one origin's robots.txt allows this collector."""

    rules: tuple[RobotsRule, ...] = ()
    unreachable: bool = False
    status: int | None = None

    @classmethod
    def parse(cls, text: str, *, token: str = ROBOTS_PRODUCT_TOKEN, status: int | None = 200) -> RobotsPolicy:
        groups = parse_groups(text)
        named = [rules for agents, rules in groups if any(_agent_token(agent) == token.casefold() for agent in agents)]
        chosen = named or [rules for agents, rules in groups if any(agent.strip() == "*" for agent in agents)]
        return cls(rules=tuple(rule for rules in chosen for rule in rules), status=status)

    @classmethod
    def from_fetch(cls, fetched: RobotsFetch, *, token: str = ROBOTS_PRODUCT_TOKEN) -> RobotsPolicy:
        status = fetched.status
        if status is None or status >= 500 or status == 429:
            return cls(unreachable=True, status=status)
        if 200 <= status < 300:
            return cls.parse(fetched.body[:ROBOTS_MAX_BYTES].decode("utf-8", errors="replace"), token=token, status=status)
        # Any other 4xx, or a redirect chain left unresolved: robots.txt is unavailable, so nothing is disallowed.
        return cls(status=status)

    def decide(self, url: str) -> tuple[bool, RobotsRule | None]:
        """Whether `url` is allowed, and the rule that decided it (None when no rule matched)."""
        if self.unreachable:
            return False, None
        target = match_target(url)
        if target == "/robots.txt":
            return True, None
        best: RobotsRule | None = None
        for rule in self.rules:
            if not rule.matches(target):
                continue
            if (
                best is None
                or rule.specificity > best.specificity
                or (rule.specificity == best.specificity and rule.allow and not best.allow)
            ):
                best = rule
        return best is None or best.allow, best


def robots_url(url: str) -> str:
    parts = urlsplit(url)
    return f"{parts.scheme.casefold()}://{parts.netloc.casefold()}/robots.txt"


class RobotsGate:
    """Reads each origin's robots.txt once and refuses the URLs it does not allow."""

    def __init__(self, fetch: RobotsFetcher, *, token: str = ROBOTS_PRODUCT_TOKEN) -> None:
        self._fetch = fetch
        self.token = token
        self._policies: dict[str, RobotsPolicy] = {}
        self._lock = Lock()

    def policy(self, url: str) -> RobotsPolicy:
        key = robots_url(url)
        with self._lock:
            cached = self._policies.get(key)
        if cached is not None:
            return cached
        policy = RobotsPolicy.from_fetch(self._fetch(key), token=self.token)
        with self._lock:
            return self._policies.setdefault(key, policy)

    def check(self, url: str) -> None:
        """Return when `url` may be fetched; raise `RobotsDisallowedError` before any request when it may not."""
        if match_target(url) == "/robots.txt":
            return
        policy = self.policy(url)
        allowed, rule = policy.decide(url)
        if allowed:
            return
        if policy.unreachable:
            raise RobotsDisallowedError(url, code="robots_unreachable", robots_url=robots_url(url), status=policy.status)
        raise RobotsDisallowedError(
            url, code="robots_disallowed", robots_url=robots_url(url), rule=str(rule) if rule else None
        )
