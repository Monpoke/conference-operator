import { and, asc, count, eq, isNotNull, lte, ne, or, isNull, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  DELIVERY_BY_EVENT,
  envelopeSchema,
  type Delivery,
  type Envelope,
  type RoomEventPayload,
} from '@conference-operator/contract'
import { outbox } from '@conference-operator/db/client'
import type { LocalStore } from './store.js'

/** Default lifetimes, per delivery policy. */
const TTL_MS: Record<Delivery, number> = {
  // 48 h: well beyond the event's duration, so that a machine left offline all
  // day still sends its history up the next morning.
  required: 48 * 60 * 60 * 1000,
  // 30 s: beyond that, telemetry no longer describes the present and interests nobody.
  'best-effort': 30 * 1000,
}

const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS = 60_000
/** The queue's ceiling. Beyond it we evict — the `best-effort` ones first. */
const MAX_DEPTH = 10_000

/**
 * How often the saturation check runs.
 *
 * Checking on every `enqueue` would cost a full aggregation per event —
 * unacceptable on a chatty room. Checking every 128 is enough: the overshoot
 * tolerated between two checks is negligible against the ceiling.
 */
const BACKPRESSURE_EVERY = 128

export interface EnqueueOptions {
  /**
   * The collapse key. At equal keys, only the last unsent occurrence survives: an
   * hour offline must not pile up 720 heartbeats.
   */
  dedupKey?: string
  ttlMs?: number
}

export interface OutboxStats {
  total: number
  required: number
  bestEffort: number
}

/**
 * The durable queue of upward events.
 *
 * It is the piece that holds the project's central promise: no control-room
 * action blocks on the network, and nothing important is lost when it goes down.
 */
export class Outbox {
  private sinceLastCheck = 0

  constructor(
    private readonly store: LocalStore,
    private readonly roomId: string,
    private readonly now: () => number = Date.now,
    private readonly maxDepth: number = MAX_DEPTH,
  ) {}

  private get db() {
    return this.store.db
  }

  /**
   * Queues an event.
   *
   * The delivery policy is not a parameter: it follows from the event's type
   * (`DELIVERY_BY_EVENT`), so that the caller does not have to decide it again —
   * and get it wrong — on every call.
   */
  enqueue(payload: RoomEventPayload, options: EnqueueOptions = {}): Envelope {
    const delivery = DELIVERY_BY_EVENT[payload.type]
    const nowMs = this.now()
    const ttlMs = options.ttlMs ?? TTL_MS[delivery]

    const envelope: Envelope = {
      id: ulid(nowMs),
      roomId: this.roomId,
      seq: this.store.nextOutboundSeq(),
      occurredAt: new Date(nowMs + this.store.settings().clockOffsetMs).toISOString(),
      monotonicMs: nowMs,
      delivery,
      ...(options.dedupKey != null ? { dedupKey: options.dedupKey } : {}),
      expiresAt: new Date(nowMs + ttlMs).toISOString(),
      payload,
    }

    this.db.transaction((tx) => {
      if (options.dedupKey != null) {
        // Collapse: the old unsent occurrence is of no further interest.
        tx.delete(outbox)
          .where(and(eq(outbox.roomId, this.roomId), eq(outbox.dedupKey, options.dedupKey)))
          .run()
      }
      tx.insert(outbox)
        .values({
          id: envelope.id,
          roomId: envelope.roomId,
          seq: envelope.seq,
          type: payload.type,
          delivery,
          payloadJson: JSON.stringify(payload),
          occurredAt: envelope.occurredAt,
          monotonicMs: Math.round(envelope.monotonicMs),
          dedupKey: options.dedupKey ?? null,
          expiresAt: envelope.expiresAt ?? null,
          nextAttemptAt: new Date(nowMs).toISOString(),
        })
        .run()
    })

    this.sinceLastCheck += 1
    if (this.sinceLastCheck >= BACKPRESSURE_EVERY) {
      this.sinceLastCheck = 0
      this.applyBackpressure()
    }
    return envelope
  }

  /**
   * The next batch to send, in emission order.
   *
   * The order by `seq` is strict: the hub applies in that order, and a
   * `recording.stopped` overtaking its `recording.started` would skew the VOD.
   */
  claimBatch(limit = 100): Envelope[] {
    const nowIso = new Date(this.now()).toISOString()
    return this.db
      .select()
      .from(outbox)
      .where(and(eq(outbox.roomId, this.roomId), lte(outbox.nextAttemptAt, nowIso)))
      .orderBy(asc(outbox.seq))
      .limit(limit)
      .all()
      .map((row) =>
        envelopeSchema.parse({
          id: row.id,
          roomId: row.roomId,
          seq: row.seq,
          occurredAt: row.occurredAt,
          monotonicMs: row.monotonicMs,
          delivery: row.delivery,
          ...(row.dedupKey != null ? { dedupKey: row.dedupKey } : {}),
          ...(row.expiresAt != null ? { expiresAt: row.expiresAt } : {}),
          payload: JSON.parse(row.payloadJson),
        }),
      )
  }

