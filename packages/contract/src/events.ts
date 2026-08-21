import { z } from 'zod'
import {
  deliverySchema,
  isoDateTimeSchema,
  obsInstanceSchema,
  roomIdSchema,
  sceneRoleSchema,
  sessionIdSchema,
  ulidSchema,
  connectivitySchema,
} from './primitives.js'

/**
 * Événements montants (outbox salle → hub).
 *
 * Union discriminée sur `type` : ajouter un événement sans mettre le hub à jour
 * fait échouer le typecheck des deux côtés, ce qui est exactement le but.
 */

export const roomEventPayloadSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('scene.changed'),
    obs: obsInstanceSchema,
    role: sceneRoleSchema.nullable(),
    /** Nom OBS réel, utile au diagnostic quand le mapping de rôles est faux. */
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
    /** Chemin renvoyé par OBS (`RecordStateChanged`), après renommage éventuel. */
    outputPath: z.string().nullable(),
    durationMs: z.number().int().nonnegative(),
    sidecarWritten: z.boolean(),
  }),
  z.object({
    type: z.literal('talk.marker'),
    sessionId: sessionIdSchema.nullable(),
    label: z.string(),
    /** Décalage depuis le début de l'enregistrement — ce qui sert au montage. */
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
    /** Rôles déclarés dans la config mais absents d'OBS : à voir en rouge en régie. */
    unresolvedRoles: z.array(sceneRoleSchema).default([]),
  }),
  z.object({
    /**
     * Message d'une salle vers la console.
     *
     * Passe par l'outbox, donc `required` : un appel à l'aide envoyé pendant
     * une coupure réseau doit arriver, même en retard. C'est exactement le
     * moment où on en a le plus besoin.
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
  // ── best-effort à partir d'ici ──
  z.object({
    type: z.literal('room.heartbeat'),
    connectivity: connectivitySchema,
    sceneRole: sceneRoleSchema.nullable(),
    recording: z.boolean(),
    streaming: z.boolean(),
    /** Profondeur de l'outbox : c'est l'indicateur à surveiller dans l'admin. */
    outboxDepth: z.number().int().nonnegative(),
    programContentHash: z.string().nullable(),
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
 * Enveloppe de transport. `id` + `roomId` forment la clé d'idempotence côté hub :
 * un rejeu de batch après reconnexion ne doit jamais dupliquer une ligne.
 */
export const envelopeSchema = z.object({
  id: ulidSchema,
  roomId: roomIdSchema,
  /** Monotone par salle, persisté : donne l'ordre d'application côté hub. */
  seq: z.number().int().nonnegative(),
  /** Horloge locale corrigée de l'offset serveur. */
  occurredAt: isoDateTimeSchema,
  /** Base monotone : reste juste même si l'horloge système saute. */
  monotonicMs: z.number().nonnegative(),
  delivery: deliverySchema,
  /** Collapse dans la file : seule la dernière occurrence non envoyée survit. */
  dedupKey: z.string().optional(),
  expiresAt: isoDateTimeSchema.optional(),
  payload: roomEventPayloadSchema,
})
export type Envelope = z.infer<typeof envelopeSchema>

/**
 * Politique par type d'événement, définie une fois ici pour que le client n'ait
 * pas à la redécider à chaque `enqueue`.
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

/** Motifs de rejet définitif : l'événement sort de la file au lieu de la bloquer. */
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
