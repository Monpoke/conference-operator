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

export const connectivitySchema = z.enum(['ONLINE', 'DEGRADED', 'OFFLINE'])
export type Connectivity = z.infer<typeof connectivitySchema>

/**
 * `required`: persisted, replayed until `expiresAt`. Losing the event would skew
 * the VOD or the room's history.
 * `best-effort`: telemetry. Stale fast, overwritten by `dedupKey`, disposable.
 */
export const deliverySchema = z.enum(['required', 'best-effort'])
export type Delivery = z.infer<typeof deliverySchema>
