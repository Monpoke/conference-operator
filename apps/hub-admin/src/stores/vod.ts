import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * Rapatriement des captations.
 *
 * À regarder **avant de démonter une salle** : c'est le dernier moment où son
 * disque est encore branché. Un rush qui n'est pas ici n'est nulle part
 * ailleurs qu'à Lille.
 */
export interface Upload {
  roomId: string
  roomName?: string | null
  file: string
  state: string
  sizeBytes: number
  bytesSent: number
  debitOctetsS?: number | null
  lastError?: string | null
}

export interface Room {
  id: string
  name: string
}

export const useVodStore = defineStore('vod', () => {
  const uploads = ref<Upload[]>([])
  const rooms = ref<Room[]>([])
  const room = ref<string>('')

  const session = useSessionStore()

  async function load(): Promise<void> {
    const [lignes, salles] = await Promise.all([
      session.client.rpc.vod.uploads({ roomId: room.value === '' ? null : room.value }),
      session.client.rpc.rooms.list(),
    ])
    uploads.value = lignes as Upload[]
    rooms.value = salles as Room[]
  }

  /**
   * Demande un rapatriement.
   *
   * `file` nul = toute la salle. La demande vise **une** machine : sans salle,
   * il n'y a personne à qui parler, et c'est la vue qui le dit plutôt que de
   * laisser un bouton sans effet.
   */
  async function request(roomId: string, file: string | null): Promise<void> {
    await session.client.rpc.vod.request({ roomId, file })
    await load()
  }

  return { uploads, rooms, room, load, request }
})

/** Ce que dit un état de téléversement, et de quelle couleur. */
export const UPLOAD_STATES: Record<string, { label: string; tone: string }> = {
  'en-cours': { label: 'en cours', tone: '' },
  termine: { label: 'terminé', tone: 'text-attenue' },
  abandonne: { label: 'abandonné', tone: 'text-attention' },
  echoue: { label: 'en échec', tone: 'text-alerte' },
}

/** Avancement en percent, borné : un fichier qui grossit en route dépasserait. */
export function progress(upload: Upload): number {
  if (upload.sizeBytes <= 0) return 0
  return Math.min(100, Math.round((upload.bytesSent / upload.sizeBytes) * 100))
}
