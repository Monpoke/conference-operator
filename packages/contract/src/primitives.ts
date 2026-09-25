import { z } from 'zod'

/**
 * Protocol version, negotiated at enrolment and on every sync.
 *
 * The hub and a room client may run different binaries on the day (a machine
 * that was not updated — it happens): the hub must be able to detect that and
 * refuse cleanly rather than fail on a missing field.
 */
export const PROTOCOL_VERSION = 1

export const roomIdSchema = z.string().min(1)
export const sessionIdSchema = z.string().min(1)

/** ULID generated client-side: time-sorted, and therefore usable as an order key. */
export const ulidSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'ULID attendu')

export const isoDateTimeSchema = z.iso.datetime({ offset: true })

/**
 * Scene roles. The client only knows roles; the mapping to real OBS scene names
 * lives in each room's config, so that a room can name its scenes however it
 * likes.
 */
export const sceneRoleSchema = z.enum([
  'LIVE',
  'HOLD',
  'TALK',
  'CAM_ONLY',
  'SLIDES_ONLY',
  'RELAY',
])
export type SceneRole = z.infer<typeof sceneRoleSchema>

/**
 * Execution mode of a machine — hub as well as room.
 *
 * `dev` unlocks the development conveniences (simulated clock, simulated OBS);
 * `production` refuses them, even when left in an environment file. Travels
 * between hub and room so each knows what it is talking to: a development room
 * plugged into the event hub is exactly the kind of accident you want to see
 * from a distance.
 */
export const executionModeSchema = z.enum(['production', 'dev'])
export type ExecutionMode = z.infer<typeof executionModeSchema>

/** OBS-A = projector output, OBS-B = capture/VOD. */
export const obsInstanceSchema = z.enum(['A', 'B'])
export type ObsInstance = z.infer<typeof obsInstanceSchema>

/**
 * What the display page renders off air. Driven by state, not by OBS scenes:
 * changing content must never require touching OBS.
 */
export const displayModeSchema = z.enum([
  'sponsors',
  'programme',
  /**
   * The same day, in two columns.
   *
   * A second layout for the program, kept alongside the first rather than
   * replacing it: the two are compared in the room, on the real video projector,
   * and it is there that one is chosen. `programme` scrolls a single column,
   * `agenda` fits the whole day on one still screen.
   */
  'agenda',
  /** OpenFeedback QR code for the running talk: "rate this talk". */
  'feedback',
  /**
   * The question picked in the control app, in large type.
   *
   * The video banner only reaches those watching the capture screen or the live
   * scene; this mode puts it in front of the whole room, whatever OBS is
   * broadcasting at the same moment.
   */
  'question',
  'countdown',
  'message',
  'wall',
  /**
   * The event's social wall: a mosaic of what is said about it — walls.io, the
   * audience's messages, the partners' posts.
   *
   * Distinct from `wall`, which shows the audience's messages alone, full screen,
   * on the operator's call: the room talking to the room. This one is the event
   * seen from outside, and it is a loop page too. The name stays from when it was
   * walls.io's embed: the value is stored in rooms and consoles already deployed.
   */
  'wallsio',
  /**
   * Waiting loop: sponsors, room program, other rooms, social accounts.
   *
   * What you leave running during breaks. The `sponsors` and `programme` modes
   * stay available on their own: when something happens, you want to be able to
   * freeze the screen on a specific page rather than wait for the loop to come
   * back to it.
   */
  'loop',
  'live',
])
export type DisplayMode = z.infer<typeof displayModeSchema>

/**
 * The screens an event can withdraw, one by one.
 *
 * Not every edition uses every screen: an event with no sponsors, or one whose
 * program is imported at the last minute, ends up with buttons in the control app
 * that project an empty frame — and with loop pages nobody wants to see come
 * round. Withdrawing a screen here removes it from the control app's choices and
 * from the waiting loop; it says nothing about what is **currently** on the
 * screen, which stays the operator's decision alone.
 *
 * Two values are deliberately missing. `loop` is the screen one always comes back
 * to — withdrawing it would leave a room with nothing to fall back on — and
 * `live` is not a choice but the state of being on air. Two values are here that
 * are not display modes: `rooms` and `socials` exist only inside the loop, and an
 * organizer withdrawing "the other rooms' page" does not care about that
 * distinction. The same holds for the loop scenes that follow them — the welcome,
 * the "offered by" announcements, the thanks to the sponsors, the animated
 * slogans, the code of conduct and the event's feedback QR.
 */
export const roomScreenSchema = z.enum([
  'sponsors',
  'programme',
  'agenda',
  'countdown',
  'message',
  'feedback',
  'wall',
  'question',
  'wallsio',
  'rooms',
  'socials',
  'welcome',
  'announcements',
  'sponsors-thanks',
  'slogans',
  'code-of-conduct',
  'event-feedback',
  'other-agendas',
  'agenda-reminder',
])
export type RoomScreen = z.infer<typeof roomScreenSchema>

/**
 * A list of screens, read tolerantly: a screen this version no longer knows is
 * dropped, not an error.
 *
 * The lists live in stored settings and room caches, and one unknown value would
 * fail the whole parse — the hub's settings fall back to their defaults on
 * failure, every one of them. A screen withdrawn from the code (the hand-fed
 * `posts`, merged into the social wall) must not cost an event its settings.
 */
export const roomScreenListSchema = z.preprocess(
  (value) => (Array.isArray(value) ? value.filter((v) => roomScreenSchema.safeParse(v).success) : value),
  z.array(roomScreenSchema),
)

export const connectivitySchema = z.enum(['ONLINE', 'DEGRADED', 'OFFLINE'])
export type Connectivity = z.infer<typeof connectivitySchema>

/**
 * `required`: persisted, replayed until `expiresAt`. Losing the event would skew
 * the VOD or the room's history.
 * `best-effort`: telemetry. Stale fast, overwritten by `dedupKey`, disposable.
 */
export const deliverySchema = z.enum(['required', 'best-effort'])
export type Delivery = z.infer<typeof deliverySchema>

/**
 * An OBS audio source, and whether it is muted on each instance.
 *
 * The rooms feed the same microphones into OBS-A and OBS-B, under the same name:
 * the source is the unit the operator thinks in, and a mute applies to both. The
 * state stays per instance all the same — cut in one OBS and not the other is
 * exactly what has to show, since it is heard in the room and not in the VOD, or
 * the other way round.
 *
 * `null` = the instance does not have this source, or is not connected.
 */
export const audioInputSchema = z.object({
  name: z.string().min(1).max(200),
  muted: z.object({ A: z.boolean().nullable(), B: z.boolean().nullable() }),
})
export type AudioInput = z.infer<typeof audioInputSchema>
