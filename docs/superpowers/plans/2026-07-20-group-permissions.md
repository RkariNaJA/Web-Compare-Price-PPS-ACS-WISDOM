# Group Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin create app-managed groups (MER, POM, …), add AD users to them, and have each group grant `can_edit` (save annotations) and/or `can_manage` (administer groups); everyone else is read-only.

**Architecture:** AD stays purely for authentication (unchanged). A new `groups_db.py` SQLite layer (reusing `annotations.db`) stores groups + membership and resolves a user's effective permissions at login. `sql_backend.py` stores those perms in the session, enforces them with two decorators, and exposes manager-only group-CRUD routes. The React frontend reads `perms` from `/login` and `/me` to disable Save for read-only users and to show a Groups admin screen for managers. **All enforcement is server-side; the frontend only hides controls.**

**Tech Stack:** Python 3 / Flask 3.1 / SQLite (WAL) / pytest 9.1 (backend); React 18 + TypeScript + Vite (frontend, no test runner — verified via `npm run build` typecheck + manual steps).

## Global Constraints

- **Keep files under 500 lines** and follow existing code style (module docstrings, snake_case backend, the `annotations_db.py` connection pattern).
- **Never touch `auth_ad.py`'s AD bind/read logic** — AD is authentication only.
- **Permissions are enforced server-side.** The frontend disabling a control is never the security boundary.
- **Read-only is the default** for any logged-in user not in a group.
- **Effective perms are resolved at login** and stored in the session; a permission change takes effect on the affected user's next login.
- **Frontend user object uses snake_case `perms.can_edit` / `perms.can_manage`** to match the existing `AuthUser.display_name` convention (no snake→camel mapper needed).
- **Bootstrap:** `INITIAL_ADMINS` (`.env`, comma-separated AD `sAMAccountName`s, default `admin.user`) always resolves to full admin.
- **Git is not initialized** in this project. Commit steps are optional (see Task 0). Each task ends with a verification checkpoint regardless.

---

## File Structure

**Backend (`DashBoard/`)**
- Create `groups_db.py` — SQLite groups + membership storage and `resolve_perms`.
- Modify `annotations_db.py` — DB path honors `VALIDATOR_DB_PATH` (one line; enables test isolation).
- Modify `sql_backend.py` — init groups DB, resolve perms at login, add perms to `/login` & `/me`, add `require_edit`/`require_manage`, gate `POST /annotations`, add group-CRUD routes.
- Modify `.env` — add `INITIAL_ADMINS=admin.user`.
- Create `requirements-dev.txt` — pytest.
- Create `tests/conftest.py`, `tests/test_groups_db.py`, `tests/test_permissions_routes.py`.

**Frontend (`DashBoard/frontend/src/`)**
- Modify `lib/types.ts` — `AuthUser.perms`.
- Modify `lib/api.ts` — normalize `perms`; group-CRUD client functions + `AppGroup` type.
- Modify `components/ResultsToolbar.tsx` — disable Save when `!canEdit`.
- Modify `App.tsx` — read `useAuth`, pass `canEdit`, admin-view toggle.
- Modify `components/Header.tsx` — "Groups" button when `can_manage`.
- Create `components/GroupAdmin.tsx` — the admin screen.

---

## Task 0: (Optional) Initialize git for version control

Skip if you don't want git. If you do, this makes the commit steps in later tasks work.

**Files:** none (repo init only)

- [ ] **Step 1: Initialize and make a baseline commit**

```bash
cd "C:/Users/admin.user/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard"
git init
git add -A
git commit -m "chore: baseline before group permissions feature"
```

Expected: `Initialized empty Git repository…` then a commit summary. (`annotations.db` is already in `.gitignore`.)

> If you skip this task, ignore every "Step: Commit" below — just run the verification above it and move on.

---

## Task 1: pytest scaffolding + DB-path override + `groups_db` foundation

**Files:**
- Create: `DashBoard/requirements-dev.txt`
- Create: `DashBoard/groups_db.py`
- Modify: `DashBoard/annotations_db.py:23`
- Create: `DashBoard/tests/conftest.py`
- Create: `DashBoard/tests/test_groups_db.py`

**Interfaces:**
- Produces: `groups_db.DB_PATH` (str), `groups_db.init_db() -> None`, `groups_db._connect() -> sqlite3.Connection`. Tables `groups(name, can_edit, can_manage, created_by, created_at)` and `group_members(group_name, username, added_by, added_at)`.
- Produces: `annotations_db.DB_PATH` now honors `VALIDATOR_DB_PATH`.
- Produces: pytest fixture `db` (in `conftest.py`) — points `groups_db.DB_PATH` and `annotations_db.DB_PATH` at a per-test temp file and calls `init_db()`.

- [ ] **Step 1: Create the dev requirements file**

Create `DashBoard/requirements-dev.txt`:

```
# Dev/test-only dependencies (not needed to run the app).
# Install with:  python -m pip install -r requirements-dev.txt
pytest==9.1.1
```

- [ ] **Step 2: Make `annotations_db` DB path overridable**

In `DashBoard/annotations_db.py`, replace line 23:

```python
DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "annotations.db")
```

with:

```python
# Default DB lives next to this module (DashBoard/annotations.db). Overridable via
# VALIDATOR_DB_PATH so tests can point at a temp file. Gitignored.
DB_PATH = os.getenv("VALIDATOR_DB_PATH") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "annotations.db"
)
```

- [ ] **Step 3: Create the test config (`conftest.py`)**

Create `DashBoard/tests/conftest.py`:

```python
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
    """Fresh, isolated SQLite file for one test; both modules share it."""
    import annotations_db
    import groups_db

    path = str(tmp_path / "test.db")
    monkeypatch.setattr(groups_db, "DB_PATH", path)
    monkeypatch.setattr(annotations_db, "DB_PATH", path)
    groups_db.init_db()
    annotations_db.init_db()
    return path
```

- [ ] **Step 4: Write the failing test for `init_db`**

Create `DashBoard/tests/test_groups_db.py`:

```python
import groups_db


def test_init_db_creates_tables(db):
    conn = groups_db._connect()
    try:
        names = {
            r["name"]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
    finally:
        conn.close()
    assert {"groups", "group_members"} <= names
```

- [ ] **Step 5: Run it to confirm it fails**

Run: `cd "C:/Users/admin.user/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard" && python -m pytest tests/test_groups_db.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'groups_db'`.

