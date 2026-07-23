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


def test_add_member_to_missing_group_404(client):
    login_as(client, can_manage=True)
    r = client.post("/groups/NOPE/members", json={"username": "somsak"})
    assert r.status_code == 404


def test_saving_annotations_records_change_log(client):
    import logs_db
    from conftest import login_as

    login_as(client, can_edit=True, username="somsak")
    resp = client.post(
        "/annotations", json={"annotations": {"rk1": {"error_from": "Wisdom", "done": True}}}
    )
    assert resp.status_code == 200
    changes = logs_db.changes_for_week(logs_db.today())
    fields = {(c["username"], c["field"], c["new_value"]) for c in changes}
    assert ("somsak", "Error From", "Wisdom") in fields
    assert ("somsak", "Done", "true") in fields


def test_ping_requires_login_then_updates_presence(client):
    from conftest import login_as

    assert client.post("/ping").status_code == 401  # no session

    login_as(client, username="somsak")
    assert client.post("/ping").status_code == 200

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
