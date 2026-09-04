import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/**
 * The control app, built as a bundle the room machine serves itself.
 *
 * `base` carries the self-sufficiency invariant, in the form it took from the
 * console: **no resource outside the served origin**. It weighs more here than
 * elsewhere — the control machine sometimes runs with no network at all, and
 * everything it displays comes from its own `127.0.0.1`.
 *
 * `manifest`, as for the console: the server reads the hashed names rather than
 * guessing them, which lets it serve the assets as `immutable` and keep the shell
 * in its own hands — the control app needs its initial state embedded before the
 * first byte, failing which a reload leaves a blank screen in the middle of a
 * talk.
 */
export default defineConfig({
  base: '/regie/',
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    manifest: true,
    target: 'es2023',
    sourcemap: true,
  },
  server: {
    // Distinct from the console's 5173: the two are developed together, a demo
    // room plugged into a local hub.
    port: 5174,
    strictPort: true,
    origin: 'http://127.0.0.1:5174',
  },
})
