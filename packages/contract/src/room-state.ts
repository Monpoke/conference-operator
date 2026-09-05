import { z } from 'zod'
import { ROOM_STATES, SESSION_STATUSES } from '@conference-operator/room-state'
import { programSchema } from '@conference-operator/program'
import { eventIdentitySchema, DEFAULT_EVENT_IDENTITY } from './event-identity.js'
import {
  connectivitySchema,
  displayModeSchema,
  isoDateTimeSchema,
  executionModeSchema,
  roomIdSchema,
  sceneRoleSchema,
  sessionIdSchema,
} from './primitives.js'
import { DEFAULT_VOD_POLICY, vodPolicySchema, vodSyncSchema } from './vod.js'

/**
 * Role → OBS scene name mapping, per room and per instance.
 * Validated against `GetSceneList` on connection: an unresolved role turns red in
 * the control app, so the problem shows up at the rehearsal and not during a talk.
 */
export const sceneRoleMapSchema = z.object({
  A: z.partialRecord(sceneRoleSchema, z.string()),
  B: z.partialRecord(sceneRoleSchema, z.string()),
})
export type SceneRoleMap = z.infer<typeof sceneRoleMapSchema>

export const obsEndpointSchema = z.object({
  url: z.string(),
  /** Never transmitted in clear beyond the hub; stored via `safeStorage` on the client. */
  password: z.string().nullable(),
})

export const roomConfigSchema = z.object({
  id: roomIdSchema,
  name: z.string(),
  /** `event.tracks[].id` from the upstream export: it is the room ↔ program link. */
  trackId: z.string(),
  obs: z.object({ A: obsEndpointSchema, B: obsEndpointSchema }),
  sceneRoles: sceneRoleMapSchema,
  /** Port of the local HTTP server that serves the display pages and the asset cache. */
  displayPort: z.number().int().positive().default(7788),
  /** Root of the recordings, for renaming and sidecars. */
  recordingRoot: z.string().nullable().default(null),
  /**
   * Short fragment used in file names (`track1`).
   * The room's full name would give unreadable names; failing that we derive it,
   * but filling it in makes the rushes far easier to sort.
   */
  fileSlug: z.string().max(24).nullable().default(null),
  /** RTMP stream key, pushed by the hub at sync time. */
  stream: z
    .object({ rtmpUrl: z.string(), streamKey: z.string() })
    .nullable()
    .default(null),
  /**
   * Room whose stream this room may relay (overflow, studio).
   *
   * The software merely switches to the `RELAY` role; the routing itself (NDI or
   * SRT) is a matter of OBS configuration and networking. This field is there to
   * announce it in the control app: "RELAY → Track #2" rather than a button
   * nobody knows the output of.
   */
  relaySourceRoomId: roomIdSchema.nullable().default(null),
  /**
   * OpenFeedback project, **written by the hub, never by the room**.
   *
   * Used to build the "rate this talk" QR code, **offline**: OpenFeedback reuses
   * the session identifiers from the upstream export, so the address is derived
   * from the already cached program, with no API key and no network call on the
   * day. That is why the value travels all the way here rather than being asked
   * for at the moment the QR code is drawn.
   *
   * The field is absent from `roomConfigPatchSchema`: a control app cannot write
   * it, and it no longer appears in its ⚙. The project is a property of the
   * **event** — it is set once in the console, in
   * `hubSettings.openFeedbackProjectId`, and comes down resolved at every `sync`.
   *
   * This is not a matter of style: as long as two places could write it, it took
   * one operator filling it in on a single machine for that room to have links
   * and the others none, with nothing saying why. Twenty-six silent slots out of
   * twenty-seven.
   */
  openFeedbackProjectId: z.string().nullable().default(null),
  /**
   * On "Start", warn if nothing is recording.
   *
   * The most expensive oversight of the day: the talk happens, nobody notices,
   * and there is no VOD to recover in the evening. Launching a talk is the right
   * place to ask the question — it is the only moment when we know a talk is
   * starting.
   *
   * Enabled by default. Turned off for a room that does not record at all, where
   * the warning would become one more click on every talk.
   */
  promptRecordingOnStart: z.boolean().default(true),
  /**
   * On "End", offer to stop the capture that is still running.
   *
   * The counterpart of the previous one, and it covers the oversight that one let
   * through. A capture you do not stop is invisible: it carries on through the
   * break, then the next talk is written into the same file — under the title,
   * the speakers and the session identifier of the **previous** one. The start
   * guard rail then stays quiet, since a recording is running, and the room ends
   * the day with a three-hour master whose sidecar lies about its content.
   *
   * Enabled by default. Turned off for a room that deliberately records in one
   * go, audience questions included, beyond the slot.
   */
  promptRecordingOnStop: z.boolean().default(true),
  /**
   * Scene taken automatically on "Start".
   *
   * Launching the talk and going on air are two gestures that belong together;
   * separating them left the overlay on screen through the speaker's first
   * sentences. `null` disables the switch for a room that prefers to keep the
   * hand.
   */
  sceneOnStart: sceneRoleSchema.nullable().default('LIVE'),
})
export type RoomConfig = z.infer<typeof roomConfigSchema>

