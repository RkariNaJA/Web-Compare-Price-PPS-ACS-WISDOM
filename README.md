# PPS · ACS · WISDOM 3-Way Validator — Handover Documentation — Hi-Tech Apparel

> Full technical reference for the 3-way validator dashboard, written so a new engineer can take ownership without asking questions.

**Last updated:** 2026-08-06 · **Original author / design contact:** admin@example.com

---

## 📌 CORE LOGIC — read this before changing anything

Everything the app does, in one page. Each rule links to its full section. **Order of operations is the whole game** — most bugs found so far were one step running before or after the step it depended on.

### What it answers

> For every PPS quote row: does `LOCAL_QUOTE_AMOUNT` equal **both** the ACS FOB **and** the WISDOM Costsheet FOB?

Three sources, all read-only: **ACS** (`dbo.ACS`) · **PPS** (`dbo.PPS`) · **Costsheet/WISDOM** (`dbo.VIEW_COSTSHEET_WISDOM`). The only thing the app ever writes is `annotations.db` (Error From / Done, groups, logs).

### The pipeline, in order

```
BACKEND  sql_backend.py                     ── SELECT *, no ORDER BY (row order is NOT stable)
  1  stringify every cell, NULL → ""
  2  append EXTRACTED_SIZE   (last 2 dash-segments of CBDID → ALL_REG_SIZE_RB)      §4.2
  3  expand_colorway_rows    split 011_066 → 2 rows · ALL_* NEVER split             §4.3

FRONTEND  load (FileSlotPPS / FileSlotACS / FileSlotCostsheet)
  4  keep only STRICT_B_COLS                                                        §3.2
  5  stash raw size in ORIG_SIZE_DATA, overwrite SIZE_DATA with the bucket          §6.2

FRONTEND  Validate (comparison.ts → runComparison)
  6  preferUSDRows      collapse USD/THB twins   ← BEFORE dedup                      ↑ top
  7  dedupePPSRows      collapse quote history   ← key INCLUDES the amount           ↑ top
  8  build ACS index    by Season|Style|Colour|Factory (+ a no-colour variant)      §6.1
  9  per PPS row → pick ACS row (5-tier size fallback)                              §6.3
 10  pick ACS FOB column: FinalFOB vs ExtSzFOB                                       §6.4
 11  pick Costsheet row: MAX First Input Date *within the size-matched subset*      §6.5
 12  pick Costsheet FOB column: Final FOB vs Extended Size FOB                       §6.5
 13  verdictOf(row) → match | diff | noKey | notCompared                             §6.6
```

### The ten rules that actually matter

| # | Rule | Why it exists |
| - | ---- | ------------- |
| 1 | **Join key = Season + Style + Colour + Factory.** Size is *not* in the key — it picks the row afterwards. | Sizes are buckets, not identities |
| 2 | **Blank colour → `all_solid`.** So do `ALL_HTR`, `ALL_AOP`, `RETAIL`, `SOLID1`. | PPS leaves colour blank for solids |
| 3 | **`ALL_*` colourways are ONE code, never split.** | Splitting `ALL_SOLID` destroyed the `all_solid` key → rows took another colour's FOB |
| 4 | **De-dup key uses `ORIG_SIZE_DATA`, never `SIZE_DATA`.** | Keying the bucket merges 3XL/4XL/5XL and sizes vanish |
| 5 | **De-dup key includes `LOCAL_QUOTE_AMOUNT`.** Different price = separate row. | A different price can be a different verdict |
| 6 | **Currency twins collapse *before* de-dup**, grouped **without** the amount. | The amount is what differs between USD/THB twins |
| 7 | **ACS has two FOB columns** — `FinalFOB` when the size matches, `ExtSzFOB` when it fell back. | One ACS row covers several sizes |
| 8 | **Costsheet has two FOB columns too**, chosen by the *Costsheet row's own size*, not the PPS size. | WISDOM is one row per size; ACS is one row with two columns |
| 9 | **MAX(First Input Date) is computed *within* the size-matched subset**, not across all candidates. | Otherwise a newer XL record beats the S record you asked for |
| 10 | **Derive verdicts with `verdictOf()`.** Never re-implement it. | It was copied in 4 places; a 4th state couldn't be added consistently |

### Landmines — every one of these has actually bitten

- **A skipped comparison looks like a failed one.** `notCompared` needed neutral handling in *four* separate places (badge, ACS cell tint, WISDOM cell, Summary donut). A clean build caught none of them. Adding a verdict? Audit every branch on `valueMatch`, `cMatch`, `lqVsAcs`, `!isMatch`. §6.6
- **`serve.py` never hot-reloads.** Waitress loads the module once. A corrected `.py` on disk changes nothing until restart. Cost 21 minutes once.
- **`dist/` is compiled output.** Editing `frontend/src/` does nothing to a running server until `npm run build` *and* the folder is copied. Delete the old `dist/` first — Vite hashes filenames, so merging leaves stale bundles.
- **`annotations.db` is data, not code.** Annotations, groups **and** logs live in that one file. It is per-machine and gitignored. **Never copy it between machines** — it overwrites the target's history.
- **`collapsedRows` *includes* `currencyFilteredRows`.** They are not disjoint; subtract for a duplicates-only figure.
- **`SELECT *` has no `ORDER BY`.** Never rely on ACS/PPS row order; ties must be broken explicitly.
- **`normalizeSizeToken` ≠ `normalizeCostsheetSizeToken`.** The Costsheet one checks EXTEND first, so `4X` and `48` (in *both* size lists) resolve differently. It decides the FOB *column* only — never the matching key.
- **Two verdict namings.** `verdictOf` returns camelCase (`noKey`), `FilterCategory` is lowercase (`nokey`). A cast compiles and silently filters nothing.

### Where the logic lives

| Concern | File |
| ------- | ---- |
| SQL reads, size extraction, colourway expansion | `sql_backend.py` §4 |
| Column config, size lists, `PREFERRED_CURRENCY` | `frontend/src/lib/constants.ts` |
| Key / size / date normalisation | `frontend/src/lib/normalize.ts` |
| **The comparison itself + `verdictOf`** | `frontend/src/lib/comparison.ts` §6 |
| Costsheet index + MAX-date lookup | `frontend/src/lib/costsheet.ts` §6.5 |
| Verdict counts for the Summary tab | `frontend/src/lib/summary.ts` |
| Auth, groups, permissions, logs | `auth_ad.py`, `groups_db.py`, `logs_db.py` 🔐 |

