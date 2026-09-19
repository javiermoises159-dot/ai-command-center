/// <reference types="vite/client" />

/**
 * Augments Vite's own `ImportMetaEnv` with this app's variables. Only `VITE_`-
 * prefixed values are exposed to the browser by Vite, which is the mechanism
 * that keeps server secrets out of the bundle.
 */
interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}