/**
 * What a room is allowed to reconfigure itself.
 *
 * Deliberately narrower than `roomConfigSchema`, and the rest does not slip in by
 * accident: zod discards unknown keys. Three exclusions, each for its own reason.
 *
 * - `id`, `name`, `trackId`: the room's identity comes from the upstream program.
 *   Letting it be rewritten from a machine would cut the room ↔ track link, and
 *   with it the whole displayed program.
 * - `stream`: a stream key comes down from the hub to its room, never the other
 *   way. It is entered where it already is, on the hub.
 * - `openFeedbackProjectId`: a property of the **event**, not of a machine. It was
 *   editable here, and the price showed: filled in on room 1's machine alone, it
 *   gave links to that room and to no other, with nothing to explain it. A
 *   setting two places can write always ends up written in only one.
 *
 * Everything else is machine configuration — OBS addresses, scene names, port,
 * recording folder — that is, exactly what is discovered in the room, in front of
 * the machines, and not when creating the rooms.
 */
const obsEndpointPatchSchema = z.object({
  url: z.string(),
  /**
   * Absent = unchanged.
   *
   * The control app never receives the password in clear — it only knows there is
   * one — so it cannot send it back as is. Without this distinction between
   * "empty" and "absent", saving a port change would erase the password along the
   * way.
   */
  password: z.string().nullable().optional(),
})

export const roomConfigPatchSchema = z
  .object({
    obs: z.object({ A: obsEndpointPatchSchema, B: obsEndpointPatchSchema }),
    sceneRoles: sceneRoleMapSchema,
    displayPort: z.number().int().positive(),
    recordingRoot: z.string().nullable(),
    fileSlug: z.string().max(24).nullable(),
    relaySourceRoomId: roomIdSchema.nullable(),
    promptRecordingOnStart: z.boolean(),
    promptRecordingOnStop: z.boolean(),
    sceneOnStart: sceneRoleSchema.nullable(),
  })
  .partial()
export type RoomConfigPatch = z.infer<typeof roomConfigPatchSchema>

/**
 * Shape *before* validation: fields with a default are optional there.
 * That is what writes accept, so as not to force every caller to repeat `null`s
 * the schema already sets.
 */
export type RoomConfigInput = z.input<typeof roomConfigSchema>

/**
 * Where a talk stands.
 *
 * `scheduled` is the default state and is never stored: we only record what
 * happened.
 *
 * The list comes from `@conference-operator/room-state`, which also carries the allowed
 * transitions: the contract and the state machine therefore cannot know
 * different states.
 */
export const sessionStatusSchema = z.enum(SESSION_STATUSES)
export type SessionStatus = z.infer<typeof sessionStatusSchema>

/**
 * What OpenFeedback knows about the program's slots.
 *
 * Three outcomes, and telling them apart is the whole point: a project that
 * cannot be found (`projetTrouve` false) kills every address at once and is fixed
 * with one field; a project that does not store its talks (`talksConnus` null)
 * makes the comparison moot, and saying so beats reporting twenty-seven slots
 * that are not missing; otherwise `manquants` names those whose link and QR code
 * lead to an empty page.
 */
export const openFeedbackCheckSchema = z.object({
  projet: z.string(),
  projetTrouve: z.boolean(),
  /**
   * Number of talks known to OpenFeedback, or `null`.
   *
   * `null` does not mean zero: it means "OpenFeedback does not keep that list",
   * because the project reads its sessions from an external source. Confusing the
   * two would cry wolf on a perfectly configured event — and a check that cries
   * wolf never gets run again.
   */
  talksConnus: z.number().int().nonnegative().nullable(),
  manquants: z.array(
    z.object({
      sessionId: sessionIdSchema,
      title: z.string(),
      /** The identifier actually served: that is the one we went looking for. */
      feedbackId: z.string(),
    }),
  ),
  /** What to make of it, in plain words: the console shows it as is. */
  detail: z.string(),
})
export type OpenFeedbackCheck = z.infer<typeof openFeedbackCheckSchema>

