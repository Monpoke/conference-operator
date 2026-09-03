import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

/** Same exception as for the applications: mounting a `.vue` needs the plugin. */
export default defineConfig({
  plugins: [vue()],
  test: { environment: 'happy-dom', include: ['test/**/*.test.ts'] },
})
