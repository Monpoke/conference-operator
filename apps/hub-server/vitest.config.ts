import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The hub prefetches the programme's images after an import: never from a test.
    setupFiles: ['../../scripts/vitest-offline.ts'],
  },
})
