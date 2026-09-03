import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Connectivity, Envelope, RoomEventPayload } from '@cloudnord/contract'
import { LocalStore } from '../src/core/store.js'
import { Outbox } from '../src/core/outbox.js'
import { OutboxPump, type PushResult } from '../src/core/outbox-pump.js'

const TRACK_1 = 'track-1-teilhard-de-chardin'

let store: LocalStore
let outbox: Outbox
let clockMs: number

beforeEach(() => {
  store = new LocalStore(':memory:')
  clockMs = Date.parse('2026-10-30T09:00:00.000Z')
  outbox = new Outbox(store, TRACK_1, () => clockMs)
})

const marker = (label: string): RoomEventPayload => ({
  type: 'talk.marker',
  sessionId: 'ses-1',
  label,
  offsetMs: 1000,
})

/** Simulated hub: accepts everything, remembers it, and knows how to break down. */
function fakeHub() {
  const received = new Map<string, Envelope>()
  let down = false

  const push = vi.fn(async (batch: Envelope[]): Promise<PushResult> => {
    if (down) throw new Error('network unreachable')
    const acked: string[] = []
    const duplicates: string[] = []
    for (const envelope of batch) {
      if (received.has(envelope.id)) duplicates.push(envelope.id)
      else {
        received.set(envelope.id, envelope)
        acked.push(envelope.id)
      }
    }
    return { acked, duplicates, rejected: [], serverTime: '2026-10-30T09:00:05.000Z' }
  })

  return {
    push,
    received,
    cut: () => {
      down = true
    },
    restore: () => {
      down = false
    },
  }
}

function makePump(hub: ReturnType<typeof fakeHub>) {
  const connectivities: Connectivity[] = []
  const pump = new OutboxPump({
    outbox,
    store,
    push: hub.push,
    onConnectivity: (c) => connectivities.push(c),
    now: () => clockMs,
  })
  return { pump, connectivities }
}

describe('draining the queue', () => {
  it('reports the events in emission order', async () => {
    const hub = fakeHub()
    const { pump } = makePump(hub)

    outbox.enqueue(marker('one'))
    outbox.enqueue(marker('two'))
    outbox.enqueue(marker('three'))

    const outcome = await pump.drainOnce()
    expect(outcome.sent).toBe(3)
    expect(outbox.depth()).toBe(0)

    const labels = [...hub.received.values()].map((e) => (e.payload as { label: string }).label)
    expect(labels).toEqual(['one', 'two', 'three'])
  })

  it('loses nothing during a cut and catches up once back', async () => {
    const hub = fakeHub()
    const { pump, connectivities } = makePump(hub)

    outbox.enqueue(marker('before'))
    await pump.drainOnce()
    expect(hub.received.size).toBe(1)

    // The network drops: the control app keeps emitting.
    hub.cut()
    outbox.enqueue(marker('during-1'))
    outbox.enqueue(marker('during-2'))
    const down = await pump.drainOnce()

    expect(down.connectivity).toBe('OFFLINE')
    expect(down.deferred).toBe(2)
    // Nothing is lost: the events stay queued.
    expect(outbox.depth()).toBe(2)

    // Back up, after the backoff.
    hub.restore()
    clockMs += 5_000
    const after = await pump.drainOnce()

    expect(after.sent).toBe(2)
    expect(outbox.depth()).toBe(0)
    expect(connectivities).toEqual(['ONLINE', 'OFFLINE', 'ONLINE'])
  })

  it('treats a duplicate as an acknowledgement', async () => {
    const hub = fakeHub()
    const { pump } = makePump(hub)
    const envelope = outbox.enqueue(marker('demo'))

    // The hub already received it (the acknowledgement was lost on the way back).
    await hub.push([envelope])
    const outcome = await pump.drainOnce()

    expect(outcome.duplicates).toBe(1)
    // Either way the hub holds it: the event must leave the queue.
    expect(outbox.depth()).toBe(0)
  })

  it('drops a rejected event without blocking the ones behind it', async () => {
    const broken = outbox.enqueue(marker('malformed'))
    const sound = outbox.enqueue(marker('sound'))

    const push = vi.fn(async (batch: Envelope[]): Promise<PushResult> => ({
      acked: batch.filter((e) => e.id !== broken.id).map((e) => e.id),
      duplicates: [],
      rejected: batch.filter((e) => e.id === broken.id).map((e) => ({ id: e.id, reason: 'invalid-schema' })),
    }))

    const pump = new OutboxPump({ outbox, store, push, now: () => clockMs })
    const outcome = await pump.drainOnce()

    expect(outcome).toMatchObject({ sent: 1, rejected: 1, deferred: 0 })
    expect(outbox.depth()).toBe(0)
    expect(store.recentLogs().some((l) => l.message.includes('rejeté'))).toBe(true)
    expect(sound.id).toBeTruthy()
  })

  it('defers what the hub has neither acknowledged nor rejected', async () => {
    outbox.enqueue(marker('one'))
    outbox.enqueue(marker('two'))

    // A hub that only handles half the batch: the rest must be picked up again,
    // not counted as delivered.
    const push = vi.fn(async (batch: Envelope[]): Promise<PushResult> => ({
      acked: [batch[0]!.id],
      duplicates: [],
      rejected: [],
    }))

    const pump = new OutboxPump({ outbox, store, push, now: () => clockMs })
    const outcome = await pump.drainOnce()

    expect(outcome).toMatchObject({ sent: 1, deferred: 1 })
    expect(outbox.depth()).toBe(1)
  })

  it('measures the clock offset on every successful uplink', async () => {
    const hub = fakeHub()
    const times: string[] = []
    const pump = new OutboxPump({
      outbox,
      store,
      push: hub.push,
      onServerTime: (t) => times.push(t),
      now: () => clockMs,
    })

    outbox.enqueue(marker('demo'))
    await pump.drainOnce()
    expect(times).toEqual(['2026-10-30T09:00:05.000Z'])
  })

  it('does nothing when the queue is empty', async () => {
    const hub = fakeHub()
    const { pump } = makePump(hub)
    expect(await pump.drainOnce()).toMatchObject({ sent: 0, deferred: 0 })
    expect(hub.push).not.toHaveBeenCalled()
  })
})

