// @vitest-environment node
//
// A node environment, and not happy-dom: this test reads a file from the
// repository, and happy-dom cannot turn `import.meta.url` into a file path. It
// examines no component, so it needs no DOM.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { consolePaths, consoleViews, viewPath } from '@conference-operator/contract'

/**
 * The console's addresses, and what serves them.
 *
 * Two invariants, and neither is visible when reading a view.
 */

const ROUTER = readFileSync(fileURLToPath(new URL('../src/router.ts', import.meta.url)), 'utf8')

describe('development views', () => {
  it('do not exist in production', () => {
    // The code that moves the whole system's clock, and the one that erases the
    // footage: the hub does not serve their address outside dev mode.
    expect(consoleViews(false)).not.toContain('developpement')
    expect(consoleViews(true)).toContain('developpement')
    expect(consolePaths(false)).not.toContain(viewPath('developpement'))
  })

  it('do not enter the bundle served on the day', () => {
    /*
     * The second lock, and the one a refactor can undo without a sound.
     *
     * `consoleViews(dev)` stops the hub *serving* the address; it does not stop the
     * code travelling. A static `import` would bring it into the production bundle,
     * one `fetch` away from whoever inspects the page — and nothing would say so,
     * since the view would stay unreachable.
     *
     * The test reads the router's source rather than Vite's output: it then needs
     * no build, and therefore runs on every `pnpm test`.
     */
    expect(ROUTER).toMatch(/component:\s*\(\)\s*=>\s*import\(['"]\.\/views\/DevelopmentView\.vue['"]\)/)
    expect(ROUTER).not.toMatch(/^import .*DevelopmentView/m)
    expect(ROUTER).not.toMatch(/^import .*stores\/dev/m)
  })
})

describe('served addresses', () => {
  it('covers every view of the mode, leaving none behind', () => {
    // The hub registers one route per view rather than an `/admin/*` wildcard: a
    // view added without its address would answer 404 with nothing to say so.
    for (const view of consoleViews(true)) {
      expect(consolePaths(true), view).toContain(viewPath(view))
    }
  })
})
