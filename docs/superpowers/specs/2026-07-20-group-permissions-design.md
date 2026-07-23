# Design: App-Managed Groups & Per-Group Permissions

**Date:** 2026-07-20
**Project:** PPS·ACS·WISDOM Validator Dashboard (`DashBoard/`)
**Status:** Approved design — ready for implementation planning

---

## Goal

Let an admin create their own groups (e.g. **MER**, **POM**), add Active Directory
users into those groups, and have each group's permissions decide what its members
can do in the dashboard. Groups and membership are **managed inside the app**; AD is
used only to authenticate the login.

## Scope decisions (agreed during brainstorming)

- **Groups live in the app**, not in Active Directory. AD only proves identity.
- **Permissions control two things only:**
  1. **can_edit** — save/change the Error From & Done annotations.
  2. **can_manage** — create groups, add/remove members, change group permissions.
- **Everyone sees the same data** (no per-group data filtering) and shares the **one
  shared annotation set** (no per-group annotation scopes). Explicitly out of scope.
- **A valid login with no group = read-only** (can view, cannot save).
- A person in multiple groups gets the **combined, most-permissive** rights.

## Non-goals (YAGNI — deliberately excluded)

- No data filtering by group (which factories/tables/columns a group sees).
- No per-group annotation sets (the `scope` column stays available for the future,
  but we keep the single `"shared"` scope).
- No writing to Active Directory (creating AD groups, editing AD membership).

---

## Architecture: two separate layers

| Layer | Responsibility | Where | Changed? |
|-------|----------------|-------|----------|
| **AD (identity)** | Prove who the person is; gate *login* via `AD_ALLOWED_GROUPS` | `auth_ad.py` | **No change** |
| **App groups (authorization)** | Decide what a logged-in person may *do* | new `groups_db.py` + `sql_backend.py` | New |

App groups are **not** AD security groups. They are the app's own concept (MER, POM,
Admins, …). The AD `memberOf` list is still read at login and kept in the session for
the login gate and for reference, but it does not drive app permissions.

---

## Component 1 — `groups_db.py` (new backend module)

SQLite persistence for groups and membership. Reuses the **existing `annotations.db`
file** and the same connection setup already used by `annotations_db.py` (WAL journal,
5-second busy timeout, `sqlite3.Row` factory).

### Schema

```sql
CREATE TABLE IF NOT EXISTS groups (
    name        TEXT PRIMARY KEY,              -- e.g. 'MER', 'POM', 'Admins'
    can_edit    INTEGER NOT NULL DEFAULT 0,    -- 1 = members may save annotations
    can_manage  INTEGER NOT NULL DEFAULT 0,    -- 1 = members may administer groups
    created_by  TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS group_members (
    group_name  TEXT NOT NULL,                 -- FK -> groups.name
    username    TEXT NOT NULL,                 -- AD sAMAccountName, stored casefolded
    added_by    TEXT NOT NULL DEFAULT '',
    added_at    TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (group_name, username)
);
```

Notes:
- `username` is stored **lower-cased** (`casefold`) so lookups are case-insensitive,
  consistent with `auth_ad.clean_username`.
- Deleting a group also deletes its `group_members` rows (handled in code or via a
  cascade — implementation detail for the plan).

### Public functions (framework-agnostic, plain dicts — same style as `annotations_db.py`)

- `init_db()` — create both tables if missing (called once at startup, next to
  `annotations_db.init_db()`).
- `list_groups()` → list of groups, each with its members.
- `create_group(name, can_edit, can_manage, created_by)`.
- `delete_group(name)`.
- `set_group_perms(name, can_edit, can_manage)`.
- `add_member(group_name, username, added_by)`.
- `remove_member(group_name, username)`.
- `resolve_perms(username)` → `{ "can_edit": bool, "can_manage": bool }` — the core
  rule below.

### Core rule — `resolve_perms(username)`

```
u = casefold(username)
can_edit   = u in INITIAL_ADMINS  OR  u is a member of any group with can_edit = 1
can_manage = u in INITIAL_ADMINS  OR  u is a member of any group with can_manage = 1
```

- **No group → both false → read-only.**
- **`INITIAL_ADMINS`** (new `.env` value, comma-separated AD usernames, default
  `admin.user`) always resolves to `can_edit = can_manage = true`. This solves the
  cold start (the first admin cannot be added from an empty groups list) and is the
  lock-out recovery path.

---

## Component 2 — `sql_backend.py` (backend wiring)

### Session & auth responses
- After a successful `authenticate()`, call `groups_db.resolve_perms(username)` and
  store the result in the session user object.
