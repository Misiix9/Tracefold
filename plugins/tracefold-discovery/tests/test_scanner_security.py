from app.models import ScanConfig
from app.scanner import SiteScanner


def test_result_scrubs_exact_bearer_token_everywhere() -> None:
    token = "eyJ-test-secret-token"
    scanner = SiteScanner(ScanConfig(target_url="https://example.com", bearer_token=token))
    scanner.errors.append(f"The server echoed {token}")
    scanner.index._record("GET", "https://example.com/api/me")["responses"].append({"body": {"value": token}})
    result = scanner._result()
    assert token not in str(result)
    assert result["errors"] == ["The server echoed [redacted]"]
