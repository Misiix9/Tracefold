from __future__ import annotations

import asyncio
import hashlib
import json
import re
from collections import deque
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urljoin, urlparse, urlunparse

import httpx
from playwright.async_api import BrowserContext, Page, Request, Response, async_playwright

from .analyzer import (
    endpoint_parts,
    in_scope,
    is_api_candidate,
    normalize_page_url,
    crawl_route_key,
    parse_body,
    redact,
    scan_javascript,
    schema_placeholder,
    value_schema,
)
from .models import ScanConfig


SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
MUTATING_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
ALL_METHODS = SAFE_METHODS | MUTATING_METHODS
OPENAPI_LOCATIONS = (
    "/openapi.json",
    "/swagger.json",
    "/api-docs",
    "/v3/api-docs",
    "/swagger/v1/swagger.json",
)


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class EndpointIndex:
    def __init__(self, base_url: str, bearer_supplied: bool) -> None:
        self.base_url = base_url
        self.bearer_supplied = bearer_supplied
        self.records: dict[tuple[str, str, str], dict[str, Any]] = {}

    def _record(self, method: str, url: str) -> dict[str, Any]:
        absolute, path, query = endpoint_parts(url, self.base_url)
        parsed = urlparse(absolute)
        origin = f"{parsed.scheme}://{parsed.netloc}"
        method = method.upper()
        key = (method, origin, path)
        if key not in self.records:
            digest = hashlib.sha1("|".join(key).encode()).hexdigest()[:12]
            self.records[key] = {
                "id": digest,
                "method": method,
                "origin": origin,
                "path": path,
                "concrete_urls": [],
                "discovered_by": [],
                "called_from": [],
                "query_parameters": {},
                "request": {
                    "has_body": False,
                    "content_types": [],
                    "schema": {},
                    "observed_samples": [],
                    "static_payload_fields": [],
                },
                "responses": [],
                "status_codes": [],
                "authentication": "Bearer supplied" if self.bearer_supplied else "Not observed",
                "openapi": None,
                "probes": [],
            }
        record = self.records[key]
        if "{" not in absolute and absolute not in record["concrete_urls"]:
            record["concrete_urls"].append(absolute)
        for name, values in query.items():
            existing = record["query_parameters"].setdefault(name, [])
            for value in values:
                if value not in existing and len(existing) < 10:
                    existing.append(value)
        return record

    def add_runtime_request(self, request: Request, page_url: str) -> None:
        headers = request.headers
        content_type = headers.get("content-type", "")
        if not is_api_candidate(request.url, request.resource_type, content_type):
            return
        record = self._record(request.method, request.url)
        self._append_unique(record["discovered_by"], "runtime")
        self._add_called_from(record, {"page": page_url, "kind": "runtime request"})
        if content_type:
            self._append_unique(record["request"]["content_types"], content_type.split(";")[0])
        body = parse_body(request.post_data, content_type)
        if body is not None:
            record["request"]["has_body"] = True
            samples = record["request"]["observed_samples"]
            if body not in samples and len(samples) < 5:
                samples.append(body)
            record["request"]["schema"] = self._merge_schema(record["request"]["schema"], value_schema(body))

    async def add_runtime_response(self, response: Response, page_url: str) -> None:
        request = response.request
        content_type = response.headers.get("content-type", "")
        if not is_api_candidate(request.url, request.resource_type, content_type):
            return
        record = self._record(request.method, request.url)
        if response.status not in record["status_codes"]:
            record["status_codes"].append(response.status)
        if response.status in {401, 403}:
            record["authentication"] = "Required or access denied"
        if len(record["responses"]) >= 5:
            return
        sample: dict[str, Any] = {
            "status": response.status,
            "content_type": content_type.split(";")[0],
        }
        if "json" in content_type.lower():
            try:
                raw = await response.body()
                if len(raw) <= 1_000_000:
                    sample["body"] = parse_body(raw, content_type)
                else:
                    sample["body"] = "[response larger than 1 MB]"
            except Exception:
                sample["body"] = "[body unavailable]"
        record["responses"].append(sample)

    def add_static(self, finding: dict[str, Any], page_url: str | None = None) -> None:
        record = self._record(finding["method"], finding["url"])
        self._append_unique(record["discovered_by"], "javascript")
        called_from = {
            "page": page_url,
            "source": finding["source_url"],
            "line": finding["line"],
            "kind": finding["kind"],
        }
        self._add_called_from(record, called_from)
        fields = record["request"]["static_payload_fields"]
        for field in finding.get("payload_fields", []):
            self._append_unique(fields, field)
        if fields and finding["method"] in MUTATING_METHODS:
            record["request"]["has_body"] = True

    def add_openapi(self, url: str, method: str, operation: dict[str, Any], document_url: str) -> None:
        record = self._record(method, url)
        self._append_unique(record["discovered_by"], "openapi")
        request_body = operation.get("requestBody", {})
        content = request_body.get("content", {}) if isinstance(request_body, dict) else {}
        schemas: list[dict[str, Any]] = []
        for content_type, definition in content.items():
            self._append_unique(record["request"]["content_types"], content_type)
            if isinstance(definition, dict) and isinstance(definition.get("schema"), dict):
                schemas.append(definition["schema"])
        if content:
            record["request"]["has_body"] = True
        if schemas:
            record["request"]["schema"] = schemas[0]
        record["openapi"] = {
            "document": document_url,
            "summary": operation.get("summary") or operation.get("operationId"),
            "request_body_required": bool(request_body.get("required")) if isinstance(request_body, dict) else False,
            "parameters": redact(operation.get("parameters", [])),
        }

    def add_probe(self, method: str, url: str, probe: dict[str, Any]) -> None:
        record = self._record(method, url)
        self._append_unique(record["discovered_by"], "probe")
        record["probes"].append(probe)
        status = probe.get("status")
        if isinstance(status, int) and status not in record["status_codes"]:
            record["status_codes"].append(status)

    def values(self) -> list[dict[str, Any]]:
        order = {name: index for index, name in enumerate(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "UNKNOWN"])}
        return sorted(self.records.values(), key=lambda item: (item["path"], order.get(item["method"], 99)))

    @staticmethod
    def _append_unique(target: list[Any], value: Any) -> None:
        if value not in target:
            target.append(value)

    @staticmethod
    def _add_called_from(record: dict[str, Any], item: dict[str, Any]) -> None:
        if item not in record["called_from"] and len(record["called_from"]) < 100:
            record["called_from"].append(item)

    @staticmethod
    def _merge_schema(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
        from .analyzer import merge_schema_pair

        return merge_schema_pair(left, right)


class SiteScanner:
    def __init__(
        self,
        config: ScanConfig,
        on_progress: Callable[[str, int, int, int], None] | None = None,
        is_cancelled: Callable[[], bool] | None = None,
        auth_context: dict[str, Any] | None = None,
    ) -> None:
        self.config = config
        self.target_url = normalize_page_url(str(config.target_url))
        parsed = urlparse(self.target_url)
        self.origin = f"{parsed.scheme}://{parsed.netloc}"
        self.index = EndpointIndex(self.target_url, bool(config.bearer_token))
        self.on_progress = on_progress or (lambda *_: None)
        self.is_cancelled = is_cancelled or (lambda: False)
        self.pages: list[dict[str, Any]] = []
        self.assets: list[dict[str, Any]] = []
        self.warnings: list[str] = []
        self.errors: list[str] = []
        self.response_tasks: set[asyncio.Task[Any]] = set()
        self.started_at = utcnow()
        self.auth_context = auth_context or {}
        self.route_skip_counts: dict[str, int] = {}
        self.route_representatives: dict[str, str] = {}

    async def run(self) -> dict[str, Any]:
        self.on_progress("Starting Chromium", 3, 0, 0)
        async with async_playwright() as playwright:
            browser = await playwright.chromium.launch(headless=True)
            context_options: dict[str, Any] = {"ignore_https_errors": self.config.ignore_https_errors}
            if self.auth_context.get("storage_state"):
                context_options["storage_state"] = self.auth_context["storage_state"]
            context = await browser.new_context(**context_options)
            await self._restore_session_storage(context)
            await self._install_auth_route(context)
            page = await context.new_page()
            current_page = {"url": self.target_url}

            def request_handler(request: Request) -> None:
                self.index.add_runtime_request(request, current_page["url"])

            def response_handler(response: Response) -> None:
                task = asyncio.create_task(self.index.add_runtime_response(response, current_page["url"]))
                self.response_tasks.add(task)
                task.add_done_callback(self.response_tasks.discard)

            page.on("request", request_handler)
            page.on("response", response_handler)
            try:
                await self._crawl(page, current_page)
                if self.response_tasks:
                    await asyncio.gather(*list(self.response_tasks), return_exceptions=True)
                if self.config.discover_openapi and not self.is_cancelled():
                    await self._discover_openapi(context)
                if self.config.safe_probing and not self.is_cancelled():
                    await self._probe_endpoints()
            finally:
                await context.close()
                await browser.close()

        return self._result()

    async def _install_auth_route(self, context: BrowserContext) -> None:
        async def route_handler(route: Any, request: Request) -> None:
            headers = dict(request.headers)
            if self._auth_allowed(request.url):
                if self.config.bearer_token:
                    headers["authorization"] = f"Bearer {self.config.bearer_token}"
                headers.update(self.config.extra_headers)
            await route.continue_(headers=headers)

        await context.route("**/*", route_handler)

    async def _restore_session_storage(self, context: BrowserContext) -> None:
        values = self.auth_context.get("session_storage", {})
        if not values:
            return
        encoded = json.dumps(values).replace("</", "<\\/")
        script = f"""(() => {{
          const all = {encoded};
          const current = all[location.origin] || {{}};
          for (const [key, value] of Object.entries(current)) sessionStorage.setItem(key, value);
        }})()"""
        await context.add_init_script(script=script)

    def _auth_allowed(self, url: str) -> bool:
        if in_scope(url, self.target_url, self.config.include_subdomains):
            return True
        parsed = urlparse(url)
        for allowed in self.auth_context.get("allowed_origins", []):
            origin = urlparse(str(allowed))
            if parsed.scheme == origin.scheme and parsed.netloc.lower() == origin.netloc.lower():
                return True
        return False

    async def _crawl(self, page: Page, current_page: dict[str, str]) -> None:
        queue: deque[tuple[str, int]] = deque([(self.target_url, 0)])
        queued = {self.target_url}
        queued_routes: dict[str, int] = {self._route_key(self.target_url): 1}
        visited: set[str] = set()
        scanned_scripts: set[str] = set()

        while queue and len(visited) < self.config.max_pages and not self.is_cancelled():
            url, depth = queue.popleft()
            normalized = normalize_page_url(url)
            if normalized in visited:
                continue
            route_key = self._route_key(normalized)
            self.route_representatives.setdefault(route_key, normalized)
            visited.add(normalized)
            current_page["url"] = normalized
            percent = min(70, 5 + int(65 * len(visited) / self.config.max_pages))
            self.on_progress(f"Crawling {urlparse(normalized).path or '/'}", percent, len(visited), len(self.index.records))
            page_result: dict[str, Any] = {"url": normalized, "depth": depth, "status": None, "title": None, "error": None}
            try:
                response = await page.goto(normalized, wait_until="domcontentloaded", timeout=self.config.navigation_timeout_ms)
                page_result["status"] = response.status if response else None
                try:
                    await page.wait_for_load_state("networkidle", timeout=min(5000, self.config.navigation_timeout_ms))
                except Exception:
                    pass
                page_result["title"] = (await page.title())[:300]
                final_url = normalize_page_url(page.url)
                current_page["url"] = final_url
                links = await page.eval_on_selector_all(
                    "a[href], area[href]",
                    "els => els.map(el => el.href).filter(Boolean)",
                )
                if depth < self.config.max_depth:
                    for link in links:
                        clean = normalize_page_url(link)
                        if not self._is_crawlable(clean) or clean in visited or clean in queued:
                            continue
                        route_key = self._route_key(clean)
                        if queued_routes.get(route_key, 0) >= self.config.max_route_variants:
                            self.route_skip_counts[route_key] = self.route_skip_counts.get(route_key, 0) + 1
                            continue
                        queue.append((clean, depth + 1))
                        queued.add(clean)
                        queued_routes[route_key] = queued_routes.get(route_key, 0) + 1

                scripts = await page.eval_on_selector_all(
                    "script",
                    "els => els.map(el => ({src: el.src || '', text: el.src ? '' : (el.textContent || '')}))",
                )
                for script in scripts:
                    if script["src"]:
                        script_url = urljoin(final_url, script["src"])
                        if script_url not in scanned_scripts:
                            scanned_scripts.add(script_url)
                            await self._scan_script_url(script_url, final_url)
                    elif script["text"]:
                        self._scan_script_text(script["text"], f"{final_url}#inline-script", final_url)
            except Exception as exc:
                page_result["error"] = self._clean_error(exc)
                self.errors.append(f"{normalized}: {page_result['error']}")
            self.pages.append(page_result)
            if self.config.request_delay_ms:
                await asyncio.sleep(self.config.request_delay_ms / 1000)

        if self.is_cancelled():
            self.warnings.append("Scan cancelled before the crawl completed.")
        elif queue:
            self.warnings.append(f"Stopped after the configured {self.config.max_pages} page limit.")
        if self.route_skip_counts:
            total = sum(self.route_skip_counts.values())
            self.warnings.append(f"Skipped {total} URL variants because their normalized route already reached its crawl budget.")

    def _route_key(self, url: str) -> str:
        return crawl_route_key(
            url,
            self.config.custom_id_patterns if self.config.normalize_dynamic_ids else [],
            self.config.normalize_query_values,
        )

    def _is_crawlable(self, url: str) -> bool:
        if not in_scope(url, self.target_url, self.config.include_subdomains):
            return False
        path = urlparse(url).path.lower()
        blocked = (".pdf", ".zip", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".mp4", ".mp3", ".woff", ".woff2")
        if path.endswith(blocked):
            return False
        for pattern in self.config.ignore_path_patterns:
            try:
                if re.search(pattern, path, re.I):
                    return False
            except re.error:
                self.warnings.append(f"Invalid ignore path pattern: {pattern}")
        return True

    async def _scan_script_url(self, script_url: str, page_url: str) -> None:
        headers = self._http_headers(script_url)
        try:
            async with httpx.AsyncClient(verify=not self.config.ignore_https_errors, follow_redirects=True, timeout=20) as client:
                response = await client.get(script_url, headers=headers)
            content_type = response.headers.get("content-type", "")
            if response.status_code >= 400 or len(response.content) > 8_000_000:
                return
            if "javascript" not in content_type.lower() and not urlparse(script_url).path.endswith((".js", ".mjs")):
                return
            self._scan_script_text(response.text, script_url, page_url)
            self.assets.append({"url": script_url, "size": len(response.content), "findings": None})
        except Exception as exc:
            self.warnings.append(f"Could not scan script {script_url}: {self._clean_error(exc)}")

    def _scan_script_text(self, source: str, source_url: str, page_url: str) -> None:
        findings = scan_javascript(source, source_url, self.target_url)
        for finding in findings:
            self.index.add_static(finding, page_url)
        if findings:
            for asset in self.assets:
                if asset["url"] == source_url:
                    asset["findings"] = len(findings)

    async def _discover_openapi(self, context: BrowserContext) -> None:
        self.on_progress("Checking OpenAPI and Swagger documents", 76, len(self.pages), len(self.index.records))
        for location in OPENAPI_LOCATIONS:
            if self.is_cancelled():
                return
            url = urljoin(self.origin, location)
            try:
                response = await context.request.get(url, headers=self._http_headers(url), timeout=10000)
                if response.status >= 400:
                    continue
                data = await response.json()
                if not isinstance(data, dict) or not isinstance(data.get("paths"), dict):
                    continue
                self._load_openapi(data, url)
                self.assets.append({"url": url, "size": None, "findings": len(data["paths"]), "type": "openapi"})
                break
            except Exception:
                continue

    def _load_openapi(self, document: dict[str, Any], document_url: str) -> None:
        base = self.origin
        servers = document.get("servers")
        if isinstance(servers, list) and servers and isinstance(servers[0], dict):
            base = urljoin(document_url, servers[0].get("url", self.origin))
        for path, path_item in document.get("paths", {}).items():
            if not isinstance(path_item, dict):
                continue
            for method, operation in path_item.items():
                upper = method.upper()
                if upper in ALL_METHODS and isinstance(operation, dict):
                    resolved = self._resolve_openapi_refs(operation, document)
                    self.index.add_openapi(urljoin(base.rstrip("/") + "/", path.lstrip("/")), upper, resolved, document_url)

    def _resolve_openapi_refs(self, value: Any, document: dict[str, Any], depth: int = 0) -> Any:
        if depth > 12:
            return value
        if isinstance(value, list):
            return [self._resolve_openapi_refs(item, document, depth + 1) for item in value]
        if not isinstance(value, dict):
            return value
        reference = value.get("$ref")
        if isinstance(reference, str) and reference.startswith("#/"):
            target: Any = document
            try:
                for part in reference[2:].split("/"):
                    target = target[part.replace("~1", "/").replace("~0", "~")]
                return self._resolve_openapi_refs(target, document, depth + 1)
            except (KeyError, TypeError):
                return value
        return {key: self._resolve_openapi_refs(item, document, depth + 1) for key, item in value.items()}

    async def _probe_endpoints(self) -> None:
        records = list(self.index.values())
        concrete: list[tuple[dict[str, Any], str]] = []
        for record in records:
            if record["method"] == "UNKNOWN":
                continue
            if record["concrete_urls"]:
                concrete.append((record, record["concrete_urls"][0]))
        if not concrete:
            return
        self.on_progress("Checking discovered endpoints", 82, len(self.pages), len(self.index.records))
        limits = httpx.Limits(max_connections=5, max_keepalive_connections=5)
        async with httpx.AsyncClient(
            verify=not self.config.ignore_https_errors,
            follow_redirects=False,
            timeout=15,
            limits=limits,
        ) as client:
            checked_options: set[str] = set()
            for position, (record, url) in enumerate(concrete):
                if self.is_cancelled():
                    return
                if url not in checked_options:
                    checked_options.add(url)
                    try:
                        options_response = await client.options(url, headers=self._http_headers(url))
                        self.index.add_probe("OPTIONS", url, {
                            "method": "OPTIONS",
                            "status": options_response.status_code,
                            "content_type": options_response.headers.get("content-type", "").split(";")[0],
                            "allow": options_response.headers.get("allow"),
                            "active_mutation": False,
                        })
                    except Exception as exc:
                        self.index.add_probe("OPTIONS", url, {
                            "method": "OPTIONS", "error": self._clean_error(exc), "active_mutation": False,
                        })
                method = record["method"]
                if method not in SAFE_METHODS and not self.config.active_mutation_probing:
                    continue
                if method not in ALL_METHODS:
                    continue
                headers = self._http_headers(url)
                body = None
                if method in MUTATING_METHODS:
                    samples = record["request"]["observed_samples"]
                    body = samples[0] if samples and isinstance(samples[0], (dict, list)) else schema_placeholder(record["request"]["schema"])
                try:
                    kwargs: dict[str, Any] = {"headers": headers}
                    if body is not None:
                        kwargs["json"] = body
                    response = await client.request(method, url, **kwargs)
                    probe = {
                        "method": method,
                        "status": response.status_code,
                        "content_type": response.headers.get("content-type", "").split(";")[0],
                        "allow": response.headers.get("allow"),
                        "location": response.headers.get("location"),
                        "active_mutation": method in MUTATING_METHODS,
                    }
                except Exception as exc:
                    probe = {"method": method, "error": self._clean_error(exc), "active_mutation": method in MUTATING_METHODS}
                self.index.add_probe(method, url, probe)
                percent = 82 + int(15 * (position + 1) / len(concrete))
                self.on_progress("Checking discovered endpoints", percent, len(self.pages), len(self.index.records))
                if self.config.request_delay_ms:
                    await asyncio.sleep(self.config.request_delay_ms / 1000)

    def _http_headers(self, url: str) -> dict[str, str]:
        headers = {"user-agent": "Tracefold-Discovery/1.0", "accept": "application/json, text/plain, */*"}
        if self._auth_allowed(url):
            if self.config.bearer_token:
                headers["authorization"] = f"Bearer {self.config.bearer_token}"
            headers.update(self.config.extra_headers)
        return headers

    def _result(self) -> dict[str, Any]:
        endpoints = self.index.values()
        result = {
            "scan": {
                "target_url": self.target_url,
                "started_at": self.started_at,
                "completed_at": utcnow(),
                "pages_visited": len(self.pages),
                "endpoints_found": len(endpoints),
                "bearer_token_used": bool(self.config.bearer_token),
                "active_mutation_probing": self.config.active_mutation_probing,
                "account_id": self.auth_context.get("account_id"),
                "account_name": self.auth_context.get("account_name"),
                "limits": {
                    "max_pages": self.config.max_pages,
                    "max_depth": self.config.max_depth,
                    "max_route_variants": self.config.max_route_variants,
                    "normalize_dynamic_ids": self.config.normalize_dynamic_ids,
                    "normalize_query_values": self.config.normalize_query_values,
                },
                "route_shapes": {
                    "count": len(self.route_representatives),
                    "skipped_variants": sum(self.route_skip_counts.values()),
                    "representatives": self.route_representatives,
                    "skipped": self.route_skip_counts,
                },
            },
            "pages": self.pages,
            "endpoints": endpoints,
            "assets": self.assets,
            "warnings": self.warnings,
            "errors": self.errors,
        }
        for page in result["pages"]:
            page["route_key"] = self._route_key(page["url"])
            page["route_representative"] = self.route_representatives.get(page["route_key"], page["url"])
        return self._scrub_token(result)

    def _clean_error(self, exc: Exception) -> str:
        text = str(exc).replace("\n", " ").strip()
        text = re.sub(r"Bearer\s+[A-Za-z0-9._~+/-]+", "Bearer [redacted]", text, flags=re.I)
        if self.config.bearer_token:
            text = text.replace(self.config.bearer_token, "[redacted]")
        return text[:500]

    def _scrub_token(self, value: Any) -> Any:
        token = self.config.bearer_token
        if not token:
            return value
        if isinstance(value, dict):
            return {key: self._scrub_token(item) for key, item in value.items()}
        if isinstance(value, list):
            return [self._scrub_token(item) for item in value]
        if isinstance(value, str):
            return value.replace(token, "[redacted]")
        return value
