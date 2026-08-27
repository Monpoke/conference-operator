import { duration } from '@cloudnord/format'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useNotificationsStore } from './notifications.js'
import { useSessionStore } from './session.js'

/**
 * Le tableau de bord : où en est chaque salle, et ce qui vaut pour toutes.
 *
 * C'est la vue sur laquelle la console est laissée ouverte toute la journée,
 * et la seule qui *observe* — elle alimente les alertes en comparant chaque
 * tour au précédent.
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

/** Le créneau commun, quand il y en a un. */
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
    const [statuts, pause] = await Promise.all([
      session.client.rpc.rooms.statuses(),
      session.client.rpc.program.globalBreak(),
    ])
    rooms.value = statuts as RoomStatus[]
    globalBreak.value = pause as GlobalBreak | null
    // Observer après avoir posé l'état : une alerte compare le tour précédent
    // au tour courant, et c'est le seul endroit qui connaît les deux.
    notifications.observeRooms(rooms.value)
  }

  return { rooms, globalBreak, load }
})

/**
 * Ce qu'il reste au créneau d'une salle, prêt à afficher.
 *
 * Arrondi à la minute : sur un écran de supervision rafraîchi toutes les dix
 * secondes, la seconde serait fausse aussitôt affichée — et ce n'est pas ici
 * qu'on tient la fin d'un talk, c'est en régie.
 *
 * Le dépassement est la raison d'être de cet affichage : c'est lui qui décale
 * le reste de la journée, donc il se distingue du reste.
 */
export function slotRemaining(ms: number | null | undefined): { texte: string; depasse: boolean } | null {
  if (ms == null) return null
  const minutes = Math.round(ms / 60000)
  if (minutes < 0) return { texte: `dépassement de ${duration(-minutes)}`, depasse: true }
  return { texte: `${duration(minutes)} restantes`, depasse: false }
}
