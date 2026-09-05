import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PAIRING_ALIAS, consoleViews, viewPath } from '@conference-operator/contract'
import { createHub, type Hub } from '../src/server.js'
import { renderWallPage } from '../src/pages/wall-page.js'
import { provisionOperator } from '../src/operators.js'

const rawProgram = readFileSync(
  fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
  'utf8',
)

const OPERATOR = { email: 'regie@cloudnord.fr', name: 'Régie', password: 'control-password-2026' }
const TRACK_1 = 'track-1-teilhard-de-chardin'

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

  await provisionOperator(hub.auth, OPERATOR)
  hub.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
  hub.services.rooms.upsert({
    id: TRACK_1,
    name: 'Track #1 - Teilhard de Chardin',
    trackId: TRACK_1,
    obs: {
      A: { url: 'ws://127.0.0.1:4455', password: null },
      B: { url: 'ws://127.0.0.1:4456', password: null },
    },
    sceneRoles: { A: {}, B: {} },
  })
})

afterEach(async () => {
  await hub.close()
})

/** Calling the contract over bare HTTP, exactly as the public pages do. */
async function rpc(path: string, input: unknown, token?: string) {
  const response = await fetch(`${origin}/rpc/${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token != null ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ json: input }),
  })
  return { status: response.status, body: (await response.json()) as { json?: never } }
}

async function operatorToken(): Promise<string> {
  const response = await fetch(`${origin}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
  })
  return ((await response.json()) as { token: string }).token
}

describe('public pages', () => {
  it('serves a standalone wall, loadable on a room\'s 4G', async () => {
    const html = await (await fetch(`${origin}/mur?salle=${TRACK_1}`)).text()
    expect(html).toContain('Cloud Nord 2026')
    // An external dependency would make the page unusable as soon as the venue's
    // network saturates — precisely when everyone is scanning it.
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=/)
    // The room is injected server side: the QR code carries the context.
    expect(html).toContain('Track #1 - Teilhard de Chardin')
  })

  it('serves the console, asking for nothing outside its origin', async () => {
    /**
     * The self-sufficiency invariant, restated — and this is where it is checked.
     *
     * The old rule forbade any `src` or `href` tag, for a reason written in black
     * and white: "a tag pointing at a CDN would break the page on the first
     * outage". What that reason targets is **the network**, not the tag. The
     * console now loads a bundle, but one served by the hub itself: an outage of
     * the event's network cannot make it disappear, whereas it would carry off any
     * other origin.
     *
     * The wall, for its part, keeps the rule to the letter — it has no build step
     * and opens on a room's 4G.
     */
    const html = await (await fetch(`${origin}/admin`)).text()
    expect(html).toContain('id="console-boot"')

    const addresses = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((found) => found[1]!)
    expect(addresses.length).toBeGreaterThan(0)
    for (const address of addresses) expect(address.startsWith('/'), address).toBe(true)
  })

  it('serves one address per console tab', async () => {
    /**
     * Each tab is an address: with no route on the hub side, a console refreshed
     * on `/admin/moderation` would answer 404 — exactly where the operator had
     * left it open.
     *
     * The addresses are enumerated from the contract rather than written here:
     * it is the same list the hub uses to register its routes and the console's
     * router uses to navigate, so a view added without a route shows up here.
     *
     * What each address serves depends on how far the migration has gone: the
     * template for the views that have not switched yet, the bundle's shell for
     * those that have. The test accepts both **and nothing else** — a blank page
     * instead of a console would otherwise pass.
     */
    for (const path of [...consoleViews(false).map(viewPath), PAIRING_ALIAS]) {
      const response = await fetch(`${origin}${path}`)
      expect(response.status, path).toBe(200)
      const html = await response.text()
      expect(
        html.includes('console hub') || html.includes('id="console-boot"'),
        `${path} serves neither the template nor the shell`,
      ).toBe(true)
    }
  })

  it('serves the service worker at the root', async () => {
    /**
     * A service worker's scope is that of its path: served under `/admin/`, it
     * would not cover the rest of the hub — and without it, no notification
     * arrives with the console closed.
     */
    const response = await fetch(`${origin}/sw.js`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('javascript')
    // Rechecked on every load: caching it would delay any correction by an event
    // day.
    expect(response.headers.get('cache-control')).toContain('no-cache')

    const code = await response.text()
    expect(code).toContain("addEventListener('push'")
    expect(() => new Function(code)).not.toThrow()
  })

  it('does not serve a view that does not exist', async () => {
    // A wildcard would serve the console on any typo, which would then open onto
    // operations without saying the address is wrong.
    expect((await fetch(`${origin}/admin/moderationn`)).status).toBe(404)
    // `developpement` is only rendered in dev mode: the hub does not serve it
    // either.
    expect((await fetch(`${origin}/admin/developpement`)).status).toBe(404)
  })

  it('serves the verification address announced during pairing', async () => {
    /**
     * That address is displayed on the control screen and followed by an operator.
     * It was configured in Better Auth with no route serving it: the link returned
     * a 404, at the precise moment someone was relying on it.
     */
    const response = await fetch(`${origin}/admin/devices?user_code=R6A67TTS`)
    expect(response.status).toBe(200)
    // Template or shell depending on how far the migration has gone — but a
    // console, and the code must stay in the URL so it knows what to check.
    const html = await response.text()
    expect(html.includes('console hub') || html.includes('id="console-boot"')).toBe(true)
  })

  it('announces a verification address the hub really serves', async () => {
    // Checks the agreement between what Better Auth promises and what exists.
    const request = await fetch(`${origin}/api/auth/device/code`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: '01JB2ZK5T7QW9V0YHRXM3N4P6C' }),
    })
    const { verification_uri, verification_uri_complete } = (await request.json()) as {
      verification_uri?: string
      verification_uri_complete?: string
    }
    const announced = verification_uri_complete ?? verification_uri
    expect(announced).toBeTruthy()

    // Replayed on this hub: the announced URL carries the production origin.
    const path = new URL(announced!).pathname + new URL(announced!).search
    expect((await fetch(`${origin}${path}`)).status).toBe(200)
  })
})

