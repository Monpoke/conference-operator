import { z } from 'zod'
import { isoDateTimeSchema } from './primitives.js'

/**
 * The audit log: what operators did through the hub, and what came of it.
 *
 * One entry per write — a mobile control gesture, a setting saved, a device
 * approved, a program imported. Reads are not written down: they change nothing,
 * and they would bury the rest.
 */

/** Past this, an entry is purged. */
export const AUDIT_RETENTION_DAYS = 30

export const auditEntrySchema = z.object({
  id: z.number().int().positive(),
  at: isoDateTimeSchema,
  /** Who: the operator's email, as every decision on the hub already carries it. */
  actor: z.string(),
  /** What: the procedure called (`regie.command`, `settings.update`…), or an auth endpoint. */
  action: z.string(),
  roomId: z.string().nullable(),
  /**
   * The request, as JSON, secrets masked and long values cut: enough to read
   * what was asked, never a stream key or a password.
   */
  detail: z.string().nullable(),
  /** Accepted by the hub. `false`: refused, and `error` says why. */
  ok: z.boolean(),
  error: z.string().nullable(),
  /** The command queued for the room, when the action sent one. */
  commandSeq: z.number().int().positive().nullable(),
  /**
   * The room's word on that command, as it reported it. `null`: not reported —
   * yet, or ever, for a room cut off or on an older version.
   */
  outcome: z
    .object({ ok: z.boolean(), message: z.string().nullable(), at: isoDateTimeSchema })
    .nullable(),
})
export type AuditEntry = z.infer<typeof auditEntrySchema>

export const auditQuerySchema = z.object({
  roomId: z.string().min(1).nullable().default(null),
  actor: z.string().min(1).nullable().default(null),
  /** The page before this entry: the list reads newest first. */
  beforeId: z.number().int().positive().nullable().default(null),
  limit: z.number().int().min(1).max(1000).default(200),
})
export type AuditQuery = z.input<typeof auditQuerySchema>
