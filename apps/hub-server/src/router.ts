import { implement, withEventMeta } from '@orpc/server'
import { ORPCError } from '@orpc/server'
import {
  DEFAULT_VOD_POLICY,
  PROTOCOL_VERSION,
  CONTROL_SESSION_HEADER,
  contract,
  isCommandExpired,
  type CaptureView,
  type Command,
} from '@conference-operator/contract'
import { roomBreak } from '@conference-operator/room-state'
import {
  currentSession,
  nextSession,
  DEFAULT_TIMEZONE,
  openFeedbackUrl,
  type Session,
} from '@conference-operator/program'
import type { RawCapture } from './services/ingest.js'
import { checkOpenFeedback } from './services/openfeedback.js'
import {
  controlCommand,
  controlRooms,
  UnknownRoom,
  LockHeld,
  controlView,
} from './services/control.js'
import { TransitionRefused } from './services/sessions.js'
import { IncompleteStorage, type VodService } from './services/vod.js'
import { S3Error } from './services/s3.js'
import { roomStatuses } from './supervision.js'
import {
  authorOf,
  publicIdentity,
  resolveActor,
  resolveClaim,
  resolveOperator,
  resolveRoom,
  type ActorContext,
  type HubContext,
} from './context.js'

const os = implement(contract).$context<HubContext>()

/**
 * Authenticated operator (hub-admin).
 */
const operatorOnly = os.middleware(async ({ context, next }) =>
  next({ context: await resolveOperator(context) }),
)

/**
 * Paired machine: adds `roomId` to the context.
 */
const roomOnly = os.middleware(async ({ context, next }) =>
  next({ context: await resolveRoom(context) }),
)

/**
 * Console **or** room machine.
 *
 * For the procedures both legitimately need — the state of the rooms, the talk
 * lifecycle. The context then carries `roomId` when the caller is a room, which
 * lets what it touches be bounded.
 */
const roomOrOperator = os.middleware(async ({ context, next }) =>
  next({ context: await resolveActor(context) }),
)

/**
 * The hub's time, as it will be propagated to the rooms.
 *
 * Each room measures its offset against this value: simulating it here moves the
 * whole system, with nothing to set on the room side.
 */
const nowIso = (context: HubContext) => context.services.clock.nowIso()

