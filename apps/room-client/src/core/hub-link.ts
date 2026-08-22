import { WebSocket } from 'ws'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import type { ContractRouterClient } from '@orpc/contract'
import {
  contract,
  type Connectivity,
  type ModeExecution,
  type Question,
  type RoomConfigPatch,
} from '@cloudnord/contract'
import { programSchema } from '@cloudnord/program'
import { SuiviInterruption } from './interruptions.js'
import type { LocalStore } from './store.js'
import type { RoomRuntime } from './runtime.js'

export type HubClient = ContractRouterClient<typeof contract>

export interface HubLinkOptions {
  hubOrigin: string
  clientId: string
  token: string
  store: LocalStore
  runtime: RoomRuntime
  onLog?: (level: 'info' | 'warn' | 'error', message: string, context?: unknown) => void
  /** Appelé quand le hub refuse nos identifiants : il faut réappairer. */
  onAuthRejected?: (raison: string) => void
  /**
   * Mode annoncé par le hub à chaque synchronisation.
   *
   * La salle le compare au sien : un poste de développement branché sur le hub
   * de l'événement — ou l'inverse — doit se voir en régie, pas se découvrir
   * dans les enregistrements.
   */
  onHubMode?: (mode: ModeExecution) => void
  /**
   * Échéance d'un `sync`.
   *
   * Indispensable : la reconnexion du lien est illimitée par conception, donc
   * sans échéance un `sync` lancé pendant que le hub est à terre n'échouerait
   * jamais — l'opérateur verrait un bouton tourner sans fin au lieu d'un état
   * « hors ligne » exploitable.
   */
  syncTimeoutMs?: number
  /**
   * Horloge du journal.
   *
   * Volontairement l'horloge **réelle**, même quand le hub simule l'heure :
   * « depuis combien de temps ce flux est-il coupé » est une question de temps
   * écoulé, pas de moment simulé. Injectable pour les tests.
   */
  now?: () => number
}

/**
 * Lien temps réel vers le hub.
 *
 * Aucune opération de régie ne dépend de ce lien : il synchronise le programme
 * et applique les commandes descendantes, mais son absence laisse la salle
 * pleinement fonctionnelle sur son cache local.
 */
/**
 * Le hub a refusé nos identifiants.
 *
 * Distinct d'une panne réseau : réessayer n'y changera rien, il faut relancer
 * l'appairage. Sans cette distinction, une machine dont le jeton a été révoqué
 * — ou dont le hub a été recréé — boucle indéfiniment en journalisant un
 * avertissement, sans que personne ne comprenne quoi faire.
 */
export class HubAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HubAuthError'
  }
}

/** Reconnaît un refus d'authentification dans une erreur oRPC. */
export function estRefusAuth(cause: unknown): boolean {
  const code = (cause as { code?: string })?.code
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') return true
  const message = String((cause as Error)?.message ?? '')
  return /jeton de salle|session opérateur|réappairage/i.test(message)
}

export class HubLink {
  readonly client: HubClient
  private stopped = false
  private sockets = new Set<WebSocket>()

  constructor(private readonly options: HubLinkOptions) {
    const wsUrl = `${options.hubOrigin.replace(/^http/, 'ws')}/ws`

    const link = new RPCLink({
      connect: () => {
        const socket = new WebSocket(wsUrl, {
          headers: {
            authorization: `Bearer ${options.token}`,
            'x-room-client-id': options.clientId,
          },
        })
        this.sockets.add(socket)
        socket.on('close', () => {
          this.sockets.delete(socket)
          if (!this.stopped) options.runtime.setConnectivity('OFFLINE')
        })
        socket.on('open', () => options.runtime.setConnectivity('ONLINE'))
        // Sans ce listener, une tentative de reconnexion vers un hub injoignable
        // émet un `error` non géré et **tue le process** — c'est-à-dire perdre
        // la régie sur une simple coupure réseau.
        socket.on('error', (cause) => {
          options.onLog?.('warn', 'socket hub en erreur', { message: cause.message })
        })
        return socket as unknown as globalThis.WebSocket
      },
      reconnect: {
        enabled: true,
        // Premier essai immédiat, puis palier constant : en salle, une coupure
        // dure rarement longtemps et on veut revenir vite.
        delay: (info) => (info.attempt === 1 ? 0 : 2_000),
        maxAttempt: Infinity,
        /**
         * Reconnexion **paresseuse**, déclenchée par nos appels, et non
         * proactivement à la fermeture du socket.
         *
         * `onClose.enabled` réduirait la latence de reprise, mais oRPC rouvrirait
         * alors un socket même après `close()` : l'application ne se fermerait
         * jamais et continuerait de frapper un hub en cours d'arrêt. La boucle
         * `consumeCommands` se réabonne de toute façon en 2 s — la cadence de
         * reprise nous appartient, et elle s'arrête quand on le dit.
         */
        onClose: { enabled: false },
      },
    })

    this.client = createORPCClient(link)
  }

  /**
   * Questions posées dans cette salle.
   *
   * Procédure publique — le mur est ouvert à qui scanne le QR — mais appelée
   * ici par le lien déjà établi : pas de second client à entretenir.
   */
  async questions(roomId: string, sessionId: string | null): Promise<Question[]> {
    return this.client.questions.list(
      { roomId, sessionId },
      { signal: AbortSignal.timeout(8_000) },
    )
  }

  /**
   * Enregistre un réglage de salle sur le hub.
   *
   * Lève, contrairement à `sync` : ici quelqu'un attend devant l'écran, et un
   * échec silencieux lui ferait croire que c'est passé. Le hub reste la source
   * de vérité — garder le réglage en local le ferait écraser au sync suivant.
   */
  async configure(patch: RoomConfigPatch): Promise<void> {
    await this.client.rooms.configure(patch, { signal: AbortSignal.timeout(8_000) })
  }

