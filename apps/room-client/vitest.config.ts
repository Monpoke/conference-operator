import { defineConfig } from 'vitest/config'

/**
 * The room's tests are the only ones that boot real infrastructure.
 *
 * Their `beforeEach` starts a hub, opens sockets and writes a temporary data
 * directory before the first assertion — several seconds even on a fast
 * machine. Vitest's ten-second default for hooks left no margin: the suite went
 * green here and timed out on CI, whose runners are slower, and the failure read
 * as a broken test rather than as a machine that needed more time.
 *
 * The generous ceilings cost nothing on a run that passes — a timeout is only
 * ever reached when something is already wrong — and they keep the signal
 * honest: a red room-client suite means the code broke, not that the runner was
 * busy.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
})
