/**
 * The machine vocabulary, not the talk one.
 *
 * `degraded` and `offline` render the same two tints as `ending-soon` and
 * `overrun` — the stylesheet keeps them apart on purpose, and says so: one pair
 * describes a machine, the other a talk. A dot over a saturated CPU has no talk
 * behind it, and naming it `overrun` would make the next reader of the
 * stylesheet believe otherwise.
 *
 * In a module rather than inside `StatusDot.vue` so that the status-dot
 * vocabulary test can read it: these three values are set on a dot without going
 * through the appearance table, and a test that had to find them by scanning a
 * single-file component would only be verifying a proximity of characters.
 */
export const DOT_LEVELS = {
  ok: '',
  warn: 'degraded',
  alert: 'offline',
  unknown: 'off',
} as const

export type DotLevel = keyof typeof DOT_LEVELS
