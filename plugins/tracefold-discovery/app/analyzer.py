from __future__ import annotations

import json
import re
from copy import deepcopy
from typing import Any
from urllib.parse import parse_qsl, urljoin, urlparse, urlunparse


SENSITIVE_KEYS = re.compile(r"token|password|passwd|secret|authorization|cookie|api[-_]?key|session", re.I)
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$", re.I)
HEX_RE = re.compile(r"^[0-9a-f]{20,}$", re.I)
OPAQUE_ID_RE = re.compile(r"^[A-Z]{2,}[A-Z0-9_-]*\d[A-Z0-9_-]{4,}$")
MIXED_ID_RE = re.compile(r"^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9_-]{10,}$")
ULID_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")
NUMBER_RE = re.compile(r"^\d+$")


def strip_fragment(url: str) -> str:
    parsed = urlparse(url)
    return urlunparse((parsed.scheme, parsed.netloc, parsed.path or "/", parsed.params, parsed.query, ""))


def normalize_page_url(url: str) -> str:
    parsed = urlparse(strip_fragment(url))
    path = parsed.path or "/"
    if path != "/":
        path = path.rstrip("/")
    return urlunparse((parsed.scheme.lower(), parsed.netloc.lower(), path, "", parsed.query, ""))


def in_scope(url: str, target_url: str, include_subdomains: bool = False) -> bool:
    candidate = urlparse(url)
    target = urlparse(target_url)
    if candidate.scheme not in {"http", "https"}:
        return False
    candidate_host = (candidate.hostname or "").lower()
    target_host = (target.hostname or "").lower()
    same_host = candidate_host == target_host
    subdomain = include_subdomains and candidate_host.endswith("." + target_host)
    return candidate.scheme == target.scheme and (same_host or subdomain)


def normalize_path(path: str, custom_patterns: list[str] | None = None) -> str:
    pieces: list[str] = []
    patterns: list[re.Pattern[str]] = []
    for pattern in custom_patterns or []:
        try:
            patterns.append(re.compile(pattern))
        except re.error:
            continue
    for part in path.split("/"):
        if not part:
            continue
        if UUID_RE.match(part):
            pieces.append("{uuid}")
        elif ULID_RE.match(part):
            pieces.append("{ulid}")
        elif NUMBER_RE.match(part):
            pieces.append("{id}")
        elif HEX_RE.match(part):
            pieces.append("{id}")
        elif any(pattern.fullmatch(part) for pattern in patterns):
            pieces.append("{id}")
        elif OPAQUE_ID_RE.match(part) or MIXED_ID_RE.match(part):
            pieces.append("{id}")
        else:
            pieces.append(part)
    return "/" + "/".join(pieces)


def normalize_query_for_crawl(query: str, normalize_values: bool = True) -> str:
    if not query:
        return ""
    pairs = parse_qsl(query, keep_blank_values=True)
    if normalize_values:
        return "&".join(f"{key}={{value}}" for key, _ in sorted(pairs))
    return "&".join(f"{key}={value}" for key, value in sorted(pairs))


def crawl_route_key(url: str, custom_patterns: list[str] | None = None, normalize_query_values: bool = True) -> str:
    parsed = urlparse(url)
    path = normalize_path(parsed.path or "/", custom_patterns)
    query = normalize_query_for_crawl(parsed.query, normalize_query_values)
    return path + (("?" + query) if query else "")


def endpoint_parts(url_or_path: str, base_url: str) -> tuple[str, str, dict[str, list[str]]]:
    absolute = urljoin(base_url, url_or_path)
    parsed = urlparse(absolute)
    path = normalize_path(parsed.path or "/")
    query: dict[str, list[str]] = {}
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        query.setdefault(key, []).append(value)
    return absolute, path, query


def is_api_candidate(url: str, resource_type: str = "", content_type: str = "") -> bool:
    path = urlparse(url).path.lower()
    if resource_type in {"xhr", "fetch"}:
        return True
    if "json" in content_type.lower() or "graphql" in path:
        return True
    return bool(re.search(r"/(api|rest|v\d+)(/|$)", path))


def redact(value: Any, key: str = "", depth: int = 0) -> Any:
    if depth > 8:
        return "[max depth]"
    if key and SENSITIVE_KEYS.search(key):
        return "[redacted]"
    if isinstance(value, dict):
        return {str(k): redact(v, str(k), depth + 1) for k, v in list(value.items())[:100]}
    if isinstance(value, list):
        return [redact(v, "", depth + 1) for v in value[:50]]
    if isinstance(value, str) and len(value) > 2000:
        return value[:2000] + "…"
    return value


def parse_body(raw: str | bytes | None, content_type: str = "") -> Any:
    if raw is None or raw == "":
        return None
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8", errors="replace")
    if "json" in content_type.lower() or raw.lstrip().startswith(("{", "[")):
        try:
            return redact(json.loads(raw))
        except (json.JSONDecodeError, TypeError):
            pass
    return raw[:4000] + ("…" if len(raw) > 4000 else "")


def value_schema(value: Any) -> dict[str, Any]:
    if value is None:
        return {"type": "null"}
    if isinstance(value, bool):
        return {"type": "boolean", "example": value}
    if isinstance(value, int):
        return {"type": "integer", "example": value}
    if isinstance(value, float):
        return {"type": "number", "example": value}
    if isinstance(value, str):
        return {"type": "string", "example": value[:160]}
    if isinstance(value, list):
        schemas = [value_schema(item) for item in value[:20]]
        merged = merge_schemas(schemas) if schemas else {}
        return {"type": "array", "items": merged}
    if isinstance(value, dict):
        return {
            "type": "object",
            "properties": {str(key): value_schema(item) for key, item in value.items()},
            "observed_fields": list(value.keys()),
        }
    return {"type": type(value).__name__}


