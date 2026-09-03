import { z } from 'zod'
import {
  displayModeSchema,
  isoDateTimeSchema,
  sceneRoleSchema,
  sessionIdSchema,
} from './primitives.js'
import { sessionStatusSchema } from './room-state.js'

/**
 * Downstream commands (hub → room).
 *
 * Carried by an Event Iterator stamped with `seq`: on reconnection, oRPC sends
 * back the last `lastEventId` received and the hub resumes just after it. No
 * home-made catch-up counter.
 */

/** What a live banner shows. Short: it shares the screen with the video. */
export const bannerSchema = z.object({
  text: z.string().min(1).max(240),
  level: z.enum(['info', 'warning', 'urgent']),
})
export type Banner = z.infer<typeof bannerSchema>

/**
 * Banner templates, ready to send.
 *
 * Constant and shared rather than stored: these are the few sentences you put on
 * air without thinking on an event day, and retyping them under pressure is the
 * best way to get them wrong. The text stays editable before sending — these are
 * starting points, not rails.
 */
export const BANNER_TEMPLATES: { name: string; message: Banner }[] = [
  { name: 'Questions', message: { text: 'Posez vos questions sur le mur — QR code à l\'écran', level: 'info' } },
  { name: 'Pause', message: { text: 'Pause de 15 minutes — reprise juste après', level: 'info' } },
  { name: 'Micro', message: { text: 'Problème de son en cours de résolution', level: 'warning' } },
  { name: 'Retard', message: { text: 'La conférence commencera avec quelques minutes de retard', level: 'warning' } },
  { name: 'Enregistrement', message: { text: 'Cette session est enregistrée et sera disponible en ligne', level: 'info' } },
]

export const commandPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('scene.force'),
    role: sceneRoleSchema,
    /**
     * Who asked for the switch, or `null` for a decision by the hub itself.
     *
     * Same reason as on `room.resync`: a room whose overlay switches without
     * anyone touching it on site reads as an incident. The room's control screen
     * reports it in its banner, with the address of whoever asked.
     */
    requestedBy: z.string().nullable().default(null),
  }),
  z.object({
    /**
     * OBS-B capture, driven remotely.
     *
     * **A state, not a verb**: `on` rather than `recording.start` and
     * `recording.stop`. A command caught up later then describes an intent that
     * is still readable, and applying it twice costs nothing — which matters on
     * an at-least-once stream. Asking for what is already running is a silent
     * success, not an incident.
     */
    type: z.literal('recording.set'),
    on: z.boolean(),
    requestedBy: z.string().nullable().default(null),
  }),
  z.object({
    /** OBS-B streaming. Same shape and same reasons as `recording.set`. */
    type: z.literal('stream.set'),
    on: z.boolean(),
    requestedBy: z.string().nullable().default(null),
  }),
  z.object({
    /**
     * Who holds this room's mobile control app, or `null` if nobody.
     *
     * Broadcast on every **change** of holder, never on the heartbeat: one
     * renewal per second per held room would fill the command table for a piece
     * of information that has not moved.
     *
     * It locks nothing in the room — the operator who is physically there is
     * never blocked by a phone that has wandered off down a corridor. It exists
     * so the control screen can **say** it, failing which a scene switching by
     * itself would read as a failure.
     */
    type: z.literal('regie.hold'),
    holder: z.string().nullable(),
  }),
  z.object({
    type: z.literal('display.set'),
    mode: displayModeSchema,
    sessionId: sessionIdSchema.nullable().default(null),
  }),
  z.object({
    type: z.literal('message.broadcast'),
    text: z.string().min(1).max(500),
    level: z.enum(['info', 'warning', 'urgent']),
    /**
     * Who is meant to see this message.
     *
     * An essential distinction: `operator` settles for the control app's banner,
     * `audience` takes over the room screen. Without it, a note addressed to the
     * operator — "your speaker has arrived" — would show up in large type in
     * front of the audience.
     */
    target: z.enum(['operator', 'audience']).default('operator'),
    /** Author shown, so we know who to answer. */
    from: z.string().max(80).nullable().default(null),
  }),
  z.object({
    /**
     * Banner on the live scenes.
     *
     * Not to be confused with `message.broadcast`, which **takes over** the room
     * screen: this one overlays the video without interrupting anything. The
     * speaker carries on, the slides stay visible, and the banner goes out live
     * and to the VOD like the rest of the overlay.
     */
    type: z.literal('overlay.set'),
    /** `null` removes the banner. That is the console's "hide". */
    message: bannerSchema.nullable(),
  }),
  z.object({
    /** A new snapshot is available: the client resynchronizes. */
    type: z.literal('program.invalidate'),
    contentHash: z.string(),
  }),
  z.object({
    /**
     * Full resynchronization requested from the console.
     *
     * Distinct from `program.invalidate`, which announces a fact — the program
     * has changed — and lets the room re-download only what moved. Here nothing
     * has changed on the hub: it is the room we suspect of having drifted, and we
     * ask it to read everything again without trusting its cache.
     *
     * The gesture exists because there was no other: putting a room straight
     * meant restarting it, and so cutting its capture.
     */
    type: z.literal('room.resync'),
    /** Who asked for it: the room traces it, so we know where the gesture came from. */
    requestedBy: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal('wall.approved'),
    commentId: z.string(),
  }),
  z.object({
    /**
     * Upload the rushes, requested from the console.
     *
     * The console does not hold the files: it can only ask, and it is the room
     * that decides *when*, by going back through its regulator. A request from
     * here carries the same urgency as a click in the control app — so it
     * overrides the waiting rules, but not the absence of configured storage.
     *
     * It takes the downstream flow like `room.resync`, and for the same reason: a
     * room momentarily cut off catches up on reconnection instead of losing it.
     */
    type: z.literal('vod.upload'),
    /** Target file. `null` = everything not yet uploaded. */
    file: z.string().nullable().default(null),
    /** Who asked for it: the control app shows it, as for a resynchronization. */
    requestedBy: z.string().nullable().default(null),
  }),
  z.object({
    /**
     * Erases the room's rushes. **Development only.**
     *
     * The hub refuses to emit it outside `MODE=dev`, and the room refuses it in
     * turn: two locks rather than one, because a development room and an event
     * hub can end up plugged into each other — that is even the accident the mode
     * badge exists to make visible.
     *
     * Only what the application knows about is erased: video containers,
     * sidecars, verdict file. The capture root is sometimes a shared disk, and
     * emptying a folder you do not entirely own is not a gesture you can take
     * back.
     */
    type: z.literal('vod.reset'),
    requestedBy: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal('session.override'),
    sessionId: sessionIdSchema,
    status: z.enum(['delayed', 'cancelled', 'moved']),
    delayMinutes: z.number().int().optional(),
    note: z.string().max(300).optional(),
  }),
  z.object({
    /** A talk's state changed — decided elsewhere, or by the scheduling rule. */
    type: z.literal('session.state'),
    sessionId: sessionIdSchema,
    /**
     * Room concerned.
     *
     * The command is broadcast to **every** room: a control app must be able to
     * report "Track #2 has just finished" without asking the hub. Each room then
     * decides whether the event concerns it or belongs to notifications.
     */
    roomId: z.string().nullable(),
    sessionTitle: z.string().nullable(),
    status: sessionStatusSchema,
    decidedBy: z.string(),
  }),
  z.object({
    /**
     * The hub's clock changed.
     *
     * Rooms align their offset on `serverTime` at every synchronization; without
     * this broadcast they would stay on the old time until the next one — that
     * is, a screen showing a different moment than the console.
     */
    type: z.literal('clock.changed'),
    serverTime: isoDateTimeSchema,
    simulated: z.boolean(),
  }),
  z.object({
    type: z.literal('stream.configure'),
    rtmpUrl: z.string(),
    streamKey: z.string(),
  }),
])
export type CommandPayload = z.infer<typeof commandPayloadSchema>
export type CommandType = CommandPayload['type']

