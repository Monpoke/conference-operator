import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** The backtick, named so as not to write it in a file that talks about it. */
const BACKTICK = String.fromCharCode(96)
import { renderProjectorPage } from '../src/core/display-page.js'
import { renderOverlayPage } from '../src/core/overlay-page.js'
import { renderHubAddressPage } from '../src/core/hub-address-page.js'
import { parseScripts, extractScripts } from './helpers/inline-scripts.js'

/**
 * Guards common to the locally served pages.
 *
 * They are written as template literals: a backtick forgotten in a comment cuts
 * the string and breaks the file. The compiler catches it, but only afterwards —
 * these tests say *which* property we hold.
 *
 * The control app has left them: it is a bundle. Those of its guards that still
 * make sense followed it — the origin of the resources and the closed document in
 * `control-served.test.ts`, the background and the layout in
 * `apps/control-web/test/frame.test.ts`. The others only targeted the literal
 * template, and Vite makes them moot.
 */
const PAGES: [string, string][] = [
  ['projector', renderProjectorPage()],
  ['overlay', renderOverlayPage()],
  ['hub address', renderHubAddressPage({ initialValue: 'http://localhost:8787' })],
]

/**
 * The page's markup, script bodies removed.
 *
 * These pages carry their whole script inline, and that script *writes* html: the
 * tag names it assembles are ordinary text in the served document. Looking for a
 * tag without setting the scripts aside would find the code that may one day
 * build it, which is not the same claim at all.
 */
const markup = (html: string) => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')

/**
 * The pages' source files, for the writing guards.
 *
 * These pages are literal templates: what one writes in them goes through a
 * parser twice, TypeScript's and then the browser's.
 */
