import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * The operator console, built as a bundle the hub serves.
 *
 * `base` matters more than it looks: the hub serves the console under `/admin`,
 * and every asset URL emitted here has to stay **relative to the hub's own
 * origin**. That is the invariant that replaced "no external dependency" — a
 * page must not reach outside the origin that served it, because that origin is
 * the one thing still reachable when the event's network drops.
 *
 * `manifest` is what lets the server emit the hashed filenames without guessing
 * them. It reads `dist/.vite/manifest.json` and writes the tags itself, which is
 * also how it keeps rendering the shell — the console needs `mode`, the event
 * identity and the Google flag before its first request, exactly as the string
 * template did.
 */
export default defineConfig({
  base: '/admin/',
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    manifest: true,
    // Aligned with `tsconfig.base.json`: one target for the whole repository,
    // decided once.
    target: 'es2023',
    sourcemap: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    /*
     * In development the hub proxies *this* server, not the other way round.
     *
     * The direction is forced: the hub carries the Better Auth cookies, `/rpc`,
     * the rooms' WebSocket, and `/sw.js` — whose scope is decided by the path
     * it is served from. Putting Vite in front would break the service worker's
     * scope and the cookies' origin.
     */
    origin: 'http://127.0.0.1:5173',
  },
})