  /** Permanently removes the events the hub has confirmed. */
  ack(ids: string[]): void {
    if (ids.length === 0) return
    this.db.transaction((tx) => {
      for (const id of ids) tx.delete(outbox).where(eq(outbox.id, id)).run()
    })
  }

  /**
   * Removes a hopelessly rejected event, tracing it in the local log.
   *
   * Leaving it in the queue would block everything behind it: a single malformed
   * message must never freeze the others from going up.
   */
  reject(entries: { id: string; reason: string }[]): void {
    if (entries.length === 0) return
    this.db.transaction((tx) => {
      for (const entry of entries) {
        const row = tx.select().from(outbox).where(eq(outbox.id, entry.id)).get()
        tx.delete(outbox).where(eq(outbox.id, entry.id)).run()
        this.store.log('warn', `événement rejeté par le hub : ${entry.reason}`, {
          id: entry.id,
          type: row?.type ?? null,
        }, tx)
      }
    })
  }

  /** Defers a batch after a network failure, with exponential backoff and jitter. */
  defer(ids: string[]): void {
    if (ids.length === 0) return
    const nowMs = this.now()

    this.db.transaction((tx) => {
      for (const id of ids) {
        const row = tx.select().from(outbox).where(eq(outbox.id, id)).get()
        if (row == null) continue
        const attempts = row.attempts + 1
        tx.update(outbox)
          .set({
            attempts,
            nextAttemptAt: new Date(nowMs + backoffMs(attempts)).toISOString(),
          })
          .where(eq(outbox.id, id))
          .run()
      }
    })
  }

  /**
   * Purges the expired events.
   *
   * The `best-effort` ones disappear quickly and without regret. The `required`
   * ones only leave after 48 h, and leave a trace in the log: losing a talk marker
   * silently would make the editing inexplicable.
   */
  evictExpired(): { dropped: number } {
    const nowIso = new Date(this.now()).toISOString()
    const expired = this.db
      .select()
      .from(outbox)
      .where(and(isNotNull(outbox.expiresAt), lte(outbox.expiresAt, nowIso)))
      .all()

    if (expired.length === 0) return { dropped: 0 }

    this.db.transaction((tx) => {
      for (const row of expired) {
        tx.delete(outbox).where(eq(outbox.id, row.id)).run()
        if (row.delivery === 'required') {
          this.store.log('error', 'événement obligatoire expiré sans avoir été remonté', {
            id: row.id,
            type: row.type,
            attempts: row.attempts,
          }, tx)
        }
      }
    })
    return { dropped: expired.length }
  }

  /**
   * Evicts when the queue saturates, starting with what counts least.
   *
   * If even the `required` share overflows, we delete nothing: we let the queue
   * grow and the alert go up to the control room. Throwing away a recording to
   * hold a quota would be the worst possible trade.
   */
  private applyBackpressure(): void {
    const stats = this.stats()
    if (stats.total <= this.maxDepth) return

    const surplus = stats.total - this.maxDepth
    const evictable = this.db
      .select({ id: outbox.id })
      .from(outbox)
      .where(eq(outbox.delivery, 'best-effort'))
      .orderBy(asc(outbox.seq))
      .limit(surplus)
      .all()

    if (evictable.length === 0) {
      this.store.log('error', 'file de remontée saturée en événements obligatoires', {
        total: stats.total,
      })
      return
    }
    this.ack(evictable.map((row) => row.id))
  }

  stats(): OutboxStats {
    const rows = this.db
      .select({ delivery: outbox.delivery, n: count() })
      .from(outbox)
      .where(eq(outbox.roomId, this.roomId))
      .groupBy(outbox.delivery)
      .all()

    const required = rows.find((row) => row.delivery === 'required')?.n ?? 0
    const bestEffort = rows.find((row) => row.delivery === 'best-effort')?.n ?? 0
    return { total: required + bestEffort, required, bestEffort }
  }

  depth(): number {
    return this.stats().total
  }

  /**
   * What is really waiting to go up, heartbeat aside.
   *
   * The room's heartbeat re-enqueues itself every 10 s and leaves at the next
   * drain. Counting it makes the indicator oscillate between 0 and 1 permanently
   * — and every switch republishes the state to every subscribed page — whereas
   * the indicator exists to report work that **piles up**.
   *
   * `depth()` stays the real total: it is what governs the backpressure.
   */
  backlog(): number {
    const [row] = this.db
      .select({ n: count() })
      .from(outbox)
      .where(
        and(
          eq(outbox.roomId, this.roomId),
          or(isNull(outbox.dedupKey), ne(outbox.dedupKey, heartbeatDedupKey(this.roomId))),
        ),
      )
      .all()
    return row?.n ?? 0
  }
}

/** A heartbeat's collapse key: a single pending occurrence per room. */
export function heartbeatDedupKey(roomId: string): string {
  return `room.heartbeat:${roomId}`
}

/** Capped exponential, with ±20 % jitter so the rooms do not synchronize. */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS)
  const jitter = base * 0.2 * (random() * 2 - 1)
  return Math.max(0, Math.round(base + jitter))
}