describe('public posting and moderation', () => {
  it('keeps a message pending then publishes it after review', async () => {
    const post = await rpc('wall/post', { roomId: TRACK_1, author: 'Alice', text: 'Super talk !' })
    expect(post.status).toBe(200)

    // Nothing reaches the screen without a human decision.
    expect(hub.services.wall.approved()).toEqual([])

    const token = await operatorToken()
    const pending = await rpc('wall/pending', {}, token)
    expect((pending.body.json as unknown as { id: string }[])).toHaveLength(1)

    const id = (pending.body.json as unknown as { id: string }[])[0]!.id
    expect((await rpc('wall/moderate', { id, decision: 'approve' }, token)).status).toBe(200)
    expect(hub.services.wall.approved().map((c) => c.text)).toEqual(['Super talk !'])
  })

  it('demands an operator session to moderate', async () => {
    const post = await rpc('wall/post', { roomId: null, author: 'A', text: 'coucou' })
    expect(post.status).toBe(200)
    // An attendee must not be able to publish their own message.
    expect((await rpc('wall/pending', {})).status).toBe(401)
    expect((await rpc('wall/moderate', { id: 'x', decision: 'approve' })).status).toBe(401)
  })

  it('slows down a poster who is too fast', async () => {
    const send = () => rpc('wall/post', { roomId: null, author: 'A', text: 'spam' })

    const statuses: number[] = []
    for (let i = 0; i < 8; i += 1) statuses.push((await send()).status)

    // Five in a row get through — an enthusiastic attendee — then it slows down.
    expect(statuses.filter((s) => s === 200)).toHaveLength(5)
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)
  })

  it('accepts questions and votes with no account', async () => {
    const asked = await rpc('questions/post', {
      roomId: TRACK_1,
      sessionId: null,
      author: 'Alice',
      text: 'Comment gérez-vous la reprise ?',
    })
    const question = asked.body.json as unknown as { id: string }

    const vote = await rpc('questions/vote', { id: question.id, deviceId: 'mobile-device-1' })
    expect((vote.body.json as unknown as { votes: number }).votes).toBe(1)

    // A second vote from the same device has no effect, and is not an error.
    const again = await rpc('questions/vote', { id: question.id, deviceId: 'mobile-device-1' })
    expect((again.body.json as unknown as { votes: number }).votes).toBe(1)

    const list = await rpc('questions/list', { roomId: TRACK_1, sessionId: null })
    expect((list.body.json as unknown as unknown[])).toHaveLength(1)
  })

  /**
   * What is already on the screen, read back from the phone.
   *
   * These messages are public in the strongest sense: they are projected large in
   * the rooms. Giving them back to the phone that has just dropped one is what
   * makes the difference between a contact form and a wall.
   */
  it('returns the already projected messages, with no account', async () => {
    const posted = await rpc('wall/post', {
      roomId: null,
      author: 'Camille',
      text: 'Super talk, merci !',
    })
    const { id } = posted.body.json as unknown as { id: string }

    // Nothing before moderation: the wall only shows what has gone through a
    // human decision.
    const before = await rpc('wall/recent', { limit: 12 })
    expect(before.body.json as unknown as unknown[]).toHaveLength(0)

    const token = await operatorToken()
    await rpc('wall/moderate', { id, decision: 'approve' }, token)

    const after = await rpc('wall/recent', { limit: 12 })
    const messages = after.body.json as unknown as { text: string }[]
    expect(messages.map((message) => message.text)).toEqual(['Super talk, merci !'])
  })
})

