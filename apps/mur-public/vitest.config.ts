import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The tests start a real hub: nothing of it may leave the machine.
    setupFiles: ['../../scripts/vitest-offline.ts'],
  },
})
