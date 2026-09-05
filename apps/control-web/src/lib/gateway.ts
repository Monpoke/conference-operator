import type {
  VisibleConfig,
  DisplayMode,
  DisplayPayload,
  ControlCommand,
  ControlView,
  SceneRole,
} from '@conference-operator/contract'
import { NO_EDITING_MARKS } from '@conference-operator/contract'
import type { HubClient } from '@conference-operator/hub-client'

/**
 * The control app, and the two ways of reaching it.
 *
 * The in-room control screen talks to its own machine: SSE for the state, a POST
 * for the gestures, all on `127.0.0.1`. The **mobile** control app is the same
 * application, served by the hub, driving a room remotely. What differs between
 * the two lives entirely here — the panels do not know where their state comes
 * from nor where their gesture goes.
 *
 * Three properties make that reuse possible, and they must be held:
 *
 * 1. the panels take `props`, not the store;
 * 2. the `room` store holds nothing but a `DisplayPayload` — the remote gateway
 *    **synthesises** one from the hub's view;
 * 3. every gesture goes through `actions.act()`, including those in `conference.ts`.
 *
 * The rule governing both gateways is the same, and it is the most important:
 * **no action writes into the state**. An active button describes OBS, never
 * what OBS was asked to do.
 */

/** What the machine answers to an action. The message is written for the operator. */
export interface ActionResult {
  ok: boolean
  message?: string
  /**
   * What the gesture brings back, when it brings anything back.
   *
   * Rare, and deliberately untyped: almost every action has no effect other than
   * on the state, which comes back through the stream. Only the gestures that
   * **ask the machine a question** have an answer — the folder picker returns
   * the chosen path, and the page fills its field with it.
   */
  detail?: unknown
}

/** What the gateway pushes towards the state store. */
export interface StateSink {
  /** A complete snapshot, or a partial merge over the previous one. */
  onPayload: (payload: DisplayPayload | Partial<DisplayPayload>, complete: boolean) => void
  /** The stream is cut, or alive again. */
  onOutage: (cut: boolean) => void
}

export interface ControlGateway {
  start(sink: StateSink): void
  stop(): void
  act(gesture: Record<string, unknown>): Promise<ActionResult>
}

/** Enough to subscribe and to close — just enough to test without `EventSource`. */
export interface StateStream {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  close(): void
}

/* ------------------------------------------------------------------- local */

/**
 * The room machine's gateway: SSE downstream, POST upstream.
 *
 * Taken over as-is from what `stores/room.ts` and `stores/actions.ts` used to
 * do: the move changes no behaviour, it merely provides a second plug-in point.
 */
export function localGateway(
  open: (url: string) => StateStream = (url) => new EventSource(url),
): ControlGateway {
  let stream: StateStream | null = null

  return {
    start(sink) {
      if (stream != null) return
      stream = open('/display/state?vue=regie')

      stream.onopen = () => sink.onOutage(false)
      stream.onerror = () => sink.onOutage(true)

      // The unnamed message: the complete snapshot. It goes out on opening and
      // after every reconnection, which repairs the page with no resume logic.
      stream.onmessage = (event) => {
        sink.onOutage(false)
        sink.onPayload(JSON.parse(event.data) as DisplayPayload, true)
      }

      // Delta: only the fields that changed.
      stream.addEventListener('delta', (event) => {
        sink.onOutage(false)
        sink.onPayload(JSON.parse(event.data) as Partial<DisplayPayload>, false)
      })
    },

    stop() {
      stream?.close()
      stream = null
    },

    async act(gesture) {
      try {
        const response = await fetch('/control/action', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(gesture),
        })
        return (await response.json()) as ActionResult
      } catch {
        /*
         * The control app runs locally: a failure here does not mean "the hub is
         * far away", it means the room's application core no longer answers.
         * That is the failure that stops everything, and it must be readable
         * immediately.
         */
        return { ok: false, message: 'Le service local ne répond pas' }
      }
    },
  }
}

