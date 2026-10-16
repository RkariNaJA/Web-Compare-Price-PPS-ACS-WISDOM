/**
 * Light / dark theme switch. The palette lives in tokens.css and is forced by
 * [data-theme="light" | "dark"] on <html>. The user's pick is remembered per
 * browser in localStorage; with no saved pick we follow the OS setting.
 *
 * applyInitialTheme() runs from main.tsx before React renders, so the page
 * never flashes the wrong theme on load.
 */
import { useState } from 'react';

export type Theme = 'light' | 'dark';
const STORAGE_KEY = 'validator-theme';

// localStorage can throw (private mode, blocked site data) — treat as "no pick".
function savedTheme(): Theme | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'light' || v === 'dark' ? v : null;
  } catch {
    return null;
  }
}

function currentTheme(): Theme {
  return (
    savedTheme() ??
    (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  );
}

export function applyInitialTheme() {
  document.documentElement.dataset.theme = currentTheme();
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // not persisted — the switch still works for this visit
    }
    setTheme(next);
  };

  return { theme, toggle };
}