export const sessionStateSchema = z.object({
  sessionId: sessionIdSchema,
  roomId: roomIdSchema.nullable(),
  status: sessionStatusSchema,
  startedAt: isoDateTimeSchema.nullable(),
  endedAt: isoDateTimeSchema.nullable(),
  /** `auto` when the scheduling rule closed the slot, otherwise the operator. */
  decidedBy: z.string(),
})
export type SessionState = z.infer<typeof sessionStateSchema>

/**
 * An organizer account, shown in the waiting loop.
 *
 * The upstream export only carries the **speakers'** social accounts: the event's
 * own have no source in the program, hence this setting. A hub setting and not a
 * code constant: a handle changes between editions — and from one event to
 * another — and correcting it must not require shipping a release to the room
 * machines.
 */
export const socialLinkSchema = z.object({
  /** Network name, shown as is: "Bluesky", "LinkedIn"… */
  network: z.string().min(1).max(40),
  /** What is read on screen and typed back: "@exemple.fr". */
  handle: z.string().min(1).max(80),
  url: z.url(),
})
export type SocialLink = z.infer<typeof socialLinkSchema>

/**
 * What a browser wants to be notified about, family by family.
 *
 * Three notches rather than a switch: on the 2026 export, announcing every start,
 * end and approaching end makes **sixty-three notices** in a day, and a phone
 * that buzzes sixty-three times ends up on silent — in which case the overrun
 * goes unnoticed too.
 *
 * `essentiel` only holds departures from the script: something is not going as
 * planned and someone has to decide. `tout` adds the normal rhythm of the day,
 * followed from a corridor.
 */
export const notifLevelSchema = z.enum(['rien', 'essentiel', 'tout'])
export type NotifLevel = z.infer<typeof notifLevelSchema>

/**
 * The two families of notice.
 *
 * `technique` talks about machines — a room going quiet, a machine to pair.
 * `exploitation` talks about the running order — what starts, ends, overruns.
 * They are set separately because they do not address you at the same moment: one
 * worries, the other paces.
 */
export const notifLevelsSchema = z.object({
  technique: notifLevelSchema.default('essentiel'),
  exploitation: notifLevelSchema.default('essentiel'),
})
export type NotifLevels = z.infer<typeof notifLevelsSchema>

/**
 * Hub settings that can be changed during the event.
 *
 * Automatic closing exists because nobody thinks of pressing "End" when a talk
 * overruns and the room is applauding. The grace period is configurable: five
 * minutes suit a 50-minute format, far less a 20-minute lightning talk.
 */
export const hubSettingsSchema = z.object({
  /**
   * Event name, **if the imported program has to be contradicted**.
   *
   * `null` — the normal case — lets the hub read `event.name` from the active
   * snapshot: importing another event's program is then enough to rename the
   * public wall, the console, the room screens and the notifications, without
   * touching a line of code or an environment variable.
   *
   * The setting is for when the upstream export carries an internal name
   * ("CN26-prod") or no name at all. See `resolveEventIdentity`.
   */
  eventName: z.string().max(80).nullable().default(null),
  /**
   * Short name, where the year teaches nothing: window title, notification.
   *
   * `null` derives it from the full name by stripping the year. To be filled in
   * when the derivation gets it wrong — it is deliberately timid.
   */
  eventShortName: z.string().max(40).nullable().default(null),
  /**
   * The event's OpenFeedback project. **The only place it is written.**
   *
   * At the hub level because it is a property of the event, not of a room:
   * setting it once holds for all of them. It comes down resolved to the rooms at
   * `sync`, and a control app can no longer contradict it — the field existed in
   * its ⚙, and it took being filled in on a single machine for the other rooms to
   * have no links at all.
   *
   * Empty, no "rate this talk" QR code is drawn anywhere: no link beats a dead
   * link scanned in a room. A blank string counts as empty — it only produces
   * addresses like `openfeedback.io///…`.
   */
  openFeedbackProjectId: z.string().max(80).nullable().default(null),
  autoEndEnabled: z.boolean().default(true),
  autoEndGraceMinutes: z.number().int().min(0).max(120).default(5),
  /**
   * The "conference-center" export the hub reimports.
   *
   * A setting and not an environment variable: the URL changes when the program
   * changes, that is, during the event, and restarting the hub to correct it is
   * exactly what cannot be done that day. `PROGRAM_SOURCE_URL` stays the seed for
   * the first startup, then this setting is authoritative.
   */
  programSourceUrl: z.url().nullable().default(null),
  /**
   * Organizer accounts, shown in the rooms' waiting loop.
   *
   * Pushed to the rooms at `sync` and kept in local cache: the loop runs during
   * the breaks, that is, exactly when the event network is busiest, and a screen
   * that loses half its content because the hub took three seconds to answer is
   * visible from the whole room.
   */
  socialLinks: z.array(socialLinkSchema).max(8).default([]),
  /**
   * Bucket the rushes land in. `null` = none, and nothing leaves.
   *
   * Here and not in the environment, unlike the keys: a bucket name is not a
   * secret, and it is the part that changes — from one edition to the next, or on
   * the morning you realise you were aiming at last year's.
   */
  vodBucket: z.string().max(200).nullable().default(null),
  /**
   * Storage prefix in the bucket, with no trailing slash.
   *
   * The file name produced by the room already carries date, room, time and
   * title; the prefix only serves to fit several editions in one bucket without
   * mixing them up.
   */
  vodPrefix: z.string().max(200).nullable().default(null),
  vodPolitique: vodPolicySchema.default(DEFAULT_VOD_POLICY),
})
export type HubSettings = z.infer<typeof hubSettingsSchema>
export type HubSettingsInput = z.input<typeof hubSettingsSchema>

