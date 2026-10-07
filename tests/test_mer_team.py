import os

import openpyxl
import pytest

import mer_team


def make_master(path, rows, header=("MER_TEAM", "MER_DEV")):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.append(list(header))
    for r in rows:
        ws.append(list(r))
    wb.save(path)
    return str(path)


@pytest.fixture(autouse=True)
def clear_cache():
    mer_team._cache.clear()
    yield
    mer_team._cache.clear()


def test_loads_dev_to_team(tmp_path):
    p = make_master(tmp_path / "m.xlsx", [("TEAM_A", "dev_alice"), ("TEAM_C", "dev_bob")])
    assert mer_team.load_master(p) == {"dev_alice": ["TEAM_A"], "dev_bob": ["TEAM_C"]}


def test_dev_key_is_lowercased_and_trimmed_team_keeps_spelling(tmp_path):
    p = make_master(tmp_path / "m.xlsx", [(" Team D (X) ", "  Dev_Alice ")])
    assert mer_team.load_master(p) == {"dev_alice": ["Team D (X)"]}


def test_dev_in_two_teams_gets_both_sorted_and_deduped(tmp_path):
    p = make_master(
        tmp_path / "m.xlsx",
        [("TEAM_B", "dev_carol"), ("Team D (X)", "dev_carol"), ("TEAM_B", "dev_carol")],
    )
    assert mer_team.load_master(p) == {"dev_carol": ["TEAM_B", "Team D (X)"]}


def test_blank_rows_and_blank_cells_are_skipped(tmp_path):
    p = make_master(
        tmp_path / "m.xlsx",
        [("TEAM_A", "mpa"), (None, "mpb"), ("TEAM_C", None), (None, None), ("  ", "mpc")],
    )
    assert mer_team.load_master(p) == {"mpa": ["TEAM_A"]}


def test_header_order_and_case_do_not_matter(tmp_path):
    p = make_master(
        tmp_path / "m.xlsx", [("mpa", "TEAM_A")], header=("mer_dev ", "Mer_Team")
    )
    assert mer_team.load_master(p) == {"mpa": ["TEAM_A"]}


def test_missing_header_raises_value_error(tmp_path):
    p = make_master(tmp_path / "m.xlsx", [("TEAM_A", "mpa")], header=("TEAM", "MER_DEV"))
    with pytest.raises(ValueError, match="MER_TEAM"):
        mer_team.load_master(p)


def test_missing_file_raises_file_not_found(tmp_path):
    with pytest.raises(FileNotFoundError):
        mer_team.load_master(str(tmp_path / "nope.xlsx"))


def test_reload_when_file_changes(tmp_path):
    p = make_master(tmp_path / "m.xlsx", [("TEAM_A", "mpa")])
    assert mer_team.load_master(p) == {"mpa": ["TEAM_A"]}
    make_master(tmp_path / "m.xlsx", [("TEAM_C", "mpa")])
    st = os.stat(p)
    os.utime(p, (st.st_atime, st.st_mtime + 10))  # guarantee a different mtime
    assert mer_team.load_master(p) == {"mpa": ["TEAM_C"]}


def test_unchanged_file_is_served_from_cache(tmp_path, monkeypatch):
    p = make_master(tmp_path / "m.xlsx", [("TEAM_A", "mpa")])
    mer_team.load_master(p)
    monkeypatch.setattr(mer_team, "_read", lambda path: pytest.fail("re-read an unchanged file"))
    assert mer_team.load_master(p) == {"mpa": ["TEAM_A"]}


def test_master_path_default_and_env_override(monkeypatch):
    monkeypatch.delenv("MER_TEAM_MASTER_PATH", raising=False)
    assert mer_team.master_path() == mer_team.DEFAULT_PATH
    assert mer_team.DEFAULT_PATH.endswith(os.path.join("Data", "Master_MerDevTeam.xlsx"))
    monkeypatch.setenv("MER_TEAM_MASTER_PATH", r"D:\x\y.xlsx")
    assert mer_team.master_path() == r"D:\x\y.xlsx"


from conftest import login_as


def test_route_requires_login(client):
    assert client.get("/get_mer_team_master").status_code == 401


def test_route_returns_master(client, tmp_path, monkeypatch):
    p = make_master(tmp_path / "m.xlsx", [("TEAM_A", "Dev_Alice")])
    monkeypatch.setenv("MER_TEAM_MASTER_PATH", p)
    login_as(client)
    resp = client.get("/get_mer_team_master")
    assert resp.status_code == 200
    assert resp.get_json() == {"master": {"dev_alice": ["TEAM_A"]}}


def test_route_missing_file_is_404_without_leaking_the_path(client, tmp_path, monkeypatch):
    monkeypatch.setenv("MER_TEAM_MASTER_PATH", str(tmp_path / "secret_dir" / "Master.xlsx"))
    login_as(client)
    resp = client.get("/get_mer_team_master")
    assert resp.status_code == 404
    err = resp.get_json()["error"]
    assert "Master.xlsx" in err and "secret_dir" not in err


def test_route_bad_header_is_500(client, tmp_path, monkeypatch):
    p = make_master(tmp_path / "m.xlsx", [("x", "y")], header=("A", "B"))
    monkeypatch.setenv("MER_TEAM_MASTER_PATH", p)
    login_as(client)
    resp = client.get("/get_mer_team_master")
    assert resp.status_code == 500
    assert "MER_TEAM" in resp.get_json()["error"]
