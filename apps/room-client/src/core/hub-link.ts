import { WebSocket } from 'ws'
import { createORPCClient } from '@orpc/client'
import { RPCLink } from '@orpc/client/websocket'
import type { ContractRouterClient } from '@orpc/contract'
import {
  contract,
  type Command,
  type Connectivity,
  type ExecutionMode,
  type Question,
  type RoomConfigPatch,
} from '@cloudnord/contract'
import { programSchema } from '@cloudnord/program'
import { OutageTracker } from './interruptions.js'
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
  /** Called when the hub refuses our credentials: the machine has to pair again. */
  onAuthRejected?: (reason: string) => void
  /**
   * The mode the hub announces on every synchronization.
   *
   * The room compares it to its own: a development machine plugged into the
   * event's hub — or the other way round — must be visible in the control app, not
   * discovered in the recordings.
   */
  onHubMode?: (mode: ExecutionMode) => void
  /**
   * A downward command has just been applied.
   *
   * Used to send up straight away what changed. A mobile control app never paints
   * ahead: it made the gesture, and until the room has confirmed, its button still
   * describes the state from before. Waiting for the next heartbeat is up to ten
   * seconds of a dead button — the time it takes to press a second time.
   */
  onCommandApplied?: (command: Command) => void
  /**
   * A `sync`'s deadline.
   *
   * Indispensable: the link's reconnection is unlimited by design, so with no
   * deadline a `sync` started while the hub is down would never fail — the
   * operator would see a button spinning endlessly instead of a usable "offline"
   * state.
   */
  syncTimeoutMs?: number
  /**
   * The log's clock.
   *
   * Deliberately the **real** clock, even when the hub simulates the time: "how
   * long has this stream been down" is a question of elapsed time, not of a
   * simulated moment. Injectable for the tests.
   */
  now?: () => number
}

/**
 * The hub refused our credentials.
 *
 * Distinct from a network failure: retrying will change nothing, the pairing has
 * to be run again. Without that distinction, a machine whose token was revoked —
 * or whose hub was recreated — loops indefinitely logging a warning, with nobody
 * understanding what to do.
 */
export class HubAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HubAuthError'
  }
}

/** Recognizes an authentication refusal inside an oRPC error. */
export function isAuthRefusal(cause: unknown): boolean {
  const code = (cause as { code?: string })?.code
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') return true
  const message = String((cause as Error)?.message ?? '')
  return /jeton de salle|session opérateur|réappairage/i.test(message)
}