export const router = os.router({
  meta: {
    hello: os.meta.hello.handler(({ input, context }) => ({
      protocolVersion: PROTOCOL_VERSION,
      serverTime: nowIso(context),
      simulatedClock: context.services.clock.simulated,
      compatible: input.protocolVersion === PROTOCOL_VERSION,
    })),
  },

  program: {
    import: os.program.import
      .use(operatorOnly)
      .handler(async ({ input, context }) => {
        const snapshot = await context.services.programs.importFrom(input.sourceUrl)
        // The rooms follow from the tracks: creating them here saves entering
        // them again, and makes the pairing list usable immediately.
        context.services.rooms.ensureFromTracks(snapshot.program.rooms)
        // Tell the rooms rather than wait for their next sync: a program change
        // must reach the screen in seconds.
        //
        // The fingerprint announced is that of the **served** program, read back
        // after the import: the day's decisions can survive a reimport, and
        // announcing the snapshot's would designate a version nobody receives.
        context.services.commands.publish(
          null,
          {
            type: 'program.invalidate',
            contentHash: context.services.programs.active()?.contentHash ?? snapshot.contentHash,
          },
          null,
        )
        return snapshot
      }),
    snapshots: os.program.snapshots
      .use(operatorOnly)
      .handler(({ context }) => context.services.programs.list()),
    activate: os.program.activate.use(operatorOnly).handler(({ input, context }) => {
      context.services.programs.activate(input.contentHash)
      // Read back after the switch, and for the same reason as at import time:
      // it is the served program's fingerprint the rooms will compare to theirs.
      context.services.commands.publish(
        null,
        {
          type: 'program.invalidate',
          contentHash: context.services.programs.active()?.contentHash ?? input.contentHash,
        },
        null,
      )
      return { ok: true }
    }),

    /**
     * The active program, flattened for the console.
     *
     * The hub already holds it; the console only knew the talks that had started and
     * could therefore not answer "and what comes next". Flattened here rather than
     * returned whole: bios, logos and artwork make up most of a snapshot's 70 kB, and
     * none of that is shown in a schedule.
     */
    /**
     * The current shared slot, seen from the event and not from a room.
     *
     * Computed room by room then grouped: it is the only honest way to say "three
     * rooms". A shared slot is not an entity of the program — it is a break
     * several rooms hold at the same moment, some because it is in their program,
     * the others because they have nothing scheduled and inherit it.
     *
     * Decided by the number of rooms: on an event where two breaks overlap, the
     * one that concerns the most people is the one we show.
     */
    globalBreak: os.program.globalBreak.use(operatorOnly).handler(({ context }) => {
      const snapshot = context.services.programs.active()
      const at = context.services.clock.now()
      if (snapshot == null) return null

      const groups = new Map<
        string,
        { state: 'en-cours' | 'a-venir'; title: string; startsAt: string; endsAt: string | null; startsAtMs: number; rooms: number }
      >()
      for (const room of snapshot.program.rooms) {
        const pause = roomBreak(snapshot.program, room.id, at)
        if (pause == null) continue
        const key = `${pause.session.startsAtMs}-${pause.endsAtMs ?? ''}-${pause.session.title}`
        const known = groups.get(key)
        if (known != null) {
          known.rooms += 1
          // A room already on a break wins over a room anticipating one: the
          // slot has started somewhere, it is no longer being announced.
          if (pause.state === 'en-cours') known.state = 'en-cours'
          continue
        }
        groups.set(key, {
          state: pause.state,
          title: pause.session.title,
          startsAt: pause.session.startsAt,
          endsAt: pause.endsAtMs == null ? null : new Date(pause.endsAtMs).toISOString(),
          startsAtMs: pause.session.startsAtMs,
          rooms: 1,
        })
      }

      const chosen = [...groups.values()].sort(
        (a, b) => b.rooms - a.rooms || a.startsAtMs - b.startsAtMs,
      )[0]
      if (chosen == null) return null

      const { startsAtMs: _ignore, ...rest } = chosen
      return { ...rest, serverTime: nowIso(context) }
    }),

    /**
     * Compares the program's identifiers with what OpenFeedback knows.
     *
     * Breaks are excluded: they have no feedback page, and counting them as missing
     * would drown the real anomalies. Breaks inherited from another room too — they
     * only exist as a projection.
     *
     * A network failure is translated, as for the storage: "fetch failed" says nothing
     * to whoever reads the console, and a check that fails without saying why never
     * gets run again.
     */
    controleOpenFeedback: os.program.controleOpenFeedback
      .use(operatorOnly)
      .handler(async ({ context }) => {
        const project = filled(context.services.settings.get().openFeedbackProjectId)
        if (project == null) {
          throw new ORPCError('BAD_REQUEST', {
            message:
              'Aucun projet OpenFeedback réglé : il n\'y a rien à contrôler tant que ' +
              'le champ des réglages est vide.',
          })
        }
        const snapshot = context.services.programs.active()
        if (snapshot == null) {
          throw new ORPCError('NOT_FOUND', { message: 'Aucun programme actif sur ce hub' })
        }

        const slots = snapshot.program.sessions
          .filter((session) => session.kind !== 'break' && session.sharedFrom == null)
          .map((session) => ({
            id: session.id,
            title: session.title,
            feedbackId: session.feedbackId ?? session.id,
          }))

        try {
          return await checkOpenFeedback(project, slots)
        } catch (cause) {
          throw new ORPCError('BAD_GATEWAY', {
            message: `OpenFeedback est injoignable : ${readableCause(cause)}`,
          })
        }
      }),

    planning: os.program.planning.use(operatorOnly).handler(({ context }) => {
      const snapshot = context.services.programs.active()
      // No error: a hub that has just been installed has no program yet, and the
      // console must be able to say so rather than break.
      if (snapshot == null) {
        return {
          contentHash: null,
          timezone: DEFAULT_TIMEZONE,
          serverTime: nowIso(context),
          // The setting is read anyway: with no program there is no link to
          // build, but the console can already say whether one is missing.
          openFeedbackProjectId: filled(
            context.services.settings.get().openFeedbackProjectId,
          ),
          rooms: [],
          sessions: [],
        }
      }

      const { program } = snapshot
      const rooms = new Map(context.services.rooms.list().map((room) => [room.id, room]))
      // The hub is authoritative on a room's name — it gets renamed from the
      // console — but a track that has never been paired is not there yet: the
      // program then gives the name written on the door, rather than a slug.
      const programRoomNames = new Map(program.rooms.map((room) => [room.id, room.name]))
      /**
       * The event's OpenFeedback project. One only, and it comes from the hub.
       *
       * No more per-room override: the field existed in the control app's ⚙, and
       * it took one operator filling it in on one machine for that room to have
       * links and the others none. The project is a property of the event — a slot
       * with no room, a plenary the export attaches to no track, has as much right
       * to its link as any other.
       */
      const eventProject = filled(
        context.services.settings.get().openFeedbackProjectId,
      )

      /**
       * The **applied** decisions, so the console can tell a decided kind from an
       * imported one: it is the first it offers to remove, and it is from there
       * that it derives what the export says.
       */
      const appliedOverrides = snapshot.overrides

      /**
       * The lifecycle, joined here rather than cross-referenced by the console.
       *
       * `states(null)`: every room at once, since this is the event's centralized
       * view. The applicability filter applies as elsewhere — a decision dated
       * after the hub's instant, which only happens under a simulated clock, must
       * not appear here either.
       */
      const lived = new Map(
        context.services.sessions.states(null).map((state) => [state.sessionId, state]),
      )

      return {
        contentHash: snapshot.contentHash,
        timezone: program.timezone,
        serverTime: nowIso(context),
        openFeedbackProjectId: eventProject,
        rooms: program.rooms.map(({ id, name }) => ({ id, name })),
        sessions: program.sessions.map((session) => {
          const room = session.roomId == null ? null : (rooms.get(session.roomId) ?? null)
          return {
            id: session.id,
            title: session.title,
            speakers: session.speakers.map((person) => person.name),
            startsAt: session.startsAt,
            endsAt: session.endsAt,
            roomId: session.roomId,
            roomName:
              session.roomId == null
                ? null
                : (room?.name ?? programRoomNames.get(session.roomId) ?? session.roomId),
            kind: session.kind,
            // No link on a break: nobody rates a lunch, and a dead QR code
            // scanned by the audience costs more than an empty cell.
            feedbackUrl:
              session.kind === 'break'
                ? null
                : openFeedbackUrl(session, eventProject, program.timezone),
            // Resolved, like `kind`: the export unless corrected. The served
            // program already carries the correction, nothing to cross-reference.
            feedbackId: session.feedbackId ?? session.id,
            feedbackIdOverride: session.feedbackId,
            overriddenAs: appliedOverrides[session.id] ?? null,
            sharedFrom: session.sharedFrom,
            /**
             * An inherited break carries a derived identifier the lifecycle does
             * not know: it is the original slot that is driven. Looking it up
             * under the projection's identifier would never return anything, and
             * doing so under the original's would show the same decision on two
             * rows.
             */
            startedAt: lived.get(session.id)?.startedAt ?? null,
            endedAt: lived.get(session.id)?.endedAt ?? null,
            decidedBy: lived.get(session.id)?.decidedBy ?? null,
          }
        }),
      }
    }),
  },

  rooms: {
    /**
     * Public: an unpaired machine must be able to offer a choice.
     */
    public: os.rooms.public.handler(({ context }) =>
      context.services.rooms.list().map((room) => ({ id: room.id, name: room.name })),
    ),

    list: os.rooms.list.use(operatorOnly).handler(({ context }) => context.services.rooms.list()),

    /**
     * Public, like `rooms.public`: the wall is open to whoever scans the QR code, and
     * these titles are already projected on the room's screen.
     */
    current: os.rooms.current.handler(({ input, context }) => {
      const snapshot = context.services.programs.active()
      if (snapshot == null) return { current: null, next: null }

      const at = context.services.clock.now()
      const preview = (session: Session | null) =>
        session == null
          ? null
          : {
              id: session.id,
              title: session.title,
              speakers: session.speakers.map((person) => person.name),
              startsAt: session.startsAt,
              endsAt: session.endsAt,
            }

      return {
        current: preview(currentSession(snapshot.program, input.roomId, at)),
        next: preview(nextSession(snapshot.program, input.roomId, at)),
      }
    }),

    /**
     * A room configuring itself — see the contract for what it is allowed to touch.
     * The target is not in the input but in the context: there is no form of this call
     * that configures another room.
     */
    configure: os.rooms.configure.use(roomOnly).handler(({ input, context }) => {
      const room = context.services.rooms.get(context.roomId)
      if (room == null) throw new ORPCError('NOT_FOUND', { message: 'Salle introuvable' })

      const relay = input.relaySourceRoomId
      if (relay != null) {
        if (relay === context.roomId) {
          throw new ORPCError('BAD_REQUEST', {
            message: "Une salle ne peut pas relayer sa propre scène",
          })
        }
        if (context.services.rooms.get(relay) == null) {
          throw new ORPCError('BAD_REQUEST', { message: 'Salle relayée inconnue du hub' })
        }
      }

      // A shallow merge: the control app sends whole `obs` and `sceneRoles`.
      // What is not in the patch — identity, stream key — stays as it is, and
      // that is what makes writing from a room safe.
      const next = {
        ...room,
        ...input,
        // The one exception to the shallow merge: an OBS password missing from
        // the patch means "unchanged", not "cleared". The control app does not
        // have it in clear, so it cannot send it back to keep it.
        obs: input.obs == null ? room.obs : {
          A: { url: input.obs.A.url, password: input.obs.A.password === undefined ? room.obs.A.password : input.obs.A.password },
          B: { url: input.obs.B.url, password: input.obs.B.password === undefined ? room.obs.B.password : input.obs.B.password },
        },
      }
      context.services.rooms.upsert(next)
      return next
    }),
    /**
     * Read-only: the control app shows the state of the other rooms.
     */
    statuses: os.rooms.statuses.use(roomOrOperator).handler(({ context }) =>
      // Enriched outside the service: this is where the program and the clock
      // are at hand, and the watch that pushes the notifications reads the same
      // function — two implementations would end up diverging.
      roomStatuses(context.services, context.services.clock.now()),
    ),

    /**
     * Full resynchronization, requested from the console.
     *
     * A command, not a direct call: the console does not talk to the rooms, it goes
     * through the downstream flow — that is what makes a momentarily disconnected room
     * catch the request up on reconnection instead of losing it.
     *
     * With no TTL, for the same reason: a request to put a room straight does not
     * expire like a "lunch break". Deduplication by `seq` stops it being applied twice
     * on catch-up.
     */
    resync: os.rooms.resync.use(operatorOnly).handler(({ input, context }) => {
      if (input.roomId != null && context.services.rooms.get(input.roomId) == null) {
        throw new ORPCError('NOT_FOUND', { message: `Salle inconnue : ${input.roomId}` })
      }
      context.services.commands.publish(
        input.roomId,
        { type: 'room.resync', requestedBy: context.operator.email },
        null,
      )
      return {
        ok: true,
        rooms: input.roomId != null ? 1 : context.services.rooms.list().length,
      }
    }),

    sync: os.rooms.sync.use(roomOnly).handler(({ input, context }) => {
      const room = context.services.rooms.get(context.roomId)
      if (room == null) throw new ORPCError('NOT_FOUND', { message: 'Salle introuvable' })

      const snapshot = context.services.programs.active()
      if (snapshot == null) {
        throw new ORPCError('NOT_FOUND', { message: 'Aucun programme importé sur le hub' })
      }

      // The snapshot only leaves again if it changed: on a sluggish room
      // network, sending 70 kB on every heartbeat would be waste.
      const unchanged = input.since === snapshot.contentHash
      const settings = context.services.settings.get()
      return {
        protocolVersion: PROTOCOL_VERSION,
        contentHash: snapshot.contentHash,
        program: unchanged ? null : snapshot.program,
        // The OpenFeedback project goes down **overwritten**, not merged:
        // whatever a room has in cache or in its database, the hub's setting is
        // authoritative. The room draws its QR codes offline, so the value has to
        // travel; but it has nothing to decide, and can no longer contradict.
        room: {
          ...room,
          openFeedbackProjectId: filled(settings.openFeedbackProjectId),
        },
        overrides: context.services.rooms.overrides(),
        serverTime: nowIso(context),
        simulatedClock: context.services.clock.simulated,
        mode: context.services.mode,
        // Sent down with the rest: the waiting loop must run through in full
        // without touching the network once the room is synchronized.
        socialLinks: settings.socialLinks,
        // Same reason, and it is what makes the screens renameable: the room
        // titles its windows with the name the hub decided, not with a constant
        // compiled into the binary installed on the machine.
        event: context.services.identity.get(),
        /**
         * Shipping the rushes back: is there a destination, and under what rules.
         *
         * Sent down at sync and cached like the rest: the room's regulator decides
         * several times a minute, and it must never depend on a network call —
         * least of all at the very moment the network is what we are trying to
         * spare. `null` says "nowhere to send", and a room that receives `null`
         * stops by itself: that is how the feature gets switched off mid-day from
         * the console.
         */
        vod:
          context.services.vod == null || !context.services.vod.ready()
            ? null
            : context.services.vod.sync(),
      }
    }),

    commands: os.rooms.commands
      .use(roomOnly)
      .handler(async function* ({ context, lastEventId, signal }) {
        const sinceSeq = parseSeq(lastEventId)
        for await (const command of context.services.commands.stream(
          context.roomId,
          sinceSeq,
          signal,
        )) {
          // A command caught up out of time is discarded on the hub side too:
          // the client would filter it anyway, so we may as well not send it.
          if (isExpiredNow(command)) continue
          // The event id carries the `seq`: it is what the client will send back
          // as `lastEventId` on reconnection.
          yield withEventMeta(command, { id: String(command.seq) })
        }
      }),
  },

  /**
   * Banner on the live scenes.
   *
   * Reserved for operators: what goes out there goes into the live feed and into the
   * VOD of every targeted room.
   */
  overlay: {
    show: os.overlay.show.use(operatorOnly).handler(({ input, context }) => {
      context.services.commands.publish(
        input.roomId,
        { type: 'overlay.set', message: input.message },
        input.ttlSeconds,
      )
      return { ok: true }
    }),

    hide: os.overlay.hide.use(operatorOnly).handler(({ input, context }) => {
      context.services.commands.publish(input.roomId, { type: 'overlay.set', message: null }, null)
      return { ok: true }
    }),

    history: os.overlay.history.use(operatorOnly).handler(({ input, context }) => {
      const past = context.services.commands.pastBanners(input.roomId, input.limit)
      // The most recent one says what is on air: a removal is not history, but
      // it switches off the banner it removed.
      const shown = past.find((entry) => entry.payload.message != null)
      const removedAt = past.findIndex((entry) => entry.payload.message == null)
      const running = removedAt === 0 ? null : shown

      return past
        .filter((entry) => entry.payload.message != null)
        .slice(0, input.limit)
        .map((entry) => ({
          seq: entry.seq,
          roomId: entry.roomId,
          message: entry.payload.message as { text: string; level: 'info' | 'warning' | 'urgent' },
          issuedAt: entry.issuedAt,
          visible: running != null && entry.seq === running.seq,
        }))
    }),
  },

  sessions: {
    states: os.sessions.states.use(roomOrOperator).handler(({ input, context }) => {
      const room = context.roomId
      // A room only sees its own talks, whatever it asks for.
      const snapshot = context.services.programs.active()
      return context.services.sessions.views(room ?? input.roomId, snapshot?.program ?? null)
    }),

    start: os.sessions.start.use(roomOrOperator).handler(({ input, context }) => {
      const { session, roomId } = resolveSession(context, input.sessionId)
      requireSameRoom(context, roomId)
      const state = onTransition(() =>
        context.services.sessions.start(session.id, roomId, authorOf(context)),
      )
      broadcastState(context, state)
      return state
    }),

    end: os.sessions.end.use(roomOrOperator).handler(({ input, context }) => {
      const { session, roomId } = resolveSession(context, input.sessionId)
      requireSameRoom(context, roomId)
      const state = onTransition(() =>
        context.services.sessions.end(session.id, roomId, authorOf(context)),
      )
      broadcastState(context, state)
      return state
    }),

    /**
     * Overrides a program slot.
     *
     * The gesture only exists because the upstream export does not say everything: a
     * welcome, a lunch, a plenary are slots like any other there, attached to a room,
     * with a title. So the room titled them on air and the control app offered to
     * "start" them.
     *
     * Decided here and not in the room: it is the event's program we are correcting,
     * and it must read the same everywhere. The broadcast that follows sends the
     * corrected program back down — the fingerprint has changed, so the rooms will not
     * stay on their cache.
     */
    override: os.sessions.override.use(operatorOnly).handler(({ input, context }) => {
      const snapshot = context.services.programs.active()
      if (snapshot == null) {
        throw new ORPCError('NOT_FOUND', { message: 'Aucun programme actif sur ce hub' })
      }
      const slot = snapshot.program.sessions.find((session) => session.id === input.sessionId)
      if (slot == null) {
        throw new ORPCError('NOT_FOUND', {
          message: `Créneau inconnu du programme actif : ${input.sessionId}`,
        })
      }
      /**
       * A break inherited from another room is not editable.
       *
       * It does not exist in the export: it is the projection of a slot which is
       * editable. Accepting a decision on it would record it under a derived
       * identifier the next computation would not find — a decision with no effect
       * that nobody would know how to remove.
       */
      if (slot.sharedFrom != null) {
        throw new ORPCError('BAD_REQUEST', {
          message:
            'Ce créneau est une pause héritée d\'une autre salle : la décision se prend ' +
            'sur le créneau d\'origine, et la projection suit.',
        })
      }

      context.services.rooms.setOverride(input.sessionId, input.action)
      // Read back after the write: it is the fingerprint of the program as it is
      // now served, and it is what we announce to the rooms.
      const contentHash = context.services.programs.active()?.contentHash ?? snapshot.contentHash
      context.services.commands.publish(
        null,
        { type: 'program.invalidate', contentHash },
        null,
      )
      return { ok: true, contentHash }
    }),

    /**
     * Corrects a slot's OpenFeedback identifier.
     *
     * Returns the address that follows from it: it is the only way to check the
     * correction, and opening it with one click beats recomposing it from memory.
     *
     * The rooms are told as for a kind decision — they draw their QR codes offline, and
     * a QR code left on the old identifier is precisely the accident this procedure
     * exists to prevent.
     */
    feedbackId: os.sessions.feedbackId.use(operatorOnly).handler(({ input, context }) => {
      const snapshot = context.services.programs.active()
      if (snapshot == null) {
        throw new ORPCError('NOT_FOUND', { message: 'Aucun programme actif sur ce hub' })
      }
      const slot = snapshot.program.sessions.find((session) => session.id === input.sessionId)
      if (slot == null) {
        throw new ORPCError('NOT_FOUND', {
          message: `Créneau inconnu du programme actif : ${input.sessionId}`,
        })
      }
      // A break has no feedback page, and an inherited break has no existence of
      // its own: correcting its identifier would have no visible effect, and would
      // leave a row nothing would ever read back.
      if (slot.kind === 'break') {
        throw new ORPCError('BAD_REQUEST', {
          message: 'Une pause n\'a pas de page OpenFeedback : rien à corriger ici.',
        })
      }

      context.services.rooms.setFeedbackId(input.sessionId, input.feedbackId)

      // Read back after the write: the served program now carries the correction,
      // and it is from it that the address is derived — recomposing it here would
      // make a second place where the rule lives, so a place where it can diverge.
      const after = context.services.programs.active()
      const corrected = after?.program.sessions.find((session) => session.id === input.sessionId)
      const contentHash = after?.contentHash ?? snapshot.contentHash
      context.services.commands.publish(null, { type: 'program.invalidate', contentHash }, null)

      return {
        ok: true,
        feedbackId: corrected?.feedbackId ?? slot.id,
        feedbackUrl:
          corrected == null
            ? null
            : openFeedbackUrl(
                corrected,
                filled(context.services.settings.get().openFeedbackProjectId),
                snapshot.program.timezone,
              ),
      }
    }),

    reset: os.sessions.reset.use(roomOrOperator).handler(({ input, context }) => {
      const { session, roomId } = resolveSession(context, input.sessionId)
      requireSameRoom(context, roomId)
      context.services.sessions.reset(session.id)
      // The room must go back to "upcoming": without this broadcast, its screen
      // would stay on the cancelled state until the next restart.
      broadcastState(context, {
        sessionId: session.id,
        roomId,
        status: 'scheduled',
        decidedBy: authorOf(context),
      })
      return { ok: true }
    }),
  },

  messages: {
    send: os.messages.send.use(operatorOnly).handler(({ input, context }) => {
      if (input.roomId != null && context.services.rooms.get(input.roomId) == null) {
        throw new ORPCError('NOT_FOUND', { message: `Salle inconnue : ${input.roomId}` })
      }
      context.services.commands.publish(
        input.roomId,
        {
          type: 'message.broadcast',
          text: input.text,
          level: input.level,
          target: input.target,
          from: context.operator.email,
        },
        input.ttlSeconds,
      )
      return { ok: true }
    }),

    fromRooms: os.messages.fromRooms.use(operatorOnly).handler(({ input, context }) => {
      const rooms = new Map(context.services.rooms.list().map((room) => [room.id, room.name] as const))
      return context.services.ingest.messagesFromRooms(input.limit).map((message) => ({
        ...message,
        roomName: rooms.get(message.roomId) ?? null,
      }))
    }),
  },

  clock: {
    get: os.clock.get.use(operatorOnly).handler(({ context }) => ({
      serverTime: context.services.clock.nowIso(),
      simulated: context.services.clock.simulated,
      // The mode is authoritative: moving a production hub's clock would skew the
      // recordings' timecodes and the automatic closings.
      controllable: context.services.mode === 'dev',
    })),

    set: os.clock.set.use(operatorOnly).handler(({ input, context }) => {
      if (context.services.mode !== 'dev') {
        throw new ORPCError('FORBIDDEN', {
          message:
            "Réglage de l'heure fermé : ce hub tourne en production. Il s'ouvre " +
            "avec MODE=dev, jamais pendant l'événement — changer l'heure " +
            'fausserait les timecodes des enregistrements.',
        })
      }

      try {
        context.services.clock.setSimulated(input.at)
      } catch (cause) {
        throw new ORPCError('BAD_REQUEST', { message: (cause as Error).message })
      }

      const serverTime = context.services.clock.nowIso()
      /**
       * Realign the rooms right away.
       *
       * They align their offset on `serverTime` at every synchronization: without
       * this broadcast, their screen would show a different moment than the
       * console until the next one.
       */
      context.services.commands.publish(
        null,
        { type: 'clock.changed', serverTime, simulated: context.services.clock.simulated },
        null,
      )
      return { serverTime, simulated: context.services.clock.simulated }
    }),
  },
  event: {
    identity: os.event.identity.use(operatorOnly).handler(({ context }) => ({
      resolved: context.services.identity.get(),
      derived: context.services.identity.derived(),
    })),
  },

  settings: {
    get: os.settings.get.use(operatorOnly).handler(({ context }) => context.services.settings.get()),
    update: os.settings.update
      .use(operatorOnly)
      .handler(({ input, context }) => context.services.settings.update(input)),
  },

  ingest: {
    push: os.ingest.push.use(roomOnly).handler(({ input, context }) => {
      const outcome = context.services.ingest.push(context.roomId, input.batch)
      return { ...outcome, serverTime: nowIso(context) }
    }),
  },

  devices: {
    pending: os.devices.pending
      .use(operatorOnly)
      .handler(({ context }) => context.services.devices.pending()),

    /**
     * Approval and assignment in a single operation.
     *
     * The order matters: we approve with Better Auth first, and only bind the machine
     * to its room if the approval succeeded. The other way round would leave an orphan
     * binding after an expired code.
     */
    approve: os.devices.approve.use(operatorOnly).handler(async ({ input, context }) => {
      if (context.services.rooms.get(input.roomId) == null) {
        throw new ORPCError('NOT_FOUND', { message: `Salle inconnue : ${input.roomId}` })
      }

      await context.auth.api.deviceVerify({
        query: { user_code: input.userCode },
        headers: context.headers,
      })
      try {
        await context.auth.api.deviceApprove({
          body: { userCode: input.userCode },
          headers: context.headers,
        })
      } catch (cause) {
        /**
         * A code belongs to the first operator who looked at it.
         *
         * Better Auth attaches it as soon as it is verified — which the console does when
         * opening the machine's link. A second operator approving from their own machine is
         * refused, and the plugin's English message helps nobody understand why.
         */
        if ((cause as { body?: { error?: string } }).body?.error === 'access_denied') {
          throw new ORPCError('FORBIDDEN', {
            message:
              "Ce code a été ouvert par un autre opérateur : c'est à lui d'approuver, " +
              "ou faites relancer l'appairage depuis la régie pour obtenir un nouveau code",
          })
        }
        throw cause
      }

      context.services.devices.bind({
        clientId: input.clientId,
        roomId: input.roomId,
        label: input.label,
        approvedByUserId: context.operator.id,
      })
      return { ok: true }
    }),

    deny: os.devices.deny.use(operatorOnly).handler(async ({ input, context }) => {
      const verification = await context.auth.api.deviceVerify({
        query: { user_code: input.userCode },
        headers: context.headers,
      })
      await context.auth.api.deviceDeny({
        body: { userCode: input.userCode },
        headers: context.headers,
      })
      /**
       * The request goes with the refusal.
       *
       * Without this, the refused machine stayed in the queue until somebody paired it:
       * refusing had no visible effect, and we refused twice.
       */
      if (verification.client_id != null) context.services.devices.forget(verification.client_id)
      return { ok: true }
    }),

    /**
     * Careful: looking at a code **attaches** it to the operator looking.
     *
     * That is the gesture Better Auth expects of a verification page, and the one
     * approval already makes. The consequence is that a second operator will no longer
     * be able to approve that code — `approve` says so in plain words rather than let
     * the plugin's English refusal through.
     */
    lookup: os.devices.lookup.use(operatorOnly).handler(async ({ input, context }) => {
      let verification: Awaited<ReturnType<typeof context.auth.api.deviceVerify>>
      try {
        verification = await context.auth.api.deviceVerify({
          query: { user_code: input.userCode },
          headers: context.headers,
        })
      } catch (cause) {
        const reason = codeRefusalReason(cause)
        // A genuine failure must stay a failure: only the two refusals the
        // console knows how to explain become an answer.
        if (reason == null) throw cause
        return { status: null, reason, clientId: null, requestedRoomId: null, requestedRoomName: null }
      }

      const scope = verification.scope ?? ''
      const requested = scope.startsWith('room:') ? scope.slice('room:'.length) : null
      const room = requested == null ? null : context.services.rooms.get(requested)
      return {
        status: verification.status as 'pending' | 'approved' | 'denied',
        reason: null,
        clientId: verification.client_id ?? null,
        requestedRoomId: requested,
        // Distinct from `requestedRoomId`: a requested room that does not exist
        // on this hub is visible, instead of disappearing silently.
        requestedRoomName: room?.name ?? null,
      }
    }),

    list: os.devices.list.use(operatorOnly).handler(({ context }) =>
      context.services.devices.list().map((device) => ({
        clientId: device.clientId,
        roomId: device.roomId,
        label: device.label,
        approvedAt: device.approvedAt,
        lastSeenAt: device.lastSeenAt,
        revokedAt: device.revokedAt,
      })),
    ),

    /**
     * Exchanges the approval session for a room token.
     *
     * The only legitimate use of a Better Auth session by a machine. After which it
     * throws the session away: its later calls carry room rights only.
     */
    claim: os.devices.claim.handler(async ({ context }) => {
      const { clientId } = await resolveClaim(context)
      const token = context.services.devices.issueToken(clientId)
      const roomId = context.services.devices.roomFor(clientId)
      if (token == null || roomId == null) {
        throw new ORPCError('FORBIDDEN', {
          message: 'Machine non appairée à une salle, ou appairage révoqué',
        })
      }
      return { token, roomId }
    }),

    revoke: os.devices.revoke.use(operatorOnly).handler(({ input, context }) => {
      context.services.devices.revoke(input.clientId)
      return { ok: true }
    }),
  },

  /**
   * Social wall. `post` and `feed` are **public**: they serve the audience's phones,
   * which have neither an account nor a pairing. They are therefore the only
   * procedures in the contract that must be rate-limited.
   */
  wall: {
    post: os.wall.post.handler(({ input, context }) => {
      if (!context.services.limiter.take(publicIdentity(context))) {
        throw new ORPCError('TOO_MANY_REQUESTS', {
          message: 'Trop de messages coup sur coup. Patientez quelques instants.',
        })
      }
      const posted = context.services.wall.post({
        source: 'form',
        author: input.author,
        text: input.text,
        roomId: input.roomId,
      })
      return { id: posted.id, status: 'pending' as const }
    }),

    /**
     * Public, like posting: these messages are already projected in the room.
     *
     * Read from the service's in-memory snapshot, never in SQL — it is the only
     * unbounded load of the day.
     */
    recent: os.wall.recent.handler(({ input, context }) =>
      context.services.wall.approved(null).slice(-input.limit).reverse(),
    ),

    feed: os.wall.feed.handler(async function* ({ input, context, lastEventId, signal }) {
      for await (const entry of context.services.wall.stream(
        input.roomId,
        parseSeq(lastEventId),
        signal,
      )) {
        yield withEventMeta(entry.comment, { id: String(entry.seq) })
      }
    }),

    pending: os.wall.pending
      .use(operatorOnly)
      .handler(({ input, context }) => context.services.wall.pending(input.source)),

    moderate: os.wall.moderate.use(operatorOnly).handler(({ input, context }) => {
      const moderated = context.services.wall.moderate(
        input.id,
        input.decision,
        context.operator.email,
      )
      if (moderated == null) throw new ORPCError('NOT_FOUND', { message: 'Message introuvable' })

      // Tell the rooms: the screen must be able to react without waiting a tick.
      if (input.decision === 'approve') {
        context.services.commands.publish(
          moderated.roomId,
          { type: 'wall.approved', commentId: moderated.id },
          3_600,
        )
      }
      return { ok: true }
    }),
  },

  push: {
    /**
     * Open to any operator: the public key is not a secret.
     */
    publicKey: os.push.publicKey
      .use(operatorOnly)
      .handler(({ context }) => ({ publicKey: context.services.push.publicKey() })),

    subscribe: os.push.subscribe.use(operatorOnly).handler(({ input, context }) => {
      context.services.push.subscribe({
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userId: context.operator.id,
        label: input.label,
        levels: input.levels,
      })
      return { ok: true }
    }),

    unsubscribe: os.push.unsubscribe.use(operatorOnly).handler(({ input, context }) => {
      context.services.push.unsubscribe(input.endpoint)
      return { ok: true }
    }),
  },

  /**
   * Shipping the rushes back to the hub's storage.
   *
   * The five room procedures are bounded by `roomOnly`: the `roomId` comes from the
   * token, never from the input. So a room can neither upload for another, nor read
   * another's plan — and revoking a machine cuts it off from the storage without
   * touching the bucket.
   */
  vod: {
    begin: os.vod.begin.use(roomOnly).handler(({ input, context }) =>
      onStorage(context, () => requireStorage(context).begin({ roomId: context.roomId, ...input })),
    ),

    parts: os.vod.parts.use(roomOnly).handler(({ input, context }) =>
      onStorage(context, () => requireStorage(context).parts(context.roomId, input.uploadId, input.numeros)),
    ),

    progress: os.vod.progress.use(roomOnly).handler(({ input, context }) =>
      onStorage(context, () => {
        requireStorage(context).progress({ roomId: context.roomId, ...input })
        return { ok: true }
      }),
    ),

    complete: os.vod.complete.use(roomOnly).handler(({ input, context }) =>
      onStorage(context, async () => ({
        ok: true,
        objectKey: await requireStorage(context).complete(context.roomId, input.uploadId),
      })),
    ),

    abort: os.vod.abort.use(roomOnly).handler(({ input, context }) =>
      onStorage(context, async () => {
        await requireStorage(context).abort(context.roomId, input.uploadId, input.raison)
        return { ok: true }
      }),
    ),

    /**
     * A room only sees its own uploads.
     *
     * The control app uses it to paint its dialog; the console, on the other hand,
     * passes no `roomId` and sees them all. Letting a room query another would serve no
     * purpose and would give a room token a view of the whole event.
     */
    uploads: os.vod.uploads.use(roomOrOperator).handler(({ input, context }) => {
      const vod = requireStorage(context)
      const rooms = new Map(context.services.rooms.list().map((room) => [room.id, room.name]))
      const target = context.operator != null ? input.roomId : context.roomId
      return vod.uploads(target, (id) => rooms.get(id) ?? null)
    }),

    /**
     * A talk's VOD folder. Admin.
     *
     * **Without `requireStorage`, and deliberately so.** The two halves of the answer
     * do not come from the same place: the takes are reconstructed from the ingestion
     * log, which every hub keeps, and only the uploads require S3. Refusing the whole
     * procedure for want of storage would deprive a hub with no S3 of the one answer
     * that matters on the evening of the strike — "is the rush on the machine?".
     */
    conference: os.vod.conference.use(operatorOnly).handler(({ input, context }) => {
      const { session, roomId } = resolveSession(context, input.sessionId)
      const rooms = new Map(context.services.rooms.list().map((room) => [room.id, room.name]))
      const vod = context.services.vod

      /**
       * The slot as lived, not the slot as planned.
       *
       * It is what bounds attachment by time: a talk announced at 14:00 and started at
       * 14:20 was recorded at 14:20. Comparing with the program's schedule would attach
       * the previous slot's take.
       */
      const state = context.services.sessions.states(roomId)
        .find((candidate) => candidate.sessionId === input.sessionId)

      const captations =
        roomId == null
          ? []
          : context.services.ingest
              .captations(roomId)
              .map((capture) => attachCapture(capture, input.sessionId, state))
              .filter((capture) => capture != null)

      return {
        sessionId: session.id,
        roomId,
        roomName: roomId == null ? null : (rooms.get(roomId) ?? null),
        stockageConfigure: vod != null && vod.ready(),
        captations,
        televersements:
          vod == null ? [] : vod.forSession(input.sessionId, (id) => rooms.get(id) ?? null),
      }
    }),

    /**
     * Tests the connection to the storage. Admin.
     *
     * **No `onStorage` here, and that is the point**: the diagnosis is the answer.
     * Translating the failure into a 502 would lose the step we stopped at — reach,
     * authenticate, sign, clean up —, which is exactly what this button exists to say.
     */
    check: os.vod.check.use(operatorOnly).handler(({ context }) => {
      const vod = context.services.vod
      if (vod == null) {
        return {
          ok: false,
          etapes: [
            {
              nom: 'joindre' as const,
              ok: false,
              detail:
                'Aucun stockage S3 configuré sur ce hub : renseigner S3_ENDPOINT, S3_ACCESS_KEY_ID et S3_SECRET_ACCESS_KEY.',
            },
          ],
        }
      }
      return vod.check()
    }),

    /**
     * Reset. **Development only, and refused here, not merely hidden.**
     *
     * The same guard as setting the clock, and for an even stronger reason: a console
     * that does not render the button only protects against carelessness, not against a
     * direct call. This one destroys a day of capture.
     *
     * The confirmation is in the contract (`z.literal('RAZ')`): it is therefore checked
     * by the hub, and not only by the dialog.
     */
    reset: os.vod.reset.use(operatorOnly).handler(({ context }) => {
      if (context.services.mode !== 'dev') {
        throw new ORPCError('FORBIDDEN', {
          message:
            "La remise à zéro n'existe qu'en mode développement. Un hub d'événement ne détruit pas ses captations.",
        })
      }
      return onStorage(context, async () => {
        const erased = await requireStorage(context).reset()
        // The hub also forgets what it knew about the takes: without that, a
        // talk's VOD folder keeps listing captures whose files have just been
        // erased, and the reset looks like it had no effect.
        const takes = context.services.ingest.forgetCaptures()
        const rooms = context.services.rooms.list()
        for (const room of rooms) {
          context.services.commands.publish(
            room.id,
            { type: 'vod.reset', requestedBy: context.operator.email },
            null,
          )
        }
        // `salles` and `prises` are contract fields: they do not get renamed.
        return { ...erased, salles: rooms.length, prises: takes }
      })
    }),

    /**
     * The storage's state, including when there is none.
     *
     * The only procedure of the group that answers with no storage configured: that is
     * precisely its reason to exist. The console must be able to say "not configured",
     * and name the missing variables — they cannot be guessed from a browser.
     */
    status: os.vod.status.use(operatorOnly).handler(({ context }) => {
      const vod = context.services.vod
      if (vod == null) {
        return {
          configure: false,
          endpoint: null,
          bucket: null,
          prefix: null,
          politique: DEFAULT_VOD_POLICY,
        }
      }
      return vod.status()
    }),

    /**
     * Asks a room to upload.
     *
     * A command, not a direct call — like `rooms.resync`, and for the same reason: the
     * console does not talk to the rooms, and a momentarily disconnected room catches
     * the request up on reconnection. With no TTL: "ship your rushes back" does not
     * expire.
     */
    request: os.vod.request.use(operatorOnly).handler(({ input, context }) => {
      requireStorage(context)
      if (context.services.rooms.get(input.roomId) == null) {
        throw new ORPCError('NOT_FOUND', { message: `Salle inconnue : ${input.roomId}` })
      }
      context.services.commands.publish(
        input.roomId,
        { type: 'vod.upload', file: input.file, requestedBy: context.operator.email },
        null,
      )
      return { ok: true }
    }),
  },

  /**
   * Mobile control.
   *
   * A single locked surface, and that is what makes the lock bearable:
   * `sessions.start` stays open to the console, `rooms.resync` too, and the room
   * machine does not go through the hub to drive its OBS. The lock only excludes
   * mobile control apps from each other.
   */
  regie: {
    locks: os.regie.locks
      .use(operatorOnly)
      .handler(({ context }) => controlRooms(context.services, context.services.clock.now())),

    hold: os.regie.hold.use(operatorOnly).handler(({ input, context }) => {
      const before = context.services.regie.lock(input.roomId)
      const lock = onLock(() =>
        context.services.regie.hold(
          input.roomId,
          context.operator.email,
          controlSessionId(context),
          input.force,
        ),
      )
      /*
       * Broadcast only on a **change** of holder, and on the **displayed holder**
       * rather than on the session.
       *
       * Renewal comes through here when the page takes the hand back after an
       * outage, and it changes nothing of what the room shows. Publishing every
       * time would fill the command table with identical information — and would
       * make the badge blink in the room. Taking a room over from one tab to
       * another of the same operator changes nothing either.
       */
      if (before?.holder !== lock.holder) broadcastLock(context, input.roomId, lock.holder)
      return lock
    }),

    release: os.regie.release.use(operatorOnly).handler(({ input, context }) => {
      const released = context.services.regie.release(input.roomId, controlSessionId(context))
      if (released) broadcastLock(context, input.roomId, null)
      return { ok: released }
    }),

    /**
     * The room's state, and the lock's heartbeat in the same call.
     *
     * The heartbeat first: a view returned to a holder whose lock has just expired
     * between two polls would leave them dispossessed without having done anything.
     * Renewing before reading closes that window.
     *
     * A caller that does not hold the room merely reads — which is what allows looking
     * at a room held by somebody else without taking it from them.
     */
    view: os.regie.view.use(operatorOnly).handler(({ input, context }) => {
      const lock = context.services.regie.lock(input.roomId)
      /*
       * Only the holder renews, and "the holder" is a session.
       *
       * A second tab of the same operator merely reads: the opposite would keep
       * alive indefinitely a lock the page that took it has stopped holding.
       */
      if (lock != null && lock.holderId === context.headers.get(CONTROL_SESSION_HEADER)) {
        context.services.regie.hold(input.roomId, lock.holder, lock.holderId, false)
      }
      return onRoom(() =>
        controlView(context.services, input.roomId, context.services.clock.now()),
      )
    }),

    command: os.regie.command.use(operatorOnly).handler(({ input, context }) => {
      requireLock(context, input.roomId)

      const result = onTransition(() =>
        onRoom(() =>
          controlCommand(context.services, input.roomId, input.action, context.operator.email),
        ),
      )

      /*
       * A lifecycle decision is broadcast like a room control app's, through the
       * same path: the other rooms must learn about it, and the console must see
       * it without waiting for its polling turn. Doing it otherwise would have
       * given two ways of announcing the same fact.
       */
      const action = input.action
      if ('sessionId' in action) {
        const state = context.services.sessions.get(action.sessionId)
        broadcastState(context, {
          sessionId: action.sessionId,
          roomId: input.roomId,
          // `reset` deletes the row: absence *is* "upcoming", here as in the
          // table. Without this fallback, the cancellation would not be announced.
          status: state?.status ?? 'scheduled',
          decidedBy: context.operator.email,
        })
      }

      return { ok: true, ...result }
    }),
  },

  questions: {
    post: os.questions.post.handler(({ input, context }) => {
      if (!context.services.limiter.take(publicIdentity(context))) {
        throw new ORPCError('TOO_MANY_REQUESTS', {
          message: 'Trop de questions coup sur coup. Patientez quelques instants.',
        })
      }
      return context.services.questions.post(input)
    }),

    vote: os.questions.vote.handler(({ input, context }) => {
      // The bucket is keyed on the device: voting is the easiest gesture to
      // automate, and it is the one that would skew the ranking.
      if (!context.services.limiter.take(publicIdentity(context, input.deviceId))) {
        throw new ORPCError('TOO_MANY_REQUESTS', { message: 'Trop de votes coup sur coup.' })
      }
      return { votes: context.services.questions.vote(input.id, input.deviceId) }
    }),

    list: os.questions.list.handler(({ input, context }) =>
      context.services.questions.list(input.roomId, input.sessionId),
    ),
  },
})

