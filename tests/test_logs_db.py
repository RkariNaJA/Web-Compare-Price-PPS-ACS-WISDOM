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
    active = logs_db.active_users()
    assert len(active) == 1
    assert active[0]["last_seen"] >= first


def test_login_history_for_day(db):
    logs_db.record_login("somsak", "Somsak S.", "ad")
    logs_db.record_login("naree", "Naree", "ad")
    todays = logs_db.logins_for_week(logs_db.today())
    users = [r["username"] for r in todays]
    assert "somsak" in users and "naree" in users
    assert logs_db.logins_for_week("2000-01-01") == []


def test_change_history_for_day(db):
    logs_db.record_changes(
        "somsak",
        [
            {"row_key": "hit|ho26|x", "field": "Error From", "old_value": "", "new_value": "Wisdom"},
            {"row_key": "hit|ho26|x", "field": "Done", "old_value": "false", "new_value": "true"},
        ],
    )
    todays = logs_db.changes_for_week(logs_db.today())
    assert len(todays) == 2
    assert todays[0]["username"] == "somsak"
    fields = {r["field"] for r in todays}
    assert fields == {"Error From", "Done"}
    assert logs_db.changes_for_week("2000-01-01") == []


def test_record_changes_empty_is_noop(db):
    logs_db.record_changes("somsak", [])
    assert logs_db.changes_for_week(logs_db.today()) == []


def test_bad_day_raises(db):
    import pytest
    with pytest.raises(ValueError):
        logs_db.logins_for_week("not-a-date")