- [ ] **Step 6: Create `groups_db.py` with the storage foundation**

Create `DashBoard/groups_db.py`:

```python
"""
SQLite persistence for APP-MANAGED groups and per-group permissions.

These are the app's OWN groups (MER, POM, Admins, …) — NOT Active Directory
security groups. AD is used only to authenticate the login; membership and
permissions live here. Stored inside the same annotations.db file, using the
same WAL / busy-timeout setup as annotations_db.py.

Two switches per group:
  can_edit   — members may save the Error From / Done annotations
  can_manage — members may create groups, add/remove members, change permissions

A user's effective permissions are the most-permissive union across every group
they belong to; INITIAL_ADMINS (env) always resolves to full admin.
"""
import os
import sqlite3
from datetime import datetime, timezone

# Same file as the annotations table; overridable for tests via VALIDATOR_DB_PATH.
DB_PATH = os.getenv("VALIDATOR_DB_PATH") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "annotations.db"
)


def _connect():
    conn = sqlite3.connect(DB_PATH, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Create the groups tables if they don't exist. Safe on every startup."""
    conn = _connect()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS groups (
                name        TEXT PRIMARY KEY,
                can_edit    INTEGER NOT NULL DEFAULT 0,
                can_manage  INTEGER NOT NULL DEFAULT 0,
                created_by  TEXT NOT NULL DEFAULT '',
                created_at  TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS group_members (
                group_name  TEXT NOT NULL,
                username    TEXT NOT NULL,
                added_by    TEXT NOT NULL DEFAULT '',
                added_at    TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (group_name, username),
                FOREIGN KEY (group_name) REFERENCES groups(name) ON DELETE CASCADE
            )
            """
        )
        conn.commit()
    finally:
        conn.close()
```

- [ ] **Step 7: Run the test to confirm it passes**

Run: `python -m pytest tests/test_groups_db.py -v`
Expected: PASS (1 passed).

- [ ] **Step 8: Commit**

```bash
git add requirements-dev.txt groups_db.py annotations_db.py tests/conftest.py tests/test_groups_db.py
git commit -m "feat(groups): add groups_db storage foundation + pytest scaffolding"
```

---

## Task 2: `groups_db` CRUD (groups + members)

**Files:**
- Modify: `DashBoard/groups_db.py`
- Modify: `DashBoard/tests/test_groups_db.py`

**Interfaces:**
- Produces:
  - `create_group(name: str, can_edit: bool, can_manage: bool, created_by: str) -> None` (raises `sqlite3.IntegrityError` on duplicate name)
  - `list_groups() -> list[dict]` — each `{"name", "can_edit": bool, "can_manage": bool, "members": list[str]}`, ordered by name; members sorted
  - `set_group_perms(name: str, can_edit: bool, can_manage: bool) -> None`
  - `delete_group(name: str) -> None`
  - `add_member(group_name: str, username: str, added_by: str) -> None` (idempotent; stores username casefolded)
  - `remove_member(group_name: str, username: str) -> None` (matches casefolded)

- [ ] **Step 1: Write the failing tests for CRUD**

Append to `DashBoard/tests/test_groups_db.py`:

```python
def test_create_and_list_group(db):
    groups_db.create_group("MER", can_edit=True, can_manage=False, created_by="admin")
    groups = groups_db.list_groups()
    assert len(groups) == 1
    g = groups[0]
    assert g["name"] == "MER"
    assert g["can_edit"] is True
    assert g["can_manage"] is False
    assert g["members"] == []


def test_add_and_remove_member_casefold(db):
    groups_db.create_group("MER", can_edit=True, can_manage=False, created_by="admin")
    groups_db.add_member("MER", "Somsak", added_by="admin")
    groups_db.add_member("MER", "SOMSAK", added_by="admin")  # dup, case variant → no-op
    members = groups_db.list_groups()[0]["members"]
    assert members == ["somsak"]

    groups_db.remove_member("MER", "SomSak")  # case-insensitive removal
    assert groups_db.list_groups()[0]["members"] == []


def test_set_group_perms(db):
    groups_db.create_group("POM", can_edit=False, can_manage=False, created_by="admin")
    groups_db.set_group_perms("POM", can_edit=True, can_manage=True)
    g = groups_db.list_groups()[0]
    assert g["can_edit"] is True and g["can_manage"] is True


def test_delete_group_cascades_members(db):
    groups_db.create_group("MER", can_edit=True, can_manage=False, created_by="admin")
    groups_db.add_member("MER", "somsak", added_by="admin")
    groups_db.delete_group("MER")
    assert groups_db.list_groups() == []
    conn = groups_db._connect()
    try:
        left = conn.execute("SELECT COUNT(*) c FROM group_members").fetchone()["c"]
    finally:
        conn.close()
    assert left == 0


def test_duplicate_group_raises(db):
    import sqlite3
    groups_db.create_group("MER", can_edit=True, can_manage=False, created_by="admin")
    try:
        groups_db.create_group("MER", can_edit=False, can_manage=False, created_by="admin")
        assert False, "expected IntegrityError"
    except sqlite3.IntegrityError:
        pass
```

- [ ] **Step 2: Run to confirm they fail**

Run: `python -m pytest tests/test_groups_db.py -v`
Expected: FAIL — `AttributeError: module 'groups_db' has no attribute 'create_group'`.

- [ ] **Step 3: Implement the CRUD functions**

Append to `DashBoard/groups_db.py`:

