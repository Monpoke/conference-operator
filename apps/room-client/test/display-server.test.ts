import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeProgram, type Program } from '@conference-operator/program'
import { AssetCache } from '../src/core/assets.js'
import { DisplayServer, type DisplayPayload } from '../src/core/display-server.js'
import { LocalStore } from '../src/core/store.js'
import { RoomRuntime } from '../src/core/runtime.js'

const program = normalizeProgram(
  JSON.parse(
    readFileSync(
      fileURLToPath(new URL('../../../packages/program/test/fixtures/cloudnord-2026.json', import.meta.url)),
      'utf8',
    ),
  ),
)

const TRACK_1 = 'track-1-teilhard-de-chardin'

let dir: string
let store: LocalStore
let assets: AssetCache
let runtime: RoomRuntime
let server: DisplayServer
let origin: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cloudnord-display-'))
  store = new LocalStore(':memory:')
  assets = new AssetCache(store, join(dir, 'assets'))
  store.saveProgram('hash-1', program)

  runtime = new RoomRuntime(store, {}, () => Date.parse('2026-10-30T10:20:00.000Z'))
  runtime.setRoomId(TRACK_1)
  runtime.setProgram('hash-1', program)

  server = new DisplayServer({
    runtime,
    assets,
    program: () => store.activeProgram(),
    roomName: () => 'Track #1 — Teilhard de Chardin',
    port: 0,
  })
  origin = await server.listen()
})

afterEach(async () => {
  await server.close()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Reads the first N messages of an SSE stream, then closes. */
/**
 * Reads the stream as a page would: a complete snapshot on opening, then deltas
 * merged over it. Returns the state rebuilt after each message, and the raw
 * message, so that what actually travelled can be checked.
 */
async function readSse(
  url: string,
  count: number,
  trigger?: () => void,
): Promise<{ merged: DisplayPayload; raw: Record<string, unknown>; delta: boolean }[]> {
  const controller = new AbortController()
  const response = await fetch(url, { signal: controller.signal })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const messages: { merged: DisplayPayload; raw: Record<string, unknown>; delta: boolean }[] = []
  let current: Record<string, unknown> = {}
  let buffer = ''
  let triggered = false

  while (messages.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let index: number
    while ((index = buffer.indexOf('\n\n')) !== -1) {
      const block = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const lines = block.split('\n')
      const data = lines.find((line) => line.startsWith('data: '))
      if (data == null) continue
      const delta = lines.some((line) => line === 'event: delta')
      const raw = JSON.parse(data.slice(6)) as Record<string, unknown>
      current = delta ? { ...current, ...raw } : raw
      messages.push({ merged: current as unknown as DisplayPayload, raw, delta })
    }
    if (!triggered && trigger != null) {
      triggered = true
      trigger()
    }
  }
  controller.abort()
  return messages
}

/** Counts the messages received during a given time window. */
async function countSse(url: string, durationMs: number): Promise<number> {
  const controller = new AbortController()
  const response = await fetch(url, { signal: controller.signal })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let receivedCount = 0
  let buffer = ''
  const fin = Date.now() + durationMs
  const abortTimer = setTimeout(() => controller.abort(), durationMs)
  try {
    while (Date.now() < fin) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        if (block.includes('data: ')) receivedCount += 1
      }
    }
  } catch {
    // Aborting the stream is the normal way to end this read.
  }
  clearTimeout(abortTimer)
  controller.abort()
  return receivedCount
}

