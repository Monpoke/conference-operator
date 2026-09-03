import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it } from 'vitest'
import { useClockStore } from '../src/stores/clock.js'
import { STREAM_DEAD_MS, useRoomStore, type StateStream } from '../src/stores/room.js'
import { payload } from './fixtures.js'

/**
 * The state stream, and the only failure the page has to diagnose itself.
 *
 * `EventSource` reconnects on its own and raises nothing: a room machine restarted
 * under an open window leaves that window apparently alive — the clock ticks, the
 * countdown descends — and in fact frozen. That is exactly what cannot be seen
 * from the room.
 */

/** A stream opened, cut and reopened by hand. */
function fakeStream(): StateStream & {
  emit: (data: unknown) => void
  emitDelta: (data: unknown) => void
  fail: () => void
  reopen: () => void
  closed: boolean
} {
  const listeners = new Map<string, (event: MessageEvent) => void>()
  const stream = {
    onopen: null as ((event: Event) => void) | null,
    onerror: null as ((event: Event) => void) | null,
    onmessage: null as ((event: MessageEvent) => void) | null,
    closed: false,
    addEventListener(type: string, listener: (event: MessageEvent) => void) {
      listeners.set(type, listener)
    },
    close() {
      stream.closed = true
    },
    emit(data: unknown) {
      stream.onmessage?.({ data: JSON.stringify(data) } as MessageEvent)
    },
    emitDelta(data: unknown) {
      listeners.get('delta')?.({ data: JSON.stringify(data) } as MessageEvent)
    },
    fail() {
      stream.onerror?.(new Event('error'))
    },
    reopen() {
      stream.onopen?.(new Event('open'))
    },
  }
  return stream
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('room state', () => {
  it('starts from the state embedded in the shell, before any byte of the stream', () => {
    const room = useRoomStore()
    room.seed(payload({ roomName: 'Track #2' }))

    // An F5 almost always comes at the worst moment: the window has frozen, and it
    // is mid-talk. Waiting for the stream would give a blank screen there.
    expect(room.payload?.roomName).toBe('Track #2')
  })

  it('replaces everything on a snapshot, merges on a delta', () => {
    const room = useRoomStore()
    const stream = fakeStream()
    room.connect(() => stream)

    stream.emit(payload({ roomName: 'Track #1' }))
    stream.emitDelta({ roomName: 'Track #7' })

    expect(room.payload?.roomName).toBe('Track #7')
    // The delta carried only the name: the rest must have survived.
    expect(room.payload?.state.roomId).toBe('track-1')
  })

  it('ignores a delta arriving before any snapshot', () => {
    const room = useRoomStore()
    const stream = fakeStream()
    room.connect(() => stream)

    stream.emitDelta({ roomName: 'Track #7' })

    // A delta on its own describes a room whose rest is unknown. Painting it
    // half-way would be worse than waiting for the snapshot, which follows every
    // reconnection anyway.
    expect(room.payload).toBe(null)
  })
})

describe('dead stream', () => {
  it('does not cry out on a one-second reconnection', () => {
    const clock = useClockStore()
    const room = useRoomStore()
    const stream = fakeStream()
    room.connect(() => stream)

    stream.fail()
    clock.advance(1000)

    expect(room.dead).toBe(false)
  })

  it('says so once the grace period has passed', () => {
    const clock = useClockStore()
    const room = useRoomStore()
    const stream = fakeStream()
    room.connect(() => stream)

    stream.fail()
    clock.advance(STREAM_DEAD_MS + 1000)

    expect(room.dead).toBe(true)
  })

  it('goes quiet as soon as a message comes back, without waiting for the reopening', () => {
    const clock = useClockStore()
    const room = useRoomStore()
    const stream = fakeStream()
    room.connect(() => stream)

    stream.fail()
    clock.advance(STREAM_DEAD_MS + 1000)
    stream.emit(payload())

    expect(room.dead).toBe(false)
  })

  it('does not count two outages as one', () => {
    const clock = useClockStore()
    const room = useRoomStore()
    const stream = fakeStream()
    room.connect(() => stream)

    stream.fail()
    clock.advance(3000)
    // `onerror` fires again on every reconnection attempt: restarting the count on
    // each would push the warning back indefinitely on a machine that is switched
    // off, which is precisely the case it has to cover.
    stream.fail()
    clock.advance(2000)

    expect(room.dead).toBe(true)
  })

  it('starts over after a real reopening', () => {
    const clock = useClockStore()
    const room = useRoomStore()
    const stream = fakeStream()
    room.connect(() => stream)

    stream.fail()
    clock.advance(STREAM_DEAD_MS + 1000)
    stream.reopen()

    expect(room.dead).toBe(false)
  })
})

describe("the room's time", () => {
  it("carries the hub's offset, not the machine's time", () => {
    const clock = useClockStore()
    const room = useRoomStore()
    room.seed(payload({ state: { ...payload().state, serverTimeOffsetMs: 3_600_000 } }))

    // The offset is what explains a countdown that does not match the operator's
    // watch — so it cannot be lost along the way.
    expect(room.now).toBe(clock.real + 3_600_000)
  })
})

describe('opening', () => {
  it('opens only one stream, even when called twice', () => {
    const room = useRoomStore()
    const streams: StateStream[] = []
    const open = (): StateStream => {
      const stream = fakeStream()
      streams.push(stream)
      return stream
    }

    room.connect(open)
    room.connect(open)

    expect(streams).toHaveLength(1)
  })
})
