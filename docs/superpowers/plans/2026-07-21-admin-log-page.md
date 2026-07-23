# Admin Log Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `can_manage` admins a Log view (who's online now, who logged in on a given day, and a full history of annotation changes), reached from a post-login chooser (Dashboard-Log / Dashboard-Compare-Data) with a header switcher; non-admins are unaffected.

**Architecture:** A new `logs_db.py` SQLite module (reusing `annotations.db`) owns three tables — `presence`, `login_events`, `change_log`. `sql_backend.py` gains a heartbeat route, three manager-only read routes, a login hook, and hooks the change log into the existing annotation save. The React frontend adds a Log dashboard, a landing chooser + header switcher, and a 30s heartbeat.

**Tech Stack:** Python 3 / Flask 3.1 / SQLite (WAL) / pytest (backend); React 18 + TypeScript + Vite (frontend, no test runner — verified via `npm run build` + manual steps).

## Global Constraints

- **Keep files under 500 lines**; match existing style (module docstrings, snake_case backend, the `annotations_db.py`/`groups_db.py` connection pattern; camel/snake conventions already in the frontend).
- **"Admin" = the `can_manage` permission.** Reuse the existing `@require_manage` guard; do not invent a new role.
- **All admin reads enforced server-side** (`@require_manage`); the heartbeat is `@login_required`. Frontend only shows/hides entry points.
- **Default knobs (exact values):** heartbeat **30000 ms**; "online" window **120 s**; online panel auto-refresh **15000 ms**; login/change history default range **today (local)**, with a date picker.
- **Timestamps stored ISO-8601 UTC**, seconds precision (`datetime.now(timezone.utc).isoformat(timespec="seconds")`). "A day" = that **local** calendar day.
- **Only annotation changes and logins are recorded** — never reads/filters/exports. Log tables are read-only via the API (no edit/delete routes).
- **No git repo** in this project — commit steps are optional; each task ends with a verification checkpoint regardless.
- **Reuse `annotations.db`** for the new tables (honor `VALIDATOR_DB_PATH` for tests).

---

## File Structure

**Backend (`DashBoard/`)**
- Create `logs_db.py` — `presence` / `login_events` / `change_log` storage + queries.
- Modify `annotations_db.py` — `save()` returns `(result, changes)` (field-level diffs).
- Modify `sql_backend.py` — import+init `logs_db`; login hook; unpack save + write change log; `/ping` + `/admin/presence` + `/admin/logins` + `/admin/changes`.
- Modify `tests/conftest.py` — wire `logs_db` into the `db` fixture.
- Create `tests/test_logs_db.py`, `tests/test_annotations_db.py`; extend `tests/test_permissions_routes.py`.

**Frontend (`DashBoard/frontend/src/`)**
- Modify `lib/types.ts` — `AppView` type + log result types.
- Modify `lib/api.ts` — `ping`, `fetchPresence`, `fetchLogins`, `fetchChanges`.
- Create `hooks/usePresenceHeartbeat.tsx` — 30s heartbeat while logged in.
- Create `components/LogDashboard.tsx` — the three-panel Log view.
- Modify `components/Header.tsx` — `Log | Compare Data` switcher (admins only).
- Modify `App.tsx` — `view` state, landing chooser, mount heartbeat, render Log/compare.

---

## Task 1: `logs_db.py` foundation + presence

**Files:**
- Create: `DashBoard/logs_db.py`
- Modify: `DashBoard/tests/conftest.py`
- Create: `DashBoard/tests/test_logs_db.py`

**Interfaces:**
- Produces: `logs_db.DB_PATH`, `logs_db._connect()`, `logs_db.init_db()` (creates `presence`, `login_events`, `change_log`), `logs_db.touch_presence(username, display_name)`, `logs_db.active_users(within_seconds=120) -> list[dict]` (`{username, display_name, last_seen, seconds_ago}`, most-recent first).
- Produces (conftest): the `db` fixture also points `logs_db.DB_PATH` at the temp file and calls `logs_db.init_db()`.

- [ ] **Step 1: Extend the `db` fixture in `DashBoard/tests/conftest.py`**

Replace the existing `db` fixture body so it also wires `logs_db`:

```python
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
```

- [ ] **Step 2: Write the failing presence test — create `DashBoard/tests/test_logs_db.py`**

```python
import logs_db


def test_init_db_creates_tables(db):
    conn = logs_db._connect()
    try:
        names = {
            r["name"]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
    finally:
        conn.close()
    assert {"presence", "login_events", "change_log"} <= names


def test_presence_touch_and_active(db):
    logs_db.touch_presence("somsak", "Somsak S.")
    active = logs_db.active_users(within_seconds=120)
    assert len(active) == 1
    assert active[0]["username"] == "somsak"
    assert active[0]["display_name"] == "Somsak S."
    assert active[0]["seconds_ago"] >= 0


def test_presence_excludes_stale(db):
    # A user last seen well outside the window must not appear.
    conn = logs_db._connect()
    try:
        conn.execute(
            "INSERT INTO presence (username, display_name, last_seen) VALUES (?, ?, ?)",
            ("old", "Old User", "2000-01-01T00:00:00+00:00"),
        )
        conn.commit()
    finally:
        conn.close()
    assert logs_db.active_users(within_seconds=120) == []


def test_presence_upsert_updates_last_seen(db):
    logs_db.touch_presence("somsak", "Somsak S.")
    first = logs_db.active_users()[0]["last_seen"]
    logs_db.touch_presence("somsak", "Somsak S.")
    # Still one row (upsert, not insert), last_seen >= the first.
    active = logs_db.active_users()
    assert len(active) == 1
    assert active[0]["last_seen"] >= first
```

