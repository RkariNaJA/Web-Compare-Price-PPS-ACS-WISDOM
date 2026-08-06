import os
import sqlite3
from datetime import timedelta
from functools import wraps

import pyodbc
from dotenv import load_dotenv
from flask import Flask, jsonify, request, session
from flask_cors import CORS

import auth_ad
import annotations_db
import groups_db
import logs_db

# Load DashBoard/.env (AD / local-auth / session config) before reading any config.
load_dotenv()

# Ensure the annotations SQLite table exists (creates DashBoard/annotations.db).
annotations_db.init_db()
groups_db.init_db()
logs_db.init_db()

app = Flask(__name__)

# ── Session / cookie config ──────────────────────────────────────────────────
app.secret_key = os.getenv("FLASK_SECRET_KEY", "dev-insecure-change-me")
app.permanent_session_lifetime = timedelta(days=int(os.getenv("SESSION_LIFETIME_DAYS", "1")))
app.config.update(
    SESSION_COOKIE_HTTPONLY=True,     # cookie never readable by JS
    SESSION_COOKIE_SAMESITE="Lax",    # sent on same-site requests (same host, any port)
    SESSION_COOKIE_SECURE=auth_ad.env_bool("COOKIE_SECURE", False),  # True once on HTTPS
)

# CORS WITH credentials so the session cookie flows on cross-port fetches.
# Empty CORS_ALLOWED_ORIGINS → reflect the caller's Origin (fine on the LAN);
# set the FQDN in .env at deployment to lock it down.
_origins = [o.strip() for o in os.getenv("CORS_ALLOWED_ORIGINS", "").split(",") if o.strip()]
CORS(app, supports_credentials=True, origins=_origins or "*")


# ── Auth guard ───────────────────────────────────────────────────────────────
def login_required(view):
    """Return 401 unless a user is in the session. Applied to every data route."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user"):
            return jsonify({"error": "authentication required"}), 401
        return view(*args, **kwargs)
    return wrapped


def require_edit(view):
    """401 if not logged in, 403 unless the user's perms allow editing."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        user = session.get("user")
        if not user:
            return jsonify({"error": "authentication required"}), 401
        if not (user.get("perms") or {}).get("can_edit"):
            return jsonify({"error": "edit permission required"}), 403
        return view(*args, **kwargs)
    return wrapped