describe('talk lifecycle from the console', () => {
  it('starts, ends and resets to upcoming', async () => {
    const token = await operatorToken()
    const session = hub.services.programs.active()!.program.sessions.find(
      (s) => s.roomId === TRACK_1 && s.kind === 'talk',
    )!

    const started = await rpc('sessions/start', { sessionId: session.id }, token)
    expect((started.body.json as unknown as { status: string }).status).toBe('running')

    const ended = await rpc('sessions/end', { sessionId: session.id }, token)
    expect((ended.body.json as unknown as { status: string }).status).toBe('ended')

    await rpc('sessions/reset', { sessionId: session.id }, token)
    const states = await rpc('sessions/states', { roomId: TRACK_1 }, token)
    expect(states.body.json as unknown as unknown[]).toEqual([])
  })

  it('refuses a session absent from the program', async () => {
    const token = await operatorToken()
    // Writing an orphan state would give the illusion of having acted.
    const result = await rpc('sessions/start', { sessionId: 'inexistante' }, token)
    expect(result.status).toBe(404)
  })

  it('reserves the driving to operators', async () => {
    const session = hub.services.programs.active()!.program.sessions[0]!
    expect((await rpc('sessions/start', { sessionId: session.id })).status).toBe(401)
    expect((await rpc('settings/update', { autoEndGraceMinutes: 1 })).status).toBe(401)
  })

  it('reads and changes the automatic closing period', async () => {
    const token = await operatorToken()
    expect(await rpc('settings/get', {}, token).then((r) => r.body.json)).toMatchObject({
      autoEndEnabled: true,
      autoEndGraceMinutes: 5,
    })

    const changed = await rpc('settings/update', { autoEndGraceMinutes: 12 }, token)
    expect(changed.body.json as unknown as { autoEndGraceMinutes: number }).toMatchObject({
      autoEndGraceMinutes: 12,
    })
    expect(hub.services.settings.get().autoEndGraceMinutes).toBe(12)
  })

  it('serves the console shell on the settings address', async () => {
    /*
     * The panel's content is no longer in the HTML: it lives in the bundle, and it
     * is `apps/hub-admin/test/settings.test.ts` that holds it — down to the
     * labels "Clôture automatique" and "Délai de grâce" this test used to check
     * here. What remains to be checked on this side is that the address answers
     * and does serve a console.
     */
    const response = await fetch(`${origin}/admin/reglages`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('id="console-boot"')
  })
})

describe('JavaScript embedded in the hub\'s pages', () => {
  /**
   * What is left of the literal templates, and why this test survives.
   *
   * The wall has no build step: its script lives in a template literal, where
   * TypeScript only sees a string. An error in it breaks the whole page — a case
   * already met on the control side, with an apostrophe whose backslash collapsed
   * inside the template.
   *
   * The console left this list when moving to Vue: its code is now seen by a
   * compiler, which is precisely the benefit we came for. This test has nothing
   * left to say about it.
   */
  const pages: [string, string][] = [
    ['mur', renderWallPage({ roomId: 'r', rooms: [{ id: 'r', name: 'R' }] })],
  ]

  it.each(pages)('%s: parseable', (_name, html) => {
    const scripts = [...html.matchAll(/<script(?![^>]*type="application\/json")[^>]*>([\s\S]*?)<\/script>/g)]
      .map((match) => match[1] ?? '')
      .filter((code) => code.trim().length > 0)

    expect(scripts.length).toBeGreaterThan(0)
    for (const code of scripts) expect(() => new Function(code)).not.toThrow()
  })
})

describe('the hub\'s simulated time', () => {
  it('propagates the time and reports it', async () => {
    const simulated = await createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath: ':memory:',
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
      // The simulated time only applies in development mode — that is what
      // `mode.test.ts` checks, and what this hub must therefore declare.
      mode: 'dev',
      simulatedTime: '2026-10-30T10:20:00.000Z',
    })
    await simulated.app.listen({ port: 0, host: '127.0.0.1' })
    const address = simulated.app.server.address()
    const base = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`

    const response = await fetch(`${base}/rpc/meta/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { protocolVersion: 1 } }),
    })
    const body = (await response.json()) as { json: { serverTime: string; simulatedClock: boolean } }

    // The rooms align their clock on this value: simulating it here moves the
    // whole system, with nothing to set on their side.
    expect(body.json.serverTime.startsWith('2026-10-30T10:2')).toBe(true)
    expect(body.json.simulatedClock).toBe(true)

    await simulated.close()
  })

  it('dates the commands with the simulated time', async () => {
    const simulated = await createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath: ':memory:',
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
      // The simulated time only applies in development mode — that is what
      // `mode.test.ts` checks, and what this hub must therefore declare.
      mode: 'dev',
      simulatedTime: '2026-10-30T10:20:00.000Z',
    })
    simulated.services.rooms.upsert({
      id: TRACK_1,
      name: 'Track #1',
      trackId: TRACK_1,
      obs: {
        A: { url: 'ws://127.0.0.1:4455', password: null },
        B: { url: 'ws://127.0.0.1:4456', password: null },
      },
      sceneRoles: { A: {}, B: {} },
    })

    const command = simulated.services.commands.publish(
      TRACK_1,
      { type: 'message.broadcast', text: 'Pause déjeuner', level: 'info' },
      600,
    )

    /**
     * This is the point that mattered: with a real clock on the hub side and a
     * room simulated in October, the staleness filter discarded every command
     * with a TTL. Both clocks must come from the same place.
     */
    expect(command.issuedAt.startsWith('2026-10-30')).toBe(true)
    await simulated.close()
  })

  it('stays on the real time with no configuration', async () => {
    const response = await fetch(`${origin}/rpc/meta/hello`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { protocolVersion: 1 } }),
    })
    const body = (await response.json()) as { json: { simulatedClock: boolean } }
    expect(body.json.simulatedClock).toBe(false)
  })
})

