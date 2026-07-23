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
    """Open a SQLite connection to annotations.db (WAL, 5s busy-timeout, foreign keys on)."""
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


def _now():
    """Current UTC timestamp as an ISO-8601 string (seconds precision)."""
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
    """Set a group's can_edit / can_manage flags (no-op if the group doesn't exist)."""
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
    """Delete a group and all of its members."""
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
    """Remove one AD username from a group (case-insensitive match)."""
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


def _initial_admins():
    """The set of always-admin usernames from INITIAL_ADMINS (.env), casefolded."""
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