/**
 * The real-time link to the hub.
 *
 * No control-room operation depends on this link: it synchronizes the program and
 * applies the downward commands, but its absence leaves the room fully functional
 * on its local cache.
 */
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
        // Without this listener, a reconnection attempt towards an unreachable hub
        // emits an unhandled `error` and **kills the process** — that is, losing the
        // control app on a plain network outage.
        socket.on('error', (cause) => {
          options.onLog?.('warn', 'socket hub en erreur', { message: cause.message })
        })
        return socket as unknown as globalThis.WebSocket
      },
      reconnect: {
        enabled: true,
        // The first attempt immediate, then a constant plateau: in a room, an
        // outage rarely lasts long and we want to come back fast.
        delay: (info) => (info.attempt === 1 ? 0 : 2_000),
        maxAttempt: Infinity,
        /**
         * A **lazy** reconnection, triggered by our calls, and not proactively when
         * the socket closes.
         *
         * `onClose.enabled` would reduce the resume latency, but oRPC would then
         * reopen a socket even after `close()`: the application would never close
         * and would keep hitting a hub that is shutting down. The `consumeCommands`
         * loop resubscribes within 2 s anyway — the resume cadence belongs to us,
         * and it stops when we say so.
         */
        onClose: { enabled: false },
      },
    })

    this.client = createORPCClient(link)
  }

  /**
   * The questions asked in this room.
   *
   * A public procedure — the wall is open to whoever scans the QR code — but
   * called here through the link that is already established: no second client to
   * maintain.
   */
  async questions(roomId: string, sessionId: string | null): Promise<Question[]> {
    return this.client.questions.list(
      { roomId, sessionId },
      { signal: AbortSignal.timeout(8_000) },
    )
  }

  /**
   * Records a room setting on the hub.
   *
   * Throws, unlike `sync`: here somebody is waiting in front of the screen, and a
   * silent failure would make them believe it went through. The hub stays the
   * source of truth — keeping the setting locally would get it overwritten at the
   * next sync.
   */
  async configure(patch: RoomConfigPatch): Promise<void> {
    await this.client.rooms.configure(patch, { signal: AbortSignal.timeout(8_000) })
  }

  /**
   * Synchronizes the program and the configuration.
   *
   * Never throws: an unreachable hub at startup is a nominal case, the room
   * carries on from its cache. The failure is reported through the connectivity.
   *
   * @param options.full Ignores the local cache and asks for the whole program
   *   again, even at an identical fingerprint. That is what "full resync" means:
   *   the ordinary sync relies on the fingerprint so as not to re-download 70 kB on
   *   every heartbeat, which is exactly the saving one distrusts when suspecting a
   *   room of having drifted.
   */
  async sync(
    options: { full?: boolean } = {},
  ): Promise<{ ok: boolean; contentHash?: string; authRejected?: boolean }> {
    const { store, runtime } = this.options
    try {
      const since = options.full === true ? null : store.settings().activeContentHash
      const result = await this.client.rooms.sync(
        { since },
        { signal: AbortSignal.timeout(this.options.syncTimeoutMs ?? 8_000) },
      )

      // The clock offset: the VOD timecodes and the timeline depend on it. The hub
      // also says whether its time is simulated — the control app must report it.
      runtime.setServerTime(result.serverTime, result.simulatedClock)
      this.options.onHubMode?.(result.mode)

      store.saveSettings({
        roomId: result.room.id,
        config: result.room,
        socialLinks: result.socialLinks,
        // The event's name comes down with the rest and stays cached: the pages
        // must title themselves correctly at the next start, an unreachable hub
        // included.
        event: result.event,
        // The same for the shipping: the regulator decides several times a minute,
        // and it must never depend on a network call.
        vod: result.vod,
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
      if (isAuthRefusal(cause)) {
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
   * Consumes the command stream until it stops.
   *
   * The resume goes through oRPC's `lastEventId`: we restart from the last applied
   * `seq`, stored locally, so an outage skips no command.
   */
  async consumeCommands(signal?: AbortSignal): Promise<void> {
    const { runtime, store } = this.options
    // A function rather than a direct read: `aborted` changes during the loop, and
    // TypeScript would otherwise freeze the value observed on entering the `while`.
    const isAborted = () => signal?.aborted === true
    const outage = new OutageTracker('flux de commandes', this.options.now)

    while (!this.stopped && !isAborted()) {
      try {
        const lastEventId = String(store.settings().lastCommandSeq)
        const iterator = await this.client.rooms.commands(undefined, { lastEventId, signal })
        runtime.setConnectivity('ONLINE')

        // The stream is restored: we say so, in the log and in the control app.
        // Without it, only the failures were traced and the incident never closed.
        // The banner counts as much as the log: it is where the operator looks, and
        // they have just seen the room go offline.
        const restored = outage.restored()
        if (restored != null) {
          this.options.onLog?.('info', restored.message)
          runtime.notify({ level: 'info', text: `Hub rejoint — ${restored.message}` })
        }

        for await (const command of iterator) {
          const issue = await runtime.applyCommand(command)
          if (issue.applied) this.options.onCommandApplied?.(command)
        }
      } catch (cause) {
        if (isAborted() || this.stopped) return
        runtime.setConnectivity('OFFLINE')

        if (isAuthRefusal(cause)) {
          // Retrying would be of no use: we report up, and the machine will show
          // its pairing screen again.
          this.stopped = true
          this.options.onLog?.('error', "identifiants refusés par le hub, réappairage nécessaire", {
            message: (cause as Error).message,
          })
          this.options.onAuthRejected?.((cause as Error).message)
          return
        }

        const failure = outage.failure()
        if (failure.message != null) {
          this.options.onLog?.('warn', failure.message, { message: (cause as Error).message })
        }
        await new Promise((resolve) => setTimeout(resolve, 2_000))
      }
    }
  }

  /**
   * Consumes the stream of approved messages.
   *
   * The same mechanics as the commands, and the same tolerance: an outage has no
   * consequence — at worst the wall stays on its last state, which is invisible to
   * the audience.
   */
  async consumeWall(signal?: AbortSignal): Promise<void> {
    const { runtime, store } = this.options
    const isAborted = () => signal?.aborted === true
    const outage = new OutageTracker('flux du mur', this.options.now)

    while (!this.stopped && !isAborted()) {
      try {
        const roomId = store.settings().roomId
        const iterator = await this.client.wall.feed({ roomId }, { signal })
        // The wall does not warrant a banner: an outage there has no visible
        // consequence for the audience, unlike the commands.
        const restored = outage.restored()
        if (restored != null) this.options.onLog?.('info', restored.message)
        for await (const comment of iterator) runtime.addComment(comment)
      } catch (cause) {
        if (isAborted() || this.stopped) return
        const failure = outage.failure()
        if (failure.message != null) {
          this.options.onLog?.('warn', failure.message, { message: (cause as Error).message })
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