- [ ] **Step 3: Run — confirm it fails**

Run from `DashBoard/`: `python -m pytest tests/test_logs_db.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'logs_db'`.

- [ ] **Step 4: Create `DashBoard/logs_db.py`**

```python
"""
SQLite persistence for the admin Log page: live presence, login history, and the
annotation change history. Reuses annotations.db (same WAL / busy-timeout setup
as annotations_db.py / groups_db.py). Overridable via VALIDATOR_DB_PATH for tests.

Three tables:
  presence      — one row per user, upserted on each heartbeat (who is online now)
  login_events  — one row per successful login (login history)
  change_log    — one row per changed annotation field (full audit trail)

All timestamps are ISO-8601 UTC (seconds). "A day" is a local calendar day.
"""
import os
import sqlite3
from datetime import datetime, timedelta, timezone

DB_PATH = os.getenv("VALIDATOR_DB_PATH") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "annotations.db"
)


def _connect():
    conn = sqlite3.connect(DB_PATH, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def today():
    """Local calendar day as 'YYYY-MM-DD' (matches how a user thinks about today)."""
    return datetime.now().astimezone().strftime("%Y-%m-%d")


def init_db():
    conn = _connect()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS presence (
                username     TEXT PRIMARY KEY,
                display_name TEXT NOT NULL DEFAULT '',
                last_seen    TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS login_events (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                at           TEXT NOT NULL,
                username     TEXT NOT NULL,
                display_name TEXT NOT NULL DEFAULT '',
                source       TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS change_log (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                at         TEXT NOT NULL,
                username   TEXT NOT NULL,
                row_key    TEXT NOT NULL,
                field      TEXT NOT NULL,
                old_value  TEXT NOT NULL DEFAULT '',
                new_value  TEXT NOT NULL DEFAULT ''
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def touch_presence(username, display_name):
    """Record that `username` is active right now (upsert last_seen = now)."""
    user = (username or "").strip()
    if not user:
        return
    conn = _connect()
    try:
        conn.execute(
            """
            INSERT INTO presence (username, display_name, last_seen)
            VALUES (?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
                display_name = excluded.display_name,
                last_seen    = excluded.last_seen
            """,
            (user, display_name or "", _now()),
        )
        conn.commit()
    finally:
        conn.close()


def active_users(within_seconds=120):
    """Users whose last_seen is within the window, most-recent first."""
    cutoff = (datetime.now(timezone.utc) - timedelta(seconds=within_seconds)).isoformat(
        timespec="seconds"
    )
    now = datetime.now(timezone.utc)
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT username, display_name, last_seen FROM presence "
            "WHERE last_seen >= ? ORDER BY last_seen DESC",
            (cutoff,),
        ).fetchall()
    finally:
        conn.close()
    out = []
    for r in rows:
        try:
            seen = datetime.fromisoformat(r["last_seen"])
            secs = max(0, int((now - seen).total_seconds()))
        except ValueError:
            secs = 0
        out.append(
            {
                "username": r["username"],
                "display_name": r["display_name"],
                "last_seen": r["last_seen"],
                "seconds_ago": secs,
            }
        )
    return out
```

- [ ] **Step 5: Run — confirm all pass**

Run from `DashBoard/`: `python -m pytest tests/test_logs_db.py -v`
Expected: PASS (4 passed).

- [ ] **Step 6: Commit** (skip if no git)

```bash
git add logs_db.py tests/conftest.py tests/test_logs_db.py
git commit -m "feat(logs): logs_db foundation + presence tracking"
```

---

## Task 2: login history + change history storage

**Files:**
- Modify: `DashBoard/logs_db.py`
- Modify: `DashBoard/tests/test_logs_db.py`

**Interfaces:**
- Produces:
  - `record_login(username, display_name, source) -> None`
  - `logins_for_day(day) -> list[dict]` (`{at, username, display_name, source}`, newest first; `day` = 'YYYY-MM-DD' local; bad date raises `ValueError`)
  - `record_changes(username, changes) -> None` (`changes` = list of `{row_key, field, old_value, new_value}`; stamps `at=now`; empty list = no-op)
  - `changes_for_day(day) -> list[dict]` (`{at, username, row_key, field, old_value, new_value}`, newest first)

- [ ] **Step 1: Append the failing tests to `DashBoard/tests/test_logs_db.py`**