- `/login` and `/me` responses include `perms: { can_edit, can_manage }` so the
  frontend knows what to render. (Perms are resolved from the DB at login; a session
  reflects the permissions as of login time.)

### New guards (next to the existing `login_required`)
- `require_edit` — 403 unless `session.user.perms.can_edit`.
- `require_manage` — 403 unless `session.user.perms.can_manage`.

Both assume `login_required` semantics too (no session → 401).

### Enforcement
- **`POST /annotations`** gains `require_edit`. This is the real gate — a read-only
  user cannot save even by calling the API directly. (`GET /annotations` stays
  `login_required` — everyone who is logged in may read.)

### New manager-only routes (all behind `require_manage`)

| Method & path | Purpose |
|---------------|---------|
| `GET /groups` | List all groups with members and permission flags |
| `POST /groups` | Create a group `{ name, can_edit, can_manage }` |
| `DELETE /groups/<name>` | Delete a group |
| `PATCH /groups/<name>` | Update a group's `can_edit` / `can_manage` |
| `POST /groups/<name>/members` | Add a member `{ username }` |
| `DELETE /groups/<name>/members/<username>` | Remove a member |

The exact REST shape is a guideline; the implementation plan may adjust it, but the
capabilities (list / create / delete group, set perms, add / remove member) are fixed.

---

## Component 3 — Frontend (`DashBoard/frontend/src`)

- **`lib/types.ts`** — `AuthUser` gains `perms: { canEdit: boolean; canManage: boolean }`
  (camelCase on the frontend; `api.ts` maps from the backend's snake_case, matching the
  existing annotation-mapping pattern).
- **`lib/api.ts`** — new functions for the group-admin routes; `apiMe`/`apiLogin`
  already return the user object, now carrying `perms`.
- **`components/ResultsToolbar.tsx`** — the **Save** button is disabled when
  `!perms.canEdit`, with a tooltip like *"Read-only — ask an admin for edit access."*
  UX only; the server is the enforcement point.
- **`components/GroupAdmin.tsx` (new)** — shown only when `perms.canManage`. A simple
  table UI to: create a group, toggle its edit/manage switches, add an AD username,
  remove a member, delete a group.
- **`components/Header.tsx`** — a small "Groups" (admin) link, visible only when
  `perms.canManage`, that opens the admin view.
- **`hooks/useAuth.tsx`** — no logic change; the `user` it already holds now carries
  `perms`.

---

## Security posture

- **All authorization is enforced server-side** in `require_edit` / `require_manage`.
- The frontend only **hides or disables** controls for tidiness — it is never the
  barrier between a read-only user and a write.
- Generic errors preserved: management routes return **403** for authenticated but
  unauthorized users (distinct from the 401 for no session).

## Configuration (`.env`)

- New: `INITIAL_ADMINS=admin.user` — comma-separated AD `sAMAccountName`s that are
  always treated as full admins (bootstrap + recovery).

## Data flow (happy paths)

1. **Login:** AD/local auth → `resolve_perms(username)` → session stores user + perms →
   `/login` returns user with perms → frontend renders Save enabled/disabled and shows
   or hides the Groups admin link.
2. **Save annotations:** frontend `POST /annotations` → `require_edit` → allowed only
   for editors → existing `annotations_db.save` runs.
3. **Manage a group:** admin opens Groups page → `POST /groups` / `POST .../members` →
   `require_manage` → `groups_db` writes → next login by an affected user reflects the
   new permissions.

## Error handling

- No session → **401** (existing behavior, drops UI to login page).
- Logged in but lacking the right → **403** with a clear message.
- Duplicate group name / duplicate member → handled idempotently or with a clear 4xx
  (decided in the plan).
- SQLite locking already handled by the shared WAL + busy-timeout setup.

## Testing focus

- `resolve_perms`: no group → read-only; editor group → can_edit; manage group →
  can_manage; `INITIAL_ADMINS` → both, even with an empty DB; multi-group union;
  case-insensitive username match.
- `require_edit` / `require_manage`: 401 vs 403 vs allowed.
- `POST /annotations` rejects a read-only user (server-side), independent of the UI.
- Group CRUD round-trips through `groups_db`.

## Rollout notes

- On first deploy the `groups` table is empty; `INITIAL_ADMINS` keeps you in control.
- Create MER and POM (with `can_edit`), an Admins group (with `can_manage`), add
  people, then you can remove yourself from `INITIAL_ADMINS` later if desired.
- Ties into the pending go-live items (role enforcement) already tracked for the project.