```python
def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def create_group(name, can_edit, can_manage, created_by):
    """Insert a new group. Raises sqlite3.IntegrityError if the name exists."""
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO groups (name, can_edit, can_manage, created_by, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (name, 1 if can_edit else 0, 1 if can_manage else 0, created_by or "", _now()),
        )
        conn.commit()
    finally:
        conn.close()


def set_group_perms(name, can_edit, can_manage):
    conn = _connect()
    try:
        conn.execute(
            "UPDATE groups SET can_edit = ?, can_manage = ? WHERE name = ?",
            (1 if can_edit else 0, 1 if can_manage else 0, name),
        )
        conn.commit()
    finally:
        conn.close()


def delete_group(name):
    conn = _connect()
    try:
        # Explicit member delete too, in case foreign_keys pragma is off on some builds.
        conn.execute("DELETE FROM group_members WHERE group_name = ?", (name,))
        conn.execute("DELETE FROM groups WHERE name = ?", (name,))
        conn.commit()
    finally:
        conn.close()


def add_member(group_name, username, added_by):
    """Add an AD username to a group (stored casefolded). Idempotent."""
    conn = _connect()
    try:
        conn.execute(
            "INSERT OR IGNORE INTO group_members (group_name, username, added_by, added_at) "
            "VALUES (?, ?, ?, ?)",
            (group_name, (username or "").strip().casefold(), added_by or "", _now()),
        )
        conn.commit()
    finally:
        conn.close()


def remove_member(group_name, username):
    conn = _connect()
    try:
        conn.execute(
            "DELETE FROM group_members WHERE group_name = ? AND username = ?",
            (group_name, (username or "").strip().casefold()),
        )
        conn.commit()
    finally:
        conn.close()


def list_groups():
    """Return every group with its sorted member list."""
    conn = _connect()
    try:
        groups = conn.execute(
            "SELECT name, can_edit, can_manage, created_by, created_at "
            "FROM groups ORDER BY name"
        ).fetchall()
        members = conn.execute(
            "SELECT group_name, username FROM group_members ORDER BY username"
        ).fetchall()
    finally:
        conn.close()
    by_group = {}
    for m in members:
        by_group.setdefault(m["group_name"], []).append(m["username"])
    return [
        {
            "name": g["name"],
            "can_edit": bool(g["can_edit"]),
            "can_manage": bool(g["can_manage"]),
            "members": by_group.get(g["name"], []),
        }
        for g in groups
    ]
```

- [ ] **Step 4: Run to confirm all pass**

Run: `python -m pytest tests/test_groups_db.py -v`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add groups_db.py tests/test_groups_db.py
git commit -m "feat(groups): group + member CRUD in groups_db"
```

---

## Task 3: `resolve_perms` (the core permission rule)

**Files:**
- Modify: `DashBoard/groups_db.py`
- Modify: `DashBoard/tests/test_groups_db.py`

**Interfaces:**
- Produces: `resolve_perms(username: str) -> dict` → `{"can_edit": bool, "can_manage": bool}`.
  Rule: `INITIAL_ADMINS` env (comma-separated, casefolded) → both True even with an empty DB; otherwise the most-permissive union across the user's groups; no group → both False. Username match is case-insensitive.

- [ ] **Step 1: Write the failing tests**

Append to `DashBoard/tests/test_groups_db.py`:

```python
def test_resolve_perms_no_group_is_readonly(db, monkeypatch):
    monkeypatch.setenv("INITIAL_ADMINS", "")
    assert groups_db.resolve_perms("nobody") == {"can_edit": False, "can_manage": False}


def test_resolve_perms_editor_group(db, monkeypatch):
    monkeypatch.setenv("INITIAL_ADMINS", "")
    groups_db.create_group("MER", can_edit=True, can_manage=False, created_by="a")
    groups_db.add_member("MER", "somsak", added_by="a")
    assert groups_db.resolve_perms("SOMSAK") == {"can_edit": True, "can_manage": False}


def test_resolve_perms_manage_group(db, monkeypatch):
    monkeypatch.setenv("INITIAL_ADMINS", "")
    groups_db.create_group("Admins", can_edit=False, can_manage=True, created_by="a")
    groups_db.add_member("Admins", "naree", added_by="a")
    assert groups_db.resolve_perms("naree") == {"can_edit": False, "can_manage": True}


def test_resolve_perms_union_across_groups(db, monkeypatch):
    monkeypatch.setenv("INITIAL_ADMINS", "")
    groups_db.create_group("Editors", can_edit=True, can_manage=False, created_by="a")
    groups_db.create_group("Managers", can_edit=False, can_manage=True, created_by="a")
    groups_db.add_member("Editors", "u", added_by="a")
    groups_db.add_member("Managers", "u", added_by="a")
    assert groups_db.resolve_perms("u") == {"can_edit": True, "can_manage": True}


def test_resolve_perms_initial_admin_even_with_empty_db(db, monkeypatch):
    monkeypatch.setenv("INITIAL_ADMINS", "admin.user, other.admin")
    assert groups_db.resolve_perms("example-user.K") == {"can_edit": True, "can_manage": True}
```

- [ ] **Step 2: Run to confirm they fail**

Run: `python -m pytest tests/test_groups_db.py -k resolve_perms -v`
Expected: FAIL — `AttributeError: module 'groups_db' has no attribute 'resolve_perms'`.

- [ ] **Step 3: Implement `resolve_perms`**

Append to `DashBoard/groups_db.py`:

```python
def _initial_admins():
    return {
        u.strip().casefold()
        for u in os.getenv("INITIAL_ADMINS", "").split(",")
        if u.strip()
    }


def resolve_perms(username):
    """Effective permissions for a username: {'can_edit': bool, 'can_manage': bool}.

    INITIAL_ADMINS always → full admin (bootstrap / lock-out recovery). Otherwise
    the union of can_edit / can_manage across every group the user belongs to.
    No group → read-only (both False). Case-insensitive on the username.
    """
    user = (username or "").strip().casefold()
    if not user:
        return {"can_edit": False, "can_manage": False}
    if user in _initial_admins():
        return {"can_edit": True, "can_manage": True}
    conn = _connect()
    try:
        row = conn.execute(
            """
            SELECT
                MAX(g.can_edit)   AS can_edit,
                MAX(g.can_manage) AS can_manage
            FROM group_members m
            JOIN groups g ON g.name = m.group_name
            WHERE m.username = ?
            """,
            (user,),
        ).fetchone()
    finally:
        conn.close()
    return {
        "can_edit": bool(row["can_edit"]) if row and row["can_edit"] is not None else False,
        "can_manage": bool(row["can_manage"]) if row and row["can_manage"] is not None else False,
    }