def require_manage(view):
    """401 if not logged in, 403 unless the user's perms allow managing groups."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        user = session.get("user")
        if not user:
            return jsonify({"error": "authentication required"}), 401
        if not (user.get("perms") or {}).get("can_manage"):
            return jsonify({"error": "manage permission required"}), 403
        return view(*args, **kwargs)
    return wrapped


# ── Auth routes ──────────────────────────────────────────────────────────────
@app.route("/login", methods=["POST"])
def login():
    """POST /login — verify credentials (local dev account, then Active Directory); on
    success store the user + resolved permissions in the session, record the login, and
    return the user object. 401 (generic message) on failure."""
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    password = data.get("password") or ""
    profile = auth_ad.authenticate(username, password)
    if not profile:
        # One generic message — never reveal whether the user exists.
        return jsonify({"error": "Invalid username or password"}), 401
    session.permanent = True
    session["user"] = {
        "username": profile["username"],
        "display_name": profile.get("display_name") or profile["username"],
        "email": profile.get("email", ""),
        "groups": profile.get("groups", []),
        "source": profile.get("source", ""),
        # App-group permissions resolved at login (see groups_db.resolve_perms).
        "perms": groups_db.resolve_perms(profile["username"]),
    }
    logs_db.record_login(
        profile["username"], profile.get("display_name", ""), profile.get("source", "")
    )
    return jsonify({"user": session["user"]})


@app.route("/logout", methods=["POST"])
def logout():
    """POST /logout — clear the server-side session so the cookie maps to nobody."""
    session.clear()
    return jsonify({"ok": True})


@app.route("/me", methods=["GET"])
def me():
    """Cheap session check the frontend calls on load to decide login vs app."""
    user = session.get("user")
    if not user:
        return jsonify({"error": "not authenticated"}), 401
    return jsonify({"user": user})


# ── Row annotations (Error From / Done) ──────────────────────────────────────
# ONE shared version for now. Keyed by row_key on the client; see annotations_db.
ANNOTATION_SCOPE = "shared"


@app.route("/annotations", methods=["GET"])
@login_required
def get_annotations():
    """Load the saved Error From / Done values so the frontend can fill the table."""
    return jsonify({"annotations": annotations_db.get_all(ANNOTATION_SCOPE)})


@app.route("/annotations", methods=["POST"])
@require_edit
def save_annotations():
    """Save the current Error From / Done values (the Save button). Body:
    { "annotations": { "<row_key>": { "error_from": "...", "done": true|false } } }.
    Returns the fresh full set (with saved_by / saved_at) so the UI can refresh."""
    data = request.get_json(silent=True) or {}
    items = data.get("annotations")
    if not isinstance(items, dict):
        return jsonify({"error": "annotations must be an object keyed by row_key"}), 400
    saved_by = (session.get("user") or {}).get("username") or "unknown"
    result, changes = annotations_db.save(ANNOTATION_SCOPE, items, saved_by)
    logs_db.record_changes(saved_by, changes)
    return jsonify({"annotations": result})


# ── Group management (app-managed groups & permissions) ───────────────────────
# All manager-only. Each returns the fresh full list so the UI refreshes in one
# round-trip (mirrors the annotations save pattern).
def _actor():
    """Username of the current logged-in user, for stamping who created a group /
    added a member; '' if there is no session."""
    return (session.get("user") or {}).get("username") or ""


@app.route("/groups", methods=["GET"])
@require_manage
def list_groups():
    """GET /groups — return every app group with its members and permission flags (manager-only)."""
    return jsonify({"groups": groups_db.list_groups()})


@app.route("/groups", methods=["POST"])
@require_manage
def create_group():
    """POST /groups {name, can_edit, can_manage} — create a group; 400 if the name is
    blank, 409 if it already exists (manager-only)."""
    data = request.get_json(silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"error": "group name required"}), 400
    try:
        groups_db.create_group(name, bool(data.get("can_edit")), bool(data.get("can_manage")), _actor())
    except sqlite3.IntegrityError:
        return jsonify({"error": f"group '{name}' already exists"}), 409
    return jsonify({"groups": groups_db.list_groups()})


@app.route("/groups/<name>", methods=["PATCH"])
@require_manage
def update_group(name):
    """PATCH /groups/<name> {can_edit, can_manage} — update that group's permission switches (manager-only)."""
    data = request.get_json(silent=True) or {}
    groups_db.set_group_perms(name, bool(data.get("can_edit")), bool(data.get("can_manage")))
    return jsonify({"groups": groups_db.list_groups()})


@app.route("/groups/<name>", methods=["DELETE"])
@require_manage
def delete_group(name):
    """DELETE /groups/<name> — delete the group and its membership rows (manager-only)."""
    groups_db.delete_group(name)
    return jsonify({"groups": groups_db.list_groups()})


@app.route("/groups/<name>/members", methods=["POST"])
@require_manage
def add_group_member(name):
    """POST /groups/<name>/members {username} — add an AD user to the group; 400 if blank,
    404 if the group doesn't exist (manager-only)."""
    data = request.get_json(silent=True) or {}
    username = (data.get("username") or "").strip()
    if not username:
        return jsonify({"error": "username required"}), 400
    try:
        groups_db.add_member(name, username, _actor())
    except sqlite3.IntegrityError:
        return jsonify({"error": f"group '{name}' not found"}), 404
    return jsonify({"groups": groups_db.list_groups()})


