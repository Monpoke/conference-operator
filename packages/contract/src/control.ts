import { z } from 'zod'
import { ROOM_STATES } from '@cloudnord/room-state'
import { sessionSchema } from '@cloudnord/program'
import {
  connectivitySchema,
  displayModeSchema,
  isoDateTimeSchema,
  roomIdSchema,
  sceneRoleSchema,
  sessionIdSchema,
} from './primitives.js'
import { eventIdentitySchema } from './event-identity.js'
import { sessionStatusSchema } from './room-state.js'

/**
 * The mobile control app: driving a room from a phone, through the hub.
 *
 * A room's control screen talks to its own machine — SSE for state,
 * `POST /control/action` for gestures, all over `127.0.0.1`. An operator who is
 * not in front of that keyboard has no commands at all: the console knows how to
 * *watch* a room, not to drive it.
 *
 * This module describes the second door. It goes through the hub, so through the
 * downstream command flow that already exists: nothing new connects a phone to an
 * OBS instance, and the room stays autonomous — a command it misses is caught up
 * on reconnection, or expires.
 */

/**
 * Beyond this, a lock nobody reports on any more falls by itself.
 *
 * Thirty seconds: enough to cross a metro tunnel or lock your phone for a minute
 * — the heartbeat restarts on the first poll —, short enough that an abandoned
 * room does not stay held while you look for it. Forced takeover exists for
 * longer cases, and it names who it dispossesses.
 */
export const CONTROL_LOCK_TTL_MS = 30_000

/**
 * Header a mobile control tab identifies itself with.
 *
 * The lock holds a **session**, not an account. Two tabs belonging to the same
 * operator — the phone in a pocket and the tablet on the table — would otherwise
 * drive the same room each believing it was alone, which is exactly the situation
 * the lock exists to remove. The address stays what we display; it is this
 * identifier that decides.
 *
 * A header rather than an input field, on the model of `x-room-client-id`: it
 * concerns three procedures and has no business in the payload of each.
 */
export const CONTROL_SESSION_HEADER = 'x-regie-session'

/**
 * Who holds a room's mobile control app.
 *
 * `expiresAt` is **computed** (`lastSeenAt + CONTROL_LOCK_TTL_MS`) and not
 * stored: an expired lock is never handed back, even when its row is still lying
 * around in the database. That is the rule the repository applies everywhere a
 * state is derived — `roomConferenceState` is no more stored than this.
 */
export const controlLockSchema = z.object({
  roomId: roomIdSchema,
  /** The operator's address, like `decidedBy`: the only word that answers "who did that". */
  holder: z.string(),
  /**
   * The tab holding the room. It is what decides, not the address.
   *
   * Returned to the client so it knows whether it is that holder: "it's you" and
   * "it's you, elsewhere" do not call for the same page — the second asks to take
   * over, and that has to be sayable.
   */
  holderId: z.string(),
  heldSince: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
})
export type ControlLock = z.infer<typeof controlLockSchema>

/** A room as the picker screen presents it, lock included. */
export const controlRoomSchema = z.object({
  roomId: roomIdSchema,
  name: z.string(),
  conference: z.enum(ROOM_STATES),
  connectivity: connectivitySchema,
  lock: controlLockSchema.nullable(),
})
export type ControlRoom = z.infer<typeof controlRoomSchema>

/**
 * Everything a mobile control app shows of a room.
 *
 * Deliberately narrower than the `DisplayPayload` a room machine serves: the hub
 * knows neither the audio meters, nor the rushes, nor the detailed state of the
 * two OBS instances. It knows the program, the lifecycle, the authoritative
 * clock, and what the room reported through its heartbeat — which is exactly
 * enough for the chosen scope.
 *
 * Everything that depends on time is computed **here**, never in the browser: the
 * hub's clock can be simulated, and in development the gap is measured in weeks.
 */
