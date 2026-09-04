import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * The repository's first vitest configuration file, and that is worth saying.
 *
 * Everywhere else the environment is chosen by a pragma at the top of the file and
 * the default configuration is enough. Mounting a Vue component requires
 * `@vitejs/plugin-vue` to be registered, which no pragma does — hence this
 * exception, limited to the applications that contain `.vue` files.
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
  },
})
