import type { Session } from '@cloudnord/program'
import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * The other rooms' programs, read back from the local cache.
 *
 * Taken from the program the machine cached, not from the room states the hub
 * reports: the header strip must go on saying "the other room finishes in 3 min"
 * during an outage, since it is the program that determines it, not the network.
 *
 * Reloaded only when the program's fingerprint changes. The control app receives
 * a state every few seconds; re-reading a dozen programs each time would cost as
 * many requests for an identical answer.
 */
export const useProgramsStore = defineStore('programs', () => {
  /** The event's rooms, as the program names them. */
  const rooms = ref<{ id: string; name: string }[]>([])
  const sessions = ref<Record<string, Session[]>>({})

  /** Fingerprint of the program already loaded. `null` while nothing has been. */
  const loaded = ref<string | null>(null)

  async function fetchSessions(roomId?: string): Promise<Record<string, unknown>> {
    const query = roomId == null ? '' : `?salle=${encodeURIComponent(roomId)}`
    const response = await fetch(`/display/sessions${query}`)
    return (await response.json()) as Record<string, unknown>
  }

  /** A specific room's program, loaded on demand. */
  async function loadRoom(roomId: string): Promise<void> {
    try {
      const body = await fetchSessions(roomId)
      sessions.value = { ...sessions.value, [roomId]: (body.sessions as Session[]) ?? [] }
    } catch {
      // With no program the strip will say "programme inconnu" rather than lie.
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
