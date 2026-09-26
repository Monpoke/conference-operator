import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { MontageJobView, MontageWorkerView } from '@conference-operator/contract'
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

  return { jobs, workers, load, forSession, relaunch, cancel, download, createWorker, revokeWorker }
})

/** What a job's state says, and in what colour. */
export const MONTAGE_STATES: Record<string, { label: string; tone: string }> = {
  attente: { label: 'en attente', tone: 'text-dim' },
  'en-cours': { label: 'en cours', tone: 'text-brand' },
  termine: { label: 'monté', tone: 'text-ok' },
  echoue: { label: 'en échec', tone: 'text-alert' },
  annule: { label: 'annulé', tone: 'text-dim' },
}

export const MONTAGE_ETAPES: Record<string, string> = {
  telechargement: 'téléchargement',
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
  if (job.state === 'termine') {
    const missing = job.marquesManquantes.length > 0 ? ` · sans marque ${job.marquesManquantes.join(' ni ')}` : ''
    return `${minutes(job.durationMs)}${missing}`
  }
  return ''
}
