import { and, desc, eq, isNull, lt } from 'drizzle-orm'
import {
  AUDIT_RETENTION_DAYS,
  auditQuerySchema,
  type AuditEntry,
  type AuditQuery,
} from '@conference-operator/contract'
import { auditLog } from '@conference-operator/db/hub'
import type { HubDatabase } from '../db.js'

/** What an operator did, as the router hands it over. */
export interface AuditRecord {
  actor: string
  action: string
  roomId: string | null
  /** The request as received: `describe` masks and cuts it before it is stored. */
  input: unknown
  ok: boolean
  error?: string | null
  commandSeq?: number | null
}

/**
 * Keys whose value never reaches the log: a stream key read back in the console
 * is a stream key given to whoever can read the log.
 */
const SECRET = /pass(word)?|secret|token|streamkey|apikey|privatekey|authorization|cookie|signature/i
/** Past this, a string is summed up: an imported program or an image is not read in a log. */
const LONG_STRING = 200
const MAX_ITEMS = 20
const MAX_DETAIL = 2_000

/**
 * The request, as it will be read in the log.
 *
 * Secrets masked, long strings and lists cut, the whole bounded. A webhook
 * address keeps its host only: its path is the credential.
 */
export function describe(action: string, input: unknown): string | null {
  if (input === undefined || input === null) return null
  const tidy = (value: unknown, key: string, depth: number): unknown => {
    if (SECRET.test(key)) return value == null ? value : '•••'
    if (typeof value === 'string') {
      if (key === 'url' && action.startsWith('integrations.')) {
        try { return `${new URL(value).origin}/…` } catch { return '•••' }
      }
      return value.length > LONG_STRING ? `${value.slice(0, 80)}… (${value.length} caractères)` : value
    }
    if (depth > 4 || value == null || typeof value !== 'object') return value
    if (Array.isArray(value)) {
      const kept = value.slice(0, MAX_ITEMS).map((item) => tidy(item, key, depth + 1))
      return value.length > MAX_ITEMS ? [...kept, `… ${value.length - MAX_ITEMS} de plus`] : kept
    }
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, tidy(v, k, depth + 1)]))
  }
  const json = JSON.stringify(tidy(input, '', 0))
  if (json === undefined || json === '{}') return null
  return json.length > MAX_DETAIL ? `${json.slice(0, MAX_DETAIL)}…` : json
}

/**
 * The audit log.
 *
 * Written by the router for every operator write, completed by the ingest when a
 * room reports what became of a command it was sent. Never in the way: an entry
 * that cannot be written costs the log a line, not the operator their gesture.
 */
export class AuditService {
  constructor(
    private readonly db: HubDatabase,
    /** The hub's clock: the entries are dated like everything else it decides. */
    private readonly now: () => number = Date.now,
  ) {}

  record(entry: AuditRecord): void {
    this.db
      .insert(auditLog)
      .values({
        at: new Date(this.now()).toISOString(),
        actor: entry.actor,
        action: entry.action,
        roomId: entry.roomId,
        detail: describe(entry.action, entry.input),
        ok: entry.ok,
        error: entry.error?.slice(0, 500) ?? null,
        commandSeq: entry.commandSeq ?? null,
      })
      .run()
  }

  /** The room's word on a command: completes the entry that sent it, once. */
  outcome(roomId: string, seq: number, ok: boolean, message: string | null): void {
    this.db
      .update(auditLog)
      .set({ outcomeOk: ok, outcomeMessage: message, outcomeAt: new Date(this.now()).toISOString() })
      .where(and(eq(auditLog.commandSeq, seq), eq(auditLog.roomId, roomId), isNull(auditLog.outcomeAt)))
      .run()
  }

  list(query: AuditQuery = {}): AuditEntry[] {
    const q = auditQuerySchema.parse(query)
    const filters = [
      q.roomId == null ? undefined : eq(auditLog.roomId, q.roomId),
      q.actor == null ? undefined : eq(auditLog.actor, q.actor),
      q.beforeId == null ? undefined : lt(auditLog.id, q.beforeId),
    ].filter((filter) => filter != null)
    return this.db
      .select()
      .from(auditLog)
      .where(filters.length === 0 ? undefined : and(...filters))
      .orderBy(desc(auditLog.id))
      .limit(q.limit)
      .all()
      .map((row) => ({
        id: row.id,
        at: row.at,
        actor: row.actor,
        action: row.action,
        roomId: row.roomId,
        detail: row.detail,
        ok: row.ok,
        error: row.error,
        commandSeq: row.commandSeq,
        outcome:
          row.outcomeAt == null
            ? null
            : { ok: row.outcomeOk === true, message: row.outcomeMessage, at: row.outcomeAt },
      }))
  }

  /** Forgets what is older than the retention. Returns how many entries went. */
  purge(): number {
    const cutoff = new Date(this.now() - AUDIT_RETENTION_DAYS * 24 * 3_600_000).toISOString()
    return this.db.delete(auditLog).where(lt(auditLog.at, cutoff)).run().changes
  }
}