/**
 * Shape *before* validation: fields with a default are optional there.
 *
 * That is what publishers must accept — requiring `sessionId: null` on a
 * `display.set` when the schema fills it in by itself would be false friction on
 * every call.
 */
export type CommandPayloadInput = z.input<typeof commandPayloadSchema>

export const commandSchema = z.object({
  /** Monotonic per room. Also serves as the event `id` for oRPC resumption. */
  seq: z.number().int().positive(),
  issuedAt: isoDateTimeSchema,
  /**
   * Validity window. A command caught up after expiry is *discarded*: a "lunch
   * break" received 40 minutes late must not be shown. `null` = no expiry
   * (durable state change).
   */
  ttlSeconds: z.number().int().positive().nullable(),
  payload: commandPayloadSchema,
})
export type Command = z.infer<typeof commandSchema>

/**
 * Validity window of mobile control gestures, per command.
 *
 * They live in the contract because both sides read them: the hub to stamp what
 * it publishes, the tests to pin down values whose drift would be paid for in
 * front of a room.
 *
 * A scene switch is the shortest — caught up ten minutes later, it puts the room
 * on air over nothing. The room screen shares its window for the same reason:
 * that is also what the audience sees, and a "rate this talk" caught up in the
 * middle of the next one is the wrong screen in front of the wrong people.
 * Capture holds longer: a room cut off for thirty seconds must catch up, but a
 * room cut off for ten minutes must not start recording on its own.
 */
export const CONTROL_COMMAND_TTL = {
  'scene.force': 30,
  'display.set': 30,
  'recording.set': 90,
  'stream.set': 90,
} as const

/** Is a command still applicable? Used when catching up. */
export function isCommandExpired(command: Command, nowMs: number): boolean {
  if (command.ttlSeconds == null) return false
  return nowMs > Date.parse(command.issuedAt) + command.ttlSeconds * 1000
}