@app.route("/groups/<name>/members/<username>", methods=["DELETE"])
@require_manage
def remove_group_member(name, username):
    """DELETE /groups/<name>/members/<username> — remove that member from the group (manager-only)."""
    groups_db.remove_member(name, username)
    return jsonify({"groups": groups_db.list_groups()})


# ── Admin log page (presence / logins / change history) ───────────────────────
@app.route("/ping", methods=["POST"])
@login_required
def ping():
    """POST /ping — heartbeat: mark the logged-in user as active right now (feeds the
    admin 'online now' list). Any logged-in user."""
    user = session.get("user") or {}
    logs_db.touch_presence(user.get("username", ""), user.get("display_name", ""))
    return jsonify({"ok": True})


@app.route("/admin/presence", methods=["GET"])
@require_manage
def admin_presence():
    """GET /admin/presence — users active in the last 2 minutes (manager-only)."""
    return jsonify({"active": logs_db.active_users(within_seconds=120)})


@app.route("/admin/logins", methods=["GET"])
@require_manage
def admin_logins():
    """GET /admin/logins?date=YYYY-MM-DD — login history for the local WEEK (Sun–Sat) that
    contains the given date (defaults to today's week; a bad date falls back to this week).
    Manager-only."""
    day = (request.args.get("date") or "").strip() or logs_db.today()
    try:
        logins = logs_db.logins_for_week(day)
    except ValueError:
        logins = logs_db.logins_for_week(logs_db.today())
    return jsonify({"logins": logins})


@app.route("/admin/changes", methods=["GET"])
@require_manage
def admin_changes():
    """GET /admin/changes?date=YYYY-MM-DD — annotation change history for the local WEEK
    (Sun–Sat) that contains the given date (defaults to today's week; a bad date falls back
    to this week). Manager-only."""
    day = (request.args.get("date") or "").strip() or logs_db.today()
    try:
        changes = logs_db.changes_for_week(day)
    except ValueError:
        changes = logs_db.changes_for_week(logs_db.today())
    return jsonify({"changes": changes})


# SQL Server connection details (loaded from .env — never hardcode infra here).
SERVER   = os.getenv("DB_SERVER", "")
DATABASE = os.getenv("DB_DATABASE", "")
TABLE_A  = os.getenv("DB_TABLE_A", "dbo.ACS")
TABLE_B  = os.getenv("DB_TABLE_B", "dbo.PPS")
TABLE_C  = os.getenv("DB_TABLE_C", "dbo.VIEW_COSTSHEET_WISDOM")

def get_connection():
    """Open a pyodbc connection to SQL Server (Windows/Trusted auth), auto-selecting the
    newest installed ODBC driver. Raises if no suitable driver is found."""
    if not SERVER or not DATABASE:
        raise Exception("DB_SERVER and DB_DATABASE must be set in .env (see .env.example).")
    preferred = [
        'ODBC Driver 18 for SQL Server',
        'ODBC Driver 17 for SQL Server',
        'SQL Server',
    ]
    available = pyodbc.drivers()
    driver = next((d for d in preferred if d in available), None)
    if driver is None:
        raise Exception(f"No suitable SQL Server ODBC driver found. Available: {available}")

    conn_str = (
        f'DRIVER={{{driver}}};'
        f'SERVER={SERVER};'
        f'DATABASE={DATABASE};'
        f'Trusted_Connection=yes;'
    )
    if driver == 'ODBC Driver 18 for SQL Server':
        conn_str += 'TrustServerCertificate=yes;'

    return pyodbc.connect(conn_str)

# ── Shared helper ─────────────────────────────────────────────────────────────
def extract_size_from_cbdid(cbdid: str) -> str:
    """Extract size token from CBDID and normalise dashes to underscores.
    e.g. SU27-HTV-HV8232-S-ALL_SOLID-ALL_REG_SIZE-RB  →  ALL_REG_SIZE_RB
    """
    parts = cbdid.split('-')
    if len(parts) >= 2:
        return '-'.join(parts[-2:]).replace('-', '_')
    return ''


