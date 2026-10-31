import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Session } from '@conference-operator/program'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { speakerView } from '../src/pages/speaker-page.js'
import { createHub, type Hub } from '../src/server.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)
const TRACK_1 = 'track-1-teilhard-de-chardin'
const MINUTE = 60_000
const START = 1_000 * MINUTE

function talk(id: string, startsAtMs: number, endsAtMs: number): Session {
  return {
    id,
    title: `Talk ${id}`,
    kind: 'talk',
    speakers: [{ name: `Orateur ${id}` }],
    startsAtMs,
    endsAtMs,
    durationMinutes: null,
  } as unknown as Session
}

const FIRST = talk('a', START, START + 45 * MINUTE)
const SECOND = talk('b', START + 60 * MINUTE, START + 105 * MINUTE)
const SESSIONS = [FIRST, SECOND]

describe('the speaker timer', () => {
  it('counts towards the start before the slot', () => {
    const view = speakerView(SESSIONS, START - 10 * MINUTE, {}, null)
    expect(view.talk?.title).toBe('Talk a')
    expect(view.targetMs).toBe(START)
    expect(view.beforeStart).toBe(true)
  })

  it('counts towards the end during the slot, and names what follows', () => {
    const view = speakerView(SESSIONS, START + 5 * MINUTE, { a: 'running' }, null)
    expect(view.talk?.speakers).toEqual(['Orateur a'])
    expect(view.targetMs).toBe(FIRST.endsAtMs)
    expect(view.beforeStart).toBe(false)
    expect(view.next?.title).toBe('Talk b')
  })

  it('keeps an overrunning talk, so the timer goes past zero', () => {
    const now = START + 50 * MINUTE
    const view = speakerView(SESSIONS, now, { a: 'running' }, null)
    expect(view.talk?.title).toBe('Talk a')
    expect(view.targetMs).toBeLessThan(now)
    expect(view.beforeStart).toBe(false)
  })

  it('counts towards the end of a talk started early', () => {
    const view = speakerView(SESSIONS, START - 5 * MINUTE, { a: 'running' }, 'a')
    expect(view.targetMs).toBe(FIRST.endsAtMs)
    expect(view.beforeStart).toBe(false)
  })

  it('moves on to the next talk once this one has ended', () => {
    const view = speakerView(SESSIONS, START + 40 * MINUTE, { a: 'ended' }, null)
    expect(view.talk?.title).toBe('Talk b')
    expect(view.targetMs).toBe(SECOND.startsAtMs)
    expect(view.beforeStart).toBe(true)
  })

  it('has nothing to count after the last talk', () => {
    const view = speakerView(SESSIONS, START + 200 * MINUTE, { a: 'ended', b: 'ended' }, null)
    expect(view.talk).toBeNull()
    expect(view.targetMs).toBeNull()
  })
})

describe('the speaker page', () => {
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
    hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  })

  afterEach(async () => {
    await hub.close()
  })

  it('is served without a session, with its state embedded and nothing remote', async () => {
    const response = await fetch(`${origin}/orateur/${TRACK_1}`)
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(html).toContain(`/orateur/${TRACK_1}/etat`)
    expect(html).toContain('id="donnees"')
    expect(html).not.toMatch(/(src|href)="https?:/)
  })

  it('serves the state on the hub clock, never cached', async () => {
    const response = await fetch(`${origin}/orateur/${TRACK_1}/etat`)
    const body = (await response.json()) as { serverTimeMs: number; view: unknown }

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(body.serverTimeMs).toBeLessThanOrEqual(hub.services.clock.now())
    expect(body.view).toHaveProperty('talk')
  })

  it('answers 404 for a room nobody knows', async () => {
    expect((await fetch(`${origin}/orateur/inventee`)).status).toBe(404)
    expect((await fetch(`${origin}/orateur/inventee/etat`)).status).toBe(404)
  })
})
