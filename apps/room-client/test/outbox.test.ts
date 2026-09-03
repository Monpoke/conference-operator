import { beforeEach, describe, expect, it } from 'vitest'
import type { RoomEventPayload } from '@cloudnord/contract'
import { LocalStore } from '../src/core/store.js'
import { Outbox, backoffMs, heartbeatDedupKey } from '../src/core/outbox.js'

const TRACK_1 = 'track-1-teilhard-de-chardin'

let store: LocalStore
let clockMs: number
let outbox: Outbox

beforeEach(() => {
  store = new LocalStore(':memory:')
  clockMs = Date.parse('2026-10-30T09:00:00.000Z')
  outbox = new Outbox(store, TRACK_1, () => clockMs)
})

const heartbeat = (outboxDepth = 0): RoomEventPayload => ({
  type: 'room.heartbeat',
  connectivity: 'ONLINE',
  sceneRole: 'HOLD',
  recording: false,
  streaming: false,
  displayMode: 'loop',
  outboxDepth,
  programContentHash: 'hash-1',
})

const marker = (label: string): RoomEventPayload => ({
  type: 'talk.marker',
  sessionId: 'ses-1',
  label,
  offsetMs: 90_000,
})

describe('delivery policies', () => {
  it('derives the policy from the event type', () => {
    // The caller does not choose: the type decides, once and for all.
    expect(outbox.enqueue(marker('demo')).delivery).toBe('required')
    expect(outbox.enqueue(heartbeat()).delivery).toBe('best-effort')
  })

  it('numbers the events in emission order', () => {
    const first = outbox.enqueue(marker('one'))
    const second = outbox.enqueue(marker('two'))

    expect(second.seq).toBe(first.seq + 1)
    expect(outbox.claimBatch().map((e) => e.seq)).toEqual([first.seq, second.seq])
  })

  it('timestamps with the corrected clock, not the PC\'s', () => {
    store.saveSettings({ clockOffsetMs: 40 * 60_000 })
    const envelope = outbox.enqueue(marker('demo'))
    // The VOD timecodes depend on that correction.
    expect(envelope.occurredAt).toBe('2026-10-30T09:40:00.000Z')
  })
})

describe('collapsing disposable events', () => {
  it('keeps only the last occurrence per key', () => {
    for (let i = 1; i <= 720; i += 1) {
      outbox.enqueue(heartbeat(i), { dedupKey: 'heartbeat' })
    }
    // An hour offline must not pile up 720 heartbeats.
    const pending = outbox.claimBatch()
    expect(pending).toHaveLength(1)
    expect((pending[0]!.payload as { outboxDepth: number }).outboxDepth).toBe(720)
  })

  it('does not affect events with no key', () => {
    outbox.enqueue(marker('one'))
    outbox.enqueue(marker('two'))
    expect(outbox.depth()).toBe(2)
  })
})

describe('uplink and replay', () => {
  it('removes the acknowledged events', () => {
    const a = outbox.enqueue(marker('one'))
    const b = outbox.enqueue(marker('two'))

    outbox.ack([a.id])
    expect(outbox.claimBatch().map((e) => e.id)).toEqual([b.id])
  })

  it('defers a failed batch with a growing backoff', () => {
    const envelope = outbox.enqueue(marker('demo'))

    outbox.defer([envelope.id])
    // Deferred: nothing left to send right away.
    expect(outbox.claimBatch()).toHaveLength(0)

    clockMs += 5_000
    expect(outbox.claimBatch().map((e) => e.id)).toEqual([envelope.id])
  })

  it('removes a definitively rejected event without blocking the queue', () => {
    const broken = outbox.enqueue(marker('malformed'))
    const sound = outbox.enqueue(marker('sound'))

    outbox.reject([{ id: broken.id, reason: 'invalid-schema' }])

    // Leaving it at the head would block everything behind it.
    expect(outbox.claimBatch().map((e) => e.id)).toEqual([sound.id])
    expect(store.recentLogs()[0]?.message).toContain('rejeté par le hub')
  })
})

