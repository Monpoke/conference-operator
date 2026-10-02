import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '../src/server.js'
import { provisionOperator } from '../src/operators.js'
import { hallUrgentMessage } from '../src/pages/boucle-preview.js'
import { redactSecrets } from '../src/router.js'

/**
 * Urgent messages, the public wall and questions switches, and the screens'
 * messages coming back up — over HTTP, as the console calls them: the right and
 * the proof are checked by the router, which a service call would bypass.
 */

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const ADMIN = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'control-password-2026' }
const MOBILE = { email: 'mobile@cloudnord.fr', name: 'Mobile', password: 'mobile-password-2026' }
const TRACK_1 = 'track-1-teilhard-de-chardin'

let hub: Hub
let origin: string
let adminToken: string

async function rpc(path: string, input: unknown, token: string | null = adminToken) {
  const response = await fetch(`${origin}/rpc/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token != null ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ json: input }),
  })
  return { status: response.status, body: (await response.json()) as { json?: unknown } }
}

async function signIn(account: { email: string; password: string }): Promise<string> {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: account.email, password: account.password }),
  })
  return ((await response.json()) as { token: string }).token
}

const urgent = { roomId: TRACK_1, text: 'Évacuez par la sortie B', level: 'urgent', target: 'audience', ttlSeconds: null }

let seq = 0
/** A `screen.message` event, as a room's outbox would deliver it. */
function screenEvent(roomId: string, payload: Record<string, unknown>, occurredAt = new Date().toISOString()) {
  seq += 1
  return {
    id: `01HZZZZZZZZZZZZZZZZZZZZZ${String(seq).padStart(2, '0')}`,
    roomId,
    seq,
    occurredAt,
    monotonicMs: seq * 1000,
    delivery: 'required' as const,
    payload: { type: 'screen.message', ...payload },
  }
}

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

  await provisionOperator(hub.auth, ADMIN)
  await provisionOperator(hub.auth, { ...MOBILE, roles: ['regieMobile'] })
  const snapshot = hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  hub.services.rooms.ensureFromTracks(snapshot.program.rooms)
  adminToken = await signIn(ADMIN)
  seq = 0
})

afterEach(async () => {
  await hub.close()
})

describe('an urgent message', () => {
  it('asks the password again, and refuses a wrong one', async () => {
    expect((await rpc('messages/urgentProof', undefined)).body.json).toEqual({ method: 'password', fresh: false })

    expect((await rpc('messages/send', urgent)).status).toBe(403)
    expect((await rpc('messages/send', { ...urgent, password: 'not-it' })).status).toBe(403)
    expect((await rpc('messages/send', { ...urgent, password: ADMIN.password })).status).toBe(200)
  })

  it('never writes the password down in the audit log', async () => {
    await rpc('messages/send', { ...urgent, password: ADMIN.password })
    const entry = hub.services.audit.list().find((item) => item.action === 'messages.send')
    expect(entry?.detail ?? '').not.toContain(ADMIN.password)
    expect(redactSecrets({ pin: '4821', password: 'x', text: 'ok' })).toEqual({ pin: '•••', password: '•••', text: 'ok' })
  })

  it('takes its own right: sending messages is not enough', async () => {
    const mobile = await signIn(MOBILE)
    const refused = await rpc('messages/send', { ...urgent, password: MOBILE.password }, mobile)
    expect(refused.status).toBe(403)
    expect(JSON.stringify(refused.body)).toContain('message:urgent')
    // An ordinary message still goes.
    expect((await rpc('messages/send', { ...urgent, level: 'info' }, mobile)).status).toBe(200)
  })

  it('confirms an urgent banner the same way', async () => {
    const banner = { roomId: TRACK_1, message: { text: 'Évacuation', level: 'urgent' }, ttlSeconds: null }
    expect((await rpc('overlay/show', banner)).status).toBe(403)
    expect((await rpc('overlay/show', { ...banner, password: ADMIN.password })).status).toBe(200)
  })
})

describe('the control app PIN', () => {
  it('is stored hashed, apart from the settings, and only its presence is shown', async () => {
    expect((await rpc('settings/urgentPin/status', undefined)).body.json).toEqual({ set: false })
    expect((await rpc('settings/urgentPin/set', { pin: '12' })).status).toBe(400)

    expect((await rpc('settings/urgentPin/set', { pin: '4821' })).body.json).toEqual({ set: true })
    expect((await rpc('settings/urgentPin/status', undefined)).body.json).toEqual({ set: true })
    expect(hub.services.settings.urgentPinHash()).toMatch(/^scrypt\$16384\$/)
    expect(JSON.stringify((await rpc('settings/get', undefined)).body)).not.toContain('scrypt')

    await rpc('settings/urgentPin/set', { pin: null })
    expect(hub.services.settings.urgentPinHash()).toBeNull()
  })
})

describe('the public wall and the questions switches', () => {
  it('refuses the wall once off, and leaves the questions', async () => {
    await rpc('settings/update', { wallEnabled: false })
    expect((await rpc('wall/post', { author: 'A', text: 'Bonjour', roomId: null }, null)).status).toBe(403)
    expect((await rpc('wall/recent', { limit: 10 }, null)).status).toBe(403)
    expect((await rpc('questions/list', { roomId: TRACK_1, sessionId: null }, null)).status).toBe(200)

    const page = await (await fetch(`${origin}/mur`)).text()
    // Only the questions left: no tab bar, the page opens on them.
    expect(page).toContain('"wall":false')
    expect(page).toMatch(/<div class="tabs[^"]*"[^>]* hidden>/)
  })

  it('closes the page when both are off', async () => {
    await rpc('settings/update', { wallEnabled: false, questionsEnabled: false })
    expect((await rpc('questions/post', { roomId: TRACK_1, sessionId: null, author: null, text: 'Une question ?' }, null)).status).toBe(403)
    const page = await (await fetch(`${origin}/mur`)).text()
    expect(page).toContain('data-role="closed"')
    expect(page).not.toContain('form-message')
  })

  it('tells every console view, without settings:read', async () => {
    await rpc('settings/update', { questionsEnabled: false })
    const mobile = await signIn(MOBILE)
    expect(((await rpc('event/identity', undefined, mobile)).body.json as { features: unknown }).features).toEqual({
      wall: true,
      questions: false,
    })
  })
})

describe("taking a screen's message down from the console", () => {
  it('sends the room a removal, short-lived, signed by its author', async () => {
    expect((await rpc('messages/clear', { roomId: TRACK_1 })).status).toBe(200)
    expect((await rpc('messages/clear', { roomId: 'nowhere' })).status).toBe(404)
    const backlog = hub.services.commands.backlog(TRACK_1, 0)
    expect(backlog.at(-1)).toMatchObject({
      ttlSeconds: 60,
      payload: { type: 'message.clear', from: ADMIN.email },
    })
  })
})

describe('the room screens, reported back', () => {
  it('shows what each screen says now, and the log of what they said', async () => {
    const later = new Date(Date.now() + 10 * 60_000).toISOString()
    hub.services.ingest.push(TRACK_1, [
      screenEvent(TRACK_1, { action: 'shown', text: 'Pause café', level: 'info', expiresAt: null, source: 'regie' }),
      screenEvent(TRACK_1, { action: 'cleared', text: null, level: null, expiresAt: null, source: null }),
      screenEvent(TRACK_1, { action: 'shown', text: 'Micro HS', level: 'warning', expiresAt: later, source: 'regie' }),
    ])

    const { current, log } = (await rpc('messages/screens', { limit: 10 })).body.json as {
      current: { roomId: string; text: string; roomName: string | null }[]
      log: { action: string }[]
    }
    expect(current).toHaveLength(1)
    expect(current[0]).toMatchObject({ roomId: TRACK_1, text: 'Micro HS' })
    expect(current[0]!.roomName).not.toBeNull()
    expect(log.map((entry) => entry.action)).toEqual(['shown', 'cleared', 'shown'])
  })

  it('drops an expired message from what is on screen', async () => {
    const past = new Date(Date.now() - 60_000).toISOString()
    hub.services.ingest.push(TRACK_1, [
      screenEvent(TRACK_1, { action: 'shown', text: 'Vieux', level: 'info', expiresAt: past, source: 'hub' }),
    ])
    expect(((await rpc('messages/screens', { limit: 10 })).body.json as { current: unknown[] }).current).toEqual([])
  })

  it('relays what is urgent to the hall screen, saying where', () => {
    const rooms = hub.services.rooms.list()
    expect(hallUrgentMessage(hub.services)).toBeNull()

    hub.services.ingest.push(TRACK_1, [
      screenEvent(TRACK_1, { action: 'shown', text: 'Évacuez', level: 'urgent', expiresAt: null, source: 'regie' }),
    ])
    const one = hallUrgentMessage(hub.services)
    expect(one?.text).toBe(`${rooms.find((room) => room.id === TRACK_1)!.name} — Évacuez`)

    // The same text in every room: sent to the whole event, said once.
    for (const room of rooms.filter((candidate) => candidate.id !== TRACK_1)) {
      hub.services.ingest.push(room.id, [
        screenEvent(room.id, { action: 'shown', text: 'Évacuez', level: 'urgent', expiresAt: null, source: 'hub' }),
      ])
    }
    expect(hallUrgentMessage(hub.services)?.text).toBe('Évacuez')
  })
})
