import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import {
  envelopeSchema,
  type Envelope,
  type ObsInstance,
  type RoomEventPayload,
} from '@cloudnord/contract'
import { ingestEvent, roomState } from '@cloudnord/db/hub'
import type { HubDatabase, HubTransaction } from '../db.js'

export interface IngestOutcome {
  acked: string[]
  duplicates: string[]
  rejected: { id: string; reason: 'invalid-schema' | 'unknown-room' | 'protocol-too-old' | 'expired' }[]
}

/**
 * Une prise recomposée, avant tout rattachement à un créneau.
 *
 * `CaptureView` du contrat porte en plus le `rattachement`, qui n'a de sens
 * qu'une fois qu'on a choisi une conférence : c'est le routeur qui le pose, pas
 * le journal.
 */
export interface CaptationBrute {
  roomId: string
  obs: ObsInstance
  sessionId: string | null
  startedAt: string
  endedAt: string | null
  durationMs: number | null
  file: string | null
  sidecarWritten: boolean
  enCours: boolean
  /** Ouverte, puis supplantée par une autre : son arrêt ne viendra jamais. */
  finInconnue: boolean
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
   * Les prises d'une salle, recomposées depuis le journal d'ingestion.
   *
   * Le hub ne voit jamais le disque de la régie — les salles appellent, jamais
   * l'inverse — mais il a mieux qu'un inventaire : il a les deux bouts de
   * chaque prise. `recording.started` dit qu'OBS s'est mis en marche et sur
   * quel créneau ; `recording.stopped` dit le fichier écrit, sa durée, et si le
   * sidecar a suivi. Les apparier rend exactement ce qu'on cherche : la liste
   * de ce qui existe sur cette machine-là.
   *
   * L'appariement se fait **par instance OBS** : les deux tournent en même
   * temps sur certaines salles, et mélanger leurs paires attribuerait le
   * fichier de l'une à la prise de l'autre. Un `started` sans `stopped` reste
   * ouvert et sort marqué en cours — c'est le cas d'une conférence qui tourne,
   * et celui d'une machine morte en pleine prise, qu'on veut voir tous les
   * deux.
   *
   * Lu à la demande plutôt que projeté dans une table : les prises se comptent
   * en dizaines sur une journée d'événement, là où les heartbeats se comptent
   * en dizaines de milliers, et une projection de plus serait une chose de plus
   * à garder juste.
   */
  captations(roomId: string): CaptationBrute[] {
    const lignes = this.db
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

    const captations: CaptationBrute[] = []
    /** La prise encore ouverte de chaque instance OBS, s'il y en a une. */
    const ouvertes = new Map<string, CaptationBrute>()

    for (const ligne of lignes) {
      const payload = JSON.parse(ligne.payloadJson) as Extract<
        RoomEventPayload,
        { type: 'recording.started' | 'recording.stopped' }
      >
      const obs = payload.obs

      if (payload.type === 'recording.started') {
        /*
         * Deux `started` d'affilée sur la même instance : la salle a redémarré
         * sans qu'on entende l'arrêt. La première prise reste dans la liste —
         * perdre sa trace effacerait un fichier qui existe — mais elle cesse
         * d'être « en cours » : son arrêt n'a pas été entendu, il ne se produira
         * plus. Les laisser actives empilait, sur une salle de développement de
         * trois jours, quatre faux enregistrements en cours au-dessus de la
         * seule ligne qui disait quelque chose.
         */
        const precedente = ouvertes.get(obs)
        if (precedente != null) {
          precedente.enCours = false
          precedente.finInconnue = true
        }
        const captation: CaptationBrute = {
          roomId,
          obs,
          sessionId: payload.sessionId,
          startedAt: ligne.occurredAt,
          endedAt: null,
          durationMs: null,
          file: null,
          sidecarWritten: false,
          enCours: true,
          finInconnue: false,
        }
        ouvertes.set(obs, captation)
        captations.push(captation)
        continue
      }

      const ouverte = ouvertes.get(obs)
      if (ouverte == null) {
        /*
         * Un arrêt sans début connu : le journal commence au milieu d'une prise
         * — hub réinstallé, base repartie de zéro. Le début manque, le fichier
         * non : la ligne vaut d'être rendue, datée de son arrêt.
         */
        captations.push({
          roomId,
          obs,
          sessionId: payload.sessionId,
          startedAt: ligne.occurredAt,
          endedAt: ligne.occurredAt,
          durationMs: payload.durationMs,
          file: payload.outputPath,
          sidecarWritten: payload.sidecarWritten,
          enCours: false,
          finInconnue: false,
        })
        continue
      }

      ouverte.endedAt = ligne.occurredAt
      ouverte.durationMs = payload.durationMs
      ouverte.file = payload.outputPath
      ouverte.sidecarWritten = payload.sidecarWritten
      ouverte.enCours = false
      // L'arrêt sait parfois le créneau que le démarrage ignorait : une prise
      // lancée avant le « Commencer » de la régie n'est estampillée qu'à la fin.
      ouverte.sessionId ??= payload.sessionId
      ouvertes.delete(obs)
    }

    return captations
  }

  /**
   * Oublie tout ce que le hub sait des prises. **Remise à zéro uniquement.**
   *
   * Le RAZ efface le préfixe du bucket et les rushes des salles ; sans ce
   * geste-ci, le hub gardait la mémoire de prises dont plus aucun fichier
   * n'existe, et le dossier VOD d'une conférence continuait de lister des
   * captations effacées la veille. Une remise à zéro qui laisse une moitié de
   * l'état debout n'en est pas une : on la relance, elle ne change rien, et on
   * finit par croire que c'est le bouton qui est cassé.
   *
   * Seuls les deux types de la captation partent. Le reste du journal —
   * heartbeats, messages des salles, changements de scène — n'a rien à voir
   * avec les rushes, et l'effacer perdrait le diagnostic d'une journée sans
   * rien libérer d'utile.
   */
  oublierCaptations(): number {
    const efface = this.db
      .delete(ingestEvent)
      .where(inArray(ingestEvent.type, ['recording.started', 'recording.stopped']))
      .run()
    return efface.changes
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

/** Récupère un id exploitable d'un événement rejeté, pour que le client le purge. */
function extractId(candidate: unknown): string {
  const id = (candidate as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : 'inconnu'
}
