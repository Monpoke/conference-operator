import type { Connectivity, DisplayMode, Envelope, RoomEventPayload, SceneRole } from '@cloudnord/contract'
import { heartbeatDedupKey, type Outbox } from './outbox.js'

// Réexportée ici : c'est la pompe qui l'utilise à l'émission.
export { heartbeatDedupKey }
import type { LocalStore } from './store.js'

export interface PushResult {
  acked: string[]
  duplicates: string[]
  rejected: { id: string; reason: string }[]
  serverTime?: string
}

export interface OutboxPumpOptions {
  outbox: Outbox
  store: LocalStore
  /** Remontée vers le hub. Injectée pour tester la vidange sans réseau. */
  push: (batch: Envelope[]) => Promise<PushResult>
  onConnectivity?: (connectivity: Connectivity) => void
  onDepth?: (depth: number) => void
  /** Décalage d'horloge mesuré à chaque remontée réussie. */
  onServerTime?: (serverTime: string) => void
  batchSize?: number
  intervalMs?: number
  now?: () => number
}

export interface DrainOutcome {
  sent: number
  duplicates: number
  rejected: number
  deferred: number
  connectivity: Connectivity
}

/**
 * Vidange la file vers le hub.
 *
 * Un seul lot en vol à la fois, dans l'ordre des `seq` : le hub applique dans
 * cet ordre, et une remontée désordonnée fausserait l'historique de la salle.
 */
export class OutboxPump {
  private timer: NodeJS.Timeout | null = null
  private draining = false
  /**
   * La pompe a été arrêtée, et un lot est peut-être encore en vol.
   *
   * Distinct de `timer == null` : ce qui compte n'est pas qu'il n'y ait plus de
   * tic, mais qu'une vidange partie **avant** l'arrêt ne revienne pas écrire
   * après lui. Voir `drainOnce`.
   */
  private arretee = false
  private connectivity: Connectivity = 'OFFLINE'

  constructor(private readonly options: OutboxPumpOptions) {}

  private setConnectivity(next: Connectivity): void {
    if (next === this.connectivity) return
    this.connectivity = next
    this.options.onConnectivity?.(next)
  }

  /**
   * Une passe de vidange.
   *
   * Ne lève jamais : l'échec réseau est un état normal, pas une exception. Le
   * lot est reporté avec backoff et la connectivité bascule.
   */
  async drainOnce(): Promise<DrainOutcome> {
    const { outbox, push } = this.options
    outbox.evictExpired()

    const batch = outbox.claimBatch(this.options.batchSize ?? 100)
    this.options.onDepth?.(outbox.backlog())

    if (batch.length === 0) {
      return { sent: 0, duplicates: 0, rejected: 0, deferred: 0, connectivity: this.connectivity }
    }

    try {
      const result = await push(batch)
      if (this.arretee) return this.abandonne(batch.length)

      // Acquittés et doublons sortent pareillement : dans les deux cas le hub
      // les détient. C'est ce qui rend le rejeu inoffensif après reconnexion.
      outbox.ack([...result.acked, ...result.duplicates])
      outbox.reject(result.rejected)

      const traites = new Set([
        ...result.acked,
        ...result.duplicates,
        ...result.rejected.map((entry) => entry.id),
      ])
      // Un événement que le hub n'a ni acquitté ni rejeté sera repris plus tard.
      const restants = batch.filter((envelope) => !traites.has(envelope.id))
      outbox.defer(restants.map((envelope) => envelope.id))

      if (result.serverTime != null) this.options.onServerTime?.(result.serverTime)
      this.setConnectivity('ONLINE')
      this.options.onDepth?.(outbox.backlog())

      return {
        sent: result.acked.length,
        duplicates: result.duplicates.length,
        rejected: result.rejected.length,
        deferred: restants.length,
        connectivity: 'ONLINE',
      }
    } catch (cause) {
      if (this.arretee) return this.abandonne(batch.length)
      outbox.defer(batch.map((envelope) => envelope.id))
      this.setConnectivity('OFFLINE')
      this.options.store.log('warn', 'remontée impossible, lot reporté', {
        taille: batch.length,
        message: (cause as Error).message,
      })
      return {
        sent: 0,
        duplicates: 0,
        rejected: 0,
        deferred: batch.length,
        connectivity: 'OFFLINE',
      }
    }
  }