# Colourways beginning with this prefix (ALL_SOLID, ALL_AOP, ALL_HTR, ALL_011, …) are ONE
# logical colourway that happens to contain an underscore — not a list of codes.
COLORWAY_NO_SPLIT_PREFIX = 'ALL_'


def expand_colorway_rows(base_row: list, colorway_idx: int) -> list[list]:
    """Split a multi-code ColorwayCode (e.g. '011_066') into one row per code.

    Codes starting with `ALL_` are left intact. They are single colourways, and splitting
    them was a real bug: 'ALL_SOLID' became two rows, 'ALL' and 'SOLID', so the join key
    `all_solid` never existed in the ACS index. A PPS row with a blank COLOR (which the
    frontend normalises to `all_solid`) therefore missed its exact match, fell through to
    the no-colour fallback, and could take a *specific* colour's FOB instead — style
    IR7874 showed 4.72 from colourway 084 rather than 3.83 from ALL_SOLID. Because
    `SELECT *` has no ORDER BY, which colour it grabbed was not even deterministic.

    This also un-breaks `normalizeJoinKey` in the frontend, which already folds `all_htr`
    and `all_aop` into `all_solid` — folding that could never fire while those values were
    being split apart here first.
    """
    if colorway_idx == -1:
        return [base_row]
    code = base_row[colorway_idx]
    if code.strip().upper().startswith(COLORWAY_NO_SPLIT_PREFIX):
        return [base_row]
    if '_' in code:
        result = []
        for part in code.split('_'):
            if part.strip():
                new_row = list(base_row)
                new_row[colorway_idx] = part.strip()
                result.append(new_row)
        return result
    return [base_row]


# ── Route 1: dbo.ACS (original table) ────────────────────────────────────────
@app.route('/get_file_a_data', methods=['GET'])
@login_required
def get_file_a_data():
    """GET /get_file_a_data — all dbo.ACS rows, with EXTRACTED_SIZE appended and underscored
    ColorwayCode expanded to one row per code. 500 {error} on any SQL failure."""
    try:
        cnxn   = get_connection()
        cursor = cnxn.cursor()
        cursor.execute(f'SELECT * FROM {TABLE_A}')

        columns  = [col[0] for col in cursor.description]
        col_map  = {col.upper(): i for i, col in enumerate(columns)}
        colorway_idx = col_map.get('COLORWAYCODE', -1)
        cbdid_idx    = col_map.get('CBDID', -1)

        # Append virtual EXTRACTED_SIZE column
        columns.append('EXTRACTED_SIZE')

        rows = []
        for row in cursor:
            base_row = [str(v) if v is not None else '' for v in row]

            extracted_size = extract_size_from_cbdid(base_row[cbdid_idx]) if cbdid_idx != -1 else ''
            base_row.append(extracted_size)

            rows.extend(expand_colorway_rows(base_row, colorway_idx))

        cnxn.close()
        return jsonify({'name': TABLE_A, 'headers': columns, 'rows': rows})

    except Exception as e:
        print(f"[ACS] Error: {e}")
        return jsonify({'error': str(e)}), 500