/**
 * Translates what the storage refuses into something readable in the console.
 *
 * Two families, and they must be told apart: `IncompleteStorage` says a setting is
 * missing **here** — a bucket, an upload we forgot to open —, `S3Error` reports what
 * the storage answered, code included. Confusing them into "internal error" would
 * send people looking for the failure in the hub when it is in the bucket's
 * permissions, and the other way round.
 *
 * The storage's code is passed through as is: `SignatureDoesNotMatch`,
 * `NoSuchBucket`, `AccessDenied` are the only words you can put into a search
 * engine, and translating them would lose them.
 */
async function onStorage<T>(
  context: { services: HubContext['services'] },
  gesture: () => T | Promise<T>,
): Promise<T> {
  try {
    return await gesture()
  } catch (error) {
    /**
     * What has already been translated passes through intact.
     *
     * `requireStorage` throws a `NOT_IMPLEMENTED` when no storage is configured:
     * repackaging it as "storage unreachable" would send people looking for a network
     * failure where there is simply nothing mounted — the exact opposite of the service
     * this block is meant to render.
     */
    if (error instanceof ORPCError) throw error
    if (error instanceof IncompleteStorage) {
      throw new ORPCError('BAD_REQUEST', { message: error.message })
    }
    if (error instanceof S3Error) {
      throw new ORPCError('BAD_GATEWAY', {
        message: `Le stockage a refusé (${error.code}) : ${error.message}`,
      })
    }
    /**
     * Everything else, rather than an internal error.
     *
     * The case that motivated this block: unreachable storage. `fetch` then throws a
     * `TypeError: fetch failed` whose real cause — `ECONNREFUSED`, `ENOTFOUND`, a
     * certificate — is filed under `cause`, and oRPC turned it into an "Internal Server
     * Error" the control app showed as is. We looked for the failure in the hub when a
     * container was missing.
     *
     * Nothing here is ever the hub's fault: these procedures only call a third-party
     * storage. `BAD_GATEWAY` says so, and the message names **the address we tried to
     * reach** — without it, we do not even know whether it is the one we think.
     */
    throw new ORPCError('BAD_GATEWAY', {
      message: `Stockage injoignable (${context.services.vod?.endpoint() ?? 'adresse inconnue'}) : ${readableCause(error)}`,
    })
  }
}