/* ------------------------------------------------------------------ remote */

/** The polling cadence. It is also the lock's heartbeat: a single round trip. */
export const POLL_MS = 1_000

/**
 * Past this, a gesture a later step depends on is declared missed.
 *
 * Five seconds: the time for a command to go down, for OBS to obey and for the
 * room to report it, with margin for an event network. Past that, saying "done"
 * would be a lie — and it is precisely the lie that empties "Commencer"'s
 * recording warning of its meaning.
 */
export const OBSERVATION_MS = 5_000

export interface RemoteGatewayOptions {
  client: HubClient
  /** The room being driven. */
  roomId: string
  /**
   * The whole view, on every poll.
   *
   * The synthesised `DisplayPayload` does not carry everything: the **lock** has
   * no place in a room's state — `remoteHolder` tells a room that it is being
   * driven remotely, not the phone that is driving it. Yet that is exactly the
   * field that must react fast: when another tab takes the room over, the one
   * losing it must see so within the second, not at the next listing.
   */
  onView?: (view: ControlView) => void
  /** Injectable, to test with no real clock and no real timer. */
  now?: () => number
  wait?: (ms: number) => Promise<void>
}

/**
 * The hub's gateway: polling downstream, `regie.command` upstream.
 *
 * The poll **also carries the lock's heartbeat** — `regie.view` renews its
 * holder's grip. A single round trip a second says both "I still hold the room"
 * and "how far along is it", and there is no separate heartbeat one could forget
 * to stop.
 */
export function remoteGateway(options: RemoteGatewayOptions): ControlGateway {
  const now = options.now ?? (() => Date.now())
  const wait =
    options.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

  let timer: ReturnType<typeof setInterval> | null = null
  let latest: ControlView | null = null
  let inFlight = false

  async function read(sink: StateSink | null): Promise<ControlView | null> {
    /*
     * A single poll in flight.
     *
     * On a phone network a response can take more than a second: without this
     * guard the calls pile up and the responses arrive out of order — a state
     * from three seconds ago would then overwrite a fresh one.
     */
    if (inFlight) return latest
    inFlight = true
    try {
      const view = await options.client.rpc.regie.view({ roomId: options.roomId })
      latest = view
      options.onView?.(view)
      sink?.onOutage(false)
      sink?.onPayload(payloadFromView(view, now()), true)
      return view
    } catch {
      /*
       * An outage, not an error.
       *
       * The phone loses the network crossing a building; saying so in red on
       * every hiccup would make the warning unreadable. It is the store's grace
       * period that decides when the screen is "frozen".
       */
      sink?.onOutage(true)
      return null
    } finally {
      inFlight = false
    }
  }

  /**
   * Waits for the room to **have done** what it was asked.
   *
   * `regie.command` answers once the hub has queued the command, and that is all
   * it can promise: the room may be cut off, OBS may refuse. Gestures a later
   * step depends on — the recording before "Commencer" — must therefore be
   * confirmed by **observation**, otherwise the rule "if the recording does not
   * start, do not begin" disappears with nothing to say so.
   */
  async function observe(
    predicate: (view: ControlView) => boolean,
    failure: string,
  ): Promise<ActionResult> {
    const deadline = now() + OBSERVATION_MS
    for (;;) {
      await wait(POLL_MS)
      const view = await read(null)
      if (view != null && predicate(view)) return { ok: true }
      if (now() >= deadline) return { ok: false, message: failure }
    }
  }

  return {
    start(sink) {
      if (timer != null) return
      void read(sink)
      timer = setInterval(() => void read(sink), POLL_MS)
    },

    stop() {
      if (timer != null) clearInterval(timer)
      timer = null
    },

    async act(gesture) {
      /*
       * A gesture made before the first response has to know its target.
       *
       * The lifecycle travels with the identifier of the slot aimed at, which
       * only the view supplies. A button pressed within a second of opening — a
       * reload in the middle of a talk, exactly when one reloads — used to leave
       * with no target, and got refused as an out-of-scope gesture. One more
       * round trip, and only there.
       */
      if (latest == null) await read(null)

      const translated = translate(gesture, latest)
      if (translated == null) {
        /*
         * Out of scope, and said in so many words.
         *
         * The markers, the VOD and the ⚙ require the room's machine, which the
         * hub does not reach. Letting the call fail on a `BAD_REQUEST` would give
         * a red with no explanation, where the reason fits in one sentence.
         */
        return { ok: false, message: "Ce geste demande la régie de la salle" }
      }

      try {
        await options.client.rpc.regie.command({ roomId: options.roomId, action: translated })
      } catch (cause) {
        return { ok: false, message: (cause as Error).message || 'Geste refusé' }
      }

      if (translated.type === 'recording.set') {
        const expected = translated.on
        return observe(
          (view) => view.recording === expected,
          expected
            ? "L'enregistrement n'a pas démarré : la salle n'a pas confirmé"
            : "L'enregistrement ne s'est pas arrêté : la salle n'a pas confirmé",
        )
      }

      /*
       * The other gestures block nothing behind them.
       *
       * The lifecycle is written on the hub: that is settled by the time it
       * returns. A scene switch is read on the button at the next poll, as in the
       * room's own control app — and nobody chains anything onto it.
       */
      return { ok: true }
    },
  }
}