# ── Route 2: dbo.PPS (replaces the PPS file upload) ──────────────────────────
@app.route('/get_pps_factories', methods=['GET'])
@login_required
def get_pps_factories():
    """Distinct FTYCODE list so the frontend picker builds itself from the DB."""
    try:
        cnxn   = get_connection()
        cursor = cnxn.cursor()
        cursor.execute(f'SELECT DISTINCT FTYCODE FROM {TABLE_B} WHERE FTYCODE IS NOT NULL ORDER BY FTYCODE')
        factories = [row[0] for row in cursor]
        cnxn.close()
        return jsonify({'factories': factories})

    except Exception as e:
        print(f"[PPS FACTORIES] Error: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/get_pps_data', methods=['GET'])
@login_required
def get_pps_data():
    """All dbo.PPS rows for ONE factory (?ftycode=HIT). Rows are sent raw —
    no dedupe — the frontend projects down to the columns it compares,
    exactly as it did for uploaded PPS files."""
    ftycode = request.args.get('ftycode', '').strip()
    if not ftycode:
        return jsonify({'error': 'Missing required query param: ftycode'}), 400
    try:
        cnxn   = get_connection()
        cursor = cnxn.cursor()
        # Parameterized — ftycode comes from the client.
        cursor.execute(f'SELECT * FROM {TABLE_B} WHERE FTYCODE = ?', ftycode)

        columns = [col[0] for col in cursor.description]
        rows    = [[str(v) if v is not None else '' for v in row] for row in cursor]

        cnxn.close()
        return jsonify({'name': f'{TABLE_B} ({ftycode})', 'headers': columns, 'rows': rows})

    except Exception as e:
        print(f"[PPS] Error: {e}")
        return jsonify({'error': str(e)}), 500


# ── Route 3: dbo.VIEW_COSTSHEET_WISDOM (new table) ───────────────────────────
@app.route('/get_costsheet_data', methods=['GET'])
@login_required
def get_costsheet_data():
    """GET /get_costsheet_data — all dbo.VIEW_COSTSHEET_WISDOM rows (newest First-Input-date
    first), colorway-expanded, EXTRACTED_SIZE added when CBDID exists; the frontend picks the
    MAX-date winner per key. 500 {error} on failure."""
    try:
        cnxn   = get_connection()
        cursor = cnxn.cursor()
        # Ship EVERY record — the frontend's lookupCostsheet() picks the winner
        # per key itself via MAX(First Input Date). The ORDER BY matters for
        # date TIES only: the frontend keeps the first-seen row on a tie, so
        # sending newest-date / highest-version first preserves the same winner
        # the old ROW_NUMBER dedupe used to guarantee.
        cursor.execute(f'''
            SELECT * FROM {TABLE_C}
            ORDER BY TRY_CONVERT(datetime, [First Input date]) DESC,
                     [CBD Version] DESC
        ''')

        columns  = [col[0] for col in cursor.description]
        col_map  = {col.upper(): i for i, col in enumerate(columns)}
        colorway_idx = col_map.get('COLORWAYCODE', -1)
        cbdid_idx    = col_map.get('CBDID', -1)

        # Append virtual EXTRACTED_SIZE column only if CBDID exists in this view
        has_cbdid = cbdid_idx != -1
        if has_cbdid:
            columns.append('EXTRACTED_SIZE')

        rows = []
        for row in cursor:
            base_row = [str(v) if v is not None else '' for v in row]

            if has_cbdid:
                base_row.append(extract_size_from_cbdid(base_row[cbdid_idx]))

            rows.extend(expand_colorway_rows(base_row, colorway_idx))

        cnxn.close()
        return jsonify({'name': TABLE_C, 'headers': columns, 'rows': rows})

    except Exception as e:
        print(f"[COSTSHEET] Error: {e}")
        return jsonify({'error': str(e)}), 500


# ── Health check ──────────────────────────────────────────────────────────────
@app.route('/', methods=['GET'])
def index():
    """GET / — plain-text health check that lists the main data endpoints."""
    return (
        'SQL Backend running.<br>'
        'Endpoints:<br>'
        '&nbsp;&nbsp;<b>/get_file_a_data</b> — dbo.ACS<br>'
        '&nbsp;&nbsp;<b>/get_pps_factories</b> — dbo.PPS factory list<br>'
        '&nbsp;&nbsp;<b>/get_pps_data?ftycode=…</b> — dbo.PPS rows for one factory<br>'
        '&nbsp;&nbsp;<b>/get_costsheet_data</b> — dbo.VIEW_COSTSHEET_WISDOM'
    )


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5001)