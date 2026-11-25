# Diagram Flow

Diagrams for the PPS · ACS · WISDOM 3-Way Validator (DashBoard). Plain text, so they read the same in any editor. The full details are in [HANDOVER.md](HANDOVER.md).

## 1. Overview

What runs where: the browser talks to one Flask backend, which reads the three price sources (ACS, PPS, WISDOM) from SQL Server and keeps its own data in SQLite.

```text
                                         ┌────────────────────────────────┐
Read-only. dbo.ACS is loaded             │ SQL Server                     │
daily by ACS\FlowACS.py;                 │ DB_SERVER / DB_DATABASE        │
PPS and WISDOM come from                 │ pyodbc · ODBC Driver 18 / 17   │
other jobs.                              │ Windows auth (Trusted)         │
                                         │                                │
                                         │ dbo.ACS          (TABLE_A)     │
                                         │ dbo.PPS          (TABLE_B)     │
                                         │ VIEW_COSTSHEET_WISDOM (C)      │
                                         └───────────────┬────────────────┘
                                                         │ SELECT (read-only)
                                                         │
                                                         ▼
┌──────────────────────────────┐         ┌────────────────────────────────┐
│ Browser                      │────────▶│ Flask backend                  │
│ React 18 + TypeScript        │  fetch  │ py serve.py (waitress)         │
│                              │◀────────│ sql_backend.py · :5001         │
│ frontend/dist/               │   JSON  │                                │
│ py -m http.server 8080       │         │ auth_ad.py · groups_db.py      │
│ (dev: npm run dev :5173)     │         │ annotations_db.py              │
│ calls <host>:5001            │         │ logs_db.py · mer_team.py       │
└──────────────────────────────┘         └───────────────┬────────────────┘
                                                         │
                       ┌─────────────────────────────────┼─────────────────────────────────┐
                       │ sqlite3                         │ LDAP :389                       │ openpyxl
                       ▼                                 ▼                                 ▼
          ┌──────────────────────────┐      ┌──────────────────────────┐      ┌──────────────────────────┐
          │ annotations.db           │      │ Active Directory         │      │ Team Mer master          │
          │ DashBoard/               │      │ AD_SERVER · auth_ad.py   │      │ Master_MerDevTeam.xlsx   │
          │                          │      │                          │      │ MER_TEAM_MASTER_PATH     │
          │ annotations, groups,     │      │ STARTTLS, SIMPLE bind    │      │                          │
          │ presence, login_events,  │      │ + local dev account      │      │ MER_TEAM / MER_DEV       │
          │ change_log               │      │                          │      │                          │
          └──────────────────────────┘      └──────────────────────────┘      └──────────────────────────┘
```

## 2. Startup

What `serve.py` does when it starts, and how the frontend is built and served.

```text
┌────────────────────────────────────────────────┐        ┌──────────────────────────────────────┐
│ Backend: py serve.py                           │        │ Frontend: DashBoard/frontend         │
│                                                │        │                                      │
│ 1. import sql_backend:                         │        │ 1. npm install                       │
│    a. load_dotenv()  (DashBoard/.env)          │        │ 2. npm run build                     │
│    b. annotations_db / groups_db / logs_db     │        │    tsc -b, then vite build → dist/   │
│       .init_db() → CREATE TABLE IF NOT EXISTS  │        │    (delete the old dist/ first)      │
│    c. Flask app, FLASK_SECRET_KEY,             │        │ 3. py -m http.server 8080            │
│       cookie settings, CORS with credentials   │        │    --directory dist                  │
│    d. mer_team.register_routes(app)            │        │                                      │
│ 2. waitress serve(app)                         │        │ Dev instead: npm run dev → :5173     │
│    SERVE_HOST    (default 0.0.0.0)             │        │ Backend URL: VITE_BACKEND_URL        │
│    SERVE_PORT    (default 5001)                │        │ or http://<page host>:5001           │
│    SERVE_THREADS (default 8)                   │        │                                      │
└────────────────────────────────────────────────┘        └──────────────────────────────────────┘
Two processes, two terminals. `python sql_backend.py` instead of serve.py
runs Flask's own server on 0.0.0.0:5001 (single-threaded, dev only).
```

## 3. Login and session

How a user signs in and how every later request is checked.

```text
┌──────────────────────────────┐        ┌────────────────────────────────────────────────────┐
│ Browser · App.tsx            │───────▶│ sql_backend.py  POST /login                        │
│ useAuth.tsx                  │  POST  │                                                    │
│                              │◀───────│ 1. auth_ad.authenticate(username, password)        │
│ 1. on load: GET /me          │ cookie │    a. LOCAL_AUTH_ENABLED + local account? → ok     │
│    200 → show app            │        │    b. AD_ENABLED → bind AD_USER_DN_TEMPLATE,       │
│    401 → LoginPage.tsx       │        │       read profile + groups (AD_ALLOWED_GROUPS)    │
│ 2. POST /login               │        │    fail → 401 'Invalid username or password'       │
│    {username, password}      │        │ 2. groups_db.resolve_perms() → can_edit,           │
└──────────────────────────────┘        │    can_manage (INITIAL_ADMINS = full admin)        │
                                        │ 3. session['user'] = profile + perms               │
Every data route checks the             │    cookie: HttpOnly, SameSite=Lax,                 │
session on each request:                │    SESSION_LIFETIME_DAYS (default 1 day)           │
 @login_required  → 401                 │ 4. logs_db.record_login()                          │
 @require_edit    → 403                 └─────────────────────────┬──────────────────────────┘
 @require_manage  → 403                                           │
                                                     ┌────────────┴─────────────┐
                                                     │ LDAP                     │ sqlite3
                                                     ▼                          ▼
                                         ┌────────────────────────┐ ┌────────────────────────┐
                                         │ Active Directory       │ │ annotations.db         │
                                         │ AD_SERVER:AD_PORT      │ │ groups, login_events   │
                                         └────────────────────────┘ └────────────────────────┘
```