  /**
   * Le lot revient après l'arrêt : on ne touche plus à rien.
   *
   * La base est fermée — ou sur le point de l'être —, et l'écriture échouerait
   * dans le `catch` qui existe précisément pour rattraper les échecs, d'où un
   * rejet non géré qui remontait jusqu'au processus.
   *
   * **Rien n'est perdu.** `claimBatch` ne marque pas ce qu'il lit : il rend ce
   * dont l'échéance est passée. Un lot qu'on renonce à reporter reste donc
   * éligible tel quel, et repart au premier tour de la prochaine ouverture —
   * ce qui est exactement le comportement voulu après un redémarrage.
   */
  private abandonne(taille: number): DrainOutcome {
    return {
      sent: 0,
      duplicates: 0,
      rejected: 0,
      deferred: taille,
      connectivity: this.connectivity,
    }
  }

  /**
   * Une passe, au plus une à la fois.
   *
   * Le garde protège l'ordre des `seq` : sans lui, un réseau lent ferait partir
   * deux lots en parallèle et le hub les appliquerait dans le désordre. Il vaut
   * pour le tic **et** pour le réveil — c'est justement quand les deux se
   * croisent qu'il compte.
   */
  private passe(): void {
    if (this.draining) return
    this.draining = true
    void this.drainOnce().finally(() => {
      this.draining = false
    })
  }

  /**
   * Vide la file maintenant, sans attendre le tic.
   *
   * Pour ce qui se regarde de loin. Une régie mobile ne peint jamais d'avance —
   * un bouton décrit OBS, pas ce qu'on lui a demandé —, si bien que le geste
   * reste sans effet visible tant que la salle n'a pas remonté ce qui a changé.
   * Deux secondes de tic plus une seconde de sondage, et l'on appuie une
   * seconde fois en croyant avoir raté le bouton.
   *
   * Appelé sur les changements d'OBS, pas sur chaque remontée : c'est un fait
   * par bascule, pas un flot. L'invariant d'autonomie tient — rien ici ne
   * bloque, et un réseau absent laisse simplement le lot en file.
   *
   * **Sans effet tant que la pompe ne tourne pas**, et le garde n'est pas
   * cosmétique : OBS continue d'émettre pendant l'arrêt de l'application, et
   * une vidange lancée après la fermeture de la base échoue dans son propre
   * `catch` — qui écrit lui-même en base pour reporter le lot. Le réveil n'a de
   * sens qu'entre `start()` et `stop()` ; en dehors, il n'y a plus de tic à
   * devancer.
   */
  reveiller(): void {
    if (this.timer == null) return
    this.passe()
  }

  start(): void {
    if (this.timer != null) return
    this.arretee = false
    const interval = this.options.intervalMs ?? 2_000
    this.timer = setInterval(() => this.passe(), interval)
    // Ne retient pas le process : l'application doit pouvoir se fermer.
    this.timer.unref?.()
  }

  stop(): void {
    this.arretee = true
    if (this.timer != null) clearInterval(this.timer)
    this.timer = null
  }
}



export interface HeartbeatInput {
  connectivity: Connectivity
  sceneRole: SceneRole | null
  recording: boolean
  streaming: boolean
  outboxDepth: number
  programContentHash: string | null
  /** Ce que l'écran de salle affiche : il ne remonte que par le battement. */
  displayMode: DisplayMode
}

export function buildHeartbeat(input: HeartbeatInput): RoomEventPayload {
  return { type: 'room.heartbeat', ...input }
}
