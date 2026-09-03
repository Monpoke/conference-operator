import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The page's frame, described in rules and not in utilities.
 *
 * The `<body>` is rendered by the room machine, not by this package: its classes
 * are scanned by nobody. What holds it up therefore lives in this stylesheet, and
 * these three rules are exactly the ones whose absence would only be seen on
 * screen — taken over from the guards of the pages it replaces.
 */
const SHEET = readFileSync(join(import.meta.dirname, '..', 'src', 'style.css'), 'utf8')

describe('the control app stylesheet', () => {
  it('paints its own background', () => {
    /*
     * The background used to come from a `body` rule in the old sheets. The hub
     * console ended up on the browser's default white when they were replaced
     * without laying classes back down; here it is a window opened in a dark room.
     */
    expect(SHEET).toMatch(/body\s*\{[^}]*background:\s*var\(--color-canvas\)/s)
    expect(SHEET).toMatch(/body\s*\{[^}]*color:\s*var\(--color-text\)/s)
  })

  it('fills the height, and does not scroll as one block', () => {
    // A control app that scrolls in its entirety pushes the commands off screen at
    // the very moment one is scrolling through a list of recordings.
    expect(SHEET).toMatch(/height:\s*100%/)
    expect(SHEET).toMatch(/overflow:\s*hidden/)
  })

  it('leaves the mount root transparent to the layout', () => {
    // `#regie-root` is a box the machine lays down; without `display: contents`,
    // the header and the content are no longer the `<body>`'s direct children and
    // the flex column applies to nothing.
    expect(SHEET).toMatch(/#regie-root\s*\{[^}]*display:\s*contents/s)
  })
})
