import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  developmentAssets,
  productionAssets,
  renderConsoleShell,
} from '../src/pages/console-shell.js'

/**
 * The shell that loads the console's bundle.
 *
 * The hub serves a bundle but always renders the page that loads it, and that is
 * what these tests hold: three things must be known to the console before its
 * first network call, and a single rule governs its tags.
 */

const IDENTITY = { name: 'Cloud Nord 2026', shortName: 'Cloud Nord' }

function shell(overrides: Partial<Parameters<typeof renderConsoleShell>[0]> = {}): string {
  return renderConsoleShell({
    mode: 'production',
    event: IDENTITY as never,
    google: null,
    assets: { scripts: ['/admin/assets/index-abc.js'], styles: ['/admin/assets/index-abc.css'] },
    ...overrides,
  })
}

describe('console shell', () => {
  it('references nothing outside its own origin', () => {
    /**
     * The invariant, restated — and this is the only place where it is checked.
     *
     * The old rule forbade any `src` or `href` tag, for a reason written in
     * black and white: "a tag pointing at a CDN would break the page on the
     * first outage". What that reason targets is the network, not the tag. An
     * asset served by the hub itself cannot disappear because the event's
     * network is cut — but an asset served by someone else can. Hence: every
     * `src`, every `href`, relative.
     */
    const html = shell()
    for (const url of [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((t) => t[1] as string)) {
      expect(url.startsWith('/'), url).toBe(true)
    }
  })

  it('embeds enough to display before the first call', () => {
    const html = shell({ mode: 'dev', google: { domain: 'cloudnord.fr' } })
    const boot = JSON.parse(
      /<script id="console-boot" type="application\/json">(.*?)<\/script>/s.exec(html)![1]!,
    ) as { mode: string; event: { name: string }; google: { domain: string } | null }

    // The event's name: the first word read, and waiting for it from a round trip
    // would make it appear after the rest.
    expect(boot.event.name).toBe('Cloud Nord 2026')
    // The mode: without it the console does not know whether the development view
    // exists, and deciding it in the browser would put the code that moves
    // everyone's clock into the production bundle.
    expect(boot.mode).toBe('dev')
    // The Google button is only offered if the hub knows how to use it.
    expect(boot.google).toEqual({ domain: 'cloudnord.fr' })
  })

  it('does not let an identity close the tag that carries it', () => {
    const html = renderConsoleShell({
      mode: 'production',
      event: { name: '</script><script>alert(1)</script>', shortName: 'x' } as never,
      google: null,
      assets: { scripts: [], styles: [] },
    })
    expect(html).not.toContain('<script>alert(1)</script>')
  })

  it('reads the hashed names from the manifest rather than guessing them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cn-spa-'))
    mkdirSync(join(directory, '.vite'))
    const manifest = join(directory, '.vite', 'manifest.json')
    writeFileSync(
      manifest,
      JSON.stringify({
        'index.html': { file: 'assets/index-XYZ.js', css: ['assets/index-XYZ.css'], isEntry: true },
      }),
    )

    // The fingerprints are what makes `immutable` safe, hence what removes the
    // 45 kB of CSS re-downloaded on every navigation.
    expect(productionAssets(manifest)).toEqual({
      scripts: ['/admin/assets/index-XYZ.js'],
      styles: ['/admin/assets/index-XYZ.css'],
    })
  })

  it('says what is missing when the manifest carries no entry', () => {
    const directory = mkdtempSync(join(tmpdir(), 'cn-spa-'))
    const manifest = join(directory, 'manifest.json')
    writeFileSync(manifest, JSON.stringify({}))

    expect(() => productionAssets(manifest)).toThrow(/index\.html/)
  })

  it('goes through the Vite server in development, building nothing', () => {
    expect(developmentAssets().scripts).toEqual(['/admin/@vite/client', '/admin/src/main.ts'])
  })
})
