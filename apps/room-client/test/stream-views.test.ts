import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIELDS_BY_VIEW, type DisplayView } from '../src/core/display-server.js'

/**
 * The state stream only pushes each page the fields it reads — the overlay has
 * no use for the room's 27 sessions or for the wall's QR code.
 *
 * The risk in that split is silent: a field added to a page but forgotten in
 * `FIELDS_BY_VIEW` raises nothing, it displays blanks. So this test reads the
 * pages' sources back and compares what they consult with what they receive.
 *
 * The control app is no longer listed: it is a bundle, not a template, and its
 * own guard lives with it — `apps/regie-web/test/champs-du-flux.test.ts`, which
 * reads its sources back the same way.
 */
const PAGES: { view: DisplayView; file: string }[] = [
  { view: 'projecteur', file: 'display-page.ts' },
  { view: 'overlay', file: 'overlay-page.ts' },
]

/**
 * Payload fields consulted by a page, by reading its source.
 *
 * `data?.field` as well as `data.field`, and the optional form is no detail: the
 * pattern's first version ignored it, and the only field a page read that way —
 * the wall, in the control app's screen menu — was missing from
 * `FIELDS_BY_VIEW` with nothing to say so. The "Mur public" link only held by
 * accident: the state embedded in the shell is not filtered, and the screen list
 * was built only once.
 */
function fieldsRead(file: string): string[] {
  const source = readFileSync(join(import.meta.dirname, '..', 'src', 'core', file), 'utf8')
  const found = source.matchAll(/\bdata\??\.([a-zA-Z]+)/g)
  return [...new Set([...found].map((m) => m[1]!))].sort()
}

describe('state stream views', () => {
  for (const { view, file } of PAGES) {
    it(`${view} receives everything ${file} consults`, () => {
      const received = new Set<string>(FIELDS_BY_VIEW[view] as readonly string[])
      const missing = fieldsRead(file).filter((field) => !received.has(field))
      expect(
        missing,
        missing.length === 0
          ? ''
          : `${file} reads ${missing.join(', ')} — add them to FIELDS_BY_VIEW.${view}, ` +
            'otherwise the page renders blanks without raising an error.',
      ).toEqual([])
    })

    it(`${view} receives nothing useless`, () => {
      // The reverse counts too: a field sent without being read is pure traffic.
      const read = new Set(fieldsRead(file))
      const useless = (FIELDS_BY_VIEW[view] as readonly string[]).filter((field) => !read.has(field))
      expect(useless).toEqual([])
    })
  }

  it('reading the sources does find something', () => {
    // A guard for the guard: an extraction gone silent would make the previous
    // tests pass while checking nothing.
    for (const { file } of PAGES) expect(fieldsRead(file).length).toBeGreaterThan(0)
  })
})
