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
    """Open a SQLite connection to annotations.db (WAL, 5s busy-timeout)."""
    conn = sqlite3.connect(DB_PATH, timeout=5.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def _now():
    """Current UTC timestamp as an ISO-8601 string (seconds precision)."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def today():
    """Local calendar day as 'YYYY-MM-DD' (matches how a user thinks about today)."""
    return datetime.now().astimezone().strftime("%Y-%m-%d")


def init_db():
    """Create the presence / login_events / change_log tables if missing. Safe on every startup."""
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
    """Users whose last_seen is the last 2 min within the window, most-recent first."""
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


def _week_bounds_utc(day):
    """(start_utc_iso, end_utc_iso) for the LOCAL week that CONTAINS 'YYYY-MM-DD' —
    Sunday 00:00 up to (but not including) the next Sunday 00:00. Raises ValueError
    if `day` isn't a valid date."""
    d = datetime.strptime(day, "%Y-%m-%d")            # naive local midnight of the picked day
    days_since_sunday = (d.weekday() + 1) % 7          # Mon=0→1 … Sat=5→6 … Sun=6→0
    start_local = (d - timedelta(days=days_since_sunday)).astimezone()  # that week's Sunday, local
    end_local = start_local + timedelta(days=7)
    start = start_local.astimezone(timezone.utc).isoformat(timespec="seconds")
    end = end_local.astimezone(timezone.utc).isoformat(timespec="seconds")
    return start, end


def record_login(username, display_name, source):
    """Append one login_events row (who / when / source) — called on each successful login."""
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO login_events (at, username, display_name, source) VALUES (?, ?, ?, ?)",
            (_now(), (username or "").strip(), display_name or "", source or ""),
        )
        conn.commit()
    finally:
        conn.close()


def logins_for_week(day):
    """Return all logins in the local week (Sun–Sat) that contains `day`, newest first."""
    start, end = _week_bounds_utc(day)
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
    """Append the given annotation change diffs to change_log (no-op on an empty list).
    `changes` = list of {row_key, field, old_value, new_value}."""
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


def changes_for_week(day):
    """Return all annotation changes in the local week (Sun–Sat) that contains `day`, newest first."""
    start, end = _week_bounds_utc(day)
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
