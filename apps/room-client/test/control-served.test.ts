import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { normalizeProgram } from '@cloudnord/program'
import { AssetCache } from '../src/core/assets.js'
import { DisplayServer } from '../src/core/display-server.js'
import { LocalStore } from '../src/core/store.js'
import { RoomRuntime } from '../src/core/runtime.js'
import {
  developmentAssets,
  productionAssets,
  renderControlShell,
} from '../src/core/control-shell.js'

/**
 * The operator's window, served by the machine.
 *
 * What is checked here is not the rendering — that is checked in
 * `@cloudnord/control-web`, which mounts the components — but the two things only
 * the room machine can guarantee: that the page leaves with the complete state
 * inside it, and that it asks nothing of any origin but its own.
 */

const program = normalizeProgram(
  JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url),
      ),
      'utf8',
    ),
  ),
)

const TRACK_1 = 'track-1-teilhard-de-chardin'

let dir: string
let store: LocalStore
let server: DisplayServer
let origin: string

/**
 * A room machine, with no bundle by default.
 *
 * `controlBundle` is passed explicitly everywhere: the real resolution walks up
 * the folders to a `dist/`, and a build left on the machine would make these
 * tests pass or fail depending on the machine. The defect is discovered in CI,
 * once, and nobody can say how long it had lasted.
 */
async function start(
  options: {
    viteOrigin?: string | null
    controlBundle?: () => { directory: string; manifest: string } | null
  } = {},
): Promise<void> {
  const runtime = new RoomRuntime(store, {}, () => Date.parse('2026-10-30T10:20:00.000Z'))
  runtime.setRoomId(TRACK_1)
  runtime.setProgram('hash-1', program)
  server = new DisplayServer({
    runtime,
    assets: new AssetCache(store, join(dir, 'assets')),
    program: () => store.activeProgram(),
    roomName: () => 'Track #1 — Teilhard de Chardin',
    event: () => ({ name: 'Cloud Nord 2026', shortName: 'Cloud Nord' }),
    port: 0,
    controlBundle: () => null,
    ...options,
  })
  origin = await server.listen()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-regie-'))
  store = new LocalStore(':memory:')
  store.saveProgram('hash-1', program)
})