const SOURCES = [
  // The projected page's template lives with the page, shared with the hub.
  '../../../packages/projector/src/server/page.ts',
  '../src/core/overlay-page.ts',
  '../src/core/overlay-live-page.ts',
  '../src/core/hub-address-page.ts',
].map((path) => [path.split('/').pop()!, readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')] as const)

describe('writing the templates', () => {
  it.each(SOURCES)('%s: no bare backtick in the template body', (_name, source) => {
    /**
     * The mistake that keeps coming back, and costs dearly every time.
     *
     * A backtick in a comment — "see CONFIG" written in code style — closes the
     * literal template. TypeScript then reports a syntax error **at the end of
     * the file**, a hundred lines from the cause, and the whole page stops
     * compiling. This test names it.
     */
    const start = source.indexOf(BACKTICK + '<!doctype html>')
    const end = source.lastIndexOf(BACKTICK)
    expect(start).toBeGreaterThan(-1)

    // **Escaped** backticks are legitimate: `display-page` uses them for its own
    // nested templates. Only the bare ones close the string.
    const body = source.slice(start + 1, end).split('\\' + BACKTICK).join('')
    expect(body).not.toContain(BACKTICK)
  })
})

describe('pages served by the client', () => {
  it.each(PAGES)('%s: no external dependency, apart from the named exception', (name, html) => {
    /*
     * A tag pointing at a CDN breaks the page at the first network cut — that is,
     * exactly when it is needed.
     *
     * No exception any more: the X button the projection's Réseaux slide used
     * to load left with the reference loop's design — a projector has no mouse.
     * The list stays, so that a dependency inviting itself in — a font, an
     * analytics script — has to be named here to pass.
     */
    const ALLOWED: Record<string, string[]> = {}
    const external = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)]
      .map((found) => found[1]!)
      .filter((address) => /^(?:https?:)?\/\//.test(address))

    expect(external).toEqual(ALLOWED[name] ?? [])
    expect(html).not.toMatch(/@import\s+url/)

    /*
     * And no frame onto the outside **in the served page**.
     *
     * The social wall is the second named external dependency, and the only one
     * that is not written here: its address is a hub setting, so it arrives in the
     * payload and is drawn by the script. What this line holds is that it stays
     * there — a frame baked into the served html would load on every screen, for
     * every room, including the ones showing something else.
     */
    expect(markup(html)).not.toMatch(/<iframe/)

    // Loaded `async`: nothing that is read should wait on the network.
    for (const address of external) {
      expect(html).toMatch(new RegExp('<script async src="' + address.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"'))
    }
  })

  it.each(PAGES)('%s: complete and closed document', (_name, html) => {
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
  })

  it.each(PAGES)('%s: the embedded JavaScript parses', (_name, html) => {
    // Without this test nothing checks that code: it lives in a template literal,
    // where TypeScript only sees a string. An error there breaks *all* the page.
    expect(parseScripts(html)).toEqual([])
  })

  it.each(PAGES)('%s: does contain script to parse', (_name, html) => {
    // A guard for the guard: if the extraction stopped finding anything at all,
    // the previous test would pass while checking nothing.
    expect(extractScripts(html).length).toBeGreaterThan(0)
  })

  it('the social wall brings no external origin with it', () => {
    /*
     * walls.io used to be the one external dependency of the page, an iframe.
     * Its posts now come from the hub, and their photos from the room's cache:
     * the page served carries no frame and no remote address, even with a wall.
     */
    const html = renderProjectorPage({
      initialPayload: {
        socialWall: [
          {
            id: 'p1', source: 'wallsio', author: 'Anne', authorSubtitle: null, avatarUrl: '/assets/a',
            text: 'Bonjour', imageUrl: '/assets/b', network: 'Instagram',
            postedAt: '2026-10-30T10:00:00.000Z', featured: true, sponsor: null,
          },
        ],
      } as never,
    })

    expect(markup(html)).not.toMatch(/<iframe/)
    expect(html).not.toContain('walls.io/')
  })

  it('the address screen escapes the value it puts back before the eyes', () => {
    // It comes from disk or from the command line: it has no business being able
    // to close the attribute carrying it.
    const html = renderHubAddressPage({ initialValue: 'http://hub"><script>x' })
    expect(html).toContain('value="http://hub&quot;&gt;&lt;script&gt;x"')
  })

  it('the address screen never gates "Continuer" on an answer from the hub', () => {
    // A control machine is prepared the day before, hub switched off: the probe
    // informs, it does not authorise. A button that could be disabled here would
    // be a failure on an event morning.
    const html = renderHubAddressPage({ initialValue: 'http://localhost:8787' })
    // The body alone: the Tailwind sheet, up top, speaks of `:disabled` for every
    // button in the application.
    const body = html.slice(html.indexOf('<body'))
    expect(body).toMatch(/<button[^>]*type="submit"/)
    expect(body).not.toMatch(/disabled/)
  })
})

/**
 * The old component sheet's classes, and why they come back.
 *
 * `.btn`, `.champ`, `.panneau` were this repository's idiom for the whole life of
 * the template pages. The sheet that defined them followed the control app, its
 * last reader — but the habit stays: adding a button to the hub address screen
 * and writing `class="btn"` gives a bare button, with no error raised.
 *
 * The guard is deliberately narrow. Its general form — every class laid down must
 * exist in the sheet — was tried: the projection page has its own `<style>` and a
 * dozen classes that serve only as a handle for its JavaScript, and they would
 * have had to be maintained by hand in a list. That is exactly the kind of list
 * that ends up missing something.
 */
const REMOVED_CLASSES = [
  'btn',
  'btn-onglet',
  'btn-petit',
  'champ',
  'inactif',
  'panneau',
  'titre-panneau',
  'touche',
]

describe('classes from the deleted component sheet', () => {
  it.each(PAGES)('%s: lays down none of them', (_name, html) => {
    const body = html.slice(html.indexOf('<body'))
    const laidDown = new Set<string>()
    for (const attribute of body.matchAll(/class="([^"]*)"/g)) {
      for (const name of attribute[1]!.split(/\s+/)) laidDown.add(name)
    }
    expect(REMOVED_CLASSES.filter((className) => laidDown.has(className))).toEqual([])
  })
})

describe('the hidden attribute is made to win', () => {
  /**
   * A trap met on the console: `[hidden] { display: none }` comes from the
   * browser's sheet, and the slightest author rule setting a `display` beats it.
   * The tabs did change the attribute, the screen did not move.
   */
  it.each(PAGES)('%s: neutralises any competing layout rule', (_name, html) => {
    expect(html).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/)
  })

  it('the overlay does carry a badge the rule has to neutralise', () => {
    // The category badge carries an `inline-block`: without the rule, `hidden`
    // would not hide it and a ghost category would show up on the VOD.
    // The real visibility check is in `effective-visibility`.
    expect(renderOverlayPage()).toMatch(/id="category"[^>]*hidden/)
  })
})
