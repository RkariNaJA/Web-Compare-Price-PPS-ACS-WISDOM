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


def test_save_remark_roundtrip_and_logs_change(db):
    _, changes = _save({"r1": {"error_from": "", "done": False, "remark": "check with dev"}})
    assert changes == [
        {"row_key": "r1", "field": "Remark", "old_value": "", "new_value": "check with dev"}
    ]
    saved = annotations_db.get_all(SCOPE)["r1"]
    assert saved["remark"] == "check with dev"
    assert saved["saved_by"] == "somsak"


def test_remark_edit_by_other_user_restamps_attribution(db):
    _save({"r1": {"error_from": "Wisdom", "done": False, "remark": "a"}}, by="somsak")
    result, changes = _save({"r1": {"error_from": "Wisdom", "done": False, "remark": "b"}}, by="nok")
    assert changes == [{"row_key": "r1", "field": "Remark", "old_value": "a", "new_value": "b"}]
    assert result["r1"]["saved_by"] == "nok"


def test_save_without_remark_key_clears_nothing_else(db):
    # Older clients that don't send "remark" still save Error From / Done.
    result, _ = _save({"r1": {"error_from": "Wisdom", "done": True}})
    assert result["r1"]["remark"] == ""


def test_remark_cleared_row_is_deleted(db):
    _save({"r1": {"error_from": "", "done": False, "remark": "x"}})
    _, changes = _save({"r1": {"error_from": "", "done": False, "remark": ""}})
    assert changes == [{"row_key": "r1", "field": "Remark", "old_value": "x", "new_value": ""}]
    assert "r1" not in annotations_db.get_all(SCOPE)


def test_remark_is_trimmed_and_capped(db):
    long = "x" * (annotations_db.REMARK_MAX_LEN + 50)
    result, _ = _save({"r1": {"error_from": "", "done": False, "remark": "  " + long + "  "}})
    assert result["r1"]["remark"] == "x" * annotations_db.REMARK_MAX_LEN


def test_init_db_migrates_old_table_without_remark(tmp_path, monkeypatch):
    import sqlite3
    path = str(tmp_path / "old.db")
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE annotations (scope TEXT NOT NULL, row_key TEXT NOT NULL, "
        "error_from TEXT NOT NULL DEFAULT '', done INTEGER NOT NULL DEFAULT 0, "
        "saved_by TEXT NOT NULL DEFAULT '', saved_at TEXT NOT NULL DEFAULT '', "
        "PRIMARY KEY (scope, row_key))"
    )
    conn.execute("INSERT INTO annotations VALUES ('shared', 'r1', 'Wisdom', 1, 'somsak', 'x')")
    conn.commit()
    conn.close()
    monkeypatch.setattr(annotations_db, "DB_PATH", path)
    annotations_db.init_db()
    annotations_db.init_db()  # idempotent
    assert annotations_db.get_all(SCOPE)["r1"]["remark"] == ""