Full file-by-file map: [§0](#0-file-map--which-file-does-what) · Task → file lookup: [§0.7](#07-i-want-to-change-x--open-y)

---

## ⚠️ Read first — the dashboard breaks when the host PC's IP changes

**TL;DR:** The backend URL is baked into the frontend at _build_ time. If the host PC's LAN IP changes, edit `frontend/.env`, rebuild, and restart both servers. Permanent fix: ask IT for a DHCP reservation.

**What happened (2026-07-03):** Users reported "the backend crashed." It hadn't — the host PC's LAN IP had changed overnight (`<OLD_SERVER_IP>` → `<NEW_SERVER_IP>`; another device grabbed the old address, so browsers were calling the wrong computer).

**Why it happens:** DHCP leases on this network last only **8 hours**. While the PC is on, Windows keeps renewing the same IP. Shut it down overnight and the lease expires — on next boot the PC may come up with a new IP.

**Symptom:** the page loads, but no data fetches ("HTTP 0" / backend-down errors), because `VITE_BACKEND_URL` is compiled into the built frontend.

**Recovery after an IP change:**

1. Find the new IP — run `ipconfig`, read the Ethernet adapter's IPv4 address.
2. Edit `frontend/.env` → `VITE_BACKEND_URL=http://<new-ip>:5001`.
3. Rebuild — `cd frontend` then `npm run build`.
4. Restart **both** servers (they are plain console windows and do **not** auto-restart after a reboot):
   - Backend: `python sql_backend.py` (or `python serve.py` once you're on waitress — §9.2b) : [py -m pip install -r requirements.txt] first if you cant run the Backend
   - Frontend: `python -m http.server 8080 --directory dist` : [NPM INSTALL] first if you cant run the Frontend
5. Tell users the new URL: `http://<new-ip>:8080`.

**Do NOT** use the machine hostname (`<HOSTNAME>.example.local`) as the backend URL — DNS also returns the WSL virtual adapter (`<WSL_ADAPTER_IP>`), which other machines can't reach, causing flaky/hanging requests.

**Permanent fix:** ask IT for a **DHCP reservation** binding this PC's Ethernet MAC (`E0-8F-4C-52-2D-BC`) to a fixed IP. After that the IP never changes and steps 1–3 are never needed again. Longer term, host it as a service — see [§10.3](#103-option-b--nssm-service-on-a-shared-server).

---

## 🚨 IMPORTANT — PPS de-duplication: how duplicates are removed while ALL sizes are kept

> **⚠️ Before touching `comparison.ts` or the results table, read this.**
> The de-dup key **MUST** use `ORIG_SIZE_DATA` (the raw size), **NOT** the normalized `SIZE_DATA`.
> Keying on `SIZE_DATA` silently merges different sizes into one bucket (`S` / `M` / `L` / `3XL-T` → `ALL_REG_SIZE_RB` / `ALL_EXTEND_SIZE_RB`) and makes sizes **vanish** from the table. This bit us once — style **FV8505 dropped from 9 sizes to 3**.

**Why de-dup exists:** `dbo.PPS` is a _history log_ — the same style/color/size/quote is re-inserted over time (only dates/status/comments/developer change), so a single factory carries ~4× redundant rows. Example: **HIT = 76,932 raw rows → ~23,036 real cases.**

**What it does:** `dedupePPSRows()` in `frontend/src/lib/comparison.ts` runs **before** the comparison and collapses each factory's rows down to **one row per validation case**, keeping the **newest** record by `INSERT_DATE`. It is **in-memory only** — the database is never modified.

**The key it groups by (per factory / FTYCODE, which is constant per file):**

```
SEASON_YEAR  +  STYLE  +  COLOR  +  ORIG_SIZE_DATA  +  LOCAL_QUOTE_AMOUNT
```

- All five match → true history duplicate → **collapse to one** (keep newest by `INSERT_DATE`).
- **Different `LOCAL_QUOTE_AMOUNT` → stays a separate row** — a different price can be a different Match/Diff verdict, so quotes are intentionally _not_ merged.
- **Size uses `ORIG_SIZE_DATA`** (the raw `3XL-T` the table displays), **NOT** `SIZE_DATA` (the normalized bucket used only for FOB matching). ← _this is the whole trick._ `FileSlotPPS.toPPSRows()` stashes the raw size in `ORIG_SIZE_DATA` and overwrites `SIZE_DATA` with the normalized bucket.

**Proof (verified against the live DB):** style **FV8505 keeps all 9 sizes** in every season, while row counts still collapse correctly (season HO26: **396 raw → 46 cases**).

**Per-factory impact:** HIT 76,932 → 23,036 · HTV 19,435 → 3,615 · HIC 11,274 → 2,293 · HSN 778 → 185.

### Currency twins run BEFORE de-duplication (added 2026-08-06)

`dbo.PPS` quotes the same price **once per currency**. `STYLE-A` / `SU27` / `HIT` / `4XL` held **4.00 USD** and **124.00 THB** — the same price at a ~31 rate. Because `LOCAL_QUOTE_AMOUNT` is deliberately part of the de-dup key (above), the two amounts looked like two different quotes and **both survived to the results table** as a phantom duplicate.

The cause was upstream: `FileSlotPPS.toPPSRows()` projected the payload down to `STRICT_B_COLS`, which kept `LOCAL_QUOTE_AMOUNT` but **dropped `LOCAL_CURRENCY`** — so nothing downstream could tell a currency twin from a genuinely different quote.

`preferUSDRows()` in `comparison.ts` now runs **immediately before** `dedupePPSRows()` and collapses each group to the preferred currency:

```
group key = SEASON_YEAR + STYLE + COLOR + ORIG_SIZE_DATA      ← note: NO amount
```

The amount is excluded **because it is the very thing that differs between twins**.

- Group contains a `PREFERRED_CURRENCY` (`'USD'`, in `constants.ts`) row → other currencies are dropped from that group.
- Group has **no** USD row → passes through **untouched**, so a THB-only quote still reaches the table. It is flagged `comparable: false` and gets the fourth verdict **Not Compared** — its FOB comparison is *skipped*, not performed and failed, so it never inflates the Diff count.
- No `LOCAL_CURRENCY` column at all (an uploaded spreadsheet) → rows returned unchanged, exactly as before.

`STRICT_B_COLS` also regained **`INSERT_DATE`**. `dedupePPSRows` has always intended to keep the newest record by that column, but it was being stripped here first, so the tie-break branch was **dead code**. It changes no output today — it only breaks ties between rows with an *identical* amount, and no such rows differ in any displayed field — but the code and its comment both claimed the behaviour.

**Measured on the live DB** (grouped by factory · season · style · colour · size): **~4.8k** groups hold both currencies (the duplicate), ~22k are USD-only, **5** are THB-only (styles `STYLE-D`, `STYLE-E`), and **174** hold two or more genuinely different USD amounts — those still yield one row per amount, unchanged.

**Caveat:** `collapsedRows` **includes** `currencyFilteredRows`; they are not disjoint. `rawPPSRows` is summed before the currency pass, so subtract one from the other for a duplicates-only figure — `App.tsx` does exactly that when building the Validate toast.

---

## 🔐 VERY IMPORTANT — Authentication (AD login + session): how it actually works

> **Added 2026-07-16.** The whole dashboard now sits behind a login. The moving parts
> (browser **cookie** ↔ Flask **session** ↔ **Active Directory**) are easy to mix up, so
> this explains the flow end-to-end, in plain terms. Read this before touching
> `auth_ad.py`, the auth routes in `sql_backend.py`, or anything in the frontend `useAuth`.

> **Updated 2026-07-20 — permissions.** Login still works exactly as below, but _what you can
> do once signed in_ is now controlled by **app-managed groups** (edit vs read-only, plus who
> can administer groups). See **"Per-group roles"** below.

### TL;DR (the whole thing in 6 lines)

1. Nobody sees the app until they sign in.
2. The browser sends the typed **username + password** to the backend's `POST /login`.
3. The backend checks them — **local dev account first, then Active Directory (AD)**.
4. On success the backend returns a **session cookie**; the browser re-sends that cookie on
   every later request — that's how the backend knows you're logged in.
5. Every data endpoint returns **401 (refuses)** unless that cookie is present.
6. Once in, **what you can do** (view only, save, or administer groups) depends on your
   **app-group permissions** — see "Per-group roles" below.

### The simplest version — who actually checks the password

**The dashboard never checks your password. It borrows it and tries to log in to AD with it.**
If AD lets it in, the password was right. That's the whole idea.

> **Like a doorman testing your key.** You tell him your name and hand him your key. He doesn't
> inspect the key — he walks to your door and **tries it in the lock**. Opens → he lets you in.
> Doesn't open → he turns you away. He never learns what your key is shaped like; he only finds out
> whether it works. AD is the lock. Trying the key in the lock is called a **bind**, and it is the
> only step that matters — everything else is small talk.

So there is **no password comparison anywhere in our code**. Nothing is stored, nothing is hashed,
nothing is compared. We ask AD a yes/no question and believe the answer.

**When do we talk to AD?** Only at the moment someone clicks Sign In (`POST /login`). Not at server
startup, not in the background. Each login opens a connection, asks, and hangs up — like making a
phone call, not like leaving a line open. There is no connection pool and no long-lived session
against AD.

**What happens, in order** (all of it in `auth_ad.py`):

| # | Step                                        | Function              | Talks to AD? |
| - | ------------------------------------------- | --------------------- | ------------ |
| 1 | Read AD's address from `.env`               | `create_ad_server()`  | No — just builds an address object |
| 2 | Phone AD, **turn on encryption**, **try to log in as the user** | **`bind_ad_user()`** | **Yes — this IS the password check** |
| 3 | Now inside, ask "who is this, what groups?" | `read_ad_profile()`   | Yes — one LDAP search |
| 4 | Check those groups against our allow-list   | `is_group_allowed()`  | No — plain text matching |
| 5 | Hang up                                     | `connection.unbind()` | Yes — in a `finally`, always runs |

Only **two lines in the whole project touch the network**: the `Connection(...)` in `bind_ad_user()`
(the connect + StartTLS + bind) and the `connection.search(...)` in `read_ad_profile()`. Step 1 is
the one people mistake for "connecting" — it isn't; it just writes down the address.

**No service account.** Because we bind as the user, we're already authenticated — so the very same
connection is reused to read their groups. That's why `.env` holds no bind DN and no bind password:
there is no extra credential to configure, and none to rotate later.

**Why port 389 when we said it's encrypted?** Two ways exist to encrypt LDAP, and we use the second:

| Way          | Port | How it works                                                              |
| ------------ | ---- | ------------------------------------------------------------------------- |
| LDAPS        | 636  | Encrypted from the very first byte (`AD_USE_SSL=true`)                    |
| **StartTLS** | 389  | Starts plain, then **upgrades to encrypted before anything secret is sent** (`AD_START_TLS=true`) |

389 is normally the *unencrypted* port, which is why the config looks wrong at a glance. It's fine —
the upgrade happens before the password is sent.

### Three things this does NOT mean

Easy to over-read "AD decides". Three limits, and two of them are go-live items:

1. **AD is not the only way in.** The **local account is tried first**, before AD is contacted at
   all — so while `LOCAL_AUTH_ENABLED=true`, one login bypasses AD entirely. Intended for offline
   dev; **set `false` before real users** (go-live item A4).
2. **AD says "this person is real", not "this person is allowed."** A second gate follows:
   `AD_ALLOWED_GROUPS`. **Empty means allow everyone** — i.e. anyone with a working account anywhere
   in the domain can sign in, not just your team. That may be exactly what you want; just make it a
   deliberate decision rather than a default.
3. **AD does not decide what you can _do_.** Identity and permissions are separate systems here:

| Question                        | Who decides                                     |
| ------------------------------- | ----------------------------------------------- |
| Are you really who you claim?   | **Active Directory**                            |
| May you log in at all?          | `AD_ALLOWED_GROUPS` (empty = everyone)          |
| May you **save** edits?         | **The app's own groups** (`groups_db`) — not AD |
| May you **administer** groups?  | **The app's own groups** (`groups_db`) — not AD |

The honest one-liner: **AD decides who you are; the app decides what you can touch.** A logged-in
user in no app group is **read-only**, and `INITIAL_ADMINS` is what gives the first person full
rights before any groups exist. See "Per-group roles" below.

### The two "hops" — this is the part people confuse

There are **two separate connections**, and they're encrypted by **different** things:

- We need 2 hop because the browser can't talk to AD directly(They speak different language)
- The backend is the translator. so it need to get the password from the browser and translate it to AD

```
 Browser  --(hop 1: password + cookie)-->  Flask backend  --(hop 2: AD bind)-->  Active Directory
           \___ secured by HTTPS(Not encrpyted) ___/          \___ secured by StartTLS(encrpyted) ___/
           \___ Frontend => Backend (HTTPS) ___/                      \___ Backend => AD (LDAP) ___/

 TODAY (dev):
 Browser  --(hop 1: password + cookie, plain HTTP — NOT encrypted)-->  Flask backend
 Flask backend  --(hop 2: AD bind, StartTLS — encrypted)-->  Active Directory

 GOAL (production):
 Browser  --(HTTPS)-->  Reverse proxy (frontend + backend behind one FQDN)
 Flask backend  --(StartTLS)-->  Active Directory
```

> Note: the protocol belongs to the **connection**, not the machine — hop 1 is one
> connection, so it's either all HTTP or all HTTPS. Strictly the browser also loads the
> page itself (HTML/JS) from the frontend server first; that leg must be HTTPS too,
> otherwise tampered JS could steal the password before it's ever sent. Putting frontend
>
> - backend behind one HTTPS reverse proxy fixes both legs at once.

| Hop                     | Carries                                            | Secured by                         | Status today                              |
| ----------------------- | -------------------------------------------------- | ---------------------------------- | ----------------------------------------- |
| **1 — Browser → Flask** | the typed password, then the session cookie        | **HTTPS** (TLS on the web server)  | **Plain HTTP in dev — NOT encrypted yet** |
| **2 — Flask → AD**      | the LDAP "bind" that verifies the password with AD | **StartTLS** (`AD_START_TLS=true`) | **Already encrypted**                     |

> ⚠️ The #1 confusion: `AD_START_TLS` only protects **hop 2**. It does **nothing** for the
> password on **hop 1**. Hop 1 becomes encrypted when we put **HTTPS** on the server — and
> only then do we set `COOKIE_SECURE=true`.

### The login flow, step by step

1. **Page loads.** React calls `GET /me` ("is there a valid session?"). No cookie yet → **401**
   → the **login page** is shown.
2. **User submits** username + password → React does `POST /login` with `credentials:'include'`
   (so the cookie can be set/sent).
3. **Backend `authenticate()`** (in `auth_ad.py`) runs, in this order:
   - **Local dev account** — if `LOCAL_AUTH_ENABLED` and the creds equal `LOCAL_AUTH_USER` /
     `LOCAL_AUTH_PASSWORD` → pass (source = `local`). This is the offline/dev path.
   - **Active Directory** — otherwise, if `AD_ENABLED`, it **binds** to AD as
     `username@example.local` over StartTLS. AD itself checks the password. If OK, it reads
     the user's profile + groups (`memberOf`).
   - Either path then checks **`AD_ALLOWED_GROUPS`** (empty = everyone allowed).
4. **Success** → the backend saves the user in a **server-side session** and returns a **signed
   cookie** (just an opaque ID — no password inside). React swaps the login page for the app.
5. **Failure** → **401 "Invalid username or password"** (one generic message; we never reveal
   whether the username exists).

### What "session" and "cookie" actually mean here (plain version)

- A **cookie** is a small token the browser stores and **automatically attaches to every future
  request** to the backend. Ours is:
  - **HttpOnly** — JavaScript cannot read it (so a malicious script can't steal it).
  - **Signed** with `FLASK_SECRET_KEY` — the browser can't forge or edit it.
  - **1-day lifetime** (`SESSION_LIFETIME_DAYS`) — after that you sign in again.
  - **Secure** only when `COOKIE_SECURE=true` (turn on once HTTPS is live).
- The cookie holds only a reference; the real user info (username, groups) lives in the Flask
  session on the server. So **"logged in" = "the browser is sending a valid session cookie."**
- **Logout** (`POST /logout`) clears the session, so the cookie maps to nobody anymore.

### Which file does what

| File                                     | Role                                                                                                                                                                                             |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DashBoard/.env`                         | All auth config + secrets (AD settings, local account, `FLASK_SECRET_KEY`). **Never commit it** (it's gitignored).                                                                               |
| `DashBoard/auth_ad.py`                   | The actual credential check: `authenticate()` (local → AD), the `ldap3` bind, and the group policy. Ported from the team's Django backend.                                                       |
| `DashBoard/sql_backend.py`               | Session/cookie config, CORS-with-credentials, the `/login` · `/logout` · `/me` routes, the `@login_required` / `@require_edit` / `@require_manage` guards, and the `/groups*` management routes. |
| `DashBoard/groups_db.py`                 | App-managed groups + membership (SQLite, inside `annotations.db`); `resolve_perms(username)` computes a user's `can_edit` / `can_manage` at login.                                               |
| `frontend/src/hooks/useAuth.tsx`         | React auth state: checks `/me` on load (so refresh keeps you signed in), exposes `login()` / `logout()`.                                                                                         |
| `frontend/src/components/LoginPage.tsx`  | The sign-in form.                                                                                                                                                                                |
| `frontend/src/App.tsx`                   | The gate: shows _loading → login → app_ based on auth state.                                                                                                                                     |
| `frontend/src/lib/api.ts`                | Adds `credentials:'include'` to every call (so the cookie flows) and bounces to login on any 401.                                                                                                |
| `frontend/src/components/Header.tsx`     | Shows the signed-in name + Logout button, and (managers only) the **Groups** button.                                                                                                             |
| `frontend/src/components/GroupAdmin.tsx` | The admin screen: create groups, toggle each group's edit/manage switches, add/remove AD usernames. Manager-only.                                                                                |

### Configuration (all in `DashBoard/.env`)

| Variable                                             | Meaning                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AD_ENABLED`                                         | Turn AD login on/off.                                                                                                                                                                                                                                                     |
| `LOCAL_AUTH_ENABLED`                                 | Allow the local dev account. **Set `false` in production.**                                                                                                                                                                                                               |
| `LOCAL_AUTH_USER` / `_PASSWORD` / `_GROUP`           | The dev account (used for local work / when AD is unreachable).                                                                                                                                                                                                           |
| `AD_SERVER` · `AD_PORT` · `AD_DOMAIN` · `AD_BASE_DN` | Which AD to talk to and where to search.                                                                                                                                                                                                                                  |
| `AD_START_TLS` · `AD_USE_SSL` · `AD_TLS_VALIDATE`    | Encryption + cert validation for **hop 2**.                                                                                                                                                                                                                               |
| `AD_AUTH_MODE`                                       | `SIMPLE` = bind as `user@domain` · `NTLM` = bind as `DOMAIN\user`.                                                                                                                                                                                                        |
| `AD_USER_FILTER`                                     | LDAP filter to locate the user (enabled accounts only).                                                                                                                                                                                                                   |
| `AD_ALLOWED_GROUPS`                                  | Comma-separated group CNs/DNs allowed to **log in**. **Empty = everyone.**                                                                                                                                                                                                |
| `AD_EDITOR_GROUPS` ⚠️                                | _(obsolete — superseded 2026-07-20 by app-managed groups; no longer read; safe to delete)_ Formerly named the edit/save groups.                                                                                                                                           |
| `AD_READONLY_GROUPS` ⚠️                              | _(obsolete — superseded 2026-07-20; no longer read; safe to delete)_                                                                                                                                                                                                      |
| `INITIAL_ADMINS`                                     | Comma-separated AD `sAMAccountName`s always treated as **full admins** (can_edit + can_manage), even before any groups exist — bootstrap + lock-out recovery. Currently `your-admin-username`.                                                                            |
| `AD_CA_CERT_FILE`                                    | PEM for an internal CA, if Python doesn't already trust the AD cert.                                                                                                                                                                                                      |
| `FLASK_SECRET_KEY`                                   | Signs the session cookie. Must stay **stable** (changing it logs everyone out) **and** be a strong random secret — permissions ride in the cookie, so the default `dev-insecure-change-me` would let anyone forge an admin session. **Set a real secret before go-live.** |
| `SESSION_LIFETIME_DAYS`                              | How long a login lasts (default 1).                                                                                                                                                                                                                                       |
| `COOKIE_SECURE`                                      | `false` on HTTP, **`true` on HTTPS**.                                                                                                                                                                                                                                     |
| `CORS_ALLOWED_ORIGINS`                               | Empty = reflect the caller's origin (dev). Set the FQDN at deployment.                                                                                                                                                                                                    |

### Per-group roles — editor vs read-only (✅ built 2026-07-20)

**How it works now:** login (via `AD_ALLOWED_GROUPS`) decides _who gets in_; **app-managed
groups** decide _what they can do once in_. These groups are the app's own (MER, POM,
Admins, …) — **not** AD security groups. AD only proves identity; you create the groups and
add people yourself, in the dashboard.

Each group carries two switches:

- **`can_edit`** — members may **save** the Error From / Done annotations.
- **`can_manage`** — members may **administer groups** (create groups, add/remove members,
  change permissions).

**The rules:**

- A logged-in user in **no** group → **read-only** (can view; the Error From / Done cells and the Save button are disabled).
- Membership is by AD `sAMAccountName`; a user in several groups gets the **combined,
  most-permissive** rights.
- **`INITIAL_ADMINS`** (in `.env`, currently `your-admin-username`) is always full admin — this
  bootstraps the very first admin (you can't add anyone from an empty groups list) and is the
  lock-out recovery path.
- Permissions are **resolved at login** and stored in the session. Changing someone's groups
  takes effect on **their next login**, not instantly.

**Where it lives:**

- Storage: `groups_db.py` → `groups` + `group_members` tables inside `annotations.db`.
- Enforcement (server-side — the real gate): `@require_edit` on `POST /annotations`,
  `@require_manage` on every `/groups*` route. A read-only user gets **403** even calling the
  API directly — the frontend only _hides_ controls for tidiness.
- Admin UI: the **Groups** button in the header (managers only) opens `GroupAdmin.tsx`.

**Typical setup:** log in as an `INITIAL_ADMINS` user → **Groups** → create an editing group
(e.g. `MER` with _can edit_) and an admin group (with _can manage_) → add AD usernames.

> The old `AD_EDITOR_GROUPS` / `AD_READONLY_GROUPS` `.env` scaffold is **superseded** and no
> longer read — edit rights now come from app groups, not AD groups. Those vars are safe to delete.

### Admin Log page (who's online · logins · change history)

> **Added 2026-07-21.** A second admin view, gated on `can_manage`.

On login an **admin** lands on a **two-card chooser** — **Dashboard-Log** and
**Dashboard-Compare-Data** — and can switch anytime via the header switcher. The switcher shows
**Compare Data | Summary** to every logged-in user, plus **Log** for admins. **Non-admins skip the
chooser** and land on the validator, but they still get the Compare / Summary switch — they just
never see **Log**.

The **Log** view has three read-only panels:

- **Online now — who's using the dashboard right this second.** While anyone has the app open,
  their browser quietly "checks in" every ~30s (`POST /ping`); this panel lists everyone seen in
  the **last 2 minutes** and refreshes itself every 15s, so it stays roughly live. Close the tab
  and you drop off within ~2 minutes. (You'll see yourself here while viewing the Log — expected.)
- **Logins — who signed in, and when.** Every successful login records one row: who · when ·
  whether it was AD or the local account. Shown for the selected **week** (Sunday–Saturday,
  defaults to the current week; use ◀ / ▶ to look back), newest first.
- **Changes — the full audit trail of edits.** Every Save records one row **per field that
  actually changed** in the Error From / Done columns: who · when · which row · which field ·
  **old value → new value** (clearing a row is logged too). Unlike the annotations themselves —
  which only remember the _latest_ editor — this keeps **every** change, so you get the whole
  history, not just the current state. Also scoped to the selected **week** (defaults to the
  current week, which rolls over at **Sunday midnight**).

**Where it lives:**

- Storage: `logs_db.py` → `presence` / `login_events` / `change_log` tables inside
  `annotations.db` (same WAL setup as the rest).
- Capture: `POST /login` records a login; `annotations_db.save()` returns the field diffs and the
  save route writes them to `change_log`.
- Enforcement (server-side): the three read routes are `@require_manage` (403 for non-admins, even
  via direct API); `/ping` is only `@login_required`. The Log tables are **read-only** — no route
  edits or deletes them.
- UI: `frontend/src/components/LogDashboard.tsx`, reached from the header switcher / landing
  chooser; a `usePresenceHeartbeat` hook pings while you're logged in.

Nothing else is logged — no reads, filters, or CSV exports. Rows accumulate (no auto-pruning; tiny
text — prune later if it ever grows).

### Going to production — checklist

1. Put the app behind **HTTPS** (reverse proxy such as IIS/Caddy, or Flask TLS).
2. `COOKIE_SECURE=true`.
3. Set a **strong random `FLASK_SECRET_KEY`** (not the dev default) — permissions ride in the signed cookie.
4. `LOCAL_AUTH_ENABLED=false` (disables the `Admin`/`1234` dev account).
5. Set `AD_ALLOWED_GROUPS` (who may **log in**); then, in the app, create groups and set `INITIAL_ADMINS` (who may **edit / manage**) — see "Per-group roles".
6. Optionally lock `CORS_ALLOWED_ORIGINS` to the FQDN.

### Troubleshooting

| Symptom                                           | Likely cause / fix                                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correct AD password is rejected                   | UPN suffix mismatch — set `AD_AUTH_MODE=NTLM` (binds as `DOMAIN\user`, sidesteps `@domain`).                                                                                                |
| Everyone logged out after a backend restart       | `FLASK_SECRET_KEY` changed or was unset — keep it fixed in `.env`.                                                                                                                          |
| Login works but data calls 401 in the browser     | Cookie isn't being sent. Confirm the frontend uses `credentials:'include'` and CORS has `supports_credentials`. Frontend + backend on **different hostnames** need `SameSite=None` + HTTPS. |
| `ModuleNotFoundError: ldap3`                      | Run `pip install -r requirements.txt`.                                                                                                                                                      |
| AD login fails with a TLS error                   | Server doesn't trust the AD cert — point `AD_CA_CERT_FILE` at the internal CA PEM, or (dev only) `AD_TLS_VALIDATE=false`.                                                                   |
| Local `Admin`/`1234` won't work                   | Is `LOCAL_AUTH_ENABLED=true` and do the creds match `.env`? It's meant to be `false` in production.                                                                                         |
| **Save** is greyed out ("Read-only")              | The user isn't in a group with `can_edit`. Add them to an editing group via **Groups** (or to `INITIAL_ADMINS`) — then they must **log in again** for it to take effect.                    |
| No **Groups** button for someone who should admin | They lack `can_manage` — add them to a managing group (or `INITIAL_ADMINS`) and have them re-login.                                                                                         |
| A group/permission change didn't take effect      | Permissions are resolved **at login** — the affected user must sign out and back in.                                                                                                        |

---

## 🚀 Need to fix when go full live (production go-live checklist)

> Get a name for internal Link(FQDN) -> get a certificate for that name -> enable HTTPS with it -> Hop 1 is now encrypted  
> **Status: NOT done yet.** Today the app runs as two dev terminals over plain **HTTP** with the
> local `Admin`/`1234` account enabled. Everything below must be done **before real users sign
> in**. Related: the **Authentication** section above and §10.3 (NSSM service).

### A. Security — do before ANY real user logs in

- [ ] **HTTPS** — get a cert for the FQDN and terminate TLS (reverse proxy, see C). Encrypts the
      AD password on **hop 1**, which is currently plaintext on the LAN.
- [ ] **`COOKIE_SECURE=true`** in `DashBoard/.env` — session cookie only travels over HTTPS.
- [ ] **Strong `FLASK_SECRET_KEY`** in `DashBoard/.env` — **critical**: permissions ride in the
      signed session cookie, so the default `dev-insecure-change-me` lets anyone forge a
      `can_manage` admin session. Set a long random value.
- [ ] **`LOCAL_AUTH_ENABLED=false`** — disables the `Admin`/`1234` dev backdoor.
  <!-- - [ ] **`AD_ALLOWED_GROUPS=<real group(s)>`** — restrict who can **log in**. _(Still need to
        decide the 1–2 groups.)_ [No Need Anymore] -->
  <!-- - [ ] **Set up app groups + `INITIAL_ADMINS`** — edit/manage rights are now **app-managed**
        (built 2026-07-20): log in as an `INITIAL_ADMINS` user and create the groups in-app (see
        the "Per-group roles" note in the Authentication section). _The old `AD_EDITOR_GROUPS`
        scaffold is obsolete._ [No Need Anymore] -->
- [ ] **`CORS_ALLOWED_ORIGINS` = the FQDN** — or make everything same-origin (see C) and CORS
      isn't needed at all.

### B. Reliability — do to be "always on"

- [x] **Run Flask under `waitress`** (production WSGI server), not `python sql_backend.py` — the
      built-in Flask server is single-threaded and dev-only. **Code side done 2026-07-31:**
      `waitress==3.0.0` is in `requirements.txt` and **`DashBoard/serve.py`** is the entry point.
      Per server: `python -m pip install -r requirements.txt`, then `python serve.py` (expect
      `* waitress serving on http://0.0.0.0:5001 (8 threads)`). Override with `SERVE_HOST` /
      `SERVE_PORT` / `SERVE_THREADS` — set `SERVE_HOST=127.0.0.1` once C's reverse proxy is in front,
      so Flask no longer faces the LAN. _Still to do: run it on the server._
- [ ] **Register the backend + frontend as Windows services (NSSM)** so they auto-start on boot.
      Today they're console windows that die on logout/reboot.
- [ ] **Give the server a DNS name (FQDN)** — users hit `https://pps-validator.example.local`
      instead of an IP. _This also permanently fixes the "IP changes break everything" problem
      described in the IP note below._

### C. Recommended architecture (simplest that covers A + B)

One reverse proxy (IIS — already on the server — or Caddy) in front:

```
              ┌──────────────────────────────────────────────┐
  Users ──▶   │ Reverse proxy on :443 (HTTPS, cert bound here)│
  https://    │   /                  → serves built  dist/    │
  fqdn        │   /login /me /get_*  → waitress(Flask) :5001  │  (localhost only)
              └──────────────────────────────────────────────┘
```

Frontend + backend become the **same origin** → the session cookie just works (no CORS, no
`SameSite` issues), HTTPS lives in one place, and Flask never faces the network directly.

### D. Housekeeping

- [x] ~~Add `waitress` to `requirements.txt`~~ — **done 2026-07-31** (moved out of
      `requirements-dev.txt`, where it would never have been installed on a server). Still run
      `python -m pip install -r requirements.txt` **on each server** (also pulls `ldap3`,
      `python-dotenv`). Use `python -m pip`, not bare `pip` — bare `pip` can resolve to a different
      interpreter than `python` and install where your `python` can't see it.
- [ ] Ensure `DashBoard/.env` exists on the server with **production** values (it's gitignored —
      it will NOT come from git).
- [ ] Point NSSM to write stdout/stderr to log files (helps debug AD/login).
- [ ] Firewall: **443 inbound** (users), **389/636 outbound** (to the domain controller).

### Still needed before we can start

- **FQDN(Fully Qualifed Domain Name)** => The full network name of a computer Ex: pps-validator.example.local
- **TLS Certificate** =>
- **AD group name(s)** for `AD_ALLOWED_GROUPS`.

### Code vs infra split

- **Code/config (small, ~30 min):** ~~add `waitress` + a run script~~ (**done** — `serve.py`), flip
  the `.env` production values, point the frontend at the same origin, rebuild.
- **Infra (on the server):** cert + DNS, reverse proxy + cert binding, NSSM services — a runbook
  to be written.

---

## Table of Contents

0. [File Map — which file does what](#0-file-map--which-file-does-what)
1. [Purpose & Business Context](#1-purpose--business-context)
2. [High-Level Architecture](#2-high-level-architecture)
3. [Data Sources](#3-data-sources)
4. [Backend (`sql_backend.py`)](#4-backend-sql_backendpy)
5. [Frontend Architecture](#5-frontend-architecture)
6. [Domain Logic — Deep Dive](#6-domain-logic--deep-dive)
7. [UI Behaviour](#7-ui-behaviour)
8. [Known Gotchas & Fixed Bugs](#8-known-gotchas--fixed-bugs)
9. [Running the Project](#9-running-the-project)
10. [Hosting on the Internal Network](#10-hosting-on-the-internal-network)
11. [Extending the App](#11-extending-the-app)
12. [Troubleshooting](#12-troubleshooting)

Appendices: [A — File-level comment map](#appendix-a--file-level-comment-map) · [B — Legacy `index.html`](#appendix-b--legacy-indexhtml)

---

## 0. File Map — which file does what

**TL;DR:** One line per file, whole project, in one place. Backend is Python in `DashBoard/`; frontend is React/TypeScript in `DashBoard/frontend/src/`. If you only remember one rule: **pure logic lives in `frontend/src/lib/`, all React state lives in `App.tsx`, and every HTTP route lives in `sql_backend.py`.**

Deeper write-ups for each area: backend → [§4.0](#40-backend-files-infrastructure) · frontend → [§5.2](#52-file-infrastructure-for-frontend) · suggested reading order → [Appendix A](#appendix-a--file-level-comment-map).

### 0.1 Backend — `DashBoard/*.py`

| File                  | What it does                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `sql_backend.py`      | **The Flask app — every HTTP route.** Auth, data endpoints, annotations, groups, admin logs. Session/CORS config, the three access guards, and the SQL Server connection helper. This is the file you run in dev. |
| `serve.py`            | **Production entry point.** Imports `app` from `sql_backend` and serves it under waitress. Use this on a server, not `python sql_backend.py`. Host/port/threads come from `SERVE_*` env vars. |
| `auth_ad.py`          | **Password check only** — no Flask, no DB. Local dev account → Active Directory bind → `AD_ALLOWED_GROUPS` policy. Returns a plain user dict. |
| `annotations_db.py`   | SQLite store for the **Error From / Done** columns. `save()` upserts and also returns the change diffs the audit log records. |
| `groups_db.py`        | SQLite store for the **app's own groups & permissions**. `resolve_perms(username)` runs at login (most-permissive wins; no group = read-only). |
| `logs_db.py`          | SQLite store for the **admin Log page** — presence, login events, change history. Append-only, UTC timestamps, Sunday–Saturday weeks. |
| `annotations.db`      | The **one SQLite file** all three `*_db.py` modules share (WAL). Everything the app persists locally. Backup = copy this file. Gitignored. |
| `requirements.txt`    | Runtime deps: Flask, flask-cors, pyodbc, ldap3, python-dotenv, waitress.                                          |
| `requirements-dev.txt`| Test-only dep: pytest.                                                                                            |
| `.env`                | **All config + secrets**, gitignored — AD settings, local account, `FLASK_SECRET_KEY`, `INITIAL_ADMINS`, CORS. Never commit. |
| `.env.example`        | Committed placeholder template — same keys, dummy values. Copy to `.env` and fill in.                             |

### 0.2 Backend tests — `DashBoard/tests/`

| File                          | What it covers                                                          |
| ----------------------------- | ----------------------------------------------------------------------- |
| `conftest.py`                 | Fixtures: isolated temp DB, Flask test client, `login_as()` session helper. |
| `test_annotations_db.py`      | Annotation save + change-diff logic.                                     |
| `test_groups_db.py`           | Groups CRUD + `resolve_perms` rules.                                     |
| `test_logs_db.py`             | Presence / logins / changes storage.                                     |
| `test_permissions_routes.py`  | Route guards end-to-end (401 vs 403 vs 200), `/ping`, `/admin/*`.        |

Run: `python -m pytest tests/ -v`

### 0.3 Frontend — domain logic (`frontend/src/lib/`, zero React)

| File            | What it does                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `comparison.ts` | **The heart of the app.** `runComparison()` — builds the ACS index, walks every de-duplicated PPS row, picks the best ACS row, and emits one verdict row per PPS row. Start here when a row shows the wrong result. |
| `normalize.ts`  | Atomic helpers: join-key normalisation, size bucketing (`ALL_REG_SIZE_RB` / `ALL_EXTEND_SIZE_RB`), `extractSizeFromCBDID`, date + header parsing. Note **two** size resolvers: `normalizeSizeToken` (shared — PPS/ACS matching) and `normalizeCostsheetSizeToken` (Costsheet FOB-source only; differs for `4X` and `48`). |
| `constants.ts`  | **Configuration single-source-of-truth** — `KEY_PAIRS` (which ACS column joins which PPS column), `REG_SIZES` / `EXTEND_SIZE`, Costsheet header aliases, file-badge colours, `MAX_B_FILES`. |
| `costsheet.ts`  | `buildCostsheetIndex` + `lookupCostsheet` — the WISDOM side: the MAX-First-Input-Date winner rule, and the per-row choice between `Final FOB` and `Extended Size FOB`. |
| `csv.ts`        | `exportComparisonCSV` — the export format (adds Verdict + Diff_Reason).                                                |
| `summary.ts`    | Match / Diff / No-Key aggregation behind the Validation Summary tab.                                                   |
| `api.ts`        | The only file that talks to the backend — ACS/Costsheet/PPS fetches, auth, group-admin calls.                          |
| `types.ts`      | Shared TypeScript types (`TableData`, `PPSFile`, `CompRow`, …). Read this first to understand the data shapes.         |

### 0.4 Frontend — React (`frontend/src/`)

| File                            | What it does                                                                        |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| `main.tsx`                      | ReactDOM mount. You will almost never touch it.                                     |
| `App.tsx`                       | **Root component and the owner of all state** (see [§5.3](#53-state-model)). Wires everything together; Validate is triggered from here. |
| `components/Header.tsx`         | Top bar — switches between the three views (**Compare / Summary / Log**, Log is manager-only), plus the Groups-admin and Logout buttons. |
| `components/UploadStrip.tsx`    | Composes the three file slots below.                                                |
| `components/FileSlotACS.tsx`    | Loads `dbo.ACS` from the backend.                                                   |
| `components/FileSlotPPS.tsx`    | Drag-and-drop PPS files, xlsx parsing, column strip-down, size normalisation.       |
| `components/FileSlotCostsheet.tsx` | Loads the Costsheet/WISDOM view.                                                 |
| `components/PreviewTable.tsx`   | Shared mini preview table used by all three slots.                                  |
| `components/KeyInfoPanel.tsx`   | Shows the join keys + FOB rules, holds the **Validate** button.                     |
| `components/ResultsToolbar.tsx` | Stats, search, filter buttons, CSV export, **Save** (disabled for read-only users). |
| `components/ResultsTable.tsx`   | **The big results grid** with the sticky-right verdict column.                      |
| `components/SummaryDashboard.tsx` | Validation Summary — Match/Diff/No-Key by factory & season (all users).           |
| `components/GroupAdmin.tsx`     | Admin screen: create groups, add members, set edit/manage (manager-only).           |
| `components/LogDashboard.tsx`   | Admin Log page: online-now / logins / change history (manager-only).                |
| `hooks/useAuth.tsx`             | Auth context — login/logout, calls `/me` on load.                                   |
| `hooks/useToast.tsx`            | Toast context + provider.                                                           |
| `hooks/usePresenceHeartbeat.tsx`| Pings `/ping` every 30s while logged in — feeds the "online now" list.               |
| `styles/tokens.css`             | CSS variables — palette, type scale, spacing. Change the theme here.                |
| `styles/global.css`             | Component classes.                                                                  |

### 0.5 Frontend — build config (`frontend/`)

| File                    | What it does                                                                  |
| ----------------------- | ----------------------------------------------------------------------------- |
| `index.html`            | Vite's HTML entry point.                                                      |
| `package.json`          | Scripts (`npm run dev` / `build` / `preview`) and dependencies.                |
| `vite.config.ts`        | Vite config — React plugin, dev server on port 5173, `host: true` so the LAN can reach it. No proxy: the frontend calls the backend directly. |
| `tsconfig*.json`        | TypeScript strict-mode config.                                                 |
| `.env`                  | Frontend-only env vars (gitignored). Normally **empty** — leaving `VITE_BACKEND_URL` unset makes the app call port 5001 on whatever host served the page, which survives IP changes. Only set it if the backend runs on a different machine, and re-run `npm run build` after. |
| `dist/`                 | **Build output** — generated by `npm run build`. Never edit by hand.           |
| `node_modules/`         | Installed packages. Gitignored.                                               |
| `README.md`             | Frontend-only quick reference.                                                |

### 0.6 Everything else in `DashBoard/`

| Path                       | What it is                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------- |
| `README.md`                | **This file** — the full handover documentation.                                                   |
| `HTML Version/`            | The original single-file HTML app this project grew out of (`index.html`, plus `Version1/2` and `Debug` snapshots). Kept as a reference/fallback — see [Appendix B](#appendix-b--legacy-indexhtml). **New features go in the React app, not here.** |
| `infrastructure Document/` | The handover PDFs (EN + TH).                                                                        |
| `docs/`                    | `superpowers/plans` and `superpowers/specs` — working plan/spec notes from Claude Code sessions. Not app code. |
| `.gitignore`               | Keeps `.env`, `annotations.db`, `node_modules/`, and build output out of git.                       |
| `.claude/`                 | Claude Code local settings. Not part of the app.                                                    |

### 0.7 "I want to change X" → open Y

| I want to…                                            | Open                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| Change which columns join ACS ↔ PPS                    | `lib/constants.ts` → `KEY_PAIRS` (then [§11.1](#111-add-a-new-key-column)) |
| Add a size so it stops landing in the wrong bucket     | `lib/constants.ts` → `REG_SIZES` / `EXTEND_SIZE`                       |
| Fix a wrong Match/Diff verdict                         | `lib/comparison.ts` → `runComparison`                                  |
| Fix a row that says "No Key Match" but shouldn't       | `lib/comparison.ts` (index build) + `lib/normalize.ts` (`normalizeJoinKey`) |
| Fix the wrong WISDOM row being picked                  | `lib/costsheet.ts` → `lookupCostsheet`                                 |
| Fix a row showing another colour's ACS FOB             | `sql_backend.py` → `expand_colorway_rows` ([§4.3](#43-colorwaycode-row-expansion)) |
| Change which currency is compared / add THB support    | `lib/constants.ts` → `PREFERRED_CURRENCY`; `lib/comparison.ts` → `preferUSDRows` |
| Add or change a verdict state                          | `lib/comparison.ts` → `verdictOf` ([§6.6](#66-3-way-verdict-logic)) — then audit every `valueMatch` / `cMatch` branch |
| Change which FOB column WISDOM reads for a size        | `lib/costsheet.ts` → `isExt` / `srcIdx` in `buildCostsheetIndex`; size lists in `lib/constants.ts` ([§6.5](#65-costsheet-matching-max-first-input-date)) |
| Extended sizes all show "No CS"                        | [§12 troubleshooting](#extended-sizes-all-show-no-cs-but-regular-sizes-are-fine) — usually a renamed view column |
| Change a column heading or add a table column          | `components/ResultsTable.tsx`                                          |
| Change what the CSV export contains                    | `lib/csv.ts`                                                           |
| Add or change an API endpoint                          | `sql_backend.py`                                                       |
| Point at a different SQL Server / table                | `.env` (`DB_SERVER`, `DB_DATABASE`, `DB_TABLE_*`) — see [§11.6](#116-point-at-a-different-sql-server--table) |
| Change who can log in                                  | `.env` (`AD_ALLOWED_GROUPS`) + `auth_ad.py`                            |
| Change who can edit vs manage                          | The in-app Group Admin screen; logic in `groups_db.py`                 |
| Change colours / spacing / fonts                       | `styles/tokens.css`                                                    |

---

## 1. Purpose & Business Context

**TL;DR:** For every uploaded PPS row, confirm its FOB price (`LOCAL_QUOTE_AMOUNT`) matches **both** the ACS FOB **and** the Costsheet/WISDOM Final FOB. Mismatches get flagged. This replaces a manual Excel VLOOKUP workflow.

The dashboard validates **`LOCAL_QUOTE_AMOUNT`** (the FOB price on a PPS quote) against two authoritative sources:

- **ACS** (`dbo.ACS`) — the master DB of per-style / per-color / per-size FOB values.
- **Costsheet / WISDOM** (`dbo.VIEW_COSTSHEET_WISDOM`) — the newer costsheet view whose FOB should also agree. Which column that is depends on the row's size: `Final FOB` for regular sizes, `Extended Size FOB` for extended ones ([§6.5](#65-costsheet-matching-max-first-input-date)).

For each PPS row it answers one question: _does `LOCAL_QUOTE_AMOUNT` match **both** the ACS FOB **and** the Costsheet FOB?_

| Result           | Meaning                                                                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Match**        | All available sources agree.                                                                                     |
| **Diff**         | At least one source disagrees; a hint names which one.                                                           |
| **No Key Match** | ACS has no row for this key (even after color fallback); diagnostics show what ACS _does_ have for related keys. |

It replaces a manual Excel VLOOKUP + eyeball-compare workflow that was too slow and error-prone for the volume of PPS rows going through the ordering process.

---

## 2. High-Level Architecture

**TL;DR:** Browser → Flask backend (`:5001`) → SQL Server. ACS and Costsheet come from the DB; PPS files are parsed entirely in the browser. Dev-only, no auth.

```
┌────────────────────────┐        ┌──────────────────────────────────┐
│  User's browser         │───────▶│  Flask backend (sql_backend.py) │
│  (Vite dev :5173 or     │  HTTP  │  Port 5001, CORS *              │
│   static build)         │◀───────│                                  │
└────────────────────────┘        │  Endpoints:                      │
        │                          │   /get_file_a_data (ACS)         │
        │  User drops              │   /get_costsheet_data            │
        │  PPS .xlsx files         └────────┬─────────────────────────┘
        ▼                                   │  ODBC (Trusted_Connection)
┌────────────────────────┐                  ▼
│  Browser XLSX parser    │        ┌──────────────────────────────────┐
│  (SheetJS / xlsx)       │        │  SQL Server                      │
└────────────────────────┘        │  <SQL_HOST>\<SQL_HOST>          │
                                  │  Database: <DATABASE>            │
                                  │   • dbo.ACS                       │
                                  │   • dbo.VIEW_COSTSHEET_WISDOM     │
                                  └──────────────────────────────────┘
```

**Deployment model:** dev-only — both processes run on the analyst's laptop. There is no auth layer: Flask has open CORS and SQL Server relies on Windows integrated auth (`Trusted_Connection=yes`). **Add auth before moving this to a shared server.**

---

## 3. Data Sources

**TL;DR:** Three inputs — **A** = ACS (DB), **B** = PPS files (browser upload, up to 4), **C** = Costsheet (DB, optional; upgrades 2-way → 3-way). A and C are fetched from SQL Server and get backend-side colorway row expansion plus a derived `EXTRACTED_SIZE`.

### 3.1 File A — ACS Database (`dbo.ACS`)

Fetched via `/get_file_a_data`. The backend adds a virtual column and expands rows:

- **`EXTRACTED_SIZE`** (appended by backend): the last two dash-segments of `CBDID`, joined with underscore.
  Example: `SU27-HTV-HV8232-S-ALL_SOLID-ALL_REG_SIZE-RB` → `ALL_REG_SIZE_RB`
- **`ColorwayCode` row expansion**: if `ColorwayCode` contains underscores (e.g. `RED_BLU_GRN`), the backend splits it into one row per code so the JOIN key is exact.

Key columns used by the frontend:

| Column           | Purpose                                    |
| ---------------- | ------------------------------------------ |
| `Season`         | Join key (matches PPS `SEASON_YEAR`)       |
| `StyleNumber`    | Join key (matches PPS `STYLE`)             |
| `ColorwayCode`   | Join key (matches PPS `COLOR`)             |
| `FactoryCode`    | Join key (matches PPS `FTYCODE`)           |
| `EXTRACTED_SIZE` | Derived size for matching PPS `SIZE_DATA`  |
| `CBDID`          | Source of `EXTRACTED_SIZE`                 |
| `FinalFOB`       | FOB to use when PPS size == ACS CBDID size |
| `ExtSzFOB`       | FOB to use when PPS size != ACS CBDID size |

### 3.2 File B — PPS Files (uploaded via drag/drop)

`.xlsx` / `.xls` / `.csv` files uploaded by the user, up to 4 at once. Matching is by **exact, case-sensitive** header text, and only these columns are kept — everything else is dropped at ingest:

| Column                  | Purpose                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `MSC_CODE`              | Display-only; shown before Season + backs the MSC Code filter    |
| `RESPONSIBLE_DEVELOPER` | Display-only; shown before Season + backs the Developer filter   |
| `SEASON_YEAR`           | Maps to ACS `Season`                                             |
| `STYLE`                 | Maps to ACS `StyleNumber`                                        |
| `COLOR`                 | Maps to ACS `ColorwayCode` (empty → `ALL_SOLID`)                 |
| `FTYCODE`               | Maps to ACS `FactoryCode`                                        |
| `SIZE_DATA`             | Normalised to `ALL_REG_SIZE_RB` / `ALL_EXTEND_SIZE_RB` / literal |
| `LOCAL_QUOTE_AMOUNT`    | The value being validated                                        |
| `LOCAL_CURRENCY`        | Which currency that amount is in — `USD` or `THB`. Drives `preferUSDRows` and the **Not Compared** verdict |
| `INSERT_DATE`           | Newest-wins tie-break inside `dedupePPSRows`. Hidden from the PPS preview |
| `ORIG_SIZE_DATA`        | (Added) preserves the raw `SIZE_DATA` for display                |

The kept-column list is `STRICT_B_COLS` in `src/lib/constants.ts`. `MSC_CODE` / `RESPONSIBLE_DEVELOPER` come straight from the PPS file (they are not part of ACS/Costsheet). Rows where every one of these columns is empty are filtered out.

### 3.3 File C — Costsheet Database (`dbo.VIEW_COSTSHEET_WISDOM`)

Optional. When loaded, upgrades validation from 2-way to 3-way. Fetched via `/get_costsheet_data`, with the same backend treatment as ACS (colorway expansion; `EXTRACTED_SIZE` appended only if `CBDID` exists in the view).

**Backend pre-dedupe (added 2026-07-10):** the endpoint no longer returns every Costsheet row. A `ROW_NUMBER()` window keeps only the record with the **MAX `First Input date`** per `(Season, Style No., Color, Factory, Size)` group (ties broken by highest `CBD Version`). This roughly halves the payload (~42k → ~22k rows) without changing results — the frontend's own MAX-date pick in `lookupCostsheet()` still runs as a safety net and selects the same winners. Because the date column is varchar `YYYY/MM/DD`, the SQL orders by `TRY_CONVERT(datetime, …)` rather than raw string.

Columns the frontend expects (matched **tolerantly** — see [§6.1](#61-join-key-construction--normalisation)):

| Logical role | Preferred header   | Also accepted (aliases)                       |
| ------------ | ------------------ | --------------------------------------------- |
| Season       | `Season`           | `SeasonYear`, `SeasonCode`                    |
| Style        | `Style No.`        | `StyleNo`, `StyleNumber`, `Style`, `Style#`   |
| Color        | `Color`            | `Colour`, `Colorway`, `ColorwayCode`          |
| Factory      | `Factory`          | `FactoryCode`, `Fty`, `FtyCode`               |
| Size         | `Size`             | `SizeData`, `SizeCode`                        |
| **FOB**      | **`Final FOB`**    | `FinalFOB`, `FinalFobPrice`, `FinalFobAmount` |
| **Ext FOB**  | **`Extended Size FOB`** | `ExtendedSizeFOB`, `ExtSizeFOB`, `ExtendSizeFOB` |
| Date         | `First Input Date` | `FirstInputDate`, `InputDate`, `FirstInput`   |

Header matching drops whitespace / underscores / dots / hyphens and lowercases before comparing — so `Final FOB`, `FinalFOB`, `Final_FOB`, and `FINAL-FOB` all resolve to the same logical column.

**Two FOB columns, not one (since 2026-08-05).** Which one is read depends on the
Costsheet row's own size — see [§6.5](#65-costsheet-matching-max-first-input-date).
Normalisation does **not** strip parentheses or percent signs, which is what keeps the
view's other FOB-ish columns from colliding with these two:

| View column | Normalises to | Used? |
| ----------- | ------------- | ----- |
| `Final FOB` | `finalfob` | ✅ regular-size rows |
| `Extended Size FOB` | `extendedsizefob` | ✅ extended-size rows |
| `FinalFOBCur(L4L)` | `finalfobcur(l4l)` | ❌ |
| `Extended Size FOB(L4L)` | `extendedsizefob(l4l)` | ❌ |
| `Extended Size Adj%` | `extendedsizeadj%` | ❌ |

---

## 4. Backend (`sql_backend.py`)

**TL;DR:** Flask on port 5001. Data endpoints return `{ name, headers, rows }` (cells stringified, colorways expanded); **data + annotation reads require login** (`@login_required`), **saving annotations requires edit permission** (`@require_edit`), and the **group-management + admin-log-page routes require manage permission** (`@require_manage`). Auth + session config load from `DashBoard/.env` (see the **Authentication** section); the SQL server/db/tables are hard-coded at the top of the file.

### 4.0 Backend files (infrastructure)

The backend is a handful of small, single-purpose Python modules in `DashBoard/`, all reading their
config from `DashBoard/.env`. **SQLite** (`annotations.db`) is the only thing the app writes to; **SQL
Server** is read-only source data.

```
DashBoard/                       ← Flask backend · dev: python sql_backend.py · prod: python serve.py
├── sql_backend.py          Flask app (:5001) · all routes · guards · session/CORS · SQL Server conn
├── serve.py                production entry point — runs `app` under waitress (use this on a server)
├── auth_ad.py              credential check: local → AD (LDAP/StartTLS) → AD_ALLOWED_GROUPS policy
├── annotations_db.py       SQLite: Error From / Done values; save() also returns the change diffs
├── groups_db.py            SQLite: app groups & permissions; resolve_perms() at login
├── logs_db.py              SQLite: admin Log page — presence / login_events / change_log
├── annotations.db          the ONE SQLite file the *_db.py modules share (WAL) · backup = copy it
├── requirements.txt        runtime deps: Flask, flask-cors, pyodbc, ldap3, python-dotenv, waitress
├── requirements-dev.txt    test-only dep: pytest
├── .env                    config + secrets (AD, local acct, FLASK_SECRET_KEY, INITIAL_ADMINS, CORS)
└── tests/                  pytest suite · run: python -m pytest tests/ -v
    ├── conftest.py                fixtures + an isolated temp DB
    ├── test_annotations_db.py     annotation save + change-diff tests
    ├── test_groups_db.py          groups CRUD + resolve_perms tests
    ├── test_logs_db.py            presence / logins / changes storage tests
    └── test_permissions_routes.py route guards · /ping · /admin/* · change-logging
```

**What each file does, in more detail:**

- **`sql_backend.py`** — The Flask application and the only process you run (in dev, `python sql_backend.py`, port 5001; on a server, `python serve.py` — see below). It defines **every HTTP route**: auth (`/login`, `/logout`, `/me`), the SQL Server data endpoints (`/get_file_a_data`, `/get_pps_factories`, `/get_pps_data`, `/get_costsheet_data`), the annotation read/save (`/annotations`), the group-management routes (`/groups*`), and the admin Log routes (`/ping`, `/admin/presence|logins|changes`). Data endpoints stringify every cell (SQL `NULL` → `""`), expand underscored `ColorwayCode` into one row each, and return `{ name, headers, rows }`. It also holds the **session/cookie config** (signed with `FLASK_SECRET_KEY`, HttpOnly, `SameSite=Lax`, 1-day lifetime, `Secure` only when `COOKIE_SECURE=true`), CORS-with-credentials, the **three access guards** (`@login_required` → 401 · `@require_edit` / `@require_manage` → 403), and the **SQL Server connection helper** (Windows `Trusted_Connection`, auto-picks the newest installed ODBC driver; `SERVER` / `DATABASE` / `TABLE_*` are constants at the top of the file). It imports and wires together all the modules below — e.g. the login route calls `auth_ad` to check the password, `groups_db.resolve_perms` to compute the user's rights, and `logs_db.record_login` to log it.

- **`serve.py`** — The **production entry point** (added 2026-07-31). Three lines of real work: import `app` from `sql_backend`, hand it to **waitress**, listen. Use it instead of `python sql_backend.py` on any shared or always-on host — Flask's built-in server is single-threaded and prints its own "development server" warning for good reason. Because it _imports_ `sql_backend`, everything that module does at import time still happens first (`load_dotenv()`, the three `init_db()` calls), so config and the SQLite tables are ready before the first request; and because the `serve()` call sits behind `if __name__ == '__main__'`, importing the module doesn't start a listener. Host/port/threads come from **`SERVE_HOST` · `SERVE_PORT` · `SERVE_THREADS`** (defaults `0.0.0.0` · `5001` · `8`) so the same file works in every environment with no edits — set `SERVE_HOST=127.0.0.1` once a reverse proxy fronts the app and Flask stops facing the LAN. This is also what NSSM should point at (§10.3), rather than at the `waitress-serve` console script, which depends on the service account's `PATH`.

- **`auth_ad.py`** — The **credential check only** — no Flask, no database. `authenticate(username, password)` first tries the local dev account (if `LOCAL_AUTH_ENABLED`), then binds to Active Directory over LDAP/StartTLS, where AD itself verifies the password (bind as `user@domain` in `SIMPLE` mode or `DOMAIN\user` in `NTLM` mode). On success it locates the account with `AD_USER_FILTER`, reads the person's profile (name, email) and their `memberOf` groups, and applies the `AD_ALLOWED_GROUPS` policy that decides **who may log in at all** (a bare CN or a full DN both match; empty = everyone). It returns a plain dict `{username, display_name, email, groups, source}` (`source` = `ad` or `local`) and never touches sessions or app permissions (those belong to `sql_backend` + `groups_db`). Ported from the team's Django auth backend; `ldap3` is imported lazily so the module loads even where the AD stack isn't installed.

- **`annotations_db.py`** — SQLite storage for the two user-filled columns, **Error From** and **Done** — the `annotations(scope, row_key, error_from, done, saved_by, saved_at)` table, PK `(scope, row_key)`. `scope` is always `"shared"` today (one set everyone sees; it exists so per-group sets could be added later with no migration), and `row_key` is the row's stable business identity (`FTYCODE|Season|Style|Color|ORIG_SIZE|LOCAL_QUOTE_AMOUNT`). `get_all()` reads them; `save()` upserts changed values, **deletes** cleared (blank) rows, stamps `saved_by`/`saved_at` only on a real change (last-write-wins — the value itself keeps no history), and — since the Log feature — also **returns the list of field-level changes** (`Error From` / `Done`, old → new, clears included) that `sql_backend` writes to the audit log. Runs in WAL mode with a 5-second busy-timeout so simultaneous saves just queue. This is what makes one person's save visible to everyone else.

- **`groups_db.py`** — SQLite storage for the app's **own groups & permissions** (the `groups(name, can_edit, can_manage, …)` and `group_members(group_name, username, …)` tables). Admins create groups here and drop AD usernames into them (stored **casefolded**, so matching is case-insensitive); each group carries `can_edit` / `can_manage`. It exposes the full CRUD (`create_group`, `list_groups`, `set_group_perms`, `delete_group`, `add_member`, `remove_member`), but the key function is `resolve_perms(username)`, called at login to compute effective rights — **most-permissive** across all the user's groups, `INITIAL_ADMINS` (from `.env`) always full admin, **no group = read-only**. Because perms are read at login, a group change takes effect on the user's **next** login. These are the _app's_ groups, deliberately separate from AD security groups.

- **`logs_db.py`** — SQLite storage for the **admin Log page**, three tables: `presence` (one row per user, **upserted** by the heartbeat — `active_users()` returns everyone seen in the last 120s), `login_events` (appended on each login — `logins_for_week()` reads one week), and `change_log` (appended by the save route — `changes_for_week()` reads one week). Timestamps are stored in **UTC**; a "week" is the **local Sunday–Saturday** week (so it rolls over at Sunday midnight). It only records and reads these tables — the routes that expose them live in `sql_backend`, and nothing edits or deletes the rows (append-only, read-only from the outside). No auto-pruning.

- **`annotations.db`** — The **single SQLite file** all three `*_db.py` modules share (each calls its own `init_db()` at startup to create its tables; WAL mode so readers and the one writer don't block each other). It holds everything the app persists locally — annotations, groups, and logs. It is **not** the source data (that's SQL Server), so a backup is simply copying this one file. The path is overridable via the `VALIDATOR_DB_PATH` env var (used by the tests to point at a throwaway temp DB). Gitignored, along with its `-wal` / `-shm` sidecar files.

- **`requirements.txt` / `requirements-dev.txt`** — The Python dependencies, version-pinned. **Runtime:** Flask + flask-cors (web server + cross-origin cookies), pyodbc (SQL Server), ldap3 (Active Directory), python-dotenv (reads `.env`), **waitress** (the production WSGI server `serve.py` runs on) — `pip install -r requirements.txt`. **Dev-only:** pytest, for the test suite — `pip install -r requirements-dev.txt`. Note `waitress` belongs in the **runtime** file, not the dev one: on a server it is the thing actually serving traffic, and if it's only in `requirements-dev.txt` then a server that installed just `requirements.txt` fails at startup with `ModuleNotFoundError: waitress` (or `waitress-serve : term not recognized`).

- **`.env`** — All configuration and secrets in one gitignored file, loaded once at startup (`load_dotenv()`): AD settings (`AD_ENABLED`, server/domain/base-DN, `AD_START_TLS`, `AD_AUTH_MODE`, `AD_USER_FILTER`, `AD_ALLOWED_GROUPS`), the local dev account, `FLASK_SECRET_KEY` (signs the session cookie — must be a **strong** secret), `INITIAL_ADMINS`, `SESSION_LIFETIME_DAYS`, `COOKIE_SECURE`, and `CORS_ALLOWED_ORIGINS`. **Never commit it.** (The Authentication section's config table lists every key.)

- **`tests/`** — The pytest suite (`python -m pytest tests/ -v`, **37 tests**). `conftest.py` supplies fixtures that point every test at an **isolated temporary database** (via `VALIDATOR_DB_PATH` + monkeypatch, so real data is never touched), plus a Flask **test client** and a `login_as()` helper that injects a session to bypass AD. The four `test_*.py` files cover, respectively: the annotation save + change-diff logic, the groups CRUD + `resolve_perms` rules, the log storage, and the HTTP routes' access guards (401 vs 403 vs 200) end-to-end.

**How a request flows:** the browser calls `sql_backend.py` → a guard checks the session → the view
reads/writes either SQL Server (data endpoints) or one of the SQLite tables (annotations / groups /
logs) → JSON comes back. `auth_ad.py` is only touched at `/login`.

### 4.1 Endpoints

| Method | Path                                | Login  | Returns                                                                           |
| ------ | ----------------------------------- | ------ | --------------------------------------------------------------------------------- |
| GET    | `/`                                 | —      | Plain HTML health check                                                           |
| POST   | `/login`                            | —      | Verify creds (local → AD); set session; `{ user }`                                |
| POST   | `/logout`                           | —      | Clear the session                                                                 |
| GET    | `/me`                               | —      | `{ user }` if signed in, else 401                                                 |
| GET    | `/get_file_a_data`                  | ✓      | `{ name, headers, rows }` from `dbo.ACS`                                          |
| GET    | `/get_pps_factories`                | ✓      | `{ factories }` — distinct `FTYCODE`                                              |
| GET    | `/get_pps_data`                     | ✓      | `{ name, headers, rows }` for one factory                                         |
| GET    | `/get_costsheet_data`               | ✓      | `{ name, headers, rows }` from Costsheet view                                     |
| GET    | `/annotations`                      | ✓      | `{ annotations }` — saved Error From / Done                                       |
| POST   | `/annotations`                      | edit   | Save annotations; fresh `{ annotations }` (403 if not an editor)                  |
| GET    | `/groups`                           | manage | `{ groups }` — all groups + members + perm flags                                  |
| POST   | `/groups`                           | manage | Create a group `{name, can_edit, can_manage}` (400 blank · 409 dup)               |
| PATCH  | `/groups/<name>`                    | manage | Set a group's `can_edit` / `can_manage`                                           |
| DELETE | `/groups/<name>`                    | manage | Delete a group (and its members)                                                  |
| POST   | `/groups/<name>/members`            | manage | Add a member `{username}` (404 if group missing)                                  |
| DELETE | `/groups/<name>/members/<username>` | manage | Remove a member                                                                   |
| POST   | `/ping`                             | ✓      | Heartbeat — mark me active (any logged-in user)                                   |
| GET    | `/admin/presence`                   | manage | `{ active }` — users seen in the last 2 min                                       |
| GET    | `/admin/logins?date=`               | manage | `{ logins }` — logins for the week containing ?date (default: this week)          |
| GET    | `/admin/changes?date=`              | manage | `{ changes }` — change history for the week containing ?date (default: this week) |

Data endpoints convert every cell to `str` (SQL `NULL` → `""`), expand `ColorwayCode` on underscore, and return HTTP 500 `{ error }` on any exception. **Login column:** ✓ = `@login_required` (401 without a valid session cookie); **edit** = `@require_edit` (403 unless `can_edit`); **manage** = `@require_manage` (403 unless `can_manage`). Every `/groups*` route returns the fresh full `{ groups }` list. The `/ping` heartbeat and `/admin/*` reads power the admin **Log page** (see the Authentication section's "Admin Log page"). See the **Authentication** section (incl. "Per-group roles") for `/login` · `/logout` · `/me` and the permission model, and §4.5 for the annotations store.

### 4.2 `EXTRACTED_SIZE` derivation

Function: `extract_size_from_cbdid(cbdid)` — takes the **last two** dash-separated segments, joins with `-`, then replaces `-` → `_`, so the CBDID's tail becomes the size token.

```python
def extract_size_from_cbdid(cbdid: str) -> str:
    parts = cbdid.split('-')
    if len(parts) >= 2:
        return '-'.join(parts[-2:]).replace('-', '_')
    return ''
```

- `SU27-HTV-HV8232-S-ALL_SOLID-ALL_REG_SIZE-RB` → `ALL_REG_SIZE_RB`
- `FA26-M-1234-BLK-2XL-EXT-RB` → `EXT_RB` (probably wrong; edge case for future validation)

If CBDID has fewer than 2 dash segments it returns `''` silently, and the frontend then treats that row as unmatched.

### 4.3 ColorwayCode row expansion

Function: `expand_colorway_rows(base_row, colorway_idx)` — if `ColorwayCode` holds several codes joined by underscores (e.g. `011_066`, `006_010_065_323_410`), it splits into one row per code. This matches how PPS files store colours one-per-row and lets the join key be an exact single-value comparison instead of substring matching.

**Codes starting `ALL_` are NOT split (fixed 2026-08-06).** `ALL_SOLID`, `ALL_AOP`, `ALL_HTR`, `ALL_011`, `ALL_010`, `ALL_531` are each **one** logical colourway that merely contains an underscore. Splitting them was a real bug:

- `ALL_SOLID` became two rows, `ALL` and `SOLID`, so the join key `all_solid` **never existed** in the ACS index.
- A PPS row with a blank `COLOR` — which `normalizeJoinKey` folds to `all_solid` — therefore missed its exact match, fell through to the no-colour fallback, and could take a **specific colour's FOB**. Style **STYLE-B showed 6.00 (colourway 084) instead of 5.00 (ALL_SOLID)**.
- Worse, `SELECT *` has no `ORDER BY`, so *which* colour it grabbed was not even deterministic between loads.

It also un-broke `normalizeJoinKey` in the frontend, which already folds `all_htr` and `all_aop` into `all_solid` — folding that could never fire while those values were being split apart here first.

| ColorwayCode | Rows in `dbo.ACS` | Behaviour |
| ------------ | ----------------- | --------- |
| `ALL_SOLID` | ~1.4k | one row |
| `ALL_AOP` | 152 | one row |
| `ALL_HTR` | 14 | one row |
| `ALL_011` · `ALL_010` · `ALL_531` | 1 each | one row |
| `ALLSOLID` | 2 | one row (no underscore — never split) |
| `011_066`, `006_010_065_323_410`, `PHT_PHV_PC2_PC1_PC3`, … | ~104 | **split**, one row per code |

Impact when this shipped: the ACS payload dropped from **~3.8k to ~2.3k rows** (exactly the ~1.5k `ALL_*` rows no longer split), and **2 rows moved Diff → Match**. 55 (season, style, factory) groups hold both `ALL_SOLID` and a specific colour — those were the ones at risk of a wrong FOB.

Known gap: **`ALLSOLID`** (no underscore, 2 rows) still won't match a blank-`COLOR` PPS row, because `normalizeJoinKey` folds `''`, `all_htr`, `all_aop`, `retail` and `solid1` into `all_solid` — but not `allsolid`.

**Order matters:** expansion runs **after** `EXTRACTED_SIZE` is appended, so every expanded row inherits the same size.

### 4.4 Configuration

Hard-coded at the top of `sql_backend.py`:

```python
SERVER   = '<SQL_HOST>\\<SQL_HOST>'
DATABASE = '<DATABASE>'
TABLE_A  = 'dbo.ACS'
TABLE_C  = 'dbo.VIEW_COSTSHEET_WISDOM'
```

Auth is Windows integrated (`Trusted_Connection=yes`), so the user running Flask must have SELECT on both tables. The ODBC driver is auto-picked from the highest-version SQL Server driver installed (`pyodbc.drivers()` filtered on `'SQL Server'`). To point at a different server/database, change these constants and restart Flask.

### 4.5 Row annotations store (`annotations.db`)

The user-filled **Error From** / **Done** columns are NOT from any source DB — they're saved to a small **SQLite** file, `DashBoard/annotations.db`, managed by `annotations_db.py` (created on startup by `init_db()`, gitignored). This is what makes a save by one user visible to the next.

- **Table:** `annotations(scope, row_key, error_from, done, saved_by, saved_at)`, PK `(scope, row_key)`.
- **Also in this file:** the app-managed permission tables `groups` / `group_members` (via `groups_db.py`, 2026-07-20) and the admin Log page tables `presence` / `login_events` / `change_log` (via `logs_db.py`, 2026-07-21) — same SQLite file, same WAL setup. See the Authentication section's "Per-group roles" and "Admin Log page".

**The two key columns, in plain terms:**

- **`scope`** = _which version_ the value belongs to which group. Always `"shared"` today (one version everyone sees). It exists so per-group versions can be added later — write a group name instead of `"shared"`, with no schema change.
- **`row_key`** = _which validation row_ the value is attached to — a stable ID built from the row's data (see §6.8): `FTYCODE|Season|Style|Color|ORIG_SIZE|LOCAL_QUOTE_AMOUNT` (e.g. `hit|ho26|fv8505|all_solid|3xl|2.8`). Used instead of the `#` row number because `#` is reassigned on every Validate — the data-based key stays the same, so a saved value re-attaches to the right row for everyone, every time.
- **Together, `(scope, row_key)`** is the primary key: one saved value per version, per row — so a Save overwrites in place instead of piling up duplicates.

- **Save semantics:** a blank row (no Error From, not Done) is **deleted**; a changed value stamps `saved_by`/`saved_at` (current user / now, UTC); an unchanged value keeps its original attribution (so "who changed it" stays accurate even when someone else clicks Save). **Last write wins** — no version history is kept.
- **Backup** = copy the one `.db` file.
- **Concurrency:** the DB opens in **WAL mode** (readers and the single writer don't block each other) with a **5-second busy-timeout** (a save that hits a brief lock waits a few ms and proceeds — no error, no corruption; SQLite is ACID). This comfortably handles dozens of simultaneous users: each Save is a few tiny upserts committing in milliseconds, and SQLite serialises writes, so "same time, different records" just queues instantly. You'd only outgrow this at hundreds of concurrent heavy writers or multiple app servers — then move annotations into SQL Server. WAL adds `-wal` / `-shm` sidecar files next to the `.db` (also gitignored).

---

## 5. Frontend Architecture

**TL;DR:** Vite + React 18 + TypeScript (strict), no CSS framework, no state library. All state lives in `App.tsx`; the comparison logic is pure and runs synchronously on Validate. Domain logic lives in `src/lib/` with zero React.

### 5.1 Tech Stack

- **Vite 5** — dev server + bundler
- **React 18** — UI
- **TypeScript 5** — strict mode
- **xlsx (SheetJS) 0.18** — PPS file parsing in the browser
- **No CSS framework** — plain CSS with variables in `src/styles/tokens.css`

No Redux, no React Query, no fetching library. State lives in `App.tsx`'s `useState` calls; the comparison logic is pure and runs synchronously on Validate click.

### 5.2 File infrastructure for Frontend

```
DashBoard/frontend/
├── package.json · vite.config.ts · tsconfig*.json · index.html · .env
├── README.md              ← frontend-only quick reference
└── src/
    ├── main.tsx           ← ReactDOM.createRoot mount
    ├── App.tsx            ← root component + state ownership
    ├── vite-env.d.ts      ← ambient env-var types
    ├── lib/               ← PURE domain logic (no React)
    │   ├── api.ts             fetchACS, fetchCostsheet, auth + group-admin calls
    │   ├── constants.ts       KEY_PAIRS, sizes, colors, C_KEY_ALIASES
    │   ├── normalize.ts       size / join-key / date / header normalisation
    │   ├── costsheet.ts       buildCostsheetIndex + lookupCostsheet (MAX date)
    │   ├── comparison.ts      runComparison — the entry point
    │   ├── csv.ts             exportComparisonCSV (Verdict + Diff_Reason)
    │   ├── summary.ts         Match / Diff / No Key aggregation for the Summary view
    │   └── types.ts           shared TypeScript types
    ├── components/
    │   ├── Header.tsx
    │   ├── UploadStrip.tsx        composes 3 file slots
    │   ├── FileSlotACS.tsx        loads dbo.ACS
    │   ├── FileSlotPPS.tsx        drag+drop, xlsx parsing, dedupe
    │   ├── FileSlotCostsheet.tsx  loads Costsheet view
    │   ├── PreviewTable.tsx       shared mini table
    │   ├── KeyInfoPanel.tsx       shows keys + FOB logic + Validate button
    │   ├── ResultsToolbar.tsx     stats + search + filter buttons + export + Save (disabled for read-only)
    │   ├── ResultsTable.tsx       the big results grid (sticky-right verdict)
    │   ├── GroupAdmin.tsx         admin screen: create groups, add members, set edit/manage (manager-only)
    │   ├── LogDashboard.tsx       admin Log page: online-now / logins / change history (manager-only)
    │   └── SummaryDashboard.tsx   Validation Summary: Match/Diff/No Key by factory & season (all users)
    ├── hooks/
    │   ├── useAuth.tsx            auth context (login/logout, /me on load)
    │   ├── useToast.tsx           toast context + provider
    │   └── usePresenceHeartbeat.tsx  pings /ping every 30s while logged in (feeds "online now")
    └── styles/
        ├── tokens.css             CSS variables (palette, type, spacing)
        └── global.css             component classes
```

### 5.3 State Model

All top-level state lives in `App.tsx`:

| State             | Type                              | Reset by    | Notes                                                   |
| ----------------- | --------------------------------- | ----------- | ------------------------------------------------------- |
| `dataA`           | `TableData \| null`               | FileSlotACS | ACS DB rows                                             |
| `dataC`           | `TableData \| null`               | FileSlot CS | Costsheet DB rows (optional)                            |
| `dataBFiles`      | `PPSFile[]`                       | FileSlotPPS | Up to 4 PPS files                                       |
| `compRows`        | `CompRow[]`                       | Validate    | Comparison output rows                                  |
| `hadResultC`      | `boolean`                         | Validate    | Snapshot: was Costsheet loaded when Validate ran?       |
| `filterMode`      | `'all'\|'match'\|'diff'\|'nokey'` | Toolbar     | Rightmost filter buttons                                |
| `search`          | `string`                          | Toolbar     | Freeform search text                                    |
| `seasonFilter`    | `string`                          | Toolbar     | `''` = all                                              |
| `factoryFilter`   | `string`                          | Toolbar     | `''` = all                                              |
| `developerFilter` | `string`                          | Toolbar     | `''` = all (substring match on `RESPONSIBLE_DEVELOPER`) |
| `mscCodeFilter`   | `string`                          | Toolbar     | `''` = all (substring match on `MSC_CODE`)              |

`hadResultC` is a deliberate snapshot: if the user clears Costsheet _after_ validating, the results table keeps its 3-column WISDOM section instead of reshuffling.

---

## 6. Domain Logic — Deep Dive

**TL;DR:** This is the section you'll read most. Everything lives in `src/lib/` as pure, unit-testable functions. Flow: normalise keys → build ACS/Costsheet indexes → for each PPS row, pick the best ACS row (5-tier size fallback), pick the newest matching Costsheet row (MAX date within size), compare FOBs, emit a verdict.

### 6.1 Join Key Construction & Normalisation

Function: `normalizeJoinKey(value, dbColName)` in `normalize.ts`. Applied to every join-key segment:

1. Coerce to string, treat null/undefined as `""`.
2. Strip all whitespace.
3. Lowercase.
4. If it's a color column (`ColorwayCode` / `COLOR` / `color` / `Color`) **and** the value is in `{empty, all_htr, all_aop, retail, solid1}`, collapse it to `all_solid`.

The composite join key is the 4 or 5 segments joined by `|`:

```
sp27|fz9758|all_solid|hsn                    ← 4-part (JOIN_KEY_PAIRS)
sp27|xl|fz9758|all_solid|hsn                 ← 5-part (KEY_PAIRS, includes size — display only)
```

**Two key flavours** are built during index construction:

- Full 4-part with color.
- 3-part **no-color** fallback (season + style + factory).

The no-color fallback is used _only_ when a PPS row's color normalises to `all_solid` **and** the full key returned no candidates — covering rows that ACS/Costsheet store without a specific color for a solid variant.

### 6.2 Size Normalisation

Sizes land in three buckets:

| Bucket               | What lands here                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `ALL_REG_SIZE_RB`    | Any size in `REG_SIZES` (S/M/L/XL/2XL/40/etc.) or the literal `ALL_REG_SIZE`                  |
| `ALL_EXTEND_SIZE_RB` | Any size in `EXTEND_SIZE` (2XL-T, 4XL, L-TT, 48/58/60, etc.) or the literal `ALL_EXTEND_SIZE` |
| literal value        | Anything not in either list (e.g. numeric shoe sizes, custom codes)                           |

**Pipeline** — `normalizeSizeToken(raw)`:

1. Trim `raw`.
2. `convertBSize`: if `raw` ∈ `REG_SIZES` → `ALL_REG_SIZE_RB`, else pass through.
3. If still not `ALL_REG_SIZE_RB`, `convertBExtendSize`: if `raw` ∈ `EXTEND_SIZE` → `ALL_EXTEND_SIZE_RB`, else pass through.
4. If empty at the end, default to `ALL_REG_SIZE_RB` (so a blank PPS `SIZE_DATA` still lands in a real bucket).

**Costsheet-specific pre-processing** (in `buildCostsheetIndex`): if the raw Size cell is literally `ALL_REG_SIZE` or `ALL_EXTEND_SIZE` (no `_RB` suffix), the frontend prepends `_RB` to align with PPS's convention.

**Where to edit the buckets:** `src/lib/constants.ts` → `REG_SIZES` and `EXTEND_SIZE`.

### 6.3 ACS Row Selection (5-tier size fallback)

Function: `matchDbRowForSize(candidates, bRawSize, bConvertedSize, sizeAIdx)` in `comparison.ts`. Given ACS candidates (rows sharing the same season+style+color+factory), pick the one whose `EXTRACTED_SIZE` best matches the PPS size, trying progressively looser tiers:

1. **Exact match** — `EXTRACTED_SIZE == bConvertedSize`.
2. **Token overlap** — split ACS `EXTRACTED_SIZE` on `_-` and match against `rawL` or `convL`.
3. **Substring** — ACS `EXTRACTED_SIZE` contains the raw or converted PPS size.
4. **Non-`reg_size` fallback** — if PPS is _not_ `all_reg_size_rb`, pick any candidate whose ACS size doesn't include `reg_size`.
5. **Last resort** — the first candidate in the list.

**Why 5 tiers:** real-world data is messy. Tiers loosen gradually, so a match is almost always found while preference always favours the strictest tier.

### 6.4 FOB Source Selection (FinalFOB vs ExtSzFOB)

Once the ACS row is picked (§6.3), decide which of its two FOB columns to use:

```
if bConvertedSize (PPS) == dbCbdidSize (ACS):
    fobSource = 'FinalFOB'   ← size matched exactly, use the primary FOB
else:
    fobSource = 'ExtSzFOB'   ← size fell back, use the "extended size" FOB
```

The `FOB Source` column in the results renders one of `Final FOB` / `ExtSzFOB` / `N/A` as a coloured pill.

### 6.5 Costsheet Matching (MAX First Input Date)

**Which FOB column the Costsheet side reads (since 2026-08-05).** ACS carries two FOB
columns on one row and picks between them by size (§6.4). The Costsheet view is shaped
the other way — one row per size — so the source is chosen by **the Costsheet row's own
size**, resolved once in `buildCostsheetIndex`:

```ts
const isExt  = normalizeCostsheetSizeToken(szRaw) === 'ALL_EXTEND_SIZE_RB';
const srcIdx = isExt ? extFobIdx : fobIdx;   // Extended Size FOB vs Final FOB
```

| Costsheet row size | FOB column read |
| ------------------ | --------------- |
| `S`, `M`, `40`, `46R`, … | `Final FOB` |
| the 31 `EXTEND_SIZE` values (`3XL`, `XL-T`, `CUST1`, `58`, …) | **`Extended Size FOB`** |

**Two subtleties worth knowing before you touch this:**

- **`normalizeCostsheetSizeToken` (`normalize.ts`) is NOT the same as `normalizeSizeToken`.**
  It checks `EXTEND_SIZE` *before* `REG_SIZES`. `4X` and `48` are the only two values in
  **both** lists, so they price from `Extended Size FOB` even though the shared resolver
  calls them regular. Everything else resolves identically in both.
- **It decides the FOB column ONLY — never the matching key.** `szNorm` still comes from
  the shared `normalizeSizeToken`, because `FileSlotPPS.tsx` normalises every uploaded PPS
  row's `SIZE_DATA` with that same function. If the two ever disagree, a PPS `4X` row stops
  matching the Costsheet `4X` row and silently takes another size's price. This was a real
  bug caught in review — keep the two concerns separate.

**Empty `Extended Size FOB`.** An extended row whose ext-FOB cell is blank has no usable
price: `lookupCostsheet` returns `matched: false`, the row renders `—` and counts as
**No CS** rather than falling back to `Final FOB` or to an older row. This is deliberate —
it surfaces the data gap instead of hiding it. Regular rows with a blank `Final FOB` are
**unchanged** (still `matched: true` with a blank value, reading as a Diff); the asymmetry
is intentional so nothing that worked before could change verdict.

---

Function: `lookupCostsheet(cIdx, bConvertedSize, joinKeyStr, keyNoColor)` in `costsheet.ts`. For each PPS row:

1. **Fetch candidates** by full key from `cIdx.rawIndex`; if empty, try `cIdx.rawIndexNoColor[keyNoColor]`.
2. **Filter by size** — progressive tiers: exact `szNorm == convL` → token overlap on `szNorm` split by `_-` → substring → (if still empty) use _all_ candidates.
3. **Pick MAX `First Input Date`** across the size-filtered set:
   ```ts
   const best = sized.reduce((prev, cur) => {
     if (!prev) return cur;
     if (!cur.dateVal) return prev; // records without a valid date are skipped
     if (!prev.dateVal) return cur;
     return cur.dateVal > prev.dateVal ? cur : prev;
   }, null);
   ```

**Critical nuance:** MAX date is computed **within the size-matched subset**, not across all candidates. So a size-S PPS row returns the newest **S** record even if a newer XL record exists. This is deliberate (see also [§6.6](#66-3-way-verdict-logic) and [§8.5](#85-max-date-is-within-size-matched-subset)).

**Since 2026-07-10** the backend already pre-dedupes to the newest record per `(Season, Style No., Color, Factory, Size)` (see [§3.3](#33-file-c--costsheet-database-dboview_costsheet_wisdom)), so this reduce usually sees one candidate per size and acts as a safety net. Max-over-group-winners equals max-over-all-rows, so results are identical.

**Date formatting** uses **local** date parts (`getFullYear` / `getMonth` / `getDate`), **not** `toISOString()` — see [§8.1](#81-timezone-bug-on-max-input-date-fixed-2026-06-30).

### 6.6 3-Way Verdict Logic

The rightmost `ACS Match?` column shows one of **four** states per row:

| State             | Condition                                                      |
| ----------------- | -------------------------------------------------------------- |
| **No Key Match**  | ACS had no row matching the PPS key (even with color fallback) |
| **Not Compared**  | Quoted in a currency other than `PREFERRED_CURRENCY` — the comparison is **skipped**, not failed |
| **Match**         | See condition below                                            |
| **Diff**          | None of the above                                              |

**Derive the verdict with `verdictOf(row)` — never re-implement it.** It is exported from `comparison.ts` and is the single source of truth; `summary.ts`, `csv.ts` and `App.tsx` all import it. Before it existed the same expression was copied in four places, which is why a fourth state could not be added consistently.

```ts
export type Verdict = 'match' | 'diff' | 'noKey' | 'notCompared';

export function verdictOf(r: CompRow): Verdict {
  if (r.status === 'noKeyMatch') return 'noKey';   // checked FIRST — see below
  if (!r.comparable) return 'notCompared';
  return r.valueMatch ? 'match' : 'diff';
}
```

`noKey` is checked **first** on purpose: a row with no ACS match is a key problem regardless of what currency it was quoted in. A consequence worth knowing — with today's data **`notCompared` never actually fires**. A THB row only survives `preferUSDRows` when its group has no USD twin (5 groups, all HIT), and every one of those has no matching ACS row, so they all resolve to `noKey`. The state is correct but dormant; it activates the moment a THB-only group gains a matching ACS row.

**Watch for the skipped-vs-failed trap.** A *skipped* comparison is indistinguishable from a *failed* one wherever code branches on a falsy value. `notCompared` needed explicit neutral handling in **four** separate places — the verdict badge, the ACS cell tint (`dbCls`), the WISDOM FOB cell, and the Summary donut — and every one was found only by reading the code, never by a passing build. If you add a fifth verdict, audit every expression derived from `valueMatch`, `cMatch`, `lqVsAcs` or `!isMatch`.

`App.tsx` maps verdicts to filter categories through an explicit `Record<Verdict, FilterCategory>`, **not** a cast: `verdictOf` returns camelCase (`noKey`, `notCompared`) while `FilterCategory` is lowercase (`nokey`, `notcompared`), so a cast compiles cleanly and then silently filters nothing for exactly those two.

The **Match** condition depends on whether Costsheet is loaded:

```ts
const acsMatch = hasCData
  ? lqVsAcs && cMatch === true // 3-way: all three must agree
  : lqVsAcs; // 2-way: PPS vs ACS only
```

- `lqVsAcs` = `parseFloat(LOCAL_QUOTE_AMOUNT) ≈ parseFloat(ACS FOB)` with epsilon `0.0001` (falls back to case-insensitive string equality if either side isn't numeric).
- `cMatch` = the same comparison against the Costsheet FOB — `Final FOB` for a regular-size Costsheet row, `Extended Size FOB` for an extended-size one (see [§6.5](#65-costsheet-matching-max-first-input-date)); stays `null` if no Costsheet row matched.

**By design:** when Costsheet is loaded but a row has _no_ Costsheet match (`cMatched = false`, `cMatch = null`), the verdict is **Diff** with reason `No WISDOM` — a 3-way check can't be _confirmed_ if a source is missing data.

**Diff reasons** (rendered under the "✗ Diff" badge, separated by `·` when multiple apply):

| Reason chip   | Trigger                                |
| ------------- | -------------------------------------- |
| `PPS!=ACS`    | `lqVsAcs === false`                    |
| `PPS!=WISDOM` | `hasC && cMatched && cMatch === false` |
| `No WISDOM`   | `hasC && !cMatched`                    |

### 6.7 CSV Export

Function: `exportComparisonCSV(rows, hasC, annotations)` in `csv.ts`.

- Exports **all** `compRows` — the on-screen filter does **not** affect the CSV.
- Columns: `Row, MSC_CODE, RESPONSIBLE_DEVELOPER, Season_B, Size_B, Style_B, Color_B, Factory_B, B_Size_Converted, DB_CBDID_Size, FOB_Source, ACS_FOB_Value, LOCAL_QUOTE_AMOUNT, [Costsheet_Final_FOB, Costsheet_Max_Input_Date,] Error_From, Done, Saved_By, Verdict, Diff_Reason`.
- `Verdict` is `MATCH` / `DIFF` / `NO_KEY_MATCH` — matches the on-screen badge exactly.
- `Diff_Reason` is populated only for `DIFF` rows, pipe-delimited (e.g. `PPS!=ACS|No_WISDOM`).
- Cells containing `"`, `,`, or newline are RFC 4180 quoted.

To find problem rows in Excel, filter **`Verdict = DIFF`** or **`Verdict = NO_KEY_MATCH`**.

### 6.8 Row

& the save key

The user-filled **Error From** / **Done** values are tied to a row by a stable **`rowKey`** built in `comparison.ts` — the same fields (and normalization) as the de-dup key, plus `FTYCODE`:

```
rowKey = FTYCODE | Season | Style | Color | ORIG_SIZE | LOCAL_QUOTE_AMOUNT   (trim + lowercase)
```

Because it's derived from the row's data (not the ephemeral `#` counter), the same value re-attaches to the same logical row every time **anyone** re-validates — that's what lets one user's save show up for the next. On **Validate** the frontend does `GET /annotations` and maps them onto the fresh rows by `rowKey`; the **Save** button `POST`s them back (storage in §4.5). One shared version, latest-write-wins.

---

## 7. UI Behaviour

**TL;DR:** Three upload slots (ACS · Costsheet · PPS) → a Key Info panel with the Validate button → a results grid with a sticky-right verdict column, a render cap for large sets, and a stack of filters + search.

### 7.1 Upload Strip

Three slots left-to-right: **ACS · Costsheet · PPS**.

- **ACS & Costsheet** — single button → backend fetch → preview.
- **PPS** — drop zone (click to browse or drag). Accepts up to `MAX_B_FILES` (4) files. Duplicate filenames are rejected with a toast. Each loaded file gets a distinct badge colour from `FILE_COLORS`.

### 7.2 Key Info Panel

Appears once both ACS and at least one PPS file are loaded. Static reference for the join keys + FOB selection logic. The **Validate** button lives here — clicking it runs `runComparison()`.

### 7.3 Results Table

Column layout when Costsheet is loaded (`hasC = true`):

```
# | MSC_CODE | RESPONSIBLE_DEVELOPER | Key Columns (Season/Size/Style/Color/Factory) |
Size Comparison (PPS SIZE / ACS CBDID SIZE / WISDOM SIZE) |
FOB Source | ACS FOB | PPS FOB | WISDOM FINAL FOB | Max Input Date |
ACS Match? (sticky right)
```

When `hasC = false`, the WISDOM SIZE / WISDOM FINAL FOB / Max Input Date columns disappear and the Size Comparison `colspan` drops from 3 to 2.

**Sticky right:** `ACS Match?` is `position: sticky; right: 0` with a soft left shadow, so the verdict stays visible no matter how wide the table gets. Hover state propagates through the sticky cell.

**Row limit (render cap):** only the first **100** rows are put in the DOM by default, so large validations (3,000+ rows) don't lag the page. A **"Show first N rows"** dropdown raises the limit to 500 / 1,000 / 3,000 / 5,000 — higher values render progressively slower. The cap affects **display only**: filters, toolbar counts, and CSV export always use the full result set. When more rows exist than the limit, a hint row at the bottom says to raise the limit or export CSV. Options live in `ROW_LIMIT_OPTIONS` in `ResultsTable.tsx`.

### 7.4 Filters & Search

Applied in this order (in `App.tsx`'s `useMemo`):

1. **Filter mode** (buttons, top-right of toolbar): `all` / `match` / `diff` / `nokey`.
2. **Season dropdown** — exact match.
3. **Factory dropdown** — exact match.
4. **MSC Code field** — a native `<datalist>` combo (type to free-filter, or click a suggestion). Case-insensitive **substring** match on PPS `MSC_CODE`; suggestions are the distinct non-empty codes in the current results, sorted.
5. **Developer field** — same combo behaviour, matching PPS `RESPONSIBLE_DEVELOPER`.
6. **Search box** — lowercase substring across: all key values, `LOCAL_QUOTE_AMOUNT`, ACS FOB, `MSC_CODE`, `RESPONSIBLE_DEVELOPER`, filename, Costsheet FOB.

The **✕ Clear Filters** button (next to Export CSV) resets everything at once — verdict categories, both dropdowns, both combo fields, and the search box. It's dimmed/disabled when no filter is active. (The "All" filter button only clears the verdict categories.)

Toolbar counts (`Match`, `Diff`, `No Key`, `Showing`) all reflect the _filtered_ rows.

### 7.5 Error From / Done columns + Save

Two user-filled columns sit just before the sticky **ACS Match?** verdict:

- **Error From** — a fixed dropdown (`-` / Developer / Wisdom / Customer); all options stay visible so it's easy to re-select.
- **Done** — a checkbox.

These are **not** from any source data (see §4.5 / §6.8), and they're **shared** — what one user saves, the next user sees.

- The **Save** button (toolbar, next to Export CSV) writes the values to the backend; a **"● Unsaved"** flag appears whenever there are unsaved edits.
- On **Validate**, saved values are loaded from the server and mapped onto the rows. ⚠️ This **overwrites unsaved local edits** — Save before re-validating.
- Hover the Error From cell to see **who last saved it** (`saved_by` · date); it's also exported as the `Saved_By` CSV column.
- **Roles are enforced:** for read-only users (no `can_edit`), the **Error From dropdown and Done checkbox are disabled** _and_ the **Save button is disabled** (both with a "Read-only — ask an admin for edit access" tooltip) — so they can't even make a local edit; `POST /annotations` also returns **403**, so it can't be bypassed via the API. Who can edit is set per app-group — see the Authentication section's "Per-group roles".
  - _History: Save gating + the 403 shipped 2026-07-20; the Error From / Done **input cells** were also disabled for read-only users on 2026-07-21 (previously they were editable-but-unsavable)._

### 7.6 Validation Summary tab

> **Added 2026-07-22.** A **Summary** view, **public to all logged-in users**, reached from the
> header switcher (`Compare Data | Summary`).

Turns the **current validation** into an at-a-glance quality picture — it summarizes the in-memory
`compRows`, so it reflects exactly the factories/seasons you loaded for that run (no backend, no SQL).
Top to bottom:

- **A donut per factory** — one Match / Diff / No Key donut for **each factory** you loaded (its
  total in the center + a legend with counts + %), shown side by side so factories are **never
  lumped together**. Pick a single factory → a single donut.
- **Factory × Season breakdown** — a table with the exact Match / Diff / No Key / Total per
  factory+season, plus a Totals row.
- **Empty state** — before you've validated it says "run a validation in Compare Data first."

The verdict / factory / season logic is the **same** the results toolbar uses, so the Summary's
totals always equal the toolbar's Match / Diff / No Key counts. It's **read-only** and **public** —
it shows nothing a user can't already see in the Compare table. Switching tabs keeps your results
(it reads `App`'s state — no re-validate). Charts are hand-rolled (no chart library), token-driven
for light/dark. Lives in `components/SummaryDashboard.tsx` + `lib/summary.ts` (pure aggregation).

---

## 8. Known Gotchas & Fixed Bugs

**TL;DR:** Five items — a timezone off-by-one (fixed), a parallel-drop stale closure (fixed), the bare `ALL_*_SIZE` suffix normalisation, tolerant Costsheet header matching, and the intentional "MAX-within-size" rule (not a bug).

### 8.1 Timezone bug on Max Input Date (fixed 2026-06-30)

**Symptom:** DB showed `2026-05-07`, output showed `2026-05-06`.

**Cause:** `dateVal.toISOString().slice(0, 10)` converted local midnight to UTC. In Bangkok (UTC+7), midnight local = 17:00 UTC the _previous_ day, so ISO stripped the wrong calendar date.

**Fix** — use local date parts (`src/lib/costsheet.ts`, ~line 128):

```ts
const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
```

**Note:** the MAX _selection_ was always correct (Date objects compare in UTC internally). Only the _display_ was off by one day.

### 8.2 Parallel-drop stale closure (fixed 2026-06-30)

**Symptom:** dropping 4 files only loaded 1.

**Cause:** each `FileReader.onload` called `onChange([...files, next])` against the closure's stale `files` array — 4 async callbacks all read the empty initial state and clobbered each other.

**Fix** — functional setState + dedupe inside the updater (`src/components/FileSlotPPS.tsx`):

```ts
setFiles((prev) => {
  if (prev.find((f) => f.name === file.name)) return prev;
  if (prev.length >= MAX_B_FILES) return prev;
  return [...prev, { name: file.name, headers, rows, colorIdx: prev.length }];
});
```

The prop signature had to change from `onChange: (next: PPSFile[]) => void` to `setFiles: Dispatch<SetStateAction<PPSFile[]>>` to support the functional form.

### 8.3 Bare `ALL_REG_SIZE` / `ALL_EXTEND_SIZE` without `_RB` suffix

**Symptom:** the WISDOM SIZE column showed a red mismatch even when sizes were logically equivalent to PPS's `ALL_REG_SIZE_RB`.

**Cause:** the Costsheet view stores group sizes without the `_RB` suffix; PPS and ACS use it.

**Fix** — at Costsheet ingest, uppercase-compare and prepend the suffix (`src/lib/costsheet.ts`, inside `buildCostsheetIndex`'s row loop):

```ts
const szUp = szRaw.toUpperCase();
if (szUp === "ALL_REG_SIZE") szRaw = "ALL_REG_SIZE_RB";
if (szUp === "ALL_EXTEND_SIZE") szRaw = "ALL_EXTEND_SIZE_RB";
```

### 8.4 Costsheet column name variations

**Symptom:** previews were empty and every row showed "No CS match".

**Cause:** exact-string matching against `'Final FOB'` failed when the view returned `FinalFOB` (no space) or `Final_FOB`.

**Fix** — alias-tolerant matcher `findCostsheetIdx(hdr, key)` in `normalize.ts`: it normalises headers (strip whitespace/underscores/dots/hyphens, lowercase) then matches against aliases in `constants.ts`. **To add a new alias:** edit `C_KEY_ALIASES` in `src/lib/constants.ts`.

### 8.5 MAX date is within the size-matched subset

**Not a bug — a design decision worth documenting.** If Costsheet has multiple rows for the same style+factory but different sizes, the MAX First Input Date is picked _within_ the rows matching the PPS row's size. So a fresher XL record does **not** override an older S record when the PPS row is size S.

If someone reports "I expected the newest record but got an older one," they may be seeing this rule in action rather than a bug — confirm by checking sizes.

---

## 9. Running the Project

**TL;DR:** Install prerequisites → start the backend (`python sql_backend.py` in dev, **`python serve.py`** on a server — §9.2b) → start the frontend (`npm run dev` for local, or `npm run build` + a static server for sharing). Backend URL comes from `frontend/.env` → `VITE_BACKEND_URL`.

### 9.1 Prerequisites

- Python 3.9+ (backend packages are pinned in `DashBoard/requirements.txt` — see §9.2)
- Node 18+ with npm
- Microsoft ODBC Driver for SQL Server (17 or 18)
- A Windows account with SELECT on `dbo.ACS` and `dbo.VIEW_COSTSHEET_WISDOM`

### 9.2 Backend (dev)

```powershell
cd "DashBoard"
python -m pip install -r requirements.txt   # Flask, flask-cors, pyodbc, ldap3, python-dotenv, waitress (pinned)
python sql_backend.py
```

Should print `* Running on http://0.0.0.0:5001`. Open `http://localhost:5001` to sanity-check — you'll see a plain HTML health message.

Common startup errors:

- `pyodbc.InterfaceError` — no SQL Server ODBC driver installed. Install "ODBC Driver 17 for SQL Server" or newer.
- `Login failed for user` — the Windows user running Flask lacks DB permission.
- `Cannot open server` — VPN or firewall blocking `<SQL_HOST>`.

### 9.2b Backend (production — `serve.py` + waitress)

`python sql_backend.py` starts Flask's **built-in development server**: single-threaded, so one slow
ACS fetch blocks every other user, and not hardened for anything but local work. On any shared or
always-on host, run the app under **waitress** instead — same app, same port, same routes:

```powershell
cd "DashBoard"
python -m pip install -r requirements.txt   # includes waitress
python serve.py
```

Should print `* waitress serving on http://0.0.0.0:5001 (8 threads)`. Sanity-check the same way
(`http://localhost:5001` → health message), then confirm a real data call (**Load ACS from DB**).

`serve.py` imports `app` from `sql_backend` and hands it to waitress — **no application code
changes**, and everything `sql_backend` does at import time (`load_dotenv()`, the three `init_db()`
calls) still runs first. Tune it with env vars rather than editing the file:

| Var             | Default   | Notes                                                                                     |
| --------------- | --------- | ----------------------------------------------------------------------------------------- |
| `SERVE_HOST`    | `0.0.0.0` | Set to `127.0.0.1` once a reverse proxy fronts the app (§10.4) so Flask isn't LAN-facing. |
| `SERVE_PORT`    | `5001`    | Keep in sync with `VITE_BACKEND_URL` / the proxy rule.                                    |
| `SERVE_THREADS` | `8`       | Concurrent request workers. 8 is ample for this user count.                               |

Common startup errors (in addition to the ODBC/DB ones above):

- **`waitress-serve : term not recognized`** — you were using the console script; use
  `python serve.py` instead, which doesn't depend on `PATH`. (Root cause is usually that the
  package's `Scripts\` folder isn't on `PATH`, or waitress was never installed on that machine.)
- **`ModuleNotFoundError: No module named 'waitress'`** — `requirements.txt` wasn't installed on
  **this** host, or a different interpreter was used. Re-run `python -m pip install -r requirements.txt`
  (with `python -m pip`, not bare `pip`), then `python -m pip show waitress` to confirm.

### 9.3 Frontend (dev)

```powershell
cd "DashBoard\frontend"
npm install
npm run dev
```

Opens `http://localhost:5173`. Vite proxies nothing — the frontend calls the backend directly at `VITE_BACKEND_URL` (default `http://localhost:5001`). To point elsewhere, edit `.env`:

```
VITE_BACKEND_URL=http://some-other-host:5001
```

### 9.4 Frontend (production build)

```powershell
cd "DashBoard\frontend"
npm run build     # runs tsc -b first, then vite build; output → dist/
npm run preview   # serves the built dist/ locally on port 4173
```

`npm run build` runs `tsc -b` first, so any TypeScript error stops the build. The `dist/` folder can be dropped onto any static host (IIS, nginx, S3+CloudFront, etc.) — there's no server-side rendering.

---

## 10. Hosting on the Internal Network

**TL;DR:** Three deployment options, in increasing operational maturity: **A** = both processes on your PC (start here), **B** = `serve.py`/waitress as an NSSM Windows service on an always-on box, **C** = backend on the DB server behind an IIS reverse proxy. A → B → C is a linear upgrade with **zero application code changes** — B and C differ only in how `serve.py` is launched and what `SERVE_HOST` is set to.

### 10.1 The three options

| Option                                         | Backend host              | Frontend host                   | Best for                              | Uptime story                          |
| ---------------------------------------------- | ------------------------- | ------------------------------- | ------------------------------------- | ------------------------------------- |
| **A. Shared PC**                               | Your laptop / desktop     | Your laptop                     | Fast to try, small team               | Only while your PC is on              |
| **B. NSSM service on shared server**           | Any always-on Windows box | Same box (IIS or `http.server`) | Small team, no admin overhead         | Always on (auto-start)                |
| **C. Backend on DB server, IIS reverse proxy** | The SQL Server host       | IIS on same host                | Prod-adjacent, ready for HTTPS + auth | Always on, single URL, backend hidden |

**Key insight:** migrating A → B → C needs zero code changes — just move files, change one env var, rebuild the frontend, and repoint DNS.

### 10.2 Option A — Shared PC (current setup)

Runtime picture:

```
Your PC (<OLD_SERVER_IP> on example.local)
├── Terminal 1: python -m http.server 8080 --directory dist   ← serves frontend
├── Terminal 2: python sql_backend.py                          ← serves API on 5001
└── Windows Firewall: inbound TCP 8080 + 5001 allowed
```

**One-time setup:**

1. **Set the backend URL** for the built frontend — `DashBoard/frontend/.env`:

   ```
   VITE_BACKEND_URL=http://<OLD_SERVER_IP>:5001
   ```

   (Better: `http://<hostname>.example.local:5001` — survives DHCP changes. Run `hostname` in PowerShell to find your machine name.)

2. **Build the frontend** (once; rerun after any code or `.env` change):

   ```powershell
   cd "DashBoard\frontend"
   npm install
   npm run build
   ```

   Output: `DashBoard\frontend\dist\` containing `index.html` + `assets/`.

3. **Open Windows Firewall** (run PowerShell **as Administrator**):

   ```powershell
   New-NetFirewallRule -DisplayName "Validator Frontend" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow
   New-NetFirewallRule -DisplayName "Validator Backend"  -Direction Inbound -Protocol TCP -LocalPort 5001 -Action Allow
   ```

   Verify: `Get-NetFirewallRule -DisplayName "Validator*" | Select-Object DisplayName,Enabled,Direction,Action`
   Remove later: `Remove-NetFirewallRule -DisplayName "Validator Frontend"` (and the same for backend).
   _To restrict rules to the corporate LAN only, append `-Profile Domain,Private` — on the same command line; a line break mid-command causes `Missing argument in parameter list`._

**Every-run setup** (both terminals must stay open):

```powershell
# Terminal 1 — frontend
cd "DashBoard\frontend"
python -m http.server 8080 --directory dist

# Terminal 2 — backend
cd "DashBoard"
python sql_backend.py
```

_Since colleagues are already hitting this, prefer **`python serve.py`** in Terminal 2 (§9.2b) —
same port and routes, but multi-threaded, so one slow ACS fetch doesn't block everyone else._

**Access URL:** `http://<OLD_SERVER_IP>:8080` — share this with colleagues.

**Verify before sharing:**

- Open `http://<OLD_SERVER_IP>:8080` on your own PC — page loads → static serving works.
- Click "Load ACS from DB" — pill shows rows → backend reachable + SQL access working.
- From a colleague's PC: `Test-NetConnection <OLD_SERVER_IP> -Port 8080` and `-Port 5001` must both report `TcpTestSucceeded : True`.

### 10.3 Option B — NSSM service on a shared server

Same shape as Option A, but the backend runs under **waitress** (`serve.py`) as a Windows service — auto-starts, survives reboots, no login required.

**Extra steps vs. A:**

1. Pick a machine that stays on 24/7 (an old desktop, or a small VM from IT).
2. Copy the `DashBoard/` folder to that machine.
3. Install Python 3.9+, run `pip install -r requirements.txt`, and install the SQL Server ODBC driver.
4. Get a **service account** from IT with `db_datareader` on `<DATABASE>` (or SELECT on the two specific objects).
5. Download **NSSM** (Non-Sucking Service Manager, free) and register the backend as a service.
   Point it at **`serve.py`** (waitress), not `sql_backend.py` — a service has no console to babysit,
   so it should not be running the dev server:
   ```powershell
   nssm install ValidatorBackend "C:\Python312\python.exe" "C:\apps\validator\serve.py"
   nssm set    ValidatorBackend AppDirectory "C:\apps\validator"
   nssm set    ValidatorBackend ObjectName ".\svc-validator" "<password>"
   nssm set    ValidatorBackend AppStdout "C:\apps\validator\logs\backend.out.log"
   nssm set    ValidatorBackend AppStderr "C:\apps\validator\logs\backend.err.log"
   nssm start  ValidatorBackend
   ```
   Use `python.exe` + `serve.py` rather than `waitress-serve.exe` — the console script's location
   depends on the **service account's** `PATH`, which is not the `PATH` you see in your own shell.
   Set the `AppStdout`/`AppStderr` log files now, not later: once it's a service there's no window,
   and AD/login errors are exactly what you'll need to read. Create the `logs\` folder first.
6. Do the same for the static file server (optional — or use IIS, which is already a service).
7. Open the firewall as in Option A.

**Verify it survives a reboot** — that's the entire point of B: `nssm status ValidatorBackend`
should report `SERVICE_RUNNING`, and it should still say that after restarting the machine without
anyone logging in. Also confirm the **service account** (`ObjectName`) is the one with
`db_datareader` — Windows integrated auth uses the identity running the process (§10.6), so a
wrong account here starts cleanly and then 500s on every data endpoint.

**Access URL:** same shape as A, pointing at the new machine's hostname/IP.

### 10.4 Option C — Backend on DB server + IIS reverse proxy

The DB server already hosts SQL Server. Putting the backend on the same box means zero cross-network DB traffic, with IIS in front serving the frontend and reverse-proxying the API.

Runtime picture:

```
DB Server (<SQL_HOST>)
├── SQL Server (existing)
├── Flask backend via serve.py/waitress (NSSM service, 127.0.0.1:5001 — NOT LAN-exposed)
└── IIS
    ├── / → static files from DashBoard\frontend\dist\
    └── /api/* → reverse-proxied to http://127.0.0.1:5001/*
```

**Setup** (assumes IT helps with IIS):

1. Copy `DashBoard/` to the DB server (e.g. `C:\apps\validator\`).
2. Install Python + pyodbc there. Register **`serve.py`** as an NSSM service (§10.3 step 5) and set
   **`SERVE_HOST=127.0.0.1`** in `DashBoard/.env` so the backend listens on localhost only — the
   proxy reaches it, the LAN can't. _(No code edit needed: `serve.py` reads the host from the
   environment. The older instruction here was to hand-edit `app.run(host=…)` in `sql_backend.py`;
   that line only runs in dev now and editing it has no effect under waitress.)_
3. Install the **URL Rewrite** and **ARR (Application Request Routing)** IIS modules (both free from Microsoft).
4. Create an IIS site pointing at `C:\apps\validator\frontend\dist\`.
5. Add a rewrite rule: match `^api/(.*)` → rewrite to `http://127.0.0.1:5001/{R:1}`.
6. Update `DashBoard/frontend/.env` → `VITE_BACKEND_URL=/api` and rebuild.

**Access URL:** `http://<db-server>/` — single origin, no CORS gymnastics, backend port not exposed. Add HTTPS by installing a cert in IIS.

### 10.5 Migrating from A → B or A → C later

The code doesn't change. Checklist:

1. **Copy `DashBoard/`** to the new host (`git clone` beats robocopy — keep the code in git for this reason).
2. **Install Python + packages + ODBC driver** on the new host.
3. **Grant SQL SELECT** to the new service account.
4. **Update `frontend/.env`** with the new backend URL, then `npm run build`.
5. **Open the firewall port** on the new host.
6. **Repoint DNS or send the new URL** to users.

The single biggest thing that makes future migration painless: **ask IT for an internal DNS name pointing at your PC's current IP** (e.g. `validator.example.local` → `<OLD_SERVER_IP>`). Later, IT flips that record to the new server and no colleague's bookmark breaks.

### 10.6 Prerequisites & practical tips

- **Node 18+ and Python 3.9+** on whichever machine builds the frontend and runs the backend. `npm install` needs internet — if the DB server can't reach npm, build on your PC and copy `dist/` over.
- **Windows integrated auth** (`Trusted_Connection=yes`) uses the identity of whoever runs the process. On your PC that's you; as an NSSM service, it's the configured `ObjectName` account.
- **CORS** currently accepts any origin (`CORS(app)`). Fine for A/B. For C (shared origin), tighten to `CORS(app, origins=['https://validator.example.local'])`.
- **HTTPS on internal networks** isn't strictly required, but modern browsers block some APIs (clipboard, service workers) on `http://`. If you add those features, upgrade to Option C with a cert.
- **No auth:** anyone on the LAN who finds the URL can hit the API. If that's a concern, gate it behind IIS Windows Authentication (Option C) or add a shared-token check to Flask.
- **Version control:** keep `DashBoard/` in git _now_, even as a local repo — migration becomes `git clone` instead of emailing zip files.
- **`MIGRATION.md`:** as you set up Option A, jot down every command you actually ran into a file inside `DashBoard/`. When migration day comes, you follow your own checklist.

### 10.7 Common first-run gotchas (Option A)

| Symptom (Terminal / browser)                                  | Cause                                                   | Fix                                                                                                                             |
| ------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm : term not recognized`                                   | Node.js not installed / not in PATH                     | Install Node 18+ from nodejs.org                                                                                                |
| `python : term not recognized`                                | Python not installed / not in PATH                      | Install Python 3.9+ and check "Add to PATH"                                                                                     |
| Blank page, terminal logs `GET / 404`                         | `dist/` doesn't exist or `--directory dist` was omitted | Re-run `npm run build`; confirm `dir dist\index.html` exists; relaunch `http.server` with `--directory dist`                    |
| `npm run build` errors with red TS errors                     | Type-checking failure                                   | Read the error, fix the offending file, rerun                                                                                   |
| Frontend loads but "Error: HTTP 0" on Load ACS                | Backend not running or firewall blocking 5001           | Confirm Terminal 2 shows `Running on 0.0.0.0:5001`; from another PC: `Test-NetConnection <ip> -Port 5001`                       |
| Backend prints `Login failed for user`                        | Windows account lacks SELECT on DB tables               | Ask a DBA to grant `db_datareader`                                                                                              |
| Backend prints `No SQL Server ODBC drivers found`             | Missing ODBC driver                                     | Install "Microsoft ODBC Driver 17 for SQL Server"                                                                               |
| Colleagues can't reach 8080 but you can                       | Firewall inbound rule missing or on the wrong profile   | Re-check `Get-NetFirewallRule -DisplayName "Validator*"`; ensure your NIC is on the Domain profile (`Get-NetConnectionProfile`) |
| `Missing argument in parameter list` on `New-NetFirewallRule` | Copy-paste inserted a line break inside the command     | Paste the whole command on ONE line, or use backtick (`` ` ``) as the last char on each continued line                          |

### 10.8 Stopping everything

- **Terminals:** `Ctrl+C` in each, then close.
- **NSSM services:** `nssm stop ValidatorBackend`.
- **Firewall rules:**
  ```powershell
  Remove-NetFirewallRule -DisplayName "Validator Frontend"
  Remove-NetFirewallRule -DisplayName "Validator Backend"
  ```

---

## 11. Extending the App

**TL;DR:** Most changes are one-file edits in `src/lib/constants.ts` (sizes, key pairs, Costsheet aliases). Adding a key column also touches `ResultsTable.tsx`; changing the SQL target touches `sql_backend.py`.

### 11.1 Add a new key column

If a 6th key (say `SKU_TYPE`) needs to join across all three sources:

1. **ACS + PPS mapping** — add to `KEY_PAIRS` in `src/lib/constants.ts`:
   ```ts
   { a: 'SkuType', b: 'SKU_TYPE_PPS' }
   ```
   If it's part of the JOIN (not just display), it's auto-included via `JOIN_KEY_PAIRS = KEY_PAIRS.filter(...)` — unless it should be excluded like `EXTRACTED_SIZE` is. Adjust the filter if so.
2. **Costsheet mapping** — add the key to `C_KEY_MAP` and matching aliases to `C_KEY_ALIASES`.
3. **Header rows** — add a `<th>` in both header rows of `ResultsTable.tsx` and bump the `colSpan` on the "Key Columns" `<th>`.
4. **Body rendering** — `keyDisplay` auto-maps over `KEY_PAIRS`, so the new cell renders automatically.

### 11.2 Add a new size to REG_SIZES or EXTEND_SIZE

Edit `src/lib/constants.ts`. That's it — everywhere else picks it up automatically.

### 11.3 Add a new Costsheet column alias

Edit `src/lib/constants.ts` → `C_KEY_ALIASES`. Aliases are compared after stripping whitespace/underscore/dot/hyphen and lowercasing, so `Final-FOB` and `finalfob` collide by design.

### 11.4 Change a column's display name

Edit the string inside the relevant `<th>` in `ResultsTable.tsx`. Internal logic uses field names (`row.dbFobValue`, etc.), not labels — so display changes are purely cosmetic.

### 11.5 Change the MAX date rule (e.g. min instead of max, or per-color-group instead of within-size)

Edit `lookupCostsheet` in `src/lib/costsheet.ts` — the `reduce` at the bottom is the whole thing. Also update the on-screen explanation in `KeyInfoPanel.tsx` to match.

### 11.6 Point at a different SQL Server / table

Edit the constants at the top of `sql_backend.py`:

```python
SERVER   = 'your\\instance'
DATABASE = 'your_db'
TABLE_A  = 'schema.your_acs_table'
TABLE_C  = 'schema.your_costsheet_view'
```

If column names differ, the aliases in `C_KEY_ALIASES` may already cover them — if not, add them (see [§11.3](#113-add-a-new-costsheet-column-alias)).

### 11.7 Add authentication

The Flask backend is currently open. Before deploying anywhere but a laptop, at minimum:

- Restrict CORS: `CORS(app, origins=['https://yourdomain.example'])`.
- Add a shared-secret header check, or route it behind an authenticated reverse proxy.
- If the frontend goes on a shared host, gate it too.

---

## 12. Troubleshooting

**TL;DR:** Most field issues are one of: backend down / firewall (HTTP 0), PPS headers not matching `STRICT_B_COLS` (every row "No Key Match"), Costsheet header aliases not matching (WISDOM columns all "—"), or a size-bucket / date-parse mismatch behind an unexpected Max Input Date.

### "Loading ACS from DB" shows a red error toast

- **HTTP 500** — check the Flask console for the SQL exception (login failure, missing table, ODBC driver missing).
- **HTTP 0 / CORS error** — Flask isn't running, or CORS is misconfigured. Confirm `http://localhost:5001` responds.
- **`data.error` in the response** — the backend caught an exception and returned it; read the message.

### A row shows the wrong ACS FOB — another colour's price

Symptom: a PPS row with a blank `COLOR` displays the FOB of a *specific* colourway. Reported as style `STYLE-B` showing **6.00** (colourway `084`) instead of **5.00** (`ALL_SOLID`).

1. Check the ACS preview. If a style appears **twice** with `ColorwayCode` `ALL` and `SOLID`, `expand_colorway_rows` is splitting `ALL_SOLID` — the backend is running code from before 2026-08-06. See [§4.3](#43-colorwaycode-row-expansion).
2. Confirm on the server: `findstr /C:"COLORWAY_NO_SPLIT_PREFIX" sql_backend.py` → 2 hits means the fix is present.
3. **Restart `serve.py` after copying it.** Waitress loads the module once at startup and never reloads, so a corrected file on disk changes nothing until restart. This has bitten twice.

If `ALL_SOLID` is intact and the FOB is still wrong, the colourway genuinely differs — check `dbo.ACS` directly for that season/style/factory.

### Two rows for the same style, size and factory with wildly different PPS FOB

One will be ~31× the other (e.g. `4.00` and `124.00`) — that is USD vs THB for the **same** quote. The fix is `preferUSDRows` (see the [currency section](#currency-twins-run-before-de-duplication-added-2026-08-06)); if you still see both, the **frontend** is stale. Rebuild with `npm run build` and copy the whole `frontend/dist/` folder, deleting the server's old one first — Vite hashes filenames, so merging leaves stale bundles behind.

Genuinely different **USD** amounts for one style/size are *not* a bug: 174 groups have revised quotes, and each keeps its own row and its own verdict.

### Every row is "No Key Match"

- Check for a `Missing ACS columns:` toast — if present, the ACS view is missing a join column.
- More likely: the PPS file's headers don't match `STRICT_B_COLS`. The header row must contain the literal, **case-sensitive** strings `SEASON_YEAR`, `STYLE`, `COLOR`, `FTYCODE`, `SIZE_DATA`, `LOCAL_QUOTE_AMOUNT`.

### WISDOM columns visible but every row shows "—" / "No CS match"

- Costsheet header names match no alias. Check the toast: `Costsheet missing columns: FOB ("Final FOB"), Date ("First Input Date"), …` — actual headers are logged to console (`[Costsheet] missing columns: … actual headers: […]`).
- Or: no Costsheet rows exist for the PPS key — verify with a direct SQL query.

### Extended sizes all show No CS but regular sizes are fine

Since 2026-08-05 extended-size rows read `Extended Size FOB`, not `Final FOB` ([§6.5](#65-costsheet-matching-max-first-input-date)). Two causes, in order of likelihood:

1. **The column didn't resolve.** Look for `Extended Size FOB ("Extended Size FOB")` in the
   `Costsheet missing columns:` toast. If the view renamed that column, add the new spelling
   to `C_KEY_ALIASES.extFob` in `constants.ts`. Careful: the view also has
   `Extended Size FOB(L4L)` and `Extended Size Adj%`, which must **not** match.
2. **The cell is genuinely empty** on the winning (newest) Costsheet row. That is the
   designed behaviour — a blank ext FOB reports No CS rather than falling back to
   `Final FOB` or to an older row. Confirm with:

   ```sql
   SELECT [Size], [Final FOB], [Extended Size Adj%], [Extended Size FOB]
   FROM dbo.VIEW_COSTSHEET_WISDOM
   WHERE [Style No.] = '<style>' AND [Season] = '<season>'
   ORDER BY [First Input date] DESC
   ```

### Max Input Date shows an unexpected value

Almost always one of:

1. **A different size on the winning record** (see [§6.5](#65-costsheet-matching-max-first-input-date) — MAX is computed within size).
2. **A different color / season** in the Costsheet (join-key mismatch).
3. **Date parse failure** — check the `First Input Date` format in SQL. `parseDate` handles ISO strings, `"YYYY-MM-DD hh:mm:ss"`, and Excel serials. `"23/06/2026"` (DMY) does **not** parse — it becomes `null` and the record is skipped from MAX.

### Diff hint says `No WISDOM` but Costsheet has a matching row

Check the size. If the PPS row is `ALL_REG_SIZE_RB` but Costsheet has `ALL_EXTEND_SIZE_RB` (or vice versa), they land in different buckets and won't match. Verify both sides normalise to the same bucket.

### Table looks squeezed, hard to read

Fixed 2026-06-30 — cells use `padding: 7px 12px` and the table has `width: max-content` so it scrolls horizontally instead of cramping. If it regresses, check `table.result tbody td` in `src/styles/global.css`.

### Only 1 PPS file loads when I drop 4

The stale-closure bug fixed 2026-06-30 (see [§8.2](#82-parallel-drop-stale-closure-fixed-2026-06-30)). If it regresses, verify `FileSlotPPS.tsx` still uses `setFiles((prev) => …)` rather than `setFiles([…files, next])`.

---

## Appendix A — File-level Comment Map

Every `.ts` / `.tsx` file in `frontend/src/` has a top-of-file JSDoc block describing its role, plus inline comments on non-obvious logic. Read in this order for a full picture:

1. `lib/types.ts` — data shapes
2. `lib/constants.ts` — configuration
3. `lib/normalize.ts` — atomic helpers
4. `lib/costsheet.ts` — Costsheet index + lookup
5. `lib/comparison.ts` — main `runComparison`
6. `lib/csv.ts` — export format
7. `lib/api.ts` — backend client
8. `App.tsx` — state + wiring
9. Components (`Header` → `UploadStrip` → `FileSlot*` → `KeyInfoPanel` → `ResultsToolbar` → `ResultsTable`)
10. `hooks/useToast.tsx`

---

## Appendix B — Legacy `index.html`

`DashBoard/index.html` is the original single-file HTML version this project was built from. It had feature parity with the React app as of 2026-06-30 and is kept as a fallback and for reference — if you break the React app during a refactor, the HTML version should still work.

**The React app is the going-forward implementation; new features should go there.**
