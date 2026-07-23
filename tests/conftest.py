"""Pytest fixtures for the validator backend.

Sets VALIDATOR_DB_PATH to a throwaway file *before* any app module is imported,
so the import-time init_db() calls never touch the real annotations.db. The `db`
fixture then points both storage modules at a fresh per-test temp file.
"""
import os
import tempfile

# MUST run before sql_backend / groups_db / annotations_db are imported anywhere.
os.environ.setdefault(
    "VALIDATOR_DB_PATH", os.path.join(tempfile.gettempdir(), "validator_test_import.db")
)

import sys

# Make the DashBoard/ modules importable when pytest runs from that folder.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest


@pytest.fixture
def db(tmp_path, monkeypatch):
    """Fresh, isolated SQLite file for one test; all storage modules share it."""
    import annotations_db
    import groups_db
    import logs_db

    path = str(tmp_path / "test.db")
    monkeypatch.setattr(groups_db, "DB_PATH", path)
    monkeypatch.setattr(annotations_db, "DB_PATH", path)
    monkeypatch.setattr(logs_db, "DB_PATH", path)
    groups_db.init_db()
    annotations_db.init_db()
    logs_db.init_db()
    return path


@pytest.fixture
def client(db, monkeypatch):
    """Flask test client backed by the isolated per-test DB.

    sql_backend calls groups_db / annotations_db functions at request time, and
    those read their (monkeypatched) DB_PATH per call — so no module reload needed.
    """
    monkeypatch.setenv("INITIAL_ADMINS", "")  # tests opt in explicitly
    import sql_backend

    sql_backend.app.config.update(TESTING=True)
    return sql_backend.app.test_client()


def login_as(client, can_edit=False, can_manage=False, username="tester"):
    """Inject a logged-in session with the given perms (bypasses AD)."""
    with client.session_transaction() as sess:
        sess["user"] = {
            "username": username,
            "display_name": username,
            "email": "",
            "groups": [],
            "source": "test",
            "perms": {"can_edit": can_edit, "can_manage": can_manage},
        }
