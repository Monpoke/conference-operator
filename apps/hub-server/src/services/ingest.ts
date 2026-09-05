import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  envelopeSchema,
  type Envelope,
  type ObsInstance,
  type RoomEventPayload,
} from '@conference-operator/contract'
import { ingestEvent, roomState } from '@conference-operator/db/hub'
import type { HubDatabase, HubTransaction } from '../db.js'

export interface IngestOutcome {
  acked: string[]
  duplicates: string[]
  rejected: { id: string; reason: 'invalid-schema' | 'unknown-room' | 'protocol-too-old' | 'expired' }[]
}

/**
 * A reconstructed take, before it is attached to any slot.
 *
 * The contract's `CaptureView` also carries `rattachement`, which only makes
 * sense once a talk has been chosen: the router sets it, not the log.
 */
export interface RawCapture {
  roomId: string
  obs: ObsInstance
  sessionId: string | null
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  file: string | null
  sidecarWritten: boolean
  enCours: boolean
  /** Opened, then superseded by another: its stop will never come. */
  finInconnue: boolean
}

export class IngestService {
  constructor(private readonly db: HubDatabase) {}

  /**
   * Applies a batch reported by a room.
   *
   * Idempotent: the `(room_id, id)` primary key absorbs replays, and an
   * `onConflictDoNothing` counts them as duplicates rather than failing. That is
   * what lets the client replay without thinking after a reconnection.
   *
   * An invalid event **leaves the batch** instead of failing it: a single
   * malformed message must never block the reporting of all the others behind it.
   */
  push(roomId: string, batch: unknown[]): IngestOutcome {
    const outcome: IngestOutcome = { acked: [], duplicates: [], rejected: [] }
    const valid: Envelope[] = []

    for (const candidate of batch) {
      const parsed = envelopeSchema.safeParse(candidate)
      if (!parsed.success) {
        const id = extractId(candidate)
        outcome.rejected.push({ id, reason: 'invalid-schema' })
        continue
      }
      if (parsed.data.roomId !== roomId) {
        // A room only reports its own events.
        outcome.rejected.push({ id: parsed.data.id, reason: 'unknown-room' })
        continue
      }
      valid.push(parsed.data)
    }

    if (valid.length === 0) return outcome

    this.db.transaction((tx) => {
      for (const envelope of valid) {
        const inserted = tx
          .insert(ingestEvent)
          .values({
            roomId: envelope.roomId,
            id: envelope.id,
            seq: envelope.seq,
            type: envelope.payload.type,
            delivery: envelope.delivery,
            occurredAt: envelope.occurredAt,
            monotonicMs: Math.round(envelope.monotonicMs),
            payloadJson: JSON.stringify(envelope.payload),
          })
          .onConflictDoNothing()
          .returning({ id: ingestEvent.id })
          .all()

        if (inserted.length === 0) outcome.duplicates.push(envelope.id)
        else outcome.acked.push(envelope.id)
      }

      // The room state reflects the last event of the batch, duplicates included:
      // a replay must not make the supervision view regress.
      const latest = valid.reduce((a, b) => (b.seq > a.seq ? b : a))
      applyToRoomState(tx, roomId, latest)
    })

    return outcome
  }

  /**
   * A room's takes, reconstructed from the ingestion log.
   *
   * The hub never sees the control machine's disk — the rooms call, never the
   * other way round — but it has better than an inventory: it has both ends of
   * every take. `recording.started` says OBS got going and on which slot;
   * `recording.stopped` says the file written, its duration, and whether the
   * sidecar followed. Pairing them returns exactly what we are after: the list of
   * what exists on that machine.
   *
   * Pairing is done **per OBS instance**: both run at the same time in some
   * rooms, and mixing their pairs would attribute one's file to the other's take.
   * A `started` with no `stopped` stays open and comes out marked as running —
   * that is the case of a running talk, and that of a machine that died mid-take,
   * and we want to see both.
   *
   * Read on demand rather than projected into a table: takes are counted in tens
   * over an event day, where heartbeats are counted in tens of thousands, and one
   * more projection would be one more thing to keep correct.
   */
  captations(roomId: string): RawCapture[] {
    const rows = this.db
      .select({
        seq: ingestEvent.seq,
        type: ingestEvent.type,
        occurredAt: ingestEvent.occurredAt,
        payloadJson: ingestEvent.payloadJson,
      })
      .from(ingestEvent)
      .where(
        and(
          eq(ingestEvent.roomId, roomId),
          inArray(ingestEvent.type, ['recording.started', 'recording.stopped']),
        ),
      )
      .orderBy(asc(ingestEvent.seq))
      .all()

    const captures: RawCapture[] = []
    /** The still-open take of each OBS instance, if there is one. */
    const open = new Map<string, RawCapture>()

    for (const row of rows) {
      const payload = JSON.parse(row.payloadJson) as Extract<
        RoomEventPayload,
        { type: 'recording.started' | 'recording.stopped' }
      >
      const obs = payload.obs

      if (payload.type === 'recording.started') {
        /*
         * Two `started` in a row on the same instance: the room restarted without
         * us hearing the stop. The first take stays in the list — losing its
         * trace would erase a file that exists — but it stops being "running":
         * its stop was not heard, and will not happen. Leaving them active piled
         * up, on a three-day development room, four false recordings in progress
         * on top of the one row that said something.
         */
        const previous = open.get(obs)
        if (previous != null) {
          previous.enCours = false
          previous.finInconnue = true
        }
        const capture: RawCapture = {
          roomId,
          obs,
          sessionId: payload.sessionId,
          startedAt: row.occurredAt,
          endedAt: null,
          durationMs: null,
          file: null,
          sidecarWritten: false,
          enCours: true,
          finInconnue: false,
        }
        open.set(obs, capture)
        captures.push(capture)
        continue
      }

      const current = open.get(obs)
      if (current == null) {
        /*
         * A stop with no known start: the log begins in the middle of a take —
         * hub reinstalled, database started from scratch. The start is missing,
         * the file is not: the row is worth returning, dated from its stop.
         */
        captures.push({
          roomId,
          obs,
          sessionId: payload.sessionId,
          startedAt: row.occurredAt,
          endedAt: row.occurredAt,
          durationMs: payload.durationMs,
          file: payload.outputPath,
          sidecarWritten: payload.sidecarWritten,
          enCours: false,
          finInconnue: false,
        })
        continue
      }

      current.endedAt = row.occurredAt
      current.durationMs = payload.durationMs
      current.file = payload.outputPath
      current.sidecarWritten = payload.sidecarWritten
      current.enCours = false
      // The stop sometimes knows the slot the start did not: a take launched
      // before the control app's "Start" is only stamped at the end.
      current.sessionId ??= payload.sessionId
      open.delete(obs)
    }

    return captures
  }

