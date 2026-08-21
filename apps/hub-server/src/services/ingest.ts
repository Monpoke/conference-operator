import { and, asc, desc, eq, sql } from 'drizzle-orm'
import {
  envelopeSchema,
  type Envelope,
  type RoomEventPayload,
} from '@cloudnord/contract'
import { ingestEvent, roomState } from '@cloudnord/db/hub'
import type { HubDatabase, HubTransaction } from '../db.js'

export interface IngestOutcome {
  acked: string[]
  duplicates: string[]
  rejected: { id: string; reason: 'invalid-schema' | 'unknown-room' | 'protocol-too-old' | 'expired' }[]
}

export class IngestService {
  constructor(private readonly db: HubDatabase) {}

  /**
   * Applique un lot remonté par une salle.
   *
   * Idempotent : la clé primaire `(room_id, id)` absorbe les rejeux, et un
   * `onConflictDoNothing` les compte comme doublons plutôt que d'échouer. C'est
   * ce qui autorise le client à rejouer sans réfléchir après une reconnexion.
   *
   * Un événement invalide **sort du lot** au lieu de le faire échouer : un seul
   * message malformé ne doit jamais bloquer la remontée de tous les autres
   * derrière lui.
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
        // Une salle ne remonte que ses propres événements.
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

      // L'état de salle reflète le dernier événement du lot, doublons compris :
      // un rejeu ne doit pas faire régresser la vue de supervision.
      const latest = valid.reduce((a, b) => (b.seq > a.seq ? b : a))
      applyToRoomState(tx, roomId, latest)
    })

    return outcome
  }

  /**
   * Événements remontés par une salle, dans l'ordre d'émission.
   *
   * Alimente le panneau de diagnostic de l'admin — et, plus tard, la
   * reconstitution des timecodes d'un talk pour le montage.
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
   * Messages envoyés par les salles.
   *
   * Lus depuis le journal d'ingestion plutôt que d'une table dédiée : ils
   * arrivent par l'outbox, donc un appel à l'aide émis pendant une coupure est
   * déjà conservé et daté — dupliquer le stockage n'apporterait rien.
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

/** Projette un événement sur la vue de supervision de la salle. */
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
        // `max(...)` ne peut référencer la ligne existante que dans le UPDATE :
        // un lot rejoué dans le désordre ne doit pas faire régresser `last_seq`.
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

/** Récupère un id exploitable d'un événement rejeté, pour que le client le purge. */
function extractId(candidate: unknown): string {
  const id = (candidate as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : 'inconnu'
}
