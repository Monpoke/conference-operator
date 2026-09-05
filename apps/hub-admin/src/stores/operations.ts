import { duration } from '@conference-operator/format'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useNotificationsStore } from './notifications.js'
import { useSessionStore } from './session.js'

/**
 * The dashboard: where each room stands, and what holds for all of them.
 *
 * This is the view the console is left open on all day, and the only one that
 * *observes* — it feeds the alerts by comparing each round with the previous one.
 */
export interface RoomStatus {
  roomId: string
  name: string
  conference: string
  connectivity: string
  recording: boolean
  streaming: boolean
  sceneRole?: string | null
  outboxDepth: number
  lastSeenAt: string
  currentSession?: { title?: string; remainingMs?: number | null } | null
  breakBadge?: { state: string } | null
}

/** The shared slot, when there is one. */
export interface GlobalBreak {
  title: string
  state: string
  startsAt: string
  endsAt?: string | null
  rooms: number
  serverTime: string
}

export const useOperationsStore = defineStore('operations', () => {
  const rooms = ref<RoomStatus[]>([])
  const globalBreak = ref<GlobalBreak | null>(null)

  const session = useSessionStore()
  const notifications = useNotificationsStore()

  async function load(): Promise<void> {
    const [statuses, sharedBreak] = await Promise.all([
      session.client.rpc.rooms.statuses(),
      session.client.rpc.program.globalBreak(),
    ])
    rooms.value = statuses as RoomStatus[]
    globalBreak.value = sharedBreak as GlobalBreak | null
    // Observe after setting the state: an alert compares the previous round with
    // the current one, and this is the only place that knows both.
    notifications.observeRooms(rooms.value)
  }

  return { rooms, globalBreak, load }
})

/**
 * What is left of a room's slot, ready to display.
 *
 * Rounded to the minute: on a supervision screen refreshed every ten seconds, the
 * second would be wrong the instant it was shown — and it is not here that a
 * talk's end is held, it is in the control app.
 *
 * The overrun is this display's reason for being: it is what shifts the rest of
 * the day, so it is set apart from the rest.
 */
export function slotRemaining(ms: number | null | undefined): { text: string; overrun: boolean } | null {
  if (ms == null) return null
  const minutes = Math.round(ms / 60000)
  if (minutes < 0) return { text: `dépassement de ${duration(-minutes)}`, overrun: true }
  return { text: `${duration(minutes)} restantes`, overrun: false }
}