/**
 * The real reason for a network failure, under `fetch`'s layer.
 *
 * `fetch failed` says nothing: it is the message undici puts on *all* its transport
 * failures. The errno code, on the other hand, tells a switched-off service
 * (`ECONNREFUSED`) from a name that does not resolve (`ENOTFOUND`) and from a
 * firewall that leaves it hanging (`ETIMEDOUT`) — three failures that are not fixed
 * in the same place.
 */
function readableCause(error: unknown): string {
  const chain: string[] = []
  let current: unknown = error
  for (let depth = 0; current != null && depth < 4; depth += 1) {
    const node = current as { message?: string; code?: string; cause?: unknown }
    const code = typeof node.code === 'string' ? node.code : null
    if (code != null) chain.push(code)
    else if (typeof node.message === 'string' && node.message !== '') chain.push(node.message)
    current = node.cause
  }
  return chain.length === 0 ? String(error) : chain.join(' — ')
}

/**
 * The upload service, or a refusal that says what to do.
 *
 * A hub with no storage configured is not broken: it is the default case, and
 * saying it this way stops people looking for a permission error on a bucket that
 * does not exist. `NOT_IMPLEMENTED` rather than a server error, because nothing
 * failed — the feature is simply not mounted.
 */
function requireStorage(context: { services: HubContext['services'] }): VodService {
  const vod = context.services.vod
  if (vod == null) {
    throw new ORPCError('NOT_IMPLEMENTED', {
      message:
        "Aucun stockage S3 configuré sur ce hub : renseigner S3_ENDPOINT, S3_ACCESS_KEY_ID et S3_SECRET_ACCESS_KEY.",
    })
  }
  return vod
}

