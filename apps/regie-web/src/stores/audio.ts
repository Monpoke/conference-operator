import { PLANCHER_DB, type NiveauEntree } from '@cloudnord/contract'
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { StateStream } from './room.js'

/**
 * Maintien de crête.
 *
 * Une saturation d'un dixième de seconde doit rester lisible : sans maintien,
 * elle passe entre deux rendus et personne ne la voit jamais.
 */
export const PEAK_HOLD_MS = 1500

interface Peak {
  db: number
  until: number
}

/**
 * Niveaux audio, en flux séparé de l'état.
 *
 * Séparé pour deux raisons : la cadence — dix messages par seconde contre
 * quelques-uns par heure pour l'état — et le fait que seule la régie s'en sert.
 * Fermer la page suffit à couper l'abonnement chez OBS.
 */
export const useAudioStore = defineStore('audio', () => {
  const inputs = ref<NiveauEntree[]>([])
  /** Vrai tant qu'aucun message n'est arrivé : « en attente » n'est pas « aucune ». */
  const waiting = ref(true)

  const peaks = ref<Record<string, Peak>>({})
  let stream: StateStream | null = null

  function apply(entries: NiveauEntree[], atMs: number): void {
    waiting.value = false
    inputs.value = entries
    const held: Record<string, Peak> = {}
    for (const entry of entries) {
      const top = entry.canaux.reduce((max, canal) => Math.max(max, canal.crete), PLANCHER_DB)
      const previous = peaks.value[entry.nom]
      held[entry.nom] =
        previous == null || top >= previous.db || atMs > previous.until
          ? { db: top, until: atMs + PEAK_HOLD_MS }
          : previous
    }
    peaks.value = held
  }

  function connect(open: (url: string) => StateStream = (url) => new EventSource(url)): void {
    if (stream != null) return
    stream = open('/display/audio')
    stream.onmessage = (event) => {
      apply((JSON.parse(event.data) as { inputs: NiveauEntree[] }).inputs, Date.now())
    }
  }

  function disconnect(): void {
    stream?.close()
    stream = null
  }

  return { inputs, waiting, peaks, apply, connect, disconnect }
})
