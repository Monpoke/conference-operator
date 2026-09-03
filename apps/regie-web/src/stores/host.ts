import type { HostLoad } from '@cloudnord/contract'
import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Un relevé toutes les cinq secondes, et pas un champ de plus dans le flux.
 *
 * La mesure est déjà une moyenne sur son intervalle : interroger plus souvent
 * ne dirait rien de plus. Surtout, une salle dont la régie est fermée continue
 * ainsi de n'émettre aucun trafic — c'est le seul trafic d'une salle au repos
 * qu'on ait accepté d'ajouter, et il s'arrête avec la fenêtre.
 */
export const POLL_MS = 5000

/**
 * Charge du poste, relevée hors du flux d'état.
 *
 * `null` couvre deux cas que la vue distingue : le serveur local n'a pas
 * répondu, ou il a répondu sans mesure — la première fenêtre n'est pas encore
 * écoulée. Les confondre ferait passer un poste qui vient de démarrer pour un
 * poste qui ne répond plus.
 */
export const useHostStore = defineStore('host', () => {
  const load = ref<HostLoad | null>(null)

  let timer: ReturnType<typeof setInterval> | null = null

  async function refresh(): Promise<void> {
    try {
      const response = await fetch('/control/host')
      if (!response.ok) throw new Error('relevé indisponible')
      load.value = (await response.json()) as HostLoad
    } catch {
      load.value = null
    }
  }

  function start(): void {
    if (timer != null) return
    void refresh()
    timer = setInterval(() => void refresh(), POLL_MS)
  }

  function stop(): void {
    if (timer == null) return
    clearInterval(timer)
    timer = null
  }

  return { load, refresh, start, stop }
})
