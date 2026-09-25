import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AUDIT_RETENTION_DAYS, type AuditEntry } from '@conference-operator/contract'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHub, type Hub } from '../src/server.js'
import { provisionOperator } from '../src/operators.js'
import { describe as describeRequest } from '../src/services/audit.js'

/**
 * The audit log: who did what through the hub, and what came of it.
 *
 * Exercised over HTTP, as the console and the phones call it: the entries are
 * written by the router's guard, which a service call would bypass.
 */

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'control-password-2026' }
const MOBILE = { email: 'mobile@cloudnord.fr', name: 'Mobile', password: 'mobile-password-2026' }
const TRACK_1 = 'track-1-teilhard-de-chardin'
const PHONE = 'session-phone'

let hub: Hub
let origin: string
let operatorToken: string

async function rpc(path: string, input: unknown, token = operatorToken, session?: string) {
  const response = await fetch(`${origin}/rpc/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(session != null ? { 'x-regie-session': session } : {}),
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

const entries = (): AuditEntry[] => hub.services.audit.list()

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

  await provisionOperator(hub.auth, OPERATOR)
  await provisionOperator(hub.auth, { ...MOBILE, roles: ['regieMobile'] })
  const snapshot = hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  hub.services.rooms.ensureFromTracks(snapshot.program.rooms)
  operatorToken = await signIn(OPERATOR)
})

afterEach(async () => {
  await hub.close()
})

describe('what gets written down', () => {
  it('writes a phone gesture down, then the room completes it with its word', async () => {
    await rpc('regie/hold', { roomId: TRACK_1, force: false }, operatorToken, PHONE)
    const sent = await rpc(
      'regie/command',
      { roomId: TRACK_1, action: { type: 'scene.set', role: 'LIVE' } },
      operatorToken,
      PHONE,
    )
    const seq = (sent.body.json as { seq: number }).seq

    const [command, hold] = entries()
    expect(hold).toMatchObject({ actor: OPERATOR.email, action: 'regie.hold', roomId: TRACK_1, ok: true })
    expect(command).toMatchObject({
      actor: OPERATOR.email,
      action: 'regie.command',
      roomId: TRACK_1,
      ok: true,
      commandSeq: seq,
      outcome: null,
    })
    expect(command!.detail).toContain('scene.set')

    // The room reports OBS refused it.
    hub.services.ingest.push(TRACK_1, [
      {
        id: '01HZZZZZZZZZZZZZZZZZZZZZZZ',
        roomId: TRACK_1,
        seq: 1,
        occurredAt: new Date().toISOString(),
        monotonicMs: 1000,
        delivery: 'best-effort',
        payload: {
          type: 'room.heartbeat',
          connectivity: 'ONLINE',
          sceneRole: null,
          recording: false,
          streaming: false,
          outboxDepth: 0,
          programContentHash: null,
          lastCommand: { seq, ok: false, message: "OBS-A n'est pas connecté" },
        },
      },
    ])

    expect(entries()[0]!.outcome).toMatchObject({ ok: false, message: "OBS-A n'est pas connecté" })
  })

  it('writes down a gesture the hub refused, and why', async () => {
    // Nobody holds the room: the gesture is refused, and that is what one looks for afterwards.
    const refused = await rpc('regie/command', { roomId: TRACK_1, action: { type: 'display.set', mode: 'sponsors' } })
    expect(refused.status).toBeGreaterThanOrEqual(400)

    expect(entries()[0]).toMatchObject({ action: 'regie.command', ok: false, commandSeq: null })
    expect(entries()[0]!.error).not.toBeNull()
  })

  it('writes down a permission the operator lacks', async () => {
    const mobile = await signIn(MOBILE)
    const refused = await rpc('clock/set', { at: null }, mobile)
    expect(refused.status).toBe(403)

    expect(entries()[0]).toMatchObject({ actor: MOBILE.email, action: 'clock.set', ok: false })
  })

  it('leaves the reads out, even behind a write permission', async () => {
    await rpc('regie/view', { roomId: TRACK_1 })
    await rpc('settings/get', undefined)
    await rpc('wall/pending', {})
    await rpc('audit/list', {})

    expect(entries()).toEqual([])
  })

  it('never keeps a stream key', async () => {
    await rpc('rooms/setStream', { roomId: TRACK_1, rtmpUrl: 'rtmp://live.example/app', streamKey: 'cle-tres-secrete' })

    const [entry] = entries()
    expect(entry).toMatchObject({ action: 'rooms.setStream', ok: true })
    expect(entry!.detail).not.toContain('cle-tres-secrete')
    expect(entry!.detail).toContain('rtmp://live.example/app')
  })

  it('writes down the account changes, which do not go through the router', async () => {
    const response = await fetch(`${origin}/api/auth/admin/set-role`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
      body: JSON.stringify({ userId: 'inconnu', role: 'admin' }),
    })
    expect(response.status).toBeGreaterThanOrEqual(400)

    expect(entries()[0]).toMatchObject({ actor: OPERATOR.email, action: 'auth.admin.set-role', ok: false })
    expect(entries()[0]!.detail).toContain('"role":"admin"')
  })
})

describe('reading it', () => {
  it('is reserved to those who may', async () => {
    const mobile = await signIn(MOBILE)
    expect((await rpc('audit/list', {}, mobile)).status).toBe(403)
    expect((await rpc('audit/list', {})).status).toBe(200)
  })

  it('filters by room and by person, newest first', async () => {
    await rpc('rooms/resync', { roomId: TRACK_1 })
    await rpc('rooms/resync', { roomId: null })

    const all = (await rpc('audit/list', {})).body.json as AuditEntry[]
    expect(all.map((entry) => entry.roomId)).toEqual([null, TRACK_1])
    const room = (await rpc('audit/list', { roomId: TRACK_1 })).body.json as AuditEntry[]
    expect(room).toHaveLength(1)
    const nobody = (await rpc('audit/list', { actor: MOBILE.email })).body.json as AuditEntry[]
    expect(nobody).toEqual([])
  })

  it(`forgets what is older than ${AUDIT_RETENTION_DAYS} days, on the hub's clock`, async () => {
    await rpc('rooms/resync', { roomId: TRACK_1 })
    hub.services.clock.setSimulated(
      new Date(hub.services.clock.now() + (AUDIT_RETENTION_DAYS + 1) * 24 * 3_600_000).toISOString(),
    )
    await rpc('rooms/resync', { roomId: null })

    expect(hub.services.audit.purge()).toBe(1)
    expect(entries().map((entry) => entry.roomId)).toEqual([null])
  })
})

describe('the request, as the log shows it', () => {
  it('masks the secrets and keeps a webhook to its host', () => {
    const detail = describeRequest('integrations.create', {
      name: 'Slack régie',
      url: 'https://hooks.slack.com/services/T000/B000/XXXX',
      secret: 'signature',
    })
    expect(detail).toContain('https://hooks.slack.com/…')
    expect(detail).not.toContain('XXXX')
    expect(detail).toContain('"secret":"•••"')
  })

  it('sums up what is too long to read', () => {
    const detail = describeRequest('program.import', { text: 'x'.repeat(70_000) })
    expect(detail).toContain('70000 caractères')
    expect(detail!.length).toBeLessThan(300)
  })
})
