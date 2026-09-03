import { eventIterator, oc } from '@orpc/contract'
import { z } from 'zod'
import { programSchema } from '@cloudnord/program'
import { bannerSchema, commandSchema } from './commands.js'
import { envelopeSchema, ingestResultSchema } from './events.js'
import {
  isoDateTimeSchema,
  roomIdSchema,
  sessionIdSchema,
  PROTOCOL_VERSION,
} from './primitives.js'
import { eventIdentitySchema } from './event-identity.js'
import {
  openFeedbackCheckSchema,
  hubSettingsSchema,
  notifLevelsSchema,
  roomConfigPatchSchema,
  roomConfigSchema,
  roomStatusSchema,
  sessionStateSchema,
  sessionStateViewSchema,
  syncResultSchema,
} from './room-state.js'
import {
  controlCommandResultSchema,
  controlCommandSchema,
  controlLockSchema,
  controlRoomSchema,
  controlViewSchema,
} from './control.js'
import { commentSchema, commentSourceSchema, questionSchema } from './wall.js'
import {
  storageCheckSchema,
  vodFolderSchema,
  vodKindSchema,
  signedPartSchema,
  uploadPlanSchema,
  vodPolicySchema,
  uploadViewSchema,
} from './vod.js'

/**
 * The system's single contract, mounted on three transports:
 *  - HTTP/Fastify  → hub-admin, wall-web
 *  - WebSocket     → room-client ↔ hub
 *  - MessagePort   → Electron main ↔ renderers (control, display, overlay)
 *
 * One definition, no duplication.
 *
 * Procedure names, route paths and field names are the wire itself: they stay as
 * they are, French ones included (`regie.*`, `program.controleOpenFeedback`,
 * `numeros`, `politique`…). Renaming them would break a room already in the
 * field, and this repository does not change the protocol version lightly.
 */

/** What a public surface needs to know about a talk. */
const sessionPreviewSchema = z.object({
  id: sessionIdSchema,
  title: z.string(),
  speakers: z.array(z.string()),
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema.nullable(),
})

/**
 * One row of the schedule, as the console reads it back.
 *
 * Deliberately wider than `sessionPreviewSchema`: the console shows the **whole**
 * program, breaks included, and not only what is running right now in a room.
 */
const planningSessionSchema = sessionPreviewSchema.extend({
  roomId: roomIdSchema.nullable(),
  /** The room's name, not its identifier: that is what is written on the door. */
  roomName: z.string().nullable(),
  /** `break` = slot with no speaker: welcome, break, lunch. */
  kind: z.enum(['talk', 'break']),
  /**
   * "Rate this talk" link on OpenFeedback.
   *
   * Resolved by the hub and not by the console: the address is derived from the
   * program and from the project configured on the room, two things the console
   * does not have. `null` on a break or with no project configured — a dead link
   * scanned by the audience costs more than an empty cell.
   */
  feedbackUrl: z.url().nullable(),
  /**
   * The identifier **served** in this slot's OpenFeedback address.
   *
   * The export's, unless corrected. Returned separately from `feedbackUrl`
   * because it is the one you read and compare when a speaker says "my feedback
   * is empty": the whole URL drowns the one segment that can be wrong.
   */
  feedbackId: z.string(),
  /**
   * The correction made from the console, or `null`.
   *
   * `feedbackId` above is already resolved — same rule as `kind` with
   * `overriddenAs`. This field says where the served identifier comes from: from
   * the export, or from someone who corrected it by hand. That is what the
   * console needs to know in order to offer giving the slot back to the export.
   */
  feedbackIdOverride: z.string().nullable().default(null),
  /**
   * Decision made on this slot from the console, or `null`.
   *
   * The `kind` above is already the one the hub **serves**: an overridden slot
   * arrives corrected, as everywhere else. This field says where that kind comes
   * from — from the export, or from a decision — which only the console needs to
   * know: it is the one that made it, it is where it gets removed, and it derives
   * what the export says from it (the inverse, since a decision with no effect is
   * never applied).
   */
  overriddenAs: z.enum(['talk', 'break']).nullable().default(null),
  /**
   * Slot this row is the projection of in another room, or `null`.
   *
   * A room that is free while another is on a break inherits that break: the row
   * therefore exists in the served program without existing in the export. It is
   * not editable — it is the original you correct, and the projection follows.
   */
  sharedFrom: z.string().nullable().default(null),
  /**
   * When the talk **actually** started and ended, or `null`.
   *
   * The `startsAt` / `endsAt` above are the program's: what was planned. These
   * are what happened — the instant of "Start" and that of "End", automatic
   * closing included. The two are read side by side, and it is the gap that is of
   * interest: a late start, an overrun, a real duration for editing.
   *
   * Joined **by the hub**, not by the console. The lifecycle is written here, it
   * holds for every room at once, and a console cross-referencing two lists
   * itself would end up showing a version that is nobody's. `null` on a slot
   * nobody drove — which is the case for every break, and for talks still to
   * come.
   */
  startedAt: isoDateTimeSchema.nullable().default(null),
  endedAt: isoDateTimeSchema.nullable().default(null),
  /**
   * Who decided, or `null` if nobody decided anything.
   *
   * `auto` for the scheduling rule, the operator's address otherwise. It is the
   * only thing that answers "I did not do that" — a talk marked ended without
   * anyone remembering it ends up in a log, or nowhere.
   */
  decidedBy: z.string().nullable().default(null),
})