describe('setting the time from the console', () => {
  /** The mode is authoritative: there is no separate switch for the clock. */
  const makeHub = (mode: 'production' | 'dev' = 'production') =>
    createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath: ':memory:',
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
      mode,
    })

  async function addressAndToken(h: Hub) {
    await h.app.listen({ port: 0, host: '127.0.0.1' })
    const a = h.app.server.address()
    const base = `http://127.0.0.1:${typeof a === 'object' && a != null ? a.port : 0}`
    await provisionOperator(h.auth, OPERATOR)
    const r = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
    })
    return { base, token: ((await r.json()) as { token: string }).token }
  }

  const call = (base: string, path: string, input: unknown, token: string) =>
    fetch(`${base}/rpc/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ json: input }),
    })

  it('refuses on a production hub, explaining how to open it', async () => {
    const h = await makeHub()
    const { base, token } = await addressAndToken(h)

    const response = await call(base, 'clock/set', { at: '2026-10-30T10:20:00.000Z' }, token)
    expect(response.status).toBe(403)
    const body = (await response.json()) as { json: { message: string } }
    // Changing the time during the event would skew the timecodes: closed by
    // default, and the message says how to open it knowingly.
    expect(body.json.message).toContain('MODE=dev')

    const state = await call(base, 'clock/get', {}, token)
    expect(((await state.json()) as { json: { controllable: boolean } }).json.controllable).toBe(false)

    await h.close()
  })

  it('moves the time when the setting is open', async () => {
    const h = await makeHub('dev')
    const { base, token } = await addressAndToken(h)

    const response = await call(base, 'clock/set', { at: '2026-10-30T10:20:00.000Z' }, token)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { json: { serverTime: string; simulated: boolean } }
    expect(body.json.serverTime.startsWith('2026-10-30T10:2')).toBe(true)
    expect(body.json.simulated).toBe(true)

    // Everything the hub dates follows, commands included.
    h.services.rooms.upsert({
      id: TRACK_1,
      name: 'Track #1',
      trackId: TRACK_1,
      obs: {
        A: { url: 'ws://127.0.0.1:4455', password: null },
        B: { url: 'ws://127.0.0.1:4456', password: null },
      },
      sceneRoles: { A: {}, B: {} },
    })
    const command = h.services.commands.publish(TRACK_1, { type: 'scene.force', role: 'HOLD' }, null)
    expect(command.issuedAt.startsWith('2026-10-30')).toBe(true)

    await h.close()
  })

  it('broadcasts the realignment to the rooms', async () => {
    const h = await makeHub('dev')
    const { base, token } = await addressAndToken(h)

    await call(base, 'clock/set', { at: '2026-10-30T10:20:00.000Z' }, token)

    // Without this broadcast, the screens would show a different moment than the
    // console until their next synchronization.
    const broadcast = h.services.commands.backlog(TRACK_1, 0)
    const realignment = broadcast.find((c) => c.payload.type === 'clock.changed')
    expect(realignment?.payload).toMatchObject({ simulated: true })

    await h.close()
  })

  it('comes back to the real time', async () => {
    const h = await makeHub('dev')
    const { base, token } = await addressAndToken(h)

    await call(base, 'clock/set', { at: '2026-10-30T10:20:00.000Z' }, token)
    const back = await call(base, 'clock/set', { at: null }, token)
    const body = (await back.json()) as { json: { simulated: boolean } }

    expect(body.json.simulated).toBe(false)
    await h.close()
  })

  it('reserves the setting to operators', async () => {
    const h = await makeHub('dev')
    await h.app.listen({ port: 0, host: '127.0.0.1' })
    const a = h.app.server.address()
    const base = `http://127.0.0.1:${typeof a === 'object' && a != null ? a.port : 0}`

    const anonymous = await fetch(`${base}/rpc/clock/set`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { at: null } }),
    })
    expect(anonymous.status).toBe(401)
    await h.close()
  })
})

