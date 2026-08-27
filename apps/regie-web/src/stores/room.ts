import type { DisplayPayload } from '@cloudnord/contract'
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useClockStore } from './clock.js'

/**
 * Au-delà, une coupure cesse d'être une reconnexion et devient un écran mort.
 *
 * Repris tel quel de la page d'origine : `EventSource` se reconnecte seul et ne
 * lève rien, si bien qu'un poste de salle redémarré sous une fenêtre ouverte
 * laisse cette fenêtre vivante en apparence — l'horloge tourne, le compte à
 * rebours descend — et figée en fait, sur l'état d'avant la coupure. Le délai
 * de grâce évite de crier à chaque reconnexion d'une seconde, que personne n'a
 * besoin de voir.
 */
export const STREAM_DEAD_MS = 4000

/** Ce que le store attend d'un flux : de quoi s'abonner et se fermer. */
export interface StateStream {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void
  onopen: ((event: Event) => void) | null
  onerror: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  close(): void
}

/**
 * L'état de la salle, et le flux qui le tient à jour.
 *
 * Un seul écrivain, et c'est le point : **aucune action de régie n'écrit ici**.
 * Appuyer sur « LIVE » poste l'action et attend le delta ; la page ne se peint
 * pas d'avance. C'est ce qui garantit qu'un bouton actif à l'écran décrit OBS
 * et non ce qu'on a demandé à OBS — la distinction compte le jour où la bascule
 * échoue et où personne ne s'en rend compte.
 */
export const useRoomStore = defineStore('room', () => {
  const payload = ref<DisplayPayload | null>(null)

  /**
   * Depuis quand le flux est coupé, ou `null` s'il tient.
   *
   * Distinct de la connectivité affichée à côté, qui dit si la **salle** joint
   * le hub. Celle-ci dit si la **page** joint sa salle — deux pannes
   * différentes, et la seconde était muette avant qu'on la nomme.
   */
  const cutSince = ref<number | null>(null)

  const clock = useClockStore()
  let stream: StateStream | null = null

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

  /**
   * Ouvre le flux et le garde ouvert.
   *
   * La fabrique est injectée pour que le store se teste sans `EventSource` :
   * happy-dom en fournit un, mais un vrai flux ne s'interrompt pas sur demande,
   * et le seul comportement qui compte ici est justement ce qui se passe quand
   * il s'interrompt.
   */
  function connect(open: (url: string) => StateStream = (url) => new EventSource(url)): void {
    if (stream != null) return
    stream = open('/display/state?vue=regie')

    stream.onopen = () => {
      cutSince.value = null
    }
    stream.onerror = () => {
      cutSince.value ??= clock.real
    }

    // Message sans nom : l'instantané complet. Il part à l'ouverture et après
    // chaque reconnexion, ce qui répare la page sans logique de reprise.
    stream.onmessage = (event) => {
      cutSince.value = null
      payload.value = JSON.parse(event.data) as DisplayPayload
    }

    /*
     * Delta : seulement les champs qui ont changé.
     *
     * Ignoré tant qu'aucun instantané n'est arrivé — un delta seul décrit une
     * salle dont on ne connaît pas le reste, et le peindre à moitié serait pire
     * que d'attendre l'instantané, qui suit de toute façon toute reconnexion.
     */
    stream.addEventListener('delta', (event) => {
      cutSince.value = null
      if (payload.value == null) return
      payload.value = { ...payload.value, ...(JSON.parse(event.data) as Partial<DisplayPayload>) }
    })
  }

  function disconnect(): void {
    stream?.close()
    stream = null
  }

  return { payload, cutSince, now, dead, seed, connect, disconnect }
})
