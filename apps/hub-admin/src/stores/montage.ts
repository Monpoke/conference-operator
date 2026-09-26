import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { MontageAnalyse, MontageJobView, MontageWorkerView } from '@conference-operator/contract'
import { useSessionStore } from './session.js'

/**
 * The VODs' montage: the queue, and the workers that take from it.
 *
 * The console only watches and steers — relaunch, cancel, download. The
 * editing itself happens on the workers, wherever they are hosted.
 */
export const useMontageStore = defineStore('montage', () => {
  const jobs = ref<MontageJobView[]>([])
  const workers = ref<MontageWorkerView[]>([])
  const session = useSessionStore()

  async function load(): Promise<void> {
    const [jobList, workerList] = await Promise.all([
      session.client.rpc.montage.list({ sessionId: null }),
      session.client.rpc.montage.workers.list(),
    ])
    jobs.value = jobList
    workers.value = workerList
  }

  async function forSession(sessionId: string): Promise<MontageJobView[]> {
    return await session.client.rpc.montage.list({ sessionId })
  }

  async function relaunch(sessionId: string): Promise<MontageJobView> {
    const job = await session.client.rpc.montage.relancer({ sessionId })
    await load()
    return job
  }

  async function cancel(jobId: string): Promise<void> {
    await session.client.rpc.montage.annuler({ jobId })
    await load()
  }

  /** What the analysis proposed, with read addresses for its files (an hour). */
  async function analysis(jobId: string): Promise<{ analyse: MontageAnalyse | null; fichiers: { nom: string; url: string }[] }> {
    return await session.client.rpc.montage.analyse({ jobId })
  }

  /** The cut to edit on: the job goes to the montage. */
  async function validate(jobId: string, debutMs: number, finMs: number): Promise<MontageJobView> {
    const job = await session.client.rpc.montage.valider({ jobId, debutMs, finMs })
    await load()
    return job
  }

  /** Opens the edited video: a signed address, valid an hour. */
  async function download(jobId: string): Promise<void> {
    const { url } = await session.client.rpc.montage.telecharger({ jobId })
    window.open(url, '_blank', 'noopener')
  }

  /** Creates a worker; the token is returned once and never shown again. */
  async function createWorker(nom: string): Promise<string> {
    const created = await session.client.rpc.montage.workers.create({ nom })
    await load()
    return created.token
  }

  async function revokeWorker(id: string): Promise<void> {
    await session.client.rpc.montage.workers.revoke({ id })
    await load()
  }

  return { jobs, workers, load, forSession, relaunch, cancel, download, analysis, validate, createWorker, revokeWorker }
})

/** What a job's state says, and in what colour. */
export const MONTAGE_STATES: Record<string, { label: string; tone: string }> = {
  attente: { label: 'en attente', tone: 'text-dim' },
  'en-cours': { label: 'en cours', tone: 'text-brand' },
  'a-valider': { label: 'à valider', tone: 'text-warn' },
  termine: { label: 'monté', tone: 'text-ok' },
  echoue: { label: 'en échec', tone: 'text-alert' },
  annule: { label: 'annulé', tone: 'text-dim' },
}

export const MONTAGE_ETAPES: Record<string, string> = {
  telechargement: 'téléchargement',
  analyse: 'analyse de la coupe et du son',
  intro: 'rendu de l’intro',
  outro: 'rendu de l’outro',
  assemblage: 'assemblage',
  envoi: 'envoi',
}

/** « 42 min », or « 1 h 05 ». */
export function minutes(ms: number | null): string {
  if (ms == null) return ''
  const total = Math.round(ms / 60_000)
  return total < 60 ? `${total} min` : `${Math.floor(total / 60)} h ${String(total % 60).padStart(2, '0')}`
}

/** Where a job stands, in one line. */
export function describe(job: MontageJobView): string {
  if (job.state === 'en-cours' && job.etape != null) return `${MONTAGE_ETAPES[job.etape] ?? job.etape} · ${job.pourcent} %`
  if (job.state === 'attente' && job.pasAvant != null) return 'attend ses rushes'
  if (job.state === 'a-valider' && job.analyse != null) return `coupe proposée, confiance ${job.analyse.confiance}`
  if (job.state === 'termine') {
    const missing = job.marquesManquantes.length > 0 ? ` · sans marque ${job.marquesManquantes.join(' ni ')}` : ''
    const sound = job.audio == null
      ? ''
      : job.audio.quasiMuet ? ' · son quasi absent' : ` · son ${job.audio.lufsAvant.toFixed(1)} → ${job.audio.lufsApres} LUFS`
    return `${minutes(job.durationMs)}${missing}${sound}`
  }
  return ''
}

/** « 1:02:07,4 » — a position in the take, to the tenth of a second. */
export function timecode(ms: number): string {
  const tenths = Math.round(ms / 100)
  const s = Math.floor(tenths / 10)
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor(s / 60) % 60).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${h > 0 ? `${h}:` : ''}${mm}:${ss},${tenths % 10}`
}

/** « 1:02:07,4 », « 2:07 », « 127.4 » → ms; `null` when unreadable. */
export function parseTimecode(text: string): number | null {
  const clean = text.trim().replace(',', '.')
  if (clean === '') return null
  const parts = clean.split(':').map(Number)
  if (parts.some((part) => !Number.isFinite(part) || part < 0) || parts.length > 3) return null
  const seconds = parts.reduce((total, part) => total * 60 + part, 0)
  return Math.round(seconds * 1000)
}
