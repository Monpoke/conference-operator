import { describe, expect, it } from 'vitest'
// @ts-expect-error — build script in plain JS, with no dedicated typings
import { readModule, renderModule } from '../scripts/build.mjs'

/**
 * The committed module must match the sources.
 *
 * Without it, a scene changed in `src/browser` would leave the rooms projecting
 * the previous compilation — and nobody would look for the difference there.
 */
describe('projector inlined into the page', () => {
  it('matches the sources', () => {
    expect(
      renderModule() === readModule(),
      'The committed module differs from a recompilation: regenerate it.\n' +
        '    pnpm --filter @conference-operator/projector build',
    ).toBe(true)
  })
})