/**
 * The control app's vocabulary, translated into the hub's.
 *
 * `null` for everything that makes no sense remotely. The table is deliberately
 * short: it *is* the definition of the scope, and an entry added here with no
 * matching downstream command would be a button that fails in the room.
 */
export function translate(
  gesture: Record<string, unknown>,
  view: ControlView | null,
): ControlCommand | null {
  const action = gesture.action
  switch (action) {
    case 'session.start':
    case 'session.end':
    case 'session.reset': {
      /*
       * The target comes from the view, and it travels explicitly.
       *
       * In the room the machine resolves the talk to drive itself. Here it is the
       * hub that computes it — same rule, `talkToControl` — but it can turn over
       * between the render and the click. Sending back the identifier one had in
       * front of them is what stops the next talk from being started.
       */
      const sessionId = view?.targetSession?.id
      return sessionId == null ? null : { type: action, sessionId }
    }
    case 'scene.set':
      return { type: 'scene.set', role: gesture.role as SceneRole }
    case 'display.set':
      return { type: 'display.set', mode: gesture.mode as DisplayMode }
    case 'recording.start':
      return { type: 'recording.set', on: true }
    case 'recording.stop':
      return { type: 'recording.set', on: false }
    case 'stream.start':
      return { type: 'stream.set', on: true }
    case 'stream.stop':
      return { type: 'stream.set', on: false }
    default:
      return null
  }
}

/**
 * The hub's view, rendered in the shape the panels read.
 *
 * This is the heart of the reuse: the components receive a `DisplayPayload` and
 * know nothing else. The fields no hub source can fill are **empty, not
 * invented** — the mobile layout does not mount the panels that would read them,
 * and a plausible `0` in place of an absence is exactly what makes a room look
 * silent.
 */
