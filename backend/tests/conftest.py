"""Shared test fixtures.

Each test gets an isolated SQLite database. Rather than reload modules (which
would create duplicate enum objects and break identity checks across the
compiler and tests), the fixture rebinds the engine in place via
``configure_database`` and clears the settings cache. Module references stay
stable for the whole process.
"""

from __future__ import annotations

import os
import tempfile
from collections.abc import Iterator

import pytest


@pytest.fixture()
def client() -> Iterator[object]:
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    url = f"sqlite:///{tmp.name}"
    os.environ["DATABASE_URL"] = url

    from ai_drama.config import get_settings
    from ai_drama import db as db_module

    get_settings.cache_clear()
    db_module.configure_database(url)
    db_module.init_db()

    from ai_drama.api import app
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        login = c.post(
            "/api/auth/login",
            json={"username": "admin", "password": "admin"},
        )
        assert login.status_code == 200
        c.headers.update({"Authorization": f"Bearer {login.json()['token']}"})
        yield c

    db_module.engine.dispose()
    try:
        os.unlink(tmp.name)
    except PermissionError:
        pass
    os.environ.pop("DATABASE_URL", None)
    get_settings.cache_clear()


@pytest.fixture()
def unauthenticated_client() -> Iterator[object]:
    tmp = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
    tmp.close()
    url = f"sqlite:///{tmp.name}"
    os.environ["DATABASE_URL"] = url

    from ai_drama.config import get_settings
    from ai_drama import db as db_module

    get_settings.cache_clear()
    db_module.configure_database(url)
    db_module.init_db()

    from ai_drama.api import app
    from fastapi.testclient import TestClient

    with TestClient(app) as c:
        yield c

    db_module.engine.dispose()
    try:
        os.unlink(tmp.name)
    except PermissionError:
        pass
    os.environ.pop("DATABASE_URL", None)
    get_settings.cache_clear()
