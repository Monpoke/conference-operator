import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useSessionStore } from './session.js'

/**
 * Bringing the takes home.
 *
 * To be looked at **before dismantling a room**: it is the last moment its disk is
 * still plugged in. Footage that is not here is nowhere else but in Lille.
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
    const [rows, roomList] = await Promise.all([
      session.client.rpc.vod.uploads({ roomId: room.value === '' ? null : room.value }),
      session.client.rpc.rooms.list(),
    ])
    uploads.value = rows as Upload[]
    rooms.value = roomList as Room[]
  }

  /**
   * Requests a repatriation.
   *
   * A null `file` means the whole room. The request targets **one** machine: with
   * no room there is nobody to talk to, and it is the view that says so rather than
   * leave a button with no effect.
   */
  async function request(roomId: string, file: string | null): Promise<void> {
    await session.client.rpc.vod.request({ roomId, file })
    await load()
  }

  return { uploads, rooms, room, load, request }
})

/** What an upload state says, and in what colour. */
export const UPLOAD_STATES: Record<string, { label: string; tone: string }> = {
  'en-cours': { label: 'en cours', tone: '' },
  termine: { label: 'terminé', tone: 'text-dim' },
  abandonne: { label: 'abandonné', tone: 'text-warn' },
  echoue: { label: 'en échec', tone: 'text-alert' },
}

/** Progress as a percentage, bounded: a file that grows in transit would exceed it. */
export function progress(upload: Upload): number {
  if (upload.sizeBytes <= 0) return 0
  return Math.min(100, Math.round((upload.bytesSent / upload.sizeBytes) * 100))
}
