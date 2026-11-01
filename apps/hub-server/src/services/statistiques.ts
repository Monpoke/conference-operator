import type { RoomIncident, StatistiqueTalk, Statistiques } from '@conference-operator/contract'
import { auditLog, ingestEvent, montageJob, question, sessionConsent, sessionState, vodUpload } from '@conference-operator/db/hub'
import { desc, eq } from 'drizzle-orm'
import type { HubDatabase } from '../db.js'

/**
 * The edition's figures, from what the hub already keeps.
 *
 * Composed from plain rows so that the rules can be read and tested apart from
 * the base. Nothing is estimated: what was not measured stays `null`, and the page
 * says how many talks an average leaves out.
 */
export interface StatSources {
  sessions: {
    id: string
    title: string
    kind: string
    roomId?: string | null
    startsAt: string
    endsAt?: string | null
  }[]
  roomName: (roomId: string) => string | null
  sallesSansCaptation: readonly string[]
  states: { sessionId: string; startedAt: string | null; endedAt: string | null; decidedBy: string | null }[]
  uploads: { sessionId: string | null; kind: string; state: string; sizeBytes: number }[]
  jobs: { sessionId: string; state: string; createdAt: string; durationMs: number | null; analyseJson: string | null }[]
  consents: { sessionId: string; statut: string }[]
  /** The rooms' audio alerts, as they were reported. */
  alerts: { roomId: string; kind: string; since: string }[]
  sponsorTiers: { name: string; sponsors: unknown[] }[]
  audit: { actions: number; refusees: number }
  questions: number
  timezone: string
}

interface AnalysedAudio {
  confiance?: string
  audio?: { lufsAvant?: number; truePeak?: number; lra?: number } | null
}

function rushOf(files: StatSources['uploads'], sansCaptation: boolean): StatistiqueTalk['rush'] {
  const rushes = files.filter((file) => file.kind === 'rush')
  if (rushes.some((file) => file.state === 'termine')) return 'rentre'
  if (rushes.some((file) => file.state === 'en-cours' || file.state === 'attente')) return 'en-cours'
  if (rushes.length > 0) return 'echec'
  return sansCaptation ? 'sans-objet' : 'manquant'
}

export function composeStatistiques(sources: StatSources): Statistiques {
  const talks = sources.sessions
    .filter((session) => session.kind !== 'break')
    .map((session): StatistiqueTalk => {
      const state = sources.states.find((candidate) => candidate.sessionId === session.id)
      const auto = state?.decidedBy === 'auto'
      const startedAt = state?.startedAt ?? null
      const endedAt = state?.endedAt ?? null
      const sansCaptation = session.roomId != null && sources.sallesSansCaptation.includes(session.roomId)
      const files = sources.uploads.filter((file) => file.sessionId === session.id)
      const jobs = sources.jobs
        .filter((job) => job.sessionId === session.id && job.state !== 'annule')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      const analysed = [...jobs].reverse().find((job) => job.analyseJson != null)
      const analyse = analysed == null ? null : (JSON.parse(analysed.analyseJson!) as AnalysedAudio)
      const inSlot = (at: string) =>
        startedAt != null && at >= startedAt && (endedAt == null || at <= endedAt)
      const alerts = (kind: string) =>
        new Set(
          sources.alerts
            .filter((alert) => alert.roomId === session.roomId && alert.kind === kind && inSlot(alert.since))
            .map((alert) => alert.since),
        ).size
      return {
        sessionId: session.id,
        title: session.title,
        roomId: session.roomId ?? null,
        roomName: session.roomId == null ? null : sources.roomName(session.roomId),
        startsAt: session.startsAt,
        endsAt: session.endsAt ?? null,
        retardMs: startedAt == null || auto ? null : Date.parse(startedAt) - Date.parse(session.startsAt),
        depassementMs: endedAt == null || session.endsAt == null || auto ? null : Date.parse(endedAt) - Date.parse(session.endsAt),
        auto,
        tenue: startedAt != null,
        sansCaptation,
        rush: rushOf(files, sansCaptation),
        rushOctets: files.filter((file) => file.kind === 'rush' && file.state === 'termine').reduce((sum, file) => sum + file.sizeBytes, 0),
        lufs: analyse?.audio?.lufsAvant ?? null,
        truePeak: analyse?.audio?.truePeak ?? null,
        lra: analyse?.audio?.lra ?? null,
        confiance: analyse?.confiance ?? null,
        alertesSaturation: alerts('saturation'),
        alertesSilence: alerts('silence'),
        montages: jobs.map((job) => job.state),
        videoMs: jobs.filter((job) => job.state === 'termine').reduce((sum, job) => sum + (job.durationMs ?? 0), 0),
        consentement: sources.consents.find((consent) => consent.sessionId === session.id)?.statut ?? null,
      }
    })
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt))

  return {
    talks,
    sponsors: {
      total: sources.sponsorTiers.reduce((sum, tier) => sum + tier.sponsors.length, 0),
      paliers: sources.sponsorTiers.map((tier) => ({ nom: tier.name, nombre: tier.sponsors.length })),
    },
    exploitation: sources.audit,
    questions: sources.questions,
    timezone: sources.timezone,
  }
}

