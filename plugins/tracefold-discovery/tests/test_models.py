import pytest
from pydantic import ValidationError

from app.models import ScanConfig


def test_mutation_probing_requires_exact_confirmation() -> None:
    with pytest.raises(ValidationError):
        ScanConfig(target_url="https://example.com", active_mutation_probing=True)
    config = ScanConfig(
        target_url="https://example.com",
        active_mutation_probing=True,
        authorization_confirmation="I AM AUTHORIZED",
    )
    assert config.active_mutation_probing


def test_sensitive_headers_cannot_be_overridden() -> None:
    with pytest.raises(ValidationError):
        ScanConfig(target_url="https://example.com", extra_headers={"Authorization": "oops"})