describe('expiry', () => {
  it('drops stale telemetry without a sound', () => {
    outbox.enqueue(heartbeat(), { dedupKey: 'heartbeat' })

    clockMs += 31_000
    expect(outbox.evictExpired().dropped).toBe(1)
    expect(outbox.depth()).toBe(0)
    // Nothing in the log: stale telemetry interests nobody.
    expect(store.recentLogs().filter((l) => l.level === 'error')).toHaveLength(0)
  })

  it('keeps a required event for 48 h', () => {
    outbox.enqueue(marker('demo'))

    clockMs += 47 * 60 * 60 * 1000
    expect(outbox.evictExpired().dropped).toBe(0)
    expect(outbox.depth()).toBe(1)
  })

  it('logs a lost required event loudly', () => {
    outbox.enqueue(marker('demo'))

    clockMs += 49 * 60 * 60 * 1000
    expect(outbox.evictExpired().dropped).toBe(1)

    // Losing a talk marker in silence would make the editing inexplicable.
    const error = store.recentLogs().find((l) => l.level === 'error')
    expect(error?.message).toContain('obligatoire expiré')
    expect(error?.contextJson).toContain('talk.marker')
  })
})

describe('queue saturation', () => {
  /** Lowered ceiling: the behaviour is the same, the test stays fast. */
  const smallOutbox = () => new Outbox(store, TRACK_1, () => clockMs, 200)

  it('evicts telemetry before anything else', () => {
    const small = smallOutbox()
    // Distinct keys: no collapsing, the queue really fills up.
    for (let i = 0; i < 400; i += 1) small.enqueue(heartbeat(i), { dedupKey: `hb-${i}` })

    expect(small.stats().total).toBeLessThanOrEqual(200 + 128)
    expect(small.stats().required).toBe(0)
  })

  it('never sacrifices a required event to hold the quota', () => {
    const small = smallOutbox()
    for (let i = 0; i < 400; i += 1) small.enqueue(marker(`marker-${i}`))

    // Dropping a recording to hold a quota would be the worst possible trade:
    // the queue grows and the alert reaches the control app instead.
    expect(small.stats().required).toBe(400)
    expect(store.recentLogs()[0]?.message).toContain('saturée')
  })
})

describe('backoff', () => {
  it('grows exponentially then levels off', () => {
    const noJitter = () => 0.5
    expect(backoffMs(1, noJitter)).toBe(1_000)
    expect(backoffMs(2, noJitter)).toBe(2_000)
    expect(backoffMs(5, noJitter)).toBe(16_000)
    expect(backoffMs(20, noJitter)).toBe(60_000)
  })

  it('applies jitter so the three rooms do not synchronise', () => {
    // With no jitter, three rooms cut off together would come back and hit the
    // hub at exactly the same instant on every attempt.
    expect(backoffMs(4, () => 0)).toBeLessThan(8_000)
    expect(backoffMs(4, () => 1)).toBeGreaterThan(8_000)
  })
})

describe('displayed uplink backlog', () => {
  it('ignores the heartbeat, which renews itself indefinitely', () => {
    // The heartbeat re-enqueues every 10 s and leaves on the next drain. Counting
    // it made the indicator swing between 0 and 1 permanently, and every swing
    // republished the whole state to every subscribed page.
    outbox.enqueue(heartbeat(), { dedupKey: heartbeatDedupKey(TRACK_1) })
    expect(outbox.depth()).toBe(1)
    expect(outbox.backlog()).toBe(0)
  })

  it('counts everything that reflects a real backlog', () => {
    outbox.enqueue(heartbeat(), { dedupKey: heartbeatDedupKey(TRACK_1) })
    outbox.enqueue(marker('chapter 1'))
    outbox.enqueue(marker('chapter 2'))
    // A marker not reported is lost work if it never leaves: it counts.
    expect(outbox.backlog()).toBe(2)
    expect(outbox.depth()).toBe(3)
  })

  it("does not mask another room's heartbeat", () => {
    // The key names the room: masking by prefix would have erased a neighbouring
    // room's backlog when it shares the same database as a fallback.
    outbox.enqueue(heartbeat(), { dedupKey: heartbeatDedupKey('another-room') })
    expect(outbox.backlog()).toBe(1)
  })
})