export const controlViewSchema = z.object({
  roomId: roomIdSchema,
  roomName: z.string(),
  /**
   * The event's identity, to title the window.
   *
   * The name decided by the hub, not the program's: it gets corrected during the
   * day without a reimport, and the tab bar is where a stale name is noticed
   * first — an operator lining up three rooms has only that to tell them apart.
   */
  event: eventIdentitySchema,
  timezone: z.string(),
  serverTime: isoDateTimeSchema,
  simulatedClock: z.boolean(),

  /**
   * Is the room answering, and since when.
   *
   * Decisive for reading the buttons: the lifecycle is written on the hub and
   * always succeeds, the scene and the recording wait for the room. Confusing the
   * two would suggest a failure on one side, or a success on the other.
   */
  connectivity: connectivitySchema,
  lastSeenAt: isoDateTimeSchema.nullable(),

  /** The eight-valued state, computed on the hub's clock. */
  conference: z.enum(ROOM_STATES),

  /**
   * The talk "Start" and "End" reach.
   *
   * Rarely the current slot: between two talks and during a break, it is the next
   * one you want to launch — the speaker is settling in. The rule lives in
   * `talkToControl`, the same one the room's control app runs.
   */
  targetSession: sessionSchema.nullable(),
  targetIsUpcoming: z.boolean(),
  /** Lifecycle of the room's talks, by identifier. */
  sessionStates: z.record(sessionIdSchema, sessionStatusSchema),
  /** The room's slots, for the timeline and the countdown. */
  sessions: z.array(sessionSchema),

  /** What the room reported from OBS. */
  sceneRole: sceneRoleSchema.nullable(),
  recording: z.boolean(),
  streaming: z.boolean(),

  /**
   * What the room is displaying, or `null` if it has not said yet.
   *
   * It comes from the heartbeat, so up to ten seconds behind a switch decided in
   * the room — that is the price of inventing nothing. `null` is a real value: a
   * room never heard from has no known screen, and lighting up "Loop" by default
   * would have the page claim something it does not know.
   */
  displayMode: displayModeSchema.nullable(),

  /**
   * The OBS-A roles actually mapped for this room.
   *
   * Offering `RELAY` to a room that has none would give a button nobody knows the
   * output of — and which would fail. The local control app reads the same thing
   * from its configuration.
   */
  sceneRoles: z.array(sceneRoleSchema),
  relaySourceRoomId: roomIdSchema.nullable(),
  promptRecordingOnStart: z.boolean(),
  promptRecordingOnStop: z.boolean(),
  sceneOnStart: sceneRoleSchema.nullable(),

  lock: controlLockSchema.nullable(),
})
export type ControlView = z.infer<typeof controlViewSchema>

/**
 * The gestures a mobile control app can make.
 *
 * The lifecycle goes through here and not directly through `sessions.*`, even
 * though those procedures exist and already accept an operator: that is what
 * gives **a single door to guard**. The lock holds `regie.command` and nothing
 * else — the console keeps its gestures, and the room's own control app is never
 * throttled by a phone that has wandered off down a corridor.
 *
 * `sessionId` is explicit rather than derived from the program at call time: the
 * targeted slot can turn over between the render and the click, and that is
 * exactly the instant at which an implicit target launches the wrong talk.
 */
export const controlCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('session.start'), sessionId: sessionIdSchema }),
  z.object({ type: z.literal('session.end'), sessionId: sessionIdSchema }),
  z.object({ type: z.literal('session.reset'), sessionId: sessionIdSchema }),
  z.object({ type: z.literal('scene.set'), role: sceneRoleSchema }),
  /**
   * The room's screen, off air.
   *
   * With no `sessionId`, where the downstream command accepts one: remotely you
   * choose a mode, not a talk to put in it. So the hub leaves it null, and the
   * room applies the mode to whatever it is already driving.
   */
  z.object({ type: z.literal('display.set'), mode: displayModeSchema }),
  z.object({ type: z.literal('recording.set'), on: z.boolean() }),
  z.object({ type: z.literal('stream.set'), on: z.boolean() }),
])
export type ControlCommand = z.infer<typeof controlCommandSchema>

/**
 * What a gesture actually achieved.
 *
 * `now`: the hub has written, it is settled — the lifecycle lives there.
 * `queued`: the command has left on the downstream flow, and that is **all the
 * hub can promise**. Whether the scene switched is then read from the view, not
 * from this reply. The distinction is not cosmetic: it is what stops the mobile
 * control app believing a recording started because a call answered 200.
 */
export const controlCommandResultSchema = z.object({
  ok: z.boolean(),
  applied: z.enum(['now', 'queued']),
})
export type ControlCommandResult = z.infer<typeof controlCommandResultSchema>