  /**
   * Forgets everything the hub knows about the takes. **Reset only.**
   *
   * The reset erases the bucket prefix and the rooms' rushes; without this
   * gesture, the hub kept the memory of takes whose files no longer exist, and a
   * talk's VOD folder kept listing captures erased the day before. A reset that
   * leaves half the state standing is not one: you run it again, it changes
   * nothing, and you end up believing the button is broken.
   *
   * Only the two capture types go. The rest of the log — heartbeats, room
   * messages, scene changes — has nothing to do with the rushes, and erasing it
   * would lose a day's diagnosis without freeing anything useful.
   */
  forgetCaptures(): number {
    const deleted = this.db
      .delete(ingestEvent)
      .where(inArray(ingestEvent.type, ['recording.started', 'recording.stopped']))
      .run()
    return deleted.changes
  }

  /**
   * Events reported by a room, in the order they were emitted.
   *
   * Feeds the admin console's diagnostics panel — and, later, the reconstruction
   * of a talk's timecodes for editing.
   */
  eventsFor(roomId: string) {
    return this.db
      .select({
        id: ingestEvent.id,
        seq: ingestEvent.seq,
        type: ingestEvent.type,
        occurredAt: ingestEvent.occurredAt,
        receivedAt: ingestEvent.receivedAt,
      })
      .from(ingestEvent)
      .where(eq(ingestEvent.roomId, roomId))
      .orderBy(asc(ingestEvent.seq))
      .all()
  }

  /**
   * Messages sent by the rooms.
   *
   * Read from the ingestion log rather than a dedicated table: they arrive
   * through the outbox, so a call for help sent during an outage is already kept
   * and dated — duplicating the storage would bring nothing.
   */
  messagesFromRooms(limit = 50) {
    return this.db
      .select({
        id: ingestEvent.id,
        roomId: ingestEvent.roomId,
        payloadJson: ingestEvent.payloadJson,
        occurredAt: ingestEvent.occurredAt,
        receivedAt: ingestEvent.receivedAt,
      })
      .from(ingestEvent)
      .where(eq(ingestEvent.type, 'room.message'))
      .orderBy(desc(ingestEvent.receivedAt))
      .limit(limit)
      .all()
      .map((row) => {
        const payload = JSON.parse(row.payloadJson) as { text: string; level: string }
        return {
          id: row.id,
          roomId: row.roomId,
          text: payload.text,
          level: payload.level as 'info' | 'warning' | 'urgent',
          occurredAt: row.occurredAt,
          receivedAt: row.receivedAt,
        }
      })
  }
}

/** Projects an event onto the room's supervision view. */
function applyToRoomState(
  tx: HubTransaction,
  roomId: string,
  envelope: Envelope,
): void {
  const projection = projectionFor(envelope.payload)
  const lastSeenAt = new Date().toISOString()

  tx.insert(roomState)
    .values({ roomId, lastSeenAt, lastSeq: envelope.seq, ...projection })
    .onConflictDoUpdate({
      target: roomState.roomId,
      set: {
        lastSeenAt,
        // `max(...)` can only reference the existing row in the UPDATE: a batch
        // replayed out of order must not make `last_seq` regress.
        lastSeq: sql`max(${roomState.lastSeq}, ${envelope.seq})`,
        ...projection,
      },
    })
    .run()
}

function projectionFor(payload: RoomEventPayload): Record<string, unknown> {
  switch (payload.type) {
    case 'room.heartbeat':
      return {
        connectivity: payload.connectivity,
        sceneRole: payload.sceneRole,
        recording: payload.recording,
        streaming: payload.streaming,
        outboxDepth: payload.outboxDepth,
        programContentHash: payload.programContentHash,
        displayMode: payload.displayMode,
      }
    case 'scene.changed':
      return payload.role != null ? { sceneRole: payload.role } : {}
    case 'recording.started':
      return { recording: true, currentSessionId: payload.sessionId }
    case 'recording.stopped':
      return { recording: false }
    case 'stream.started':
      return { streaming: true }
    case 'stream.stopped':
      return { streaming: false }
    default:
      return {}
  }
}

/** Gets a usable id from a rejected event, so the client can purge it. */
function extractId(candidate: unknown): string {
  const id = (candidate as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : 'inconnu'
}
