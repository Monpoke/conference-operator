import { defineStore } from 'pinia'
import { ref } from 'vue'

/**
 * Le battement d'une seconde, tenu à un seul endroit.
 *
 * Cinq affichages en dépendent — l'horloge, le compte à rebours du créneau, le
 * chronomètre de prise, la péremption des signalements, la détection d'un flux
 * mort — et chacun tenait son propre `setInterval` dans la page d'origine.
 * Cinq réveils par seconde sur une machine qui encode, pour cinq lectures de la
 * même valeur.
 *
 * Un store plutôt qu'un module : un `ref` de portée module survivrait d'un
 * fichier de test au suivant, avec son intervalle, et le défaut ne se verrait
 * qu'en exécution parallèle.
 */
export const useClockStore = defineStore('clock', () => {
  /** Temps réel de la machine. Le décalage du hub s'ajoute chez qui l'affiche. */
  const real = ref(Date.now())

  let timer: ReturnType<typeof setInterval> | null = null

  function start(): void {
    if (timer != null) return
    timer = setInterval(() => {
      real.value = Date.now()
    }, 1000)
  }

  function stop(): void {
    if (timer == null) return
    clearInterval(timer)
    timer = null
  }

  /** Avance le battement à la main. Réservé aux tests, qui ne dorment pas. */
  function advance(ms: number): void {
    real.value += ms
  }

  return { real, start, stop, advance }
})
