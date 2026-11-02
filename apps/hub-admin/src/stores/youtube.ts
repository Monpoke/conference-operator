import type { YoutubeEnvoi, YoutubeStatus } from '@conference-operator/contract'
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

export const useYoutubeStore = defineStore('youtube', () => {
  const session = useSessionStore()
  const status = ref<YoutubeStatus | null>(null)
  const envois = ref<YoutubeEnvoi[]>([])

  async function load(): Promise<void> {
    const [nextStatus, nextEnvois] = await Promise.all([session.client.rpc.youtube.status(), session.client.rpc.youtube.envois()])
    status.value = nextStatus
    envois.value = nextEnvois
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

  async function setVisibilite(jobId: string, publique: boolean): Promise<void> {
    envois.value = await session.client.rpc.youtube.visibilite({ jobId, publique })
  }

  return { status, envois, load, setClient, connect, disconnect, send, setVisibilite }
})
