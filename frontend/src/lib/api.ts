/**
 * Backend client. Fetches ACS and Costsheet data from the Flask backend
 * (sql_backend.py, port 5001 by default). The URL comes from the env var
 * VITE_BACKEND_URL — set it in .env if the backend is running elsewhere.
 */
import type { ActiveUser, AuthUser, ChangeEvent, LoginEvent, RowAnnotation, TableData } from './types';

// Backend base URL. `import.meta.env` is Vite's compile-time env injection.
// Default: same host the page was served from, port 5001 — survives DHCP
// address changes because the browser already knows the working host.
const BACKEND_URL =
  (import.meta.env.VITE_BACKEND_URL as string | undefined) ??
  `http://${window.location.hostname}:5001`;

// Every request carries the session cookie so the backend's @login_required
// passes once the user is signed in.
const CREDS: RequestInit = { credentials: 'include' };

// Registered by the auth provider — invoked whenever the backend returns 401
// (expired/absent session) so the UI can drop straight back to the login page.
let unauthorizedHandler: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  unauthorizedHandler = fn;
}

// Generic GET → JSON → TableData. The `t=<epoch>` cache-buster forces a fresh
// response instead of returning a stale SQL snapshot from the browser cache.
async function fetchTable(path: string): Promise<TableData> {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${BACKEND_URL}${path}${sep}t=${Date.now()}`, CREDS);
  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new Error('Your session expired — please sign in again.');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);  // backend sends { error } on SQL failures
  return { name: data.name, headers: data.headers, rows: data.rows };
}

// GET /get_file_a_data — returns dbo.ACS rows, with EXTRACTED_SIZE appended
// and underscore-joined ColorwayCode entries expanded into separate rows.
export const fetchACS = () => fetchTable('/get_file_a_data');

// GET /get_costsheet_data — returns dbo.VIEW_COSTSHEET_WISDOM rows, with the
// same colorway-expansion + optional EXTRACTED_SIZE (only if CBDID exists).
export const fetchCostsheet = () => fetchTable('/get_costsheet_data');

// GET /get_pps_factories — distinct FTYCODE list from dbo.PPS, drives the picker.
export async function fetchPPSFactories(): Promise<string[]> {
  const res = await fetch(`${BACKEND_URL}/get_pps_factories?t=${Date.now()}`, CREDS);
  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new Error('Your session expired — please sign in again.');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data.factories as string[];
}

// GET /get_pps_data?ftycode=… — all dbo.PPS rows for one factory (raw, no dedupe).
export const fetchPPS = (ftycode: string) =>
  fetchTable(`/get_pps_data?ftycode=${encodeURIComponent(ftycode)}`);

// ── Auth ─────────────────────────────────────────────────────────────────────
// Older sessions (from before this feature) may lack perms; default to read-only
// so the UI never crashes on `user.perms`.
function normalizeUser(raw: any): AuthUser {
  return {
    ...raw,
    perms: raw?.perms ?? { can_edit: false, can_manage: false },
  } as AuthUser;
}

// POST /login — returns the user profile on success, throws the backend's
// message ("Invalid username or password") on 401.
export async function apiLogin(username: string, password: string): Promise<AuthUser> {
  const res = await fetch(`${BACKEND_URL}/login`, {
    ...CREDS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Login failed (HTTP ${res.status})`);
  return normalizeUser(data.user);
}

// POST /logout — clears the server session. Best-effort; never throws.
export async function apiLogout(): Promise<void> {
  await fetch(`${BACKEND_URL}/logout`, { ...CREDS, method: 'POST' }).catch(() => {});
}

// GET /me — returns the current user if the session cookie is still valid, else
// null. Called once on load to decide login page vs. app.
export async function apiMe(): Promise<AuthUser | null> {
  try {
    const res = await fetch(`${BACKEND_URL}/me`, CREDS);
    if (!res.ok) return null;
    const data = await res.json();
    return normalizeUser(data.user);
  } catch {
    return null;
  }
}

