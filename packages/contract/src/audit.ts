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
  /**
   * Searched, as typed, in who, the procedure, the request, the refusal and the
   * room. `''`: no search.
   */
  q: z.string().trim().max(100).default(''),
  /**
   * What the search also matches, as the console names it: the procedures whose
   * label reads like `q` (« démarrée » → `sessions.start`), the rooms whose name
   * does (« Track #1 » → its id). The words are the console's, so it sends them.
   */
  actions: z.array(z.string().min(1).max(80)).max(200).default([]),
  rooms: z.array(z.string().min(1).max(200)).max(200).default([]),
  /** The page before this entry: the list reads newest first. */
  beforeId: z.number().int().positive().nullable().default(null),
  limit: z.number().int().min(1).max(1000).default(200),
})
export type AuditQuery = z.input<typeof auditQuerySchema>

/** One numbered page of the log, for reading; the export keeps walking `beforeId`. */
export const auditPageQuerySchema = auditQuerySchema.omit({ beforeId: true, limit: true }).extend({
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(10).max(200).default(50),
})
export type AuditPageQuery = z.input<typeof auditPageQuerySchema>

export const auditPageSchema = z.object({
  items: z.array(auditEntrySchema),
  /** Matching the filters and the search. */
  total: z.number().int().nonnegative(),
  /** The page served: the last one when a later page was asked for. */
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
})
export type AuditPage = z.infer<typeof auditPageSchema>
