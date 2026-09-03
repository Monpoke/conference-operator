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
} from './primitives.js'

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
  z.object({
    type: z.literal('incident'),
    level: z.enum(['warn', 'error']),
    message: z.string(),
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
  }),
  z.object({
    type: z.literal('stream.telemetry'),
    bitrateKbps: z.number().nonnegative(),
    skippedFrames: z.number().int().nonnegative(),
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
  'stream.started': 'required',
  'stream.stopped': 'required',
  'obs.connection': 'required',
  'room.message': 'required',
  incident: 'required',
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