/**
 * Does this take belong to this talk, and on what grounds.
 *
 * Two possible answers, and they are not equivalent. The control app normally
 * stamps every take with the running slot: that is `session`, it is not open to
 * debate, and nothing else is needed.
 *
 * That leaves the case that costs dearly on a strike evening: a recording launched
 * by hand, before the control app's "Start" or without it, carries no slot. The
 * rush exists nonetheless, it is even the only one that exists, and finding it means
 * opening the files one by one. So we attach it by time — the take covers the slot
 * **as lived**, in the same room — saying the attachment is derived: it is a lead,
 * not a fact, and the console shows it as such.
 *
 * The planned slot is never used as a basis: a talk announced at 14:00 and started
 * at 14:20 would make us attach the previous slot's take.
 */
function attachCapture(
  capture: RawCapture,
  sessionId: string,
  lived: { startedAt: string | null; endedAt: string | null } | undefined,
): CaptureView | null {
  if (capture.sessionId === sessionId) {
    return { ...capture, rattachement: 'session' }
  }
  // Stamped with another slot: it belongs to that one, not to this one.
  if (capture.sessionId != null) return null
  if (lived?.startedAt == null) return null

  const talkStart = Date.parse(lived.startedAt)
  // Talk still running: it runs until now, so any take opened since its start
  // covers it.
  const talkEnd = lived.endedAt == null ? Number.POSITIVE_INFINITY : Date.parse(lived.endedAt)
  const takeStart = Date.parse(capture.startedAt)
  const takeEnd =
    capture.endedAt == null ? Number.POSITIVE_INFINITY : Date.parse(capture.endedAt)

  const overlap = takeStart < talkEnd && talkStart < takeEnd
  return overlap ? { ...capture, rattachement: 'horaire' } : null
}

