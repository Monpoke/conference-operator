import { EventEmitter, on } from 'node:events'
import { and, asc, desc, eq, gt, isNull, or } from 'drizzle-orm'
import { commandSchema, type Command, type CommandPayloadInput } from '@conference-operator/contract'
import { command } from '@conference-operator/db/hub'
import type { HubDatabase } from '../db.js'

/** Internal envelope: the command plus its target, to filter the fanout. */
interface Dispatched {
  roomId: string | null
  command: Command
}

const CHANNEL = 'command'

/**
 * Downstream command bus.
 *
 * The fanout is a plain in-process `EventEmitter`: the hub runs as a single
 * instance (an assumed constraint of the SQLite choice), so every WebSocket
 * connection lives in the same process. No Redis to maintain in order to
 * broadcast to three rooms.
 *
 * One channel for everyone, with filtering by room at consumption time: a global
 * broadcast must reach all three rooms, and one channel per room would force the
 * publisher to know the list of connected rooms.
 */
export class CommandService {
  private readonly emitter = new EventEmitter()

  constructor(
    private readonly db: HubDatabase,
    /** Command timestamping: it is what the staleness filter works from. */
    private readonly now: () => number = Date.now,
  ) {
    // Three rooms, plus the screens and the admin console: the default limit of
    // 10 is reached quickly.
    this.emitter.setMaxListeners(64)
  }

  /**
   * Banners that have already been on air, most recent first.
   *
   * Read from the commands issued rather than copied elsewhere: they are already
   * persisted, dated and ordered. A second table could only diverge from what
   * actually went out to the rooms.
   *
   * Removals (`message: null`) are not history — you do not put "nothing" back on
   * air — but the most recent one says **which** banner is still shown.
   */
  pastBanners(roomId: string | null, limit: number): {
    seq: number
    roomId: string | null
    payload: { type: 'overlay.set'; message: { text: string; level: string } | null }
    issuedAt: string
  }[] {
    return this.db
      .select()
      .from(command)
      .where(eq(command.type, 'overlay.set'))
      .orderBy(desc(command.seq))
      .limit(limit * 2)
      .all()
      .filter((row) => roomId == null || row.roomId == null || row.roomId === roomId)
      .map((row) => ({
        seq: row.seq,
        roomId: row.roomId,
        payload: JSON.parse(row.payloadJson) as {
          type: 'overlay.set'
          message: { text: string; level: string } | null
        },
        issuedAt: row.issuedAt,
      }))
  }

  /**
   * Publishes a command. `roomId === null` broadcasts to every room.
   *
   * The `seq` is assigned by the database (auto-incremented key, globally
   * monotonic) and acts as the oRPC event identifier: it is what the client sends
   * back as `lastEventId` to resume after an outage.
   */
  publish(
    roomId: string | null,
    payload: CommandPayloadInput,
    ttlSeconds: number | null,
  ): Command {
    const issuedAt = new Date(this.now()).toISOString()
    const inserted = this.db
      .insert(command)
      .values({
        roomId,
        type: payload.type,
        payloadJson: JSON.stringify(payload),
        ttlSeconds,
        issuedAt,
      })
      .returning({ seq: command.seq })
      .get()

    const issued = commandSchema.parse({ seq: inserted.seq, issuedAt, ttlSeconds, payload })
    this.emitter.emit(CHANNEL, { roomId, command: issued } satisfies Dispatched)
    return issued
  }

  /** A room's commands after `sinceSeq`, global broadcasts included. */
  backlog(roomId: string, sinceSeq: number): Command[] {
    return this.db
      .select()
      .from(command)
      .where(
        and(or(eq(command.roomId, roomId), isNull(command.roomId)), gt(command.seq, sinceSeq)),
      )
      .orderBy(asc(command.seq))
      .all()
      .map((row) =>
        commandSchema.parse({
          seq: row.seq,
          issuedAt: row.issuedAt,
          ttlSeconds: row.ttlSeconds,
          payload: JSON.parse(row.payloadJson),
        }),
      )
  }

  /**
   * A room's flow: catch-up then real time, through the same path.
   *
   * `sinceSeq` comes from the `lastEventId` oRPC provides on reconnection — the
   * client has no catch-up counter to manage itself.
   */
  async *stream(roomId: string, sinceSeq: number, signal?: AbortSignal): AsyncGenerator<Command> {
    // Subscribe *before* reading the backlog: a command published between the two
    // would otherwise fall into a gap nobody would notice.
    const live = on(this.emitter, CHANNEL, { signal })

    let lastSeq = sinceSeq
    for (const pending of this.backlog(roomId, sinceSeq)) {
      lastSeq = pending.seq
      yield pending
    }

    try {
      for await (const [event] of live) {
        const { roomId: target, command: issued } = event as Dispatched
        if (target != null && target !== roomId) continue
        // The backlog may already have delivered this command: do not repeat it.
        if (issued.seq <= lastSeq) continue
        lastSeq = issued.seq
        yield issued
      }
    } catch (cause) {
      // `on()` rejects with AbortError on disconnection: that is a normal end.
      if ((cause as Error)?.name !== 'AbortError') throw cause
    }
  }
}
