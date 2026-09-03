import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '../src/server.js'

/**
 * The hub knows which event it is the hub of.
 *
 * What these tests protect is a property of the whole repository: **no surface
 * writes an event's name in hard**. The hub reads it from the imported program, a
 * setting can contradict it, and everything else — public wall, console, service
 * worker, room machines — consumes what it decided. Reintroducing a constant
 * somewhere would show up here.
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
  origin = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`
})

afterEach(async () => {
  await hub.close()
})

describe('event identity', () => {
  it('stays neutral for as long as no program is imported', () => {
    // A hub that has just been installed: it does not know yet where it is, and
    // saying so is better than displaying another event's name.
    expect(hub.services.identity.get()).toEqual({ name: 'Événement', shortName: 'Événement' })
  })

  it('is derived from the imported program, with nothing to set', () => {
    hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')

    // The single gesture to serve another event: import its export.
    expect(hub.services.identity.get()).toEqual({
      name: 'Cloud Nord 2026',
      shortName: 'Cloud Nord',
    })
  })

  it('follows the active program when going back to a version', () => {
    hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
    const other = JSON.parse(rawProgram) as { event: { name: string } }
    other.event.name = 'DevFest Lille 2027'
    hub.services.programs.importFromText(JSON.stringify(other), 'https://exemple/autre.json')

    expect(hub.services.identity.get().name).toBe('DevFest Lille 2027')
  })

  it('lets the hub setting contradict the upstream export', () => {
    hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
    hub.services.settings.update({ eventName: 'Cloud Nord — répétition' })

    expect(hub.services.identity.get().name).toBe('Cloud Nord — répétition')
    // And the derivation stays readable: it is what the console shows as a
    // placeholder, so that one dares to empty the field.
    expect(hub.services.identity.derived().name).toBe('Cloud Nord 2026')
  })
})

describe('surfaces served by the hub', () => {
  beforeEach(() => {
    hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  })

  it('titles the public wall with the event name', async () => {
    const html = await (await fetch(`${origin}/mur`)).text()

    // The first word read by someone who has just scanned a QR code: rendered
    // server side, not requested by the page — on a room's 4G it would arrive
    // after everything else.
    expect(html).toContain('<title>Cloud Nord 2026 — mur &amp; questions</title>')
  })

  it('titles the console with the event name', async () => {
    const html = await (await fetch(`${origin}/admin`)).text()

    expect(html).toContain('<title>Cloud Nord 2026 — console hub</title>')
  })

  it('gives its short name to the notifications service worker', async () => {
    // Some push services wake the worker with no readable payload: it is then the
    // only name it has to title the notice with.
    const code = await (await fetch(`${origin}/sw.js`)).text()

    expect(code).toContain('"Cloud Nord"')
  })

  it('follows a rename without restarting the hub', async () => {
    hub.services.settings.update({ eventName: 'Cloud Nord — répétition' })

    const html = await (await fetch(`${origin}/mur`)).text()
    expect(html).toContain('Cloud Nord — répétition')
    // The name gets corrected during the event; restarting for that is precisely
    // what cannot be done on the day. The service worker follows at the next page
    // load — the browser rechecks it every time, which is why it is served with no
    // cache.
    const code = await (await fetch(`${origin}/sw.js`)).text()
    // Short name unchanged: nothing to strip here, "répétition" is not a year.
    // The derivation is deliberately timid.
    expect(code).toContain('"Cloud Nord — répétition"')
  })

  it('escapes what it inserts into the HTML', async () => {
    hub.services.settings.update({ eventName: '<script>alert(1)</script>' })

    const html = await (await fetch(`${origin}/mur`)).text()
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('&lt;script&gt;')
  })
})