// ── Row annotations (Error From / Done) ──────────────────────────────────────
// The backend speaks snake_case ({ error_from, done, saved_by, saved_at }); we
// convert to/from the frontend RowAnnotation shape here so the rest of the app
// only sees camelCase.
function toAnnotations(raw: Record<string, any>): Record<string, RowAnnotation> {
  const out: Record<string, RowAnnotation> = {};
  for (const [key, v] of Object.entries(raw || {})) {
    out[key] = {
      errorFrom: v.error_from || '',
      done: !!v.done,
      savedBy: v.saved_by || '',
      savedAt: v.saved_at || '',
    };
  }
  return out;
}

// GET /annotations — the shared saved values, keyed by row_key.
export async function fetchAnnotations(): Promise<Record<string, RowAnnotation>> {
  const res = await fetch(`${BACKEND_URL}/annotations?t=${Date.now()}`, CREDS);
  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new Error('Your session expired — please sign in again.');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return toAnnotations(data.annotations);
}

// POST /annotations — save the current values (the Save button). Sends only
// error_from/done; the backend stamps saved_by/saved_at. Returns the fresh set.
export async function saveAnnotations(
  items: Record<string, RowAnnotation>,
): Promise<Record<string, RowAnnotation>> {
  const payload: Record<string, { error_from: string; done: boolean }> = {};
  for (const [key, v] of Object.entries(items)) {
    payload[key] = { error_from: v.errorFrom || '', done: !!v.done };
  }
  const res = await fetch(`${BACKEND_URL}/annotations`, {
    ...CREDS,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ annotations: payload }),
  });
  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new Error('Your session expired — please sign in again.');
  }
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `Save failed (HTTP ${res.status})`);
  }
  const data = await res.json();
  return toAnnotations(data.annotations);
}

// ── Group management (admin-only; backend enforces manage permission) ─────────
export interface AppGroup {
  name: string;
  can_edit: boolean;
  can_manage: boolean;
  members: string[];
}

// Shared helper: every group route returns { groups: AppGroup[] } (the fresh
// full list) so one call both mutates and refreshes.
async function groupsRequest(path: string, init?: RequestInit): Promise<AppGroup[]> {
  const res = await fetch(`${BACKEND_URL}${path}`, { ...CREDS, ...init });
  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new Error('Your session expired — please sign in again.');
  }
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data.groups as AppGroup[];
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const fetchGroups = () => groupsRequest('/groups');

export const createGroup = (name: string, can_edit: boolean, can_manage: boolean) =>
  groupsRequest('/groups', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ name, can_edit, can_manage }),
  });

export const setGroupPerms = (name: string, can_edit: boolean, can_manage: boolean) =>
  groupsRequest(`/groups/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({ can_edit, can_manage }),
  });

export const deleteGroup = (name: string) =>
  groupsRequest(`/groups/${encodeURIComponent(name)}`, { method: 'DELETE' });

export const addGroupMember = (name: string, username: string) =>
  groupsRequest(`/groups/${encodeURIComponent(name)}/members`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ username }),
  });

export const removeGroupMember = (name: string, username: string) =>
  groupsRequest(`/groups/${encodeURIComponent(name)}/members/${encodeURIComponent(username)}`, {
    method: 'DELETE',
  });

// ── Admin log page ────────────────────────────────────────────────────────────
// Heartbeat: fire-and-forget; a failed ping just means "not seen right now".
export function ping(): void {
  fetch(`${BACKEND_URL}/ping`, { ...CREDS, method: 'POST' }).catch(() => {});
}

async function adminGet<T>(path: string, key: string): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, CREDS);
  if (res.status === 401) {
    unauthorizedHandler?.();
    throw new Error('Your session expired — please sign in again.');
  }
  if (!res.ok) {
    const d = await res.json().catch(() => ({}));
    throw new Error(d.error || `HTTP ${res.status}`);
  }
  const data = await res.json();
  return data[key] as T;
}

export const fetchPresence = () => adminGet<ActiveUser[]>('/admin/presence', 'active');
export const fetchLogins = (date: string) =>
  adminGet<LoginEvent[]>(`/admin/logins?date=${encodeURIComponent(date)}`, 'logins');
export const fetchChanges = (date: string) =>
  adminGet<ChangeEvent[]>(`/admin/changes?date=${encodeURIComponent(date)}`, 'changes');

export const backendUrl = BACKEND_URL;
