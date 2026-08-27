import type { Session } from '@cloudnord/program'
import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Les programmes des autres salles, relus du cache local.
 *
 * Tirés du programme mis en cache par le poste, pas de l'état des salles
 * remonté par le hub : le flux d'en-tête doit continuer à dire « l'autre salle
 * finit dans 3 min » pendant une coupure, puisque c'est le programme qui le
 * détermine, pas le réseau.
 *
 * Rechargés seulement quand l'empreinte du programme change. La régie reçoit un
 * état toutes les quelques secondes ; relire une dizaine de programmes à chaque
 * fois coûterait autant de requêtes pour une réponse identique.
 */
export const useProgramsStore = defineStore('programs', () => {
  /** Salles de l'événement, telles que le programme les nomme. */
  const rooms = ref<{ id: string; name: string }[]>([])
  const sessions = ref<Record<string, Session[]>>({})

  /** Empreinte du programme déjà chargé. `null` tant que rien ne l'a été. */
  const loaded = ref<string | null>(null)

  async function fetchSessions(roomId?: string): Promise<Record<string, unknown>> {
    const query = roomId == null ? '' : `?salle=${encodeURIComponent(roomId)}`
    const response = await fetch(`/display/sessions${query}`)
    return (await response.json()) as Record<string, unknown>
  }

  /** Programme d'une salle précise, chargé à la demande. */
  async function loadRoom(roomId: string): Promise<void> {
    try {
      const body = await fetchSessions(roomId)
      sessions.value = { ...sessions.value, [roomId]: (body.sessions as Session[]) ?? [] }
    } catch {
      // Sans programme, le flux dira « programme inconnu » plutôt que de mentir.
      sessions.value = { ...sessions.value, [roomId]: [] }
    }
  }

  async function load(contentHash: string | null, ownRoomId: string | null): Promise<void> {
    const key = String(contentHash)
    if (key === loaded.value) return
    loaded.value = key

    try {
      rooms.value = ((await fetchSessions()).rooms as { id: string; name: string }[]) ?? []
    } catch {
      rooms.value = []
    }

    await Promise.all(
      rooms.value.filter((room) => room.id !== ownRoomId).map((room) => loadRoom(room.id)),
    )
  }

  return { rooms, sessions, loaded, load, loadRoom }
})
