/**
 * TypeScript ambient declarations for Vite.
 *
 * The triple-slash reference pulls in Vite's built-in types (import.meta.env, etc.).
 * The interface merge below adds our custom env var VITE_BACKEND_URL so
 * `import.meta.env.VITE_BACKEND_URL` type-checks as `string | undefined`
 * anywhere it's used (currently just src/lib/api.ts).
 */
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BACKEND_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
