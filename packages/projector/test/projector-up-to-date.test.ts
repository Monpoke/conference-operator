import { describe, expect, it } from 'vitest'
// @ts-expect-error — build script in plain JS, with no dedicated typings
import { MODULES, readModule, renderModule } from '../scripts/build.mjs'

/**
 * The committed modules must match the sources.
 *
 * Without it, a scene changed in `src/browser` would leave the rooms projecting
 * the previous compilation — and nobody would look for the difference there.
 * The same holds for the VOD's intro and outro, rendered from `src/vod`.
 */
describe('pages inlined into their documents', () => {
  for (const name of Object.keys(MODULES as Record<string, unknown>)) {
    it(`${name} matches the sources`, () => {
      expect(
        renderModule(name) === readModule(name),
        'The committed module differs from a recompilation: regenerate it.\n' +
          '    pnpm --filter @conference-operator/projector build',
      ).toBe(true)
    })
  }
})
