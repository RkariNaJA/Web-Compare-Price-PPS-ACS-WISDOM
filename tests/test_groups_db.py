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
    monkeypatch.setenv("INITIAL_ADMINS", "test.admin, other.admin")
    assert groups_db.resolve_perms("Test.Admin") == {"can_edit": True, "can_manage": True}
