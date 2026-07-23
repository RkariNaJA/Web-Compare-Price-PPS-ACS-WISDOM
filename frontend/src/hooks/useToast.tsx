/**
 * Toast context + hook (For pop-up notification).
 *
 * Any component under <ToastProvider> can call useToast() to get a `toast(text, kind)`
 * function. Only one toast is shown at a time; it auto-dismisses after 3s.
 * The visible toast is rendered by the provider itself so children don't need to render it.
 */
import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import type { ToastMsg } from '../lib/types';

interface ToastCtx {
  toast: (text: string, kind?: 'ok' | 'err') => void;
  current: ToastMsg | null;
}

const Ctx = createContext<ToastCtx | null>(null);

// Wrap the app in this once (see App.tsx). Owns the single toast slot state.
export function ToastProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<ToastMsg | null>(null);

  // Show a toast. The id + setTimeout+id-check pattern guards against overwriting
  // a fresher toast from a previous one's expiring timer.
  const toast = useCallback((text: string, kind: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setCurrent({ id, text, kind });
    window.setTimeout(() => {
      setCurrent((c) => (c && c.id === id ? null : c));  // only clear if we're still the current toast
    }, 3000);
  }, []);

  return (
    <Ctx.Provider value={{ toast, current }}>
      {children}
      {/* Actual toast DOM lives here — fixed-position via .toast CSS in global.css */}
      {current && <div className={`toast ${current.kind}`}>{current.text}</div>}
    </Ctx.Provider>
  );
}

// Component-side hook — the only thing consumers actually import.
export function useToast() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx.toast;
}