describe('local display server', () => {
  it('serves a self-contained page, bar one optional script', async () => {
    const html = await (await fetch(`${origin}/display/projector`)).text()
    expect(html).toContain('<!doctype html>')
    /*
     * A tag pointing at a CDN would break the screen at the first network cut.
     * Only the X button escapes that: loaded `async`, last, and nothing that is
     * read depends on it — the Réseaux slide carries the hashtag in large type,
     * which stays there without it.
     */
    const external = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)]
      .map((found) => found[1]!)
      .filter((url) => /^(?:https?:)?\/\//.test(url))
    expect(external).toEqual(['https://platform.x.com/widgets.js'])
    expect(html).toContain("new EventSource('/display/state?vue=projecteur')")
  })

  it('exposes the program filtered down to the room', async () => {
    const payload = (await (await fetch(`${origin}/display/data`)).json()) as DisplayPayload
    // 15 of the event's 27 sessions take place in this room.
    expect(payload.sessions).toHaveLength(15)
    expect(payload.sessions.every((session) => session.roomId === TRACK_1)).toBe(true)
    expect(payload.sponsorTiers[0]?.name).toBe('Gold')
    expect(payload.state.currentSession?.title).toContain('HoneySwamp')
    // The readable name, not the technical identifier: this is projected in the room.
    expect(payload.roomName).toBe('Track #1 — Teilhard de Chardin')
  })

  it('pushes the first state immediately, then every change', async () => {
    const messages = await readSse(`${origin}/display/state?vue=projecteur`, 2, () => {
      void runtime.setDisplayMode('programme')
    })

    // The screen must never wait for a change to display something.
    expect(messages[0]?.merged.state.mode).toBe('loop')
    expect(messages[1]?.merged.state.mode).toBe('programme')
    // The first message is complete, the next carries only what moved.
    expect(messages[0]?.delta).toBe(false)
    expect(messages[1]?.delta).toBe(true)
    expect(Object.keys(messages[1]!.raw)).toEqual(['state'])
  })

  it('sends nothing when the clock tick changes nothing', async () => {
    // The tick recomputes the timeline every 5 s. With no real change it must
    // produce no traffic: that is what republished 43 KB for nothing.
    const stream = countSse(`${origin}/display/state?vue=projecteur`, 1_500)
    for (let i = 0; i < 20; i++) runtime.refreshSessions()
    // Only the opening snapshot should have travelled.
    expect(await stream).toBe(1)
  })

  it('sends the overlay only the fields it reads', async () => {
    const messages = await readSse(`${origin}/display/state?vue=overlay`, 2, () => {
      void runtime.setDisplayMode('live')
    })
    // The room's program is most of the payload's weight, and the overlay never
    // displays it.
    expect(Object.keys(messages[0]!.raw).sort()).toEqual(['event', 'eventIdentity', 'state'])
    expect(messages[0]!.raw).not.toHaveProperty('sessions')
    expect(messages[0]!.raw).not.toHaveProperty('diagnostics')
  })

  it('serves the whole payload to whoever names no view', async () => {
    // `/display/data` and the diagnostic tools have no business knowing the views.
    const messages = await readSse(`${origin}/display/state`, 1)
    expect(Object.keys(messages[0]!.raw)).toContain('sessions')
    expect(Object.keys(messages[0]!.raw)).toContain('diagnostics')
  })

  it('serves the assets from the local cache', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('PNG-BYTES', { status: 200, headers: { 'content-type': 'image/png' } }),
    ) as unknown as typeof fetch
    const ref = await assets.fetchOne('https://cdn.exemple/logo.png', fetchImpl)

    const response = await fetch(`${origin}${ref.localUrl}`)
    expect(await response.text()).toBe('PNG-BYTES')
    expect(response.headers.get('content-type')).toBe('image/png')
    // Content-addressed: cacheable indefinitely by OBS's Browser Source.
    expect(response.headers.get('cache-control')).toContain('immutable')
  })

  it('answers 404 on a missing asset rather than blocking the render', async () => {
    expect((await fetch(`${origin}/assets/${'0'.repeat(64)}`)).status).toBe(404)
  })

  it('stays serveable with no program cached', async () => {
    const empty = new LocalStore(':memory:')
    const other = new DisplayServer({
      runtime: new RoomRuntime(empty),
      assets: new AssetCache(empty, join(dir, 'empty')),
      program: () => null,
      port: 0,
    })
    const otherOrigin = await other.listen()

    // First commissioning, before any sync: the page must display all the same
    // rather than leave a black screen in the room.
    const payload = (await (await fetch(`${otherOrigin}/display/data`)).json()) as DisplayPayload
    expect(payload.sessions).toEqual([])
    expect(payload.state.mode).toBe('loop')
    expect((await fetch(`${otherOrigin}/display/projector`)).status).toBe(200)

    await other.close()
    empty.close()
  })
})

describe('VU meter', () => {
  it('subscribes the room only while a control app is watching', async () => {
    // The property that justifies a separate stream: OBS emits 50 times a second,
    // on the machine that encodes. Nobody watching, nobody paying.
    const demandes: boolean[] = []
    const local = new DisplayServer({
      runtime,
      assets,
      program: () => store.activeProgram(),
      onLevelsRequested: (actif) => demandes.push(actif),
      port: 0,
    })
    const url = await local.listen()

    try {
      expect(demandes).toEqual([])

      const controller = new AbortController()
      const stream = await fetch(`${url}/display/audio`, { signal: controller.signal })
      const reader = stream.body!.getReader()
      // The subscription is laid down when the stream opens.
      await vi.waitFor(() => expect(demandes).toEqual([true]))

      local.publishLevels([{ name: 'Micro', channels: [{ magnitude: -18, peak: -16 }] }])

      // The first block is the opening comment, which pushes the headers; we read
      // on to the first measurement.
      const decoder = new TextDecoder()
      let receivedText = ''
      while (!receivedText.includes('data: ')) {
        receivedText += decoder.decode((await reader.read()).value, { stream: true })
      }
      expect(receivedText).toContain('"name":"Micro"')
      expect(receivedText).toContain('-18')

      controller.abort()
      // And withdrawn as soon as the last page closes.
      await vi.waitFor(() => expect(demandes).toEqual([true, false]))
    } finally {
      await local.close()
    }
  })

  it('does not reopen the subscription for a second control app', async () => {
    const demandes: boolean[] = []
    const local = new DisplayServer({
      runtime,
      assets,
      program: () => store.activeProgram(),
      onLevelsRequested: (actif) => demandes.push(actif),
      port: 0,
    })
    const url = await local.listen()

    try {
      const a = new AbortController()
      const b = new AbortController()
      await fetch(`${url}/display/audio`, { signal: a.signal })
      await vi.waitFor(() => expect(demandes).toEqual([true]))
      await fetch(`${url}/display/audio`, { signal: b.signal })

      // Two pages open, a single subscription on OBS.
      expect(demandes).toEqual([true])

      a.abort()
      // And it is not cut while anyone is left.
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(demandes).toEqual([true])

      b.abort()
      await vi.waitFor(() => expect(demandes).toEqual([true, false]))
    } finally {
      await local.close()
    }
  })
})

