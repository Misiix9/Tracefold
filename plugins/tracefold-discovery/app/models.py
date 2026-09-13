from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, Field, HttpUrl, field_validator, model_validator


class ScanConfig(BaseModel):
    account_id: str | None = Field(default=None, max_length=100)
    target_url: HttpUrl
    bearer_token: str = Field(default="", max_length=16384)
    max_pages: int = Field(default=50, ge=1, le=500)
    max_depth: int = Field(default=5, ge=0, le=20)
    request_delay_ms: int = Field(default=150, ge=0, le=10000)
    navigation_timeout_ms: int = Field(default=20000, ge=2000, le=120000)
    ignore_https_errors: bool = False
    include_subdomains: bool = False
    discover_openapi: bool = True
    safe_probing: bool = True
    active_mutation_probing: bool = False
    authorization_confirmation: str = ""
    extra_headers: dict[str, str] = Field(default_factory=dict)
    normalize_dynamic_ids: bool = True
    max_route_variants: int = Field(default=1, ge=1, le=25)
    custom_id_patterns: list[str] = Field(default_factory=list, max_length=30)
    ignore_path_patterns: list[str] = Field(default_factory=list, max_length=50)
    normalize_query_values: bool = True

    @field_validator("extra_headers")
    @classmethod
    def block_sensitive_header_overrides(cls, value: dict[str, str]) -> dict[str, str]:
        blocked = {"authorization", "cookie", "host", "content-length"}
        if any(key.lower() in blocked for key in value):
            raise ValueError("Authorization, Cookie, Host, and Content-Length cannot be overridden")
        return value

    @model_validator(mode="after")
    def mutation_confirmation(self) -> "ScanConfig":
        if self.active_mutation_probing and self.authorization_confirmation != "I AM AUTHORIZED":
            raise ValueError('Active mutation probing requires the exact confirmation "I AM AUTHORIZED"')
        return self


class ScanJob(BaseModel):
    id: str
    status: Literal["queued", "running", "completed", "failed", "cancelled"] = "queued"
    phase: str = "Queued"
    progress: int = 0
    pages_visited: int = 0
    endpoints_found: int = 0
    started_at: str | None = None
    completed_at: str | None = None
    error: str | None = None
    result: dict[str, Any] | None = None
    cancel_requested: bool = False

    def now(self) -> str:
        return datetime.now(timezone.utc).isoformat()


class AccountInput(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    base_url: HttpUrl
    login_url: HttpUrl | None = None
    auth_mode: Literal["interactive", "bearer", "form"] = "interactive"
    username: str = Field(default="", max_length=500)
    password: str = Field(default="", max_length=4096)
    bearer_token: str = Field(default="", max_length=16384)
    username_selector: str = Field(default='input[type="email"], input[name="username"]', max_length=500)
    password_selector: str = Field(default='input[type="password"]', max_length=500)
    submit_selector: str = Field(default='button[type="submit"]', max_length=500)
    token_storage_key: str = Field(default="", max_length=200)
    extra_headers: dict[str, str] = Field(default_factory=dict)
    allowed_origins: list[HttpUrl] = Field(default_factory=list, max_length=20)
    variables: dict[str, str | int | float | bool] = Field(default_factory=dict)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Account name cannot be empty")
        return value

    @field_validator("extra_headers")
    @classmethod
    def protect_headers(cls, value: dict[str, str]) -> dict[str, str]:
        blocked = {"authorization", "cookie", "host", "content-length"}
        if any(key.lower() in blocked for key in value):
            raise ValueError("Use the account auth fields for Authorization and cookies")
        return value

class TestAssertion(BaseModel):
    type: Literal["contains", "not_contains", "jsonpath_equals", "jsonpath_not_equals", "jsonpath_count", "empty_array"]
    path: str = ""
    value: Any = None


class TestCaseInput(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] = "GET"
    url: str = Field(min_length=1, max_length=4000)
    expected_statuses: list[int] = Field(default_factory=lambda: [200], max_length=20)
    account_expectations: dict[str, list[int]] = Field(default_factory=dict)
    headers: dict[str, str] = Field(default_factory=dict)
    query: dict[str, Any] = Field(default_factory=dict)
    payload: Any = None
    assertions: list[TestAssertion] = Field(default_factory=list, max_length=30)
    notes: str = Field(default="", max_length=4000)
    enabled: bool = True

    @field_validator("expected_statuses")
    @classmethod
    def valid_statuses(cls, value: list[int]) -> list[int]:
        if any(code < 100 or code > 599 for code in value):
            raise ValueError("Expected status codes must be between 100 and 599")
        return sorted(set(value))

    @field_validator("account_expectations")
    @classmethod
    def valid_account_statuses(cls, value: dict[str, list[int]]) -> dict[str, list[int]]:
        for account_id, statuses in value.items():
            if not account_id or any(code < 100 or code > 599 for code in statuses):
                raise ValueError("Per-account status codes must be between 100 and 599")
        return {account_id: sorted(set(statuses)) for account_id, statuses in value.items()}

    @field_validator("headers")
    @classmethod
    def protect_test_headers(cls, value: dict[str, str]) -> dict[str, str]:
        if any(key.lower() in {"authorization", "cookie", "host", "content-length"} for key in value):
            raise ValueError("Authentication headers come from the selected account")
        return value


class TestRunInput(BaseModel):
    name: str = Field(default="Test run", min_length=1, max_length=200)
    account_ids: list[str] = Field(min_length=1, max_length=50)
    test_case_ids: list[str] = Field(default_factory=list, max_length=1000)
    include_crawl: bool = False
    crawl_target_url: HttpUrl | None = None
    max_pages: int = Field(default=50, ge=1, le=500)
    max_depth: int = Field(default=5, ge=0, le=20)
    request_delay_ms: int = Field(default=150, ge=0, le=10000)
    navigation_timeout_ms: int = Field(default=20000, ge=2000, le=120000)
    ignore_https_errors: bool = False
    include_subdomains: bool = False
    discover_openapi: bool = True
    safe_probing: bool = False
    authorization_confirmation: str = ""
    normalize_dynamic_ids: bool = True
    max_route_variants: int = Field(default=1, ge=1, le=25)
    custom_id_patterns: list[str] = Field(default_factory=list, max_length=30)
    ignore_path_patterns: list[str] = Field(default_factory=list, max_length=50)
    normalize_query_values: bool = True

    @model_validator(mode="after")
    def has_work(self) -> "TestRunInput":
        if not self.test_case_ids and not self.include_crawl:
            raise ValueError("Select test cases or enable the full site crawl")
        return self