/**
 * Live banner.
 *
 * The history is read from the issued commands: they are already persisted, dated
 * and ordered, and a second copy could only diverge from what really left for the
 * rooms.
 */
describe('live banner', () => {
  const makeHub = () =>
    createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath: ':memory:',
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
    })

  async function asConsole(h: Hub) {
    await h.app.listen({ port: 0, host: '127.0.0.1' })
    const a = h.app.server.address()
    const base = `http://127.0.0.1:${typeof a === 'object' && a != null ? a.port : 0}`
    await provisionOperator(h.auth, OPERATOR)
    const r = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: OPERATOR.email, password: OPERATOR.password }),
    })
    const token = ((await r.json()) as { token: string }).token
    return async (path: string, input: unknown) => {
      const response = await fetch(`${base}/rpc/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ json: input }),
      })
      return { status: response.status, body: (await response.json()) as { json?: never } }
    }
  }

  it('keeps what has gone by, and says which one is displayed', async () => {
    const h = await makeHub()
    const call = await asConsole(h)

    await call('overlay/show', { roomId: null, message: { text: 'Premier', level: 'info' } })
    await call('overlay/show', { roomId: null, message: { text: 'Second', level: 'warning' } })

    const past = (await call('overlay/history', {})).body.json as unknown as {
      message: { text: string }
      visible: boolean
    }[]

    // From the most recent to the oldest: it is the one we want to put back first.
    expect(past.map((p) => p.message.text)).toEqual(['Second', 'Premier'])
    expect(past.map((p) => p.visible)).toEqual([true, false])

    await h.close()
  })

  it('displays nothing any more after a removal', async () => {
    const h = await makeHub()
    const call = await asConsole(h)

    await call('overlay/show', { roomId: null, message: { text: 'Premier', level: 'info' } })
    await call('overlay/hide', { roomId: null })

    const past = (await call('overlay/history', {})).body.json as unknown as {
      message: { text: string }
      visible: boolean
    }[]

    // The removal is not history — we do not put "nothing" back on air — but it
    // switches off the banner it removed.
    expect(past.map((p) => p.message.text)).toEqual(['Premier'])
    expect(past.every((p) => !p.visible)).toBe(true)

    await h.close()
  })
})

/**
 * The running talk, seen from the public wall.
 *
 * Public like the wall itself: these titles are already projected on the room's
 * screen, and without them "ask your question" does not say what about.
 */
describe('the running talk, on the public side', () => {
  it('gives it with no authentication', async () => {
    const h = await createHub({
      port: 0,
      host: '127.0.0.1',
      databasePath: ':memory:',
      publicUrl: 'http://127.0.0.1',
      authSecret: 'test-secret-'.padEnd(48, 'x'),
      logLevel: 'fatal',
      mode: 'dev',
      simulatedTime: '2026-10-30T10:20:00.000Z',
    })
    await h.app.listen({ port: 0, host: '127.0.0.1' })
    const address = h.app.server.address()
    const base = `http://127.0.0.1:${typeof address === 'object' && address != null ? address.port : 0}`
    const snapshot = h.services.programs.importFromText(rawProgram, 'https://exemple/programme.json')
    h.services.rooms.ensureFromTracks(snapshot.program.rooms)

    const response = await fetch(`${base}/rpc/rooms/current`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: { roomId: TRACK_1 } }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      json: { current: { title: string; speakers: string[] } | null; next: { title: string } | null }
    }
    expect(body.json.current?.title).toContain('HoneySwamp')
    expect(body.json.current?.speakers.length).toBeGreaterThan(0)
    expect(body.json.next?.title).toBeTruthy()

    await h.close()
  })
})
