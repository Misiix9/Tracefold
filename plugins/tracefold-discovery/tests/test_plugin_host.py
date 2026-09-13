"""Behaviour Discovery only has when it runs as a Tracefold plugin.

Covers the three things that break silently otherwise: user data escaping the persistent
plugin directory, the page refusing to be displayed inside Tracefold, and reports that a
hosted plugin cannot download.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import EXPORTS, app, resolve_data_dir, write_export
from tests.test_api import SAMPLE_RESULT


# TrustedHostMiddleware only accepts the loopback names Discovery binds to.
client = TestClient(app, base_url="http://127.0.0.1")


def test_data_directory_follows_the_host_supplied_location(monkeypatch, tmp_path):
    """Plugin data must live outside the installed code, or an update would erase it."""
    supplied = tmp_path / "plugin-data"
    monkeypatch.setenv("TRACEFOLD_DISCOVERY_DATA_DIR", str(supplied))
    assert resolve_data_dir() == supplied.resolve()

    monkeypatch.delenv("TRACEFOLD_DISCOVERY_DATA_DIR")
    monkeypatch.setenv("TRACEFOLD_PLUGIN_DATA_DIR", str(supplied))
    assert resolve_data_dir() == supplied.resolve()

    monkeypatch.delenv("TRACEFOLD_PLUGIN_DATA_DIR")
    standalone = resolve_data_dir()
    assert standalone.name == ".tracefold"


def test_pages_may_be_displayed_inside_tracefold_but_not_elsewhere():
    response = client.get("/")
    assert response.status_code == 200
    policy = response.headers["content-security-policy"]
    # X-Frame-Options cannot express an allowed embedder and would block the host outright.
    assert "x-frame-options" not in {name.lower() for name in response.headers}
    assert "frame-ancestors 'self' tauri://localhost" in policy
    assert "http://tauri.localhost" in policy
    assert "default-src 'self'" in policy
    # A strict policy is the point: no inline scripts, no third-party origins.
    assert "unsafe-inline" not in policy
    assert "*" not in policy.split("frame-ancestors")[0]


def test_health_answers_before_anything_else_is_ready():
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


@pytest.mark.parametrize("format_name", ["json", "csv", "xlsx"])
def test_reports_are_written_to_disk_for_a_hosted_plugin(format_name):
    saved = write_export(SAMPLE_RESULT, format_name, "scan", "tracefold-example.com")
    path = Path(saved["path"])
    try:
        assert path.is_file()
        assert path.parent == EXPORTS
        assert path.suffix == f".{format_name}"
        assert int(saved["bytes"]) == path.stat().st_size > 0
        # No partial file is left behind by the atomic write.
        assert not path.with_name(path.name + ".part").exists()
        if format_name == "json":
            assert json.loads(path.read_text(encoding="utf-8"))["scan"]["target_url"]
    finally:
        path.unlink(missing_ok=True)


def test_report_filenames_cannot_escape_the_exports_directory():
    saved = write_export(SAMPLE_RESULT, "json", "scan", "../../escaped")
    path = Path(saved["path"])
    try:
        assert path.parent == EXPORTS
        assert ".." not in path.name
    finally:
        path.unlink(missing_ok=True)


def test_unknown_export_formats_are_refused():
    with pytest.raises(Exception):
        write_export(SAMPLE_RESULT, "exe", "scan", "report")


def test_reveal_only_accepts_reports_this_plugin_wrote():
    assert client.post("/api/reveal", json={"path": "/etc/passwd"}).status_code == 422
    assert client.post("/api/reveal", json={"path": str(EXPORTS / ".." / ".." / "etc" / "passwd")}).status_code == 422
    assert client.post("/api/reveal", json={"path": ""}).status_code == 422
    # A path inside the exports directory that does not exist is a miss, not a traversal.
    assert client.post("/api/reveal", json={"path": str(EXPORTS / "absent.json")}).status_code == 404


def test_saving_a_report_requires_a_completed_job():
    assert client.post("/api/scans/deadbeef/save/json").status_code == 404
    assert client.post("/api/test-runs/deadbeef/save/json").status_code == 404


def test_credentials_are_scoped_to_the_active_authentication_mode():
    """Changing mode must not leave a credential from the old one being sent."""
    from app.auth import account_auth_context

    stored = {
        "id": "a1",
        "name": "Portal user",
        "base_url": "https://example.com",
        "bearer_token": "typed-token",
        "captured_token": "captured-token",
        "storage_state": {"cookies": []},
        "session_storage": {"https://example.com": {"k": "v"}},
    }

    bearer = account_auth_context({**stored, "auth_mode": "bearer"})
    assert bearer["bearer_token"] == "typed-token"
    # A bearer account authenticates with its token, not a browser session.
    assert bearer["storage_state"] is None
    assert bearer["session_storage"] == {}

    for mode in ("interactive", "form"):
        context = account_auth_context({**stored, "auth_mode": mode})
        # The stale typed token must not be preferred once the mode no longer uses it.
        assert context["bearer_token"] == "captured-token"
        assert context["storage_state"] == {"cookies": []}


def test_interactive_login_verifies_certificates_unless_opted_in():
    from app.models import AccountInput

    account = AccountInput(name="User", base_url="https://example.com")
    assert account.ignore_https_errors is False

    opted_in = AccountInput(name="User", base_url="https://example.com", ignore_https_errors=True)
    assert opted_in.ignore_https_errors is True


def test_changing_authentication_mode_drops_the_previous_secret(tmp_path):
    from app.models import AccountInput
    from app.storage import AccountStore

    store = AccountStore(tmp_path)
    created = store.create(
        AccountInput(
            name="Bearer user",
            base_url="https://example.com",
            auth_mode="bearer",
            bearer_token="secret-token",
        )
    )

    # Editing without retyping the token keeps it while the mode is unchanged.
    store.update(
        created["id"],
        AccountInput(name="Bearer user renamed", base_url="https://example.com", auth_mode="bearer"),
    )
    assert store.get_runtime(created["id"])["bearer_token"] == "secret-token"

    # Switching to interactive must not silently retain it.
    store.update(
        created["id"],
        AccountInput(name="Bearer user renamed", base_url="https://example.com", auth_mode="interactive"),
    )
    assert not store.get_runtime(created["id"]).get("bearer_token")


def test_two_reports_saved_in_the_same_second_do_not_collide():
    first = write_export(SAMPLE_RESULT, "json", "scan", "tracefold-example.com")
    second = write_export(SAMPLE_RESULT, "json", "scan", "tracefold-example.com")
    try:
        assert first["path"] != second["path"]
        assert Path(first["path"]).is_file() and Path(second["path"]).is_file()
    finally:
        Path(first["path"]).unlink(missing_ok=True)
        Path(second["path"]).unlink(missing_ok=True)