/**
 * A talk's state, enriched with the program.
 *
 * The console does not hold the program: without these fields it could only show
 * an opaque identifier and would be unable to compute the remaining time. They
 * are resolved on the hub side, at read time.
 */
export const sessionStateViewSchema = sessionStateSchema.extend({
  title: z.string().nullable(),
  roomName: z.string().nullable(),
  /** **Scheduled** times, not the actual ones. */
  scheduledStartsAt: isoDateTimeSchema.nullable(),
  scheduledEndsAt: isoDateTimeSchema.nullable(),
  /**
   * Time left on the scheduled slot, on the hub's clock. Negative = overrun.
   *
   * Redundant with `scheduledEndsAt` in appearance only: subtracting it requires
   * a reference time, and the browser only has its own. The hub's clock can be
   * simulated — in development the gap is measured in weeks — and it is the
   * authority for the whole day. Same reason, and same field, as
   * `roomStatus.currentSession.remainingMs`.
   */
  remainingMs: z.number().int().nullable().default(null),
})
export type SessionStateView = z.infer<typeof sessionStateViewSchema>

/**
 * A decision taken on a slot on the day, without a reimport.
 *
 * `break` and `talk` correct what the export does not say. The normalizer has a
 * single signal to decide on — a slot **with no speaker** is a break — and it
 * gets it wrong both ways: a plenary announced with a name passes for a room
 * talk, a keynote whose speaker is not announced yet passes for lunch.
 *
 * The hub then serves the program with the corrected `kind`, and everything that
 * follows goes with it — on-air titling, target of "Start", status dot colour,
 * feedback QR code. An override that says what the export already says has no
 * effect: see `ProgramService.active`.
 *
 * The other three are declared but not applied yet.
 */
export const sessionOverrideSchema = z.object({
  sessionId: sessionIdSchema,
  status: z.enum(['talk', 'break', 'delayed', 'cancelled', 'moved']),
  delayMinutes: z.number().int().nullable(),
  note: z.string().nullable(),
})

