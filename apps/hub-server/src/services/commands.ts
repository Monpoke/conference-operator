import { EventEmitter, on } from 'node:events'
import { and, asc, desc, eq, gt, isNull, or } from 'drizzle-orm'
import { commandSchema, type Command, type CommandPayloadInput } from '@cloudnord/contract'
import { command } from '@cloudnord/db/hub'
import type { HubDatabase } from '../db.js'

/** Enveloppe interne : la commande plus sa cible, pour filtrer le fanout. */
interface Dispatched {
  roomId: string | null
  command: Command
}

const CHANNEL = 'command'

/**
 * Bus de commandes descendantes.
 *
 * Le fanout est un simple `EventEmitter` en process : le hub tourne en instance
 * unique (contrainte assumée du choix SQLite), donc toutes les connexions
 * WebSocket vivent dans le même processus. Pas de Redis à maintenir pour
 * diffuser vers trois salles.
 *
 * Un seul canal pour tout le monde, avec filtrage par salle à la consommation :
 * une diffusion globale doit atteindre les trois salles, et un canal par salle
 * obligerait le publieur à connaître la liste des salles connectées.
 */
export class CommandService {
  private readonly emitter = new EventEmitter()

  constructor(
    private readonly db: HubDatabase,
    /** Datation des commandes : c'est elle qui sert au filtre d'obsolescence. */
    private readonly now: () => number = Date.now,
  ) {
    // Trois salles, plus les écrans et l'admin : la limite par défaut de 10 est vite atteinte.
    this.emitter.setMaxListeners(64)
  }

  /**
   * Publie une commande. `roomId === null` diffuse à toutes les salles.
   *
   * Le `seq` est attribué par la base (clé auto-incrémentée, globalement
   * monotone) et sert d'identifiant d'événement oRPC : c'est lui que le client
   * renvoie en `lastEventId` pour reprendre après une coupure.
   */
  /**
   * Bandeaux déjà passés à l'antenne, du plus récent au plus ancien.
   *
   * Lus dans les commandes émises plutôt que recopiés ailleurs : elles sont
   * déjà persistées, datées et ordonnées. Une seconde table ne pourrait que
   * diverger de ce qui est réellement parti dans les salles.
   *
   * Les retraits (`message: null`) ne sont pas de l'historique — on ne remet
   * pas « rien » à l'antenne — mais le plus récent dit **lequel** des bandeaux
   * est encore affiché.
   */
  bandeauxPasses(roomId: string | null, limit: number): {
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
      .filter((ligne) => roomId == null || ligne.roomId == null || ligne.roomId === roomId)
      .map((ligne) => ({
        seq: ligne.seq,
        roomId: ligne.roomId,
        payload: JSON.parse(ligne.payloadJson) as {
          type: 'overlay.set'
          message: { text: string; level: string } | null
        },
        issuedAt: ligne.issuedAt,
      }))
  }

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

  /** Commandes de la salle postérieures à `sinceSeq`, diffusions globales comprises. */
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
   * Flux d'une salle : rattrapage puis temps réel, par le même chemin.
   *
   * `sinceSeq` vient du `lastEventId` fourni par oRPC à la reconnexion — le
   * client n'a aucun compteur de rattrapage à gérer lui-même.
   */
  async *stream(roomId: string, sinceSeq: number, signal?: AbortSignal): AsyncGenerator<Command> {
    // S'abonner *avant* de lire le backlog : une commande publiée entre les deux
    // tomberait sinon dans un trou dont personne ne se rendrait compte.
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
        // Le backlog a pu déjà livrer cette commande : ne pas la répéter.
        if (issued.seq <= lastSeq) continue
        lastSeq = issued.seq
        yield issued
      }
    } catch (cause) {
      // `on()` rejette avec AbortError à la déconnexion : c'est une fin normale.
      if ((cause as Error)?.name !== 'AbortError') throw cause
    }
  }
}