/**
 * A blank string is not a value.
 *
 * A text field left empty in a form arrives here as `''`, not as `null`, and `??`
 * lets it through: that is how an OpenFeedback project "set to nothing" silently
 * overwrote the fallback and produced `https://openfeedback.io///…` addresses.
 */
function filled(value: string | null | undefined): string | null {
  const clean = value?.trim() ?? ''
  return clean === '' ? null : clean
}

/**
 * Finds a session in the active program.
 *
 * Refusing an unknown session rather than writing an orphan state: a decision about
 * an identifier that is no longer in the program would be invisible everywhere, and
 * would give the illusion of having acted.
 */
function resolveSession(
  context: { services: HubContext['services'] },
  sessionId: string,
): { session: { id: string }; roomId: string | null } {
  const snapshot = context.services.programs.active()
  const session = snapshot?.program.sessions.find((candidate) => candidate.id === sessionId)
  if (session == null) {
    throw new ORPCError('NOT_FOUND', { message: `Session inconnue au programme : ${sessionId}` })
  }
  return { session, roomId: session.roomId }
}

/**
 * Forbids a room from deciding for another.
 *
 * The console is not concerned: deciding remotely when a room operator is
 * unavailable is precisely its role.
 */
/**
 * Translates a lifecycle refusal into an answer the control app can show.
 *
 * `CONFLICT` and not `BAD_REQUEST`: the request was well formed, it is the talk's
 * state that moved — most often because another control app, or the automatic
 * closing, went past in the meantime. The message comes from the shared table, so it
 * says the same thing as the greyed-out button opposite.
 */
