from app.analyzer import (
    endpoint_parts,
    in_scope,
    merge_schema_pair,
    normalize_path,
    parse_body,
    scan_javascript,
    value_schema,
)


def test_normalizes_common_identifiers() -> None:
    assert normalize_path("/api/tickets/123") == "/api/tickets/{id}"
    assert normalize_path("/api/users/550e8400-e29b-41d4-a716-446655440000") == "/api/users/{uuid}"
    assert normalize_path("/api/usefulLinks") == "/api/usefulLinks"
    assert normalize_path("/api/useful-links") == "/api/useful-links"


def test_scope_keeps_token_on_target() -> None:
    target = "https://uat.example.com"
    assert in_scope("https://uat.example.com/api/a", target)
    assert not in_scope("https://cdn.example.com/file.js", target)
    assert in_scope("https://api.uat.example.com/v1/a", target, include_subdomains=True)
    assert not in_scope("https://evil-uat.example.com/v1/a", target, include_subdomains=True)


def test_extracts_query_parameters() -> None:
    _, path, query = endpoint_parts("/api/tickets/42?includeComments=true&page=2", "https://example.com")
    assert path == "/api/tickets/{id}"
    assert query == {"includeComments": ["true"], "page": ["2"]}


def test_redacts_sensitive_body_fields() -> None:
    body = parse_body('{"name":"Misi","password":"secret","nested":{"accessToken":"abc"}}', "application/json")
    assert body["name"] == "Misi"
    assert body["password"] == "[redacted]"
    assert body["nested"]["accessToken"] == "[redacted]"


def test_merges_observed_json_schemas() -> None:
    first = value_schema({"title": "One", "priority": 1})
    second = value_schema({"title": "Two", "enabled": True})
    merged = merge_schema_pair(first, second)
    assert set(merged["properties"]) == {"title", "priority", "enabled"}
    assert merged["always_observed"] == ["title"]


def test_scans_fetch_and_axios_calls() -> None:
    source = """
      fetch(`/api/tickets/${id}`, {method: 'PATCH', body: JSON.stringify({title: name, priority: 2})});
      axios.get('/api/userSettings');
      client.delete('/api/tickets/42');
    """
    findings = scan_javascript(source, "https://example.com/assets/app.js", "https://example.com")
    keys = {(item["method"], item["raw_url"]) for item in findings}
    assert ("PATCH", "/api/tickets/{param}") in keys
    assert ("GET", "/api/userSettings") in keys
    assert ("DELETE", "/api/tickets/42") in keys
    patch = next(item for item in findings if item["method"] == "PATCH")
    assert patch["payload_fields"] == ["priority", "title"]