```

- [ ] **Step 4: Run to confirm all pass**

Run: `python -m pytest tests/test_groups_db.py -v`
Expected: PASS (all tests green).

- [ ] **Step 5: Commit**

```bash
git add groups_db.py tests/test_groups_db.py
git commit -m "feat(groups): resolve_perms with INITIAL_ADMINS bootstrap + union rule"
```

---

## Task 4: Flask perms wiring — guards, login/me, gate annotations

**Files:**
- Modify: `DashBoard/sql_backend.py:10-11` (imports), `:17` (init), `:38-45` (guards area), `:59-66` (login session), `:96-98` (annotations POST decorator)
- Modify: `DashBoard/tests/conftest.py`
- Create: `DashBoard/tests/test_permissions_routes.py`
- Modify: `DashBoard/.env`

**Interfaces:**
- Consumes: `groups_db.resolve_perms`, `groups_db.init_db` (Task 1–3).
- Produces: session `user` gains `"perms": {"can_edit", "can_manage"}`; `/login` and `/me` return it. Decorators `require_edit(view)` and `require_manage(view)` — 401 no session, 403 lacking right. `POST /annotations` now requires edit.
- Produces (conftest): fixture `client` and helper `login_as(client, can_edit=False, can_manage=False, username="tester")`.

- [ ] **Step 1: Add the group DB init + import**

In `DashBoard/sql_backend.py`, after line 11 (`import annotations_db`) add:

```python
import groups_db
```

After line 17 (`annotations_db.init_db()`) add:

```python
groups_db.init_db()
```

- [ ] **Step 2: Add the two permission guards**

In `DashBoard/sql_backend.py`, immediately after the `login_required` function (after line 45), add:

```python
def require_edit(view):
    """401 if not logged in, 403 unless the user's perms allow editing."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        user = session.get("user")
        if not user:
            return jsonify({"error": "authentication required"}), 401
        if not (user.get("perms") or {}).get("can_edit"):
            return jsonify({"error": "edit permission required"}), 403
        return view(*args, **kwargs)
    return wrapped


def require_manage(view):
    """401 if not logged in, 403 unless the user's perms allow managing groups."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        user = session.get("user")
        if not user:
            return jsonify({"error": "authentication required"}), 401
        if not (user.get("perms") or {}).get("can_manage"):
            return jsonify({"error": "manage permission required"}), 403
        return view(*args, **kwargs)
    return wrapped
```

- [ ] **Step 3: Resolve perms at login and store in the session**

In `DashBoard/sql_backend.py`, in the `login()` view, replace the session assignment (lines 59-66):

```python
    session["user"] = {
        "username": profile["username"],
        "display_name": profile.get("display_name") or profile["username"],
        "email": profile.get("email", ""),
        "groups": profile.get("groups", []),
        "source": profile.get("source", ""),
    }
    return jsonify({"user": session["user"]})
```

with:

```python
    session["user"] = {
        "username": profile["username"],
        "display_name": profile.get("display_name") or profile["username"],
        "email": profile.get("email", ""),
        "groups": profile.get("groups", []),
        "source": profile.get("source", ""),
        # App-group permissions resolved at login (see groups_db.resolve_perms).
        "perms": groups_db.resolve_perms(profile["username"]),
    }
    return jsonify({"user": session["user"]})
```

(`/me` already returns `session["user"]` verbatim, so it now includes `perms` — no change needed there.)

- [ ] **Step 4: Gate `POST /annotations` with `require_edit`**

In `DashBoard/sql_backend.py`, change the `save_annotations` decorator (line 97) from `@login_required` to `@require_edit`:

```python
@app.route("/annotations", methods=["POST"])
@require_edit
def save_annotations():
```

(Leave `GET /annotations` on `@login_required` — everyone signed in may read.)

- [ ] **Step 5: Extend `conftest.py` with a Flask client + login helper**

Append to `DashBoard/tests/conftest.py`:

```python
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
```

- [ ] **Step 6: Write the failing route tests**

Create `DashBoard/tests/test_permissions_routes.py`:

```python
from conftest import login_as


def test_save_annotations_requires_login(client):
    resp = client.post("/annotations", json={"annotations": {}})
    assert resp.status_code == 401


def test_save_annotations_forbidden_for_readonly(client):
    login_as(client, can_edit=False)
    resp = client.post(
        "/annotations", json={"annotations": {"k1": {"error_from": "Wisdom", "done": True}}}
    )
    assert resp.status_code == 403


def test_save_annotations_allowed_for_editor(client):
    login_as(client, can_edit=True)
    resp = client.post(
        "/annotations", json={"annotations": {"k1": {"error_from": "Wisdom", "done": True}}}
    )
    assert resp.status_code == 200
    assert "annotations" in resp.get_json()


def test_get_annotations_allowed_for_readonly(client):
    login_as(client, can_edit=False)
    resp = client.get("/annotations")
    assert resp.status_code == 200


def test_me_returns_perms(client):
    login_as(client, can_edit=True, can_manage=True)
    resp = client.get("/me")
    assert resp.status_code == 200
    assert resp.get_json()["user"]["perms"] == {"can_edit": True, "can_manage": True}
```

- [ ] **Step 7: Run the route tests**

Run: `python -m pytest tests/test_permissions_routes.py -v`
Expected: PASS (all 5 green). If `ModuleNotFoundError: pyodbc`, run `python -m pip install -r requirements.txt` first.

- [ ] **Step 8: Add the bootstrap admin to `.env`**

Append to `DashBoard/.env` (near the AD config):

```
# App-group bootstrap: these AD sAMAccountNames are always full admins,
# even before any groups exist (lock-out recovery). Comma-separated.
INITIAL_ADMINS=admin.user
```

- [ ] **Step 9: Full backend test run + commit**

Run: `python -m pytest tests/ -v`
Expected: PASS (all tests green).

```bash
git add sql_backend.py tests/conftest.py tests/test_permissions_routes.py .env
git commit -m "feat(auth): resolve perms at login, gate annotations save, add guards"
```

> Note: `.env` may be gitignored — if `git add .env` reports it's ignored, that's expected; just skip it.

---

## Task 5: Flask group-management routes (manager-only)

**Files:**
- Modify: `DashBoard/sql_backend.py` (add routes after the annotations routes, ~line 108)
- Modify: `DashBoard/tests/test_permissions_routes.py`

**Interfaces:**
- Consumes: `require_manage`, `groups_db.*` CRUD.
- Produces routes (all behind `require_manage`, all return `{"groups": [...]}` = the fresh full list):
  - `GET /groups`
  - `POST /groups` body `{name, can_edit, can_manage}` → 400 if name blank, 409 if exists
  - `PATCH /groups/<name>` body `{can_edit, can_manage}`
  - `DELETE /groups/<name>`
  - `POST /groups/<name>/members` body `{username}` → 400 if blank
  - `DELETE /groups/<name>/members/<username>`

- [ ] **Step 1: Write the failing tests**

Append to `DashBoard/tests/test_permissions_routes.py`:

```python
def test_groups_list_requires_manage(client):
    login_as(client, can_edit=True, can_manage=False)
    assert client.get("/groups").status_code == 403


