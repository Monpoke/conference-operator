import { and, asc, count, eq, isNotNull, lte, ne, or, isNull, sql } from 'drizzle-orm'
import { ulid } from 'ulid'
import {
  DELIVERY_BY_EVENT,
  envelopeSchema,
  type Delivery,
  type Envelope,
  type RoomEventPayload,
} from '@cloudnord/contract'
import { outbox } from '@cloudnord/db/client'
import type { LocalStore } from './store.js'

/** Durées de vie par défaut, par politique. */
const TTL_MS: Record<Delivery, number> = {
  // 48 h : largement au-delà de la durée de l'événement, pour qu'un PC resté
  // hors ligne toute la journée remonte quand même son historique le lendemain.
  required: 48 * 60 * 60 * 1000,
  // 30 s : au-delà, une télémétrie ne décrit plus le présent et n'intéresse plus personne.
  'best-effort': 30 * 1000,
}

const BACKOFF_BASE_MS = 1_000
const BACKOFF_CAP_MS = 60_000
/** Plafond de la file. Au-delà, on évince — les `best-effort` d'abord. */
const MAX_DEPTH = 10_000

/**
 * Périodicité du contrôle de saturation.
 *
 * Le vérifier à chaque `enqueue` coûterait une agrégation complète par
 * événement — inacceptable sur une salle bavarde. Contrôler tous les 128
 * suffit : le dépassement toléré entre deux contrôles est négligeable devant
 * le plafond.
 */
const BACKPRESSURE_EVERY = 128

export interface EnqueueOptions {
  /**
   * Clé de collapse. À clé égale, seule la dernière occurrence non envoyée
   * survit : une heure hors ligne ne doit pas accumuler 720 heartbeats.
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
 * File d'attente durable des événements montants.
 *
 * C'est la pièce qui tient la promesse centrale du projet : aucune action de
 * régie ne bloque sur le réseau, et rien d'important n'est perdu quand il tombe.
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
   * Met un événement en file.
   *
   * La politique de livraison n'est pas un paramètre : elle découle du type
   * d'événement (`DELIVERY_BY_EVENT`), pour que l'appelant n'ait pas à la
   * redécider — et à se tromper — à chaque appel.
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
        // Collapse : l'ancienne occurrence non envoyée n'a plus d'intérêt.
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
   * Prochain lot à envoyer, dans l'ordre d'émission.
   *
   * L'ordre par `seq` est strict : le hub applique dans cet ordre, et un
   * `recording.stopped` qui doublerait son `recording.started` fausserait la VOD.
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

  /** Sort définitivement les événements confirmés par le hub. */
  ack(ids: string[]): void {
    if (ids.length === 0) return
    this.db.transaction((tx) => {
      for (const id of ids) tx.delete(outbox).where(eq(outbox.id, id)).run()
    })
  }

  /**
   * Sort un événement rejeté sans espoir, en le traçant dans le journal local.
   *
   * Le laisser en file bloquerait tout ce qui le suit : un seul message
   * malformé ne doit jamais geler la remontée des autres.
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

  /** Reporte un lot après un échec réseau, avec backoff exponentiel et gigue. */
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
   * Purge les événements périmés.
   *
   * Les `best-effort` disparaissent vite et sans regret. Les `required` ne
   * partent qu'après 48 h, et laissent une trace au journal : perdre un
   * marqueur de talk en silence rendrait le montage inexplicable.
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
   * Évince quand la file sature, en commençant par ce qui compte le moins.
   *
   * Si même la part `required` déborde, on ne supprime rien : on laisse la file
   * grossir et l'alerte remonter en régie. Jeter un enregistrement pour tenir
   * un quota serait le pire compromis possible.
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
   * Ce qui attend réellement d'être remonté, hors battement.
   *
   * Le battement de salle se réinscrit toutes les 10 s et repart au drain
   * suivant. Le compter fait osciller l'indicateur entre 0 et 1 en permanence
   * — et chaque bascule republie l'état à toutes les pages abonnées — alors
   * que l'indicateur existe pour signaler du travail qui **s'accumule**.
   *
   * `depth()` reste le total réel : c'est lui qui régit la contre-pression.
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

/** Clé de collapse d'un heartbeat : une seule occurrence en attente par salle. */
export function heartbeatDedupKey(roomId: string): string {
  return `room.heartbeat:${roomId}`
}

/** Exponentiel plafonné, avec ±20 % de gigue pour ne pas synchroniser les salles. */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_CAP_MS)
  const jitter = base * 0.2 * (random() * 2 - 1)
  return Math.max(0, Math.round(base + jitter))
}