/**
 * The wake-up: reporting straight away what has just changed.
 *
 * For what is driven from afar. A mobile control app reads the room's state
 * through the hub, which gets it from the heartbeat: with no wake-up, a scene
 * switch takes up to one pump tick to show on the phone. And the control app
 * never paints ahead — it is the stream that repaints the button — so that delay
 * reads as a missed gesture, and one presses a second time.
 */
describe('waking the pump', () => {
  it('drains the queue without waiting for the tick', async () => {
    const hub = fakeHub()
    const { pump } = makePump(hub)
    outbox.enqueue(marker('one'))

    pump.start()
    pump.wake()
    await vi.waitFor(() => expect(hub.received.size).toBe(1))
    pump.stop()
  })

  it('does not write to the database when the batch comes back after closing', async () => {
    /*
     * The race that killed the process, one time in three.
     *
     * A batch leaves, the application closes while the hub is thinking, and the
     * answer — or the failure — comes back onto a closed database. `defer` then
     * wrote from inside the very `catch` that exists to catch failures: the
     * rejection had nobody left to catch it and reached the process.
     *
     * Nothing is lost along the way: `claimBatch` does not mark what it reads, an
     * undeferred batch stays eligible and leaves again at the next opening.
     */
    const hub = fakeHub()
    let respond: (() => void) | null = null
    const slow = new Promise<void>((resolve) => {
      respond = resolve
    })
    const pump = new OutboxPump({
      outbox,
      store,
      push: async (batch) => {
        await slow
        return hub.push(batch)
      },
    })
    outbox.enqueue(marker('one'))

    pump.start()
    const drain = pump.drainOnce()
    pump.stop()
    store.close()
    respond!()

    // Does not throw, and says so: the batch is deferred to the next opening.
    await expect(drain).resolves.toMatchObject({ sent: 0, deferred: 1 })
  })

  it('does nothing when the pump is stopped', async () => {
    /*
     * The guard is not cosmetic.
     *
     * OBS keeps emitting while the application shuts down, and a drain launched
     * after the database is closed fails inside its own `catch` — which itself
     * writes to the database to defer the batch. The rejection then reached the
     * process, with nobody able to catch it.
     */
    const hub = fakeHub()
    const { pump } = makePump(hub)
    outbox.enqueue(marker('one'))

    // Never started: there is no tick to get ahead of.
    pump.wake()
    await Promise.resolve()
    expect(hub.push).not.toHaveBeenCalled()

    // And not after a stop either: that is the shutdown case.
    pump.start()
    pump.stop()
    pump.wake()
    await Promise.resolve()
    expect(hub.push).not.toHaveBeenCalled()
  })
})
