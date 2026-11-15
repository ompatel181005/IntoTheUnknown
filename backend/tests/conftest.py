import pytest

from app.processing import views


@pytest.fixture(autouse=True)
def _irsa_cooldown_reset():
    """A failed IRSA query starts a cooldown (views._irsa); never let it leak between tests."""
    views._irsa["failed_at"] = None
    yield
    views._irsa["failed_at"] = None
