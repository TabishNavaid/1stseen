"""Deterministic parsing helpers shared by source adapters."""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from html import unescape
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urljoin


def parse_published_datetime(value: Any) -> datetime | None:
    """Parse a date only when a source explicitly labels it as published/released."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        seconds = float(value) / 1000 if float(value) > 10_000_000_000 else float(value)
        try:
            return datetime.fromtimestamp(seconds, tz=UTC)
        except (OverflowError, OSError, ValueError):
            return None
    text = str(value).strip()
    try:
        parsed = datetime.fromisoformat(text)
        return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)
    except ValueError:
        try:
            parsed = parsedate_to_datetime(text)
            return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)
        except (TypeError, ValueError, OverflowError):
            return None


def strip_html(value: str, *, limit: int = 4_000) -> str:
    text = re.sub(r"<[^>]+>", " ", value)
    return " ".join(unescape(text).split())[:limit]


def location_text(value: Any) -> str | None:
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, dict):
        parts = [
            value.get(key)
            for key in ("addressLocality", "city", "addressRegion", "region", "addressCountry", "country")
        ]
        clean: list[str] = [str(item).strip() for item in parts if item]
        return ", ".join(dict.fromkeys(clean)) or None
    if isinstance(value, list):
        nested = [location_text(item) for item in value]
        return " · ".join(item for item in nested if item) or None
    return None


def iter_json_nodes(value: Any) -> Iterator[dict[str, Any]]:
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from iter_json_nodes(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_json_nodes(child)


class StructuredHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.scripts: list[tuple[str, str]] = []
        self.anchors: list[tuple[str, str]] = []
        self._script_type: str | None = None
        self._script_parts: list[str] = []
        self._anchor_href: str | None = None
        self._anchor_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        if tag.lower() == "script":
            self._script_type = (attributes.get("type") or "").lower()
            self._script_parts = []
        elif tag.lower() == "a" and attributes.get("href"):
            self._anchor_href = attributes["href"]
            self._anchor_parts = []

    def handle_data(self, data: str) -> None:
        if self._script_type is not None:
            self._script_parts.append(data)
        if self._anchor_href is not None:
            self._anchor_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "script" and self._script_type is not None:
            self.scripts.append((self._script_type, "".join(self._script_parts)))
            self._script_type = None
            self._script_parts = []
        elif tag.lower() == "a" and self._anchor_href is not None:
            self.anchors.append((self._anchor_href, " ".join(self._anchor_parts).strip()))
            self._anchor_href = None
            self._anchor_parts = []


def parse_json_scripts(html: str, script_type: str) -> list[Any]:
    parser = StructuredHtmlParser()
    parser.feed(html)
    results: list[Any] = []
    for kind, payload in parser.scripts:
        if kind != script_type:
            continue
        try:
            results.append(json.loads(payload))
        except json.JSONDecodeError:
            continue
    return results


def absolute_url(base_url: str, value: Any) -> str | None:
    if not value:
        return None
    return urljoin(base_url, str(value).strip())