  /**
   * Synchronise programme et configuration.
   *
   * Ne lève jamais : un hub injoignable au démarrage est un cas nominal, la
   * salle continue sur son cache. L'échec est remonté par la connectivité.
   */
  async sync(): Promise<{ ok: boolean; contentHash?: string; authRejected?: boolean }> {
    const { store, runtime } = this.options
    try {
      const since = store.settings().activeContentHash
      const result = await this.client.rooms.sync(
        { since },
        { signal: AbortSignal.timeout(this.options.syncTimeoutMs ?? 8_000) },
      )

      // Offset d'horloge : les timecodes VOD et la timeline en dépendent.
      // Le hub dit aussi si son heure est simulée — la régie doit le signaler.
      runtime.setServerTime(result.serverTime, result.simulatedClock)
      this.options.onHubMode?.(result.mode)

      store.saveSettings({
        roomId: result.room.id,
        config: result.room,
        socialLinks: result.socialLinks,
      })
      runtime.setRoomId(result.room.id)

      if (result.program != null) {
        const program = programSchema.parse(result.program)
        store.saveProgram(result.contentHash, program)
        runtime.setProgram(result.contentHash, program)
      } else {
        store.saveSettings({ activeContentHash: result.contentHash })
      }

      runtime.setConnectivity('ONLINE')
      runtime.refreshSessions()
      return { ok: true, contentHash: result.contentHash }
    } catch (cause) {
      if (estRefusAuth(cause)) {
        this.options.onLog?.('error', 'identifiants refusés par le hub', {
          message: (cause as Error).message,
        })
        this.options.onAuthRejected?.((cause as Error).message)
        runtime.setConnectivity('OFFLINE')
        return { ok: false, authRejected: true }
      }
      this.options.onLog?.('warn', 'synchronisation impossible, cache local conservé', {
        message: (cause as Error).message,
      })
      runtime.setConnectivity('OFFLINE')
      return { ok: false }
    }
  }

  /**
   * Consomme le flux de commandes jusqu'à l'arrêt.
   *
   * La reprise passe par `lastEventId` d'oRPC : on repart du dernier `seq`
   * appliqué, stocké localement, donc une coupure ne fait sauter aucune commande.
   */
  async consumeCommands(signal?: AbortSignal): Promise<void> {
    const { runtime, store } = this.options
    // Fonction plutôt que lecture directe : `aborted` change en cours de boucle,
    // et TypeScript figerait sinon la valeur observée à l'entrée du `while`.
    const isAborted = () => signal?.aborted === true
    const suivi = new SuiviInterruption('flux de commandes', this.options.now)

    while (!this.stopped && !isAborted()) {
      try {
        const lastEventId = String(store.settings().lastCommandSeq)
        const iterator = await this.client.rooms.commands(undefined, { lastEventId, signal })
        runtime.setConnectivity('ONLINE')

        // Le flux est rétabli : on le dit, au journal et en régie. Sans cela,
        // seuls les échecs étaient tracés et l'incident ne se refermait jamais.
        // Le bandeau compte autant que le journal : c'est là que l'opérateur
        // regarde, et il vient de voir la salle passer hors ligne.
        const retour = suivi.retabli()
        if (retour != null) {
          this.options.onLog?.('info', retour.message)
          runtime.notify({ level: 'info', text: `Hub rejoint — ${retour.message}` })
        }

        for await (const command of iterator) {
          await runtime.applyCommand(command)
        }
      } catch (cause) {
        if (isAborted() || this.stopped) return
        runtime.setConnectivity('OFFLINE')

        if (estRefusAuth(cause)) {
          // Réessayer ne servirait à rien : on remonte, et la machine
          // réaffichera son écran d'appairage.
          this.stopped = true
          this.options.onLog?.('error', "identifiants refusés par le hub, réappairage nécessaire", {
            message: (cause as Error).message,
          })
          this.options.onAuthRejected?.((cause as Error).message)
          return
        }

        const echec = suivi.echec()
        if (echec.message != null) {
          this.options.onLog?.('warn', echec.message, { message: (cause as Error).message })
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000))
      }
    }
  }

  /**
   * Consomme le flux des messages approuvés.
   *
   * Même mécanique que les commandes, et même tolérance : une coupure n'a
   * aucune conséquence — au pire le mur reste sur son dernier état, ce qui est
   * invisible pour le public.
   */
  async consumeWall(signal?: AbortSignal): Promise<void> {
    const { runtime, store } = this.options
    const isAborted = () => signal?.aborted === true
    const suivi = new SuiviInterruption('flux du mur', this.options.now)

    while (!this.stopped && !isAborted()) {
      try {
        const roomId = store.settings().roomId
        const iterator = await this.client.wall.feed({ roomId }, { signal })
        // Le mur ne justifie pas un bandeau : une coupure y est sans
        // conséquence visible pour le public, contrairement aux commandes.
        const retour = suivi.retabli()
        if (retour != null) this.options.onLog?.('info', retour.message)
        for await (const comment of iterator) runtime.addComment(comment)
      } catch (cause) {
        if (isAborted() || this.stopped) return
        const echec = suivi.echec()
        if (echec.message != null) {
          this.options.onLog?.('warn', echec.message, { message: (cause as Error).message })
        }
        await new Promise((resolve) => setTimeout(resolve, 5_000))
      }
    }
  }

  setConnectivity(connectivity: Connectivity): void {
    this.options.runtime.setConnectivity(connectivity)
  }

  async close(): Promise<void> {
    this.stopped = true
    for (const socket of this.sockets) socket.terminate()
    this.sockets.clear()
  }
}
