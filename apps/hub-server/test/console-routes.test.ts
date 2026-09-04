import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { consolePaths } from '@cloudnord/contract'
import { createHub, type Hub } from '../src/server.js'
import { resolveConsoleBundle } from '../src/pages/console-shell.js'

/**
 * What the hub serves on the addresses claimed by the bundle.
 *
 * The test describes **both** situations, because both really exist: the console
 * is built in the image, it is not in continuous integration — `dist/` is not
 * versioned and `pnpm test` triggers no Vite build, which is precisely what keeps
 * the suite inside the minute it claims.
 *
 * Making these assertions depend on whether an artifact is built would make them
 * unmanageable; writing them for both says what the hub promises in each.
 */

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

let hub: Hub
let origin: string

beforeEach(async () => {
  hub = await createHub({
    port: 0,
    host: '127.0.0.1',
    databasePath: ':memory:',
    publicUrl: 'http://127.0.0.1',
    authSecret: 'test-secret-'.padEnd(48, 'x'),
    logLevel: 'fatal',
  })
  await hub.app.listen({ port: 0, host: '127.0.0.1' })
  const address = hub.app.server.address()
  const port = typeof address === 'object' && address != null ? address.port : 0
  origin = `http://127.0.0.1:${port}`
  hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
})

afterEach(async () => {
  await hub.close()
})

describe('addresses claimed by the bundle', () => {
  it('serves at least one', () => {
    // A guard for the guard: an empty list would let everything below pass
    // without exercising anything.
    expect(consolePaths(false).length).toBeGreaterThan(0)
  })

  it('answers, whatever the state of the bundle', async () => {
    for (const path of consolePaths(false)) {
      const response = await fetch(`${origin}${path}`)
      // Never a 404 and never a 503: the address exists, and there is always
      // something to serve — the shell if the bundle is there, the template
      // otherwise.
      expect(response.status, path).toBe(200)
    }
  })

  it('serves the shell when the bundle is built, the template otherwise', async () => {
    const bundle = resolveConsoleBundle()
    const path = consolePaths(false)[0]!
    const html = await (await fetch(`${origin}${path}`)).text()

    if (bundle == null) {
      /*
       * The fallback is not a consolation: the template still exists and works.
       * Refusing to serve because an artifact is missing would punish operations
       * for a build defect, when there is a perfectly usable console at hand.
       */
      expect(html).toContain('console hub')
    } else {
      expect(html).toContain('id="console-boot"')
      // The fingerprint in the name: it is what makes `immutable` safe on the
      // assets side.
      expect(html).toMatch(/src="\/admin\/assets\/[^"]+\.js"/)
    }
  })

  it('never caches the shell', async () => {
    const path = consolePaths(false)[0]!
    const response = await fetch(`${origin}${path}`)
    if (resolveConsoleBundle() != null) {
      // An updated console that never is on an operator's machine is worse than
      // re-downloading it on every opening.
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
  })
})

/**
 * The mobile control app, served by the hub.
 *
 * Two addresses, and the gap between them is what counts: `/regie` picks a room,
 * `/regie/<id>` drives one. They are **enumerated** like the console's, never
 * taken by a wildcard — `/regie/assets/…` must reach the files, not render the
 * shell in their place.
 *
 * As for the console, both situations are described: the bundle is built in the
 * image, it is not in continuous integration.
 */
describe('the mobile control app', () => {
  it('answers on both addresses', async () => {
    for (const path of ['/regie', '/regie/track-1-teilhard-de-chardin']) {
      const response = await fetch(`${origin}${path}`)
      /*
       * 200 with the bundle, 503 without — and never a 404.
       *
       * The absence of a bundle is not an operational state: the image builds it,
       * so it signals an incomplete deployment. A 404 would send one looking at
       * the address, which is the only thing that is fine.
       */
      expect([200, 503], path).toContain(response.status)
      if (response.status === 503) {
        expect(await response.text()).toContain('pnpm --filter @cloudnord/control-web build')
      }
    }
  })

  it('does not resolve the room before rendering the page', async () => {
    /*
     * The shell is public, like the console's: it is the first oRPC call that
     * demands a session. Refusing here would return a 404 to someone who is not
     * signed in yet, which reads as a dead address.
     */
    const response = await fetch(`${origin}/regie/ghost-room`)
    expect(response.status).not.toBe(404)
  })

  it('embeds the scope and the rooms, never a room\'s state', async () => {
    const response = await fetch(`${origin}/regie`)
    if (response.status !== 200) return
    const html = await response.text()

    // `regie-portee` and `portee`/`distante` are contract names and values.
    expect(html).toContain('id="regie-portee"')
    expect(html).toContain('"portee":"distante"')
    /*
     * No `#etat-initial` here, and that is deliberate.
     *
     * The room machine inlines its whole state because an F5 lands in the middle
     * of a talk and its window drives the video projector. A phone that drives
     * nothing until someone has taken the room does not have that argument — and
     * embedding it would require resolving the operator before rendering the page.
     */
    expect(html).not.toContain('id="etat-initial"')
  })

  it('references no resource outside its own origin', async () => {
    const response = await fetch(`${origin}/regie`)
    if (response.status !== 200) return
    const html = await response.text()
    /*
     * The same invariant as the console and the display pages, in the shape it
     * has taken: every `src` and every `href` is relative. An asset served by the
     * process that already serves the page cannot disappear because the event's
     * network is cut; any other origin can.
     */
    expect(html).not.toMatch(/(?:src|href)="https?:\/\//)
  })

  it('never caches the shell', async () => {
    const response = await fetch(`${origin}/regie/track-1-teilhard-de-chardin`)
    if (response.status !== 200) return
    // It carries the scope boot payload, and the room it names changes from one
    // address to the next.
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})
