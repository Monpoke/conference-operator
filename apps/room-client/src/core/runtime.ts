import { EventEmitter } from 'node:events'
import {
  NOTIFICATION_TTL_MS,
  isCommandExpired,
  type AiredQuestion,
  type BroadcastMessage,
  type Comment,
  type Command,
  type Connectivity,
  type DisplayMode,
  type DisplayState,
  type Notification,
  type SceneRole,
  type SessionStatus,
} from '@conference-operator/contract'
import { talkToControl, roomBreak } from '@conference-operator/room-state'
import {
  currentSession,
  nextSession,
  sessionsForRoom,
  type Program,
  type Session,
} from '@conference-operator/program'
import type { LocalStore } from './store.js'

/*
 * Re-exported, not redefined: the definitions live in `@conference-operator/contract` since
 * the control app became a package of its own. Keeping them visible here saves
 * touching the imports of everything that reads a room's state.
 */
export { NOTIFICATION_TTL_MS }
export type { AiredQuestion, BroadcastMessage, DisplayState, Notification }


export interface RuntimeEffects {
  /** Switches OBS-A. Separate from the runtime so it stays testable with no OBS. */
  setSceneRole?: (role: SceneRole) => Promise<void>
  /** Asks the hub for a sync again after the program is invalidated. */
  resync?: (contentHash: string) => void
  /**
   * Reads the talks' lifecycle back from the hub.
   *
   * The runtime keeps a local copy, fed by the commands as they come: it cannot
   * correct itself when it is *time* that changes, since no command is emitted for
   * decisions that stop applying.
   */
  reloadSessionStates?: () => void
  /** A full resynchronization asked for by the console. */
  fullResync?: () => void
  /**
   * Shipping the rushes back, asked for by the console. A null `file` = everything
   * that is left.
   *
   * The runtime uploads nothing itself: it has neither disk nor network. It passes
   * on, exactly as for the resynchronization.
   */
  uploadVod?: (file: string | null) => void
  /**
   * Erases the room's rushes. **Development only.**
   *
   * The runtime deletes nothing itself: it passes on, as for the rest. The
   * production refusal lives in `RoomApp`, as close to the disk as possible.
   */
  resetVod?: () => void
  /**
   * OBS-B's capture, asked for remotely.
   *
   * Separate from the runtime like `setSceneRole`, and for the same reason: this
   * module decides *what* to do, the machine knows *how*. Asking for what is
   * already running must be a silent success — a command replayed on reconnection
   * must not produce an incident in the control app's stack.
   */
  setRecording?: (on: boolean) => void
  /** OBS-B's stream. The same shape and the same reasons as `setRecording`. */
  setStreaming?: (on: boolean) => void
  /**
   * Asks the hub for the other rooms' state again, without waiting for the polling
   * turn.
   *
   * What a neighbouring room does already arrives pushed on the command stream;
   * only the *view* that displays it was polled. The control app therefore
   * received the "Track #2 has just finished" notification while Track #2's badge
   * still said "running".
   */
  refreshRoomStatuses?: () => void
}

export type CommandOutcome =
  | { applied: true }
  | { applied: false; reason: 'expired' | 'already-applied' | 'unsupported' }

/**
 * The room's current state and the application of the downward commands.
 *
 * Deliberately with no network and no Electron: the runtime decides *what* to
 * display and *which* scene to ask for, the real effects are injected.
 */
export class RoomRuntime extends EventEmitter {
  private display: DisplayState
  private program: Program | null

  constructor(
    private readonly store: LocalStore,
    private readonly effects: RuntimeEffects = {},
    private readonly now: () => number = Date.now,
  ) {
    super()
    const settings = store.settings()
    const cached = store.activeProgram()
    this.program = cached?.program ?? null
    this.display = {
      /**
       * At startup, the waiting loop.
       *
       * It is a room's neutral state before any intervention, and the one one
       * wants to find there in the morning with nobody having touched anything. It
       * shrinks by itself to the pages that have content: a room that has never
       * synchronized shows the sponsors there, as before.
       */
      mode: 'loop',
      message: null,
      liveMessage: null,
      question: null,
      sceneRole: null,
      connectivity: 'OFFLINE',
      roomId: settings.roomId,
      contentHash: cached?.contentHash ?? null,
      currentSession: null,
      nextSession: null,
      outboxDepth: 0,
      serverTimeOffsetMs: settings.clockOffsetMs,
      recording: false,
      streaming: false,
      comments: [],
      sessionStates: {},
      notifications: [],
      simulatedClock: false,
      targetSession: null,
      targetIsUpcoming: false,
      remoteHolder: null,
      breakBadge: null,
    }
    this.refreshSessions()
  }