/**
 * What is playing in the other rooms, on the **effective** end time.
 *
 * The position used to be looked up in a list already filtered down to talks, and
 * a slot with no explicit end time was "running" there forever: the screen next
 * door announced the morning's first talk until the evening. The computation now
 * goes through `timelinePosition`, over every slot, and the filter on talks comes
 * afterwards.
 */
describe('other rooms, effective end', () => {
  const TRACK_2 = 'track-2-mf-1092'
  /** 08:50 → 09:40 UTC, Track #2's first talk. */
  const MORNING = 'cmq3nx20102h901ppuyjkennd'
  /** 10:00 → 10:50 UTC: the one really playing at the test's hour. */
  const NOON = 'cmqb69foj000p01nl361us8f0'

  async function neighbour(): Promise<DisplayPayload['otherRooms'][number] | undefined> {
    const payload = (await (await fetch(`${origin}/display/data`)).json()) as DisplayPayload
    return payload.otherRooms.find((salle) => salle.roomId === TRACK_2)
  }

  it('announces the talk that is playing, not the morning one left open', async () => {
    // The morning talk loses its end time: only its duration is left, as in an
    // export that carries start times only.
    const served: Program = {
      ...program,
      sessions: program.sessions.map((session) =>
        session.id === MORNING
          ? { ...session, endsAt: null, endsAtMs: null, durationMinutes: 50 }
          : session,
      ),
    }
    store.saveProgram('hash-2', served)
    runtime.setProgram('hash-2', served)

    // The file's clock is at 10:20 UTC: the duration closes the morning talk at
    // 09:40, and it is the 10:00 one that is playing.
    const vue = await neighbour()
    expect(vue?.session?.id).toBe(NOON)
    expect(vue?.running).toBe(true)
  })

  it('gives the next talk when nothing is playing next door', async () => {
    // 09:50 UTC: Track #2 is between two talks. An empty room does not announce
    // "en ce moment", it announces the next one's time.
    runtime.setServerTime(new Date(Date.parse('2026-10-30T09:50:00.000Z')).toISOString(), true)

    const vue = await neighbour()
    expect(vue?.running).toBe(false)
    expect(vue?.session?.id).toBe(NOON)
  })
})

/**
 * The machine's load, served outside the state stream.
 *
 * The point to protect is not the figure: it is that the figure does not travel
 * in the payload. A value that moves every second would republish the whole
 * diagnostic on every tick, when a room at rest must emit nothing.
 */
describe('machine load', () => {
  it('answers on its own route', async () => {
    const response = await fetch(`${origin}/control/host`)
    expect(response.status).toBe(200)

    const charge = (await response.json()) as {
      cpu: number | null
      cores: number
      windowMs: number
      memory: { usedBytes: number; totalBytes: number } | null
    }
    expect(charge.cores).toBeGreaterThan(0)
    // Memory, for its part, reads from the very first call: it is a snapshot.
    expect(charge.memory?.totalBytes).toBeGreaterThan(0)
    expect(charge.memory?.usedBytes).toBeLessThanOrEqual(charge.memory?.totalBytes ?? 0)
    // On the first reading no window has elapsed: the server admits it rather
    // than announce an idle machine.
    expect(charge.cpu === null || (charge.cpu >= 0 && charge.cpu <= 1)).toBe(true)
  })

  it('stays out of the payload sent to the pages', async () => {
    const payload = (await (await fetch(`${origin}/display/data`)).json()) as Record<string, unknown>
    expect(payload).not.toHaveProperty('hote')
    expect(JSON.stringify(payload)).not.toContain('cores')
  })

  it('relays the reading it is handed', async () => {
    const local = new DisplayServer({
      runtime,
      assets,
      program: () => store.activeProgram(),
      hostLoad: () => ({
        cpu: 0.42,
        cores: 8,
        windowMs: 5_000,
        memory: { usedBytes: 11_000_000_000, totalBytes: 16_000_000_000 },
      }),
      port: 0,
    })
    const origin_ = await local.listen()
    try {
      expect(await (await fetch(`${origin_}/control/host`)).json()).toEqual({
        cpu: 0.42,
        cores: 8,
        windowMs: 5_000,
        memory: { usedBytes: 11_000_000_000, totalBytes: 16_000_000_000 },
      })
    } finally {
      await local.close()
    }
  })
})