def test_group_create_add_member_flow(client):
    login_as(client, can_manage=True, username="admin")

    r = client.post("/groups", json={"name": "MER", "can_edit": True, "can_manage": False})
    assert r.status_code == 200
    groups = r.get_json()["groups"]
    assert groups[0]["name"] == "MER" and groups[0]["can_edit"] is True

    r = client.post("/groups/MER/members", json={"username": "Somsak"})
    assert r.status_code == 200
    assert r.get_json()["groups"][0]["members"] == ["somsak"]

    r = client.delete("/groups/MER/members/somsak")
    assert r.get_json()["groups"][0]["members"] == []

    r = client.patch("/groups/MER", json={"can_edit": False, "can_manage": True})
    assert r.get_json()["groups"][0]["can_manage"] is True

    r = client.delete("/groups/MER")
    assert r.get_json()["groups"] == []


def test_group_create_blank_name_400(client):
    login_as(client, can_manage=True)
    assert client.post("/groups", json={"name": "  "}).status_code == 400


def test_group_create_duplicate_409(client):
    login_as(client, can_manage=True)
    client.post("/groups", json={"name": "MER", "can_edit": True, "can_manage": False})
    r = client.post("/groups", json={"name": "MER", "can_edit": False, "can_manage": False})
    assert r.status_code == 409
```

- [ ] **Step 2: Run to confirm they fail**

Run: `python -m pytest tests/test_permissions_routes.py -k group -v`
Expected: FAIL — 404 (routes don't exist yet).

- [ ] **Step 3: Implement the routes**

First, add the stdlib import at the TOP of `DashBoard/sql_backend.py` — insert `import sqlite3` immediately under `import os` (line 1), so the top block reads:

```python
import os
import sqlite3
from datetime import timedelta
from functools import wraps
```

Then, in `DashBoard/sql_backend.py`, after the `save_annotations` view (after line 108, before the SQL Server section), add:

```python
# ── Group management (app-managed groups & permissions) ───────────────────────
# All manager-only. Each returns the fresh full list so the UI refreshes in one
# round-trip (mirrors the annotations save pattern).
def _actor():
    return (session.get("user") or {}).get("username") or ""


@app.route("/groups", methods=["GET"])
@require_manage
def list_groups():
    return jsonify({"groups": groups_db.list_groups()})


@app.route("/groups", methods=["POST"])
@require_manage
def create_group():
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "group name required"}), 400
    try:
        groups_db.create_group(name, bool(data.get("can_edit")), bool(data.get("can_manage")), _actor())
    except sqlite3.IntegrityError:
        return jsonify({"error": f"group '{name}' already exists"}), 409
    return jsonify({"groups": groups_db.list_groups()})


@app.route("/groups/<name>", methods=["PATCH"])
@require_manage
def update_group(name):
    data = request.get_json(silent=True) or {}
    groups_db.set_group_perms(name, bool(data.get("can_edit")), bool(data.get("can_manage")))
    return jsonify({"groups": groups_db.list_groups()})


@app.route("/groups/<name>", methods=["DELETE"])
@require_manage
def delete_group(name):
    groups_db.delete_group(name)
    return jsonify({"groups": groups_db.list_groups()})


@app.route("/groups/<name>/members", methods=["POST"])
@require_manage
def add_group_member(name):
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    if not username:
        return jsonify({"error": "username required"}), 400
    groups_db.add_member(name, username, _actor())
    return jsonify({"groups": groups_db.list_groups()})


@app.route("/groups/<name>/members/<username>", methods=["DELETE"])
@require_manage
def remove_group_member(name, username):
    groups_db.remove_member(name, username)
    return jsonify({"groups": groups_db.list_groups()})
```

- [ ] **Step 4: Run the tests**

Run: `python -m pytest tests/ -v`
Expected: PASS (all backend tests green).

- [ ] **Step 5: Commit**

```bash
git add sql_backend.py tests/test_permissions_routes.py
git commit -m "feat(groups): manager-only group management routes"
```

---

## Task 6: Frontend types + API client

**Files:**
- Modify: `DashBoard/frontend/src/lib/types.ts:93-99`
- Modify: `DashBoard/frontend/src/lib/api.ts` (`apiLogin`/`apiMe` normalization + new group functions)

**Interfaces:**
- Produces: `AuthUser.perms: { can_edit: boolean; can_manage: boolean }`.
- Produces (api.ts): `AppGroup` type `{ name; can_edit; can_manage; members: string[] }`; functions `fetchGroups`, `createGroup(name, can_edit, can_manage)`, `setGroupPerms(name, can_edit, can_manage)`, `deleteGroup(name)`, `addGroupMember(name, username)`, `removeGroupMember(name, username)` — all `Promise<AppGroup[]>`.

- [ ] **Step 1: Add `perms` to `AuthUser`**

In `DashBoard/frontend/src/lib/types.ts`, replace the `AuthUser` interface (lines 93-99):

```typescript
export interface AuthUser {
  username: string;      // sAMAccountName (used as the saved_by key later)
  display_name: string;  // friendly name for the header
  email: string;
  groups: string[];      // AD group DNs the user belongs to
  source: string;        // 'ad' | 'local'
}
```

with:

```typescript
export interface AuthUser {
  username: string;      // sAMAccountName (used as the saved_by key later)
  display_name: string;  // friendly name for the header
  email: string;
  groups: string[];      // AD group DNs the user belongs to
  source: string;        // 'ad' | 'local'
  // App-group permissions resolved by the backend at login. snake_case to match
  // display_name and the backend JSON (no mapper needed).
  perms: { can_edit: boolean; can_manage: boolean };
}
```

- [ ] **Step 2: Normalize `perms` in `apiLogin` / `apiMe`**

In `DashBoard/frontend/src/lib/api.ts`, add this helper just above `apiLogin` (before line 69):

```typescript
// Older sessions (from before this feature) may lack perms; default to read-only
// so the UI never crashes on `user.perms`.
function normalizeUser(raw: any): AuthUser {
  return {
    ...raw,
    perms: raw?.perms ?? { can_edit: false, can_manage: false },
  } as AuthUser;
}
```

Then change the `return` in `apiLogin` (line 78) from:

```typescript
  return data.user as AuthUser;
