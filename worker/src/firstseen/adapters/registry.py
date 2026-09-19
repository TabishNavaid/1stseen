from __future__ import annotations

from firstseen.providers import CompletionClient

from .base import AdapterName, SourceAdapter
from .feeds import FeedAdapter, SitemapAdapter
from .generic import GenericCareerPageAdapter, LlmJobExtractor, PlaywrightRenderer
from .structured import AshbyAdapter, GreenhouseAdapter, LeverAdapter, SmartRecruitersAdapter
from .wayback import WaybackAdapter


class AdapterRegistry:
    def __init__(self, adapters: list[SourceAdapter] | None = None) -> None:
        registered = adapters or [
            GreenhouseAdapter(),
            LeverAdapter(),
            AshbyAdapter(),
            SmartRecruitersAdapter(),
            GenericCareerPageAdapter(),
            FeedAdapter(),
            SitemapAdapter(),
            WaybackAdapter(),
        ]
        self._adapters: dict[AdapterName, SourceAdapter] = {adapter.name: adapter for adapter in registered}

    def get(self, name: AdapterName) -> SourceAdapter:
        try:
            return self._adapters[name]
        except KeyError as exc:
            raise ValueError(f"No adapter registered for {name}") from exc

    @classmethod
    def with_fallbacks(cls, client: CompletionClient) -> AdapterRegistry:
        generic = GenericCareerPageAdapter(
            browser=PlaywrightRenderer(),
            llm=LlmJobExtractor(client),
        )
        return cls(
            [
                GreenhouseAdapter(),
                LeverAdapter(),
                AshbyAdapter(),
                SmartRecruitersAdapter(),
                generic,
                FeedAdapter(),
                SitemapAdapter(generic),
                WaybackAdapter(generic),
            ]
        )
