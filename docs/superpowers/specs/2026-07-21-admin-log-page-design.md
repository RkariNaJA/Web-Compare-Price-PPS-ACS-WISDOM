# Design: Admin Log Page + Landing Chooser

**Date:** 2026-07-21
**Project:** PPS·ACS·WISDOM Validator Dashboard (`DashBoard/`)
**Status:** Approved design — ready for implementation planning

---

## Goal

Give admins a **Log** view showing (a) who is **online right now**, (b) **who logged in** on a
given day, and (c) a **full history of annotation changes** (who changed which column, from what
to what, when). On login, an admin lands on a **two-choice screen** — **Dashboard-Log** and
**Dashboard-Compare-Data** — and can switch between them anytime. Non-admins are unaffected.

## Scope decisions (agreed during brainstorming)

- **"Admin" = the existing `can_manage` permission** (same gate as the Groups screen). No new role.
- **Landing:** admins land on a 2-card chooser (Dashboard-Log / Dashboard-Compare-Data); a header
  switcher (`Log | Compare Data`) lets them jump between the two. **Non-admins skip the chooser and
  go straight to Compare-Data** and never see the Log or the switcher.
- **Online now:** live presence via a ~30s browser heartbeat; the list shows users active in the
  **last 2 minutes**; the panel auto-refreshes every ~15s.
- **Logins in a day:** every successful login is recorded; the Log page shows logins for a selected
  day (**defaults to today**).
- **Change log:** **full append-only history** — one entry per changed field (Error From / Done),
  recording who, when, the row, and **old → new** value; **clearing a row is logged** as a change to
  empty. Shown for a selected day (**defaults to today**).

## Non-goals (YAGNI — deliberately excluded)

- No logging of reads, views, filters, searches, or CSV exports — only annotation *changes* and
  *logins* are recorded.
- No real-time push (WebSockets/SSE) — polling only.
- No automatic retention/pruning of log tables (tiny text rows; add later if needed).
- No UI to edit or delete log entries — the Log page is read-only.
- No change to the annotation model itself (still one shared scope, last-write-wins for the *current*
  value; the new `change_log` is a separate audit trail alongside it).

---

## Default knobs (chosen values, in one place)

| Knob | Value |
|------|-------|
| Heartbeat interval | 30s |
| "Online" window | active within 120s (2 min) |
| Online-panel auto-refresh | 15s |
| Login / change history default range | today (date picker for other days) |
| Retention | none (manual, future) |

---

## Architecture

A new **`logs_db.py`** SQLite module (reusing `annotations.db`, same WAL/busy-timeout setup as
`annotations_db.py` and `groups_db.py`) owns three tables. `sql_backend.py` gains a heartbeat route,
three manager-only read routes, a login hook, and a change hook. The frontend gains a `LogDashboard`
view, a landing chooser + header switcher in `App.tsx`, and a heartbeat hook.

Enforcement reuses the existing guards: `@login_required` for the heartbeat, `@require_manage` for
every admin read route. The frontend only *shows/hides* the Log entry points; the server is the gate.

---

## Component 1 — `logs_db.py` (new backend module)

Same connection pattern as `groups_db.py` (honors `VALIDATOR_DB_PATH`, WAL, 5s busy-timeout).

### Schema
```sql
-- Live presence: one row per user, upserted on each heartbeat.
CREATE TABLE IF NOT EXISTS presence (
    username     TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    last_seen    TEXT NOT NULL DEFAULT ''      -- ISO-8601 UTC
);

-- Login history: one row per successful login.
CREATE TABLE IF NOT EXISTS login_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    at           TEXT NOT NULL,                -- ISO-8601 UTC
    username     TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    source       TEXT NOT NULL DEFAULT ''      -- 'ad' | 'local'
);

-- Change history: one row per changed field per save.
CREATE TABLE IF NOT EXISTS change_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    at         TEXT NOT NULL,                  -- ISO-8601 UTC
    username   TEXT NOT NULL,
    row_key    TEXT NOT NULL,
    field      TEXT NOT NULL,                  -- 'Error From' | 'Done'
    old_value  TEXT NOT NULL DEFAULT '',
    new_value  TEXT NOT NULL DEFAULT ''
);
```

### Public functions
- `init_db()` — create the three tables.
- `touch_presence(username, display_name)` — upsert `last_seen = now`.
- `active_users(within_seconds=120)` → list of `{username, display_name, last_seen, seconds_ago}` for
  users whose `last_seen` is within the window, most-recent first.
- `record_login(username, display_name, source)` — insert a `login_events` row.
- `logins_for_day(day)` → list of `{at, username, display_name, source}` for that local day, newest first.
- `record_changes(username, changes)` — insert one `change_log` row per item in `changes`
  (`changes` = list of `{row_key, field, old_value, new_value}`), stamping `at = now`.
- `changes_for_day(day)` → list of `{at, username, row_key, field, old_value, new_value}` for that day,
  newest first.

**Day handling:** `day` is a `YYYY-MM-DD` string; a day's range is computed in the **server's local
time** (matching how a user thinks about "today"), then compared against the stored UTC timestamps.
(Implementation detail for the plan; the contract is "logins/changes that happened on that local day.")

---

## Component 2 — annotation change capture (`annotations_db.py` + `sql_backend.py`)

