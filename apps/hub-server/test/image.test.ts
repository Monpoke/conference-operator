import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The hub's image lists the manifests one by one, and nobody remembers it.
 *
 * The Dockerfile says so itself: `--frozen-lockfile` compares the lockfile to the
 * whole set of projects it finds, and "a missing manifest reads as a stale
 * lockfile, and the install fails on a message that does not say that". The
 * breakage therefore happens at deployment time, on a misleading error, while the
 * cause is a package added to the workspace ten commits earlier.
 *
 * This test costs two directory reads and removes the whole class.
 */

const root = fileURLToPath(new URL('../../../', import.meta.url))
const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8')

/** The manifests copied in the install stage. */
const listed = new Set(
  [...dockerfile.matchAll(/^COPY ([\w./-]+)\/package\.json/gm)].map((found) => found[1] as string),
)

/** The projects actually present, per the groups in `pnpm-workspace.yaml`. */
const present = new Set(
  ['apps', 'packages'].flatMap((group) =>
    readdirSync(join(root, group))
      .map((name) => `${group}/${name}`)
      .filter((path) => {
        try {
          return statSync(join(root, path, 'package.json')).isFile()
        } catch {
          return false
        }
      }),
  ),
)

describe('hub image', () => {
  it('copies the manifest of every workspace project', () => {
    expect([...present].filter((project) => !listed.has(project)).sort()).toEqual([])
  })

  it('does not copy a manifest that no longer exists', () => {
    expect([...listed].filter((project) => !present.has(project)).sort()).toEqual([])
  })

  it('is actually looking at something', () => {
    // A guard for the guard: two empty sets would match without proving
    // anything, and a regex that finds nothing is the most likely defect here.
    expect(listed.size).toBeGreaterThan(5)
  })
})