function onTransition<T>(gesture: () => T): T {
  try {
    return gesture()
  } catch (error) {
    if (error instanceof TransitionRefused) {
      throw new ORPCError('CONFLICT', { message: error.message })
    }
    throw error
  }
}

/**
 * Translates an unknown room into `NOT_FOUND`.
 *
 * A `/regie/<id>` address gets bookmarked and shared: an identifier that no longer
 * designates anything — room renamed, program reimported — must say so, not return
 * an empty view that would read as a switched-off room.
 */
function onRoom<T>(gesture: () => T): T {
  try {
    return gesture()
  } catch (error) {
    if (error instanceof UnknownRoom) {
      throw new ORPCError('NOT_FOUND', { message: error.message })
    }
    throw error
  }
}

/**
 * Translates an already held room into `CONFLICT`, naming the holder.
 */
function onLock<T>(gesture: () => T): T {
  try {
    return gesture()
  } catch (error) {
    if (error instanceof LockHeld) {
      throw new ORPCError('CONFLICT', { message: error.message })
    }
    throw error
  }
}

/**
 * Refuses a gesture to whoever does not hold the room.
 *
 * The message names the holder: "refused" without saying by whom sends people
 * looking for a defect where there is only a colleague at the other end of the
 * building. And it tells a missing lock from somebody else's — the first is fixed
 * with one click on "Take the room", the second calls for a decision.
 */