`annotations_db.save(scope, items, saved_by)` already computes, per row, whether a value **changed**
and whether a row is being **deleted** (blank). Extend it to also produce the field-level diffs:

- **Change the return value** from `result` to a tuple **`(result, changes)`**, where `changes` is a
  list of `{row_key, field, old_value, new_value}`:
  - `Error From`: if `prev.error_from != new.error_from` → one entry (`old`/`new` are the strings;
    unassigned = `''`).
  - `Done`: if `prev.done != new.done` → one entry (`old`/`new` are `'true'`/`'false'`).
  - **Deletion** (row cleared): emit the transitions to empty for whichever field(s) were non-default.
  - A brand-new value has `prev` empty → `old_value = ''` / `false`.
- The **only caller** (`save_annotations` in `sql_backend.py`) unpacks the tuple, returns `result` as
  today, and calls `logs_db.record_changes(current_username, changes)` so the audit trail is written.

This keeps `annotations_db` free of any dependency on `logs_db` (it just reports diffs); `sql_backend`
orchestrates the logging.

### Login hook
In the `/login` view, after a successful `authenticate()`, call
`logs_db.record_login(profile["username"], profile.get("display_name"), profile.get("source"))`.

---

## Component 3 — backend routes (`sql_backend.py`)

| Method & path | Guard | Purpose |
|---------------|-------|---------|
| `POST /ping` | `@login_required` | Heartbeat → `logs_db.touch_presence(current user)`. Returns `{ok: true}`. |
| `GET /admin/presence` | `@require_manage` | `{active: [...]}` — users active within 2 min. |
| `GET /admin/logins?date=YYYY-MM-DD` | `@require_manage` | `{logins: [...]}` for the day (default today). |
| `GET /admin/changes?date=YYYY-MM-DD` | `@require_manage` | `{changes: [...]}` for the day (default today). |

`logs_db.init_db()` is called at startup next to `annotations_db.init_db()` / `groups_db.init_db()`.

---

## Component 4 — frontend

- **View state in `App.tsx`:** a `view` of `'menu' | 'log' | 'compare'`.
  - On login: admin (`can_manage`) → `'menu'`; non-admin → `'compare'`.
  - The **landing chooser** (rendered when `view === 'menu'`) shows two cards → set `view` to `'log'`
    or `'compare'`.
  - The existing **Groups** overlay stays reachable from the header as today.
- **`Header.tsx`:** for `can_manage` users, add a `Log | Compare Data` switcher (sets `view`). Hidden
  for non-admins. The Groups button remains.
- **`LogDashboard.tsx` (new):** three panels —
  1. **Online now** — from `/admin/presence`, auto-refreshing every 15s (username + "active Xs ago").
  2. **Logins** — from `/admin/logins?date=…`, with a date picker defaulting to today.
  3. **Changes** — from `/admin/changes?date=…`, same date picker; columns: time · who · row_key ·
     field · old → new.
- **Heartbeat hook** (e.g. `usePresenceHeartbeat`): while logged in, `POST /ping` every 30s; cleared
  on logout/unmount. Runs regardless of which view is open.
- **`lib/api.ts`:** `ping()`, `fetchPresence()`, `fetchLogins(date)`, `fetchChanges(date)`, plus the
  TypeScript result types.

---

## Security posture

- All admin reads are **server-enforced** with `@require_manage` (403 for authenticated non-admins,
  401 for no session). The heartbeat is `@login_required` only (any signed-in user may ping).
- Log tables are **append-only via the app** and exposed **read-only** — no route edits or deletes them.
- The audit trail records usernames and row identifiers only — no passwords or secrets.

## Data flow (happy paths)
1. **Login:** `authenticate()` → `record_login(...)` → session (perms) → response. Admin UI lands on
   the chooser; the heartbeat starts.
2. **Heartbeat:** every 30s the open app `POST /ping` → `touch_presence`. The admin's Online-now panel
   (polling `/admin/presence` every 15s) reflects it within seconds.
3. **Save annotations:** `save()` returns `(result, changes)`; the route writes `changes` via
   `record_changes` and returns `result`. The admin's Changes panel shows them for that day.

## Error handling
- No session → 401 (drops UI to login). Logged-in non-admin hitting `/admin/*` → 403.
- Bad/missing `date` param → default to today (never 500 on a malformed date).
- Heartbeat failures are non-fatal (fire-and-forget on the client; a failed ping just means "not seen").
- SQLite locking handled by the shared WAL + busy-timeout.

## Testing focus
- `logs_db`: presence upsert + `active_users` window (in vs out of range); `record_login` +
  `logins_for_day` (right day only); `record_changes` + `changes_for_day`.
- `annotations_db.save` diffs: Error From change; Done change; new value (old empty); row clear →
  empty transitions; a no-op save produces **no** change entries.
- Route guards: `/admin/*` → 401 (no session) / 403 (editor without manage) / 200 (manager); `/ping`
  updates presence and is allowed for any logged-in user.
- Frontend: `npm run build` typecheck + manual walkthrough (admin sees chooser + switcher + three
  panels populate; non-admin sees neither the chooser nor the Log link).

## Rollout notes
- New tables auto-create on startup; no migration. Existing annotations are untouched (the change log
  starts recording from deploy forward — pre-existing values have no history, which is expected).
- Ties into the same admin model as the Groups feature; `INITIAL_ADMINS` users see the Log immediately.
