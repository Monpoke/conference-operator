/**
 * A failure of the room, as the hub is told about it.
 *
 * A file retried every ten minutes must not fill the hub's log: the same failure
 * goes up once per quarter of an hour, and a different one at once.
 */
export const INCIDENT_REPEAT_MS = 15 * 60_000

export interface RoomIncidentReport {
  type: 'room.incident'
  niveau: 'warn' | 'error'
  source: string
  message: string
  fichier: string | null
  detail: string | null
}

export function incidentReporter(source: string, now: () => number = Date.now) {
  const lastSent = new Map<string, number>()
  return (level: 'info' | 'warn' | 'error', message: string, context?: unknown): RoomIncidentReport | null => {
    if (level === 'info') return null
    const fields = (context ?? {}) as { file?: unknown; error?: unknown }
    const fichier = typeof fields.file === 'string' ? fields.file.slice(0, 400) : null
    const detail = typeof fields.error === 'string' ? fields.error.slice(0, 500) : null
    const key = `${message}|${fichier ?? ''}|${detail ?? ''}`
    const at = now()
    if (at - (lastSent.get(key) ?? Number.NEGATIVE_INFINITY) < INCIDENT_REPEAT_MS) return null
    lastSent.set(key, at)
    return { type: 'room.incident', niveau: level, source, message: message.slice(0, 300), fichier, detail }
  }
}
