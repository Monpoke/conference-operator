import type { DisplayPayload } from '@cloudnord/contract'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { StateStream } from '../lib/porte.js'
import { useClockStore } from './clock.js'
import { usePorteStore } from './porte.js'

export type { StateStream }

/**
 * Au-delà, une coupure cesse d'être une reconnexion et devient un écran mort.
 *
 * Repris tel quel de la page d'origine : `EventSource` se reconnecte seul et ne
 * lève rien, si bien qu'un poste de salle redémarré sous une fenêtre ouverte
 * laisse cette fenêtre vivante en apparence — l'horloge tourne, le compte à
 * rebours descend — et figée en fait, sur l'état d'avant la coupure. Le délai
 * de grâce évite de crier à chaque reconnexion d'une seconde, que personne n'a
 * besoin de voir.
 *
 * Vaut pour les deux portes. À distance, c'est le sondage qui échoue : un
 * téléphone qui perd le réseau doit le dire aussi fort qu'une régie dont le
 * poste a redémarré.
 */
export const STREAM_DEAD_MS = 4000

/**
 * L'état de la salle, et le flux qui le tient à jour.
 *
 * Un seul écrivain, et c'est le point : **aucune action de régie n'écrit ici**.
 * Appuyer sur « LIVE » poste l'action et attend le delta ; la page ne se peint
 * pas d'avance. C'est ce qui garantit qu'un bouton actif à l'écran décrit OBS
 * et non ce qu'on a demandé à OBS — la distinction compte le jour où la bascule
 * échoue et où personne ne s'en rend compte.
 *
 * D'où l'état vient est l'affaire de `porte` : le flux SSE du poste de salle,
 * ou le sondage du hub. Ce store ne le sait pas, et les panneaux non plus.
 */
export const useRoomStore = defineStore('room', () => {
  const payload = ref<DisplayPayload | null>(null)

  /**
   * Depuis quand le flux est coupé, ou `null` s'il tient.
   *
   * Distinct de la connectivité affichée à côté, qui dit si la **salle** joint
   * le hub. Celle-ci dit si la **page** joint sa source — deux pannes
   * différentes, et la seconde était muette avant qu'on la nomme.
   */
  const cutSince = ref<number | null>(null)

  const clock = useClockStore()
  const porte = usePorteStore()

  /** Heure de la salle, décalage du hub compris. */
  const now = computed(() => clock.real + (payload.value?.state.serverTimeOffsetMs ?? 0))

  /**
   * Mesuré au battement, des deux côtés, et c'est délibéré.
   *
   * L'instant de coupure comme la comparaison lisent la même horloge d'une
   * seconde : l'écart est donc exact à un battement près, et l'erreur tombe
   * toujours du même côté — l'avertissement paraît entre quatre et cinq
   * secondes après la coupure, jamais avant quatre. Un « écran figé » affiché
   * trop tôt sur une reconnexion d'une seconde coûte plus cher qu'un affiché
   * une seconde trop tard.
   */
  const dead = computed(
    () => cutSince.value != null && clock.real - cutSince.value > STREAM_DEAD_MS,
  )

  /** L'état embarqué dans la coquille, posé avant le premier octet du flux. */
  function seed(initial: DisplayPayload | null): void {
    if (initial != null) payload.value = initial
  }

  function connect(ouvrirFlux?: (url: string) => StateStream): void {
    if (ouvrirFlux != null) porte.configurer({ ouvrirFlux })
    porte.ouvrir(
      {
        onPayload: (recu, complet) => {
          if (complet) {
            payload.value = recu as DisplayPayload
            return
          }
          /*
           * Un delta seul décrit une salle dont on ne connaît pas le reste.
           *
           * Le peindre à moitié serait pire que d'attendre l'instantané, qui
           * suit de toute façon toute reconnexion.
           */
          if (payload.value == null) return
          payload.value = { ...payload.value, ...(recu as Partial<DisplayPayload>) }
        },
        onCoupure: (coupe) => {
          if (coupe) cutSince.value ??= clock.real
          else cutSince.value = null
        },
      },
    )
  }

  function disconnect(): void {
    porte.fermer()
  }

  /**
   * Repart de zéro sur une autre salle.
   *
   * L'état de la précédente doit partir avec elle : garder le `payload` le temps
   * du premier sondage afficherait une seconde le titre, le compte à rebours et
   * l'état d'enregistrement de la salle qu'on vient de quitter — sur la page de
   * celle qu'on ouvre.
   */
  function oublier(): void {
    payload.value = null
    cutSince.value = null
  }

  return { payload, cutSince, now, dead, seed, connect, disconnect, oublier }
})
