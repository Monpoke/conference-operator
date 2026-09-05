import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — build script in plain JS, with no dedicated typings
import { compileCss, escapeForStyleTag } from '../scripts/build-css.mjs'
import { TAILWIND_CSS } from '../src/generated/styles.js'

/**
 * The committed sheet must match the classes actually used.
 *
 * The risk is silent: a Tailwind class added to a page without regenerating the
 * sheet simply has no style. Nothing raises, nothing breaks at type-check time —
 * the screen renders crooked, and you find out in the room.
 *
 * Recompiling costs a few tens of milliseconds, so we compare for real rather
 * than sampling a few class names.
 */
describe('stylesheet', () => {
  it('is up to date with the pages', () => {
    const fresh = escapeForStyleTag(compileCss(join(mkdtempSync(join(tmpdir(), 'cn-css-')), 'styles.css')))
    expect(
      fresh === TAILWIND_CSS,
      'The committed sheet differs from a recompilation: a page uses classes that ' +
        'are not in the served CSS (or nothing uses them any more).\n' +
        '    pnpm --filter @conference-operator/ui build',
    ).toBe(true)
  })

  it('contains the utilities and the theme', () => {
    // Guard rail for the guard rail: an empty compilation would pass the
    // comparison above while proving nothing.
    expect(TAILWIND_CSS.length).toBeGreaterThan(5_000)
    expect(TAILWIND_CSS).toContain('--color-dim')
    expect(TAILWIND_CSS).toMatch(/\.flex\{/)
  })

  it('cannot close the style tag of the page inlining it', () => {
    expect(TAILWIND_CSS).not.toMatch(/<\/style>/i)
  })
})