```python
def test_login_history_for_day(db):
    logs_db.record_login("somsak", "Somsak S.", "ad")
    logs_db.record_login("naree", "Naree", "ad")
    todays = logs_db.logins_for_day(logs_db.today())
    users = [r["username"] for r in todays]
    assert "somsak" in users and "naree" in users
    # A different day has nothing.
    assert logs_db.logins_for_day("2000-01-01") == []


def test_change_history_for_day(db):
    logs_db.record_changes(
        "somsak",
        [
            {"row_key": "hit|ho26|x", "field": "Error From", "old_value": "", "new_value": "Wisdom"},
            {"row_key": "hit|ho26|x", "field": "Done", "old_value": "false", "new_value": "true"},
        ],
    )
    todays = logs_db.changes_for_day(logs_db.today())
    assert len(todays) == 2
    assert todays[0]["username"] == "somsak"
    fields = {r["field"] for r in todays}
    assert fields == {"Error From", "Done"}
    assert logs_db.changes_for_day("2000-01-01") == []


def test_record_changes_empty_is_noop(db):
    logs_db.record_changes("somsak", [])
    assert logs_db.changes_for_day(logs_db.today()) == []


def test_bad_day_raises(db):
    import pytest
    with pytest.raises(ValueError):
        logs_db.logins_for_day("not-a-date")
```

- [ ] **Step 2: Run — confirm failure**

Run: `python -m pytest tests/test_logs_db.py -k "login_history or change_history or noop or bad_day" -v`
Expected: FAIL — `AttributeError: module 'logs_db' has no attribute 'record_login'`.

- [ ] **Step 3: Append to `DashBoard/logs_db.py`**

```python
def _day_bounds_utc(day):
    """(start_utc_iso, end_utc_iso) for the LOCAL calendar day 'YYYY-MM-DD'.
    Raises ValueError if `day` isn't a valid date."""
    start_local = datetime.strptime(day, "%Y-%m-%d").astimezone()  # local midnight, tz-aware
    end_local = start_local + timedelta(days=1)
    start = start_local.astimezone(timezone.utc).isoformat(timespec="seconds")
    end = end_local.astimezone(timezone.utc).isoformat(timespec="seconds")
    return start, end


def record_login(username, display_name, source):
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO login_events (at, username, display_name, source) VALUES (?, ?, ?, ?)",
            (_now(), (username or "").strip(), display_name or "", source or ""),
        )
        conn.commit()
    finally:
        conn.close()


def logins_for_day(day):
    start, end = _day_bounds_utc(day)
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT at, username, display_name, source FROM login_events "
            "WHERE at >= ? AND at < ? ORDER BY at DESC",
            (start, end),
        ).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]


def record_changes(username, changes):
    if not changes:
        return
    now = _now()
    user = (username or "").strip()
    conn = _connect()
    try:
        conn.executemany(
            "INSERT INTO change_log (at, username, row_key, field, old_value, new_value) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            [
                (now, user, c["row_key"], c["field"], c.get("old_value", ""), c.get("new_value", ""))
                for c in changes
            ],
        )
        conn.commit()
    finally:
        conn.close()


def changes_for_day(day):
    start, end = _day_bounds_utc(day)
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT at, username, row_key, field, old_value, new_value FROM change_log "
            "WHERE at >= ? AND at < ? ORDER BY at DESC, id DESC",
            (start, end),
        ).fetchall()
    finally:
        conn.close()
    return [dict(r) for r in rows]
```

- [ ] **Step 4: Run — confirm all pass**

Run: `python -m pytest tests/test_logs_db.py -v`
Expected: PASS (8 passed).

- [ ] **Step 5: Commit** (skip if no git)

```bash
git add logs_db.py tests/test_logs_db.py
git commit -m "feat(logs): login history + change history storage"
```

---

## Task 3: capture changes + logins (wire into save + login)

**Files:**
- Modify: `DashBoard/annotations_db.py` (the `save` function)
- Modify: `DashBoard/sql_backend.py` (imports/init, login hook, save route)
- Create: `DashBoard/tests/test_annotations_db.py`
- Modify: `DashBoard/tests/test_permissions_routes.py`

**Interfaces:**
- Consumes: `logs_db.record_login`, `logs_db.record_changes`, `logs_db.init_db`, `logs_db.changes_for_day`.
- Produces: `annotations_db.save(scope, items, saved_by)` now returns **`(result, changes)`** where `changes` is a list of `{row_key, field, old_value, new_value}`. `POST /annotations` writes those to `change_log`; `/login` writes a `login_events` row.

- [ ] **Step 1: Write the failing save-diff test — create `DashBoard/tests/test_annotations_db.py`**

```python
import annotations_db

SCOPE = "shared"


def _save(items, by="somsak"):
    return annotations_db.save(SCOPE, items, by)


def test_save_returns_result_and_changes_for_new_value(db):
    result, changes = _save({"r1": {"error_from": "Wisdom", "done": False}})
    assert "r1" in result
    assert changes == [
        {"row_key": "r1", "field": "Error From", "old_value": "", "new_value": "Wisdom"}
    ]


def test_save_logs_done_toggle(db):
    _save({"r1": {"error_from": "Wisdom", "done": False}})
    _, changes = _save({"r1": {"error_from": "Wisdom", "done": True}})
    assert changes == [
        {"row_key": "r1", "field": "Done", "old_value": "false", "new_value": "true"}
    ]


def test_save_noop_has_no_changes(db):
    _save({"r1": {"error_from": "Wisdom", "done": True}})
    _, changes = _save({"r1": {"error_from": "Wisdom", "done": True}})
    assert changes == []


def test_save_clear_logs_transition_to_empty(db):
    _save({"r1": {"error_from": "Wisdom", "done": True}})
    _, changes = _save({"r1": {"error_from": "", "done": False}})  # cleared → deleted
    assert {"row_key": "r1", "field": "Error From", "old_value": "Wisdom", "new_value": ""} in changes
    assert {"row_key": "r1", "field": "Done", "old_value": "true", "new_value": "false"} in changes
    assert "r1" not in annotations_db.get_all(SCOPE)
```

