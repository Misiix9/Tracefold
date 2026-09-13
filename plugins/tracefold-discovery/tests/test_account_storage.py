from app.models import AccountInput
from app.storage import AccountStore


def test_account_secrets_are_encrypted_and_survive_metadata_updates(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr("app.storage.keyring.get_password", lambda *args: (_ for _ in ()).throw(RuntimeError()))
    store = AccountStore(tmp_path)
    created = store.create(AccountInput(
        name="User A",
        base_url="https://uat.example.com",
        auth_mode="bearer",
        bearer_token="very-secret-token",
        variables={"ticketId": "42"},
    ))
    files = [path for path in tmp_path.rglob("*") if path.is_file()]
    assert all(b"very-secret-token" not in path.read_bytes() for path in files)

    updated = store.update(created["id"], AccountInput(
        name="Restricted user A",
        base_url="https://uat.example.com",
        auth_mode="bearer",
        bearer_token="",
        variables={"ticketId": "99"},
    ))
    runtime = store.get_runtime(created["id"])
    assert updated["name"] == "Restricted user A"
    assert runtime["bearer_token"] == "very-secret-token"
    assert runtime["variables"]["ticketId"] == "99"