afterEach(async () => {
  await server.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('the shell', () => {
  it('renders the bundle\'s entry point, and no longer the template', async () => {
    await start({ viteOrigin: 'http://127.0.0.1:5174' })

    const response = await fetch(`${origin}/regie`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain('id="regie-root"')
    /*
     * The old page inlined everything: the sheet frozen into a `<style>`, the
     * state machine and three thousand lines of code in two `<script>` tags, and
     * the markup of the seven modals. None of that must ship any more — what is
     * left is the shell, the room's state, and tags pointing at files served by
     * this same machine.
     */
    expect(html).not.toContain('<style>')
    expect(html).not.toContain('id="vod-dialog"')
    // The embedded state now dominates the page, and that is the point.
    const boot = /<script id="etat-initial"[^>]*>(.*?)<\/script>/s.exec(html)![1]!
    expect(html.length - boot.length).toBeLessThan(1_500)
  })

  it('renders a complete and closed document', async () => {
    // Taken over from the template pages' guards: a truncated shell still
    // rendered, in part, and the defect showed on screen with nobody knowing
    // where it came from.
    await start({ viteOrigin: 'http://127.0.0.1:5174' })
    const html = await (await fetch(`${origin}/regie`)).text()

    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
  })

  it('embeds the complete state, because an F5 always lands mid-talk', async () => {
    await start({ viteOrigin: 'http://127.0.0.1:5174' })

    const html = await (await fetch(`${origin}/regie`)).text()
    const raw = /<script id="etat-initial" type="application\/json">(.*?)<\/script>/s.exec(html)
    const boot = JSON.parse(raw![1]!.replace(/\\u003c/g, '<')) as { roomName: string }

    // Waiting for the stream's first message to paint anything would give half a
    // second of blank screen at the exact moment the operator has just lost
    // their window.
    expect(boot.roomName).toBe('Track #1 — Teilhard de Chardin')
  })

  it('never lets itself be cached: it carries the room\'s state', async () => {
    await start({ viteOrigin: 'http://127.0.0.1:5174' })
    const response = await fetch(`${origin}/regie`)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('serves the bundle\'s hashed files, and lets them be cached', async () => {
    const bundle = fakeBundle()
    await start({ controlBundle: () => bundle })

    const html = await (await fetch(`${origin}/regie`)).text()
    expect(html).toContain('src="/regie/assets/index-abc123.js"')
    expect(html).toContain('href="/regie/assets/index-def456.css"')

    const asset = await fetch(`${origin}/regie/assets/index-abc123.js`)
    expect(asset.status).toBe(200)
    /*
     * The names carry a fingerprint, hence `immutable`: the control app is
     * reopened several times a day on a room machine, and nothing justifies
     * reading the same megabyte again every time.
     */
    expect(asset.headers.get('cache-control')).toContain('immutable')
  })

  it('says what to do when the bundle is missing, rather than returning a 404', async () => {
    await start()

    const response = await fetch(`${origin}/regie`)

    // This is not an operational state: the packaging embeds the bundle. A 404
    // would send people looking at the address instead.
    expect(response.status).toBe(503)
    expect(await response.text()).toContain('pnpm --filter @cloudnord/control-web build')
  })
})

describe('development', () => {
  it('points the shell at Vite, and proxies what Vite can render', async () => {
    /*
     * The proxy's direction is forced: it is the machine that carries the state
     * stream, the actions and the VU meter, all on its own origin. Putting Vite in
     * front would mean proxying an SSE stream and an OBS WebSocket for the sole
     * comfort of hot reloading.
     */
    const vite = Fastify({ logger: false })
    vite.get('/regie/src/main.ts', async (_request, reply) => {
      reply.header('content-type', 'text/javascript')
      return reply.send('// servi par Vite')
    })
    const viteAddress = await vite.listen({ host: '127.0.0.1', port: 0 })

    try {
      await start({ viteOrigin: viteAddress })

      const html = await (await fetch(`${origin}/regie`)).text()
      expect(html).toContain('src="/regie/@vite/client"')
      expect(html).toContain('src="/regie/src/main.ts"')

      // And the machine really serves what Vite gives it, on its own origin.
      const module = await fetch(`${origin}/regie/src/main.ts`)
      expect(module.status).toBe(200)
      expect(await module.text()).toBe('// servi par Vite')
    } finally {
      await vite.close()
    }
  })

  it('keeps the shell to itself, even behind the proxy', async () => {
    // It carries the embedded state: leaving it to the proxy would render the
    // page Vite serves from `index.html`, with no state inside.
    const vite = Fastify({ logger: false })
    vite.get('/regie', async (_request, reply) => reply.send('coquille de Vite'))
    const viteAddress = await vite.listen({ host: '127.0.0.1', port: 0 })

    try {
      await start({ viteOrigin: viteAddress })
      const html = await (await fetch(`${origin}/regie`)).text()
      expect(html).toContain('id="etat-initial"')
      expect(html).not.toContain('coquille de Vite')
    } finally {
      await vite.close()
    }
  })

  it('prefers Vite over the built bundle when both are there', async () => {
    const bundle = fakeBundle()
    await start({ controlBundle: () => bundle, viteOrigin: 'http://127.0.0.1:1' })

    /*
     * The reverse order looked more careful — an installed machine has no Vite, a
     * stray variable must not divert it — and it made development impossible.
     * `pnpm test` builds the bundle: a three-day-old `dist/` then took precedence
     * over the running server. One developed against a compiled control app, with
     * no hot reload, and the Vue extension refused to inspect a page it saw as
     * being in production mode.
     *
     * A `dist/` is an artefact; a Vite origin is an intention.
     */
    const html = await (await fetch(`${origin}/regie`)).text()
    expect(html).toContain('@vite/client')
    expect(html).not.toContain('/regie/assets/index-abc123.js')
  })

  it('serves the bundle as soon as no Vite origin is announced', async () => {
    // The installed machine's case: the variable is never set there.
    const bundle = fakeBundle()
    await start({ controlBundle: () => bundle })

    const html = await (await fetch(`${origin}/regie`)).text()
    expect(html).toContain('/regie/assets/index-abc123.js')
    expect(html).not.toContain('@vite/client')
  })
})

describe('the page\'s self-sufficiency', () => {
  it('references no resource outside its own origin', () => {
    const html = renderControlShell({
      initialPayload: { roomName: 'Track #1' } as never,
      assets: productionAssets(temporaryManifest()),
      eventName: 'Cloud Nord 2026',
    })

    /*
     * The invariant, in the shape it took on the console: no resource outside the
     * served origin. It weighs more here — the room machine sometimes runs with no
     * network at all.
     */
    for (const url of [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((trouve) => trouve[1]!)) {
      expect(url.startsWith('/')).toBe(true)
    }
  })

  it('gives Vite the same prefix, so development does not cheat', () => {
    const assets = developmentAssets()
    for (const url of [...assets.scripts, ...assets.styles]) {
      expect(url.startsWith('/regie/')).toBe(true)
    }
  })

  it('titles the window with the event, which is no constant of the binary', () => {
    const html = renderControlShell({
      initialPayload: {} as never,
      assets: { scripts: [], styles: [] },
      eventName: 'Cloud Nord 2027',
    })

    // The same machine will serve next year's edition, and the window bar is the
    // first place a stale name gets noticed.
    expect(html).toContain('<title>Régie — Cloud Nord 2027</title>')
  })

  it('escapes anything that could close the state script tag', () => {
    const html = renderControlShell({
      initialPayload: { roomName: '</script><script>alert(1)</script>' } as never,
      assets: { scripts: [], styles: [] },
    })

    // A room's name comes from the hub, not from the machine: it has no business
    // in the grammar of the page carrying it.
    expect(html).not.toContain('</script><script>alert(1)')
    expect(html).toContain('\\u003c/script>')
  })
})

/** A minimal Vite manifest, to read the assets without building the bundle. */
function temporaryManifest(): string {
  const folder = join(dir, '.vite')
  mkdirSync(folder, { recursive: true })
  const path = join(folder, 'manifest.json')
  writeFileSync(
    path,
    JSON.stringify({
      'index.html': { file: 'assets/index-abc123.js', css: ['assets/index-def456.css'] },
    }),
  )
  return path
}

/** The same, with the files behind it: enough to serve for real. */
function fakeBundle(): { directory: string; manifest: string } {
  const manifest = temporaryManifest()
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'export const rien = 0\n')
  writeFileSync(join(dir, 'assets', 'index-def456.css'), '.rien{}\n')
  return { directory: dir, manifest }
}