/** Reads the rows `composeStatistiques` works from. */
export class StatistiquesService {
  constructor(private readonly db: HubDatabase) {}

  bilan(context: Pick<StatSources, 'sessions' | 'roomName' | 'sallesSansCaptation' | 'sponsorTiers' | 'timezone'>): Statistiques {
    const audit = this.db.select({ ok: auditLog.ok }).from(auditLog).all()
    const alerts: StatSources['alerts'] = []
    for (const row of this.db.select({ roomId: ingestEvent.roomId, payload: ingestEvent.payloadJson }).from(ingestEvent).where(eq(ingestEvent.type, 'audio.alerts')).all()) {
      const { alerts: reported = [] } = JSON.parse(row.payload) as { alerts?: { kind: string; since: string }[] }
      for (const alert of reported) alerts.push({ roomId: row.roomId, kind: alert.kind, since: alert.since })
    }
    return composeStatistiques({
      ...context,
      states: this.db.select().from(sessionState).all(),
      uploads: this.db.select({ sessionId: vodUpload.sessionId, kind: vodUpload.kind, state: vodUpload.state, sizeBytes: vodUpload.sizeBytes }).from(vodUpload).all(),
      jobs: this.db.select({ sessionId: montageJob.sessionId, state: montageJob.state, createdAt: montageJob.createdAt, durationMs: montageJob.durationMs, analyseJson: montageJob.analyseJson }).from(montageJob).all(),
      consents: this.db.select({ sessionId: sessionConsent.sessionId, statut: sessionConsent.statut }).from(sessionConsent).all(),
      alerts,
      audit: { actions: audit.length, refusees: audit.filter((entry) => !entry.ok).length },
      questions: this.db.select({ id: question.id }).from(question).all().length,
    })
  }
}

/** How far back the console reads the rooms' incidents. */
const INCIDENTS_SHOWN = 200

export class IncidentsService {
  constructor(private readonly db: HubDatabase) {}

  list(): RoomIncident[] {
    return this.db
      .select({ roomId: ingestEvent.roomId, occurredAt: ingestEvent.occurredAt, payload: ingestEvent.payloadJson })
      .from(ingestEvent)
      .where(eq(ingestEvent.type, 'room.incident'))
      .orderBy(desc(ingestEvent.occurredAt))
      .limit(INCIDENTS_SHOWN)
      .all()
      .map((row) => {
        const event = JSON.parse(row.payload) as Omit<RoomIncident, 'roomId' | 'occurredAt'>
        return {
          roomId: row.roomId,
          occurredAt: row.occurredAt,
          niveau: event.niveau,
          source: event.source,
          message: event.message,
          fichier: event.fichier ?? null,
          detail: event.detail ?? null,
        }
      })
  }
}
