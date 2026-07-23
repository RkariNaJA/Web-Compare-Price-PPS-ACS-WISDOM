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
