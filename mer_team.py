"""Team Mer master data: maps a CBD creator (MER_DEV) to their team(s) (MER_TEAM).

The source is an .xlsx the master data team maintains (gitignored — copied to the
server by hand). It is cached by file modified-time, so a replaced file is picked
up on the next request without restarting the backend.
"""
import os

import openpyxl

DEFAULT_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "Data", "Master_MerDevTeam.xlsx"
)
TEAM_COL = "MER_TEAM"
DEV_COL = "MER_DEV"

# path -> (mtime, master)
_cache: dict[str, tuple[float, dict[str, list[str]]]] = {}


def master_path() -> str:
    """MER_TEAM_MASTER_PATH from .env, else DashBoard/Data/Master_MerDevTeam.xlsx."""
    return os.getenv("MER_TEAM_MASTER_PATH") or DEFAULT_PATH


def _cell(v) -> str:
    return str(v).strip() if v is not None else ""


def _read(path: str) -> dict[str, list[str]]:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        rows = wb.active.iter_rows(values_only=True)
        header = [_cell(h).upper() for h in next(rows, ())]
        for col in (TEAM_COL, DEV_COL):
            if col not in header:
                raise ValueError(f"Team Mer master is missing the {col} column")
        ti, di = header.index(TEAM_COL), header.index(DEV_COL)
        teams: dict[str, set[str]] = {}
        for row in rows:
            team = _cell(row[ti]) if ti < len(row) else ""
            dev = _cell(row[di]).lower() if di < len(row) else ""
            if team and dev:
                teams.setdefault(dev, set()).add(team)
        return {dev: sorted(ts) for dev, ts in teams.items()}
    finally:
        wb.close()


def load_master(path: str) -> dict[str, list[str]]:
    """{lower-cased MER_DEV: sorted [MER_TEAM, ...]}. Raises FileNotFoundError / ValueError."""
    mtime = os.path.getmtime(path)  # FileNotFoundError when the file is missing
    hit = _cache.get(path)
    if hit and hit[0] == mtime:
        return hit[1]
    master = _read(path)
    _cache[path] = (mtime, master)
    return master


def register_routes(app, login_required):
    """Attach GET /get_mer_team_master. Lives here so sql_backend.py stays small."""
    from flask import jsonify

    @app.route("/get_mer_team_master", methods=["GET"])
    @login_required
    def get_mer_team_master():
        path = master_path()
        try:
            return jsonify({"master": load_master(path)})
        except FileNotFoundError:
            # Basename only — never leak server folder names to the browser.
            return jsonify(
                {"error": f"Team Mer master file not found: {os.path.basename(path)}"}
            ), 404
        except Exception as e:
            print(f"[MER TEAM] Error: {e}")
            return jsonify({"error": str(e)}), 500