- [ ] **Step 2: Run — confirm failure**

Run: `python -m pytest tests/test_annotations_db.py -v`
Expected: FAIL — `save()` returns a dict, not a `(result, changes)` tuple (unpack/assertion errors).

- [ ] **Step 3: Rewrite `save()` in `DashBoard/annotations_db.py`**

Replace the entire `save` function (from `def save(scope, items, saved_by):` through its `return get_all(scope)`) with:

```python
def save(scope, items, saved_by):
    """Upsert/delete annotations for a scope; return (fresh_full_set, changes).

    `items` = { row_key: {error_from, done} }.
      - A blank row (error_from empty AND done false) is DELETED — the user cleared it.
      - A changed value is stamped with saved_by / saved_at (now, UTC).
      - An unchanged value keeps its original attribution.

    `changes` is a list of {row_key, field, old_value, new_value} for every field
    that actually changed (including a row being cleared) — the audit trail. `field`
    is 'Error From' or 'Done'; Done values are the strings 'true'/'false'; an
    unassigned Error From is ''.
    """
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    existing = get_all(scope)
    changes = []
    conn = _connect()
    try:
        for row_key, val in items.items():
            error_from = (val.get("error_from") or "").strip()
            done = 1 if val.get("done") else 0

            prev = existing.get(row_key)
            prev_error = prev["error_from"] if prev else ""
            prev_done = bool(prev["done"]) if prev else False

            if not error_from and not done:
                # Row cleared → log the transition to empty for any field that had a value.
                if prev is not None:
                    if prev_error != "":
                        changes.append({"row_key": row_key, "field": "Error From",
                                        "old_value": prev_error, "new_value": ""})
                    if prev_done:
                        changes.append({"row_key": row_key, "field": "Done",
                                        "old_value": "true", "new_value": "false"})
                conn.execute(
                    "DELETE FROM annotations WHERE scope = ? AND row_key = ?",
                    (scope, row_key),
                )
                continue

            new_done = bool(done)
            if prev_error != error_from:
                changes.append({"row_key": row_key, "field": "Error From",
                                "old_value": prev_error, "new_value": error_from})
            if prev_done != new_done:
                changes.append({"row_key": row_key, "field": "Done",
                                "old_value": "true" if prev_done else "false",
                                "new_value": "true" if new_done else "false"})

            changed = (
                prev is None
                or prev["error_from"] != error_from
                or (1 if prev["done"] else 0) != done
            )
            by, at = (saved_by, now) if changed else (prev["saved_by"], prev["saved_at"])

            conn.execute(
                """
                INSERT INTO annotations (scope, row_key, error_from, done, saved_by, saved_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(scope, row_key) DO UPDATE SET
                    error_from = excluded.error_from,
                    done       = excluded.done,
                    saved_by   = excluded.saved_by,
                    saved_at   = excluded.saved_at
                """,
                (scope, row_key, error_from, done, by, at),
            )
        conn.commit()
    finally:
        conn.close()
    return get_all(scope), changes
```

- [ ] **Step 4: Run — confirm the save-diff tests pass**

Run: `python -m pytest tests/test_annotations_db.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Wire logs into `sql_backend.py`**

(a) After `import groups_db` at the top, add:
```python
import logs_db
```
(b) After `groups_db.init_db()` (near the other init calls), add:
```python
logs_db.init_db()
```
(c) In the `login()` view, right after the `session["user"] = {...}` assignment block and before `return jsonify({"user": session["user"]})`, add:
```python
    logs_db.record_login(
        profile["username"], profile.get("display_name", ""), profile.get("source", "")
    )
```
(d) In `save_annotations()`, change the save call + return. Replace:
```python
    saved_by = (session.get("user") or {}).get("username") or "unknown"
    result = annotations_db.save(ANNOTATION_SCOPE, items, saved_by)
    return jsonify({"annotations": result})
```
with:
```python
    saved_by = (session.get("user") or {}).get("username") or "unknown"
    result, changes = annotations_db.save(ANNOTATION_SCOPE, items, saved_by)
    logs_db.record_changes(saved_by, changes)
    return jsonify({"annotations": result})
```

- [ ] **Step 6: Add a route-level change-logging test — append to `DashBoard/tests/test_permissions_routes.py`**

```python
def test_saving_annotations_records_change_log(client):
    import logs_db
    from conftest import login_as

    login_as(client, can_edit=True, username="somsak")
    resp = client.post(
        "/annotations", json={"annotations": {"rk1": {"error_from": "Wisdom", "done": True}}}
    )
    assert resp.status_code == 200
    changes = logs_db.changes_for_day(logs_db.today())
    fields = {(c["username"], c["field"], c["new_value"]) for c in changes}
    assert ("somsak", "Error From", "Wisdom") in fields
    assert ("somsak", "Done", "true") in fields
