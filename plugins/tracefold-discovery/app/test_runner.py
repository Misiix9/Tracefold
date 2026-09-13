from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urljoin, urlparse

import httpx
from jsonpath_ng.ext import parse as parse_jsonpath

from .analyzer import parse_body, redact
from .auth import account_auth_context
from .models import ScanConfig, TestRunInput
from .scanner import MUTATING_METHODS, SiteScanner
from .storage import AccountStore, TestCaseStore


PLACEHOLDER_RE = re.compile(r"\$\{([A-Za-z_][\w.-]*)}|\{\{([A-Za-z_][\w.-]*)}}")


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class TestRunner:
    def __init__(
        self,
        request: TestRunInput,
        accounts: AccountStore,
        test_cases: TestCaseStore,
        on_progress: Callable[[str, int, int, int], None] | None = None,
        is_cancelled: Callable[[], bool] | None = None,
    ) -> None:
        self.request = request
        self.accounts = accounts
        self.case_store = test_cases
        self.on_progress = on_progress or (lambda *_: None)
        self.is_cancelled = is_cancelled or (lambda: False)
        self.started_at = utcnow()
        self.test_results: list[dict[str, Any]] = []
        self.crawl_runs: list[dict[str, Any]] = []
        self.errors: list[str] = []

    async def run(self) -> dict[str, Any]:
        account_values = [self.accounts.get_runtime(item_id) for item_id in self.request.account_ids]
        cases = self.case_store.selected(self.request.test_case_ids) if self.request.test_case_ids else []
        has_mutation = any(case["method"] in MUTATING_METHODS for case in cases)
        if has_mutation and self.request.authorization_confirmation != "I AM AUTHORIZED":
            raise ValueError('Mutating test cases require the exact confirmation "I AM AUTHORIZED"')
        total_steps = max(1, len(account_values) * (len(cases) + int(self.request.include_crawl)))
        completed_steps = 0
        for account in account_values:
            if self.is_cancelled():
                break
            auth = account_auth_context(account)
            if cases:
                results = await self._run_cases_for_account(auth, cases, completed_steps, total_steps)
                self.test_results.extend(results)
                completed_steps += len(cases)
            if self.request.include_crawl and not self.is_cancelled():
                percent = int(100 * completed_steps / total_steps)
                self.on_progress(f"Full crawl as {account['name']}", percent, completed_steps, len(self.test_results))
                crawl_result = await self._run_crawl(auth)
                self.crawl_runs.append({
                    "account_id": account["id"],
                    "account_name": account["name"],
                    "auth_mode": account["auth_mode"],
                    "result": crawl_result,
                })
                completed_steps += 1
        return self._result(account_values)

    async def _run_cases_for_account(
        self,
        account: dict[str, Any],
        cases: list[dict[str, Any]],
        completed_before: int,
        total_steps: int,
    ) -> list[dict[str, Any]]:
        cookies = self._cookies(account.get("storage_state"))
        limits = httpx.Limits(max_connections=4, max_keepalive_connections=4)
        results: list[dict[str, Any]] = []
        async with httpx.AsyncClient(cookies=cookies, follow_redirects=False, timeout=30, limits=limits) as client:
            for index, case in enumerate(cases):
                if self.is_cancelled():
                    break
                percent = int(100 * (completed_before + index) / total_steps)
                self.on_progress(f"{account['account_name']}: {case['name']}", percent, completed_before + index, len(self.test_results) + len(results))
                results.append(await self._execute_case(client, account, case))
                if self.request.request_delay_ms:
                    await asyncio.sleep(self.request.request_delay_ms / 1000)
        return results

    async def _execute_case(self, client: httpx.AsyncClient, account: dict[str, Any], case: dict[str, Any]) -> dict[str, Any]:
        run_id = uuid.uuid4().hex[:12]
        variables = {
            "accountName": account["account_name"],
            "baseUrl": account["base_url"].rstrip("/"),
            **account.get("variables", {}),
        }
        started = utcnow()
        clock = time.perf_counter()
        method = case["method"]
        expected = case.get("account_expectations", {}).get(account["account_id"], case.get("expected_statuses", []))
        try:
            raw_url = self._resolve(case["url"], variables)
            url = raw_url if raw_url.startswith(("http://", "https://")) else urljoin(account["base_url"].rstrip("/") + "/", raw_url.lstrip("/"))
            request_query = self._resolve(case.get("query", {}), variables)
            request_payload = self._resolve(case.get("payload"), variables)
        except Exception as exc:
            return {
                "id": run_id, "timestamp": started, "test_case_id": case["id"], "test_case_name": case["name"],
                "account_id": account["account_id"], "account_name": account["account_name"], "auth_mode": account["auth_mode"],
                "method": method, "url": case["url"], "endpoint_path": case["url"], "expected_statuses": expected,
                "request_query": {}, "request_payload": None, "notes": case.get("notes", ""), "result": "ERROR",
                "error": self._scrub(str(exc), account), "duration_ms": 0,
            }
        base_result = {
            "id": run_id,
            "timestamp": started,
            "test_case_id": case["id"],
            "test_case_name": case["name"],
            "account_id": account["account_id"],
            "account_name": account["account_name"],
            "auth_mode": account["auth_mode"],
            "method": method,
            "url": url,
            "endpoint_path": urlparse(url).path,
            "expected_statuses": expected,
            "request_query": redact(request_query),
            "request_payload": redact(request_payload),
            "notes": case.get("notes", ""),
        }
        if not self._credential_target_allowed(url, account):
            return {**base_result, "result": "ERROR", "error": "URL is outside this account's allowed origins", "duration_ms": 0}
        headers = {"accept": "application/json, text/plain, */*", **account.get("extra_headers", {})}
        headers.update(self._resolve(case.get("headers", {}), variables))
        if account.get("bearer_token"):
            headers["authorization"] = f"Bearer {account['bearer_token']}"
        kwargs: dict[str, Any] = {"headers": headers, "params": request_query}
        payload = request_payload
        if payload is not None:
            kwargs["json"] = payload
        try:
            response = await client.request(method, url, **kwargs)
            duration = round((time.perf_counter() - clock) * 1000, 1)
            content_type = response.headers.get("content-type", "")
            raw_body = response.text[:100_000]
            body = parse_body(raw_body, content_type)
            status_ok = not expected or response.status_code in expected
            assertions = self._evaluate_assertions(case.get("assertions", []), raw_body, body)
            assertions_ok = all(item["passed"] for item in assertions)
            result = "PASS" if status_ok and assertions_ok and response.status_code != 500 else "FAIL"
            return {
                **base_result,
                "actual_status": response.status_code,
                "result": result,
                "duration_ms": duration,
                "response_content_type": content_type.split(";")[0],
                "response_body": redact(body),
                "response_size_bytes": len(response.content),
                "assertions": assertions,
                "error": "HTTP 500 is never acceptable for this BOLA plan" if response.status_code == 500 else "",
            }
        except Exception as exc:
            return {
                **base_result,
                "result": "ERROR",
                "error": self._scrub(str(exc), account),
                "duration_ms": round((time.perf_counter() - clock) * 1000, 1),
            }

    async def _run_crawl(self, account: dict[str, Any]) -> dict[str, Any]:
        target = str(self.request.crawl_target_url or account["base_url"])
        if not self._credential_target_allowed(target, account):
            raise ValueError(f"Crawl target is outside the allowed origins for {account['account_name']}")
        config = ScanConfig(
            target_url=target,
            bearer_token=account.get("bearer_token", ""),
            max_pages=self.request.max_pages,
            max_depth=self.request.max_depth,
            request_delay_ms=self.request.request_delay_ms,
            navigation_timeout_ms=self.request.navigation_timeout_ms,
            ignore_https_errors=self.request.ignore_https_errors,
            include_subdomains=self.request.include_subdomains,
            discover_openapi=self.request.discover_openapi,
            safe_probing=self.request.safe_probing,
            extra_headers=account.get("extra_headers", {}),
            normalize_dynamic_ids=self.request.normalize_dynamic_ids,
            max_route_variants=self.request.max_route_variants,
            custom_id_patterns=self.request.custom_id_patterns,
            ignore_path_patterns=self.request.ignore_path_patterns,
            normalize_query_values=self.request.normalize_query_values,
        )
        scanner = SiteScanner(
            config,
            on_progress=lambda phase, progress, pages, endpoints: self.on_progress(
                f"{account['account_name']}: {phase}", progress, pages, endpoints
            ),
            is_cancelled=self.is_cancelled,
            auth_context=account,
        )
        return await scanner.run()

    @staticmethod
    def _cookies(storage_state: dict[str, Any] | None) -> httpx.Cookies:
        jar = httpx.Cookies()
        for cookie in (storage_state or {}).get("cookies", []):
            try:
                jar.set(cookie["name"], cookie["value"], domain=cookie.get("domain"), path=cookie.get("path", "/"))
            except Exception:
                continue
        return jar

    @staticmethod
    def _resolve(value: Any, variables: dict[str, Any]) -> Any:
        if isinstance(value, dict):
            return {key: TestRunner._resolve(item, variables) for key, item in value.items()}
        if isinstance(value, list):
            return [TestRunner._resolve(item, variables) for item in value]
        if not isinstance(value, str):
            return value
        full = PLACEHOLDER_RE.fullmatch(value)
        if full:
            key = full.group(1) or full.group(2)
            if key not in variables:
                raise ValueError(f"Missing account variable: {key}")
            return variables[key]
        def replace(match: re.Match[str]) -> str:
            key = match.group(1) or match.group(2)
            if key not in variables:
                raise ValueError(f"Missing account variable: {key}")
            return str(variables[key])
        return PLACEHOLDER_RE.sub(replace, value)

    @staticmethod
    def _credential_target_allowed(url: str, account: dict[str, Any]) -> bool:
        parsed = urlparse(url)
        allowed = [account["base_url"], *account.get("allowed_origins", [])]
        for value in allowed:
            origin = urlparse(str(value))
            if parsed.scheme == origin.scheme and parsed.netloc.lower() == origin.netloc.lower():
                return True
        return False

    @staticmethod
    def _evaluate_assertions(assertions: list[dict[str, Any]], raw: str, body: Any) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        for assertion in assertions:
            kind = assertion["type"]
            path = assertion.get("path", "")
            expected = assertion.get("value")
            try:
                if kind == "contains":
                    actual = str(expected) in raw
                elif kind == "not_contains":
                    actual = str(expected) not in raw
                elif kind == "empty_array":
                    matches = [item.value for item in parse_jsonpath(path or "$").find(body)]
                    actual = bool(matches) and all(isinstance(item, list) and not item for item in matches)
                else:
                    matches = [item.value for item in parse_jsonpath(path).find(body)]
                    if kind == "jsonpath_equals":
                        actual = bool(matches) and any(item == expected for item in matches)
                    elif kind == "jsonpath_not_equals":
                        actual = all(item != expected for item in matches)
                    elif kind == "jsonpath_count":
                        actual = len(matches) == int(expected)
                    else:
                        actual = False
                results.append({"type": kind, "path": path, "expected": expected, "passed": actual})
            except Exception as exc:
                results.append({"type": kind, "path": path, "expected": expected, "passed": False, "error": str(exc)[:300]})
        return results

    def _result(self, accounts: list[dict[str, Any]]) -> dict[str, Any]:
        finished = utcnow()
        passed = sum(1 for item in self.test_results if item["result"] == "PASS")
        failed = sum(1 for item in self.test_results if item["result"] == "FAIL")
        errors = sum(1 for item in self.test_results if item["result"] == "ERROR")
        result = {
            "run": {
                "name": self.request.name,
                "started_at": self.started_at,
                "completed_at": finished,
                "accounts": [{"id": item["id"], "name": item["name"], "auth_mode": item["auth_mode"]} for item in accounts],
                "tests": len(self.test_results),
                "passed": passed,
                "failed": failed,
                "errors": errors,
                "crawl_accounts": len(self.crawl_runs),
            },
            "test_results": self.test_results,
            "crawl_runs": self.crawl_runs,
            "errors": self.errors,
        }
        secrets = []
        for account in accounts:
            secrets.extend([account.get("bearer_token", ""), account.get("captured_token", "")])
        return self._deep_scrub(result, [item for item in secrets if item])

    @classmethod
    def _deep_scrub(cls, value: Any, secrets: list[str]) -> Any:
        if isinstance(value, dict):
            return {key: cls._deep_scrub(item, secrets) for key, item in value.items()}
        if isinstance(value, list):
            return [cls._deep_scrub(item, secrets) for item in value]
        if isinstance(value, str):
            for secret in secrets:
                value = value.replace(secret, "[redacted]")
        return value

    @staticmethod
    def _scrub(value: str, account: dict[str, Any]) -> str:
        token = account.get("bearer_token", "")
        if token:
            value = value.replace(token, "[redacted]")
        return re.sub(r"Bearer\s+\S+", "Bearer [redacted]", value, flags=re.I)[:1000]
