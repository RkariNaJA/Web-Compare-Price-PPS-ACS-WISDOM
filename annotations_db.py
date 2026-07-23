"""
SQLite persistence for the user-filled row annotations (Error From / Done).

ONE SHARED VERSION for now: every logged-in user reads and writes the same
`scope = "shared"` set, so what one person saves, the next person sees (see the
README "Save" notes). Storage is keyed by (scope, row_key) so per-group versions
can be added later just by writing a real group name into `scope` — no schema
change, no migration.

`row_key` is the stable business identity of a validation row (identical to the
de-dup key): FTYCODE | Season | Style | Color | ORIG_SIZE | LOCAL_QUOTE_AMOUNT.
It is computed on the frontend (comparison.ts) so save and load line up even
though the comparison rebuilds the table every time.


sqlite3 got a default 5-second busy-timeout. if we got 2 user save at the same time the second one wait for the lock(few ms) and then proceeds
"""
import os
import sqlite3
from datetime import datetime, timezone

# Default DB lives next to this module (DashBoard/annotations.db). Overridable via
# VALIDATOR_DB_PATH so tests can point at a temp file. Gitignored.
DB_PATH = os.getenv("VALIDATOR_DB_PATH") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "annotations.db"
)


def _connect():
    """Open a SQLite connection to annotations.db (WAL mode, 5s busy-timeout)."""
    # timeout=5.0 (also Python's default) makes a write WAIT up to 5s for the lock
    # instead of erroring with "database is locked" — so simultaneous saves just
    # queue (each write is a few ms). SQLite is ACID, so concurrent access never
    # corrupts data; the worst case without this would be one save erroring out.
    conn = sqlite3.connect(DB_PATH, timeout=5.0)
    conn.row_factory = sqlite3.Row
    # WAL (Write-Ahead Logging): readers and the single writer run CONCURRENTLY —
    # a reader never blocks the writer and vice-versa. Smoother when many users
    # load/save at once. It's a persistent property of the .db file (also creates
    # -wal / -shm sidecar files). busy_timeout mirrors the connect timeout above in ms.
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    return conn


def init_db():
    """Create the table if it doesn't exist. Safe to call on every startup."""
    conn = _connect()
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS annotations (
                scope      TEXT NOT NULL,
                row_key    TEXT NOT NULL,
                error_from TEXT NOT NULL DEFAULT '',
                done       INTEGER NOT NULL DEFAULT 0,
                saved_by   TEXT NOT NULL DEFAULT '',
                saved_at   TEXT NOT NULL DEFAULT '',
                PRIMARY KEY (scope, row_key)
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


def get_all(scope):
    """Return { row_key: {error_from, done, saved_by, saved_at} } for a scope."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT row_key, error_from, done, saved_by, saved_at "
            "FROM annotations WHERE scope = ?",
            (scope,),
        ).fetchall()
    finally:
        conn.close()
    return {
        r["row_key"]: {
            "error_from": r["error_from"],
            "done": bool(r["done"]),
            "saved_by": r["saved_by"],
            "saved_at": r["saved_at"],
        }
        for r in rows
    }


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
