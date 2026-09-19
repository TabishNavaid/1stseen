"""Typed runtime configuration shared by scheduled and local worker entrypoints."""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, HttpUrl, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", ".env.local"), extra="ignore")

    environment: str = Field(default="development", alias="FIRSTSEEN_ENV")
    supabase_url: HttpUrl | None = Field(default=None, alias="SUPABASE_URL")
    supabase_service_role_key: str | None = Field(default=None, alias="SUPABASE_SERVICE_ROLE_KEY")
    llm_model: str = Field(default="ollama/qwen2.5:7b", alias="LLM_MODEL")
    llm_api_base: HttpUrl | None = Field(
        default_factory=lambda: HttpUrl("http://localhost:11434"), alias="LLM_API_BASE"
    )
    llm_api_key: str | None = Field(default=None, alias="LLM_API_KEY")
    llm_default_routes: str = Field(default="", alias="LLM_DEFAULT_ROUTES")
    llm_extract_routes: str = Field(default="", alias="LLM_EXTRACT_ROUTES")
    llm_classify_routes: str = Field(default="", alias="LLM_CLASSIFY_ROUTES")
    llm_normalize_routes: str = Field(default="", alias="LLM_NORMALIZE_ROUTES")
    llm_reason_routes: str = Field(default="", alias="LLM_REASON_ROUTES")
    gemini_api_key: str | None = Field(default=None, alias="GEMINI_API_KEY")
    groq_api_key: str | None = Field(default=None, alias="GROQ_API_KEY")
    ollama_api_base: HttpUrl | None = Field(default=None, alias="OLLAMA_API_BASE")
    llm_timeout_seconds: int = Field(default=30, ge=1, le=120, alias="LLM_TIMEOUT_SECONDS")
    http_timeout_seconds: int = Field(default=20, ge=1, le=120, alias="HTTP_TIMEOUT_SECONDS")
    browser_timeout_seconds: int = Field(default=30, ge=5, le=120, alias="BROWSER_TIMEOUT_SECONDS")
    http_min_host_interval_seconds: float = Field(
        default=0.25, ge=0, le=10, alias="HTTP_MIN_HOST_INTERVAL_SECONDS"
    )
    max_source_bytes: int = Field(default=2_000_000, ge=10_000, le=10_000_000, alias="MAX_SOURCE_BYTES")
    # Honour robots.txt before every collector request (robots.py). Off by default, so collection behaves exactly as it
    # did before: robots.txt is never read. The owner turns it on once the measured coverage loss is accepted.
    robots_txt_enforced: bool = Field(default=False, alias="ROBOTS_TXT_ENFORCED")
    reddit_api_enabled: bool = Field(default=False, alias="REDDIT_API_ENABLED")
    reddit_client_id: str | None = Field(default=None, alias="REDDIT_CLIENT_ID")
    reddit_client_secret: str | None = Field(default=None, alias="REDDIT_CLIENT_SECRET")
    reddit_user_agent: str | None = Field(default=None, alias="REDDIT_USER_AGENT")
    reddit_communities: str = Field(default="", alias="REDDIT_COMMUNITIES")
    reddit_search_limit: int = Field(default=25, ge=1, le=100, alias="REDDIT_SEARCH_LIMIT")
    reddit_llm_extraction_enabled: bool = Field(default=False, alias="REDDIT_LLM_EXTRACTION_ENABLED")
    agent_api_bearer_token: str | None = Field(default=None, alias="AGENT_API_BEARER_TOKEN")
    # Optional model-assisted intent understanding for the RecruitingAgent. Off by
    # default so the agent stays fully deterministic without a provider; it can only
    # widen which typed tools a question needs, never produce a forecast value.
    agent_intent_llm_enabled: bool = Field(default=False, alias="AGENT_INTENT_LLM_ENABLED")
    allow_unauthenticated_agent_dev: bool = Field(
        default=False, alias="ALLOW_UNAUTHENTICATED_AGENT_DEV"
    )
    # Per-token ceiling for the agent HTTP surface, counted in one process. The
    # service runs with a small max-instances, so the effective ceiling is this
    # value times the instance count; see docs/deployment.md.
    agent_api_rate_limit_per_minute: int = Field(
        default=60, ge=1, le=10_000, alias="AGENT_API_RATE_LIMIT_PER_MINUTE"
    )

    @model_validator(mode="after")
    def validate_reddit_access(self) -> Settings:
        if self.reddit_api_enabled:
            missing = [
                name
                for name, value in (
                    ("REDDIT_CLIENT_ID", self.reddit_client_id),
                    ("REDDIT_CLIENT_SECRET", self.reddit_client_secret),
                    ("REDDIT_USER_AGENT", self.reddit_user_agent),
                )
                if not value
            ]
            if missing:
                raise ValueError(f"Reddit API collection requires {', '.join(missing)}")
            if not self.reddit_user_agent or "by /u/" not in self.reddit_user_agent:
                raise ValueError("REDDIT_USER_AGENT must be descriptive and include 'by /u/<account>'")
            if not self.reddit_community_allowlist():
                raise ValueError("REDDIT_COMMUNITIES must contain an explicit community allowlist")
        if self.reddit_llm_extraction_enabled and not self.reddit_api_enabled:
            raise ValueError("REDDIT_LLM_EXTRACTION_ENABLED requires REDDIT_API_ENABLED=true")
        if self.environment == "production" and not self.agent_api_bearer_token:
            raise ValueError("AGENT_API_BEARER_TOKEN is required in production")
        if self.environment == "production" and self.allow_unauthenticated_agent_dev:
            raise ValueError("ALLOW_UNAUTHENTICATED_AGENT_DEV cannot be enabled in production")
        return self

    def reddit_community_allowlist(self) -> tuple[str, ...]:
        return tuple(
            community.strip().removeprefix("r/")
            for community in self.reddit_communities.split(",")
            if community.strip()
        )

    def require_supabase(self) -> tuple[str, str]:
        if not self.supabase_url or not self.supabase_service_role_key:
            raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for persisted runs")
        return str(self.supabase_url).rstrip("/"), self.supabase_service_role_key

    def routes_for(self, capability: str) -> tuple[str, ...]:
        configured = {
            "extract": self.llm_extract_routes,
            "classify": self.llm_classify_routes,
            "normalize": self.llm_normalize_routes,
            "reason": self.llm_reason_routes,
        }.get(capability, "")
        raw = configured or self.llm_default_routes or self.llm_model
        return tuple(route.strip() for route in raw.split(",") if route.strip())


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
