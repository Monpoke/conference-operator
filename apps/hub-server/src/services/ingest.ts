import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  envelopeSchema,
  type Envelope,
  type ObsInstance,
  type RemoteCommandOutcome,
  type RoomEventPayload,
  type VodConsent,
  type VodConsentRecord,
} from '@conference-operator/contract'
import { ingestEvent, roomState, sessionConsent } from '@conference-operator/db/hub'
import type { HubDatabase, HubTransaction } from '../db.js'
import { SILENCE_MS } from './rooms.js'

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
  /**
   * The last command outcome each room reported.
   *
   * In memory and not in `room_state`: it only serves a phone waiting a few
   * seconds for the word on its own gesture, and a hub restarted since has no
   * phone waiting.
   */
  private readonly outcomes = new Map<string, RemoteCommandOutcome>()

  constructor(
    private readonly db: HubDatabase,
    /** A batch was applied: whoever watches this room recomposes its view. */
    private readonly onChange: (roomId: string | null) => void = () => {},
    /** A new `room.message` was stored — a replayed one does not count. */
    private readonly onRoomMessage: () => void = () => {},
    /** A room reported what became of a command it was sent: the audit completes its entry. */
    private readonly onCommandOutcome: (roomId: string, outcome: RemoteCommandOutcome) => void = () => {},
  ) {}

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

    let outcomeMoved = false
    for (const envelope of valid) {
      if (envelope.payload.type !== 'room.heartbeat') continue
      const reported = envelope.payload.lastCommand
      const held = this.outcomes.get(roomId)
      // The highest `seq` wins: a replayed batch must not bring back an older word.
      if (reported == null || (held != null && held.seq >= reported.seq)) continue
      this.outcomes.set(roomId, reported)
      outcomeMoved = true
      this.onCommandOutcome(roomId, reported)
    }

    const before = this.projected(roomId)
    let newMessage = false
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
        else {
          outcome.acked.push(envelope.id)
          if (envelope.payload.type === 'room.message') newMessage = true
        }
      }

      /*
       * Every event of the batch, in emission order, duplicates included.
       *
       * Only the last one used to be projected: a `recording.started` followed in
       * the same batch by a `scene.changed` never reached the supervision view,
       * and the console showed a room mid-capture as not recording. Folding them
       * all in order ends on the same state a replay would: the pump re-sends an
       * unacknowledged batch before any later one, so a replay cannot overwrite
       * something newer.
       */
      for (const envelope of [...valid].sort((a, b) => a.seq - b.seq)) {
        applyToRoomState(tx, roomId, envelope)
        applyConsent(tx, roomId, envelope)
      }
    })

    // After the commit, never inside: a watcher woken mid-transaction would read
    // the state from before.
    if (outcomeMoved || this.moved(before, this.projected(roomId))) this.onChange(roomId)
    if (newMessage) this.onRoomMessage()
    return outcome
  }

  /** The last command outcome the room reported, `null` if it never did. */
  lastCommand(roomId: string): RemoteCommandOutcome | null {
    return this.outcomes.get(roomId) ?? null
  }

  /** The room's projected state, as the watchers would read it. */
  private projected(roomId: string): typeof roomState.$inferSelect | null {
    return this.db.select().from(roomState).where(eq(roomState.roomId, roomId)).get() ?? null
  }

  /**
   * Did the batch change anything a watcher could see?
   *
   * A room reports every couple of seconds, most often to repeat itself: waking
   * every open phone to recompose an identical view was the bulk of the stream's
   * traffic. The receipt time and the sequence always move and say nothing by
   * themselves — except when the room was silent long enough to be shown offline:
   * its return *is* the news.
   */
  private moved(
    before: typeof roomState.$inferSelect | null,
    after: typeof roomState.$inferSelect | null,
  ): boolean {
    if (before == null || after == null) return true
    if (before.lastSeenAt == null || Date.parse(before.lastSeenAt) < Date.now() - SILENCE_MS) return true
    const { lastSeenAt: _before, lastSeq: _beforeSeq, ...was } = before
    const { lastSeenAt: _after, lastSeq: _afterSeq, ...is } = after
    return JSON.stringify(was) !== JSON.stringify(is)
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
  /**
   * A talk's YouTube consent, `null` while nobody has answered.
   *
   * By `sessionId` alone and not by room: the consent belongs to the talk. A slot
   * moved to another room after the fact keeps the answer its speaker gave, which
   * is the only reading that stays true.
   */
  consent(sessionId: string): VodConsentRecord | null {
    const row = this.db
      .select({ statut: sessionConsent.statut, decideA: sessionConsent.decideA })
      .from(sessionConsent)
      .where(eq(sessionConsent.sessionId, sessionId))
      .get()
    return row == null ? null : { statut: row.statut as VodConsent, decideA: row.decideA }
  }

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
   * What the delivery tests read: order kept, nothing duplicated, nothing lost
   * across a cut. No console reads it — the supervision view is `room_state`,
   * which `applyToRoomState` feeds.
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

/**
 * Files a YouTube consent, if that is what the event carries.
 *
 * Stored rather than projected, unlike everything else here: a take is a reading
 * of a disk that can be read again, a consent is an answer given once in front of
 * somebody who has left. See `session_consent`.
 *
 * **Last answer wins, on the room's clock and not on arrival.** A room replays
 * its queue after an outage, and a replayed "accordé" from ten this morning must
 * not overwrite the "refusé" the speaker gave at noon. Comparing `decide_a`
 * settles it whatever order the batches land in — which is exactly the ordering an
 * outbox does not guarantee.
 *
 * A withdrawal deletes the row instead of writing a third value: the absence of a
 * row already says "still to be asked", and two ways of spelling one state is one
 * too many. It is guarded by the same date so that it cannot be replayed over a
 * later answer either.
 */
function applyConsent(tx: HubTransaction, roomId: string, envelope: Envelope): void {
  const payload = envelope.payload
  if (payload.type !== 'vod.consent') return

  const known = tx
    .select({ decideA: sessionConsent.decideA })
    .from(sessionConsent)
    .where(eq(sessionConsent.sessionId, payload.sessionId))
    .get()
  if (known != null && Date.parse(known.decideA) > Date.parse(payload.decideA)) return

  if (payload.consentement == null) {
    tx.delete(sessionConsent).where(eq(sessionConsent.sessionId, payload.sessionId)).run()
    return
  }

  const updatedAt = new Date().toISOString()
  tx.insert(sessionConsent)
    .values({
      sessionId: payload.sessionId,
      statut: payload.consentement,
      decideA: payload.decideA,
      roomId,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: sessionConsent.sessionId,
      set: { statut: payload.consentement, decideA: payload.decideA, roomId, updatedAt },
    })
    .run()
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
        audioInputs: JSON.stringify(payload.audioInputs),
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
      // A health measured on a stream that has stopped describes nothing any more.
      return {
        streaming: false,
        streamBitrateKbps: null,
        streamSkippedRatio: null,
        streamCongestion: null,
        streamHealthAt: null,
      }
    case 'obs.connection':
      return payload.obs === 'A'
        ? { obsAConnected: payload.connected, obsAMissingRoles: JSON.stringify(payload.unresolvedRoles) }
        : { obsBConnected: payload.connected, obsBMissingRoles: JSON.stringify(payload.unresolvedRoles) }
    case 'stream.telemetry':
      return {
        streamBitrateKbps: Math.round(payload.bitrateKbps),
        streamSkippedRatio: payload.skippedRatio,
        streamCongestion: payload.congestion,
        streamHealthAt: new Date().toISOString(),
      }
    default:
      return {}
  }
}

/** Gets a usable id from a rejected event, so the client can purge it. */
function extractId(candidate: unknown): string {
  const id = (candidate as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : 'inconnu'
}
