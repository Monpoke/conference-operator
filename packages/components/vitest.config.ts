import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

/** Même exception que pour les applications : monter un `.vue` demande le plugin. */
export default defineConfig({
  plugins: [vue()],
  test: { environment: 'happy-dom', include: ['test/**/*.test.ts'] },
})
