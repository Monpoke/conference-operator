import type { YoutubeEnvoi, YoutubeStatus, YoutubeVignette } from '@conference-operator/contract'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

export const ENVOI_LABELS: Record<YoutubeEnvoi['state'], { label: string; tone: string }> = {
  attente: { label: 'en attente', tone: 'text-dim' },
  'en-cours': { label: 'envoi en cours', tone: 'text-brand' },
  termine: { label: 'sur YouTube', tone: 'text-ok' },
  echoue: { label: 'en échec', tone: 'text-alert' },
}

/** How far a send has gone, bounded: `null` before its size is known. */
export function envoiPourcent(envoi: Pick<YoutubeEnvoi, 'octets' | 'taille'>): number | null {
  if (envoi.taille == null || envoi.taille === 0) return null
  return Math.min(100, Math.round((envoi.octets / envoi.taille) * 100))
}

export const VIGNETTE_LABELS: Record<YoutubeVignette['state'], { label: string; tone: string }> = {
  attente: { label: 'à dessiner', tone: 'text-dim' },
  calcul: { label: 'en cours de dessin', tone: 'text-brand' },
  prete: { label: 'prête, pas envoyée', tone: 'text-warn' },
  envoi: { label: 'envoi…', tone: 'text-brand' },
  envoyee: { label: 'sur YouTube', tone: 'text-ok' },
  echec: { label: 'en échec', tone: 'text-alert' },
}

/** Among the chosen videos, which can take each grouped action. */
export function actionsPossibles(
  jobIds: readonly string[],
  envois: readonly Pick<YoutubeEnvoi, 'jobId' | 'state' | 'visibilite'>[],
  vignettes: readonly Pick<YoutubeVignette, 'cle' | 'state'>[],
) {
  const envoiOf = (id: string) => envois.find((envoi) => envoi.jobId === id)
  const vignetteOf = (id: string) => vignettes.find((vignette) => vignette.cle === id)
  const sent = jobIds.filter((id) => envoiOf(id)?.state === 'termine')
  return {
    envoyer: jobIds.filter((id) => !['attente', 'en-cours', 'termine'].includes(envoiOf(id)?.state ?? '')),
    publier: sent.filter((id) => envoiOf(id)?.visibilite !== 'public'),
    depublier: sent.filter((id) => envoiOf(id)?.visibilite === 'public'),
    titres: sent,
    generer: sent.filter((id) => !['attente', 'calcul', 'envoi'].includes(vignetteOf(id)?.state ?? '')),
    envoyerVignettes: jobIds.filter((id) => vignetteOf(id)?.state === 'prete'),
  }
}

export const useYoutubeStore = defineStore('youtube', () => {
  const session = useSessionStore()
  const status = ref<YoutubeStatus | null>(null)
  const envois = ref<YoutubeEnvoi[]>([])
  const vignettes = ref<YoutubeVignette[]>([])

  async function load(): Promise<void> {
    const [nextStatus, nextEnvois, nextVignettes] = await Promise.all([session.client.rpc.youtube.status(), session.client.rpc.youtube.envois(), session.client.rpc.youtube.vignettes()])
    status.value = nextStatus
    envois.value = nextEnvois
    vignettes.value = nextVignettes
  }
  async function setClient(clientId: string, clientSecret: string): Promise<void> {
    status.value = await session.client.rpc.youtube.setClient({ clientId, clientSecret })
  }
  async function connect(): Promise<void> {
    const { url } = await session.client.rpc.youtube.connect()
    window.location.assign(url)
  }
  async function disconnect(): Promise<void> {
    status.value = await session.client.rpc.youtube.disconnect()
  }
  async function send(jobIds: string[] | null): Promise<void> {
    envois.value = await session.client.rpc.youtube.envoyer({ jobIds })
  }

  /** The gestures under way, `jobId:gesture`: the hub answers them in seconds, with nothing to poll. */
  const pending = ref<ReadonlySet<string>>(new Set())
  async function tracked<T>(key: string, work: () => Promise<T>): Promise<T> {
    pending.value = new Set([...pending.value, key])
    try {
      return await work()
    } finally {
      const next = new Set(pending.value)
      next.delete(key)
      pending.value = next
    }
  }
  async function setVisibilite(jobId: string, publique: boolean): Promise<void> {
    envois.value = await tracked(`${jobId}:visibilite`, () => session.client.rpc.youtube.visibilite({ jobId, publique }))
  }

  async function genererVignettes(cles: string[] | null): Promise<void> {
    vignettes.value = await session.client.rpc.youtube.genererVignettes({ cles })
  }
  async function envoyerVignettes(cles: string[] | null = null): Promise<void> {
    vignettes.value = await session.client.rpc.youtube.envoyerVignettes({ cles })
  }
  async function syncMetadata(jobId: string): Promise<void> {
    await tracked(`${jobId}:titre`, () => session.client.rpc.youtube.synchroniser({ jobId }))
  }
  async function syncPlaylist(title: string, publique: boolean): Promise<void> {
    status.value = await session.client.rpc.youtube.playlist({ title, publique })
  }

  return { pending, status, envois, vignettes, genererVignettes, envoyerVignettes, load, setClient, connect, disconnect, send, setVisibilite, syncMetadata, syncPlaylist }
})
