from __future__ import annotations

import json
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import keyring
from cryptography.fernet import Fernet, InvalidToken

from .models import AccountInput, TestCaseInput


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


class JsonCollection:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()

    def read(self) -> list[dict[str, Any]]:
        with self.lock:
            if not self.path.exists():
                return []
            try:
                value = json.loads(self.path.read_text(encoding="utf-8"))
                return value if isinstance(value, list) else []
            except (json.JSONDecodeError, OSError):
                return []

    def write(self, values: list[dict[str, Any]]) -> None:
        with self.lock:
            temporary = self.path.with_suffix(self.path.suffix + ".tmp")
            temporary.write_text(json.dumps(values, ensure_ascii=False, indent=2), encoding="utf-8")
            temporary.replace(self.path)


class SecureVault:
    SERVICE = "Tracefold Discovery"
    USERNAME = "local-vault-key"

    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.backend = "OS keychain"
        self._fernet = Fernet(self._load_key())

    def _load_key(self) -> bytes:
        try:
            value = keyring.get_password(self.SERVICE, self.USERNAME)
            if not value:
                value = Fernet.generate_key().decode("ascii")
                keyring.set_password(self.SERVICE, self.USERNAME, value)
            return value.encode("ascii")
        except Exception:
            self.backend = "restricted local key"
            key_path = self.data_dir / ".vault-key"
            if key_path.exists():
                return key_path.read_bytes().strip()
            key = Fernet.generate_key()
            descriptor = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(key)
            return key

    def save(self, item_id: str, value: dict[str, Any]) -> None:
        path = self.data_dir / f"{item_id}.vault"
        encoded = json.dumps(value, ensure_ascii=False).encode("utf-8")
        encrypted = self._fernet.encrypt(encoded)
        path.write_bytes(encrypted)
        try:
            path.chmod(0o600)
        except OSError:
            pass

    def load(self, item_id: str) -> dict[str, Any]:
        path = self.data_dir / f"{item_id}.vault"
        if not path.exists():
            return {}
        try:
            return json.loads(self._fernet.decrypt(path.read_bytes()).decode("utf-8"))
        except (InvalidToken, json.JSONDecodeError, OSError):
            raise ValueError("This account's encrypted session could not be opened on this computer")

    def delete(self, item_id: str) -> None:
        path = self.data_dir / f"{item_id}.vault"
        if path.exists():
            path.unlink()