```

- [ ] **Step 7: Run the whole backend suite**

Run: `python -m pytest tests/ -v`
Expected: PASS (all green — the previously-passing route tests still pass because `save_annotations` returns the same JSON shape; the new tests pass).

- [ ] **Step 8: Commit** (skip if no git)

```bash
git add annotations_db.py sql_backend.py tests/test_annotations_db.py tests/test_permissions_routes.py
git commit -m "feat(logs): capture annotation changes + record logins"
```

---

## Task 4: admin read routes + heartbeat

**Files:**
- Modify: `DashBoard/sql_backend.py`
- Modify: `DashBoard/tests/test_permissions_routes.py`

**Interfaces:**
- Consumes: `logs_db.touch_presence/active_users/logins_for_day/changes_for_day/today`, `require_manage`, `login_required`.
- Produces routes:
  - `POST /ping` (`@login_required`) → `{"ok": true}`, upserts presence for the session user.
  - `GET /admin/presence` (`@require_manage`) → `{"active": [...]}`.
  - `GET /admin/logins?date=YYYY-MM-DD` (`@require_manage`) → `{"logins": [...]}` (default today; bad date → today).
  - `GET /admin/changes?date=YYYY-MM-DD` (`@require_manage`) → `{"changes": [...]}` (default today; bad date → today).

- [ ] **Step 1: Write the failing route tests — append to `DashBoard/tests/test_permissions_routes.py`**

```python
def test_ping_requires_login_then_updates_presence(client):
    from conftest import login_as

    assert client.post("/ping").status_code == 401  # no session

    login_as(client, username="somsak")
    assert client.post("/ping").status_code == 200

    # Presence is admin-only to read; use a manager session to verify.
    login_as(client, can_manage=True, username="admin")
    active = client.get("/admin/presence").get_json()["active"]
    assert any(u["username"] == "somsak" for u in active)


def test_admin_log_routes_require_manage(client):
    from conftest import login_as

    login_as(client, can_edit=True, can_manage=False)
    assert client.get("/admin/presence").status_code == 403
    assert client.get("/admin/logins").status_code == 403
    assert client.get("/admin/changes").status_code == 403


def test_admin_logins_and_changes_default_today(client):
    from conftest import login_as

    login_as(client, can_manage=True)
    r = client.get("/admin/logins")
    assert r.status_code == 200 and "logins" in r.get_json()
    r = client.get("/admin/changes?date=not-a-date")  # bad date must not 500
    assert r.status_code == 200 and "changes" in r.get_json()
```

- [ ] **Step 2: Run — confirm failure**

Run: `python -m pytest tests/test_permissions_routes.py -k "ping or admin_log or default_today" -v`
Expected: FAIL — 404 (routes don't exist).

- [ ] **Step 3: Add the routes to `sql_backend.py`**

After the group-management routes block (before the `# SQL Server connection details` section), add:

```python
# ── Admin log page (presence / logins / change history) ───────────────────────
@app.route("/ping", methods=["POST"])
@login_required
def ping():
    user = session.get("user") or {}
    logs_db.touch_presence(user.get("username", ""), user.get("display_name", ""))
    return jsonify({"ok": True})


@app.route("/admin/presence", methods=["GET"])
@require_manage
def admin_presence():
    return jsonify({"active": logs_db.active_users(within_seconds=120)})


@app.route("/admin/logins", methods=["GET"])
@require_manage
def admin_logins():
    day = (request.args.get("date") or "").strip() or logs_db.today()
    try:
        logins = logs_db.logins_for_day(day)
    except ValueError:
        logins = logs_db.logins_for_day(logs_db.today())
    return jsonify({"logins": logins})


@app.route("/admin/changes", methods=["GET"])
@require_manage
def admin_changes():
    day = (request.args.get("date") or "").strip() or logs_db.today()
    try:
        changes = logs_db.changes_for_day(day)
    except ValueError:
        changes = logs_db.changes_for_day(logs_db.today())
    return jsonify({"changes": changes})
```

- [ ] **Step 4: Run the whole backend suite**

Run: `python -m pytest tests/ -v`
Expected: PASS (all green).

- [ ] **Step 5: Commit** (skip if no git)

```bash
git add sql_backend.py tests/test_permissions_routes.py
git commit -m "feat(logs): heartbeat + admin presence/logins/changes routes"
```

---

## Task 5: frontend API client + types

**Files:**
- Modify: `DashBoard/frontend/src/lib/types.ts`
- Modify: `DashBoard/frontend/src/lib/api.ts`

**Interfaces:**
- Produces (types.ts): `export type AppView = 'menu' | 'log' | 'compare';` and `ActiveUser`, `LoginEvent`, `ChangeEvent`.
- Produces (api.ts): `ping()`, `fetchPresence(): Promise<ActiveUser[]>`, `fetchLogins(date: string): Promise<LoginEvent[]>`, `fetchChanges(date: string): Promise<ChangeEvent[]>`.

- [ ] **Step 1: Add types to `DashBoard/frontend/src/lib/types.ts`**

Append at the end of the file:

```typescript
// Which top-level view an admin is looking at (see App.tsx / Header.tsx).
export type AppView = 'menu' | 'log' | 'compare';

// Admin Log page payloads (snake_case = straight from the backend JSON).
export interface ActiveUser {
  username: string;
  display_name: string;
  last_seen: string;
  seconds_ago: number;
}
export interface LoginEvent {
  at: string;
  username: string;
  display_name: string;
  source: string;
}
export interface ChangeEvent {
  at: string;
  username: string;
  row_key: string;
  field: string;
  old_value: string;
  new_value: string;
}
```

