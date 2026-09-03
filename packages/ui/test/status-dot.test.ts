import { readFileSync } from 'node:fs'
import { globSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
// Chemin relatif : `ui` ne dépend pas de `components`, et l'inverse serait un
// cycle. Ce test lit déjà des sources par chemin — c'est sa nature.
import { DOT_LEVELS } from '../../components/src/domain/status-levels.js'
import { APPEARANCE, outlineOf } from '@cloudnord/room-state'
import { describe, expect, it } from 'vitest'

/**
 * The status dot's vocabulary is written in two places, and only one raises.
 *
 * `APPEARANCE` and `outlineOf()` produce **class names**; `status.css` paints
 * them. Nothing links the two: a tint added to the table with no matching rule
 * gives a random dot, and a rule left behind after a tint is removed travels in
 * the sheet inlined by every page without anyone noticing. Both defects existed —
 * the second (`.status-dot.pause`) survived the change of `APPEARANCE.pause`,
 * whose tint moved to `off`.
 *
 * The test compares the two sets in both directions, as `vues-du-flux` does for
 * the flow's fields.
 */

const STATUS_CSS = readFileSync(fileURLToPath(new URL('../src/status.css', import.meta.url)), 'utf8')

/** Modifiers actually painted, read from the sheet. */
const painted = new Set(
  [...STATUS_CSS.matchAll(/\.status-dot\.([a-z-]+)/g)].map((found) => found[1] as string),
)

/**
 * Modifiers actually set by the code.
 *
 * Three sources, and the third is the one I had missed. The fill comes from the
 * appearance table; the outline from `outlineOf()`, whose output is prefixed with
 * a space since it gets concatenated. But some dots are set **by hand**, without
 * going through any table: a machine's, where only a connectivity is shown, and
 * the shared slot's, which is not a talk.
 *
 * Listing them here by hand meant keeping a fourth list up to date, and that is
 * exactly what failed: `.status-dot.break` was removed as dead while the Global
 * panel set it, and the panel fell back to the default green. So we collect them
 * from the sources.
 */
const SOURCES = globSync('{apps,packages}/*/{src,test}/**/*.{ts,vue}', {
  cwd: fileURLToPath(new URL('../../../', import.meta.url)),
})

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const byHand = new Set(
  SOURCES.flatMap((file) =>
    [
      ...readFileSync(ROOT + file, 'utf8').matchAll(
        /status-dot[^\n]{0,80}?\b(off|break|ending-soon|not-started|ended|late|overrun|degraded|offline|unsure|silent)\b/g,
      ),
    ].map((found) => found[1] as string),
  ),
)

const set = new Set(
  [
    ...Object.values(APPEARANCE).map((appearance) => appearance.tint),
    ...['ONLINE', 'DEGRADED', 'OFFLINE', null].map((c) => outlineOf(c).trim()),
    ...Object.values(DOT_LEVELS),
    ...byHand,
  ].filter((name) => name !== ''),
)

describe('status dot vocabulary', () => {
  it('paints every modifier the code can set', () => {
    expect([...set].filter((name) => !painted.has(name)).sort()).toEqual([])
  })

  it('paints no modifier nobody sets any more', () => {
    expect([...painted].filter((name) => !set.has(name)).sort()).toEqual([])
  })

  it('actually covers something', () => {
    // Guard rail for the guard rail: two empty sets would match each other
    // perfectly while proving nothing.
    expect(painted.size).toBeGreaterThan(6)
  })
})