class AccountStore:
    def __init__(self, data_dir: Path) -> None:
        self.collection = JsonCollection(data_dir / "accounts.json")
        self.vault = SecureVault(data_dir / "account-secrets")

    def list_public(self) -> list[dict[str, Any]]:
        return [self._public(item) for item in self.collection.read()]

    def get_public(self, account_id: str) -> dict[str, Any]:
        return self._public(self._get_metadata(account_id))

    def get_runtime(self, account_id: str) -> dict[str, Any]:
        metadata = self._get_metadata(account_id)
        secret = self.vault.load(account_id)
        return {**metadata, **secret}

    def create(self, value: AccountInput) -> dict[str, Any]:
        self._validate_auth(value.auth_mode, value.username, value.password, value.bearer_token)
        account_id = uuid.uuid4().hex
        now = utcnow()
        metadata = self._metadata(account_id, value, now, now)
        values = self.collection.read()
        values.append(metadata)
        self.collection.write(values)
        self.vault.save(account_id, self._secrets(value))
        return self._public(metadata)

    def update(self, account_id: str, value: AccountInput) -> dict[str, Any]:
        values = self.collection.read()
        existing = next((item for item in values if item.get("id") == account_id), None)
        if not existing:
            raise KeyError(account_id)
        updated = self._metadata(account_id, value, existing["created_at"], utcnow())
        values = [updated if item.get("id") == account_id else item for item in values]
        old_secrets = self.vault.load(account_id)
        new_secrets = self._secrets(value)
        for key in ("password", "bearer_token"):
            if not new_secrets.get(key) and old_secrets.get(key):
                new_secrets[key] = old_secrets[key]
        for key in ("storage_state", "session_storage", "captured_token", "session_updated_at"):
            if key in old_secrets:
                new_secrets[key] = old_secrets[key]
        self._validate_auth(value.auth_mode, value.username, new_secrets.get("password", ""), new_secrets.get("bearer_token", "") or new_secrets.get("captured_token", ""))
        self.collection.write(values)
        self.vault.save(account_id, new_secrets)
        return self._public(updated)

    def save_session(self, account_id: str, session: dict[str, Any]) -> dict[str, Any]:
        secret = self.vault.load(account_id)
        secret.update(session)
        secret["session_updated_at"] = utcnow()
        self.vault.save(account_id, secret)
        return self.get_public(account_id)

    def delete(self, account_id: str) -> None:
        values = self.collection.read()
        if not any(item.get("id") == account_id for item in values):
            raise KeyError(account_id)
        self.collection.write([item for item in values if item.get("id") != account_id])
        self.vault.delete(account_id)

    def _get_metadata(self, account_id: str) -> dict[str, Any]:
        item = next((item for item in self.collection.read() if item.get("id") == account_id), None)
        if not item:
            raise KeyError(account_id)
        return item

    def _public(self, metadata: dict[str, Any]) -> dict[str, Any]:
        try:
            secret = self.vault.load(metadata["id"])
        except ValueError:
            secret = {}
        return {
            **metadata,
            "has_password": bool(secret.get("password")),
            "has_bearer_token": bool(secret.get("bearer_token") or secret.get("captured_token")),
            "has_session": bool(secret.get("storage_state")),
            "session_updated_at": secret.get("session_updated_at"),
            "vault_backend": self.vault.backend,
        }

    @staticmethod
    def _metadata(account_id: str, value: AccountInput, created_at: str, updated_at: str) -> dict[str, Any]:
        return {
            "id": account_id,
            "name": value.name,
            "base_url": str(value.base_url),
            "login_url": str(value.login_url or value.base_url),
            "auth_mode": value.auth_mode,
            "username": value.username,
            "username_selector": value.username_selector,
            "password_selector": value.password_selector,
            "submit_selector": value.submit_selector,
            "token_storage_key": value.token_storage_key,
            "extra_headers": value.extra_headers,
            "allowed_origins": [str(item) for item in value.allowed_origins],
            "variables": value.variables,
            "created_at": created_at,
            "updated_at": updated_at,
        }

    @staticmethod
    def _secrets(value: AccountInput) -> dict[str, Any]:
        return {"password": value.password, "bearer_token": value.bearer_token}

    @staticmethod
    def _validate_auth(auth_mode: str, username: str, password: str, bearer_token: str) -> None:
        if auth_mode == "bearer" and not bearer_token:
            raise ValueError("Bearer token is required for bearer-token accounts")
        if auth_mode == "form" and (not username or not password):
            raise ValueError("Username and password are required for form-login accounts")


class TestCaseStore:
    def __init__(self, data_dir: Path) -> None:
        self.collection = JsonCollection(data_dir / "test-cases.json")

    def list(self) -> list[dict[str, Any]]:
        return self.collection.read()

    def create(self, value: TestCaseInput) -> dict[str, Any]:
        item = {"id": uuid.uuid4().hex, **value.model_dump(), "created_at": utcnow(), "updated_at": utcnow()}
        values = self.collection.read()
        values.append(item)
        self.collection.write(values)
        return item

    def update(self, item_id: str, value: TestCaseInput) -> dict[str, Any]:
        values = self.collection.read()
        existing = next((item for item in values if item.get("id") == item_id), None)
        if not existing:
            raise KeyError(item_id)
        updated = {"id": item_id, **value.model_dump(), "created_at": existing["created_at"], "updated_at": utcnow()}
        self.collection.write([updated if item.get("id") == item_id else item for item in values])
        return updated

    def delete(self, item_id: str) -> None:
        values = self.collection.read()
        if not any(item.get("id") == item_id for item in values):
            raise KeyError(item_id)
        self.collection.write([item for item in values if item.get("id") != item_id])

    def selected(self, ids: list[str]) -> list[dict[str, Any]]:
        wanted = set(ids)
        found = [item for item in self.collection.read() if item.get("id") in wanted]
        if len(found) != len(wanted):
            raise KeyError("One or more test cases no longer exist")
        return found