- [ ] **Step 2: Add the API functions to `DashBoard/frontend/src/lib/api.ts`**

Add the import at the top (extend the existing `import type { ... } from './types';` line to include the new types), then append this block before `export const backendUrl = BACKEND_URL;`:

```typescript
// ── Admin log page ────────────────────────────────────────────────────────────
// Heartbeat: fire-and-forget; a failed ping just means "not seen right now".
export function ping(): void {
  fetch(`${BACKEND_URL}/ping`, { ...CREDS, method: 'POST' }).catch(() => {});
}

async function adminGet<T>(path: string, key: string): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, CREDS);
  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new Error('Your session expired — please sign in again.');
  }
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data[key] as T;
}

export const fetchPresence = () => adminGet<ActiveUser[]>('/admin/presence', 'active');
export const fetchLogins = (date: string) =>
  adminGet<LoginEvent[]>(`/admin/logins?date=${encodeURIComponent(date)}`, 'logins');
export const fetchChanges = (date: string) =>
  adminGet<ChangeEvent[]>(`/admin/changes?date=${encodeURIComponent(date)}`, 'changes');
```

Update the type import line to add `ActiveUser, LoginEvent, ChangeEvent` (it currently imports `AuthUser, RowAnnotation, TableData`):

```typescript
import type { ActiveUser, AuthUser, ChangeEvent, LoginEvent, RowAnnotation, TableData } from './types';
```

- [ ] **Step 3: Typecheck**

Run from `DashBoard/frontend/`: `npm run build`
Expected: build succeeds (nothing consumes the new exports yet).

- [ ] **Step 4: Commit** (skip if no git)

```bash
cd "…/DashBoard" && git add frontend/src/lib/types.ts frontend/src/lib/api.ts
git commit -m "feat(fe): admin-log API client + types"
```

---

## Task 6: presence heartbeat hook

**Files:**
- Create: `DashBoard/frontend/src/hooks/usePresenceHeartbeat.tsx`
- Modify: `DashBoard/frontend/src/App.tsx`

**Interfaces:**
- Consumes: `ping()` (Task 5).
- Produces: `usePresenceHeartbeat(intervalMs?: number)` — pings immediately then every `intervalMs` (default 30000) while mounted. Mounted inside `AppInner` (only rendered when logged in).

- [ ] **Step 1: Create the hook — `DashBoard/frontend/src/hooks/usePresenceHeartbeat.tsx`**

```tsx
/**
 * While the app is open (mounted, i.e. logged in), tell the backend the current
 * user is active — an immediate ping plus one every `intervalMs`. Powers the
 * admin Log page's "online now" list. Fire-and-forget; failures are ignored.
 */
import { useEffect } from 'react';
import { ping } from '../lib/api';

export function usePresenceHeartbeat(intervalMs = 30000) {
  useEffect(() => {
    ping();
    const id = setInterval(ping, intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}
```

- [ ] **Step 2: Mount it in `AppInner`**

In `DashBoard/frontend/src/App.tsx`, add the import with the other hook imports:
```typescript
import { usePresenceHeartbeat } from './hooks/usePresenceHeartbeat';
```
Then at the top of `AppInner()`, right after `const canEdit = !!user?.perms?.can_edit;`, add:
```typescript
  usePresenceHeartbeat();
```

- [ ] **Step 3: Typecheck**

Run from `DashBoard/frontend/`: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit** (skip if no git)

```bash
cd "…/DashBoard" && git add frontend/src/hooks/usePresenceHeartbeat.tsx frontend/src/App.tsx
git commit -m "feat(fe): presence heartbeat while logged in"
```

---

## Task 7: LogDashboard component

**Files:**
- Create: `DashBoard/frontend/src/components/LogDashboard.tsx`

**Interfaces:**
- Consumes: `fetchPresence`, `fetchLogins`, `fetchChanges`, `ActiveUser`, `LoginEvent`, `ChangeEvent` (Task 5); `useToast`.
- Produces: default-exported `LogDashboard()` — three panels; online auto-refreshes every 15s; logins/changes driven by a date picker defaulting to local today.

- [ ] **Step 1: Create `DashBoard/frontend/src/components/LogDashboard.tsx`**