```

to:

```typescript
  return normalizeUser(data.user);
```

And change the `return` in `apiMe` (line 93) from:

```typescript
    return data.user as AuthUser;
```

to:

```typescript
    return normalizeUser(data.user);
```

- [ ] **Step 3: Add the group-admin API functions**

Append to `DashBoard/frontend/src/lib/api.ts` (after the annotations section, before `export const backendUrl`):

```typescript
// ── Group management (admin-only; backend enforces manage permission) ─────────
export interface AppGroup {
  name: string;
  can_edit: boolean;
  can_manage: boolean;
  members: string[];
}

// Shared helper: every group route returns { groups: AppGroup[] } (the fresh
// full list) so one call both mutates and refreshes.
async function groupsRequest(path: string, init?: RequestInit): Promise<AppGroup[]> {
  const res = await fetch(`${BACKEND_URL}${path}`, { ...CREDS, ...init });
  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new Error('Your session expired — please sign in again.');
  }
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.groups as AppGroup[];
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const fetchGroups = () => groupsRequest('/groups');

export const createGroup = (name: string, can_edit: boolean, can_manage: boolean) =>
  groupsRequest('/groups', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, can_edit, can_manage }),
  });

export const setGroupPerms = (name: string, can_edit: boolean, can_manage: boolean) =>
  groupsRequest(`/groups/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ can_edit, can_manage }),
  });

export const deleteGroup = (name: string) =>
  groupsRequest(`/groups/${encodeURIComponent(name)}`, { method: 'DELETE' });

export const addGroupMember = (name: string, username: string) =>
  groupsRequest(`/groups/${encodeURIComponent(name)}/members`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ username }),
  });

export const removeGroupMember = (name: string, username: string) =>
  groupsRequest(`/groups/${encodeURIComponent(name)}/members/${encodeURIComponent(username)}`, {
    method: 'DELETE',
  });
```

- [ ] **Step 4: Typecheck**

Run: `cd "C:/Users/admin.user/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard/frontend" && npm run build`
Expected: build succeeds (no TypeScript errors). (This compiles the whole app; it stays green because nothing consumes `perms` yet.)

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/admin.user/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard"
git add frontend/src/lib/types.ts frontend/src/lib/api.ts
git commit -m "feat(fe): AuthUser.perms + group-admin API client"
```

---

## Task 7: Disable Save for read-only users

**Files:**
- Modify: `DashBoard/frontend/src/components/ResultsToolbar.tsx` (Props + Save button)
- Modify: `DashBoard/frontend/src/App.tsx` (read `useAuth`, pass `canEdit`)

**Interfaces:**
- Consumes: `AuthUser.perms.can_edit` (Task 6).
- Produces: `ResultsToolbar` Props gains `canEdit: boolean`; `AppInner` exposes `const { user } = useAuth()` for use by later tasks too.

- [ ] **Step 1: Add `canEdit` to the toolbar Props**

In `DashBoard/frontend/src/components/ResultsToolbar.tsx`, in the `Props` interface, after `dirty: boolean;` (line 46) add:

```typescript
  canEdit: boolean;             // false → Save disabled (server also rejects)
```

And add `canEdit,` to the destructured params (after `dirty,` at line 72):

```typescript
  dirty,
  canEdit,
}: Props) {
```

- [ ] **Step 2: Gate the Save button**

In `DashBoard/frontend/src/components/ResultsToolbar.tsx`, replace the Save button (lines 231-239):

```tsx
        <button
          className="btn btn-primary"
          style={{ padding: '5px 13px' }}
          onClick={onSave}
          disabled={saving}
          title="Save Error From / Done — shared with everyone"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
```

with:

```tsx
        <button
          className="btn btn-primary"
          style={{ padding: '5px 13px' }}
          onClick={onSave}
          disabled={saving || !canEdit}
          title={
            canEdit
              ? 'Save Error From / Done — shared with everyone'
              : 'Read-only — ask an admin for edit access'
          }
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
```

- [ ] **Step 3: Provide `canEdit` from App**

In `DashBoard/frontend/src/App.tsx`, at the top of `AppInner()` (after line 23, `const toast = useToast();`) add:

```typescript
  const { user } = useAuth();
  const canEdit = !!user?.perms?.can_edit;
```

Then in the `<ResultsToolbar ... />` JSX, after `dirty={dirty}` (line 264) add:

```tsx
            dirty={dirty}
            canEdit={canEdit}
```

(`useAuth` is already imported on line 15.)

- [ ] **Step 4: Typecheck**

Run: `cd "C:/Users/admin.user/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard/frontend" && npm run build`
Expected: build succeeds.

- [ ] **Step 5: Manual verification**

Run backend (`python sql_backend.py` in `DashBoard/`) and frontend (`npm run dev` in `frontend/`). Log in as a user **not** in `INITIAL_ADMINS` and not in any group → after Validate, the **Save button is greyed out** with the "Read-only" tooltip. Log in as `admin.user` → Save is enabled.

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/admin.user/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard"
git add frontend/src/components/ResultsToolbar.tsx frontend/src/App.tsx
git commit -m "feat(fe): disable Save for read-only users"
```

---

## Task 8: Header "Groups" link + admin-view toggle

**Files:**
- Modify: `DashBoard/frontend/src/components/Header.tsx`
- Modify: `DashBoard/frontend/src/App.tsx`

**Interfaces:**
- Consumes: `AuthUser.perms.can_manage`, `const { user } = useAuth()` in `AppInner` (Task 7).
- Produces: `Header` accepts optional `onOpenGroups?: () => void`; renders a "Groups" button only when `user.perms.can_manage`. `AppInner` owns `adminOpen` state and conditionally renders `<GroupAdmin>` (created in Task 9). Until Task 9 lands, the toggle renders a placeholder.

- [ ] **Step 1: Add the Groups button to the header**

In `DashBoard/frontend/src/components/Header.tsx`, replace the whole component (lines 7-28):

```tsx
export default function Header() {
  const { user, logout } = useAuth();
  return (
    <header className="header">
      <div className="logo">⊞</div>
      <div>
        <h1>3-way Validator</h1>
        <p>ACS (ACS DB) &amp; Costsheet (Wisdom DB) vs PPS (File B)</p>
      </div>
      {user && (
        <div className="header-user">
          <span className="header-username" title={user.email || user.username}>
            {user.display_name || user.username}
          </span>
          <button className="btn btn-ghost" onClick={() => logout()} title="Sign out">
            Logout
          </button>
        </div>
      )}
    </header>
  );
}
```

with:

```tsx
export default function Header({ onOpenGroups }: { onOpenGroups?: () => void }) {
  const { user, logout } = useAuth();
  return (
    <header className="header">
      <div className="logo">⊞</div>
      <div>
        <h1>3-way Validator</h1>
        <p>ACS (ACS DB) &amp; Costsheet (Wisdom DB) vs PPS (File B)</p>
      </div>
      {user && (
        <div className="header-user">
          {user.perms?.can_manage && onOpenGroups && (
            <button
              className="btn btn-ghost"
              onClick={onOpenGroups}
              title="Manage groups & permissions"
            >
              Groups
            </button>
          )}
          <span className="header-username" title={user.email || user.username}>
            {user.display_name || user.username}
          </span>
          <button className="btn btn-ghost" onClick={() => logout()} title="Sign out">
            Logout
          </button>
        </div>
      )}
    </header>
  );
}
```

- [ ] **Step 2: Add the admin-view toggle in App**

In `DashBoard/frontend/src/App.tsx`, add the state near the other `useState` calls (after line 43, `const [saving, setSaving] = useState(false);`):

```typescript
  const [adminOpen, setAdminOpen] = useState(false);
```

Add the import at the top with the other component imports (after line 16, `import LoginPage from './components/LoginPage';`):

```typescript
  import GroupAdmin from './components/GroupAdmin';
```

Then replace the top of the returned JSX (lines 220-236) from:

```tsx
  return (
    <div className="app">
      <Header />
      <UploadStrip
        dataA={dataA}
        dataC={dataC}
        dataBFiles={dataBFiles}
        setDataA={setDataA}
        setDataC={setDataC}
        setDataBFiles={setDataBFiles}
      />
      <KeyInfoPanel
        visible={keyPanelVisible}
        canValidate={canValidate}
        onValidate={handleValidate}
      />
```

with:

```tsx
  if (adminOpen) {
    return (
      <div className="app">
        <Header onOpenGroups={() => setAdminOpen(true)} />
        <GroupAdmin onClose={() => setAdminOpen(false)} />
      </div>
    );
  }

  return (
    <div className="app">
      <Header onOpenGroups={() => setAdminOpen(true)} />
      <UploadStrip
        dataA={dataA}
        dataC={dataC}
        dataBFiles={dataBFiles}
        setDataA={setDataA}
        setDataC={setDataC}
        setDataBFiles={setDataBFiles}
      />
      <KeyInfoPanel
        visible={keyPanelVisible}
        canValidate={canValidate}
        onValidate={handleValidate}
      />
```

> This references `GroupAdmin`, created in Task 9. The build will fail until Task 9 is done — that's expected; do Task 9 next before running `npm run build`.

- [ ] **Step 3: Commit (after Task 9 makes it compile)**

Hold this commit until Task 9 is complete and the build passes, then:

```bash
cd "C:/Users/admin.user/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard"
git add frontend/src/components/Header.tsx frontend/src/App.tsx
git commit -m "feat(fe): Groups button + admin-view toggle"
```

---

## Task 9: GroupAdmin screen

**Files:**
- Create: `DashBoard/frontend/src/components/GroupAdmin.tsx`

**Interfaces:**
- Consumes: `fetchGroups`, `createGroup`, `setGroupPerms`, `deleteGroup`, `addGroupMember`, `removeGroupMember`, `AppGroup` (Task 6); `useToast` (existing).
- Produces: default-exported `GroupAdmin({ onClose }: { onClose: () => void })`.

- [ ] **Step 1: Create the component**

Create `DashBoard/frontend/src/components/GroupAdmin.tsx`:

```tsx
/**
 * Admin screen for app-managed groups & permissions. Only reachable when the
 * signed-in user has can_manage (the "Groups" button in the header). Every
 * action calls the backend (which re-checks manage permission) and refreshes
 * from the returned full list, so the UI always mirrors the server.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  addGroupMember,
  createGroup,
  deleteGroup,
  fetchGroups,
  removeGroupMember,
  setGroupPerms,
  type AppGroup,
} from '../lib/api';
import { useToast } from '../hooks/useToast';

export default function GroupAdmin({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [groups, setGroups] = useState<AppGroup[]>([]);
  const [loading, setLoading] = useState(true);

  // New-group form
  const [newName, setNewName] = useState('');
  const [newEdit, setNewEdit] = useState(true);
  const [newManage, setNewManage] = useState(false);

  // Per-group "add member" text, keyed by group name
  const [memberInput, setMemberInput] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    setLoading(true);
    fetchGroups()
      .then(setGroups)
      .catch((err) => toast((err as Error).message, 'err'))
      .finally(() => setLoading(false));
  }, [toast]);

  useEffect(() => load(), [load]);

  const run = (p: Promise<AppGroup[]>, ok?: string) =>
    p
      .then((g) => {
        setGroups(g);
        if (ok) toast(ok, 'ok');
      })
      .catch((err) => toast((err as Error).message, 'err'));

  const onCreate = () => {
    const name = newName.trim();
    if (!name) return;
    run(createGroup(name, newEdit, newManage), `Created "${name}"`).then(() => {
      setNewName('');
      setNewEdit(true);
      setNewManage(false);
    });
  };

  const onAddMember = (group: string) => {
    const username = (memberInput[group] || '').trim();
    if (!username) return;
    run(addGroupMember(group, username), `Added ${username} to ${group}`).then(() =>
      setMemberInput((prev) => ({ ...prev, [group]: '' })),
    );
  };

  return (
    <div className="group-admin" style={{ padding: '18px 22px', maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Groups &amp; Permissions</h2>
        <button className="btn btn-ghost" style={{ marginLeft: 'auto' }} onClick={onClose}>
          ← Back to validator
        </button>
      </div>

      {/* Create group */}
      <div
        style={{
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          flexWrap: 'wrap',
          padding: '12px 0 18px',
          borderBottom: '1px solid var(--border, #ddd)',
        }}
      >
        <input
          className="filter-select"
          placeholder="New group name (e.g. MER)"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onCreate()}
        />
        <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <input type="checkbox" checked={newEdit} onChange={(e) => setNewEdit(e.target.checked)} />
          can edit
        </label>
        <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
          <input
            type="checkbox"
            checked={newManage}
            onChange={(e) => setNewManage(e.target.checked)}
          />
          can manage
        </label>
        <button className="btn btn-primary" onClick={onCreate} disabled={!newName.trim()}>
          + Create group
        </button>
      </div>

      {loading ? (
        <p style={{ marginTop: 18 }}>Loading…</p>
      ) : groups.length === 0 ? (
        <p style={{ marginTop: 18, opacity: 0.7 }}>
          No groups yet. Create one above — then add AD usernames to it.
        </p>
      ) : (
        groups.map((g) => (
          <div
            key={g.name}
            style={{
              padding: '14px 0',
              borderBottom: '1px solid var(--border, #eee)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
              <strong style={{ fontSize: '1.05rem' }}>{g.name}</strong>
              <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={g.can_edit}
                  onChange={(e) => run(setGroupPerms(g.name, e.target.checked, g.can_manage))}
                />
                can edit
              </label>
              <label style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={g.can_manage}
                  onChange={(e) => run(setGroupPerms(g.name, g.can_edit, e.target.checked))}
                />
                can manage
              </label>
              <button
                className="btn btn-ghost"
                style={{ marginLeft: 'auto' }}
                onClick={() => {
                  if (confirm(`Delete group "${g.name}"? This removes its members too.`))
                    run(deleteGroup(g.name), `Deleted "${g.name}"`);
                }}
              >
                Delete group
              </button>
            </div>

            {/* Members */}
            <div style={{ marginTop: 10, paddingLeft: 4 }}>
              {g.members.length === 0 ? (
                <span style={{ opacity: 0.6, fontSize: '.85rem' }}>No members yet.</span>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {g.members.map((m) => (
                    <span
                      key={m}
                      style={{
                        display: 'inline-flex',
                        gap: 6,
                        alignItems: 'center',
                        padding: '3px 8px',
                        borderRadius: 12,
                        background: 'var(--chip-bg, #eef)',
                        fontSize: '.85rem',
                      }}
                    >
                      {m}
                      <button
                        onClick={() => run(removeGroupMember(g.name, m))}
                        title={`Remove ${m}`}
                        style={{
                          border: 'none',
                          background: 'transparent',
                          cursor: 'pointer',
                          fontWeight: 'bold',
                        }}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <input
                  className="filter-select"
                  placeholder="AD username (sAMAccountName)"
                  value={memberInput[g.name] || ''}
                  onChange={(e) =>
                    setMemberInput((prev) => ({ ...prev, [g.name]: e.target.value }))
                  }
                  onKeyDown={(e) => e.key === 'Enter' && onAddMember(g.name)}
                />
                <button className="btn btn-ghost" onClick={() => onAddMember(g.name)}>
                  + Add member
                </button>
              </div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck (whole app, including Task 8's wiring)**

Run: `cd "C:/Users/admin.user/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard/frontend" && npm run build`
Expected: build succeeds.

- [ ] **Step 3: Commit (this + Task 8's held files)**

```bash
cd "C:/Users/admin.user/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard"
git add frontend/src/components/GroupAdmin.tsx frontend/src/components/Header.tsx frontend/src/App.tsx
git commit -m "feat(fe): GroupAdmin screen for managing groups & members"
```

---

## Task 10: End-to-end manual verification

**Files:** none (manual QA)

- [ ] **Step 1: Start both servers**

```bash
# Terminal 1 — backend
cd "C:/Users/admin.user/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard"
python sql_backend.py
# Terminal 2 — frontend
cd "C:/Users/admin.user/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard/frontend"
npm run dev
```

- [ ] **Step 2: Admin path**

Log in as `admin.user` (in `INITIAL_ADMINS`). Confirm:
- A **"Groups"** button appears in the header.
- Click it → GroupAdmin opens. Create group **MER** with *can edit* checked.
- Add your own username and a colleague's `sAMAccountName` to MER.
- "← Back to validator" returns to the app; Validate → **Save is enabled**.

- [ ] **Step 3: Editor path**

Log in as a user you added to MER (edit group). Confirm: **no** Groups button (not a manager), Validate → **Save enabled**, a save succeeds.

- [ ] **Step 4: Read-only path**

Log in as a valid AD user in **no** group. Confirm: no Groups button, Validate → **Save greyed out** with the "Read-only" tooltip.

- [ ] **Step 5: Server-side enforcement spot check**

While logged in as the read-only user, confirm the backend rejects a direct save (browser devtools console):

```js
fetch(`${location.protocol}//${location.hostname}:5001/annotations`, {
  method: 'POST', credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ annotations: { k: { error_from: 'x', done: true } } }),
}).then(r => console.log('status', r.status));  // expect 403
```

- [ ] **Step 6: Final backend test run**

```bash
cd "C:/Users/admin.user/Desktop/Pyrhon Refresh File/PPS,ACS,WISDOM/DashBoard"
python -m pytest tests/ -v
```

Expected: all green.

---

## Self-Review (completed while writing)

- **Spec coverage:** Two-layer architecture (Tasks 1–5 backend, 6–9 frontend); `can_edit`/`can_manage` switches (Tasks 2–3, 7–9); read-only default (Task 3 + 7); union across groups (Task 3); `INITIAL_ADMINS` bootstrap (Task 3 + 4 `.env`); reuse of `annotations.db` (Task 1); server-side enforcement (Task 4 guards, verified Task 10 step 5); manager-only routes (Task 5); admin UI (Tasks 8–9). No spec requirement left without a task.
- **Explicitly-excluded scope** (data filtering, per-group annotation scopes, AD writes) is not implemented — matches the spec's non-goals.
- **Placeholder scan:** none — every code step has full content.
- **Type consistency:** backend perms dict `{"can_edit","can_manage"}` used identically in `groups_db.resolve_perms`, the guards, the session, and the tests; frontend `perms.can_edit`/`can_manage` and `AppGroup` shape used identically across `types.ts`, `api.ts`, `Header.tsx`, `App.tsx`, `GroupAdmin.tsx`. Route return shape `{"groups": AppGroup[]}` consistent between Task 5 and Task 6's `groupsRequest`.