export function payloadFromView(view: ControlView, nowMs: number): DisplayPayload {
  /*
   * A configuration reduced to what the guards depend on.
   *
   * `conference.ts` reads `promptRecordingOnStart`, `promptRecordingOnStop` and
   * `sceneOnStart` to decide whether to warn before "Commencer", whether to offer
   * to stop the take on "Terminer", and which scene to take afterwards. Filling
   * them from the view is what makes the question asked on a phone exactly the
   * one asked in the room.
   */
  const config: VisibleConfig = {
    obs: {
      A: { url: '', hasPassword: false, pending: false },
      B: { url: '', hasPassword: false, pending: false },
    },
    /*
     * The mapped roles, with their own name as the value.
     *
     * The OBS scene name has no business here — nobody reads it remotely, and the
     * hub does not serve it. What the projection panel needs to know is **which
     * roles exist**: offering "Relais" to a room that has none would give a button
     * nobody knows what it shows, and that would fail on the switch.
     */
    sceneRoles: { A: Object.fromEntries(view.sceneRoles.map((role) => [role, role])), B: {} },
    displayPort: 0,
    recordingRoot: null,
    fileSlug: null,
    relaySourceRoomId: view.relaySourceRoomId,
    openFeedbackProjectId: null,
    promptRecordingOnStart: view.promptRecordingOnStart,
    promptRecordingOnStop: view.promptRecordingOnStop,
    sceneOnStart: view.sceneOnStart,
    /*
     * A phone does not open the folder picker of a machine it cannot see — and
     * the ⚙ is not mounted remotely anyway.
     */
    canBrowse: false,
  }

  return {
    state: {
      /*
       * The screen the room reported, or the loop if it never said.
       *
       * This fallback invents nothing: `loop` is the state a room starts in, the
       * one found in the morning with nobody having touched anything. A room that
       * has not beaten yet therefore does show the loop — and if it is cut off,
       * the connectivity says so right beside it.
       *
       * It comes back with up to ten seconds of delay on a switch decided in the
       * room, and straight away on one requested from here: the room beats as soon
       * as it has applied the command.
       */
      mode: view.displayMode ?? 'loop',
      message: null,
      liveMessage: null,
      question: null,
      sceneRole: view.sceneRole,
      connectivity: view.connectivity,
      roomId: view.roomId,
      contentHash: null,
      /*
       * `currentSession` stays null, and `targetSession` carries everything.
       *
       * The panels mounted remotely only read the target; filling in the current
       * session would ask the hub for a second computation nobody here has any
       * use for.
       */
      currentSession: null,
      nextSession: null,
      outboxDepth: 0,
      /*
       * The hub's clock is authoritative, and it is the one installed here.
       *
       * The store adds this offset to the browser's time for everything that
       * counts time. Without it, a badly set phone — or a hub on a simulated
       * clock, where the offset is measured in weeks — would show a countdown
       * that is nobody's.
       */
      serverTimeOffsetMs: Date.parse(view.serverTime) - nowMs,
      recording: view.recording,
      streaming: view.streaming,
      comments: [],
      sessionStates: view.sessionStates,
      notifications: [],
      targetSession: view.targetSession,
      breakBadge: null,
      targetIsUpcoming: view.targetIsUpcoming,
      simulatedClock: view.simulatedClock,
      /*
       * Null, and rightly so: this field tells the **room** that it is being
       * driven remotely. On the phone doing the driving it has nobody to warn —
       * the lock banner already says who holds the room.
       */
      remoteHolder: null,
    },
    roomName: view.roomName,
    event: null,
    timezone: view.timezone,
    sessions: view.sessions,
    sponsorTiers: [],
    diagnostics: {
      obs: { A: null, B: null },
      questions: [],
      questionsRefreshedAt: null,
      questionsSession: null,
      config,
      mode: { room: 'production', hub: null },
      relaySourceRoomId: view.relaySourceRoomId,
      rooms: [],
      roomsRefreshedAt: null,
      outboxDepth: 0,
      log: [],
      /*
       * The hub stores only a boolean: `startedAtMs` is therefore null, and the
       * recording stopwatch is not mounted remotely. Giving it a plausible start
       * time would show a wrong duration beside a correct red dot.
       *
       * The editing anchors fall with it, and for the same reason: they live in
       * the take, on the room's machine. The buttons are not mounted remotely —
       * `recording.mark` is refused there anyway.
       */
      recording: {
        active: view.recording,
        markers: 0,
        startedAtMs: null,
        startedAtCorrectedMs: null,
        editing: NO_EDITING_MARKS,
      },
    },
    wall: null,
    otherRooms: [],
    socialLinks: [],
    eventIdentity: view.event,
    feedback: null,
    /*
     * No pairing: that is a room-machine matter. The veil only lifts on `null` or
     * `paired`, and `null` is the truth here.
     */
    pairing: null,
  }
}