  state(): DisplayState {
    return { ...this.display }
  }

  /**
   * Applies a state change, and only notifies if there is one.
   *
   * The clock tick recomputes the timeline every 5 s: without this comparison it
   * republished an identical state, and every subscribed page received the
   * complete payload for nothing.
   */
  private patch(patch: Partial<DisplayState>): void {
    const current = this.display as unknown as Record<string, unknown>
    const changed = Object.entries(patch).some(
      ([key, value]) => JSON.stringify(current[key] ?? null) !== JSON.stringify(value ?? null),
    )
    if (!changed) return
    this.display = { ...this.display, ...patch }
    this.emit('state', this.state())
  }

  /**
   * The time corrected by the server offset — never a raw `Date.now()` for display.
   *
   * **`serverTimeOffsetMs` is counted from the machine's clock.** The served pages
   * add it to their own `Date.now()`, the outbox dates its events the same way,
   * and a clock injected here would make them diverge without a word: that is why
   * a room's simulated time is **an offset** and not a replacement clock.
   */
  correctedNow(): number {
    return this.now() + this.display.serverTimeOffsetMs
  }

  setConnectivity(connectivity: Connectivity): void {
    if (connectivity !== this.display.connectivity) this.patch({ connectivity })
  }

  setOutboxDepth(outboxDepth: number): void {
    if (outboxDepth !== this.display.outboxDepth) this.patch({ outboxDepth })
  }

  /**
   * Adds an approved message to the wall.
   *
   * Deduplicates: resuming the stream after an outage can redeliver what is
   * already displayed.
   */
  addComment(comment: Comment, limit = 12): void {
    if (this.display.comments.some((existing) => existing.id === comment.id)) return
    this.patch({ comments: [...this.display.comments, comment].slice(-limit) })
  }