def merge_schema_pair(left: dict[str, Any], right: dict[str, Any]) -> dict[str, Any]:
    if not left:
        return deepcopy(right)
    if not right:
        return deepcopy(left)
    if left.get("type") != right.get("type"):
        types = set(left.get("anyOf", [])) | set(right.get("anyOf", []))
        if left.get("type"):
            types.add(left["type"])
        if right.get("type"):
            types.add(right["type"])
        return {"type": "mixed", "anyOf": sorted(types)}
    result = deepcopy(left)
    if left.get("type") == "object":
        result.setdefault("properties", {})
        for key, schema in right.get("properties", {}).items():
            result["properties"][key] = merge_schema_pair(result["properties"].get(key, {}), schema)
        left_fields = set(left.get("observed_fields", []))
        right_fields = set(right.get("observed_fields", []))
        result["observed_fields"] = sorted(left_fields | right_fields)
        result["always_observed"] = sorted(
            set(left.get("always_observed", left_fields)) & set(right.get("always_observed", right_fields))
        )
    elif left.get("type") == "array":
        result["items"] = merge_schema_pair(left.get("items", {}), right.get("items", {}))
    return result


def merge_schemas(schemas: list[dict[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for schema in schemas:
        result = merge_schema_pair(result, schema)
    return result


def template_to_path(raw: str) -> str:
    raw = re.sub(r"\$\{[^}]+}", "{param}", raw)
    raw = re.sub(r"\{\{[^}]+}}", "{param}", raw)
    return raw.replace("\\/", "/")


def _line_number(source: str, offset: int) -> int:
    return source.count("\n", 0, offset) + 1


def _payload_fields(fragment: str) -> list[str]:
    body_match = re.search(r"(?:body|data)\s*:\s*(?:JSON\.stringify\s*\()?\s*\{([^{}]{0,2000})}", fragment, re.S)
    if not body_match:
        return []
    fields = re.findall(r"(?:^|[,\s])(?:['\"])?([A-Za-z_$][\w$-]*)(?:['\"])?\s*:", body_match.group(1))
    return sorted(set(fields))


def scan_javascript(source: str, source_url: str, base_url: str) -> list[dict[str, Any]]:
    findings: list[dict[str, Any]] = []
    seen: set[tuple[str, str, int]] = set()

    patterns = [
        (re.compile(r"fetch\s*\(\s*([`'\"])(?P<url>.+?)\1(?P<opts>\s*,\s*\{.{0,2500}?})?\s*\)", re.S), "FETCH"),
        (re.compile(r"axios\s*\.\s*(?P<method>get|post|put|patch|delete|head|options)\s*\(\s*([`'\"])(?P<url>.+?)\2", re.I | re.S), "AXIOS"),
        (re.compile(r"\.\s*(?P<method>get|post|put|patch|delete|head|options)\s*\(\s*([`'\"])(?P<url>/(?:api|rest|v\d+)/.+?)\2", re.I | re.S), "CLIENT"),
        (re.compile(r"\.open\s*\(\s*['\"](?P<method>GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)['\"]\s*,\s*([`'\"])(?P<url>.+?)\2", re.I | re.S), "XHR"),
    ]
    for pattern, kind in patterns:
        for match in pattern.finditer(source):
            raw_url = template_to_path(match.group("url"))
            if not (raw_url.startswith(("/", "http://", "https://")) or "/api/" in raw_url):
                continue
            method = (match.groupdict().get("method") or "").upper()
            fragment = source[match.start(): min(len(source), match.end() + 1800)]
            if kind == "FETCH":
                method_match = re.search(r"method\s*:\s*['\"]([A-Z]+)['\"]", fragment, re.I)
                method = method_match.group(1).upper() if method_match else "GET"
            line = _line_number(source, match.start())
            key = (method, raw_url, line)
            if key in seen:
                continue
            seen.add(key)
            findings.append({
                "method": method,
                "url": urljoin(base_url, raw_url),
                "raw_url": raw_url,
                "source_url": source_url,
                "line": line,
                "kind": kind.lower(),
                "payload_fields": _payload_fields(fragment),
            })

    quoted_urls = re.compile(r"([`'\"])(?P<url>/(?:api|rest|v\d+)/[^`'\"\s]{1,300})\1", re.I)
    for match in quoted_urls.finditer(source):
        raw_url = template_to_path(match.group("url"))
        line = _line_number(source, match.start())
        key = ("UNKNOWN", raw_url, line)
        if key not in seen:
            seen.add(key)
            findings.append({
                "method": "UNKNOWN",
                "url": urljoin(base_url, raw_url),
                "raw_url": raw_url,
                "source_url": source_url,
                "line": line,
                "kind": "string reference",
                "payload_fields": [],
            })
    return findings


def schema_placeholder(schema: dict[str, Any]) -> Any:
    schema_type = schema.get("type")
    if schema_type == "object":
        return {key: schema_placeholder(value) for key, value in schema.get("properties", {}).items()}
    if schema_type == "array":
        return [schema_placeholder(schema.get("items", {}))]
    if "example" in schema and schema["example"] != "[redacted]":
        return schema["example"]
    return {"string": "test", "integer": 1, "number": 1.0, "boolean": True, "null": None}.get(schema_type)
