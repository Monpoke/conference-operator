import { z } from 'zod'
import {
  deliverySchema,
  displayModeSchema,
  isoDateTimeSchema,
  obsInstanceSchema,
  roomIdSchema,
  sceneRoleSchema,
  sessionIdSchema,
  ulidSchema,
  connectivitySchema,
  audioInputSchema,
} from './primitives.js'
import { vodConsentSchema } from './vod.js'

/**
 * Upstream events (room outbox → hub).
 *
 * Discriminated union on `type`: adding an event without updating the hub fails
 * the typecheck on both sides, which is exactly the point.
 */

export const roomEventPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('scene.changed'),
    obs: obsInstanceSchema,
    role: sceneRoleSchema.nullable(),
    /** Real OBS name, useful for diagnosis when the role mapping is wrong. */
    sceneName: z.string(),
  }),
  z.object({
    type: z.literal('recording.started'),
    obs: obsInstanceSchema,
    sessionId: sessionIdSchema.nullable(),
  }),
  z.object({
    type: z.literal('recording.stopped'),
    obs: obsInstanceSchema,
    sessionId: sessionIdSchema.nullable(),
    /** Path returned by OBS (`RecordStateChanged`), after any renaming. */
    outputPath: z.string().nullable(),
    durationMs: z.number().int().nonnegative(),
    sidecarWritten: z.boolean(),
  }),
  /**
   * The YouTube consent decided in the room, for one talk.
   *
   * It goes up as an **event** and not as a procedure call, for the reason the
   * outbox exists: the answer is obtained in front of the speaker, at the end of
   * their talk, on a machine whose network is the event's. A call would fail there
   * and the answer would be lost — and it is the one thing here that cannot be
   * reconstructed afterwards from the disk, since only the person who asked heard
   * it. `required`, therefore: it arrives, late if need be.
   *
   * A null `consentement` withdraws the decision and puts the talk back to
   * "unanswered". It is a real gesture and not a technicality: an operator who
   * marks the wrong row must be able to take it back, rather than leave standing a
   * consent nobody gave.
   */
  z.object({
    type: z.literal('vod.consent'),
    sessionId: sessionIdSchema,
    consentement: vodConsentSchema.nullable(),
    /** On the room's corrected clock: it dates the answer, not its arrival. */
    decideA: isoDateTimeSchema,
  }),
  /**
   * No longer emitted, still accepted.
   *
   * The markers live in the sidecar, which is what the editing reads; the hub never
   * read these. A room installed before this version may still hold some in its
   * queue: refusing them would print "événement rejeté par le hub" in its control
   * app's log, in the middle of a talk, for nothing. The hub stores and ignores
   * them. To be removed once every room runs a version that no longer sends them.
   */
  z.object({
    type: z.literal('talk.marker'),
    sessionId: sessionIdSchema.nullable(),
    label: z.string(),
    /** Offset from the start of the recording — what editing works from. */
    offsetMs: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('stream.started'),
    obs: obsInstanceSchema,
    sessionId: sessionIdSchema.nullable(),
  }),
  z.object({
    type: z.literal('stream.stopped'),
    obs: obsInstanceSchema,
    reason: z.enum(['operator', 'obs-error', 'shutdown']),
  }),
  z.object({
    type: z.literal('obs.connection'),
    obs: obsInstanceSchema,
    connected: z.boolean(),
    /** Roles declared in the config but missing from OBS: shown red in the control app. */
    unresolvedRoles: z.array(sceneRoleSchema).default([]),
  }),
  z.object({
    /**
     * Message from a room to the console.
     *
     * Goes through the outbox, so `required`: a call for help sent during a
     * network outage must arrive, even late. That is exactly the moment it is
     * needed most.
     */
    type: z.literal('room.message'),
    text: z.string().min(1).max(500),
    level: z.enum(['info', 'warning', 'urgent']),
  }),
  // ── best-effort from here on ──
  z.object({
    type: z.literal('room.heartbeat'),
    connectivity: connectivitySchema,
    sceneRole: sceneRoleSchema.nullable(),
    recording: z.boolean(),
    streaming: z.boolean(),
    /** Outbox depth: the indicator to watch in the admin console. */
    outboxDepth: z.number().int().nonnegative(),
    programContentHash: z.string().nullable(),
    /**
     * What the room's screen is showing right now.
     *
     * Reported because it is now driven from afar: a mobile control app never
     * paints ahead, so without this field no screen button lights up and the
     * operator does not know what the audience sees.
     *
     * Optional on input: a room on an older version keeps beating without it,
     * and its screen simply reads "unknown" rather than failing its whole batch.
     */
    displayMode: displayModeSchema.nullable().default(null),
    /**
     * The audio sources and their mute state, for the mobile control app.
     *
     * Optional on input for the same reason as `displayMode`: an older room keeps
     * beating, and simply shows no source to mute.
     */
    audioInputs: z.array(audioInputSchema).max(64).default([]),
  }),
  /**
   * The stream's health, measured by the room between two samples.
   *
   * Rates, not OBS's raw counters: those are cumulative since the stream started,
   * and a "bitrate" read straight from `outputBytes` was the total sent so far.
   * No room ever sent the old shape — nothing called the measure — so it changes
   * without a compatibility concern.
   */
  z.object({
    type: z.literal('stream.telemetry'),
    bitrateKbps: z.number().nonnegative(),
    /** Share of the frames OBS skipped since the previous sample, 0–1. */
    skippedRatio: z.number().min(0).max(1),
    congestion: z.number().min(0).max(1),
  }),
])
export type RoomEventPayload = z.infer<typeof roomEventPayloadSchema>
export type RoomEventType = RoomEventPayload['type']

/**
 * Transport envelope. `id` + `roomId` form the idempotency key on the hub side:
 * replaying a batch after reconnection must never duplicate a row.
 */
export const envelopeSchema = z.object({
  id: ulidSchema,
  roomId: roomIdSchema,
  /** Monotonic per room, persisted: gives the order of application on the hub. */
  seq: z.number().int().nonnegative(),
  /** Local clock corrected by the server offset. */
  occurredAt: isoDateTimeSchema,
  /** Monotonic base: stays correct even if the system clock jumps. */
  monotonicMs: z.number().nonnegative(),
  delivery: deliverySchema,
  /** Collapses in the queue: only the last unsent occurrence survives. */
  dedupKey: z.string().optional(),
  expiresAt: isoDateTimeSchema.optional(),
  payload: roomEventPayloadSchema,
})
export type Envelope = z.infer<typeof envelopeSchema>

/**
 * Policy per event type, defined once here so the client does not have to decide
 * it again on every `enqueue`.
 */
export const DELIVERY_BY_EVENT: Record<RoomEventType, z.infer<typeof deliverySchema>> = {
  'scene.changed': 'required',
  'recording.started': 'required',
  'recording.stopped': 'required',
  'talk.marker': 'required',
  'vod.consent': 'required',
  'stream.started': 'required',
  'stream.stopped': 'required',
  'obs.connection': 'required',
  'room.message': 'required',
  'room.heartbeat': 'best-effort',
  'stream.telemetry': 'best-effort',
}

/** Final rejection reasons: the event leaves the queue instead of blocking it. */
export const rejectionReasonSchema = z.enum([
  'invalid-schema',
  'unknown-room',
  'protocol-too-old',
  'expired',
])

export const ingestResultSchema = z.object({
  acked: z.array(ulidSchema),
  duplicates: z.array(ulidSchema),
  rejected: z.array(z.object({ id: ulidSchema, reason: rejectionReasonSchema })),
  serverTime: isoDateTimeSchema,
})