## 4. Compare: from three sources to a verdict

The backend only prepares the rows; the matching and the verdict run in the browser.

```text
┌────────────────────────────────┐        ┌──────────────────────────────────────────────────────┐
│ Browser · UploadStrip.tsx      │───────▶│ sql_backend.py  (@login_required)                    │
│                                │  GET   │                                                      │
│ FileSlotACS      (ACS)         │◀───────│ GET /get_file_a_data       → SELECT * dbo.ACS        │
│ FileSlotPPS      (factories,   │  JSON  │ GET /get_pps_factories     → DISTINCT FTYCODE        │
│                   max 4)       │        │ GET /get_pps_data?ftycode= → dbo.PPS, one factory    │
│ FileSlotCostsheet (WISDOM)     │        │ GET /get_costsheet_data    → VIEW_COSTSHEET_WISDOM   │
│ lib/api.ts adds ?t=<now>       │        │                      newest First Input date first   │
└────────────────────────────────┘        │ GET /get_mer_team_master   → Team Mer .xlsx          │
                                          │                                                      │
                                          │ each cell → str, EXTRACTED_SIZE from CBDID,          │
                                          │ multi-colourway rows → one row per colourway         │
                                          └──────────────────────────┬───────────────────────────┘
                                                                     │ {name, headers, rows}
                                                                     ▼
                                          ┌──────────────────────────────────────────────────────┐
                                          │ Browser · lib/comparison.ts  (pure TypeScript)       │
                                          │                                                      │
                                          │ 1. USD and THB quotes become separate rows           │
                                          │ 2. collapse PPS quote history to the live quote      │
                                          │ 3. index ACS by season · style · colour · factory    │
                                          │ 4. per PPS row:                                      │
                                          │    a. best ACS row by 5-tier size fallback           │
                                          │    b. ACS price column: regular vs ext. size,        │
                                          │       in the quote's currency                        │
                                          │    c. costsheet row: newest input date within        │
                                          │       the size-matched subset                        │
                                          │    d. compare → verdict                              │
                                          └──────────────────────────┬───────────────────────────┘
                                                                     │ verdict per row
                                                                     ▼
                                          ┌──────────────────────────────────────────────────────┐
                                          │ ResultsTable.tsx / SummaryDashboard.tsx              │
                                          │                                                      │
                                          │ Match         every loaded source agrees             │
                                          │ Diff          PPS!=ACS · PPS!=WISDOM · no WISDOM     │
                                          │ No Key Match  no ACS row for the key                 │
                                          │ Not Compared  no price in that currency              │
                                          │                                                      │
                                          │ CSV export (lib/csv.ts) · RowDetailsModal            │
                                          └──────────────────────────────────────────────────────┘
```

## 5. Annotations, presence and admin log

The only data the app writes, all in one SQLite file.

```text
┌────────────────────────────────┐        ┌────────────────────────────────────────────────────┐
│ Browser                        │───────▶│ sql_backend.py                                     │
│                                │ fetch  │                                                    │
│ ResultsTable: Error From,      │◀───────│ GET  /annotations           (login)                │
│   Done, Remark per row         │  JSON  │ POST /annotations           (can_edit)             │
│ usePresenceHeartbeat:          │        │      → annotations_db.save + record_changes        │
│   POST /ping every 30 s        │        │ POST /ping                  → touch_presence       │
│ GroupAdmin.tsx                 │        │ GET/POST/PATCH/DELETE /groups...  (can_manage)     │
│ LogDashboard.tsx               │        │ GET  /admin/presence        active < 120 s         │
└────────────────────────────────┘        │ GET  /admin/logins          this week              │
                                          │ GET  /admin/changes         this week              │
                                          └─────────────────────────┬──────────────────────────┘
                                                                    │ sqlite3 · WAL · 5 s busy-timeout
                                                                    ▼
                                          ┌────────────────────────────────────────────────────┐
                                          │ DashBoard/annotations.db  (VALIDATOR_DB_PATH)      │
                                          │                                                    │
                                          │ annotations    annotations_db.py  scope 'shared'   │
                                          │ groups,        groups_db.py                        │
                                          │ group_members                                      │
                                          │ presence,      logs_db.py                          │
                                          │ login_events,                                      │
                                          │ change_log                                         │
                                          └────────────────────────────────────────────────────┘
```
