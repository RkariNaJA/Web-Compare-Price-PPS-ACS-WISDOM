/**
 * Entry point — mounts the React tree into <div id="root"> in index.html
 * and pulls in the two global stylesheets (CSS variables + component styles).
 *
 * StrictMode enables extra dev-only checks (double-invocation of effects/renders)
 * to surface bugs early. It has no effect on the production build.
 */
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/tokens.css';   // CSS variables (palette, spacing, type)
import './styles/global.css';   // component classes (.header, .file-slot, .result table, …)
import { applyInitialTheme } from './hooks/useTheme';

applyInitialTheme();             // set light/dark before the first render (no flash)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