  /**
   * Reports a fact in the control app. The oldest ones drop off: a stack that
   * grows endlessly stops being read.
   */
  notify(notification: Omit<Notification, 'id' | 'at'>, limit = 5): void {
    const entry: Notification = {
      ...notification,
      id: `${this.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date(this.correctedNow()).toISOString(),
    }
    this.patch({ notifications: [...this.display.notifications, entry].slice(-limit) })
  }

  dismissNotification(id: string): void {
    this.patch({ notifications: this.display.notifications.filter((n) => n.id !== id) })
  }

  /** Applies a state change decided on the hub or by the schedule rule. */
  setSessionStatus(sessionId: string, status: SessionStatus): void {
    const next = { ...this.display.sessionStates }
    // `scheduled` is the absence of state: we remove rather than store a marker
    // that would mean "nothing happened".
    if (status === 'scheduled') delete next[sessionId]
    else next[sessionId] = status
    this.patch({ sessionStates: next })
    // The target depends on the lifecycle: ending the upcoming talk must move the
    // control app to the next one straight away, not at the next tick.
    this.refreshSessions()
  }

  /**
   * Replaces the whole lifecycle with what the hub says.
   *
   * A replacement, not a merge: what has disappeared from the hub's list must
   * disappear here too. A cancelled decision — by the console, or because the
   * clock was moved back — is erased in no other way, and a room that kept
   * "running" on an upcoming talk would paint its badge and its countdown on a
   * fact that no longer exists.
   */
  replaceSessionStates(states: { sessionId: string; status: SessionStatus }[]): void {
    const next: Record<string, SessionStatus> = {}
    // `scheduled` stays the absence of state, identically to setSessionStatus.
    for (const state of states) {
      if (state.status !== 'scheduled') next[state.sessionId] = state.status
    }
    this.patch({ sessionStates: next })
    this.refreshSessions()
  }

  /** The drivable talk's state. */
  currentSessionStatus(): SessionStatus {
    const id = this.display.targetSession?.id
    return id == null ? 'scheduled' : (this.display.sessionStates[id] ?? 'scheduled')
  }

  /** Reflects OBS-B's state. Always from an OBS event, never assumed. */
  observeCapture(patch: { recording?: boolean; streaming?: boolean }): void {
    const next = { ...this.display, ...patch }
    if (next.recording !== this.display.recording || next.streaming !== this.display.streaming) {
      this.patch({ recording: next.recording, streaming: next.streaming })
    }
  }

  /**
   * Aligns the clock on the hub's.
   *
   * The gap is measured against **our** clock, not against a `Date.now()` read
   * back by the caller. The nuance cost dearly: measured crookedly, the gap added
   * itself to an already offset room, and the control app looked for its talks
   * several weeks after the end of the event — "no talk to drive", while the other
   * rooms' stream fell right.
   */
  setServerTime(serverTime: string, simulated = this.display.simulatedClock): void {
    this.setClockOffset(Date.parse(serverTime) - this.now(), simulated)
  }

  setClockOffset(offsetMs: number, simulated = this.display.simulatedClock): void {
    if (offsetMs === this.display.serverTimeOffsetMs && simulated === this.display.simulatedClock) {
      return
    }
    this.store.saveSettings({ clockOffsetMs: offsetMs })
    this.patch({ serverTimeOffsetMs: offsetMs, simulatedClock: simulated })
    // The time has moved: so has the running talk, perhaps. Waiting for the next
    // tick would leave the screen pointing at the wrong talk for 5 s.
    this.refreshSessions()
  }

  /**
   * A banner set from the control app.
   *
   * With no lifetime: the control app has a button to remove it, and a banner that
   * disappears by itself while one is looking elsewhere comes back without anyone
   * knowing why it had gone.
   */
  setLiveMessage(text: string | null, level: 'info' | 'warning' | 'urgent' = 'info'): void {
    this.patch({ liveMessage: text == null ? null : { text, level, expiresAtMs: null } })
  }

  /**
   * A question put on air from the control app.
   *
   * With no lifetime, like the banner: the control app has a button to remove it.
   * It does carry the talk it attaches to, though — see `refreshSessions`, which
   * makes it drop at the next talk.
   */
  setQuestion(text: string | null, author: string | null, sessionId: string | null): void {
    this.patch({ question: text == null ? null : { text, author, sessionId } })
  }

  setProgram(contentHash: string, program: Program): void {
    this.program = program
    this.patch({ contentHash })
    this.refreshSessions()
  }

  setRoomId(roomId: string): void {
    this.patch({ roomId })
    this.refreshSessions()
  }

  /** Recomputes the running / next session. To be called again on a clock tick. */
  refreshSessions(): void {
    const { roomId } = this.display
    if (this.program == null || roomId == null) {
      this.patch({ currentSession: null, nextSession: null, breakBadge: null })
      return
    }
    const at = this.correctedNow()
    const running = currentSession(this.program, roomId, at)
    const next = nextSession(this.program, roomId, at)

    /**
     * The commands' target: what "Start" and "End" reach.
     *
     * The rule lives in `talkToControl`, with the rest of the state machine: the
     * hub's console and the test bench run it too, and three copies of a schedule
     * rule always end up diverging.
     */
    const target = talkToControl(
      sessionsForRoom(this.program, roomId),
      at,
      this.display.sessionStates,
    )

    /**
     * The question on air drops with the talk it belongs to.
     *
     * Without that, it stays burned into the capture overlay while the next
     * speaker settles in — engraved in their VOD, addressed to somebody else. A
     * question with no talk attached (asked outside a talk) is not concerned:
     * nothing says when it should drop.
     */
    const question = this.display.question
    const staleQuestion =
      question != null && question.sessionId != null && question.sessionId !== target?.id

    const onBreak = roomBreak(this.program, roomId, at)

    this.patch({
      currentSession: running,
      nextSession: next,
      targetSession: target,
      /**
       * "Upcoming" is read on the schedule, not on the gap to the current session.
       *
       * A talk in overrun is no longer the current slot — its slot is closed —
       * without being upcoming for all that: it is on air. Comparing the
       * identifiers announced it as "upcoming" at the precise moment it was
       * overrunning.
       */
      targetIsUpcoming: target != null && target.startsAtMs > at,
      breakBadge:
        onBreak == null
          ? null
          : { state: onBreak.state, title: onBreak.session.title, startsAt: onBreak.session.startsAt },
      ...(staleQuestion ? { question: null } : {}),
    })
  }

  /** A display switch asked for locally by the operator. */
  async setDisplayMode(mode: DisplayMode): Promise<void> {
    this.patch({ mode })
  }

  async setSceneRole(role: SceneRole): Promise<void> {
    await this.effects.setSceneRole?.(role)
    this.patch({ sceneRole: role })
  }

  /** The scene state observed on OBS is authoritative and overwrites ours. */
  observeSceneRole(role: SceneRole | null): void {
    if (role !== this.display.sceneRole) this.patch({ sceneRole: role })
  }

  /**
   * Applies a command from the hub.
   *
   * Two filters before any action, in this order: the expiration (a "lunch break"
   * caught up 40 min later must not display) then the replay (a reconnection can
   * redeliver what is already applied).
   */
  async applyCommand(command: Command): Promise<CommandOutcome> {
    if (isCommandExpired(command, this.correctedNow())) {
      // Marked anyway: otherwise every reconnection would redeliver it.
      this.store.markApplied(command.seq, command.payload.type)
      return { applied: false, reason: 'expired' }
    }
    if (this.store.hasApplied(command.seq)) {
      return { applied: false, reason: 'already-applied' }
    }

    const payload = command.payload
    switch (payload.type) {
      case 'scene.force':
        await this.setSceneRole(payload.role)
        break
      case 'display.set':
        this.patch({ mode: payload.mode })
        break
      case 'message.broadcast': {
        const author = payload.from == null ? '' : `${payload.from} : `
        if (payload.target === 'operator') {
          /**
           * The control app's banner only.
           *
           * Switching the room screen for a note to the operator would display it
           * large in front of the audience — "your speaker has arrived" has no
           * business there.
           */
          this.notify({
            level: payload.level === 'info' ? 'info' : 'warning',
            text: `${author}${payload.text}`,
          })
          break
        }

        /**
         * Aimed at the audience: the room screen takes the message.
         *
         * The display time runs from **now**, not from the hub's emission. A
         * displayed message must stay readable for the announced time, even if it
         * took a few seconds to arrive — or if the room's clock diverges from the
         * hub's. Staleness is a completely different filter: it is judged on
         * `issuedAt`, before arriving here.
         */
        this.patch({
          mode: 'message',
          message: {
            text: payload.text,
            level: payload.level,
            expiresAtMs:
              command.ttlSeconds == null ? null : this.correctedNow() + command.ttlSeconds * 1000,
          },
        })
        // The control app must also know what is being projected at its end.
        this.notify({
          level: payload.level === 'urgent' ? 'warning' : 'info',
          text: `Affiché en salle — ${author}${payload.text}`,
        })
        break
      }
      case 'overlay.set':
        // The banner touches neither the screen mode nor the scene: it overlays,
        // and the room carries on with exactly what it was doing.
        this.patch({
          liveMessage:
            payload.message == null
              ? null
              : {
                  ...payload.message,
                  expiresAtMs:
                    command.ttlSeconds == null
                      ? null
                      : this.correctedNow() + command.ttlSeconds * 1000,
                },
        })
        break
      case 'program.invalidate':
        this.effects.resync?.(payload.contentHash)
        break
      case 'room.resync':
        /**
         * Reported in the control app, and not only in the log.
         *
         * A room that starts downloading its program again in the middle of a day
         * without anyone on site having asked for it reads as an incident. Saying
         * where the gesture comes from saves one going to look for it.
         */
        this.notify({
          level: 'info',
          text:
            payload.requestedBy == null
              ? 'Resynchronisation complète demandée depuis la console'
              : `Resynchronisation complète demandée par ${payload.requestedBy}`,
        })
        this.effects.fullResync?.()
        break
      case 'vod.upload':
        /**
         * Reported in the control app, like the resynchronization, and for the same
         * reason.
         *
         * A room that starts saturating its uplink in the middle of a day without
         * anyone on site having asked for it reads as an incident. Saying where the
         * gesture comes from saves one looking for a failure.
         */
        this.notify({
          level: 'info',
          text:
            payload.requestedBy == null
              ? 'Rapatriement des rushes demandé depuis la console'
              : `Rapatriement des rushes demandé par ${payload.requestedBy}`,
        })
        this.effects.uploadVod?.(payload.file)
        break
      case 'vod.reset':
        /**
         * Reported in the control app, and as a warning.
         *
         * A room that loses its rushes must say so loudly and name who asked for
         * it: it is the system's only gesture there is no coming back from, and
         * discovering the folder empty without knowing why is the worse of the two
         * moments.
         */
        this.notify({
          level: 'warning',
          text:
            payload.requestedBy == null
              ? 'Remise à zéro des rushes demandée depuis la console'
              : `Remise à zéro des rushes demandée par ${payload.requestedBy}`,
        })
        this.effects.resetVod?.()
        break
      case 'recording.set':
        /**
         * Reported in the control app, like the resynchronization and for the same
         * reason.
         *
         * A recording that starts — or worse, that stops — without anyone having
         * touched the room's keyboard reads as an OBS failure. Naming who asked for
         * it saves one going to look for a defect where there is none.
         */
        this.notify({
          level: 'info',
          text: `${payload.on ? 'Enregistrement démarré' : 'Enregistrement arrêté'} ${requestedByLabel(payload.requestedBy)}`,
        })
        this.effects.setRecording?.(payload.on)
        break
      case 'stream.set':
        this.notify({
          level: 'info',
          text: `${payload.on ? 'Diffusion démarrée' : 'Diffusion arrêtée'} ${requestedByLabel(payload.requestedBy)}`,
        })
        this.effects.setStreaming?.(payload.on)
        break
      case 'regie.hold':
        /**
         * Who is driving the room remotely — a display, and nothing else.
         *
         * No button is greyed out here: the operator who is in the room must never
         * depend on a phone that has gone off down a corridor, nor on a lock
         * somebody forgot to release. What the command changes is what the screen
         * *says*, failing which a scene that switches by itself is read as an
         * incident — in the middle of a talk.
         */
        this.patch({ remoteHolder: payload.holder })
        this.notify({
          level: 'info',
          text:
            payload.holder == null
              ? 'La régie mobile a rendu la salle'
              : `Salle pilotée à distance par ${payload.holder}`,
        })
        break
      case 'session.state': {
        const ours = this.display.roomId
        if (payload.roomId == null || payload.roomId === ours) {
          this.setSessionStatus(payload.sessionId, payload.status)
          break
        }
        /**
         * Another room: we do not touch our state, but we go and read theirs.
         *
         * The other rooms' lifecycle is not sent to us — and we do not want it, it
         * has no business in our state. What displays it is the supervision view,
         * which is polled: the command therefore serves as a trigger, and the badge
         * follows the notification instead of trailing it by one turn.
         */
        this.effects.refreshRoomStatuses?.()
        if (payload.status === 'ended') {
          this.notify({
            level: 'info',
            text: `${payload.sessionTitle ?? 'Une conférence'} vient de se terminer dans une autre salle`,
          })
        }
        break
      }
      case 'clock.changed': {
        /**
         * The hub's time has moved: we realign immediately.
         *
         * Without that, the screen would keep showing the old moment until the next
         * synchronization — and the timeline would point at the wrong talk.
         */
        this.setServerTime(payload.serverTime, payload.simulated)
        /**
         * And we read the lifecycle back straight away.
         *
         * Moving the clock back cancels decisions: a talk launched later in the day
         * has not started yet at the new instant. The hub knows it — it is the hub
         * that dates the decisions — the room does not: without this re-read, the
         * control app keeps "running" on an upcoming talk until the next
         * synchronization.
         */
        this.effects.reloadSessionStates?.()
        this.notify({
          level: 'info',
          text: payload.simulated
            ? "Heure du hub modifiée (horloge simulée)"
            : "Heure du hub revenue à l'heure réelle",
        })
        break
      }
      case 'session.override':
      case 'wall.approved':
      case 'stream.configure':
        // Wired up in later batches; we trace the application so as not to receive
        // them in a loop on every reconnection.
        this.store.markApplied(command.seq, payload.type)
        return { applied: false, reason: 'unsupported' }
    }

    this.store.markApplied(command.seq, payload.type)
    return { applied: true }
  }

  /** Removes a message whose TTL has run out. To be called on a clock tick. */
  expireMessage(): void {
    const { message, liveMessage } = this.display
    const now = this.correctedNow()

    if (message?.expiresAtMs != null && now > message.expiresAtMs) {
      // Back to the waiting loop: it is the room's default screen, and the one one
      // wants to fall back on when a message clears by itself.
      this.patch({ message: null, mode: 'loop' })
    }
    // The banner expires by itself, but brings nothing back: it had substituted
    // for nothing, it simply withdraws from the picture.
    if (liveMessage?.expiresAtMs != null && now > liveMessage.expiresAtMs) {
      this.patch({ liveMessage: null })
    }
  }

  /**
   * Removes the notices that are out of date. To be called on a clock tick.
   *
   * Dismissing by hand stays possible and immediate; this only concerns those
   * nobody dismissed, that is, most of them: in the control room one reads the
   * banner, one does not tidy it away.
   */
  expireNotifications(): void {
    const { notifications } = this.display
    if (notifications.length === 0) return
    const limit = this.correctedNow() - NOTIFICATION_TTL_MS
    const remaining = notifications.filter((notice) => Date.parse(notice.at) > limit)
    if (remaining.length !== notifications.length) this.patch({ notifications: remaining })
  }
}

/**
 * Where a remotely made gesture comes from.
 *
 * `null` only arrives from a hub older than this command — the field has a
 * default. We then say "from the hub" rather than inventing a name: the notice
 * exists so that the operator stops looking for a failure, and "by nobody" would
 * relaunch exactly the search it must close.
 */
function requestedByLabel(requestedBy: string | null): string {
  return requestedBy == null ? 'depuis le hub' : `par ${requestedBy}`
}