function requireLock(context: HubContext, roomId: string): void {
  const lock = context.services.regie.lock(roomId)
  if (lock == null) {
    throw new ORPCError('FORBIDDEN', {
      message: "Prenez la salle avant de la piloter : personne ne la tient",
    })
  }
  if (lock.holderId !== context.headers.get(CONTROL_SESSION_HEADER)) {
    throw new ORPCError('FORBIDDEN', {
      message: `${lock.holder} tient la régie de cette salle`,
    })
  }
}

/**
 * The tab that is speaking, or a refusal.
 *
 * Required rather than derived from the account: falling back on the address when
 * the header is missing would silently degrade exclusivity, and that is the kind of
 * fallback you only discover the day two tabs drive the same room.
 */
function controlSessionId(context: HubContext): string {
  const session = context.headers.get(CONTROL_SESSION_HEADER)
  if (session == null || session === '') {
    throw new ORPCError('BAD_REQUEST', {
      message: `En-tête ${CONTROL_SESSION_HEADER} absent : la régie ne s'identifie pas`,
    })
  }
  return session
}

/**
 * Tells the room who is driving it remotely, or that nobody is.
 *
 * Durable (null `ttl`) like `session.state`: it is a state change, not a message of
 * the moment. A momentarily disconnected room must find it again on reconnection —
 * otherwise its control screen shows a holder who left an hour ago, or shows none
 * while it is being driven.
 */
function broadcastLock(
  context: { services: HubContext['services'] },
  roomId: string,
  holder: string | null,
): void {
  context.services.commands.publish(roomId, { type: 'regie.hold', holder }, null)
}

function requireSameRoom(context: ActorContext, roomId: string | null): void {
  if (context.roomId != null && roomId !== context.roomId) {
    throw new ORPCError('FORBIDDEN', {
      message: "Cette conférence ne se tient pas dans votre salle",
    })
  }
}

/**
 * Tells the room concerned without waiting for its next sync.
 */
/**
 * Tells **every** room, not only the one concerned.
 *
 * A control app must be able to report "Track #2 has just finished" without asking
 * the hub: that is what lets an operator anticipate a switch or a handover. Each
 * room then filters on `roomId`.
 */
function broadcastState(
  context: { services: HubContext['services'] },
  state: { sessionId: string; roomId: string | null; status: 'scheduled' | 'running' | 'ended'; decidedBy: string },
): void {
  const snapshot = context.services.programs.active()
  const session = snapshot?.program.sessions.find((s) => s.id === state.sessionId)

  context.services.commands.publish(
    null,
    {
      type: 'session.state',
      sessionId: state.sessionId,
      roomId: state.roomId,
      sessionTitle: session?.title ?? null,
      status: state.status,
      decidedBy: state.decidedBy,
    },
    null,
  )
}

/**
 * Translates a Better Auth refusal into a displayable reason.
 *
 * The device plugin returns `invalid_request` for a code it does not know and
 * `expired_token` for an expired one, in the error's body. The two do not call for
 * the same gesture — retyping the code, or asking for a new one from the control app
 * —, and nothing else lets them be told apart.
 *
 * @returns `null` for any other error: it must travel up as it is.
 */
function codeRefusalReason(cause: unknown): 'inconnu' | 'expire' | null {
  const error = (cause as { body?: { error?: string } }).body?.error
  if (error === 'expired_token') return 'expire'
  if (error === 'invalid_request') return 'inconnu'
  return null
}

/**
 * `lastEventId` is an opaque string on the oRPC side: we bring it back to a safe `seq`.
 */
function parseSeq(lastEventId: string | undefined): number {
  if (lastEventId == null) return 0
  const seq = Number.parseInt(lastEventId, 10)
  return Number.isFinite(seq) && seq > 0 ? seq : 0
}

function isExpiredNow(command: Command): boolean {
  return isCommandExpired(command, Date.now())
}

export type Router = typeof router
