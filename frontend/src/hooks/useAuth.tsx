/**
 * Auth context. Holds the current user, exposes login/logout, and — on mount —
 * asks the backend /me whether the session cookie is still valid (so a page
 * refresh keeps you signed in). Any 401 from the API layer flips the user back
 * to null via setUnauthorizedHandler, dropping the app to the login page.
 */
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { apiLogin, apiLogout, apiMe, setUnauthorizedHandler } from '../lib/api';
import type { AuthUser } from '../lib/types';

interface AuthCtx {
  user: AuthUser | null;
  loading: boolean;                                   // true during the initial /me check
  login: (username: string, password: string) => Promise<void>;  // throws on bad creds
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Any 401 anywhere → back to the login screen.
    setUnauthorizedHandler(() => setUser(null));
    // Resume an existing session if the cookie is still good.
    apiMe().then((u) => {
      setUser(u);
      setLoading(false);
    });
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const profile = await apiLogin(username, password); // throws → caught by the form
    setUser(profile);
  }, []);

  const logout = useCallback(async () => {
    await apiLogout();
    setUser(null);
  }, []);

  return <Ctx.Provider value={{ user, loading, login, logout }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