```tsx
/**
 * Admin-only Log view (reached from the header switcher / landing chooser).
 * Three panels: who's online now (live, auto-refreshing), who logged in on a
 * chosen day, and the full annotation change history for that day. Read-only.
 * Every call is manager-gated on the backend.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  fetchChanges,
  fetchLogins,
  fetchPresence,
  type ActiveUser,
  type ChangeEvent,
  type LoginEvent,
} from '../lib/api';
import { useToast } from '../hooks/useToast';

// Local 'YYYY-MM-DD' for the date input's default (matches the backend's local day).
const todayLocal = () => new Date().toLocaleDateString('en-CA');
const timeOf = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
};

export default function LogDashboard() {
  const toast = useToast();
  const [active, setActive] = useState<ActiveUser[]>([]);
  const [day, setDay] = useState(todayLocal());
  const [logins, setLogins] = useState<LoginEvent[]>([]);
  const [changes, setChanges] = useState<ChangeEvent[]>([]);

  // Live "online now" — refresh every 15s.
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchPresence()
        .then((a) => alive && setActive(a))
        .catch((err) => alive && toast((err as Error).message, 'err'));
    load();
    const id = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [toast]);

  // Logins + changes for the selected day.
  const loadDay = useCallback(() => {
    fetchLogins(day)
      .then(setLogins)
      .catch((err) => toast((err as Error).message, 'err'));
    fetchChanges(day)
      .then(setChanges)
      .catch((err) => toast((err as Error).message, 'err'));
  }, [day, toast]);

  useEffect(() => loadDay(), [loadDay]);

  return (
    <div className="log-dashboard" style={{ padding: '18px 24px', display: 'grid', gap: 22 }}>
      {/* Online now */}
      <section>
        <h2 style={{ margin: '0 0 8px' }}>
          Online now <span style={{ fontSize: '.7rem', color: 'var(--muted)' }}>(last 2 min · live)</span>
        </h2>
        {active.length === 0 ? (
          <p style={{ opacity: 0.7 }}>Nobody active right now.</p>
        ) : (
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {active.map((u) => (
              <li key={u.username}>
                <strong>{u.display_name || u.username}</strong>{' '}
                <span style={{ color: 'var(--muted)' }}>({u.username})</span> — active{' '}
                {u.seconds_ago < 60 ? `${u.seconds_ago}s` : `${Math.floor(u.seconds_ago / 60)}m`} ago
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Day picker */}
      <section style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <label>Day:</label>
        <input
          className="filter-select"
          type="date"
          value={day}
          max={todayLocal()}
          onChange={(e) => setDay(e.target.value || todayLocal())}
        />
      </section>

      {/* Logins */}
      <section>
        <h2 style={{ margin: '0 0 8px' }}>Logins ({logins.length})</h2>
        {logins.length === 0 ? (
          <p style={{ opacity: 0.7 }}>No logins on this day.</p>
        ) : (
          <table className="result" style={{ width: 'auto' }}>
            <thead>
              <tr>
                <th>Time</th>
                <th>User</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {logins.map((l, i) => (
                <tr key={i}>
                  <td>{timeOf(l.at)}</td>
                  <td title={l.username}>{l.display_name || l.username}</td>
                  <td>{l.source}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Changes */}
      <section>
        <h2 style={{ margin: '0 0 8px' }}>Changes ({changes.length})</h2>
        {changes.length === 0 ? (
          <p style={{ opacity: 0.7 }}>No changes on this day.</p>
        ) : (
          <table className="result" style={{ width: 'auto' }}>
            <thead>
              <tr>
                <th>Time</th>
                <th>Who</th>
                <th>Row</th>
                <th>Field</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c, i) => (
                <tr key={i}>
                  <td>{timeOf(c.at)}</td>
                  <td>{c.username}</td>
                  <td title={c.row_key} style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.row_key}
                  </td>
                  <td>{c.field}</td>
                  <td>
                    <span style={{ color: 'var(--muted)' }}>{c.old_value || '—'}</span> →{' '}
                    <strong>{c.new_value || '—'}</strong>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run from `DashBoard/frontend/`: `npm run build`
Expected: build succeeds (the component compiles even though nothing imports it yet).

- [ ] **Step 3: Commit** (skip if no git)

```bash
cd "…/DashBoard" && git add frontend/src/components/LogDashboard.tsx
git commit -m "feat(fe): LogDashboard (online now / logins / changes)"
```

---

## Task 8: landing chooser + header switcher + view routing

**Files:**
- Modify: `DashBoard/frontend/src/components/Header.tsx`
- Modify: `DashBoard/frontend/src/App.tsx`

**Interfaces:**
- Consumes: `LogDashboard` (Task 7), `AppView` (Task 5), `usePresenceHeartbeat` (already mounted), `useAuth`.
- Produces: admins land on `view='menu'` (a 2-card chooser); the header shows a `Log | Compare Data` switcher for `can_manage`; non-admins stay on `view='compare'` and see neither.

- [ ] **Step 1: Add the switcher to `Header.tsx`**

In `DashBoard/frontend/src/components/Header.tsx`, replace the component signature and the `header-user` block to accept `view` / `onSetView` and render the switcher. Replace the whole component with:

```tsx
import { useAuth } from '../hooks/useAuth';
import type { AppView } from '../lib/types';

interface HeaderProps {
  onOpenGroups?: () => void;
  view?: AppView;
  onSetView?: (v: AppView) => void;
}