export const contract = {
  meta: {
    /** Application liveness ping — also the base for the clock offset. */
    hello: oc
      .input(z.object({ protocolVersion: z.number().int() }))
      .output(
        z.object({
          protocolVersion: z.literal(PROTOCOL_VERSION),
          serverTime: isoDateTimeSchema,
          /** Simulated time: to be flagged, otherwise the gap with reality confuses. */
          simulatedClock: z.boolean().default(false),
          compatible: z.boolean(),
        }),
      ),
  },

  program: {
    /** Imports the upstream export and creates a versioned snapshot. Admin. */
    import: oc
      .input(z.object({ sourceUrl: z.url() }))
      .output(
        z.object({
          contentHash: z.string(),
          importedAt: isoDateTimeSchema,
          program: programSchema,
        }),
      ),
    /** Snapshot history, for a one-click rollback on the day. */
    snapshots: oc.output(
      z.array(
        z.object({
          contentHash: z.string(),
          importedAt: isoDateTimeSchema,
          active: z.boolean(),
          sessionCount: z.number().int(),
          issueCount: z.number().int(),
        }),
      ),
    ),
    activate: oc.input(z.object({ contentHash: z.string() })).output(z.object({ ok: z.boolean() })),
    /**
     * The active program, flattened and ready to display. Admin.
     *
     * The hub already holds the program; without this procedure the console only
     * knows the talks that have **started** and cannot answer "and what comes
     * next". Returned flattened rather than the whole `programSchema`: the
     * biographies, the sponsor logos and the artwork are most of a snapshot's
     * 70 kB, and none of that is shown in a schedule.
     */
    /**
     * The current shared slot: what concerns everyone at once.
     *
     * Separate from per-room supervision, because the question is not the same:
     * the cards say where each room stands, this one says what the event is
     * doing. `null` the rest of the time — the panel then has nothing to say, and
     * an empty panel reads as a failure.
     */
    globalBreak: oc.output(
      z
        .object({
          /** `a-venir`: it starts in less than a quarter of an hour. */
          state: z.enum(['en-cours', 'a-venir']),
          title: z.string(),
          startsAt: isoDateTimeSchema,
          /** Resumption: effective end of the break. `null` if nothing closes it. */
          endsAt: isoDateTimeSchema.nullable(),
          /** Number of rooms concerned — all of them, most of the time. */
          rooms: z.number().int(),
          /** The hub's time, base of the countdown: the browser only has its own. */
          serverTime: isoDateTimeSchema,
        })
        .nullable(),
    ),

    /**
     * Compares the program's OpenFeedback identifiers with its own. Admin.
     *
     * On demand, never in the background: it is a pre-event gesture, run once the
     * program has been imported so as to correct what it reports. It leaves the
     * hub — the only procedure here that calls a third party — and so it can fail
     * for reasons that say nothing about the program.
     */
    controleOpenFeedback: oc.output(openFeedbackCheckSchema),

    planning: oc.output(
      z.object({
        /** Version shown: the same as in the snapshot list. `null` if no program. */
        contentHash: z.string().nullable(),
        /** The event's timezone: times are read over there, not on the console's PC. */
        timezone: z.string(),
        /**
         * The hub's time at read time.
         *
         * It is what designates the slot highlighted as "now". Taken here and not
         * in the browser for the same reason as `remainingMs`: the hub's clock can
         * be simulated, and it is the authority — a highlight computed on the
         * machine's time would point at a slot from last week while a day is
         * played out from the Development menu.
         */
        serverTime: isoDateTimeSchema,
        /**
         * The OpenFeedback project used as a default, once the rule is applied.
         *
         * Returned so the console can explain an empty "Feedback" column instead
         * of leaving it empty. Without it, all you see is a run of dashes, and
         * nothing says whether a setting is missing or OpenFeedback is simply not
         * part of this event.
         */
        openFeedbackProjectId: z.string().nullable(),
        rooms: z.array(z.object({ id: roomIdSchema, name: z.string() })),
        sessions: z.array(planningSessionSchema),
      }),
    ),
  },

  rooms: {
    /**
     * Public list of rooms: identifier and name, nothing else.
     *
     * A machine must be able to offer a choice **before** being paired, so before
     * having any token. These names are already public — the wall attendees scan
     * shows them.
     */
    public: oc.output(z.array(z.object({ id: roomIdSchema, name: z.string() }))),
    list: oc.output(z.array(roomConfigSchema)),
    /** `since` = last known `contentHash`; the snapshot is only returned if it changed. */
    sync: oc
      .input(z.object({ since: z.string().nullable() }))
      .output(syncResultSchema),
    /**
     * A room configuring itself.
     *
     * The hub stays the source of truth — it is the one that pushes the config
     * back at every `sync`, and a change kept locally would be overwritten at the
     * next one. But entering it belongs in the room: the two OBS addresses and
     * the scene names are established in front of the machines, not from a
     * console at the other end of the building.
     *
     * Bounded to the calling room by `roomOnly`: the context carries the
     * `roomId`, it is not in the input, so no room can configure another.
     */
    configure: oc.input(roomConfigPatchSchema).output(roomConfigSchema),
    /**
     * A room's current and next talk. **Public.**
     *
     * The wall uses it to tell attendees what they are listening to: without it,
     * "ask your question" does not say what about, and questions arrive in the
     * control room with no way to attach them to a talk. These titles are already
     * public — they are projected.
     */
    current: oc
      .input(z.object({ roomId: roomIdSchema }))
      .output(
        z.object({
          current: sessionPreviewSchema.nullable(),
          next: sessionPreviewSchema.nullable(),
        }),
      ),
    /** Room supervision in the admin console. */
    statuses: oc.output(z.array(roomStatusSchema)),
    /**
     * Requests a full resynchronization. `roomId` null = every room.
     *
     * Reserved for the operator: it is a console gesture, not something a room
     * asks of itself — the control app already has its own button.
     *
     * `rooms` counts the rooms targeted, so the console can say it rather than
     * announcing a send with no recipient when there is none.
     */
    resync: oc
      .input(z.object({ roomId: roomIdSchema.nullable() }))
      .output(z.object({ ok: z.boolean(), rooms: z.number().int() })),
    /**
     * Downstream flow. Every event is stamped with its `seq` via `withEventMeta`:
     * resumption after an outage goes through `lastEventId`, not through an input
     * parameter.
     */
    commands: oc.output(eventIterator(commandSchema)),
  },

  /**
   * Banner on the live scenes.
   *
   * A surface of its own, and not one more mode on the room screen: the banner
   * overlays the video without interrupting anything, where a screen message
   * replaces everything. The two serve different moments.
   */
  overlay: {
    /** Puts a banner on air. `roomId` null = every room. */
    show: oc
      .input(
        z.object({
          roomId: roomIdSchema.nullable(),
          message: bannerSchema,
          /** Display duration. `null` = until it is removed. */
          ttlSeconds: z.number().int().positive().max(3600).nullable().default(null),
        }),
      )
      .output(z.object({ ok: z.boolean() })),

    /** Removes the banner. */
    hide: oc
      .input(z.object({ roomId: roomIdSchema.nullable() }))
      .output(z.object({ ok: z.boolean() })),

    /**
     * What has already been on air, most recent first.
     *
     * Read from the commands issued: they are already persisted and dated, and
     * keeping a second copy could only diverge. Used to put a banner back without
     * retyping it — a "back in 5 minutes" comes out several times in a day.
     */
    history: oc
      .input(
        z.object({
          roomId: roomIdSchema.nullable().default(null),
          limit: z.number().int().min(1).max(100).default(20),
        }),
      )
      .output(
        z.array(
          z.object({
            seq: z.number().int(),
            roomId: roomIdSchema.nullable(),
            message: bannerSchema,
            issuedAt: isoDateTimeSchema,
            /** Is this banner the one on air right now? */
            visible: z.boolean(),
          }),
        ),
      ),
  },

  /**
   * Talk lifecycle.
   *
   * Driven from the room's control app **and** from the console: a talk can
   * overrun while the room operator is unavailable, and the organizer must be
   * able to decide remotely.
   */
  sessions: {
    /** Known states. Without `roomId`, every room — that is the console's view. */
    states: oc
      .input(z.object({ roomId: roomIdSchema.nullable() }))
      .output(z.array(sessionStateViewSchema)),
    start: oc.input(z.object({ sessionId: sessionIdSchema })).output(sessionStateSchema),
    end: oc.input(z.object({ sessionId: sessionIdSchema })).output(sessionStateSchema),
    /** Cancels a decision: the talk becomes "upcoming" again. */
    reset: oc.input(z.object({ sessionId: sessionIdSchema })).output(z.object({ ok: z.boolean() })),
    /**
     * Overrides a program slot, without a reimport.
     *
     * `action: null` removes the override: the slot becomes what the export says
     * again. Reserved for the operator — it is a decision about the event's
     * program, not about how a room is running.
     *
     * Returns the fingerprint of the program as it is now served: it changes with
     * the override, and that is what makes the program come back down to the
     * rooms instead of leaving them on their cache.
     */
    override: oc
      .input(
        z.object({
          sessionId: sessionIdSchema,
          action: z.enum(['talk', 'break']).nullable(),
        }),
      )
      .output(z.object({ ok: z.boolean(), contentHash: z.string() })),

    /**
     * Corrects a slot's OpenFeedback identifier. Admin.
     *
     * The address is built offline, betting that OpenFeedback reuses the upstream
     * export's identifiers. The bet holds — all twenty-seven match — but it would
     * be lost silently: the link would stay clickable and the QR code scannable,
     * both leading to a page that talks about no talk. We would only notice from
     * the missing feedback, that is, too late.
     *
     * A null `feedbackId` gives the slot back to the export. The correction
     * survives a reimport: it is a property of the hub, and the reimported program
     * would bring back precisely the faulty identifier.
     */
    feedbackId: oc
      .input(
        z.object({
          sessionId: sessionIdSchema,
          /** `null` — or blank — gives the slot back to the export's identifier. */
          feedbackId: z.string().max(200).nullable(),
        }),
      )
      .output(
        z.object({
          ok: z.boolean(),
          /** The identifier served after the gesture, correction or export. */
          feedbackId: z.string(),
          /** The address that follows from it, to check with one click. `null` with no project set. */
          feedbackUrl: z.url().nullable(),
        }),
      ),
  },

  /**
   * Message exchange between the console and the rooms.
   *
   * Two distinct directions: the console broadcasts a command (immediate, with a
   * TTL), a room reports through its outbox (durable, survives an outage).
   */
  messages: {
    /** Sends a message. `roomId` null = every room. */
    send: oc
      .input(
        z.object({
          roomId: roomIdSchema.nullable(),
          text: z.string().min(1).max(500),
          level: z.enum(['info', 'warning', 'urgent']),
          target: z.enum(['operator', 'audience']),
          /** Display duration. `null` = until replaced. */
          ttlSeconds: z.number().int().positive().max(3600).nullable(),
        }),
      )
      .output(z.object({ ok: z.boolean() })),

    /** Messages reported by the rooms, most recent first. */
    fromRooms: oc
      .input(z.object({ limit: z.number().int().min(1).max(200).default(50) }))
      .output(
        z.array(
          z.object({
            id: z.string(),
            roomId: roomIdSchema,
            roomName: z.string().nullable(),
            text: z.string(),
            level: z.enum(['info', 'warning', 'urgent']),
            occurredAt: isoDateTimeSchema,
            receivedAt: isoDateTimeSchema,
          }),
        ),
      ),
  },

  /**
   * The hub's clock.
   *
   * A development tool: moving the time lets you play out an event day in
   * advance. Closed by default on the server side — doing it during the event
   * would skew the recordings' timecodes.
   */
  clock: {
    get: oc.output(
      z.object({
        serverTime: isoDateTimeSchema,
        simulated: z.boolean(),
        /** Does the hub allow setting it from the console? */
        controllable: z.boolean(),
      }),
    ),
    /** A null `at` goes back to real time. */
    set: oc
      .input(z.object({ at: isoDateTimeSchema.nullable() }))
      .output(z.object({ serverTime: isoDateTimeSchema, simulated: z.boolean() })),
  },

  /**
   * The event's identity, as the hub decides it.
   *
   * Read-only: it is written through `settings.update` (or not at all, when it is
   * derived from the imported program). Two values rather than one, because the
   * console must be able to say what you would get by releasing the setting —
   * otherwise nobody dares clear a field.
   */
  event: {
    identity: oc.output(
      z.object({
        /** What is shown everywhere: the setting if there is one, the derivation otherwise. */
        resolved: eventIdentitySchema,
        /** What the imported program alone would give, settings ignored. */
        derived: eventIdentitySchema,
      }),
    ),
  },

  /** Settings that can be changed during the event. */
  settings: {
    get: oc.output(hubSettingsSchema),
    update: oc.input(hubSettingsSchema.partial()).output(hubSettingsSchema),
  },

  ingest: {
    /**
     * Draining the outbox. Idempotent on `(roomId, envelope.id)`: a replay after
     * reconnection returns `duplicates`, never a second insertion.
     */
    push: oc
      .input(z.object({ batch: z.array(envelopeSchema).min(1).max(500) }))
      .output(ingestResultSchema),
  },

  wall: {
    /**
     * Public post from a phone (QR code). Goes through moderation.
     *
     * A null `roomId` — what the public wall sends — means "every room": a message
     * from the audience addresses the event, not the room its author happens to be
     * in. The field stays for the sources that do know which room they are talking
     * about.
     */
    post: oc
      .input(
        z.object({
          roomId: roomIdSchema.nullable(),
          author: z.string().min(1).max(80),
          text: z.string().min(1).max(500),
        }),
      )
      .output(z.object({ id: z.string(), status: z.literal('pending') })),
    /** Flow of approved messages, consumed by the room screens. */
    feed: oc
      .input(z.object({ roomId: roomIdSchema.nullable() }))
      .output(eventIterator(commentSchema)),
    /**
     * Latest messages already on screen. **Public.**
     *
     * Used by the wall on mobile: without it, posting a message meant speaking
     * into the void — nothing showed that others were writing, nor that it really
     * ended up projected. These messages are already public in the strongest
     * sense: they are shown in large type in the rooms.
     *
     * Served from the hub's in-memory snapshot, like the flow: the wall is the
     * only unbounded load of the day — a few hundred phones when the QR code is on
     * screen — and it must not turn into queries.
     */
    recent: oc
      .input(z.object({ limit: z.number().int().min(1).max(30).default(12) }))
      .output(z.array(commentSchema)),
    /** Moderation queue, all sources together. Admin. */
    pending: oc
      .input(z.object({ source: commentSourceSchema.optional() }))
      .output(z.array(commentSchema)),
    moderate: oc
      .input(z.object({ id: z.string(), decision: z.enum(['approve', 'reject']) }))
      .output(z.object({ ok: z.boolean() })),
  },

  /**
   * Pairing of the room machines.
   *
   * The token exchange itself happens on the Better Auth endpoints
   * (`/api/auth/device/*`, RFC 8628): these procedures cover what Better Auth
   * does not know — which room a machine serves.
   */
  devices: {
    /** Machines that requested pairing and have not been dealt with. Admin. */
    pending: oc.output(
      z.array(
        z.object({
          clientId: z.string(),
          scope: z.string().nullable(),
          requestedAt: isoDateTimeSchema,
        }),
      ),
    ),
    /**
     * Approves a machine *and* assigns it to a room, in a single operation. The
     * two must be atomic: a machine approved but not assigned would hold a valid
     * token with no room, which is a useless and confusing state in the control
     * app.
     */
    approve: oc
      .input(
        z.object({
          userCode: z.string().min(4),
          clientId: z.string(),
          roomId: roomIdSchema,
          label: z.string().max(80).optional(),
        }),
      )
      .output(z.object({ ok: z.boolean() })),
    deny: oc.input(z.object({ userCode: z.string().min(4) })).output(z.object({ ok: z.boolean() })),
    /**
     * State of a pairing code, without approving anything.
     *
     * Used by the link the machine displays: landing on the console with a dead
     * code and a queue of requests says nothing about what is wrong. An unknown
     * code and an expired code are not fixed the same way — one is a typo or a
     * recreated database, the other means restarting pairing from the control app
     * —, hence two distinct reasons rather than an error.
     */
    lookup: oc.input(z.object({ userCode: z.string().min(4) })).output(
      z.object({
        /** Better Auth state of the code, or `null` if it is no longer usable. */
        status: z.enum(['pending', 'approved', 'denied']).nullable(),
        /** Set when `status` is `null`: why the code is worthless. */
        reason: z.enum(['inconnu', 'expire']).nullable(),
        clientId: z.string().nullable(),
        /** Room requested by the machine, as it travels in the scope. */
        requestedRoomId: roomIdSchema.nullable(),
        /** `null` if the requested room does not exist (any more) on this hub. */
        requestedRoomName: z.string().nullable(),
      }),
    ),
    /**
     * Exchanges the approval session for a room token.
     *
     * Called by the machine right after pairing, with the session the approval
     * earned it. That token carries a room's rights and nothing more; the Better
     * Auth session is then discarded.
     */
    claim: oc.output(
      z.object({
        token: z.string(),
        roomId: roomIdSchema,
      }),
    ),
    /** Paired machines, for supervision and revocation. */
    list: oc.output(
      z.array(
        z.object({
          clientId: z.string(),
          roomId: roomIdSchema,
          label: z.string().nullable(),
          approvedAt: isoDateTimeSchema,
          lastSeenAt: isoDateTimeSchema.nullable(),
          revokedAt: isoDateTimeSchema.nullable(),
        }),
      ),
    ),
    /** Cuts a machine's access without touching the operator's account. */
    revoke: oc.input(z.object({ clientId: z.string() })).output(z.object({ ok: z.boolean() })),
  },

  /**
   * Notifications pushed to the consoles, **window closed**.
   *
   * The console gets watched on a phone tucked in a pocket: the page's
   * notifications stop as soon as the browser goes to sleep, which is exactly the
   * moment you need to be told. Web Push crosses that sleep, at the cost of one
   * subscription per browser and of a watcher on the hub side — it alone can
   * still observe that a room has gone down when nobody is looking.
   */
  push: {
    /**
     * The hub's VAPID public key, to pass to `pushManager.subscribe`.
     *
     * `null` when push is not available: the console then only offers page
     * notifications, rather than a button that would fail.
     */
    publicKey: oc.output(z.object({ publicKey: z.string().nullable() })),
    /** Registers the browser. Callable again: the same endpoint overwrites. */
    subscribe: oc
      .input(
        z.object({
          endpoint: z.url(),
          keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
          /** Readable label — "the control room's iPhone" — to tell them apart. */
          label: z.string().max(80).nullable().default(null),
          /**
           * What that particular browser wants to receive.
           *
           * Kept with the subscription, and not with the operator: it is the same
           * person who wants the essentials on the phone in their pocket and
           * everything on the console in front of them.
           */
          levels: notifLevelsSchema.default({ technique: 'essentiel', exploitation: 'essentiel' }),
        }),
      )
      .output(z.object({ ok: z.boolean() })),
    unsubscribe: oc.input(z.object({ endpoint: z.url() })).output(z.object({ ok: z.boolean() })),
  },

  /**
   * Shipping the rushes back to the hub's S3 storage.
   *
   * The hub holds the keys and never hands them over: it signs short-lived
   * addresses, the room uploads to them. A stolen room machine gives access to no
   * bucket, and revoking a room is enough to cut it off from the storage — the
   * same reason a room has its own token rather than an operator's.
   *
   * Every room procedure is bounded to the calling room by `roomOnly`: the
   * `roomId` comes from the token, never from the input.
   */
  vod: {
    /**
     * Opens — or **resumes** — the upload of a file.
     *
     * Idempotent on `(room, file)`: calling again restarts nothing, it returns the
     * plan already open with the list of parts that have arrived. That is what
     * makes a machine rebooted mid-upload able to pick up where it was, instead of
     * redoing three gigabytes.
     *
     * It is also the **start notification**: the hub has no other way of learning
     * that a room has started uploading something.
     */
    begin: oc
      .input(
        z.object({
          /** Path relative to the recordings root, as the room names it. */
          file: z.string().min(1).max(400),
          sizeBytes: z.number().int().nonnegative(),
          kind: vodKindSchema,
          sessionId: sessionIdSchema.nullable().default(null),
        }),
      )
      .output(uploadPlanSchema),

    /**
     * Signs the addresses of a batch of parts.
     *
     * In small batches and on demand, never all in advance: a signed address
     * expires, and presigning five hundred for a two-hour rush means expiring four
     * hundred and eighty before we get there.
     */
    parts: oc
      .input(
        z.object({
          uploadId: z.string(),
          numeros: z.array(z.number().int().positive()).min(1).max(20),
        }),
      )
      .output(z.array(signedPartSchema)),

    /**
     * A part has arrived.
     *
     * The `etag` is not bookkeeping: S3 requires it, part by part, when closing
     * the upload. Without it the object does not get reassembled. The duration is
     * for the room's regulator, which decides to carry on or ease off based on
     * what it observes, not on what it is promised.
     */
    progress: oc
      .input(
        z.object({
          uploadId: z.string(),
          numero: z.number().int().positive(),
          etag: z.string().min(1),
          octets: z.number().int().positive(),
          dureeMs: z.number().int().nonnegative(),
        }),
      )
      .output(z.object({ ok: z.boolean() })),

    /** Reassembles the object at the storage. **This is the end notification.** */
    complete: oc
      .input(z.object({ uploadId: z.string() }))
      .output(z.object({ ok: z.boolean(), objectKey: z.string() })),

    /**
     * Gives up, and says so.
     *
     * A multipart abandoned in silence stays billed indefinitely at the storage.
     * So the room reports it when it can; the hub's housekeeping covers the case
     * where it no longer can.
     */
    abort: oc
      .input(z.object({ uploadId: z.string(), raison: z.string().max(300) }))
      .output(z.object({ ok: z.boolean() })),

    /** What the hub knows about the uploads. `roomId` null = every room. */
    uploads: oc
      .input(z.object({ roomId: roomIdSchema.nullable().default(null) }))
      .output(z.array(uploadViewSchema)),

    /**
     * **One** talk's VOD folder. Admin.
     *
     * The "uploads" view sorts by file and by room, which is the right ordering
     * when dismantling a room and the wrong one when a speaker asks where their
     * capture is. This procedure answers the other way round: you start from the
     * slot, and go down to the take and then to the object at the storage.
     *
     * It does not depend on the storage: a hub with no S3 still answers, with
     * `stockageConfigure` false and the "takes" half filled in. That is even the
     * most useful case — knowing a rush exists on a machine you are about to
     * unplug.
     */
    conference: oc
      .input(z.object({ sessionId: sessionIdSchema }))
      .output(vodFolderSchema),

    /**
     * Is the storage configured, and how. Admin.
     *
     * No input: the console asks it to know whether it has anything to show.
     * Answering "not configured" beats a settings panel where every button would
     * fail — and says at the same time which variables are missing, which cannot
     * be guessed from a browser.
     */
    status: oc.output(
      z.object({
        /**
         * The hub knows where to write: keys **and** bucket.
         *
         * A single boolean for both, because nothing leaves without both — but a
         * null `endpoint` tells the two causes apart, and the console does not say
         * the same thing in one case and the other: one is set in an environment
         * file, the other in the field just above.
         */
        configure: z.boolean(),
        /** `null` = no keys configured on this hub, so nothing to set here. */
        endpoint: z.string().nullable(),
        bucket: z.string().nullable(),
        prefix: z.string().nullable(),
        politique: vodPolicySchema,
      }),
    ),

    /**
     * Tests the connection to the storage, for real. Admin.
     *
     * It does not probe: it **performs the real gesture**. Open an upload, sign a
     * part address, write a few bytes to it, abandon everything. That is the only
     * way to tell a bucket that exists from a bucket you are allowed to write to,
     * and a valid key from a correct signature.
     *
     * It never throws: the diagnosis **is** the answer. An HTTP error would lose
     * the step we stopped at, which is all we came for.
     *
     * What it does not say, and what you need to know: it tests the path **from
     * the hub**. The rooms write the parts themselves, on another network and
     * sometimes behind another firewall.
     */
    check: oc.output(storageCheckSchema),

    /**
     * Erases everything: the bucket prefix, and the rooms' rushes. **Dev only.**
     *
     * A development tool, and refused on the server side outside `MODE=dev` — not
     * merely absent from the console. A hidden view is one `hidden` away from
     * whoever inspects the page; this one destroys a day of capture.
     *
     * Three guard rails, each with its reason:
     *
     * - **a prefix is required.** Without it, "the prefix" and "the whole bucket"
     *   are the same thing, and a bucket shared with something else would go too;
     * - **on the room side, only what the application knows about is erased** —
     *   the video containers, their sidecars, the verdicts file. The capture root
     *   is sometimes a shared disk;
     * - **`confirmation` must equal `RAZ`.** The contract checks it, so the hub
     *   does too: a direct call, without going through the console and its dialog,
     *   cannot happen by inattention.
     */
    reset: oc
      .input(
        z.object({
          /** Typed again in the console. The contract makes it a hub guard. */
          confirmation: z.literal('RAZ'),
        }),
      )
      .output(
        z.object({
          /** Objects deleted under the prefix. */
          objets: z.number().int().nonnegative(),
          /** Uploads in progress abandoned along the way. */
          multiparts: z.number().int().nonnegative(),
          /** Rooms the order was sent to. Each erases its own. */
          salles: z.number().int().nonnegative(),
          /**
           * Capture events forgotten by the hub.
           *
           * The hub keeps its own memory of the takes, reconstructed from the
           * ingestion log. Leaving it standing made a talk's VOD folder list
           * captures whose files had just been erased — and the reset looked like
           * it had had no effect.
           */
          prises: z.number().int().nonnegative().default(0),
        }),
      ),

    /**
     * Asks a room to upload. Admin.
     *
     * The console does not hold the files: it can only ask. The room goes back
     * through its own regulator — but an explicit request counts as agreement not
     * to wait for the next window.
     */
    request: oc
      .input(
        z.object({
          roomId: roomIdSchema,
          /** `null` = everything not yet uploaded. */
          file: z.string().max(400).nullable().default(null),
        }),
      )
      .output(z.object({ ok: z.boolean() })),
  },

  /**
   * Mobile control: driving a room from a phone, through the hub.
   *
   * A namespace of its own, and not procedures grafted onto `rooms` or
   * `sessions`, because it is **the only surface the lock guards**. The lifecycle
   * goes through it again even though `sessions.start` already accepts an
   * operator: two doors to the same gesture, only one of them locked, would have
   * locked nobody.
   *
   * What the lock does not guard, and that is deliberate: the console keeps its
   * gestures free, and the room's control app does not go through the hub at all —
   * it posts on its own loopback. The operator physically in front of the machine
   * is never blocked by a phone that has wandered off down a corridor.
   */
  regie: {
    /**
     * The rooms and their locks, for the picker screen.
     *
     * An expired lock is not handed back: what the list shows is what you can take
     * without dispossessing anyone.
     */
    locks: oc.output(z.array(controlRoomSchema)),
    /**
     * Takes the room, or renews the hold.
     *
     * Without `force`, a room already held by someone else answers `CONFLICT`
     * naming the holder — taking over is a decision, not a side effect of
     * reloading a page. With `force`, it dispossesses; that is what the "Take over
     * the room" button does, behind a dialog.
     */
    hold: oc
      .input(z.object({ roomId: roomIdSchema, force: z.boolean().default(false) }))
      .output(controlLockSchema),
    /** Releases the room. No effect if the caller was not holding it. */
    release: oc.input(z.object({ roomId: roomIdSchema })).output(z.object({ ok: z.boolean() })),
    /**
     * A room's state, **and the lock's heartbeat**.
     *
     * Both in the same call, by design. A one-second poll already says "I am
     * here"; making it a second gesture is one more heartbeat you can forget to
     * stop — and a lock that outlives the page holding it. A caller that does not
     * hold the room merely reads.
     */
    view: oc.input(z.object({ roomId: roomIdSchema })).output(controlViewSchema),
    /**
     * A control gesture. Reserved for the lock holder.
     *
     * Two kinds of answer behind a single procedure, and `applied` tells them
     * apart: the lifecycle is written on the hub — settled on return —, a scene or
     * a recording leaves on the downstream flow and is only observed from the
     * view. Confusing the two would suggest a recording is running because a call
     * answered.
     */
    command: oc
      .input(z.object({ roomId: roomIdSchema, action: controlCommandSchema }))
      .output(controlCommandResultSchema),
  },

  questions: {
    post: oc
      .input(
        z.object({
          roomId: roomIdSchema,
          sessionId: sessionIdSchema.nullable(),
          author: z.string().max(80).nullable(),
          text: z.string().min(1).max(300),
        }),
      )
      .output(questionSchema),
    /** `deviceId` limits multiple voting without requiring an account. */
    vote: oc
      .input(z.object({ id: z.string(), deviceId: z.string().min(8) }))
      .output(z.object({ votes: z.number().int() })),
    list: oc
      .input(z.object({ roomId: roomIdSchema, sessionId: sessionIdSchema.nullable() }))
      .output(z.array(questionSchema)),
  },
}

export type Contract = typeof contract