export const syncResultSchema = z.object({
  protocolVersion: z.number().int(),
  /** Snapshot hash: the client only re-downloads if it changed. */
  contentHash: z.string(),
  /** Absent when the client is already up to date (`since` == `contentHash`). */
  program: programSchema.nullable(),
  room: roomConfigSchema,
  overrides: z.array(sessionOverrideSchema),
  /** Base of the clock offset: the VOD timecodes depend on it. */
  serverTime: isoDateTimeSchema,
  /**
   * The hub's mode.
   *
   * The room compares it with its own and reports any divergence: a development
   * machine plugged into the event hub — or the other way round — must be visible
   * before it is noticed in the recordings.
   */
  mode: executionModeSchema.default('production'),
  /**
   * The hub's clock is simulated.
   *
   * Propagated all the way to the control screen: seeing 11:00 on an August
   * morning with no explanation would cast doubt on everything else.
   */
  simulatedClock: z.boolean().default(false),
  /**
   * The event's accounts, for the waiting loop.
   *
   * Sent down with the rest rather than asked for separately: the room must be
   * able to run its whole loop without touching the network once synchronized.
   */
  socialLinks: z.array(socialLinkSchema).default([]),
  /**
   * The event's identity, decided by the hub.
   *
   * Sent down and cached like the rest: the room must be able to title its
   * windows and its waiting loop before reaching anyone. Resolved on the hub side
   * rather than derived from the program on the room side, so that the setting
   * that contradicts the upstream export holds on the screens too.
   */
  event: eventIdentitySchema.default(DEFAULT_EVENT_IDENTITY),
  /**
   * Shipping the rushes back: does the hub know where to send them, and at what
   * pace.
   *
   * Sent down and cached like the program, and for the same reason: a room's
   * regulator decides several times a minute, and it must never depend on a
   * network call — least of all at the very moment the network is what we are
   * trying to spare. `null` when the hub has no storage configured.
   */
  vod: vodSyncSchema.nullable().default(null),
})

/** Hub view of a room, fed by the heartbeats — the supervision screen. */
export const roomStatusSchema = z.object({
  roomId: roomIdSchema,
  name: z.string(),
  connectivity: connectivitySchema,
  lastSeenAt: isoDateTimeSchema.nullable(),
  sceneRole: sceneRoleSchema.nullable(),
  currentSessionId: sessionIdSchema.nullable(),
  recording: z.boolean(),
  streaming: z.boolean(),
  /**
   * The room's screen, as it reported it. `null` = never said.
   *
   * Distinct from `sceneRole`, and confusing them would project one for the
   * other: the scene is what OBS-A sends to the projector during a talk, the mode
   * is what the display page shows the rest of the time.
   */
  displayMode: displayModeSchema.nullable().default(null),
  outboxDepth: z.number().int().nonnegative(),
  programContentHash: z.string().nullable(),
  /**
   * What is playing right now, according to the program and the hub's clock.
   *
   * The title, not just the identifier: a supervision console must answer "what
   * is going on" without having to look elsewhere. Computed from the program
   * rather than from what the room reported — a room that is cut off must keep
   * showing what it is supposed to be broadcasting.
   */
  currentSession: z
    .object({
      id: sessionIdSchema,
      title: z.string(),
      endsAt: isoDateTimeSchema.nullable(),
      /**
       * Time left on the slot, on the hub's clock. Negative = overrun.
       *
       * Redundant with `endsAt` in appearance only: subtracting it requires a
       * reference time, and the browser only has its own. The hub's clock can be
       * simulated — in development the gap is measured in weeks — and it is the
       * authority for the whole day. `null` on a slot with an unknown end, which
       * we do not want to show as "0 min".
       */
      remainingMs: z.number().int().nullable().default(null),
    })
    .nullable()
    .default(null),
  /**
   * The room's break, running or imminent — or `null`.
   *
   * Separate from `conference`, and not one more state: the two coexist. A talk
   * can run while lunch approaches, and that is even the case that matters — the
   * one where you decide not to run straight on.
   *
   * Computed by the hub, like the rest of this structure: it alone has the
   * authoritative time, and that time can be simulated.
   */
  breakBadge: z
    .object({
      /** `a-venir`: it starts in less than a quarter of an hour. */
      state: z.enum(['en-cours', 'a-venir']),
      title: z.string(),
      startsAt: isoDateTimeSchema,
      /** Resumption: effective end of the break. `null` if nothing closes it. */
      endsAt: isoDateTimeSchema.nullable(),
    })
    .nullable()
    .default(null),
  /**
   * Where the room stands, in one word — what the consoles' status dot paints.
   *
   * Computed by the hub, like `remainingMs` and for the same reason: it alone has
   * the authoritative time, and that time can be simulated. Deriving it in the
   * browser would give a correct colour on the operator's machine and a wrong one
   * everywhere else.
   *
   * Crosses the program with the talk lifecycle ("Start" / "End" in the control
   * app). The program gives the slot; the lifecycle gives what is really playing
   * in it. Without it, a started slot nobody launched read as "running", and a
   * room overrunning did not exist — past the end time, the program moves on to
   * the next slot.
   */
  conference: z.enum(ROOM_STATES).default('aucune'),
})
export type RoomStatus = z.infer<typeof roomStatusSchema>