export default function Header({ onOpenGroups, view, onSetView }: HeaderProps) {
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
          {user.perms?.can_manage && onSetView && (
            <span style={{ display: 'inline-flex', gap: 4, marginRight: 4 }}>
              <button
                className={`btn btn-ghost${view === 'log' ? ' active' : ''}`}
                onClick={() => onSetView('log')}
                title="Admin log: who's online, logins, changes"
              >
                Log
              </button>
              <button
                className={`btn btn-ghost${view === 'compare' ? ' active' : ''}`}
                onClick={() => onSetView('compare')}
                title="The validator / compare-data view"
              >
                Compare Data
              </button>
            </span>
          )}
          {user.perms?.can_manage && onOpenGroups && (
            <button className="btn btn-ghost" onClick={onOpenGroups} title="Manage groups & permissions">
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

- [ ] **Step 2: Add view routing to `App.tsx`**

In `DashBoard/frontend/src/App.tsx`:

(a) Add imports (with the other component imports):
```typescript
import LogDashboard from './components/LogDashboard';
import type { AppView } from './lib/types';
```

(b) At the top of `AppInner()`, right after `const canEdit = !!user?.perms?.can_edit;`, add:
```typescript
  const canManage = !!user?.perms?.can_manage;
  const [view, setView] = useState<AppView>(canManage ? 'menu' : 'compare');
```

(c) Just before the existing `if (adminOpen) {` block, define a reusable header element and the chooser/log branches. Replace this existing code:
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
```
with:
```tsx
  const header = (
    <Header onOpenGroups={() => setAdminOpen(true)} view={view} onSetView={setView} />
  );

  if (adminOpen) {
    return (
      <div className="app">
        {header}
        <GroupAdmin onClose={() => setAdminOpen(false)} />
      </div>
    );
  }

  if (view === 'menu') {
    return (
      <div className="app">
        {header}
        <div className="landing-chooser" style={{ display: 'flex', gap: 20, padding: 40, flexWrap: 'wrap' }}>
          <button
            className="btn btn-ghost"
            style={{ flex: '1 1 260px', minHeight: 140, fontSize: '1.1rem', flexDirection: 'column', gap: 6 }}
            onClick={() => setView('log')}
          >
            <strong>Dashboard-Log</strong>
            <span style={{ fontSize: '.8rem', color: 'var(--muted)' }}>
              Who's online, logins, and change history
            </span>
          </button>
          <button
            className="btn btn-ghost"
            style={{ flex: '1 1 260px', minHeight: 140, fontSize: '1.1rem', flexDirection: 'column', gap: 6 }}
            onClick={() => setView('compare')}
          >
            <strong>Dashboard-Compare-Data</strong>
            <span style={{ fontSize: '.8rem', color: 'var(--muted)' }}>
              The 3-way validator
            </span>
          </button>
        </div>
      </div>
    );
  }

  if (view === 'log') {
    return (
      <div className="app">
        {header}
        <LogDashboard />
      </div>
    );
  }

  return (
    <div className="app">
      {header}
```

(The rest of the existing `return (...)` — `UploadStrip`, `KeyInfoPanel`, results — is unchanged; it now renders only when `view === 'compare'`.)

- [ ] **Step 3: Typecheck**

Run from `DashBoard/frontend/`: `npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit** (skip if no git)

```bash
cd "…/DashBoard" && git add frontend/src/components/Header.tsx frontend/src/App.tsx
git commit -m "feat(fe): landing chooser + Log/Compare header switcher"
```

---

## Task 9: End-to-end manual verification

**Files:** none (manual QA)

- [ ] **Step 1: Start both servers** (backend `python sql_backend.py` in `DashBoard/`; frontend `npm run dev` in `frontend/`).

- [ ] **Step 2: Admin path** — log in as `admin.user` (INITIAL_ADMINS). Confirm:
  - You land on the **two-card chooser** (Dashboard-Log / Dashboard-Compare-Data).
  - Header shows a **`Log | Compare Data`** switcher (and the Groups button).
  - Open **Log** → "Online now" lists you within ~30s; the **date** defaults to today.
  - In another browser/incognito, log in as a second user, make an edit in Compare-Data and Save → back on the admin's **Log**, the second user appears in "Online now" and the edit appears under **Changes** (who, field, old → new); both logins appear under **Logins**.

- [ ] **Step 3: Non-admin path** — log in as a user in no group (or read-only group). Confirm: **no chooser** (straight to Compare-Data), **no `Log` switcher**, no Groups button. Browsing `/#` — there's no client route to the Log; the backend also returns **403** for `/admin/*`.

- [ ] **Step 4: Server-side enforcement spot check** (as the read-only user, in devtools console):
```js
fetch(`${location.protocol}//${location.hostname}:5001/admin/changes`, { credentials: 'include' })
  .then(r => console.log('status', r.status)); // expect 403
```

- [ ] **Step 5: Final backend suite** — from `DashBoard/`: `python -m pytest tests/ -v` → all green.

---

## Self-Review (completed while writing)

- **Spec coverage:** landing chooser + switcher (Task 8); admin = can_manage (Tasks 4/8 via `require_manage` / `can_manage`); online-now + heartbeat (Tasks 1/4/6/7); login history (Tasks 2/3/4/7); full change history incl. clearing (Tasks 2/3/7); `logs_db` in `annotations.db` (Task 1); server-side enforcement (Task 4, verified Task 9); default knobs (Global Constraints + Tasks 6/7); non-admin bypass (Task 8, verified Task 9). Non-goals (no read/export logging, no push, no pruning, read-only log) are respected — nothing builds them.
- **Placeholder scan:** none — every code step is complete.
- **Type consistency:** `save()` returns `(result, changes)` in Task 3 and is unpacked in the same task's route edit; `changes` item shape `{row_key, field, old_value, new_value}` matches `record_changes` (Task 2) and the tests. Frontend `AppView` defined in types.ts (Task 5) and consumed by Header + App (Task 8). `ActiveUser/LoginEvent/ChangeEvent` shapes match the backend JSON keys (`active`/`logins`/`changes`).
